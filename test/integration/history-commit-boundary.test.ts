/** Shared history commit: actual SQLite, existing write capabilities and failure injection. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import {
  commitSourceWithHistory, listMemoryHistory, planBeforeImage,
  type BeforeImagePlan, type MemoryHistoryReason,
} from "../../src/memory/history";
import {
  acquireMemoryWriteAdmission, memoryWriteMarker, releaseMemoryWriteAdmission,
} from "../../src/migration/write-lock";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const databases: SqliteD1[] = [];
const releases: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const release of releases.splice(0)) await release(); }
  finally { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); }
});

async function fixture(reason: MemoryHistoryReason = "manual-update") {
  const sqlite = makeSqliteD1({ autoAdmitFixtureWrites: false }); databases.push(sqlite);
  sqlite.seed({ id: "current", content: "original decision", tags: ["kind:semantic", "topic"],
    source: "api", createdAt: 1000, vectorIds: ["old-vector"] });
  const rootEnv = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(),
  });
  const admission = await acquireMemoryWriteAdmission(rootEnv);
  const env: Env = { ...rootEnv, WRITE_ADMISSION_TOKEN: admission.token };
  releases.push(() => releaseMemoryWriteAdmission(rootEnv, admission));
  await env.DB.prepare(
    "UPDATE entries SET workspace_id = ?, actor_id = ?, memory_tier = ?, write_marker = ? WHERE id = ?",
  ).bind("own", "alice", "hot", memoryWriteMarker(env), "current").run();
  const plan = planBeforeImage("current", {
    content: "original decision", tags: JSON.stringify(["kind:semantic", "topic"]),
    source: "api", createdAt: 1000, vectorIds: JSON.stringify(["old-vector"]), workspaceId: "own",
  }, reason, 2000);
  const update = () => env.DB.prepare(
    `UPDATE entries SET content = ?, updated_at = ?, write_marker = ?
      WHERE id = ? AND content = ? AND tags = ? AND source = ?
        AND created_at = ? AND vector_ids = ? AND workspace_id = ?`,
  ).bind("new decision", 2000, memoryWriteMarker(env), plan.sourceId, plan.source.content,
    plan.source.tags, plan.source.source, plan.source.createdAt, plan.source.vectorIds, plan.source.workspaceId);
  return { sqlite, env, rootEnv, admission, plan, update };
}

function batchDouble(sourceResult: D1Result) {
  const archive = { bind: vi.fn().mockReturnThis() };
  const edge = { bind: vi.fn().mockReturnThis() };
  const prepare = vi.fn().mockReturnValueOnce(archive).mockReturnValueOnce(edge);
  const batch = vi.fn().mockResolvedValue([
    { success: true, meta: { changes: 1 } }, sourceResult, { success: true, meta: { changes: 1 } },
  ]);
  const env = { DB: { prepare, batch }, WRITE_ADMISSION_TOKEN: "test-capability" } as unknown as Env;
  const plan: BeforeImagePlan = {
    id: "prior", sourceId: "current", archivedTags: '["status:deprecated"]', originalTags: [],
    reason: "manual-update", replacedAt: 2000,
    source: { content: "old", tags: "[]", source: "api", createdAt: 1000, vectorIds: "[]", workspaceId: "own" },
  };
  const source = { run: vi.fn() } as unknown as D1PreparedStatement;
  return { env, plan, source, batch, prepare, archive, edge };
}

describe("history transaction boundary and result ownership", () => {
  it.each([{ changes: 0 }, { changes: 1 }, { rows_written: 0 }, { rows_written: 1 }])(
    "returns the source result object unchanged, not archive/edge success: %j", async meta => {
      const sourceResult = { success: true, meta } as unknown as D1Result;
      const f = batchDouble(sourceResult);
      expect(await commitSourceWithHistory(f.env, f.source, f.plan)).toBe(sourceResult);
      expect(f.batch).toHaveBeenCalledExactlyOnceWith([f.archive, f.source, f.edge]);
      expect(f.prepare.mock.calls[0][0]).toMatch(/INSERT INTO entries/);
      expect(f.prepare.mock.calls[1][0]).toMatch(/INSERT INTO edges/);
      expect(f.source.run).not.toHaveBeenCalled();
    },
  );

  it("keeps a plan-free mutation on run(), with the exact result and no history preparation", async () => {
    const result = { success: true, meta: { changes: 0 } } as unknown as D1Result;
    const f = batchDouble(result);
    vi.mocked(f.source.run).mockResolvedValue(result);
    expect(await commitSourceWithHistory(f.env, f.source)).toBe(result);
    expect(f.source.run).toHaveBeenCalledTimes(1);
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.batch).not.toHaveBeenCalled();
  });

  it.each([false, true])("propagates the original execution error without retries (history=%s)", async history => {
    const f = batchDouble({} as D1Result);
    const failure = new Error("original D1 execution failure");
    f.batch.mockRejectedValue(failure); vi.mocked(f.source.run).mockRejectedValue(failure);
    await expect(commitSourceWithHistory(f.env, f.source, history ? f.plan : undefined)).rejects.toBe(failure);
    expect(history ? f.batch : f.source.run).toHaveBeenCalledTimes(1);
    expect(history ? f.source.run : f.batch).not.toHaveBeenCalled();
  });

  it("does not execute anything when preparing the history edge fails", async () => {
    const f = batchDouble({} as D1Result);
    const failure = new Error("edge preparation failure");
    f.prepare.mockReset().mockReturnValueOnce(f.archive).mockImplementationOnce(() => { throw failure; });
    await expect(commitSourceWithHistory(f.env, f.source, f.plan)).rejects.toBe(failure);
    expect(f.batch).not.toHaveBeenCalled(); expect(f.source.run).not.toHaveBeenCalled();
  });

  it("keeps history assembly below capture and out of both source-update branches", () => {
    const store = readFileSync(resolve(import.meta.dirname, "../../src/capture/store.ts"), "utf8");
    const history = readFileSync(resolve(import.meta.dirname, "../../src/memory/history.ts"), "utf8");
    // 旧forkの移行書込みだけが退役行方式を使い、通常更新は4.0のsnapshotを同batchで使う。
    expect(store.match(/await commitSourceWithHistory\(/g)).toHaveLength(1);
    expect(store).toContain("snapshotStatement(env");
    expect(store).not.toMatch(/beforeImage(?:Insert|Edge)Statement/);
    expect(history).not.toMatch(/from\s+["'][^"']*capture\//);
  });
});

describe("real SQLite history atomicity with production admission", () => {
  it.each(["manual-update", "smart-merge", "smart-replace"] as const)(
    "commits one source update and one immutable, scoped before-image (%s)", async reason => {
      const f = await fixture(reason); const sourceUpdate = f.update();
      const batch = vi.spyOn(f.env.DB, "batch");
      const result = await commitSourceWithHistory(f.env, sourceUpdate, f.plan);
      expect(batch).toHaveBeenCalledTimes(1);
      expect(batch.mock.calls[0][0]).toHaveLength(3);
      expect(batch.mock.calls[0][0][1]).toBe(sourceUpdate);
      expect(result.meta.rows_written).toBe(1);
      expect(f.sqlite.rows().find(row => row.id === "current")).toMatchObject({
        content: "new decision", workspace_id: "own", actor_id: "alice", memory_tier: "hot",
        vector_ids: '["old-vector"]', updated_at: 2000,
      });
      expect(f.sqlite.rows().find(row => row.id === f.plan.id)).toMatchObject({
        content: "original decision", workspace_id: "own", actor_id: "alice", memory_tier: "cold",
        tags: '["status:deprecated"]', vector_ids: "[]",
      });
      expect(await listMemoryHistory(f.env, "current", 10)).toEqual([{
        id: f.plan.id, content: "original decision", tags: ["kind:semantic", "topic"], source: "api",
        createdAt: 1000, replacedAt: 2000, reason,
      }]);
      expect(f.env.AI.run).not.toHaveBeenCalled();
      expect(f.env.VECTORIZE.upsert).not.toHaveBeenCalled();
      expect(f.env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
    },
  );

  it("rolls back archive and source when the third statement is rejected", async () => {
    const f = await fixture(); const before = f.sqlite.rows();
    // Failure injection adds a rejecting trigger; no production guard is removed.
    await f.sqlite.db.exec(`CREATE TEMP TRIGGER reject_test_history_edge BEFORE INSERT ON edges
      WHEN NEW.type = 'supersedes' BEGIN SELECT RAISE(ABORT, 'test history edge rejected'); END;`);
    await expect(commitSourceWithHistory(f.env, f.update(), f.plan)).rejects.toThrow("test history edge rejected");
    expect(f.sqlite.rows()).toEqual(before);
    expect((await f.env.DB.prepare("SELECT id FROM edges").all()).results).toEqual([]);
  });

  it("preserves a concurrent winner when the snapshot CAS has already lost", async () => {
    const f = await fixture();
    await f.env.DB.prepare("UPDATE entries SET content = ?, write_marker = ? WHERE id = ?")
      .bind("concurrent winner", memoryWriteMarker(f.env), "current").run();
    const before = f.sqlite.rows();
    const result = await commitSourceWithHistory(f.env, f.update(), f.plan);
    expect(result.meta.changes).toBe(0);
    expect(f.sqlite.rows()).toEqual(before);
    expect((await f.env.DB.prepare("SELECT id FROM edges").all()).results).toEqual([]);
  });

  it("does not acquire fresh authority for a revoked writer", async () => {
    const f = await fixture(); const sourceUpdate = f.update(); const before = f.sqlite.rows();
    await releaseMemoryWriteAdmission(f.rootEnv, f.admission);
    await expect(commitSourceWithHistory(f.env, sourceUpdate, f.plan)).rejects.toThrow();
    expect(f.sqlite.rows()).toEqual(before);
    expect((await f.env.DB.prepare("SELECT id FROM edges").all()).results).toEqual([]);
  });
});
