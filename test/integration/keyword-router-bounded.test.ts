/**
 * T-0073/T-0074 router behavior that the eval's lock only catches indirectly:
 * the bounded plan's AND tier, the LIKE floor, scope and binding order on the
 * short-token paths, and the fusion IDF window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";
import type { Identity } from "../../src/lib/identity";
import { distillToRareTerms } from "../../src/recall/distill";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { fuseDenseAndKeyword, keywordSearch, recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;
const memberOf = (personal: string): Identity => ({ userId: "u1", role: "member", personalWorkspaceId: personal, companyWorkspaceIds: [], defaultShare: "" as const });

let sqlite: SqliteD1;
let env: Env;

const envFor = (db: unknown): Env => makeTestEnv(undefined, {
  DB: db as Env["DB"],
  OAUTH_KV: makeMemoryKV(),
  VECTORIZE: makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("index unavailable")) }),
});

function seedIn(id: string, workspaceId: string, content: string, createdAt: number) {
  sqlite.seed({ id, content, createdAt });
  sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(workspaceId, id).run();
}

const issuedSql = () => sqlite.issued;
const searchSql = () => issuedSql().filter(sql => sql.includes("SELECT e.id") && sql.includes("entries_fts MATCH"));
const likeSql = () => issuedSql().filter(sql => sql.includes("FROM entries WHERE") && sql.includes("content LIKE") && sql.includes("ORDER BY created_at DESC"));

async function recall(query: string, o: { cfg?: { KEYWORD_CANDIDATE_LIMIT?: number }; after?: number; identity?: Identity; e?: Env } = {}) {
  const diagnostics: RecallDiagnostics = {};
  await recallEntries(
    { query, topK: 5, after: o.after, synthesize: false }, o.e ?? env, ctx, { ...DEFAULTS, ...o.cfg },
    { diagnostics, ...(o.identity ? { identity: o.identity } : {}) },
  );
  return diagnostics;
}

beforeEach(async () => {
  resetDatabaseInit();
  resetFtsReadyMemo();
  sqlite = makeSqliteD1();
  env = envFor(sqlite.db);
  await initializeDatabase(env);
  await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
  resetFtsReadyMemo();
  sqlite.issued.length = 0;
  sqlite.batches.length = 0;
});
afterEach(() => sqlite.close());

describe("bounded plan: the AND tier", () => {
  it("runs newest-first by FTS rowid under a LIMIT, with no sort over the matches", async () => {
    // alpha, bravo, charlie co-occur in every row (800 each); delta is in 60 rows, 40 of them with the other three: it alone fits the OR tier, but past the limit of 50, so the AND tier is still needed and, holding only 40, leaves room for the OR tier
    for (let i = 0; i < 800; i++) sqlite.seed({ id: `row-${i}`, content: `alpha bravo charlie ${i < 40 ? "delta " : ""}note${i}`, createdAt: i + 1 });
    for (let i = 0; i < 20; i++) sqlite.seed({ id: `lone-${i}`, content: `delta lone${i}`, createdAt: 2000 + i });
    sqlite.batches.length = 0;

    const diagnostics = await recall("alpha bravo charlie delta", { cfg: { KEYWORD_CANDIDATE_LIMIT: 50 } });

    expect(diagnostics.ftsRoute).toBe("fts-bounded");
    const statements = searchSql();
    expect(statements).toHaveLength(2);
    // tier 0 is the AND: no bm25 sort, stopped by its LIMIT (the candidate SELECT is the CTE body; the rest turns note text into match levels)
    expect(statements[0]).not.toContain("bm25");
    const body = statements[0].match(/WITH s AS MATERIALIZED \(([\s\S]*?)\)\s+SELECT/)![1];
    expect(body).toMatch(/ORDER BY entries_fts\.rowid DESC LIMIT \?\s*$/);
    // tier 1 is the OR over the rarest words that fit the candidate limit, ranked as ever
    expect(statements[1]).toContain("bm25(entries_fts)");
    expect(diagnostics.keywordIds!.length).toBeLessThanOrEqual(50);

    // the plan is a reverse scan of the index joined by rowid: no temp b-tree over the matches
    const plan = (sqlite.db.prepare(`EXPLAIN QUERY PLAN ${body}`).bind('"alpha" "bravo" "charlie" "delta"', 50) as unknown as { all(): Promise<{ results: { detail: string }[] }> });
    const details = (await plan.all()).results.map(r => r.detail).join(" | ");
    expect(details).toContain("SCAN entries_fts VIRTUAL TABLE");
    expect(details).not.toMatch(/TEMP B-TREE/i);
  });

  it("returns the newest rows carrying every word when more than the limit match, not the oldest", async () => {
    for (let i = 0; i < 900; i++) sqlite.seed({ id: `row-${i}`, content: `alpha bravo charlie note${i}`, createdAt: i + 1 });
    // the newest all-token row is also the last one inserted
    sqlite.seed({ id: "newest", content: "alpha bravo charlie latest", createdAt: 5000 });

    const diagnostics = await recall("alpha bravo charlie", { cfg: { KEYWORD_CANDIDATE_LIMIT: 50 } });

    expect(diagnostics.ftsRoute).toBe("fts-bounded");
    expect(diagnostics.keywordIds).toContain("newest");
    expect(diagnostics.keywordIds).not.toContain("row-0");
  });

  it("still returns the row that carries every word when the intersection is small", async () => {
    for (let i = 0; i < 2100; i++) sqlite.seed({ id: `row-${i}`, content: `alpha note${i}`, createdAt: i + 2 });
    for (let i = 0; i < 300; i++) sqlite.seed({ id: `b-${i}`, content: `bravo note${i}`, createdAt: i + 2 });
    sqlite.seed({ id: "gold", content: "alpha bravo gold", createdAt: 1 });

    const diagnostics = await recall("alpha bravo");
    expect(diagnostics.ftsRoute).toBe("fts-bounded");
    expect(diagnostics.keywordIds).toContain("gold");
  });
});

describe("bounded plan: the AND tier is left out when the OR tier holds every match", () => {
  const ftsIds = async (match: string, order: string, limit: number) =>
    ((await sqlite.db.prepare(`SELECT e.id FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid AND e.id = entries_fts.id WHERE entries_fts MATCH ? ${order} LIMIT ?`).bind(match, limit).all()).results as { id: string }[]).map(r => r.id);

  it("issues one statement and returns exactly the candidates the two tiers would have", async () => {
    // garden (3020) is too common to score; invoice (100) fits the fork limit, and 20 rows carry both
    for (let i = 0; i < 3000; i++) sqlite.seed({ id: `g-${i}`, content: `garden note${i}`, createdAt: i + 1 });
    for (let i = 0; i < 80; i++) sqlite.seed({ id: `i-${i}`, content: `invoice note${i}`, createdAt: i + 5000 });
    for (let i = 0; i < 20; i++) sqlite.seed({ id: `b-${i}`, content: `garden invoice note${i}`, createdAt: i + 9000 });
    const both = new Set([...await ftsIds('"garden" "invoice"', "ORDER BY entries_fts.rowid DESC", 500), ...await ftsIds('"invoice"', "ORDER BY bm25(entries_fts)", 500)]);
    sqlite.batches.length = 0;
    sqlite.issued.length = 0;

    const diagnostics = await recall("garden invoice");

    expect(diagnostics.ftsRoute).toBe("fts-bounded");
    expect(searchSql()).toHaveLength(1);
    expect(new Set(diagnostics.keywordIds)).toEqual(both);
    expect(both.size).toBe(100);
  });

  it("keeps it when the OR tier could truncate", async () => {
    for (let i = 0; i < 3000; i++) sqlite.seed({ id: `g-${i}`, content: `garden note${i}`, createdAt: i + 1 });
    for (let i = 0; i < 400; i++) sqlite.seed({ id: `i-${i}`, content: `invoice note${i}`, createdAt: i + 5000 });
    sqlite.batches.length = 0;
    await recall("garden invoice", { cfg: { KEYWORD_CANDIDATE_LIMIT: 100 } });
    expect(searchSql()).toHaveLength(2);
  });
});

describe("bounded plan: the OR tier reaches a mid-df token", () => {
  it("returns rows carrying only the moderately common token when the other word is too common to score", async () => {
    // garden (2500) is past the budget, invoice (800) is not: an answer that carries only invoice must stay reachable
    for (let i = 0; i < 2500; i++) sqlite.seed({ id: `g-${i}`, content: `garden note${i}`, createdAt: i + 1000 });
    for (let i = 0; i < 800; i++) sqlite.seed({ id: `i-${i}`, content: `invoice note${i}`, createdAt: i + 1 });
    sqlite.batches.length = 0;

    const diagnostics = await recall("garden invoice");

    expect(diagnostics.ftsRoute).toBe("fts-bounded");
    expect(diagnostics.keywordIds!.some(id => id.startsWith("i-"))).toBe(true);
  });
});

describe("bounded plan: nothing to retrieve with", () => {
  it("goes straight to LIKE, without an FTS batch, when a token is known absent and no other fits", async () => {
    for (let i = 0; i < 2100; i++) sqlite.seed({ id: `row-${i}`, content: `widget note${i}`, createdAt: i + 1 });
    sqlite.issued.length = 0;
    sqlite.batches.length = 0;

    const diagnostics = await recall("widget zzzrare");

    expect(diagnostics.ftsRoute).toBe("like-match-budget");
    expect(diagnostics.ftsUsed).toBe(false);
    expect(searchSql()).toEqual([]);
    expect(diagnostics.keywordIds!.length).toBeGreaterThan(0);
  });

  it("falls back to the recency window when the bounded FTS statements return no rows", async () => {
    for (let i = 0; i < 2100; i++) sqlite.seed({ id: `row-${i}`, content: `widget note${i}`, createdAt: i + 2 });
    for (let i = 0; i < 3; i++) sqlite.seed({ id: `g-${i}`, content: `widget gadget note${i}`, createdAt: 1 });
    sqlite.issued.length = 0;
    sqlite.batches.length = 0;

    // The plan is bounded (widget 2103 + gadget 3 > budget); make its FTS statements come back empty.
    const blank = new Proxy(sqlite.db, {
      get(target, prop, receiver) {
        if (prop !== "batch") { const v = Reflect.get(target, prop, receiver); return typeof v === "function" ? v.bind(target) : v; }
        return async (statements: { sql?: string }[]) => {
          const results = await (target as unknown as { batch: (s: unknown[]) => Promise<{ results: unknown[] }[]> }).batch(statements);
          return results.map((r, i) => ((statements[i] as { sql?: string }).sql ?? "").includes("SELECT e.id") ? { ...r, results: [] } : r);
        };
      },
    });
    // the statement objects the proxy sees must expose their SQL
    const tagged = new Proxy(blank, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => Object.assign(sqlite.db.prepare(sql), { sql });
      },
    });
    const blankEnv = envFor(tagged);
    await blankEnv.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    const diagnostics = await recall("widget gadget", { e: blankEnv });

    expect(diagnostics.ftsRoute).toBe("like-match-budget");
    expect(diagnostics.ftsUsed).toBe(false);
    expect(likeSql().length).toBeGreaterThan(0);
    expect(diagnostics.keywordIds!.length).toBeGreaterThan(0);
  });

  it("does not touch the LIKE window when the bounded plan finds rows", async () => {
    for (let i = 0; i < 2100; i++) sqlite.seed({ id: `row-${i}`, content: `widget note${i}`, createdAt: i + 2 });
    sqlite.seed({ id: "gold", content: "widget gadget", createdAt: 1 });
    sqlite.issued.length = 0;
    sqlite.batches.length = 0;

    const diagnostics = await recall("widget gadget");
    expect(diagnostics.ftsRoute).toBe("fts-bounded");
    expect(likeSql()).toEqual([]);
    expect(diagnostics.keywordIds).toContain("gold");
  });
});

describe("short-token df sample: scope and time bounds", () => {
  it("counts only the caller's readable rows", async () => {
    for (let i = 0; i < 60; i++) seedIn(`mine-${i}`, "ws-a", `atlas ledger note${i}`, i + 1);
    // a foreign workspace, newer, every row carrying io: an unscoped sample would read io as saturated
    for (let i = 0; i < 250; i++) seedIn(`foreign-${i}`, "ws-b", `atlas ledger io note${i}`, 100 + i);
    const out = await distillToRareTerms("io atlas ledger", env, undefined, {}, memberOf("ws-a"));
    expect(out.total).toBe(60);
    expect(out.df!.get("io")!).toBeLessThanOrEqual(2);
  });

  it("counts only rows inside the time bounds", async () => {
    for (let i = 0; i < 150; i++) seedIn(`old-${i}`, "ws-a", `atlas io note${i}`, i + 1);
    for (let i = 0; i < 50; i++) seedIn(`new-${i}`, "ws-a", `atlas ledger note${i}`, 1000 + i);
    const out = await distillToRareTerms("io atlas ledger", env, undefined, { after: 1000 }, memberOf("ws-a"));
    expect(out.total).toBe(50);
    expect(out.df!.get("io")!).toBeLessThanOrEqual(2);
  });
});

describe("short-token ranking in the FTS statement: binding order", () => {
  it("binds match, time bounds, scope, short-token patterns, and limit in statement order", async () => {
    seedIn("in-both", "ws-a", "atlas io", 1000);
    seedIn("in-atlas", "ws-a", "atlas only", 1001);
    seedIn("foreign", "ws-b", "atlas io", 1002);
    seedIn("too-old", "ws-a", "atlas io", 10);
    const diagnostics = await recall("atlas io", { after: 500, identity: memberOf("ws-a") });
    expect(diagnostics.ftsRoute).toBe("fts");
    // the short-token row ranks first even though the other is newer; scope and time bounds both hold
    expect(diagnostics.keywordIds).toEqual(["in-both", "in-atlas"]);
  });
});

describe("fusion IDF window for queries that left LIKE", () => {
  const row = { id: "r1", content: "nightly-88 rebuilds the index", tags: "[]", source: "api", created_at: 1 };
  const fuse = (idfWindow: number) => fuseDenseAndKeyword(
    [], [row], ["nightly-88", "88"], true, { df: null, total: null }, 0.5, false, idfWindow,
  )[0].score;

  it("prices IDF against the window when df is unknown, so a two-row FTS answer keeps a LIKE-sized weight", () => {
    expect(fuse(500)).toBeGreaterThan(fuse(0) * 5);
  });

  it("is set by the router only when df is absent and a short token was left out of retrieval", async () => {
    for (let i = 0; i < 5; i++) sqlite.seed({ id: `r${i}`, content: `nightly-88 rebuilds note${i}`, createdAt: i + 1 });
    const run = (tokens: string[], corpus?: { df: Map<string, number> | null; total: number | null }) =>
      keywordSearch(tokens, env, 500, {}, undefined, undefined, undefined, corpus);
    expect((await run(["nightly-88", "nightly", "88"])).idfWindow).toBe(500);
    expect((await run(["nightly-88", "nightly"])).idfWindow).toBeUndefined();
    const df = new Map([["nightly-88", 5], ["nightly", 5], ["88", 5]]);
    expect((await run(["nightly-88", "nightly", "88"], { df, total: 5 })).idfWindow).toBeUndefined();
  });
});
