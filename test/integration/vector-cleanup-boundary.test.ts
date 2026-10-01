/** 保存処理と削除台帳の境界を検証する。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as store from "../../src/capture/store";
import * as cleanup from "../../src/vectorize/cleanup";
import { deleteEntryVectors } from "../../src/vectorize/batch";
import {
  acquireMemoryWriteAdmission,
  releaseMemoryWriteAdmission,
} from "../../src/migration/write-lock";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";

const dispose: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of dispose.splice(0)) await close();
  vi.restoreAllMocks();
});

async function fixture() {
  // Seed through the project's helper, then use real production admissions for
  // every mutation under test. No auto-admission of marker-free test SQL.
  const sqlite = makeSqliteD1({ autoAdmitFixtureWrites: false });
  sqlite.seed({ id: "entry", content: "unchanged source", createdAt: 1, vectorIds: ["live"] });
  const base = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as D1Database,
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock(),
  });
  const admission = await acquireMemoryWriteAdmission(base);
  const env = { ...base, WRITE_ADMISSION_TOKEN: admission.token };
  dispose.push(async () => {
    try { await releaseMemoryWriteAdmission(base, admission); } finally { sqlite.close(); }
  });
  const rows = async () => (await env.DB.prepare(
    "SELECT op_id, entry_id, vector_ids, ready FROM vector_cleanup_ops ORDER BY op_id",
  ).all<{ op_id: string; entry_id: string; vector_ids: string; ready: number }>()).results;
  return { sqlite, env, admission, rows };
}

describe("vector cleanup module boundary", () => {
  it("一括削除でも現行参照と別所有者の索引を保ち、記憶別のreceiptを残す", async () => {
    const f = await fixture();
    f.sqlite.seed({ id: "other", content: "other source", createdAt: 1 });
    const original = f.sqlite.rows();
    vi.mocked(f.env.VECTORIZE.getByIds).mockImplementation(async ids => ids.map(id => ({
      id, values: [], metadata: { parentId: id === "foreign" ? "foreign-owner" : id === "other-stale" ? "other" : "entry" },
    })));
    await deleteEntryVectors(f.env, [
      { entryId: "entry", vectorIds: ["live", "stale", "foreign"] },
      { entryId: "other", vectorIds: ["other-stale"] },
    ]);
    expect(f.env.VECTORIZE.deleteByIds).toHaveBeenCalledExactlyOnceWith(["stale", "other-stale"]);
    const rows = await f.rows();
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.ready === 3)).toBe(true);
    expect(rows.map(r => JSON.parse(r.vector_ids).ids).flat().sort()).toEqual(["other-stale", "stale"]);
    expect(f.sqlite.rows()).toEqual(original);
  });
  it("保存APIの公開範囲を保ち、cleanupの互換再公開を残さない", () => {
    expect(Object.keys(store).sort()).toEqual([
      "APPEND_VECTOR_COMPACTION_THRESHOLD", "APPEND_SCORE_CONTEXT_CHARS", "AppendOperationConflictError",
      "EntryGoneError", "WriteConflictError", "HeldRowEmbedRefusedError", "discardUpload",
      "MEMORY_CONTENT_MAX_CHARS", "MEMORY_MAX_CHUNKS", "MEMORY_MAX_TAGS",
      "MEMORY_SOURCE_MAX_BYTES", "MEMORY_TAG_MAX_BYTES", "MemoryInputError",
      "VECTORIZE_METADATA_MAX_BYTES",
      "appendToEntry", "deleteStaleVectors", "embedContextForRow",
      "indexPendingAppendPassage", "parsePendingAppendPassages", "reembedOrDegrade",
      "reembedOrThrow", "storeEntry", "updateEntryContent",
      "upsertEntryVectors",
      "validateIndexableMemory",
    ].sort());
  });

  it.each([
    [undefined, []], [null, []], ["invalid", []], ["{}", []], ["null", []],
    ['["one",2,null,"two","one"]', ["one", "two", "one"]],
  ])("keeps the legacy vector ID parser for %s", (raw, expected) => {
    expect(cleanup.parseVectorIds(raw)).toEqual(expected);
  });

  it("keeps referenced IDs and retains a receipt until processing and absence are confirmed", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = await fixture();
    const original = f.sqlite.rows();
    const op = await cleanup.recordVectorCleanup(f.env, "entry", ["live", "stale", "stale"]);
    await cleanup.markVectorCleanupReady(f.env, op);
    expect(JSON.parse((await f.rows())[0].vector_ids)).toEqual(["live", "stale"]);
    await cleanup.settleVectorCleanupOp(f.env, op, "entry", ["live", "stale"]);
    expect(f.env.VECTORIZE.deleteByIds).toHaveBeenCalledExactlyOnceWith(["stale"]);
    expect((await f.rows())[0].ready).toBe(3);
    now += 61_000;
    vi.mocked(f.env.VECTORIZE.describe).mockResolvedValue({
      processedUpToMutation: "earlier", processedUpToDatetime: 0,
    } as unknown as VectorizeIndexInfo);
    expect(await cleanup.drainPendingVectorCleanup(f.env)).toBe(0);
    // 所有者確認は読み取りのみ。未処理receiptを完了扱いせず、追加削除もしない。
    expect(f.env.VECTORIZE.deleteByIds).toHaveBeenCalledTimes(1);
    expect((await f.rows())[0].ready).toBe(3);
    vi.mocked(f.env.VECTORIZE.describe).mockResolvedValue({
      processedUpToMutation: "m", processedUpToDatetime: 0,
    } as unknown as VectorizeIndexInfo);
    vi.mocked(f.env.VECTORIZE.getByIds).mockResolvedValue([]);
    expect(await cleanup.drainPendingVectorCleanup(f.env)).toBe(1);
    expect(await f.rows()).toEqual([]);
    expect(f.sqlite.rows()).toEqual(original);
    expect(f.env.AI.run).not.toHaveBeenCalled();
  });

  it("leaves a durable record after the existing three-attempt delete budget fails", async () => {
    const f = await fixture();
    const op = await cleanup.recordVectorCleanup(f.env, "entry", ["stale"]);
    await cleanup.markVectorCleanupReady(f.env, op);
    vi.mocked(f.env.VECTORIZE.deleteByIds).mockRejectedValue(new Error("test: unavailable"));
    await expect(cleanup.settleVectorCleanupOp(f.env, op, "entry", ["stale"]))
      .rejects.toThrow("test: unavailable");
    expect(f.env.VECTORIZE.deleteByIds).toHaveBeenCalledTimes(3);
    expect(await f.rows()).toEqual([expect.objectContaining({ op_id: op, ready: 1 })]);
  });

  it("rechecks the write capability after the remote guard and before deleting", async () => {
    const f = await fixture();
    const op = await cleanup.recordVectorCleanup(f.env, "entry", ["stale"]);
    await cleanup.markVectorCleanupReady(f.env, op);
    const beforeRemote = vi.fn(async () => releaseMemoryWriteAdmission(f.env, f.admission));
    await expect(cleanup.settleVectorCleanupOp(f.env, op, "entry", ["stale"], { beforeRemote }))
      .rejects.toThrow();
    expect(beforeRemote).toHaveBeenCalledOnce();
    expect(f.env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
    expect(await f.rows()).toHaveLength(1);
  });

  it("keeps one remote bulk delete and independent per-entry receipts", async () => {
    const f = await fixture();
    const left = await cleanup.recordVectorCleanup(f.env, "left", ["a", "shared"]);
    const right = await cleanup.recordVectorCleanup(f.env, "right", ["b", "shared"]);
    await cleanup.markVectorCleanupReady(f.env, left);
    await cleanup.markVectorCleanupReady(f.env, right);
    await cleanup.submitVectorCleanupBatch(f.env, [
      { opId: left, vectorIds: ["a", "shared"] },
      { opId: right, vectorIds: ["b", "shared"] },
    ]);
    expect(f.env.VECTORIZE.deleteByIds).toHaveBeenCalledExactlyOnceWith(["a", "shared", "b"]);
    const rows = await f.rows();
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.ready === 3)).toBe(true);
    expect(JSON.parse(rows.find(row => row.op_id === left)!.vector_ids)).toMatchObject({
      ids: ["a", "shared"], deleteMutationId: "m",
    });
    expect(JSON.parse(rows.find(row => row.op_id === right)!.vector_ids)).toMatchObject({
      ids: ["b", "shared"], deleteMutationId: "m",
    });
  });

  it.each([
    [undefined, 10], [0, 10], [2.9, 20], [99, 30], [Number.NaN, 10], [Infinity, 10],
  ])("retains bounded page selection for maxPages=%s", async (maxPages, expected) => {
    const f = await fixture();
    for (let i = 0; i < 35; i++) {
      const op = await cleanup.recordVectorCleanup(f.env, "entry", ["live"]);
      await cleanup.markVectorCleanupReady(f.env, op);
    }
    expect(await cleanup.drainPendingVectorCleanup(f.env, { maxPages })).toBe(expected);
    expect(await f.rows()).toHaveLength(35 - expected);
    expect(f.env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
  });
});
