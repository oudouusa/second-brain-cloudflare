import { DEFAULTS } from "../../src/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyStatus, deprecateEntry, forgetEntry } from "../../src/capture/lifecycle";
import { acquireMemoryWriteAdmission, envWithMemoryWriteAdmission, memoryWriteMarker } from "../../src/migration/write-lock";
import { recordVectorCleanup, markVectorCleanupReady, submitLifecycleVectorCleanup } from "../../src/vectorize/cleanup";
import { makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

let sqlite: SqliteD1;
afterEach(() => { vi.restoreAllMocks(); sqlite?.close(); });

async function fixture(ids = ["old-vector"]) {
  sqlite = makeSqliteD1({ autoAdmitFixtureWrites: false });
  sqlite.seed({ id: "entry", content: "original", createdAt: 1, vectorIds: ids });
  const base = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database });
  const admission = await acquireMemoryWriteAdmission(base);
  const env = envWithMemoryWriteAdmission(base, admission);
  const rows = () => env.DB.prepare("SELECT vector_ids, ready, expires_at, write_marker FROM vector_cleanup_ops")
    .all<{ vector_ids: string; ready: number; expires_at: number; write_marker: string }>();
  return { env, admission, rows };
}

describe("lifecycleの索引削除契約", () => {
  it("FTS と件数トリガー付きの削除でも、直接削除した1件を確定する", async () => {
    const { env } = await fixture();
    const result = await env.DB.prepare("DELETE FROM entries WHERE id = ?").bind("absent").run();
    expect(result.meta.changes).toBe(0);
    expect(await forgetEntry("entry", env, { actorId: "", channel: "rest" as const }, { reason: "forget", config: DEFAULTS }, "")).toMatchObject({ status: "deleted", vectorCount: 1, trashed: true, edgesDropped: false });
    expect(await forgetEntry("entry", env, { actorId: "", channel: "rest" as const }, { reason: "forget", config: DEFAULTS }, "")).toEqual({ status: "not_found" });
  });

  it("Prompt Capsule のタグ更新で changes が増えても非推奨化と状態更新を確定する", async () => {
    const { env } = await fixture();
    const tags = JSON.stringify(["capsule:core"]);
    const updated = await env.DB.prepare("UPDATE entries SET tags = ?, write_marker = ? WHERE id = ?")
      .bind(tags, memoryWriteMarker(env), "entry").run();
    expect(updated.meta.changes).toBeGreaterThan(1);
    expect(await applyStatus("entry", "canonical", env, { actorId: "", channel: "rest" as const }, DEFAULTS, "")).toMatchObject({ status: "ok", indexed: true });
    expect(await deprecateEntry("entry", env, { actorId: "", channel: "rest" as const }, DEFAULTS, "")).toBe(true);
    expect(JSON.parse(sqlite.rows()[0].tags as string)).toContain("status:deprecated");
  });

  for (const operation of ["forget", "deprecate"] as const) {
    it.each([false, true])(`${operation}は遠隔失敗=%sでも確定済み本文操作と台帳を維持する`, async (rejectRemote) => {
      const { env, rows } = await fixture();
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      vi.spyOn(console, "error").mockImplementation(() => {});
      if (rejectRemote) vi.mocked(env.VECTORIZE.deleteByIds).mockRejectedValue(new Error("remote failure"));
      else vi.mocked(env.VECTORIZE.deleteByIds).mockResolvedValue({ mutationId: "receipt" });
      if (operation === "forget") {
        await expect(forgetEntry("entry", env, { actorId: "", channel: "rest" as const }, { reason: "forget", config: DEFAULTS }, "")).resolves.toMatchObject({ status: "deleted", vectorCount: 1, trashed: true, edgesDropped: false });
        expect(sqlite.rows()).toHaveLength(0);
      } else {
        await expect(deprecateEntry("entry", env, { actorId: "", channel: "rest" as const }, DEFAULTS, "")).resolves.toBe(true);
        expect(sqlite.rows()[0]).toMatchObject({ content: "original", vector_ids: "[]" });
      }
      expect(env.VECTORIZE.deleteByIds).toHaveBeenCalledExactlyOnceWith(["old-vector"]);
      expect((await rows()).results).toEqual([expect.objectContaining({
        vector_ids: '["old-vector"]', ready: rejectRemote ? 1 : 3,
        expires_at: rejectRemote ? now : now + 60_000,
      })]);
    });
  }

  it("forgetのhookは本文操作前と権限更新後の遠隔操作前に呼ぶ", async () => {
    const { env, admission, rows } = await fixture();
    const events: string[] = [];
    const options = {
      reason: "forget" as const, config: DEFAULTS,
      async beforeMutation() {
        expect(this).toBe(options);
        events.push("hook");
        if (events.length === 2) {
          expect(sqlite.rows()).toHaveLength(0);
          expect((await rows()).results[0].write_marker).toMatch(new RegExp(`^${admission.token}:write:`));
        }
      },
    };
    vi.mocked(env.VECTORIZE.deleteByIds).mockImplementation(async () => {
      events.push("remote");
      return { mutationId: "receipt" };
    });
    await forgetEntry("entry", env, { actorId: "", channel: "rest" as const }, options, "");
    expect(events).toEqual(["hook", "hook", "remote"]);
  });


  it("同じentry IDを再利用した行の現行索引と他のentryの索引は削除しない", async () => {
    const { env, rows } = await fixture(["retired", "current", "foreign"]);
    const op = await recordVectorCleanup(env, "entry", ["retired", "current", "foreign"]);
    await markVectorCleanupReady(env, op);
    await env.DB.prepare(`UPDATE entries SET vector_ids = ?, write_marker = ? WHERE id = ?`)
      .bind('["current"]', memoryWriteMarker(env), "entry").run();
    vi.mocked(env.VECTORIZE.getByIds).mockResolvedValue([
      { id: "retired", values: [1], metadata: { parentId: "entry" } },
      { id: "foreign", values: [1], metadata: { parentId: "another" } },
    ]);
    await submitLifecycleVectorCleanup(env, op, "entry", ["retired", "current", "foreign"]);
    expect(env.VECTORIZE.deleteByIds).toHaveBeenCalledExactlyOnceWith(["retired"]);
    expect((await rows()).results).toHaveLength(1);
    expect(sqlite.rows()[0].vector_ids).toBe('["current"]');
  });

  it("空の削除台帳はmarkerとDELETEのbatchで除去し遠隔操作をしない", async () => {
    const { env, rows } = await fixture([]);
    const op = await recordVectorCleanup(env, "entry", []);
    const hook = vi.fn();
    await submitLifecycleVectorCleanup(env, op, "entry", [], hook);
    expect((await rows()).results).toEqual([]);
    expect(env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it("台帳の権限喪失は従来の例外で拒否し遠隔操作へ進まない", async () => {
    const { env } = await fixture();
    const hook = vi.fn();
    await expect(submitLifecycleVectorCleanup(env, "missing", "entry", ["old-vector"], hook))
      .rejects.toThrow("Vector cleanup capability was lost");
    expect(env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it("hook失敗時に台帳を残して再送を保留する", async () => {
    const { env, rows } = await fixture();
    const op = await recordVectorCleanup(env, "entry", ["old-vector"]);
    await markVectorCleanupReady(env, op);
    await expect(submitLifecycleVectorCleanup(env, op, "entry", ["old-vector"], async () => { throw new Error("stopped"); }))
      .rejects.toThrow("stopped");
    expect(env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
    expect((await rows()).results[0].ready).toBe(1);
  });
});
