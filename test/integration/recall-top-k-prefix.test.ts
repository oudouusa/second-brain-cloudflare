/**
 * T-0081 — a larger topK only appends: the results for topK k are the first k of the results for any larger topK.
 * The candidate pool, the diversity pass and the graph slots used to scale with topK, so the head reshuffled.
 * Driven through recallEntries with a Vectorize mock that honours topK, as the real index does.
 */
import { describe, expect, it, vi } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { VECTORIZE_WIDEN_MAX_CANDIDATES, RECALL_MAX_TOP_K, RECALL_POOL_SIZE } from "../../src/constants";
import { makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import { mulberry32 } from "../eval/stats";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV } from "../helpers/make-env";
import type { Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

/** `parents` memories, each indexed as two chunks, best-scoring first. */
function setup(parents: number) {
  const db = new D1Mock();
  for (let i = 0; i < parents; i++) {
    db.entries.push({ id: `e${i}`, content: `topic note ${i}`, tags: "[]", source: "api", created_at: 1000 + i, vector_ids: "[]", recall_count: 0, importance_score: 0 });
  }
  // Real vector values, so the diversity pass does its work (without them MMR is inert and a wrong block rounding passes).
  const rand = mulberry32(parents);
  const index = Array.from({ length: parents * 2 }, (_, i) => ({ id: `v${i}`, score: 0.95 - i * 0.005, values: Array.from({ length: 6 }, () => rand() - 0.5), metadata: { parentId: `e${Math.floor(i / 2)}`, isUpdate: false } }));
  const query = vi.fn(async (_v: unknown, opts: { topK?: number } = {}) => ({ matches: index.slice(0, opts.topK ?? 10) }));
  const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: query as never }) });
  // No keyword rows: the dense arm alone decides, so the candidate count is the parent count.
  const prepare = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => sql.includes("content LIKE") && sql.includes("ORDER BY") && (sql.includes("SELECT id, content") || sql.startsWith("WITH s AS MATERIALIZED"))
    ? { bind: () => ({ all: async () => ({ results: [] }) }) }
    : prepare(sql);
  const recall = async (topK: number, hops = 0) => (await recallEntries({ query: "topic note", topK, hops, synthesize: false }, env, ctx)).matches.map(m => m.id);
  return { recall, query };
}

describe("recall topK never reorders the head (T-0081)", () => {
  it("returns the first k of the topK-20 list for every k, with and without hops", async () => {
    for (const hops of [0, 1]) {
      const { recall } = setup(30);
      const full = await recall(RECALL_MAX_TOP_K, hops);
      expect(full).toHaveLength(VECTORIZE_WIDEN_MAX_CANDIDATES / 2);
      for (let k = 1; k < RECALL_MAX_TOP_K; k++) expect(await recall(k, hops), `topK ${k}, hops ${hops}`).toEqual(full.slice(0, k));
    }
  });

  it("draws from a deeper dense list only when the diversified one is shorter than topK, and only appends", async () => {
    // 15 chunkで8記憶、forkの追加取得上限20 chunkで10記憶。
    const { recall, query } = setup(25);
    const head = await recall(5);
    expect(query.mock.calls.map(c => (c[1] as { topK: number }).topK)).toEqual([RECALL_POOL_SIZE]);
    query.mockClear();
    const deep = await recall(12);
    expect(query.mock.calls.map(c => (c[1] as { topK: number }).topK)).toEqual([RECALL_POOL_SIZE, VECTORIZE_WIDEN_MAX_CANDIDATES]);
    expect(deep).toHaveLength(VECTORIZE_WIDEN_MAX_CANDIDATES / 2);
    expect(new Set(deep).size).toBe(VECTORIZE_WIDEN_MAX_CANDIDATES / 2);
    expect(deep.slice(0, 5)).toEqual(head);
  });

  it("does not ask for the deeper list when the index has nothing more to give", async () => {
    const { recall, query } = setup(3); // 6 chunks: the pool never fills
    expect(await recall(RECALL_MAX_TOP_K)).toHaveLength(3);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

/**
 * A seeded sweep over the cases a fixed-shape fixture cannot reach: memories the index knows but hydration hides
 * (auto-insight and deprecated tags, another workspace's rows, a filter), graph recalls with real edges, and every
 * filter recall takes. Real SQLite, real vector values, topK 1-20 compared pairwise.
 */
describe("recall topK prefix, randomized sweep (T-0081)", () => {
  const member: Identity = { userId: "u1", role: "member", personalWorkspaceId: "ws-p", companyWorkspaceIds: ["ws-co"], defaultShare: "" as const };
  const KINDS = ["kind:episodic", "kind:semantic"];

  async function corpus(seed: number, hiddenShare: number) {
    resetDatabaseInit();
    const rand = mulberry32(seed);
    const sqlite = makeSqliteD1();
    // Recall bumps recall_count for what it presents, which feeds the next recall's ranking: drop the write (as the
    // eval does) so every call in the sweep ranks the same corpus.
    const DB = new Proxy(sqlite.db as object as Record<string, unknown>, {
      get: (target, key) => key === "prepare"
        ? (sql: string) => sql.includes("SET recall_count = recall_count + 1") ? { bind: () => ({ run: async () => ({}) }) } : (target.prepare as (s: string) => unknown)(sql)
        : typeof target[key as string] === "function" ? (target[key as string] as (...a: unknown[]) => unknown).bind(target) : target[key as string],
    });
    const env = makeTestEnv(undefined, { DB: DB as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }) as Env;
    await initializeDatabase(env);
    const n = 36;
    for (let i = 0; i < n; i++) {
      const tags = [KINDS[Math.floor(rand() * 2)], ...(rand() < 0.4 ? ["work"] : []), ...(rand() < hiddenShare ? [rand() < 0.5 ? "auto-insight" : "status:deprecated"] : [])];
      sqlite.seed({ id: `m${i}`, content: `${rand() < 0.6 ? "topic note" : "other words"} number ${i}`, createdAt: 1000 + Math.floor(rand() * 500), tags });
      sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(rand() < 0.15 ? "ws-x" : rand() < 0.5 ? "ws-p" : "ws-co", `m${i}`).run();
    }
    for (let e = 0; e < 60; e++) {
      const a = Math.floor(rand() * n), b = Math.floor(rand() * n);
      if (a === b) continue;
      await sqlite.db.prepare(`INSERT OR IGNORE INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at) VALUES (?, ?, ?, 'relates_to', ?, 'inferred', '{}', 1, 1)`)
        .bind(`edge-${e}`, `m${a}`, `m${b}`, 0.4 + rand() * 0.6).run();
    }
    // The index knows every memory (hidden and foreign ones too), one or two chunks each, in a shuffled score order.
    const chunks = Array.from({ length: n }, (_, i) => Array.from({ length: 1 + Math.floor(rand() * 2) }, (_, c) => ({ i, c })))
      .flat().map(x => ({ ...x, r: rand() })).sort((x, y) => y.r - x.r);
    const index = chunks.map((x, k) => ({ id: `v${x.i}-${x.c}`, score: 0.98 - k * 0.004, values: Array.from({ length: 6 }, () => rand() - 0.5), metadata: { parentId: `m${x.i}`, isUpdate: false } }));
    const query = vi.fn(async (_v: unknown, opts: { topK?: number } = {}) => ({ matches: index.slice(0, opts.topK ?? 10) }));
    (env as any).VECTORIZE = makeVectorizeMock({ query: query as never });
    return { env, sqlite };
  }

  const configs: { name: string; params: Record<string, unknown>; identity?: Identity }[] = [
    { name: "plain", params: {} },
    { name: "hops 1", params: { hops: 1 } },
    { name: "hops 2", params: { hops: 2 } },
    { name: "hops 1, kind", params: { hops: 1, kind: "episodic" } },
    { name: "hops 1, tag", params: { hops: 1, tag: "work" } },
    { name: "hops 1, after", params: { hops: 1, after: 1150 } },
    { name: "hops 1, after and before", params: { hops: 1, after: 1100, before: 1400 } },
    { name: "hops 1, scoped member", params: { hops: 1 }, identity: member },
    { name: "hops 0, scoped member, kind", params: { kind: "semantic" }, identity: member },
  ];

  for (const hiddenShare of [0, 0.25, 0.4]) {
    it(`every topK 1-20 is a prefix of every larger one (hidden share ${hiddenShare})`, async () => {
      for (const seed of [11, 12, 13]) {
        const { env, sqlite } = await corpus(seed * 7 + Math.round(hiddenShare * 100), hiddenShare);
        try {
          for (const cfg of configs) {
            const lists: string[][] = [];
            for (let k = 1; k <= RECALL_MAX_TOP_K; k++) {
              const res = await recallEntries({ query: "topic note", topK: k, synthesize: false, ...cfg.params }, env, ctx, undefined, cfg.identity ? { identity: cfg.identity } : {});
              lists.push(res.matches.map(m => m.id));
            }
            for (let a = 0; a < lists.length; a++) for (let b = a + 1; b < lists.length; b++) {
              expect(lists[a], `${cfg.name}, seed ${seed}, topK ${a + 1} vs ${b + 1}`).toEqual(lists[b].slice(0, lists[a].length));
            }
          }
        } finally {
          sqlite.close();
        }
      }
    }, 120_000);
  }
});
