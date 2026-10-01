import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { withFtsWriteGuard } from "../db/fts-write-guard";
import { recordD1BaseEnv } from "../runtime/d1-budget";

type McpExecutionContext = ExecutionContext & { props?: { userId?: string } };

// CPU制限とは別。通信・動的waitUntil・解放が止まっても夜間DOを常駐させない。
export const NIGHTLY_MAX_WALL_MS = 5 * 60_000;

/**
 * Runs the full MCP protocol and tool graph outside the Free-plan HTTP
 * Worker's 10 ms CPU envelope. Durable Object requests have their own CPU
 * budget, while the public Worker only authenticates and forwards the request.
 *
 * The object is deliberately stateless. D1 remains the source of truth and a
 * single stable object name merely lets warm isolates reuse the imported MCP
 * module; no memory content or credentials are persisted here.
 */
export class McpExecutor extends DurableObject<Env> {
  #nightlyRunning = false;

  /** provider管理と直接接続の回答を既存CPU境界で実行する。認証は各handler、永続状態はD1。 */
  async handleChatGpt(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/dashboard/api/")) url.pathname = url.pathname.slice("/dashboard/api".length);
    const env = withFtsWriteGuard(recordD1BaseEnv({ ...this.env, MCP_EXECUTOR: undefined }));
    const ctx = { waitUntil: (promise: Promise<unknown>) => this.ctx.waitUntil(promise) } as ExecutionContext;
    const handler = url.pathname === "/chat" && request.method === "POST"
      ? (await import("../routes/recall")).handleRecallRoutes
      : (await import("../routes/chatgpt")).handleChatGptRoutes;
    const response = await handler(request, url, env, ctx);
    return this.#keepResponseAlive(response ?? new Response("Not found", { status: 404 }));
  }

  /** 週次の読取専用プレビュー。認証・scope・候補条件は既存REST本体へ委譲する。 */
  async handleInsightPreview(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const dashboard = url.pathname.startsWith("/dashboard/api/");
    const path = dashboard ? url.pathname.slice("/dashboard/api".length) : url.pathname;
    if (path !== "/insights/dry-run" || request.method !== "GET") {
      return this.#keepResponseAlive(new Response("Not found", { status: 404 }));
    }
    return this.#handleRest(request, dashboard);
  }

  /** REST検索専用。原文・履歴・検索台帳の正本と利用回数のwrite fenceはD1に残す。 */
  async handleRecall(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const dashboard = url.pathname.startsWith("/dashboard/api/");
    const path = dashboard ? url.pathname.slice("/dashboard/api".length) : url.pathname;
    if (path !== "/recall" || request.method !== "POST") {
      return this.#keepResponseAlive(new Response("Not found", { status: 404 }));
    }
    return this.#handleRest(request, dashboard);
  }

  async #handleRest(request: Request, dashboard: boolean): Promise<Response> {
    const env = withFtsWriteGuard(recordD1BaseEnv({ ...this.env, MCP_EXECUTOR: undefined }));
    const ctx = { waitUntil: (promise: Promise<unknown>) => this.ctx.waitUntil(promise) } as ExecutionContext;
    const { createDefaultHandler } = await import("../routes/index");
    const handler = createDefaultHandler(dashboard ? { trustedPrefix: "/dashboard/api" } : {});
    return this.#keepResponseAlive(await handler.fetch(request, env, ctx));
  }

  #keepResponseAlive(response: Response): Response {
    if (!response.body) return response;
    // JSONもRPCではstream。SSEと同じく完了・切断まで送信側の文脈を保持する。
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    this.ctx.waitUntil(response.body.pipeTo(stream.writable).catch(() => {}));
    return new Response(stream.readable, response);
  }

  /** 夜間専用objectのRPC。全waitUntilとadmission解放が終わるまで応答しない。 */
  async runNightly(scheduledTime: number): Promise<void> {
    if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0) {
      throw new TypeError("Invalid scheduled time");
    }
    // 同じobjectへの重複呼出は、最初の処理の期限を延ばさずに拒否する。
    if (this.#nightlyRunning) throw new Error("Nightly execution already running");
    this.#nightlyRunning = true;
    const deadline = setTimeout(() => {
      // Promise.raceだけでは元のI/Oが残る。専用objectを終了し、同時処理も止める。
      // 強制終了時の未確定処理は既存journal/CAS/期限付きadmissionで回復する。
      this.ctx.abort("Nightly wall-clock limit exceeded (300000 ms)", { retryAlarm: false });
    }, NIGHTLY_MAX_WALL_MS);
    const pending: Promise<void>[] = [];
    let failed = false;
    const executionContext = {
      waitUntil: (task: Promise<unknown>) => {
        const observed = Promise.resolve(task).then(() => {}, () => { failed = true; });
        pending.push(observed);
        this.ctx.waitUntil(observed);
      },
    } as unknown as ExecutionContext;
    try {
      const { NIGHTLY_MAINTENANCE_CRON, runScheduledJobs } = await import("../runtime/scheduled");
      try {
        await runScheduledJobs({ cron: NIGHTLY_MAINTENANCE_CRON, scheduledTime } as ScheduledEvent,
          this.env, executionContext);
      } finally {
        // 実行途中に登録された背景処理も、さらに登録される解放処理も待つ。
        while (pending.length) await Promise.all(pending.splice(0));
      }
      if (failed) throw new Error("Nightly background task failed");
    } finally {
      clearTimeout(deadline);
      this.#nightlyRunning = false;
    }
  }

  async handleMcp(request: Request, oauthUserId?: string): Promise<Response> {
    const executionContext = {
      waitUntil: (promise: Promise<unknown>) => this.ctx.waitUntil(promise),
      props: oauthUserId ? { userId: oauthUserId } : undefined,
    } as unknown as McpExecutionContext;
    const { apiHandler } = await import("./handler");
    return apiHandler.fetch(request, withFtsWriteGuard(recordD1BaseEnv(this.env)), executionContext);
  }
}
