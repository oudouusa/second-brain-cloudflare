/**
 * Second Brain — Cloudflare Worker
 * https://github.com/rahilp/second-brain-cloudflare
 */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { NIGHTLY_MAINTENANCE_CRON, runScheduledJobs } from "./runtime/scheduled";
import { resolveIdentityFromToken } from "./lib/identity";
import { augmentOAuthRegistrationRequest, consumeOAuthRegistrationQuota } from "./oauth/register";
import { boundRequestBody, isValidAuthToken, json } from "./lib/http";
import { durationMs, errorName, installPrivacySafeConsole, logErrorEvent, logEvent } from "./lib/observability";
import { verifyCloudflareAccess } from "./lib/cloudflare-access";
import { dashboardApiHandler, defaultHandler } from "./routes";
import { initializeDatabase } from "./db/init";
import { withFtsWriteGuard } from "./db/fts-write-guard";
import { recordD1BaseEnv } from "./runtime/d1-budget";
import { fetchMcpApi } from "./mcp/dispatch";

export type { Env } from "./env";
export { McpExecutor } from "./mcp/executor";

installPrivacySafeConsole();

const SAFE_ROUTE_GROUPS = new Set([
  "append", "brief", "capture", "chat", "classify-pending", "config", "digest", "entry", "export",
  "forget", "graph", "health", "history", "hot-context", "import", "insights", "integrations",
  "list", "mcp", "oauth-mcp", "migration", "recall", "rollover", "stale", "tags", "vectorize-pending",
]);

const ACCESS_MCP_PATH = "/mcp";
const MANAGED_OAUTH_MCP_PATH = "/oauth-mcp";

const managedOAuthApiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    url.pathname = ACCESS_MCP_PATH;
    return fetchMcpApi(new Request(url, request), env, ctx);
  },
};

function requestOperation(request: Request): string {
  const rawPathname = new URL(request.url).pathname;
  const pathname = rawPathname.startsWith("/dashboard/api/")
    ? rawPathname.slice("/dashboard/api".length)
    : rawPathname;
  if (pathname === "/admin/backup") return "admin_backup";
  if (pathname === "/admin/backups") return "admin_backups";
  if (pathname.startsWith("/admin/restore/")) return "admin_restore";
  if (pathname.startsWith("/oauth/")) return "oauth";
  const group = pathname.split("/").filter(Boolean)[0] ?? "root";
  if (SAFE_ROUTE_GROUPS.has(group)) return group;
  if (/\.(?:css|html|ico|js|png|svg|webmanifest)$/i.test(pathname)) return "asset";
  return "other";
}

import { classifyD1DailyLimitError, dailyLimitMcpResponse, dailyLimitRestResponse } from "./lib/daily-limit";

export async function resolveExternalToken({ token, env }: { token: string; request: Request; env: unknown }) {
  const e = env as Env;
  if (await isValidAuthToken(token, e)) return { props: { userId: "owner", via: "token" as const } };
  const identity = await resolveIdentityFromToken(token, e);
  return identity ? { props: { userId: identity.userId, via: "token" as const } } : null;
}

const oauthProvider = new OAuthProvider({
  // /mcp is retained for the existing Cloudflare Access application. A
  // separate top-level path is required because Access intercepts /mcp before
  // the Worker can issue its own OAuth challenge.
  apiRoute: MANAGED_OAUTH_MCP_PATH,
  // The OAuth provider must see /oauth-mcp to validate the protected-resource
  // audience. The Agents MCP handler itself is mounted at /mcp, so normalize
  // only after the provider has accepted the token.
  apiHandler: managedOAuthApiHandler,
  defaultHandler,
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  allowPlainPKCE: false,
  // Accept the static AUTH_TOKEN for Claude Desktop + mcp-remote (no browser flow).
  resolveExternalToken,
});

function withoutAccessCredentials(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.delete("Cf-Access-Jwt-Assertion");
  headers.delete("Cookie");
  headers.delete("X-Second-Brain-Dashboard");
  return new Request(request, { headers });
}

function asManagedOAuthMcpRequest(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = MANAGED_OAUTH_MCP_PATH;
  return new Request(url, request);
}

type McpExecutionContext = ExecutionContext & { props?: { userId?: string } };

/** Cloudflare Access is owner-only on this deployment, so its verified MCP
 * surface must enter the same tenant as an owner OAuth grant. Restore the
 * request-scoped props after dispatch so a reused test context cannot leak it. */
async function asOwnerMcp<T>(ctx: ExecutionContext, run: (ownerCtx: ExecutionContext) => Promise<T>): Promise<T> {
  const ownerCtx = ctx as McpExecutionContext;
  const previous = ownerCtx.props;
  ownerCtx.props = { userId: "owner" };
  try {
    return await run(ownerCtx);
  } finally {
    if (previous === undefined) delete ownerCtx.props;
    else ownerCtx.props = previous;
  }
}

const DASHBOARD_PATH = "/dashboard";
const DASHBOARD_API_PREFIX = "/dashboard/api";
const DASHBOARD_SESSION_HEADER = "X-Second-Brain-Dashboard";

function dashboardRequestError(request: Request, url: URL): Response | null {
  if (request.headers.get(DASHBOARD_SESSION_HEADER) !== "1") {
    return json({ ok: false, error: "Cloudflare Access session required" }, 403);
  }
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin") {
    return json({ ok: false, error: "Cross-site dashboard request rejected" }, 403);
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)
    && request.headers.get("Origin") !== url.origin) {
    return json({ ok: false, error: "Invalid dashboard request origin" }, 403);
  }
  return null;
}

async function dashboardHtml(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  if (!env.ASSETS) return new Response("Dashboard assets unavailable", { status: 503 });
  const assetUrl = new URL("/", url);
  const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
  const headers = new Headers(asset.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  headers.set("X-Frame-Options", "DENY");
  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
}

export default {
  fetch: async (req: Request, env: Env, ctx: ExecutionContext) => {
    env = withFtsWriteGuard(recordD1BaseEnv(env));
    const startedAt = performance.now();
    const operation = requestOperation(req);
    try {
      const url = new URL(req.url);
      let response: Response;
      if (url.pathname === "/" && req.method === "GET") {
        response = new Response(null, {
          status: 302,
          headers: {
            "Cache-Control": "no-store", Location: new URL(DASHBOARD_PATH, url).toString(),
            "Set-Cookie": "CF_Authorization=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax",
          },
        });
      } else if (url.pathname === DASHBOARD_PATH || url.pathname.startsWith(`${DASHBOARD_PATH}/`)) {
        const accessError = await verifyCloudflareAccess(req, env);
        if (accessError !== null) {
          response = url.pathname.startsWith(`${DASHBOARD_API_PREFIX}/`)
            ? json({ ok: false, error: "Cloudflare Access authentication failed" }, accessError)
            : new Response("Cloudflare Access authentication failed", { status: accessError });
        } else if (url.pathname === DASHBOARD_PATH) {
          response = await dashboardHtml(req, env, url);
        } else if (url.pathname.startsWith(`${DASHBOARD_API_PREFIX}/`)) {
          const requestError = dashboardRequestError(req, url);
          if (requestError) {
            response = requestError;
          } else if (url.pathname === `${DASHBOARD_API_PREFIX}/mcp`) {
            const mcpUrl = new URL(req.url);
            mcpUrl.pathname = "/mcp";
            const cleaned = withoutAccessCredentials(req);
            response = await asOwnerMcp(ctx, ownerCtx => fetchMcpApi(
              new Request(mcpUrl, cleaned as unknown as RequestInit), env, ownerCtx,
            ));
          } else {
            response = await dashboardApiHandler.fetch(withoutAccessCredentials(req), env, ctx);
          }
        } else {
          response = new Response("Not found", { status: 404 });
        }
      } else if (url.pathname === ACCESS_MCP_PATH && req.headers.has("Cf-Access-Jwt-Assertion")) {
        const accessError = await verifyCloudflareAccess(req, env);
        response = accessError === null
          ? await asOwnerMcp(ctx, ownerCtx => fetchMcpApi(withoutAccessCredentials(req), env, ownerCtx))
          : json({ ok: false, error: "Cloudflare Access authentication failed" }, accessError);
      } else if (url.pathname === "/oauth/register" && req.method === "POST") {
        const augmented = await augmentOAuthRegistrationRequest(req);
        if (augmented instanceof Response) {
          response = augmented;
        } else {
          await initializeDatabase(env);
          const quota = await consumeOAuthRegistrationQuota(env);
          response = quota ?? await oauthProvider.fetch(augmented, env as any, ctx);
        }
      } else if (url.pathname === "/oauth/token" && req.method === "POST") {
        const bounded = await boundRequestBody(req, 64 * 1024);
        response = bounded.ok
          ? await oauthProvider.fetch(bounded.request, env as any, ctx)
          : bounded.response;
      } else if (url.pathname === ACCESS_MCP_PATH) {
        // Preserve direct/static-token compatibility in environments without
        // the production Access policy while keeping one canonical provider.
        response = await oauthProvider.fetch(asManagedOAuthMcpRequest(req), env as any, ctx);
      } else {
        response = await oauthProvider.fetch(req, env as any, ctx);
      }
      logEvent("http_request", {
        operation,
        method: req.method,
        status: response.status,
        outcome: response.status >= 500 ? "error" : response.status >= 400 ? "rejected" : "success",
        duration_ms: durationMs(startedAt),
      });
      return response;
    } catch (error) {
      logErrorEvent("http_request", {
        operation,
        method: req.method,
        outcome: "error",
        duration_ms: durationMs(startedAt),
        error_name: errorName(error),
      });
      const kind = classifyD1DailyLimitError(error);
      if (kind) return operation === "mcp" ? dailyLimitMcpResponse(kind) : dailyLimitRestResponse(kind);
      return json({ ok: false, error: "Internal server error" }, 500);
    }
  },
  scheduled: async (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    if (event.cron === NIGHTLY_MAINTENANCE_CRON && env.MCP_EXECUTOR) {
      // 夜間だけを既存namespace内の専用objectへ送る。MCPのobjectとは共有しない。
      // RPC失敗後のinline再実行は、既に書き込んだ処理を重複させるため行わない。
      ctx.waitUntil((async () => {
        try {
          await env.MCP_EXECUTOR!.getByName("nightly-v1").runNightly(event.scheduledTime);
        } catch (error) {
          logErrorEvent("scheduled_job", {
            operation: "nightly_dispatch", outcome: "error", error_name: errorName(error),
          });
        }
      })());
      return;
    }
    // 他4 cronとbindingなしのローカル開発は従来の実行先を維持する。
    return runScheduledJobs(event, env, ctx);
  },
};
