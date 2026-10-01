import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import {
  buildStandingCache, readStandingCaches, resetStandingIsolateState, standingKvKey, standingTouched,
  STANDING_CACHE_MAX_AGE_MS, STANDING_ISOLATE_MEMO_MS, type StandingCacheConfig,
} from "../../src/standing/cache";
import { decodeVector, encodeVector, type StandingCacheV1 } from "../../src/standing/codec";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

import { makeTestEnv } from "../helpers/make-env";

const cfg: StandingCacheConfig = { STANDING_MAX: 3, EMBEDDING_MODEL: "m", EMBEDDING_DIM: 2 };

function insertEntry(sqlite: SqliteD1, opts: { id: string; workspaceId?: string; tags?: string[]; vectorIds?: string[]; createdAt?: number }): void {
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id) VALUES (?, 'memory', ?, 'api', ?, ?, ?)`,
  ).bind(
    opts.id, JSON.stringify(opts.tags ?? ["standing:active"]), opts.createdAt ?? 1,
    JSON.stringify(opts.vectorIds ?? [opts.id]), opts.workspaceId ?? "ws-a",
  ).run();
}

function makeStandingKV(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const puts: { key: string; value: unknown }[] = [];
  let failNextPuts = 0;
  const kv = {
    get: vi.fn(async (keyOrKeys: string | string[]) => {
      if (Array.isArray(keyOrKeys)) {
        const m = new Map<string, unknown>();
        for (const k of keyOrKeys) m.set(k, store.get(k) ?? null);
        return m;
      }
      return store.get(keyOrKeys) ?? null;
    }),
    put: vi.fn(async (key: string, value: string) => {
      if (failNextPuts > 0) { failNextPuts--; throw new Error("429"); }
      const parsed = JSON.parse(value);
      store.set(key, parsed);
      puts.push({ key, value: parsed });
    }),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
  } as unknown as KVNamespace;
  return { kv, store, puts, failNextPuts: (n: number) => { failNextPuts = n; } };
}

function makeStandingVectorize(vectors: Record<string, number[]>) {
  const calls: string[][] = [];
  const vectorize = {
    getByIds: vi.fn(async (ids: string[]) => {
      calls.push(ids);
      return ids.filter(id => vectors[id]).map(id => ({ id, values: vectors[id] }));
    }),
  } as unknown as Vectorize;
  return { vectorize, calls };
}

function envFor(sqlite: SqliteD1, vectorize: Vectorize, kv: KVNamespace): Env {
  return sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, VECTORIZE: vectorize as unknown as Env["VECTORIZE"], OAUTH_KV: kv }));
}

const vecOf = (item: StandingCacheV1["items"][number] | undefined, i = 0) => (item ? Array.from(decodeVector(item.vecs[i])) : undefined);

describe("buildStandingCache", () => {
  let sqlite: SqliteD1;
  beforeEach(() => { sqlite = makeSqliteD1(); resetStandingIsolateState(); });

  it("keeps the oldest STANDING_MAX, dropping newer over-cap rows", async () => {
    for (let i = 0; i < 5; i++) insertEntry(sqlite, { id: `m${i}`, createdAt: i, vectorIds: [`m${i}`] });
    const { vectorize } = makeStandingVectorize(Object.fromEntries([0, 1, 2, 3, 4].map(i => [`m${i}`, [i, i]])));
    const { kv } = makeStandingKV();
    const cache = await buildStandingCache(envFor(sqlite, vectorize, kv), cfg, "ws-a");
    expect(cache.items.map(i => i.id)).toEqual(["m0", "m1", "m2"]);
  });

  it("excludes deprecated, conflict-held and quarantine rows", async () => {
    insertEntry(sqlite, { id: "keep", tags: ["standing:active"], createdAt: 1 });
    insertEntry(sqlite, { id: "deprecated", tags: ["standing:active", "status:deprecated"], createdAt: 2 });
    insertEntry(sqlite, { id: "held", tags: ["standing:active", "conflict-held"], createdAt: 3 });
    // A recognized reason: isHeld/NOT_HELD_SQL match the five exact reasons this Worker writes.
    insertEntry(sqlite, { id: "quarantined", tags: ["standing:active", "quarantine:hidden"], createdAt: 4 });
    const { vectorize } = makeStandingVectorize({ keep: [1, 1], deprecated: [1, 1], held: [1, 1], quarantined: [1, 1] });
    const { kv } = makeStandingKV();
    const cache = await buildStandingCache(envFor(sqlite, vectorize, kv), cfg, "ws-a");
    expect(cache.items.map(i => i.id)).toEqual(["keep"]);
  });

  it("uses known vectors for just-written rows instead of fetching them", async () => {
    insertEntry(sqlite, { id: "fresh", createdAt: 1, vectorIds: ["fresh"] });
    const { vectorize, calls } = makeStandingVectorize({}); // Vectorize has nothing yet (async upsert not visible)
    const { kv } = makeStandingKV();
    const cache = await buildStandingCache(envFor(sqlite, vectorize, kv), cfg, "ws-a", [{ id: "fresh", vector: [3, 4] }]);
    expect(cache.items).toHaveLength(1);
    expect(vecOf(cache.items[0])).toEqual([3, 4]);
    expect(calls).toHaveLength(0); // never asked Vectorize for the chunk it already has
  });

  it("keeps a previous vector when getByIds misses and sets retryAt", async () => {
    insertEntry(sqlite, { id: "stale-fetch", createdAt: 1, vectorIds: ["stale-fetch"] });
    const prev: StandingCacheV1 = {
      v: 1, model: cfg.EMBEDDING_MODEL, dim: cfg.EMBEDDING_DIM, builtAt: 0,
      items: [{ id: "stale-fetch", projects: [], createdAt: 1, vecs: [encodeVector([5, 6])] }],
    };
    const { vectorize } = makeStandingVectorize({}); // this build's getByIds misses it
    const { kv } = makeStandingKV({ [standingKvKey("ws-a")]: prev });
    const cache = await buildStandingCache(envFor(sqlite, vectorize, kv), cfg, "ws-a", [], { now: 1000 });
    expect(cache.items).toHaveLength(1);
    expect(vecOf(cache.items[0])).toEqual([5, 6]);
    expect(cache.retryAt).toBeUndefined(); // the row was recovered from the previous cache, so nothing to retry
  });

  it("drops a row and sets retryAt when neither a known vector nor a fetch nor a previous cache has it", async () => {
    insertEntry(sqlite, { id: "not-indexed-yet", createdAt: 1, vectorIds: ["not-indexed-yet"] });
    const { vectorize } = makeStandingVectorize({});
    const { kv } = makeStandingKV();
    const cache = await buildStandingCache(envFor(sqlite, vectorize, kv), cfg, "ws-a", [], { now: 1000 });
    expect(cache.items).toHaveLength(0);
    expect(cache.retryAt).toBe(1000 + 10 * 60 * 1000);
  });

  it("batches getByIds at VECTORIZE_GET_BY_IDS_BATCH (20)", async () => {
    for (let i = 0; i < 25; i++) insertEntry(sqlite, { id: `m${i}`, createdAt: i, vectorIds: [`m${i}`] });
    const { vectorize, calls } = makeStandingVectorize(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`m${i}`, [i, i]])));
    const { kv } = makeStandingKV();
    await buildStandingCache(envFor(sqlite, vectorize, kv), { ...cfg, STANDING_MAX: 25 }, "ws-a");
    expect(calls.map(c => c.length)).toEqual([20, 5]);
  });

  it("never reads another workspace's rows", async () => {
    insertEntry(sqlite, { id: "mine", workspaceId: "ws-a", createdAt: 1, vectorIds: ["mine"] });
    insertEntry(sqlite, { id: "theirs", workspaceId: "ws-b", createdAt: 2, vectorIds: ["theirs"] });
    const { vectorize } = makeStandingVectorize({ mine: [1, 1], theirs: [1, 1] });
    const { kv } = makeStandingKV();
    const cache = await buildStandingCache(envFor(sqlite, vectorize, kv), cfg, "ws-a");
    expect(cache.items.map(i => i.id)).toEqual(["mine"]);
  });

  it("retries once after a put failure and then gives up without throwing", async () => {
    insertEntry(sqlite, { id: "m", createdAt: 1, vectorIds: ["m"] });
    const { vectorize } = makeStandingVectorize({ m: [1, 1] });
    const { kv, puts } = makeStandingKV();
    kv.put = vi.fn().mockRejectedValue(new Error("429"));
    await expect(buildStandingCache(envFor(sqlite, vectorize, kv), cfg, "ws-a", [], { retryDelayMs: 0 })).resolves.toBeDefined();
    expect(vi.mocked(kv.put).mock.calls).toHaveLength(2);
  });

  it("does not write to KV a second time when nothing changed (budget audit dab677a5)", async () => {
    insertEntry(sqlite, { id: "m", createdAt: 1, vectorIds: ["m"] });
    const { vectorize } = makeStandingVectorize({ m: [1, 1] });
    const { kv, puts } = makeStandingKV();
    const env = envFor(sqlite, vectorize, kv);
    await buildStandingCache(env, cfg, "ws-a", [], { now: 1000 });
    expect(puts).toHaveLength(1);
    await buildStandingCache(env, cfg, "ws-a", [], { now: 2000 }); // same D1 rows, same Vectorize state, no pending retry
    expect(puts).toHaveLength(1); // the second build's result matched what was already stored, so it was not written
  });

  it("writes again once the content genuinely changes", async () => {
    insertEntry(sqlite, { id: "m", createdAt: 1, vectorIds: ["m"] });
    const { vectorize } = makeStandingVectorize({ m: [1, 1] });
    const { kv, puts } = makeStandingKV();
    const env = envFor(sqlite, vectorize, kv);
    await buildStandingCache(env, cfg, "ws-a", [], { now: 1000 });
    insertEntry(sqlite, { id: "m2", createdAt: 2, vectorIds: ["m2"] });
    const { vectorize: vectorize2 } = makeStandingVectorize({ m: [1, 1], m2: [2, 2] });
    await buildStandingCache(envFor(sqlite, vectorize2, kv), cfg, "ws-a", [], { now: 2000 });
    expect(puts).toHaveLength(2);
  });

  it("backs off a permanently unresolved row, bounding a day's writes to a small constant instead of one every 10 minutes (budget audit dab677a5)", async () => {
    insertEntry(sqlite, { id: "stuck", createdAt: 0, vectorIds: ["stuck"] });
    const { vectorize } = makeStandingVectorize({}); // never resolves: simulates a memory that never gets indexed
    const { kv, puts } = makeStandingKV();
    const env = envFor(sqlite, vectorize, kv);
    const ONE_DAY = 24 * 60 * 60 * 1000;
    let now = 0;
    let cache = await buildStandingCache(env, cfg, "ws-a", [], { now });
    let builds = 1;
    // Jump straight to when readStandingCaches would next schedule a build (its own retryAt), the same way
    // production driving through the day would, and count how many land inside one 24-hour window.
    while (cache.retryAt !== undefined && cache.retryAt < ONE_DAY) {
      now = cache.retryAt;
      cache = await buildStandingCache(env, cfg, "ws-a", [], { now });
      builds++;
    }
    expect(cache.retryAt).toBeDefined(); // still never resolved, so still retrying, just far less often
    expect(builds).toBeLessThanOrEqual(10); // was 144 (a flat 10-minute retry with no backoff)
    expect(puts.length).toBeLessThanOrEqual(10);
  });

  it("shares one in-flight build across concurrent calls for the same workspace (single-flight, budget audit dab677a5)", async () => {
    insertEntry(sqlite, { id: "m", createdAt: 1, vectorIds: ["m"] });
    const { vectorize, calls } = makeStandingVectorize({ m: [1, 1] });
    const { kv, puts } = makeStandingKV();
    const env = envFor(sqlite, vectorize, kv);
    const [a, b, c] = await Promise.all([
      buildStandingCache(env, cfg, "ws-a"),
      buildStandingCache(env, cfg, "ws-a"),
      buildStandingCache(env, cfg, "ws-a"),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(calls).toHaveLength(1); // Vectorize was asked once, not three times
    expect(puts).toHaveLength(1); // and KV was written once, not three times
  });

  it("single-flight does not leak across separate calls once the first one finishes", async () => {
    insertEntry(sqlite, { id: "m", createdAt: 1, vectorIds: ["m"] });
    const { vectorize, calls } = makeStandingVectorize({ m: [1, 1] });
    const { kv } = makeStandingKV();
    const env = envFor(sqlite, vectorize, kv);
    await buildStandingCache(env, cfg, "ws-a");
    await buildStandingCache(env, cfg, "ws-a");
    expect(calls).toHaveLength(2); // two genuinely separate (sequential, non-overlapping) builds
  });

  it("tolerates a cross-isolate race: a fresh pre-write read catches a value another build already wrote (budget audit dab677a5)", async () => {
    insertEntry(sqlite, { id: "m", createdAt: 1, vectorIds: ["m"] });
    const { vectorize } = makeStandingVectorize({ m: [1, 1] });
    const { kv, puts } = makeStandingKV(); // starts empty
    const env = envFor(sqlite, vectorize, kv);
    const raceWinner: StandingCacheV1 = {
      v: 1, model: cfg.EMBEDDING_MODEL, dim: cfg.EMBEDDING_DIM, builtAt: 999,
      items: [{ id: "m", projects: [], createdAt: 1, vecs: [encodeVector([1, 1])] }],
    };
    let getCalls = 0;
    kv.get = vi.fn(async () => {
      getCalls++;
      // Nothing there yet on this build's own initial read; by the time it is ready to write, another isolate
      // (this test simulates it directly, since single-flight is per-isolate and cannot dedupe across isolates)
      // has already written the identical result.
      return getCalls === 1 ? null : raceWinner;
    }) as unknown as KVNamespace["get"];
    await buildStandingCache(env, cfg, "ws-a", [], { now: 1000 });
    expect(getCalls).toBeGreaterThanOrEqual(2); // proves there is a fresh read right before writing, not just the initial one
    expect(puts).toHaveLength(0); // and the race was caught: no redundant write over the winner's identical result
  });

  it("FX3 finding 5: refreshes builtAt when a stale cache's content is unchanged, instead of skipping the write forever", async () => {
    insertEntry(sqlite, { id: "m", createdAt: 1, vectorIds: ["m"] });
    const { vectorize } = makeStandingVectorize({ m: [1, 1] });
    const staleButIdentical: StandingCacheV1 = {
      v: 1, model: cfg.EMBEDDING_MODEL, dim: cfg.EMBEDDING_DIM, builtAt: 0,
      items: [{ id: "m", projects: [], createdAt: 1, vecs: [encodeVector([1, 1])] }],
    };
    const { kv, puts } = makeStandingKV({ [standingKvKey("ws-a")]: staleButIdentical });
    const env = envFor(sqlite, vectorize, kv);
    const now = STANDING_CACHE_MAX_AGE_MS + 1;

    const cache = await buildStandingCache(env, cfg, "ws-a", [], { now });

    // Old behavior: sameContent ignored builtAt and skipped this write, so the stored builtAt
    // never advanced and readStandingCaches would call this stale again on every future read.
    expect(puts).toHaveLength(1);
    expect(puts[0].value).toMatchObject({ builtAt: now, items: staleButIdentical.items });
    expect(cache.builtAt).toBe(now);
  });

  it("still skips the write when content is unchanged and the stored cache is not yet stale", async () => {
    insertEntry(sqlite, { id: "m", createdAt: 1, vectorIds: ["m"] });
    const { vectorize } = makeStandingVectorize({ m: [1, 1] });
    const fresh: StandingCacheV1 = {
      v: 1, model: cfg.EMBEDDING_MODEL, dim: cfg.EMBEDDING_DIM, builtAt: 1000,
      items: [{ id: "m", projects: [], createdAt: 1, vecs: [encodeVector([1, 1])] }],
    };
    const { kv, puts } = makeStandingKV({ [standingKvKey("ws-a")]: fresh });
    const env = envFor(sqlite, vectorize, kv);

    await buildStandingCache(env, cfg, "ws-a", [], { now: 1000 + 1000 }); // well inside STANDING_CACHE_MAX_AGE_MS

    expect(puts).toHaveLength(0);
  });

  it("the cache-build read is served by idx_entries_standing (EXPLAIN QUERY PLAN)", async () => {
    // Mirrors buildStandingCacheNow's own query text (src/standing/cache.ts) — kept as a
    // literal here, like test/unit/compress-held-plan.test.ts's raw-SQL checks, because the
    // build's query lives inline rather than behind an exported builder.
    const rows = (await sqlite.db.prepare(
      `EXPLAIN QUERY PLAN SELECT id, tags, vector_ids, created_at FROM entries
        WHERE workspace_id = ?1
          AND instr(lower(tags), '"standing:active"') > 0
          AND tags NOT LIKE '%"status:deprecated"%'
          AND tags NOT LIKE '%"conflict-held"%'
          AND tags NOT LIKE '%"quarantine:instruction"%' AND tags NOT LIKE '%"quarantine:hidden"%' AND tags NOT LIKE '%"quarantine:burst"%' AND tags NOT LIKE '%"quarantine:capsule"%' AND tags NOT LIKE '%"quarantine:too_long"%'
        ORDER BY created_at ASC, id ASC
        LIMIT ?2`,
    ).bind("ws-a", 50).all()).results as { detail: string }[];
    const plan = rows.map(r => r.detail).join("\n");
    expect(plan).toContain("idx_entries_standing");
  });
});

describe("readStandingCaches", () => {
  let sqlite: SqliteD1;
  const waitUntil = vi.fn((p: Promise<unknown>) => { p.catch(() => {}); });
  beforeEach(() => { sqlite = makeSqliteD1(); resetStandingIsolateState(); waitUntil.mockClear(); });

  const cacheAt = (builtAt: number, retryAt?: number): StandingCacheV1 =>
    ({ v: 1, model: cfg.EMBEDDING_MODEL, dim: cfg.EMBEDDING_DIM, builtAt, ...(retryAt !== undefined && { retryAt }), items: [] });

  it("bulk-reads all workspace keys in one call", async () => {
    const { kv } = makeStandingKV({ [standingKvKey("ws-a")]: cacheAt(1000), [standingKvKey("ws-b")]: cacheAt(1000) });
    const { vectorize } = makeStandingVectorize({});
    const ctx = { waitUntil };
    await readStandingCaches(envFor(sqlite, vectorize, kv), ctx, cfg, ["ws-a", "ws-b"], 1000);
    expect(vi.mocked(kv.get).mock.calls).toHaveLength(1);
    expect(vi.mocked(kv.get).mock.calls[0][0]).toEqual([standingKvKey("ws-a"), standingKvKey("ws-b")]);
  });

  it("missing key means empty and schedules nothing", async () => {
    const { kv } = makeStandingKV();
    const { vectorize } = makeStandingVectorize({});
    const out = await readStandingCaches(envFor(sqlite, vectorize, kv), { waitUntil }, cfg, ["ws-a"], 1000);
    expect(out).toEqual([]);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("memoizes a read for 60 seconds; standingTouched clears it", async () => {
    const { kv } = makeStandingKV({ [standingKvKey("ws-a")]: cacheAt(1000) });
    const { vectorize } = makeStandingVectorize({});
    const env = envFor(sqlite, vectorize, kv);
    await readStandingCaches(env, { waitUntil }, cfg, ["ws-a"], 1000);
    await readStandingCaches(env, { waitUntil }, cfg, ["ws-a"], 1000 + STANDING_ISOLATE_MEMO_MS - 1);
    expect(vi.mocked(kv.get).mock.calls).toHaveLength(1); // still memoized

    standingTouched(env, { waitUntil }, cfg, ["ws-a"]);
    await readStandingCaches(env, { waitUntil }, cfg, ["ws-a"], 1000 + STANDING_ISOLATE_MEMO_MS - 1);
    // standingTouched cleared the memo, so this read goes to KV again despite being inside the 60s window.
    expect(vi.mocked(kv.get).mock.calls).toHaveLength(2);
  });

  it("re-reads once the memo window has passed", async () => {
    const { kv } = makeStandingKV({ [standingKvKey("ws-a")]: cacheAt(1000) });
    const { vectorize } = makeStandingVectorize({});
    const env = envFor(sqlite, vectorize, kv);
    await readStandingCaches(env, { waitUntil }, cfg, ["ws-a"], 1000);
    await readStandingCaches(env, { waitUntil }, cfg, ["ws-a"], 1000 + STANDING_ISOLATE_MEMO_MS + 1);
    expect(vi.mocked(kv.get).mock.calls).toHaveLength(2);
  });

  it("schedules a rebuild for a stale builtAt, at most once per workspace per 60 seconds", async () => {
    const { kv } = makeStandingKV({ [standingKvKey("ws-a")]: cacheAt(0) });
    const { vectorize } = makeStandingVectorize({});
    const env = envFor(sqlite, vectorize, kv);
    const now = STANDING_CACHE_MAX_AGE_MS + 1;
    await readStandingCaches(env, { waitUntil }, cfg, ["ws-a"], now);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    // A second stale read moments later, inside the throttle window, schedules nothing more.
    resetKvGetOnly(kv);
    await readStandingCaches(env, { waitUntil }, cfg, ["ws-a"], now + 1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("schedules a rebuild for a passed retryAt", async () => {
    const { kv } = makeStandingKV({ [standingKvKey("ws-a")]: cacheAt(1000, 2000) });
    const { vectorize } = makeStandingVectorize({});
    await readStandingCaches(envFor(sqlite, vectorize, kv), { waitUntil }, cfg, ["ws-a"], 2500);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("does not schedule a rebuild for a fresh cache with no pending retry", async () => {
    const { kv } = makeStandingKV({ [standingKvKey("ws-a")]: cacheAt(1000) });
    const { vectorize } = makeStandingVectorize({});
    await readStandingCaches(envFor(sqlite, vectorize, kv), { waitUntil }, cfg, ["ws-a"], 1000 + 1000);
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

describe("standingTouched", () => {
  let sqlite: SqliteD1;
  beforeEach(() => { sqlite = makeSqliteD1(); resetStandingIsolateState(); });

  it("schedules a build per workspace, passing known vectors through", async () => {
    insertEntry(sqlite, { id: "m", createdAt: 1, vectorIds: ["m"] });
    const { vectorize } = makeStandingVectorize({}); // Vectorize has nothing; only "known" resolves it
    const { kv, puts } = makeStandingKV();
    const scheduled: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => scheduled.push(p) };
    standingTouched(envFor(sqlite, vectorize, kv), ctx, cfg, ["ws-a"], [{ id: "m", vector: [7, 8] }]);
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
    expect(puts).toHaveLength(1);
    const cache = puts[0].value as StandingCacheV1;
    expect(vecOf(cache.items[0])).toEqual([7, 8]);
  });
});

function resetKvGetOnly(kv: KVNamespace): void {
  vi.mocked(kv.get).mockClear();
}
