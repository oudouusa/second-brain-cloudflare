import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeAIMock, makeMemoryKV, makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";
import { DEFAULTS } from "../../src/config";
import {
  APPEND_VECTOR_COMPACTION_THRESHOLD,
  appendToEntry as appendUpstream,
  storeEntry,
} from "../../src/capture/store";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { processPendingVectorization } from "../../src/capture/pending";

// 既存のfork receipt検査を上流の引数順へ接続する。
async function appendToEntry(env: Env, id: string, addition: string, source: string, ctx: ExecutionContext, config = DEFAULTS, options: import("../../src/capture/store").AppendEntryOptions = {}) {
  return appendUpstream(env, id, "", addition, [], source, config, options.volatility,
    { workspaceId: "", actorId: "" }, { actorId: "", channel: "rest" }, options.when, "", ctx, options);
}
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as any;

async function flushWaitUntil(): Promise<void> {
  while (pending.length) await Promise.allSettled(pending.splice(0));
}

// Content just over CHUNK_MAX_CHARS (1600) to prove combined size no longer
// sends the whole history through the append embedding path.
const LONG_CONTENT = "a".repeat(1601);

describe("POST /append", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    pending.length = 0;
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  afterEach(flushWaitUntil);

  it("returns 400 when id is missing", async () => {
    const res = await worker.fetch(req("POST", "/append", { body: { addition: "update" } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when addition is missing", async () => {
    const res = await worker.fetch(req("POST", "/append", { body: { id: "abc" } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("auto-links the entry to a similar neighbor after appending (#16)", async () => {
    db.entries.push({ id: "target", content: "Original note", tags: "[]", source: "api", created_at: 1, vector_ids: "[]" });
    db.entries.push({ id: "neighbor", content: "Related memory", tags: "[]", source: "api", created_at: 1, vector_ids: "[]" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [{ id: "neighbor", score: 0.85, metadata: { parentId: "neighbor" } }] }),
      }),
    });

    const res = await worker.fetch(req("POST", "/append", { body: { id: "target", addition: "New related detail" } }), env, ctx);
    expect(res.status).toBe(200);
    await flushWaitUntil();

    const e = db.edges.find((x: any) => x.type === "relates_to");
    expect(e).toBeTruthy();
    expect([e.source_id, e.target_id].sort()).toEqual(["neighbor", "target"]);
    expect(e.provenance).toBe("inferred");
  });

  it("does not link a loosely-related neighbor below the threshold", async () => {
    db.entries.push({ id: "target", content: "Original note", tags: "[]", source: "api", created_at: 1, vector_ids: "[]" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [{ id: "loose", score: 0.38, metadata: { parentId: "loose" } }] }),
      }),
    });

    const res = await worker.fetch(req("POST", "/append", { body: { id: "target", addition: "New detail" } }), env, ctx);
    expect(res.status).toBe(200);
    expect(db.edges).toHaveLength(0);
  });

  it("returns 404 for non-existent id", async () => {
    const res = await worker.fetch(req("POST", "/append", { body: { id: "no-such-id", addition: "update" } }), env, ctx);
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });

  it("appends to existing entry", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Original content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "New info" } }),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(db.entries[0].content).toContain("Original content");
    expect(db.entries[0].content).toContain("New info");
  });

  // ── Short append: append-only path (≤ CHUNK_MAX_CHARS) ──────────────────────

  it("short append: uses -update- vector ID style, does not delete old vectors", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    db.entries.push({
      id: "entry-1",
      content: "Short original",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1"]',
    });

    await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "Small addition" } }),
      env,
      ctx
    );

    // vector_ids should append a write-unique id, so stale cleanup can never
    // delete a newer concurrent append that reused the same timestamp.
    const vectorIds: string[] = JSON.parse(db.entries[0].vector_ids);
    expect(vectorIds).toHaveLength(2);
    expect(vectorIds[0]).toBe("entry-1");
    expect(vectorIds[1]).toMatch(/^v-[0-9a-f-]+-0$/);
    // Old vectors should NOT be deleted on the short path
    expect(deleteByIdsMock).not.toHaveBeenCalled();
  });

  // ── Long entry: addition-only indexing path (> CHUNK_MAX_CHARS combined) ────

  it("long entry append: indexes only the addition and preserves old vectors", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    db.entries.push({
      id: "entry-1",
      content: LONG_CONTENT,
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1","entry-1-update-111"]',
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "More info" } }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);

    // D1 content updated with full combined text
    expect(db.entries[0].content).toContain(LONG_CONTENT);
    expect(db.entries[0].content).toContain("More info");

    // Existing semantic history remains valid and one vector is added for this update.
    const vectorIds: string[] = JSON.parse(db.entries[0].vector_ids);
    expect(vectorIds.slice(0, 2)).toEqual(["entry-1", "entry-1-update-111"]);
    expect(vectorIds[2]).toMatch(/^v-[0-9a-f-]+-0$/);
    expect(deleteByIdsMock).not.toHaveBeenCalled();
  });

  it("compacts accumulated append vectors after the successful response", async () => {
    const oldVectorIds = Array.from(
      { length: APPEND_VECTOR_COMPACTION_THRESHOLD },
      (_, index) => `old-${index}`,
    );
    const upsert = vi.fn().mockResolvedValue({ mutationId: "compact" });
    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "retire-old" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ upsert, deleteByIds }),
    });
    db.entries.push({
      id: "many-appends",
      content: "Original",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: JSON.stringify(oldVectorIds),
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "many-appends", addition: "Newest detail" } }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    await flushWaitUntil();
    expect(env.VECTORIZE.insert).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledOnce();
    expect(JSON.parse(db.entries[0].vector_ids)).toHaveLength(1);
    expect(deleteByIds).toHaveBeenCalled();
  });

  it("long entry append: inserts a new vector without upserting or deleting history", async () => {
    const callOrder: string[] = [];
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: vi.fn().mockImplementation(async () => { callOrder.push("insert"); return { mutationId: "m" }; }),
        upsert: vi.fn().mockImplementation(async () => { callOrder.push("upsert"); return { mutationId: "m" }; }),
        deleteByIds: vi.fn().mockImplementation(async () => { callOrder.push("delete"); return { mutationId: "m" }; }),
      }),
    });
    db.entries.push({
      id: "entry-1",
      content: LONG_CONTENT,
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1"]',
    });

    await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "More info" } }),
      env,
      ctx
    );

    expect(callOrder).toContain("insert");
    expect(callOrder).not.toContain("upsert");
    expect(callOrder).not.toContain("delete");
  });

  it("long entry append: addition-index failure fails loud, D1 unchanged, old vectors kept", async () => {
    // The addition embed/insert must run before D1 is mutated. On failure the
    // handler returns an error and leaves content + vectors intact — never commits
    // the new content and then deletes every vector.
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: vi.fn().mockRejectedValue(new Error("Vectorize down")),
        deleteByIds: deleteByIdsMock,
      }),
    });
    db.entries.push({
      id: "entry-1",
      content: LONG_CONTENT,
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1"]',
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "More info" } }),
      env,
      ctx
    );

    expect(res.status).toBe(500);
    // D1 content unchanged — the append did not commit.
    expect(db.entries[0].content).toBe(LONG_CONTENT);
    // Cleanup may remove newly-upserted partial vectors, but never the old live id.
    expect(deleteByIdsMock.mock.calls.flatMap(call => call[0])).not.toContain("entry-1");
  });

  it("long entry append: never attempts to delete old vectors", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        deleteByIds: vi.fn().mockRejectedValue(new Error("delete failed")),
      }),
    });
    db.entries.push({
      id: "entry-1",
      content: LONG_CONTENT,
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1"]',
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "More info" } }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(JSON.parse(db.entries[0].vector_ids)).toContain("entry-1");
  });

  it("long entry append: embeds only new chunks, never the previous history", async () => {
    const insert = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ insert }) });
    db.entries.push({
      id: "entry-1",
      content: LONG_CONTENT,
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["old-vector"]',
    });
    const addition = "b".repeat(1800);

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition } }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const embeddingCalls = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls
      .filter(call => call[0] === DEFAULTS.EMBEDDING_MODEL);
    expect(embeddingCalls).toHaveLength(2);
    expect(embeddingCalls.every(([, input]) => !JSON.stringify(input).includes(LONG_CONTENT))).toBe(true);
    expect(insert.mock.calls[0][0]).toHaveLength(2);
    expect(JSON.parse(db.entries[0].vector_ids).slice(0, 1)).toEqual(["old-vector"]);
  });

  it("reuses operation_id after a retry without duplicating content or vectors", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Original",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });
    const operationId = crypto.randomUUID();
    const request = () => req("POST", "/append", {
      body: { id: "entry-1", addition: "One durable result", operation_id: operationId },
    });

    const first = await worker.fetch(request(), env, ctx);
    const second = await worker.fetch(request(), env, ctx);
    const replay = await second.json() as any;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(replay.replayed).toBe(true);
    expect(db.entries[0].content.match(/\[Update /g)).toHaveLength(1);
    expect(env.VECTORIZE.insert).toHaveBeenCalledOnce();
    expect(db.appendReceipts).toHaveLength(1);
  });

  it("stores and replays the idempotency receipt against the real SQLite schema", async () => {
    const sqlite = makeSqliteD1();
    const realPending: Promise<unknown>[] = [];
    const realCtx = {
      waitUntil: (promise: Promise<unknown>) => { realPending.push(promise); },
    } as ExecutionContext;
    try {
      sqlite.seed({ id: "sqlite-entry", content: "Original", createdAt: Date.now() });
      const realEnv = sqlite.admitEnv(makeTestEnv(undefined, {
        DB: sqlite.db as unknown as D1Database,
      }));
      const options = { operationId: "sqlite-operation" };

      const first = await appendToEntry(
        realEnv, "sqlite-entry", "Durable detail", "api", realCtx, DEFAULTS, options,
      );
      const replay = await appendToEntry(
        realEnv, "sqlite-entry", "Durable detail", "api", realCtx, DEFAULTS, options,
      );
      await Promise.allSettled(realPending);

      expect(first).toMatchObject({ indexed: true, replayed: false, rollover: { status: "none" } });
      expect(replay).toMatchObject({ indexed: true, replayed: true, rollover: { status: "none" } });
      expect(String(sqlite.rows()[0].content).match(/\[Update /g)).toHaveLength(1);
      await expect(sqlite.db.prepare(
        `SELECT operation_id FROM append_receipts WHERE entry_id = ?`,
      ).bind("sqlite-entry").first()).resolves.toEqual({ operation_id: "sqlite-operation" });
    } finally {
      sqlite.close();
    }
  });

  it("durably queues a quota-deferred passage and later indexes it exactly once", async () => {
    const sqlite = makeSqliteD1();
    const aiRun = vi.fn()
      .mockRejectedValueOnce(new Error("4006: daily free allocation used"))
      .mockResolvedValue({ data: [new Array(768).fill(0.1)] });
    const upsert = vi.fn().mockResolvedValue({ mutationId: "pending-recovery" });
    try {
      sqlite.seed({
        id: "quota-append",
        content: "Original semantic history",
        createdAt: Date.now() - 600_000,
        vectorIds: ["old-vector"],
      });
      const realEnv = sqlite.admitEnv(makeTestEnv(undefined, {
        DB: sqlite.db as unknown as D1Database,
        AI: { run: aiRun } as unknown as Ai,
        VECTORIZE: makeVectorizeMock({ upsert }),
      }));

      const appended = await appendToEntry(
        realEnv,
        "quota-append",
        "Deferred semantic passage",
        "api",
        ctx,
        DEFAULTS,
        { operationId: "quota-operation" },
      );

      expect(appended).toMatchObject({
        indexed: false,
        semanticUnavailableReason: "workers_ai_quota_exhausted",
      });
      expect(sqlite.rows()[0]).toMatchObject({
        vector_ids: '["old-vector"]',
      });
      expect(JSON.parse(String(sqlite.rows()[0].pending_append_passages))).toEqual([
        expect.objectContaining({
          content: "Deferred semantic passage",
          operationId: "quota-operation",
        }),
      ]);

      const recovered = await processPendingVectorization(realEnv, { now: Date.now() });

      expect(recovered).toMatchObject({ processed: 1, failed: 0, remaining: 0 });
      expect(upsert).toHaveBeenCalledOnce();
      const row = sqlite.rows()[0];
      expect(JSON.parse(String(row.vector_ids))).toHaveLength(2);
      expect(row.pending_append_passages).toBe("[]");
      await expect(sqlite.db.prepare(
        `SELECT indexed FROM append_receipts WHERE entry_id = ?`,
      ).bind("quota-append").first()).resolves.toEqual({ indexed: 1 });

      const replay = await appendToEntry(
        realEnv,
        "quota-append",
        "Deferred semantic passage",
        "api",
        ctx,
        DEFAULTS,
        { operationId: "quota-operation" },
      );
      expect(replay).toMatchObject({ indexed: true, replayed: true });
      expect(upsert).toHaveBeenCalledOnce();
    } finally {
      sqlite.close();
    }
  });

  it("full-entry recovery clears a queued append instead of indexing only its tail", async () => {
    const sqlite = makeSqliteD1();
    const aiRun = vi.fn()
      .mockRejectedValueOnce(new Error("4006: daily free allocation used"))
      .mockResolvedValue({ data: [new Array(768).fill(0.1)] });
    const upsert = vi.fn().mockResolvedValue({ mutationId: "full-recovery" });
    try {
      sqlite.seed({
        id: "quota-unindexed-entry",
        content: "Original text that has never been indexed",
        createdAt: Date.now() - 600_000,
      });
      const realEnv = sqlite.admitEnv(makeTestEnv(undefined, {
        DB: sqlite.db as unknown as D1Database,
        AI: { run: aiRun } as unknown as Ai,
        VECTORIZE: makeVectorizeMock({ upsert }),
      }));

      await appendToEntry(
        realEnv, "quota-unindexed-entry", "Queued tail", "api", ctx, DEFAULTS,
      );
      expect(sqlite.rows()[0].vector_ids).toBe("[]");

      const recovered = await processPendingVectorization(realEnv, { now: Date.now() });

      expect(recovered).toMatchObject({ processed: 1, failed: 0, remaining: 0 });
      expect(sqlite.rows()[0].pending_append_passages).toBe("[]");
      const metadata = upsert.mock.calls[0][0][0].metadata;
      expect(metadata.content).toContain("Original text that has never been indexed");
      expect(metadata.content).toContain("Queued tail");
    } finally {
      sqlite.close();
    }
  });

  it("rejects operation_id reuse for different content", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Original",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });
    const operationId = crypto.randomUUID();
    await worker.fetch(req("POST", "/append", {
      body: { id: "entry-1", addition: "First result", operation_id: operationId },
    }), env, ctx);

    const conflict = await worker.fetch(req("POST", "/append", {
      body: { id: "entry-1", addition: "Different result", operation_id: operationId },
    }), env, ctx);

    expect(conflict.status).toBe(409);
    expect(db.entries[0].content).not.toContain("Different result");
  });

  it("returns additive rollover advice without changing append compatibility", async () => {
    db.entries.push({
      id: "rollover-advice",
      content: "x".repeat(9_950),
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });

    const res = await worker.fetch(req("POST", "/append", {
      body: { id: "rollover-advice", addition: "y".repeat(50) },
    }), env, ctx);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      rollover_status: "required",
      rollover_warn_at: 8_000,
      rollover_at: 10_000,
    });
    expect(body.content_chars).toBeGreaterThanOrEqual(10_000);
    expect(db.entries[0].content).toContain("y".repeat(50));
  });

  it("does not record success when a concurrent append wins the source-row CAS", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Original",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });
    db.appendReceipts.push({
      entry_id: "entry-1",
      operation_id: "previous-operation",
      request_hash: "previous-hash",
      indexed: 1,
      completed_at: 1,
    });
    let racingVersion = 0;
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: vi.fn().mockImplementation(async () => {
          // Replace rather than mutate: a real D1 SELECT returns a detached row, while
          // D1Mock keeps object references for speed.
          db.entries[0] = { ...db.entries[0],
            content: `Concurrent winner ${++racingVersion}`,
            vector_ids: '["concurrent-vector"]',
            updated_at: Date.now(),
            write_marker: "another-request",
          };
          return { mutationId: "inserted-before-cas" };
        }),
      }),
    });

    const res = await worker.fetch(req("POST", "/append", {
      body: {
        id: "entry-1",
        addition: "Losing append",
        operation_id: "losing-operation",
      },
    }), env, ctx);

    expect(res.status).toBe(409);
    expect(db.entries[0].content).toBe(`Concurrent winner ${racingVersion}`);
    expect(racingVersion).toBeGreaterThan(1);
    expect(db.appendReceipts).toEqual([expect.objectContaining({
      operation_id: "previous-operation",
    })]);
  });

  it("populates per-tag metadata keys when entry has non-empty tags (short path)", async () => {
    db.entries.push({
      id: "tagged-entry",
      content: "Original",
      tags: '["work","idea"]',
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "tagged-entry", addition: "Short update" } }),
      env, ctx
    );
    expect(res.status).toBe(200);

    // Verify Vectorize.insert was called with tag_* metadata fields
    const insertMock = env.VECTORIZE.insert as ReturnType<typeof import("vitest").vi.fn>;
    const vectors = insertMock.mock.calls[0][0] as any[];
    expect(vectors[0].metadata).toMatchObject({ tag_work: true, tag_idea: true });
  });

  it("returns 500 when appendToEntry throws due to Vectorize failure (short path)", async () => {
    db.entries.push({
      id: "fail-entry",
      content: "Short content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });

    const failEnv = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: vi.fn().mockRejectedValue(new Error("Vectorize unavailable")),
      }),
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "fail-entry", addition: "short addition" } }),
      failEnv, ctx
    );
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });

  it("keeps the delayed-delete tombstone after a partially accepted unavailable insert", async () => {
    db.entries.push({
      id: "partial-entry",
      content: "Short content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });
    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "delete-ack" });
    const partialEnv = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: vi.fn().mockRejectedValue(new Error("accepted before transport failed")),
        describe: vi.fn().mockRejectedValue(new Error("index unavailable")),
        deleteByIds,
      }),
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "partial-entry", addition: "keyword-only addition" } }),
      partialEnv,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(db.entries[0].content).toContain("keyword-only addition");
    expect(db.entries[0].vector_ids).toBe("[]");
    expect(deleteByIds).toHaveBeenCalledOnce();
    expect(db.vectorCleanupOps).toHaveLength(1);
    expect(db.vectorCleanupOps[0]).toMatchObject({ ready: 3, entry_id: "partial-entry" });
    expect(db.vectorCleanupOps[0].expires_at).toBeGreaterThan(Date.now());
  });

  it("keeps a fresh vector when classification changes only the entry tags", async () => {
    const d1 = makeSqliteD1();
    const id = "classified-before-vector-commit";
    const content = "I finished the Second Brain indexing investigation today.";
    const createdAt = 1_700_000_000_000;
    d1.seed({ id, content, createdAt, tags: ["work"] });

    const indexed = new Set<string>();
    const deleteByIds = vi.fn(async (ids: string[]) => {
      ids.forEach(vectorId => indexed.delete(vectorId));
      return { mutationId: "delete-mutation" };
    });
    const concurrentEnv = d1.admitEnv({
      DB: d1.db,
      OAUTH_KV: makeMemoryKV(),
      AI: makeAIMock(),
      VECTORIZE: {
        upsert: vi.fn(async (vectors: { id: string }[]) => {
          vectors.forEach(vector => indexed.add(vector.id));
          await d1.db.prepare(
            `UPDATE entries SET tags = ?, updated_at = ? WHERE id = ?`,
          ).bind(JSON.stringify(["work", "kind:episodic"]), createdAt + 1, id).run();
          return { mutationId: "upsert-mutation" };
        }),
        deleteByIds,
      },
    } as unknown as Env);

    const { vectorIds } = await storeEntry(
      concurrentEnv, id, content, ["work"], "api", createdAt, DEFAULTS,
    );

    const row = d1.rows()[0];
    expect(JSON.parse(row.tags as string)).toEqual(["work", "kind:episodic"]);
    expect(JSON.parse(row.vector_ids as string)).toEqual(vectorIds);
    expect([...indexed]).toEqual(vectorIds);
    expect(deleteByIds).not.toHaveBeenCalled();
  });
});
