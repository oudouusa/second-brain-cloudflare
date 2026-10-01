import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { McpExecutor, NIGHTLY_MAX_WALL_MS } from "../../src/mcp/executor";
import { NIGHTLY_MAINTENANCE_CRON, runScheduledJobs } from "../../src/runtime/scheduled";
import { makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/env";

vi.mock("../../src/runtime/scheduled", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/runtime/scheduled")>(),
  runScheduledJobs: vi.fn(),
}));

const time = Date.UTC(2026, 8, 12, 1);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function context() {
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil: vi.fn((task: Promise<unknown>) => tasks.push(task)) } as unknown as ExecutionContext;
  return { ctx, finish: async () => { while (tasks.length) await Promise.all(tasks.splice(0)); } };
}
function bound(runNightly = vi.fn(async (_time: number) => {})) {
  const getByName = vi.fn(() => ({ runNightly }));
  return { runNightly, getByName, env: makeTestEnv(undefined, {
    MCP_EXECUTOR: { getByName } as unknown as Env["MCP_EXECUTOR"],
  }) };
}

beforeEach(() => { vi.mocked(runScheduledJobs).mockReset().mockResolvedValue(undefined); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("夜間処理のCPU実行境界", () => {
  it("夜間は専用objectに転送し、公開WorkerではD1や処理本体を実行しない", async () => {
    const { env, getByName, runNightly } = bound();
    const prepare = vi.spyOn(env.DB, "prepare");
    const kvGet = vi.spyOn(env.OAUTH_KV, "get");
    const { ctx, finish } = context();
    await worker.scheduled({ cron: NIGHTLY_MAINTENANCE_CRON, scheduledTime: time } as ScheduledEvent, env, ctx);
    await finish();
    expect(getByName).toHaveBeenCalledExactlyOnceWith("nightly-v1");
    expect(runNightly).toHaveBeenCalledExactlyOnceWith(time);
    expect(runScheduledJobs).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(kvGet).not.toHaveBeenCalled();
  });

  it("RPC失敗後にinline再実行せず、エラー本文をログへ出さない", async () => {
    const { env, runNightly } = bound(vi.fn(async () => { throw new Error("private detail"); }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, finish } = context();
    await worker.scheduled({ cron: NIGHTLY_MAINTENANCE_CRON, scheduledTime: time } as ScheduledEvent, env, ctx);
    await finish();
    expect(runNightly).toHaveBeenCalledOnce();
    expect(runScheduledJobs).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).toContain("nightly_dispatch");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private detail");
  });

  it.each(["30 * * * *", "45 1 * * *", "15 2 * * SUN", "45 2 * * SUN", "unknown"])(
    "%s は従来の実行本体へ渡す", async cron => {
      const { env, getByName } = bound();
      const { ctx, finish } = context();
      const event = { cron, scheduledTime: time } as ScheduledEvent;
      await worker.scheduled(event, env, ctx); await finish();
      expect(runScheduledJobs).toHaveBeenCalledExactlyOnceWith(event, env, ctx);
      expect(getByName).not.toHaveBeenCalled();
    });

  it("bindingなしのローカル開発では同じ夜間処理本体を使う", async () => {
    const env = makeTestEnv(); const { ctx } = context();
    const event = { cron: NIGHTLY_MAINTENANCE_CRON, scheduledTime: time } as ScheduledEvent;
    await worker.scheduled(event, env, ctx);
    expect(runScheduledJobs).toHaveBeenCalledExactlyOnceWith(event, env, ctx);
  });

  it("RPCは動的に登録される背景処理と解放まで待つ", async () => {
    const first = deferred(); const nested = deferred();
    let registered = false; let released = false; let returned = false;
    vi.mocked(runScheduledJobs).mockImplementation(async (_event, _env, ctx) => {
      ctx.waitUntil((async () => {
        await first.promise;
        ctx.waitUntil(nested.promise.then(() => { released = true; }));
        registered = true;
      })());
    });
    const env = makeTestEnv(); const { ctx } = context();
    const executor = new McpExecutor(ctx as unknown as DurableObjectState, env);
    const result = executor.runNightly(time).then(() => { returned = true; });
    await vi.waitFor(() => expect(runScheduledJobs).toHaveBeenCalledOnce());
    expect(returned).toBe(false);
    first.resolve(); await vi.waitFor(() => expect(registered).toBe(true));
    expect(returned).toBe(false);
    nested.resolve(); await result;
    expect(released).toBe(true);
    expect(runScheduledJobs).toHaveBeenCalledWith(
      { cron: NIGHTLY_MAINTENANCE_CRON, scheduledTime: time }, env, expect.any(Object));
  });

  it("背景処理が失敗しても他の解放を待ってからRPCを失敗にする", async () => {
    let released = false;
    vi.mocked(runScheduledJobs).mockImplementation(async (_event, _env, ctx) => {
      ctx.waitUntil(Promise.reject(new Error("private background")));
      ctx.waitUntil(Promise.resolve().then(() => {
        ctx.waitUntil(Promise.resolve().then(() => { released = true; }));
      }));
    });
    const { ctx } = context();
    const executor = new McpExecutor(ctx as unknown as DurableObjectState, makeTestEnv());
    await expect(executor.runNightly(time)).rejects.toThrow("Nightly background task failed");
    expect(released).toBe(true);
  });

  it.each([NaN, -1, Infinity, 1.5])("不正な時刻 %s は処理前に拒否する", async value => {
    const { ctx } = context();
    const executor = new McpExecutor(ctx as unknown as DurableObjectState, makeTestEnv());
    await expect(executor.runNightly(value)).rejects.toThrow("Invalid scheduled time");
    expect(runScheduledJobs).not.toHaveBeenCalled();
  });

  it.each(["handler", "background", "release"])("%s が返らなくても実時間5分で専用DOを終了する", async stage => {
    vi.useFakeTimers();
    const stuck = deferred();
    vi.mocked(runScheduledJobs).mockImplementation(async (_event, _env, ctx) => {
      if (stage === "handler") await stuck.promise;
      else if (stage === "background") ctx.waitUntil(stuck.promise);
      else ctx.waitUntil(Promise.resolve().then(() => { ctx.waitUntil(stuck.promise); }));
    });
    const abort = vi.fn();
    const { ctx } = context();
    const state = Object.assign(ctx, { abort });
    const executor = new McpExecutor(state as unknown as DurableObjectState, makeTestEnv());
    const run = executor.runNightly(time);
    expect(NIGHTLY_MAX_WALL_MS).toBe(300_000);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(abort).toHaveBeenCalledExactlyOnceWith(
      "Nightly wall-clock limit exceeded (300000 ms)", { retryAlarm: false });
    // 実runtimeのabortはcatch不能。unit doubleでは解放してテストを終了する。
    stuck.resolve(); await run;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "failure"])("%s 後は停止タイマーを残さず、次の実行を許可する", async outcome => {
    vi.useFakeTimers();
    const abort = vi.fn(); const { ctx } = context();
    const executor = new McpExecutor(Object.assign(ctx, { abort }) as unknown as DurableObjectState, makeTestEnv());
    if (outcome === "failure") vi.mocked(runScheduledJobs).mockRejectedValueOnce(new Error("failed"));
    if (outcome === "failure") await expect(executor.runNightly(time)).rejects.toThrow("failed");
    else await executor.runNightly(time);
    expect(vi.getTimerCount()).toBe(0);
    await executor.runNightly(time + 86400_000);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(NIGHTLY_MAX_WALL_MS * 2);
    expect(abort).not.toHaveBeenCalled();
  });

  it("重複呼出で停止期限を延長したり処理を多重化したりしない", async () => {
    vi.useFakeTimers();
    const stuck = deferred();
    vi.mocked(runScheduledJobs).mockImplementation(async () => stuck.promise);
    const abort = vi.fn(); const { ctx } = context();
    const executor = new McpExecutor(Object.assign(ctx, { abort }) as unknown as DurableObjectState, makeTestEnv());
    const run = executor.runNightly(time);
    await vi.advanceTimersByTimeAsync(240_000);
    await expect(executor.runNightly(time + 1)).rejects.toThrow("Nightly execution already running");
    expect(runScheduledJobs).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(abort).toHaveBeenCalledOnce();
    stuck.resolve(); await run;
  });
});
