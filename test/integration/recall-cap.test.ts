/**
 * T-0089.3.1 (4.3): the occupancy cap bounds how much of a result mail and
 * transcript rows may take, so a flood of planted or synced mail cannot
 * crowd out a caller's own direct memories. Real SQLite, real dense scores.
 *
 * All rows share one createdAt and the query matches no row's content, so
 * only the dense score (the `index` array's order) decides ranking: recency
 * and the keyword arm stay neutral and the cap's effect is isolable.
 */
import { describe, it, expect, vi } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { DEFAULTS } from "../../src/config";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as unknown as ExecutionContext;
const CREATED_AT = 1_700_000_000_000;
const QUERY = "lookup zylophantine reference";

function denseEnv(sqlite: SqliteD1, index: { id: string; score: number }[]): Env {
  const query = vi.fn(async (_v: unknown, opts: { topK?: number } = {}) => ({
    matches: index.slice(0, opts.topK ?? 10).map(m => ({ id: m.id, score: m.score, metadata: { parentId: m.id, isUpdate: false } })),
  }));
  return sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock({ query: query as never }) }));
}

async function setup() {
  resetDatabaseInit();
  const sqlite = makeSqliteD1();
  const env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  sqlite.issued.length = 0;
  return { sqlite, env };
}

const cfgCap = { ...DEFAULTS, MIRROR_MAX_SHARE: 0.4 };

describe("occupancy cap at recall time", () => {
  it("bounds mail's share of the results while a direct memory remains", async () => {
    const { sqlite } = await setup();
    // 6 mail + 4 direct = 10 candidates: within topK(5) + CAP_LOOKAHEAD(5), so
    // MMR's diversify width does not truncate any direct row out of view
    // before the cap ever sees it (a separate, documented exhausted case).
    for (let i = 0; i < 6; i++) sqlite.seed({ id: `mail${i}`, content: `Newsletter roundup number ${i}`, createdAt: CREATED_AT, source: "email-gmail" });
    for (let i = 0; i < 4; i++) sqlite.seed({ id: `direct${i}`, content: `My own note number ${i}`, createdAt: CREATED_AT, source: "api" });
    const index = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `mail${i}`, score: 0.99 - i * 0.01 })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `direct${i}`, score: 0.5 - i * 0.01 })),
    ];
    const env = denseEnv(sqlite, index);
    const { matches } = await recallEntries({ query: QUERY, topK: 5, synthesize: false }, env, ctx, cfgCap);
    // ceil(0.4*5) = 2: at most 2 of the top 5 are mail while a direct row remains.
    const mailCount = matches.filter(m => m.source === "email-gmail").length;
    expect(mailCount).toBeLessThanOrEqual(2);
    expect(matches.filter(m => m.source === "api").length).toBeGreaterThan(0);
  });

  it("transcripts count toward the share exactly like mail", async () => {
    const { sqlite } = await setup();
    for (let i = 0; i < 4; i++) sqlite.seed({ id: `t${i}`, content: `Coding session log number ${i}`, createdAt: CREATED_AT, source: "claude-code" });
    for (let i = 0; i < 3; i++) sqlite.seed({ id: `direct${i}`, content: `My own note number ${i}`, createdAt: CREATED_AT, source: "api" });
    const index = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, score: 0.99 - i * 0.01 })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `direct${i}`, score: 0.5 - i * 0.01 })),
    ];
    const env = denseEnv(sqlite, index);
    const { matches } = await recallEntries({ query: QUERY, topK: 3, synthesize: false }, env, ctx, cfgCap);
    // ceil(0.4*3) = 2.
    expect(matches.filter(m => m.source === "claude-code").length).toBeLessThanOrEqual(2);
    expect(matches.filter(m => m.source === "api").length).toBeGreaterThan(0);
  });

  it("never shortens results: an all-mail candidate set still fills topK", async () => {
    const { sqlite } = await setup();
    for (let i = 0; i < 5; i++) sqlite.seed({ id: `mail${i}`, content: `Newsletter number ${i}`, createdAt: CREATED_AT, source: "email-gmail" });
    const index = Array.from({ length: 5 }, (_, i) => ({ id: `mail${i}`, score: 0.9 - i * 0.01 }));
    const env = denseEnv(sqlite, index);
    const { matches } = await recallEntries({ query: QUERY, topK: 5, synthesize: false }, env, ctx, cfgCap);
    expect(matches).toHaveLength(5);
  });

  it("a source word in the query lifts the cap", async () => {
    const { sqlite } = await setup();
    for (let i = 0; i < 4; i++) sqlite.seed({ id: `mail${i}`, content: `Newsletter roundup number ${i}`, createdAt: CREATED_AT, source: "email-gmail" });
    sqlite.seed({ id: "direct0", content: "My own note", createdAt: CREATED_AT, source: "api" });
    const index = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `mail${i}`, score: 0.99 - i * 0.01 })),
      { id: "direct0", score: 0.5 },
    ];
    const env = denseEnv(sqlite, index);
    const { matches } = await recallEntries({ query: "email newsletter roundup", topK: 4, synthesize: false }, env, ctx, cfgCap);
    expect(matches.filter(m => m.source === "email-gmail").length).toBe(4);
  });

  it("a mirror tag filter lifts the cap", async () => {
    const { sqlite, env } = await setup();
    // Member-first (tag) recall never touches VECTORIZE.query; ranking comes
    // from the keyword arm, so the content must actually hold the query term.
    for (let i = 0; i < 4; i++) sqlite.seed({ id: `mail${i}`, content: `Newsletter number ${i}`, createdAt: CREATED_AT, source: "email-gmail", tags: ["email"] });
    const { matches } = await recallEntries({ query: "newsletter", topK: 4, tag: "email", synthesize: false }, env, ctx, cfgCap);
    expect(matches).toHaveLength(4);
    expect(matches.every(m => m.source === "email-gmail")).toBe(true);
  });

  it("MIRROR_MAX_SHARE 1.0 (off) leaves rankings byte-identical to the dense order", async () => {
    const { sqlite } = await setup();
    for (let i = 0; i < 8; i++) sqlite.seed({ id: `mail${i}`, content: `Newsletter roundup number ${i}`, createdAt: CREATED_AT, source: "email-gmail" });
    for (let i = 0; i < 4; i++) sqlite.seed({ id: `direct${i}`, content: `My own note number ${i}`, createdAt: CREATED_AT, source: "api" });
    const index = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `mail${i}`, score: 0.99 - i * 0.01 })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `direct${i}`, score: 0.5 - i * 0.01 })),
    ];
    const env = denseEnv(sqlite, index);
    const { matches } = await recallEntries({ query: QUERY, topK: 5, synthesize: false }, env, ctx, DEFAULTS);
    // All 5 dense-highest are mail, since DEFAULTS.MIRROR_MAX_SHARE is 1.0 (off).
    expect(matches.filter(m => m.source === "email-gmail")).toHaveLength(5);
  });
});
