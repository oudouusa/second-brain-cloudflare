/**
 * The reranker composes with T-0081's block layout: it rescales scores inside the candidate pool before MMR, and
 * the pool, the blocks of five and the graph slots (ranks 5 and 10) are laid out after it. So with the model ON:
 * a smaller topK is still the leading part of every larger one, linked memories still sit exactly where they sit
 * without the reranker (see test/eval/legacy-rerank.test.ts, which uses cases where the graph does surface linked
 * memories), and the model really does reorder direct results (a scrambling stand-in, so the prefix test cannot
 * pass by the reranker doing nothing).
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import { RECALL_MAX_TOP_K, RERANK_MODEL, RERANK_READY_KV_KEY } from "../../src/constants";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";
import { resetRerankReadyMemo } from "../../src/recall/model-reranker";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { mulberry32 } from "../eval/stats";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const hash = (s: string) => parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16) / 0xffffffff;

describe("reranker with the block layout", () => {
  const open: SqliteD1[] = [];
  afterEach(() => { open.splice(0).forEach(s => s.close()); resetRerankReadyMemo(); });

  async function corpus(seed: number) {
    resetDatabaseInit();
    resetRerankReadyMemo();
    const rand = mulberry32(seed);
    const sqlite = makeSqliteD1();
    open.push(sqlite);
    // The recall_count write feeds the next ranking; drop it so every call ranks the same brain.
    const DB = new Proxy(sqlite.db as object as Record<string, unknown>, {
      get: (target, key) => key === "prepare"
        ? (sql: string) => sql.includes("SET recall_count = recall_count + 1") ? { bind: () => ({ run: async () => ({}) }) } : (target.prepare as (s: string) => unknown)(sql)
        : typeof target[key as string] === "function" ? (target[key as string] as (...a: unknown[]) => unknown).bind(target) : target[key as string],
    });
    const kv = makeMemoryKV();
    await kv.put(RERANK_READY_KV_KEY, "1");
    const rerankCalls: string[] = [];
    const ai = { run: vi.fn(async (model: string, input: any) => {
      if (model === RERANK_MODEL) {
        rerankCalls.push(input.query);
        // A scrambling model: unrelated to the heuristic order, so any reorder it causes is visible.
        return { response: input.contexts.map((c: { text: string }, id: number) => ({ id, score: hash(c.text) * 10 - 5 })) };
      }
      return { data: [new Array(768).fill(0.1)] };
    }) } as unknown as Ai;
    const env = makeTestEnv(undefined, { DB: DB as unknown as Env["DB"], OAUTH_KV: kv, AI: ai }) as Env;
    await initializeDatabase(env);
    const n = 40;
    for (let i = 0; i < n; i++) {
      sqlite.seed({ id: `m${i}`, content: `topic note number ${i} about planning`, createdAt: 1000 + Math.floor(rand() * 500), tags: ["work"] });
    }
    // Linked memories the index does not know and whose text shares no query word: only the graph can surface them.
    for (let k = 0; k < 14; k++) {
      sqlite.seed({ id: `link${k}`, content: `why the planning changed: rationale ${k}`, createdAt: 1600 + k, tags: ["work"] });
      const from = Math.floor(rand() * n);
      await sqlite.db.prepare(`INSERT OR IGNORE INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at) VALUES (?, ?, ?, 'decided', 1, 'explicit', '{}', 1, 1)`)
        .bind(`edge-${k}`, `m${from}`, `link${k}`).run();
    }
    const chunks = Array.from({ length: n }, (_, i) => ({ i, r: rand() })).sort((x, y) => y.r - x.r);
    const index = chunks.map((x, k) => ({ id: `v${x.i}`, score: 0.98 - k * 0.004, values: Array.from({ length: 6 }, () => rand() - 0.5), metadata: { parentId: `m${x.i}`, isUpdate: false } }));
    const query = vi.fn(async (_v: unknown, opts: { topK?: number } = {}) => ({ matches: index.slice(0, opts.topK ?? 10) }));
    (env as any).VECTORIZE = makeVectorizeMock({ query: query as never });
    return { env, rerankCalls };
  }

  const run = async (env: Env, topK: number, hops: number, mode: "on" | "off") => {
    const diagnostics: RecallDiagnostics = {};
    const res = await recallEntries({ query: "why did the topic note planning change", topK, hops, synthesize: false }, env, ctx, Object.freeze({ ...DEFAULTS, RERANK_MODE: mode }), { diagnostics });
    return { matches: res.matches, ids: res.matches.map(m => m.id), diagnostics };
  };

  it("keeps the topK prefix property with the model on, with and without hops", async () => {
    for (const seed of [3, 4, 5]) {
      const { env } = await corpus(seed);
      for (const hops of [0, 1, 2]) {
        const lists: string[][] = [];
        for (let k = 1; k <= RECALL_MAX_TOP_K; k++) lists.push((await run(env, k, hops, "on")).ids);
        for (let a = 0; a < lists.length; a++) for (let b = a + 1; b < lists.length; b++) {
          expect(lists[a], `seed ${seed}, hops ${hops}, topK ${a + 1} vs ${b + 1}`).toEqual(lists[b].slice(0, lists[a].length));
        }
      }
    }
  }, 240_000);

  it("the model really does reorder direct results here (a scrambling stand-in), across seeds and hops", async () => {
    let reordered = 0;
    for (const seed of [3, 4, 5, 6]) {
      const { env } = await corpus(seed);
      for (const hops of [0, 1]) {
        const off = await run(env, RECALL_MAX_TOP_K, hops, "off");
        const on = await run(env, RECALL_MAX_TOP_K, hops, "on");
        expect(on.diagnostics.rerankRoute, `seed ${seed}, hops ${hops}`).toBe("applied");
        if (JSON.stringify(on.ids) !== JSON.stringify(off.ids)) reordered++;
      }
    }
    expect(reordered).toBeGreaterThan(0);
  }, 240_000);

  it("every linked memory finds its root: no expanded node is rejected for want of one", async () => {
    for (const seed of [3, 4]) {
      const { env } = await corpus(seed);
      for (const hops of [1, 2]) {
        const { diagnostics } = await run(env, RECALL_MAX_TOP_K, hops, "on");
        expect((diagnostics.rejections ?? []).filter(r => r.reason === "no-root")).toEqual([]);
        expect(diagnostics.expandedIds?.length ?? 0).toBeGreaterThan(0); // the graph did expand, so this is not vacuous
      }
    }
  });

  it("never lists a memory twice and keeps the list within topK", async () => {
    const { env } = await corpus(7);
    for (const k of [5, 10, 20]) {
      const { ids } = await run(env, k, 1, "on");
      expect(ids.length).toBeLessThanOrEqual(k);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
