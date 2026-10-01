import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../src/env";
import * as ai from "../../src/lib/ai";
import { storeEntry } from "../../src/capture/store";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { beginMemoryWriteAdmission } from "../../src/migration/write-lock";
import { createNightlyD1Budget, D1BudgetExceededError } from "../../src/runtime/d1-budget";
import { drainPendingVectorCleanup, settleVectorCleanupOp } from "../../src/vectorize/cleanup";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";

beforeEach(() => {
  resetDatabaseInit(); vi.restoreAllMocks();
  vi.spyOn(ai, "embedDocument").mockResolvedValue(new Array(128).fill(0.1));
});
afterEach(() => { resetDatabaseInit(); vi.restoreAllMocks(); });

async function fixture() {
  const sq = makeSqliteD1({ autoAdmitFixtureWrites: false });
  const env = makeTestEnv(undefined, { DB: sq.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock() });
  await initializeDatabase(env);
  sq.seed({ id: "source", content: "An unchanged source", tags: [], createdAt: 1000 });
  const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
  const admission = await beginMemoryWriteAdmission(env, ctx);
  return { sq, env, admission };
}

describe("reserve durable settlement before remote Vectorize effects", () => {
  it("defers an upsert before sending when source commit/receipt credit is missing", async () => {
    const f = await fixture();
    try {
      const b = createNightlyD1Budget(f.admission.env, 7);
      await expect(storeEntry(b.env, "source", "An unchanged source", [], "api", 1000))
        .rejects.toBeInstanceOf(D1BudgetExceededError);
      expect(f.env.VECTORIZE.upsert).not.toHaveBeenCalled();
      expect(f.sq.rows()[0].content).toBe("An unchanged source");
      expect(f.sq.rows()[0].vector_ids).toBe("[]");
      const journal = await f.sq.db.prepare("SELECT ready, vector_ids FROM vector_cleanup_ops").all();
      expect(journal.results).toHaveLength(1);
      expect(journal.results[0]).toMatchObject({ ready: 0 });
      expect(b.stats()).toMatchObject({ used: 2, deferred: 1 });
    } finally { await f.admission.finish(); f.sq.close(); }
  });

  it("a sibling cannot consume the source CAS/retirement budget while upsert awaits", async () => {
    const f = await fixture();
    try {
      const b = createNightlyD1Budget(f.admission.env, 9);
      vi.mocked(f.env.VECTORIZE.upsert).mockImplementation(async () => {
        await expect(b.env.DB.prepare("SELECT 1").first()).rejects.toBeInstanceOf(D1BudgetExceededError);
        return { mutationId: "accepted" };
      });
      const ids = await storeEntry(b.env, "source", "An unchanged source", [], "api", 1000);
      expect(ids.vectorIds).toHaveLength(1);
      expect(JSON.parse(String(f.sq.rows()[0].vector_ids))).toEqual(ids.vectorIds);
      expect((await f.sq.db.prepare("SELECT op_id FROM vector_cleanup_ops").all()).results).toHaveLength(0);
      expect(b.stats()).toMatchObject({ used: 9, deferred: 1 });
    } finally { await f.admission.finish(); f.sq.close(); }
  });

  it("does not begin remote deletion without credit for the returned receipt", async () => {
    const f = await fixture();
    try {
      await f.sq.db.prepare("INSERT INTO vector_cleanup_ops(op_id,entry_id,vector_ids,created_at,ready,expires_at,write_marker) VALUES(?,?,?,?,?,?,?)")
        .bind("debt", "gone", '["orphan"]', 1, 1, 0, f.sq.fixtureMarker()).run();
      const b = createNightlyD1Budget(f.admission.env, 3);
      await expect(settleVectorCleanupOp(b.env, "debt", "gone", ["orphan"]))
        .rejects.toBeInstanceOf(D1BudgetExceededError);
      expect(f.env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
      expect((await f.sq.db.prepare("SELECT op_id FROM vector_cleanup_ops").all()).results).toHaveLength(1);
      expect(b.stats()).toMatchObject({ used: 1, deferred: 1 });
    } finally { await f.admission.finish(); f.sq.close(); }
  });

  it("reserves authorization and receipt together, without claiming deletion is visible", async () => {
    const f = await fixture();
    try {
      await f.sq.db.prepare("INSERT INTO vector_cleanup_ops(op_id,entry_id,vector_ids,created_at,ready,expires_at,write_marker) VALUES(?,?,?,?,?,?,?)")
        .bind("debt", "gone", '["orphan"]', 1, 1, 0, f.sq.fixtureMarker()).run();
      const b = createNightlyD1Budget(f.admission.env, 4);
      vi.mocked(f.env.VECTORIZE.deleteByIds).mockImplementation(async () => {
        await expect(b.env.DB.prepare("SELECT 1").first()).rejects.toBeInstanceOf(D1BudgetExceededError);
        return { mutationId: "accepted-but-not-visible" };
      });
      await settleVectorCleanupOp(b.env, "debt", "gone", ["orphan"]);
      const row = await f.sq.db.prepare("SELECT ready, vector_ids FROM vector_cleanup_ops WHERE op_id = ?").bind("debt").first() as any;
      expect(row.ready).toBe(3);
      expect(JSON.parse(row.vector_ids).deleteMutationId).toBe("accepted-but-not-visible");
      expect(b.stats()).toMatchObject({ used: 4, deferred: 1 });
    } finally { await f.admission.finish(); f.sq.close(); }
  });
  it("does not silently pretend an unbudgeted caller has an SQL envelope", async () => {
    const env = makeTestEnv();
    await expect(drainPendingVectorCleanup(env, { sqlBudget: 8 })).rejects.toThrow("requires an invocation budget");
    await expect(drainPendingVectorCleanup(env, { sqlBudget: 3 })).rejects.toThrow(RangeError);
  });

});
