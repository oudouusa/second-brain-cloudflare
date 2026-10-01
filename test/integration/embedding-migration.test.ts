/**
 * #248 — rebuilding every vector after an embedding-model change.
 *
 * Driven against real SQLite (`test/helpers/sqlite-d1.ts`) rather than the
 * string-matching D1 mock, because the correctness of this feature *is* its SQL:
 * a keyset cursor whose comparison decides whether entries get skipped, and an
 * aggregate that projects chunk counts. A mock that matched the query text would
 * pass whatever the comparison said.
 *
 * The properties that matter, in order:
 *
 * 1. **No entry is ever skipped.** A skipped entry is invisible to every repair
 *    mechanism the Worker has — vector ids are deterministic, so `vector_ids`
 *    stays non-empty and `/vectorize-pending` cannot see it.
 * 2. **An interrupted rebuild resumes** rather than restarting, because restarting
 *    spends the one budget that runs out.
 * 3. **A stalled rebuild stops** instead of burning the remaining budget
 *    reproducing the same failure.
 * 4. **D1 content is never written.** Vectors are derived; memories are not.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV } from "../helpers/make-env";
import { chunkText } from "../../src/text/chunk";
import { DEFAULTS } from "../../src/config";
import {
  MIGRATION_KEY,
  clearMigration,
  estimate,
  looksLikeBudgetError,
  readMigration,
  runBatch,
  runDeltaBatch,
} from "../../src/migration/embedding";
import { acquireFinalDeltaLease, memoryWriteMarker, setMemoryWriteLock } from "../../src/migration/write-lock";
import { forgetEntry } from "../../src/capture/lifecycle";
import { storeEntry } from "../../src/capture/store";
import { drainPendingVectorCleanup } from "../../src/vectorize/cleanup";
import { makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/env";

const NEW_MODEL = DEFAULTS.EMBEDDING_MODEL;

/**
 * An AI binding that records which model it was asked for and can be made to
 * fail. `makeAIMock` only returns a vector for the shipped model and hands back a
 * stream for anything else, which is useless here — the point is exercising
 * the fixed fork profile with a real embedding-shaped response.
 */
function makeAI(opts: { failFrom?: number; error?: string } = {}) {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    binding: {
      run: vi.fn(async (model: string) => {
        n++;
        calls.push(model);
        if (opts.failFrom !== undefined && n >= opts.failFrom) {
          throw new Error(opts.error ?? "boom");
        }
        return { data: [new Array(768).fill(0.1)] };
      }),
    },
  };
}

function makeEnv(d1: SqliteD1, ai: ReturnType<typeof makeAI>, kv = makeMemoryKV()) {
  const upserted: { id: string }[][] = [];
  const env = d1.admitEnv({
    DB: d1.db,
    OAUTH_KV: kv,
    AI: ai.binding,
    VECTORIZE: makeVectorizeMock({
      upsert: vi.fn(async (vectors: { id: string }[]) => {
        upserted.push(vectors);
        return { mutationId: "m" };
      }),
      deleteByIds: vi.fn(async () => ({ mutationId: "m" })),
    }),
  } as unknown as Env);
  return { env, upserted, kv };
}

const cfg = { ...DEFAULTS, EMBEDDING_MODEL: NEW_MODEL };

describe("migration estimate", () => {
  let d1: SqliteD1;
  beforeEach(() => {
    d1 = makeSqliteD1();
  });

  it("counts entries and projects at least as many chunks as the chunker makes", async () => {
    // One short entry and one long enough to split, so the projection is
    // exercised rather than trivially 1-per-entry.
    const long = "word ".repeat(900); // 4500 chars
    d1.seed({ id: "short", content: "hello", createdAt: 1 });
    d1.seed({ id: "long", content: long, createdAt: 2 });

    const { env } = makeEnv(d1, makeAI());
    const { entries, chunks } = await estimate(env);

    expect(entries).toBe(2);
    // The projection must never promise fewer chunks than the chunker produces,
    // or the estimate understates the cost the user is agreeing to.
    const real = chunkText("hello").length + chunkText(long).length;
    expect(chunks).toBeLessThanOrEqual(real);
    expect(chunks).toBeGreaterThanOrEqual(2);
  });

  /** Deprecated entries have had their vectors deliberately deleted and recall
   *  filters them out, so rebuilding them would spend the scarce resource of the
   *  whole operation on something nothing reads. */
  it("excludes deprecated entries from the count", async () => {
    d1.seed({ id: "live", content: "a", createdAt: 1 });
    d1.seed({ id: "gone", content: "b", createdAt: 2, tags: ["status:deprecated"] });

    const { env } = makeEnv(d1, makeAI());
    expect((await estimate(env)).entries).toBe(1);
  });

  it("reports zero for an empty brain rather than failing", async () => {
    const { env } = makeEnv(d1, makeAI());
    expect(await estimate(env)).toEqual({ entries: 0, chunks: 0 });
  });
});

describe("migration batches", () => {
  let d1: SqliteD1;
  beforeEach(() => {
    d1 = makeSqliteD1();
  });

  it("re-embeds with the fixed profile model", async () => {
    d1.seed({ id: "a", content: "hello", createdAt: 1 });
    const ai = makeAI();
    const { env } = makeEnv(d1, ai);

    await runBatch(env, cfg);

    expect(ai.calls).toEqual([NEW_MODEL]);
    expect(ai.calls).toEqual([DEFAULTS.EMBEDDING_MODEL]);
  });

  /**
   * The load-bearing property. Every entry must be reached exactly once across
   * however many batches it takes — no gaps, because a gap is undetectable.
   */
  it("covers every entry across batches with no gaps and no repeats", async () => {
    // More entries than one batch will take. Timestamps ascend so this covers
    // ordinary paging; the tie case has its own test below, because a tie only
    // exercises the id tie-break when it spans a batch boundary.
    const ids = Array.from({ length: 40 }, (_, i) => `e${String(i).padStart(2, "0")}`);
    ids.forEach((id, i) => d1.seed({ id, content: `body ${id}`, createdAt: 100 + i }));

    const ai = makeAI();
    const { env } = makeEnv(d1, ai);

    const seen: string[] = [];
    for (let guard = 0; guard < 50; guard++) {
      const before = await readMigration(env);
      const r = await runBatch(env, cfg);
      const after = await readMigration(env);
      // Record what this batch advanced over.
      if (after?.cursorId && after.cursorId !== before?.cursorId) seen.push(after.cursorId);
      if (r.done) break;
    }

    const state = await readMigration(env);
    expect(state?.processed).toBe(40);
    expect(state?.failed).toBe(0);
    // Every entry embedded exactly once.
    expect(ai.calls).toHaveLength(40);
    // And the cursor ended on the last entry in (created_at, id) order.
    expect(state?.cursorId).toBe("e39");
    // Strictly increasing cursor — never revisited a position.
    expect([...seen]).toEqual([...seen].sort());
  });

  /**
   * Entries captured in the same millisecond are common — a bulk import gives a
   * whole brain one timestamp. If the cursor compared `created_at` alone, the
   * batch boundary would fall inside the tied group and everything after it
   * would be skipped, silently and permanently.
   *
   * Every entry here shares one timestamp, so the boundary is guaranteed to land
   * inside the tie. An earlier version of this suite tied only the first five of
   * forty, which never crossed a boundary and left the tie-break untested.
   */
  it("does not skip entries that share a created_at across a batch boundary", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `e${String(i).padStart(2, "0")}`);
    ids.forEach(id => d1.seed({ id, content: `body ${id}`, createdAt: 100 }));

    const ai = makeAI();
    const { env } = makeEnv(d1, ai);

    for (let guard = 0; guard < 50; guard++) {
      if ((await runBatch(env, cfg)).done) break;
    }

    const state = await readMigration(env);
    expect(state?.processed).toBe(40);
    expect(ai.calls).toHaveLength(40);
    expect(state?.cursorId).toBe("e39");
  });

  it("resumes from the cursor instead of starting over", async () => {
    Array.from({ length: 30 }, (_, i) => `e${i}`).forEach((id, i) =>
      d1.seed({ id, content: `body ${id}`, createdAt: 100 + i }),
    );

    const ai = makeAI();
    const { env, kv } = makeEnv(d1, ai);

    const first = await runBatch(env, cfg);
    expect(first.processed).toBeGreaterThan(0);
    expect(first.done).toBe(false);
    const afterFirst = ai.calls.length;

    // A fresh process, same KV: the ledger is the only thing carried over.
    const ai2 = makeAI();
    const { env: env2 } = makeEnv(d1, ai2, kv);
    await runBatch(env2, cfg);

    // The second run embedded new entries, not the ones already done.
    expect(ai2.calls.length).toBeLessThanOrEqual(30 - afterFirst);
    const state = await readMigration(env2);
    expect(state?.processed).toBe(afterFirst + ai2.calls.length);
  });

  it("reports done once, with nothing remaining", async () => {
    d1.seed({ id: "a", content: "one", createdAt: 1 });
    d1.seed({ id: "b", content: "two", createdAt: 2 });
    const { env } = makeEnv(d1, makeAI());

    let last = await runBatch(env, cfg);
    for (let i = 0; i < 5 && !last.done; i++) last = await runBatch(env, cfg);

    expect(last.done).toBe(true);
    expect(last.remaining).toBe(0);
    expect((await readMigration(env))?.finishedAt).toBeGreaterThan(0);
  });

  it("never writes to entries.content", async () => {
    d1.seed({ id: "a", content: "the original text", createdAt: 1 });
    const { env } = makeEnv(d1, makeAI());

    await runBatch(env, cfg);

    const rows = d1.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("the original text");
  });

  it("removes a migrated vector when the source is forgotten during upsert", async () => {
    d1.seed({ id: "private", content: "forget me", createdAt: 1 });
    const { env } = makeEnv(d1, makeAI());
    const indexed = new Set<string>();
    let releaseUpsert!: () => void;
    let enteredUpsert!: () => void;
    const entered = new Promise<void>(resolve => { enteredUpsert = resolve; });
    const gate = new Promise<void>(resolve => { releaseUpsert = resolve; });
    env.VECTORIZE = makeVectorizeMock({
      upsert: vi.fn(async (vectors: { id: string }[]) => {
        enteredUpsert();
        await gate;
        for (const vector of vectors) indexed.add(vector.id);
        return { mutationId: "m" };
      }),
      deleteByIds: vi.fn(async (ids: string[]) => {
        for (const id of ids) indexed.delete(id);
        return { mutationId: "m" };
      }),
    });

    const migration = runBatch(env, cfg);
    await entered;
    expect(await forgetEntry("private", env, { actorId: "", channel: "rest" as const }, { reason: "forget", config: DEFAULTS }, "")).toMatchObject({ status: "deleted" });
    releaseUpsert();
    const result = await migration;

    expect(result.failed).toBe(1);
    expect(indexed.size).toBe(0);
    expect(d1.rows()).toHaveLength(0);
    expect(env.VECTORIZE.deleteByIds).toHaveBeenCalledWith(expect.arrayContaining([expect.stringMatching(/^v-/)]));
  });

  it("protects an active vector journal from a concurrent cleanup pass", async () => {
    d1.seed({ id: "active", content: "still writing", createdAt: 1 });
    const { env } = makeEnv(d1, makeAI());
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const inside = new Promise<void>(resolve => { entered = resolve; });
    env.VECTORIZE = makeVectorizeMock({
      upsert: vi.fn(async () => { entered(); await gate; return { mutationId: "m" }; }),
      deleteByIds: vi.fn(async () => ({ mutationId: "m" })),
    });

    const writing = storeEntry(env, "active", "still writing", [], "api", 1, cfg);
    await inside;
    expect(await drainPendingVectorCleanup(env)).toBe(0);
    expect(env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
    release();
    await writing;
    expect(JSON.parse(d1.rows()[0].vector_ids as string)[0]).toMatch(/^v-/);
  });

  it("quarantines an expired journal before deleting an upsert that is still in flight", async () => {
    d1.seed({ id: "in-flight", content: "private pending body", createdAt: 1 });
    const { env } = makeEnv(d1, makeAI());
    const indexed = new Set<string>();
    let releaseUpsert!: () => void;
    let enteredUpsert!: () => void;
    const gate = new Promise<void>(resolve => { releaseUpsert = resolve; });
    const entered = new Promise<void>(resolve => { enteredUpsert = resolve; });
    env.VECTORIZE = makeVectorizeMock({
      upsert: vi.fn(async (vectors: { id: string }[]) => {
        enteredUpsert();
        await gate;
        vectors.forEach(vector => indexed.add(vector.id));
        return { mutationId: "m" };
      }),
      deleteByIds: vi.fn(async (ids: string[]) => { ids.forEach(id => indexed.delete(id)); return { mutationId: "m" }; }),
    });

    const writing = storeEntry(env, "in-flight", "private pending body", [], "api", 1, cfg);
    await entered;
    await d1.db.prepare(`UPDATE vector_cleanup_ops SET expires_at = 0`).run();

    // First recovery pass only takes ownership and starts a fresh grace period.
    // Deleting now could run before the still-pending upsert and lose the tombstone.
    expect(await drainPendingVectorCleanup(env)).toBe(0);
    expect(env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
    const quarantined = await d1.db.prepare(
      `SELECT ready, expires_at FROM vector_cleanup_ops`,
    ).first() as { ready: number; expires_at: number };
    expect(quarantined.ready).toBe(2);
    expect(quarantined.expires_at).toBeGreaterThan(Date.now());

    releaseUpsert();
    expect(await writing).toMatchObject({ committed: false });
    expect(indexed.size).toBe(0);
    expect(JSON.parse(d1.rows()[0].vector_ids as string)).toEqual([]);
  });

  it("fences a writer whose expired cleanup journal was claimed before its D1 commit", async () => {
    d1.seed({ id: "expired", content: "slow write", createdAt: 1 });
    const { env } = makeEnv(d1, makeAI());
    const indexed = new Set<string>();
    env.VECTORIZE = makeVectorizeMock({
      upsert: vi.fn(async (vectors: { id: string }[]) => { vectors.forEach(vector => indexed.add(vector.id)); return { mutationId: "m" }; }),
      deleteByIds: vi.fn(async (ids: string[]) => { ids.forEach(id => indexed.delete(id)); return { mutationId: "m" }; }),
    });

    const originalPrepare = env.DB.prepare.bind(env.DB);
    const realBatch = env.DB.batch.bind(env.DB);
    let releaseCommit!: () => void, reachedCommit!: () => void;
    const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
    const atCommit = new Promise<void>(resolve => { reachedCommit = resolve; });
    let paused = false;
    env.DB.batch = async (statements) => {
      if (!paused) { paused = true; reachedCommit(); await commitGate; }
      return realBatch(statements);
    };

    const writing = storeEntry(env, "expired", "slow write", [], "api", 1, cfg);
    await atCommit;
    await originalPrepare(`UPDATE vector_cleanup_ops SET expires_at = 0`).run();
    expect(await drainPendingVectorCleanup(env)).toBe(0);
    expect(indexed.size).toBe(0);

    releaseCommit();
    expect(await writing).toMatchObject({ committed: false });
    expect(JSON.parse(d1.rows()[0].vector_ids as string)).toEqual([]);
    expect(indexed.size).toBe(0);
  });

  it("durably retries cleanup after capture is forgotten and three deletes fail", async () => {
    d1.seed({ id: "forgotten", content: "private body", createdAt: 1 });
    const { env } = makeEnv(d1, makeAI());
    const indexed = new Set<string>();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const inside = new Promise<void>(resolve => { entered = resolve; });
    let deleteAttempts = 0;
    env.VECTORIZE = makeVectorizeMock({
      upsert: vi.fn(async (vectors: { id: string }[]) => {
        entered();
        await gate;
        vectors.forEach(vector => indexed.add(vector.id));
        return { mutationId: "m" };
      }),
      deleteByIds: vi.fn(async (ids: string[]) => {
        deleteAttempts++;
        if (deleteAttempts <= 3) throw new Error("temporary delete failure");
        ids.forEach(id => indexed.delete(id));
        return { mutationId: "m" };
      }),
    });

    const writing = storeEntry(env, "forgotten", "private body", [], "api", 1, cfg);
    await inside;
    await forgetEntry("forgotten", env, { actorId: "", channel: "rest" as const }, { reason: "forget", config: DEFAULTS }, "");
    release();
    await expect(writing).rejects.toThrow("temporary delete failure");
    expect(indexed.size).toBe(1);
    // 失敗したuploadの台帳はreceipt確認まで残す。
    expect(await drainPendingVectorCleanup(env)).toBe(0);
    expect(indexed.size).toBe(0);
    await d1.db.prepare(`UPDATE vector_cleanup_ops SET expires_at = 0`).run();
    expect(await drainPendingVectorCleanup(env)).toBe(1);
  });

  it("keeps the default one-page drain but can retire three bounded cleanup pages", async () => {
    const { env } = makeEnv(d1, makeAI());
    env.VECTORIZE = makeVectorizeMock({
      describe: vi.fn(async () => ({
        vectorCount: 0, dimensions: 128, processedUpToMutation: "delete-receipt",
        // 公式Vectorize APIのstring形式。生成型のnumber定義とはこのfixtureで区別する。
        processedUpToDatetime: "9999-12-31T23:59:59.999Z",
      } as unknown as VectorizeIndexInfo)),
      getByIds: vi.fn(async () => []),
      deleteByIds: vi.fn(async () => ({ mutationId: "delete-receipt" })),
    });

    for (let i = 0; i < 35; i++) {
      await d1.db.prepare(
        `INSERT INTO vector_cleanup_ops
           (op_id, entry_id, vector_ids, created_at, ready, expires_at, write_marker)
         VALUES (?, ?, ?, ?, 3, 0, ?)`,
      ).bind(
        `cleanup-${i}`,
        `retired-${i}`,
        JSON.stringify({
          ids: [`old-vector-${i}`],
          deleteMutationId: "delete-receipt",
          deleteSubmittedAt: 1,
        }),
        i,
        d1.fixtureMarker(),
      ).run();
    }

    expect(await drainPendingVectorCleanup(env)).toBe(10);
    expect((await d1.db.prepare(`SELECT COUNT(*) AS count FROM vector_cleanup_ops`).first() as { count: number }).count).toBe(25);

    expect(await drainPendingVectorCleanup(env, { maxPages: 3 })).toBe(25);
    expect((await d1.db.prepare(`SELECT COUNT(*) AS count FROM vector_cleanup_ops`).first() as { count: number }).count).toBe(0);
  });

  it("retires the prior random vector IDs when a lost cursor retries the full row", async () => {
    d1.seed({ id: "retry", content: "retry body", createdAt: 1 });
    const kv = makeMemoryKV();
    const realPut = kv.put.bind(kv);
    let failPut = true;
    kv.put = vi.fn(async (...args: Parameters<KVNamespace["put"]>) => {
      if (failPut) { failPut = false; throw new Error("lost cursor write"); }
      return realPut(...args);
    }) as KVNamespace["put"];
    const { env } = makeEnv(d1, makeAI(), kv);
    const indexed = new Set<string>();
    env.VECTORIZE = makeVectorizeMock({
      upsert: vi.fn(async (vectors: { id: string }[]) => { vectors.forEach(vector => indexed.add(vector.id)); return { mutationId: "m" }; }),
      deleteByIds: vi.fn(async (ids: string[]) => { ids.forEach(id => indexed.delete(id)); return { mutationId: "m" }; }),
    });

    await expect(runBatch(env, cfg)).rejects.toThrow("lost cursor write");
    expect(indexed.size).toBe(1);
    await runBatch(env, cfg);
    expect(indexed.size).toBe(1);
    expect(env.VECTORIZE.deleteByIds).toHaveBeenCalled();
  });

  /**
   * `reembedOrThrow` looks like the natural helper for this and is the wrong one:
   * it hardcodes `Date.now()`, which would stamp every rebuilt vector's metadata
   * with migration time. Recall's keyword fusion reads that metadata, so a whole
   * brain would look as though every memory were created the day it migrated.
   */
  it("stamps rebuilt vectors with the entry's own created_at, not now", async () => {
    const originally = 1_600_000_000_000;
    d1.seed({ id: "a", content: "hello", createdAt: originally });
    const { env, upserted } = makeEnv(d1, makeAI());

    await runBatch(env, cfg);

    expect(upserted).toHaveLength(1);
    const [vector] = upserted[0] as unknown as { metadata: Record<string, unknown> }[];
    expect(vector.metadata.created_at).toBe(originally);
    expect(vector.metadata.parentId).toBe("a");
  });

  it("skips deprecated entries when rebuilding", async () => {
    d1.seed({ id: "live", content: "keep", createdAt: 1 });
    d1.seed({ id: "gone", content: "drop", createdAt: 2, tags: ["status:deprecated"] });
    const ai = makeAI();
    const { env } = makeEnv(d1, ai);

    let r = await runBatch(env, cfg);
    for (let i = 0; i < 3 && !r.done; i++) r = await runBatch(env, cfg);

    expect(ai.calls).toHaveLength(1);
    expect((await readMigration(env))?.processed).toBe(1);
  });
});

describe("migration differential batches", () => {
  let d1: SqliteD1;
  beforeEach(() => {
    d1 = makeSqliteD1();
  });

  async function finishFull(env: Env) {
    for (let guard = 0; guard < 20; guard++) {
      if ((await runBatch(env, cfg)).done) return;
    }
    throw new Error("full migration did not finish");
  }

  it("re-embeds updates and captures made after the full scan began", async () => {
    d1.seed({ id: "old-a", content: "before a", createdAt: 1 });
    d1.seed({ id: "old-b", content: "before b", createdAt: 2 });
    const ai = makeAI();
    const { env } = makeEnv(d1, ai);
    await finishFull(env);

    const startedAt = (await readMigration(env))!.startedAt;
    await d1.db.prepare(`UPDATE entries SET content = ?, updated_at = ?, write_marker = ? WHERE id = ?`)
      .bind("after a", startedAt + 1, memoryWriteMarker(env), "old-a").run();
    d1.seed({ id: "new-c", content: "after c", createdAt: startedAt + 2 });

    const beforeDeltaCalls = ai.calls.length;
    let result = await runDeltaBatch(env, cfg);
    for (let guard = 0; guard < 20 && !result.done; guard++) {
      result = await runDeltaBatch(env, cfg);
    }

    expect(result.done).toBe(true);
    expect(ai.calls.length - beforeDeltaCalls).toBe(2);
    const state = await readMigration(env);
    expect(state?.deltaProcessed).toBe(2);
    expect(state?.deltaFinishedAt).toBeGreaterThan(0);
  });

  it("uses id as the tie-break when updated timestamps cross a batch boundary", async () => {
    d1.seed({ id: "baseline", content: "base", createdAt: 1 });
    const ai = makeAI();
    const { env } = makeEnv(d1, ai);
    await finishFull(env);
    const changedAt = (await readMigration(env))!.startedAt + 1;

    for (let i = 0; i < 40; i++) {
      d1.seed({
        id: `delta-${String(i).padStart(2, "0")}`,
        content: `delta ${i}`,
        createdAt: changedAt,
      });
    }
    const beforeDeltaCalls = ai.calls.length;
    for (let guard = 0; guard < 20; guard++) {
      if ((await runDeltaBatch(env, cfg)).done) break;
    }

    expect(ai.calls.length - beforeDeltaCalls).toBe(40);
    expect((await readMigration(env))?.deltaCursorId).toBe("delta-39");
  });

  it("can restart the delta scan idempotently for the locked final pass", async () => {
    d1.seed({ id: "a", content: "initial", createdAt: 1 });
    const ai = makeAI();
    const { env } = makeEnv(d1, ai);
    await finishFull(env);
    const changedAt = (await readMigration(env))!.startedAt + 1;
    await d1.db.prepare(`UPDATE entries SET content = ?, updated_at = ?, write_marker = ? WHERE id = ?`)
      .bind("changed", changedAt, memoryWriteMarker(env), "a").run();

    expect((await runDeltaBatch(env, cfg)).done).toBe(true);
    const beforeRestart = ai.calls.length;
    expect((await runDeltaBatch(env, cfg, { restart: true })).done).toBe(true);
    expect(ai.calls.length - beforeRestart).toBe(1);
    expect((await readMigration(env))?.deltaProcessed).toBe(1);
  });

  it("final delta catches a post-scan import with old timestamps and no vectors", async () => {
    const ai = makeAI();
    const { env } = makeEnv(d1, ai);
    d1.seed({ id: "original", content: "full scan", createdAt: 1000 });
    await finishFull(env);
    expect((await readMigration(env))?.finishedAt).toEqual(expect.any(Number));

    // A restored/manual-import row can be committed after the full cursor passed while
    // retaining its historical timestamps. Empty vector_ids is the durable evidence that
    // makes the final restarted delta include it regardless of those old timestamps.
    d1.seed({ id: "historical-import", content: "restored later", createdAt: 1 });
    await env.DB.prepare(`DELETE FROM memory_write_admissions WHERE token = ?`)
      .bind(env.WRITE_ADMISSION_TOKEN).run();
    const lock = await setMemoryWriteLock(env, "final-delta");
    const deltaToken = await acquireFinalDeltaLease(env, lock.ownerId);
    const result = await runDeltaBatch(env, cfg, {
      restart: true,
      lockOwner: lock.ownerId,
      deltaToken,
    });

    expect(result.processed).toBe(1);
    expect(result.done).toBe(true);
    expect(d1.rows().find(row => row.id === "historical-import")?.vector_ids).not.toBe("[]");
  });

  it("refuses a delta scan before the full pass is complete", async () => {
    d1.seed({ id: "a", content: "initial", createdAt: 1 });
    const { env } = makeEnv(d1, makeAI());
    await expect(runDeltaBatch(env, cfg)).rejects.toThrow(/full re-embedding pass/);
  });
});

describe("migration under failure", () => {
  let d1: SqliteD1;
  beforeEach(() => {
    d1 = makeSqliteD1();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  /**
   * Property 3. When the budget runs out every remaining entry fails for the
   * same reason, so a loop that kept going would spend the rest of the run
   * producing identical errors and report hundreds of distinct "failures".
   */
  it("stops the run when a batch achieves nothing", async () => {
    Array.from({ length: 20 }, (_, i) => `e${i}`).forEach((id, i) =>
      d1.seed({ id, content: `body ${id}`, createdAt: 100 + i }),
    );
    // Fails from the very first embed.
    const ai = makeAI({ failFrom: 1, error: "AiError: 4006 out of neurons" });
    const { env } = makeEnv(d1, ai);

    const r = await runBatch(env, cfg);

    expect(r.stalled).toBe(true);
    expect(r.processed).toBe(0);
    expect(r.done).toBe(false);
    // One attempt, not twenty.
    expect(ai.calls).toHaveLength(1);
  });

  it("keeps the cursor when it stalls, so a resume does not redo paid work", async () => {
    Array.from({ length: 20 }, (_, i) => `e${i}`).forEach((id, i) =>
      d1.seed({ id, content: `body ${id}`, createdAt: 100 + i }),
    );

    // Succeeds for a while, then the budget goes.
    const ai = makeAI({ failFrom: 4, error: "4006 quota exceeded" });
    const { env, kv } = makeEnv(d1, ai);

    const first = await runBatch(env, cfg);
    expect(first.processed).toBe(3);
    const cursor = (await readMigration(env))?.cursorId;
    expect(cursor).toBe("e2");

    // Resume with budget restored: picks up after e2, does not redo e0–e2.
    const ai2 = makeAI();
    const { env: env2 } = makeEnv(d1, ai2, kv);
    await runBatch(env2, cfg);
    expect((await readMigration(env2))?.cursorId).not.toBe("e0");
    expect((await readMigration(env2))?.processed).toBeGreaterThan(3);
  });

  /** A failed entry must stay in front of the cursor so a later run retries it,
   *  rather than being stepped over and lost. */
  it("does not advance the cursor past an entry that failed", async () => {
    d1.seed({ id: "a", content: "ok", createdAt: 1 });
    d1.seed({ id: "b", content: "bad", createdAt: 2 });
    d1.seed({ id: "c", content: "ok", createdAt: 3 });

    const ai = makeAI({ failFrom: 2, error: "single entry problem" });
    const { env } = makeEnv(d1, ai);

    await runBatch(env, cfg);

    // Advanced to a, stopped at b. c has not been passed over.
    expect((await readMigration(env))?.cursorId).toBe("a");
  });

  it("starts over when the target profile changed under a half-finished run", async () => {
    d1.seed({ id: "a", content: "one", createdAt: 1 });
    d1.seed({ id: "b", content: "two", createdAt: 2 });
    const { env, kv } = makeEnv(d1, makeAI());

    await runBatch(env, cfg);
    expect((await readMigration(env))?.cursorId).toBeTruthy();

    // Simulate a stale ledger from a different dimensions/prompt profile.
    const stale = JSON.parse((await kv.get(MIGRATION_KEY))!);
    await kv.put(MIGRATION_KEY, JSON.stringify({
      ...stale,
      dimensions: 384,
      promptVersion: 0,
      profileId: "legacy-bge384",
    }));
    const ai2 = makeAI();
    const { env: env2 } = makeEnv(d1, ai2, kv);
    await runBatch(env2, cfg);

    const state = await readMigration(env2);
    expect(state).toMatchObject({
      model: DEFAULTS.EMBEDDING_MODEL,
      dimensions: 128,
      promptVersion: 1,
      profileId: "embeddinggemma-mrl128-v1",
    });
    // Cursor restarted from the beginning of the table.
    expect(state?.processed).toBeLessThanOrEqual(2);
    expect(ai2.calls[0]).toBe(DEFAULTS.EMBEDDING_MODEL);
  });

  it("treats an unreadable ledger as absent rather than trusting its cursor", async () => {
    d1.seed({ id: "a", content: "one", createdAt: 1 });
    const kv = makeMemoryKV();
    await kv.put(MIGRATION_KEY, "{not json");
    const { env } = makeEnv(d1, makeAI(), kv);

    expect(await readMigration(env)).toBeNull();
    // And a batch still runs, from the start.
    const r = await runBatch(env, cfg);
    expect(r.processed).toBe(1);
  });

  it("clears the ledger on reset", async () => {
    d1.seed({ id: "a", content: "one", createdAt: 1 });
    const { env } = makeEnv(d1, makeAI());
    await runBatch(env, cfg);
    expect(await readMigration(env)).not.toBeNull();

    await clearMigration(env);
    expect(await readMigration(env)).toBeNull();
  });
});

describe("budget-error recognition", () => {
  /** Best-effort and deliberately not load-bearing — the no-progress stop is
   *  what actually protects the run. These cases document the intent. */
  it("recognises the shapes Cloudflare uses for a spent budget", () => {
    for (const message of [
      "AiError: 4006: out of neurons",
      "Quota exceeded for this account",
      "Insufficient capacity",
      "Rate limit exceeded",
      "429 Too Many Requests",
    ]) {
      expect(looksLikeBudgetError(new Error(message)), message).toBe(true);
    }
  });

  it("does not mistake an ordinary failure for a spent budget", () => {
    for (const message of ["network unreachable", "invalid model", "boom"]) {
      expect(looksLikeBudgetError(new Error(message)), message).toBe(false);
    }
  });
});
