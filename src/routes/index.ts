import type { Env } from "../env";
import { boundRequestBody, CORS_HEADERS, json, VERIFIED_AUTH_HEADER, withVerifiedAuth } from "../lib/http";
import { handleOAuthAuthorize } from "../oauth/authorize";
import { ensureDbReady } from "../runtime/state";
import { handleCaptureRoutes } from "./capture";
import { handleRolloverRoutes } from "./rollover";
import { handleHistoryRoutes } from "./history";
import { handlePromptCapsuleRoutes } from "./prompt-capsule";
import { handleProjectsRoutes } from "./projects";
import { handleRecallRoutes } from "./recall";
import { handleEntriesRoutes } from "./entries";
import { handleGraphRoutes } from "./graph";
import { handleIntegrationsRoutes } from "./integrations";
import { handleAdminRoutes } from "./admin";
import { handlePushRoutes } from "./push";
import { handleBriefRoutes } from "./brief";
import { handleConfigRoutes } from "./config";
import { handleMigrationRoutes } from "./migration";
import { handleOAuthRevokeRoutes } from "./oauth-revoke";
import {
  normalizeMemoryWriteLockError,
  restRequestNeedsWriteAdmission,
  withRequestWriteAdmission,
} from "../migration/write-lock";
import { handleBackupRoutes } from "./backup";
import { handleChatGptRoutes } from "./chatgpt";
import { isChatGptOperationEnabled } from "../lib/chatgpt";
import { initializeDatabase } from "../db/init";
import { resolveIdentity } from "../lib/identity";
import { handleStandingRoutes } from "./standing";
import { handleLedgerRoutes } from "./ledger";

type RouteHandler = (
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response | null>;

const routeHandlers: RouteHandler[] = [
  handleCaptureRoutes,
  handleRolloverRoutes,
  handleHistoryRoutes,
  handlePromptCapsuleRoutes,
  handleProjectsRoutes,
  handleRecallRoutes,
  handleEntriesRoutes,
  handleGraphRoutes,
  handleIntegrationsRoutes,
  handleAdminRoutes,
  handlePushRoutes,
  handleBriefRoutes,
  handleConfigRoutes,
  handleMigrationRoutes,
  handleBackupRoutes,
  handleChatGptRoutes,
  handleOAuthRevokeRoutes,
  handleStandingRoutes,
  handleLedgerRoutes,
];

interface DefaultHandlerOptions {
  /** Present only after the outer Worker has verified a trusted auth boundary. */
  trustedPrefix?: string;
}

export function createDefaultHandler(options: DefaultHandlerOptions = {}) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, { headers: CORS_HEADERS });
      }

      if (options.trustedPrefix) {
        if (!url.pathname.startsWith(`${options.trustedPrefix}/`)) {
          return new Response("Not found", { status: 404 });
        }
        url.pathname = url.pathname.slice(options.trustedPrefix.length);
        const headers = new Headers(request.headers);
        headers.delete("Authorization");
        headers.delete(VERIFIED_AUTH_HEADER);
        headers.set(VERIFIED_AUTH_HEADER, "1");
        request = new Request(request, { headers });
      } else {
        // The public handler removes any forged verification marker before routing.
        request = await withVerifiedAuth(request, env);
      }

      // OAuth authorize endpoint — hosted login page for browser-based MCP clients.
      if (url.pathname === "/oauth/authorize") {
        return handleOAuthAuthorize(request, env);
      }

      const staticallyAuthenticated = request.headers.get(VERIFIED_AUTH_HEADER) === "1";
      const authenticated = staticallyAuthenticated
        || (request.headers.has("Authorization") && !!(await resolveIdentity(request, env)));
      // REST検索も既存DOのCPU予算へ送る。検索語の解析・D1初期化はDO内で行う。
      // 転送前に実バイト32 KiBを確認し、DO内では元のREST認証・scope・admissionを再利用する。
      if (authenticated && url.pathname === "/recall" && request.method === "POST"
        && env.MCP_EXECUTOR) {
        const bounded = await boundRequestBody(request, 32 * 1024);
        if (!bounded.ok) {
          return bounded.response.status === 413
            ? json({ ok: false, error: "JSON body is too large" }, 413)
            : bounded.response;
        }
        return env.MCP_EXECUTOR.getByName("mcp-v1").handleRecall(bounded.request);
      }
      if (authenticated && !["GET", "HEAD"].includes(request.method) && request.body) {
        const bounded = await boundRequestBody(request, 1024 * 1024);
        if (!bounded.ok) return bounded.response;
        request = bounded.request;
      }
      // 認証と全体の本文上限を確認し、DB初期化・利用者情報・SSEの処理は既存DOで行う。
      // DO内でも利用者認証と回答専用の256 KiB上限を適用する。
      if (authenticated && url.pathname === "/chat" && request.method === "POST"
        && env.MCP_EXECUTOR && isChatGptOperationEnabled(env, "answer")) {
        return env.MCP_EXECUTOR.getByName("mcp-v1").handleChatGpt(request);
      }

      // 原文引用の検証とLLM応答の解析も既存DOのCPU予算で実行する。
      // DO内の既存REST handlerでadmin認可・両方のworkspace scopeを再確認する。
      if (authenticated && url.pathname === "/insights/dry-run" && request.method === "GET"
        && env.MCP_EXECUTOR) {
        return env.MCP_EXECUTOR.getByName("mcp-v1").handleInsightPreview(request);
      }

      const isRestore = url.pathname.startsWith("/admin/restore/");
      // Snapshot creation claims an exclusive maintenance barrier itself so its D1
      // rows and credential-free integration cursors represent one quiescent point.
      const isBackupSnapshot = url.pathname === "/admin/backup" && request.method === "POST";
      // restoreR2Backup verifies both R2 objects and their hash before performing its own
      // awaited schema init. Starting background init here would mutate D1 first.
      if (authenticated && url.pathname === "/import") {
        const initialized = await initializeDatabase(env);
        if (initialized.changed) {
          return json({
            ok: false,
            retry: true,
            error: "Database schema initialized; retry the same import request",
          }, 202);
        }
      } else if (authenticated && !isRestore && !isBackupSnapshot) {
        ensureDbReady(ctx, env);
      }

      return withRequestWriteAdmission(env, ctx, authenticated && restRequestNeedsWriteAdmission(request, url),
        async (routedEnv, routedCtx) => {
          for (const handler of routeHandlers) {
            try {
              const response = await handler(request, url, routedEnv, routedCtx);
              if (response) return response;
            } catch (e) {
              const lockError = await normalizeMemoryWriteLockError(env, e);
              if (lockError) {
                return json({
                  ok: false,
                  error: lockError.message,
                  writeLock: lockError.lock,
                }, lockError.status);
              }
              throw e;
            }
          }

          return new Response("Not found", { status: 404 });
        });
    },
  };
}

export const defaultHandler = createDefaultHandler();
export const dashboardApiHandler = createDefaultHandler({ trustedPrefix: "/dashboard/api" });
