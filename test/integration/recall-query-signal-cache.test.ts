import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import { observeWorkersAiQuotaError } from "../../src/lib/ai";
import { QUERY_SIGNAL_CACHE_PREFIX } from "../../src/recall/query-signal-cache";
import { recallEntries } from "../../src/recall/search";
import type { RecallInternalOptions } from "../../src/recall/types";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const open: SqliteD1[] = [];
const pending: Promise<unknown>[] = [];
async function drain() {
  for (let i = 0; i < pending.length; i++) await pending[i];
  pending.length = 0;
}
afterEach(async () => {
  await drain();
  open.splice(0).forEach(db => db.close());
  vi.restoreAllMocks();
});

async function fixture() {
  const sqlite = makeSqliteD1();
  open.push(sqlite);
  sqlite.seed({ id: "a", content: "atlas planning", tags: ["atlas"], createdAt: 1000 });
  sqlite.seed({ id: "b", content: "atlas planning", tags: ["obsolete"], createdAt: 1000 });
  const kv = makeMemoryKV();
  const run = vi.fn(async (model: string) => {
    if (model !== DEFAULTS.EMBEDDING_MODEL) throw new Error("タグ推論などのAI呼出しは禁止");
    return { data: [new Array(768).fill(0.1)] };
  });
  const env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv, AI: { run } as unknown as Ai,
    VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: ["a", "b"].map(id => ({
      id, score: 0.9, metadata: { parentId: id }, values: new Array(128).fill(0.1),
    })) }) }),
  });
  const waitUntil = vi.fn((p: Promise<unknown>) => { pending.push(p); });
  const ctx = { waitUntil } as unknown as ExecutionContext;
  return { kv, env, run, waitUntil,
    recall: (internal: RecallInternalOptions = {}) => recallEntries(
      { query: "atlas", topK: 2, hops: 0, synthesize: false }, env, ctx,
      { ...DEFAULTS, RERANK_MODE: "off" }, internal,
    ),
    key: async () => (await kv.list({ prefix: QUERY_SIGNAL_CACHE_PREFIX })).keys[0].name,
  };
}

describe("recallのquery embedding cache", () => {
  it("missをwaitUntilで保存し、旧cacheのtagを無視してhitでも同じ順位を返す", async () => {
    const f = await fixture();
    const first = await f.recall();
    await drain();
    expect(first.querySignalCacheHit).toBe(false);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.waitUntil).toHaveBeenCalled();
    const key = await f.key();
    const cached = JSON.parse((await f.kv.get(key))!);
    expect(cached.queryTags).toEqual([]);
    expect(cached.values).toHaveLength(128);
    cached.queryTags = ["obsolete"];
    await f.kv.put(key, JSON.stringify(cached));
    f.run.mockClear();
    const second = await f.recall();
    expect(second.querySignalCacheHit).toBe(true);
    expect(second.matches).toEqual(first.matches);
    expect(second.matches[0].id).toBe("a");
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(["破損JSON", "次元不一致", "KV読取障害"])("%sではAIへ退避しcacheHitをfalseにする", async mode => {
    const f = await fixture();
    await f.recall();
    await drain();
    const key = await f.key();
    if (mode === "KV読取障害") {
      const get = f.kv.get.bind(f.kv);
      vi.spyOn(f.kv, "get").mockImplementation((async (name: string) => {
        if (name.startsWith(QUERY_SIGNAL_CACHE_PREFIX)) throw new Error("合成KV障害");
        return get(name);
      }) as typeof f.kv.get);
    } else {
      const cached = JSON.parse((await f.kv.get(key))!);
      cached.values.pop();
      await f.kv.put(key, mode === "破損JSON" ? "{" : JSON.stringify(cached));
    }
    f.run.mockClear();
    const result = await f.recall();
    expect(result.querySignalCacheHit).toBe(false);
    expect(result.semanticUnavailable).toBe(false);
    expect(result.matches[0].id).toBe("a");
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("KV書込障害でも検索とwaitUntilは失敗しない", async () => {
    const f = await fixture();
    const put = f.kv.put.bind(f.kv);
    vi.spyOn(f.kv, "put").mockImplementation(async (name, value, options) => {
      if (name.startsWith(QUERY_SIGNAL_CACHE_PREFIX)) throw new Error("合成KV障害");
      return put(name, value, options);
    });
    expect((await f.recall()).matches[0].id).toBe("a");
    await drain();
    expect((await f.kv.list({ prefix: QUERY_SIGNAL_CACHE_PREFIX })).keys).toEqual([]);
    expect((await f.recall()).querySignalCacheHit).toBe(false);
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it("quota markerがあるmissはAIを短絡し、失敗したembeddingを保存しない", async () => {
    const f = await fixture();
    await observeWorkersAiQuotaError(f.env, new Error("4006: daily free allocation used"));
    const result = await f.recall();
    await drain();
    expect(result.querySignalCacheHit).toBe(false);
    expect(result.semanticUnavailableReason).toBe("workers_ai_quota_exhausted");
    expect(result.matches.length).toBeGreaterThan(0);
    expect(f.run).not.toHaveBeenCalled();
    expect((await f.kv.list({ prefix: QUERY_SIGNAL_CACHE_PREFIX })).keys).toEqual([]);
  });

  it("quota markerがあっても既存hitはAIなしで再利用する", async () => {
    const f = await fixture();
    await f.recall();
    await drain();
    await observeWorkersAiQuotaError(f.env, new Error("4006: daily free allocation used"));
    f.run.mockClear();
    const result = await f.recall();
    expect(result.querySignalCacheHit).toBe(true);
    expect(result.semanticUnavailable).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  });

  it("keyword-only評価はcacheを読まず書かず、その後のdense検索を汚染しない", async () => {
    const f = await fixture();
    const get = vi.spyOn(f.kv, "get");
    const result = await f.recall({ variant: { arms: "keyword-only" } });
    await drain();
    expect(result.querySignalCacheHit).toBe(false);
    expect(get.mock.calls.some(([key]) => String(key).startsWith(QUERY_SIGNAL_CACHE_PREFIX))).toBe(false);
    expect((await f.kv.list({ prefix: QUERY_SIGNAL_CACHE_PREFIX })).keys).toEqual([]);
    expect(f.run).not.toHaveBeenCalled();
    expect((await f.recall()).querySignalCacheHit).toBe(false);
    expect(f.run).toHaveBeenCalledTimes(1);
  });
});
