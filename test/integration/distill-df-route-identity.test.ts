/**
 * Distillation's df must not depend on which route counted it (dfCountsStmt in src/recall/distill.ts): the per-term FTS
 * counts and the one-pass LIKE scan must agree row for row, or a price read from the all-workspace vocabulary lets another
 * tenant's rows change the caller's df, and df drives ranking. The trigram index folds some content characters to ASCII
 * (the Kelvin sign U+212A to "k", long s U+017F to "s") where LIKE does not, so MATCH alone is not the definition.
 *
 * Real SQLite (test/helpers/sqlite-d1.ts): the thing under test is FTS5 trigram MATCH against LIKE.
 */
import { describe, it, expect } from "vitest";
import { distillToRareTerms, dfThroughRoute } from "../../src/recall/distill";
import { recallEntries } from "../../src/recall/search";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { contentLikePattern, CONTENT_LIKE_ESCAPE } from "../../src/text/like";
import { scopeWhereForRead } from "../../src/lib/scope";
import { DEFAULTS } from "../../src/config";
import { FTS_READY_KV_KEY } from "../../src/constants";
import type { Env } from "../../src/env";
import type { Identity } from "../../src/lib/identity";

function mulberry32(seed: number) {
  return function random() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Content pieces that fold differently under the trigram tokenizer and LIKE, next to their plain spellings.
const PIECES = [
  "kelvin", "Kelvin", "KELVIN", "Kelvin", "KELVIN",
  "class", "CLASS", "claſſ", "CLAſſ",
  "widget", "WIDGET", "ｗｉｄｇｅｔ", "ＷIDGET",
  "cafe", "café", "CAFÉ", "cafè",
  "resume", "résumé", "RÉSUMÉ",
  "strasse", "straße", "STRASSE",
  "istanbul", "İstanbul", "ISTANBUL",
  "東京都庁", "東京都", "都庁舎",
  "50%_off", "50%off", "50x_off", "50%_OFF", "a_b%c", "aXb%c",
  "filler", "text", "prekelvinpost", "subclassed",
];
// Terms distillation counts through dfCountsStmt: eligible (3+ characters) and count-safe (ftsCountSafeToken).
const TERMS = ["kelvin", "class", "widget", "cafe", "resume", "strasse", "istanbul", "東京都庁", "50%_off", "a_b%c", "elvin", "lass"];

function seedIn(sqlite: SqliteD1, id: string, workspaceId: string, content: string, createdAt: number) {
  sqlite.seed({ id, content, createdAt });
  sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(workspaceId, id).run();
}

async function brain() {
  resetDatabaseInit();
  resetFtsReadyMemo();
  const sqlite = makeSqliteD1();
  const env: Env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  return { sqlite, env };
}

const member = (personal: string): Identity => ({ userId: "u1", role: "member", personalWorkspaceId: personal, companyWorkspaceIds: [], defaultShare: "" });

describe("df is the same on both routes", () => {
  it("the counts and the pass agree, and every LIKE match is a MATCH match, across 150 randomized mixed-Unicode corpora", async () => {
    const mismatches: string[] = [];
    for (let n = 0; n < 150; n++) {
      const rng = mulberry32(20260930 + n);
      const { sqlite, env } = await brain();
      const rows = 5 + Math.floor(rng() * 30);
      for (let i = 0; i < rows; i++) {
        const words = Array.from({ length: 1 + Math.floor(rng() * 5) }, () => PIECES[Math.floor(rng() * PIECES.length)]);
        seedIn(sqlite, `r${i}`, rng() < 0.8 ? "ws-a" : "ws-b", words.join(rng() < 0.5 ? " " : ""), i + 1);
      }
      const terms = [...new Set(Array.from({ length: 2 + Math.floor(rng() * 3) }, () => TERMS[Math.floor(rng() * TERMS.length)]))];
      const scope = rng() < 0.5 ? scopeWhereForRead(member("ws-a")) : null;
      const counts = await dfThroughRoute(env, terms, scope, "counts");
      const pass = await dfThroughRoute(env, terms, scope, "pass");
      const label = `trial#${n} terms=${JSON.stringify(terms)} scoped=${!!scope}`;
      if (JSON.stringify([...counts!]) !== JSON.stringify([...pass!])) mismatches.push(`${label}: counts=${JSON.stringify([...counts!])} pass=${JSON.stringify([...pass!])}`);
      for (const t of terms) {
        // The superset claim the counts route rests on: no row matches LIKE without matching MATCH.
        const outside = sqlite.db.prepare(
          `SELECT count(*) AS n FROM entries WHERE content LIKE ? ${CONTENT_LIKE_ESCAPE} AND rowid NOT IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)`,
        ).bind(contentLikePattern(t), `"${t.replaceAll(`"`, `""`)}"`).first() as unknown as { n: number };
        if ((await outside).n) mismatches.push(`${label}: ${(await outside).n} LIKE match(es) for ${t} outside MATCH`);
      }
      sqlite.close();
    }
    expect(mismatches, mismatches.slice(0, 5).join("\n")).toEqual([]);
  }, 60_000);

  it("the reviewer's cases: the Kelvin sign and long s count as LIKE counts them, on both routes", async () => {
    const { sqlite, env } = await brain();
    seedIn(sqlite, "a", "ws-a", "Kelvin scale widget", 1);
    seedIn(sqlite, "b", "ws-a", "kelvin widget", 2);
    seedIn(sqlite, "c", "ws-a", "Kelvin widget", 3);
    seedIn(sqlite, "d", "ws-a", "claſſ notes", 4);
    seedIn(sqlite, "e", "ws-a", "class notes", 5);
    for (const route of ["counts", "pass"] as const) {
      const df = await dfThroughRoute(env, ["kelvin", "class"], null, route);
      expect(df!.get("kelvin"), route).toBe(2);
      expect(df!.get("class"), route).toBe(1);
    }
    sqlite.close();
  });
});

describe("another tenant's rows cannot change the caller's df or results", () => {
  it("3,000 matching rows in ws-b flip the route but not ws-a's df, rebuilt query or recall results", async () => {
    const { sqlite, env } = await brain();
    const identity = member("ws-a");
    seedIn(sqlite, "a1", "ws-a", "Kelvin probe x", 1);
    seedIn(sqlite, "a2", "ws-a", "kelvin probe y", 2);
    for (let i = 0; i < 42; i++) seedIn(sqlite, `f${i}`, "ws-a", `filler note ${i}`, 10 + i);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
    const recall = async () => (await recallEntries({ query: "kelvin probe quasar", topK: 10, hops: 0, synthesize: false }, env, ctx, DEFAULTS, { identity })).matches.map(m => m.id);

    const before = await distillToRareTerms("kelvin probe quasar", env, undefined, {}, identity);
    const beforeIds = await recall();

    for (let i = 0; i < 3000; i++) seedIn(sqlite, `b${i}`, "ws-b", `kelvin probe quasar ${i}`, 100 + i);
    const after = await distillToRareTerms("kelvin probe quasar", env, undefined, {}, identity);
    const afterIds = await recall();

    // The precondition that makes this a test: the other tenant's rows did move the price.
    expect([before.distillSource, after.distillSource]).toEqual(["fts", "scan"]);
    expect(after.df).toEqual(before.df);
    expect(after.df!.get("kelvin")).toBe(1);
    expect(after.total).toBe(before.total);
    expect(after.query).toBe(before.query);
    expect(afterIds).toEqual(beforeIds);
    sqlite.close();
  }, 30_000);
});
