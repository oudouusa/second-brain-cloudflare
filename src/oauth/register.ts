import { readJsonBody } from "../lib/http";
import type { Env } from "../env";

// Redirects are an authorization boundary: the owner token entered on the consent
// page must never mint a code to an arbitrary web origin supplied through anonymous
// dynamic client registration. Keep hosted callbacks explicit and permit only native
// app callbacks or RFC 8252-style loopback listeners with a concrete port.
export const CURSOR_MCP_REDIRECT_URIS = [
  "http://localhost:8787/callback",
  "cursor://anysphere.cursor-mcp/oauth/callback",
  "https://www.cursor.com/agents/mcp/oauth/callback",
];

const KNOWN_REDIRECT_URIS = new Set(CURSOR_MCP_REDIRECT_URIS);

export function isAllowedOAuthRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
  if (KNOWN_REDIRECT_URIS.has(value)) return true;
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol !== "http:") return false;
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
      return false;
    }
    const port = Number(url.port);
    return Number.isInteger(port) && port >= 1 && port <= 65_535;
  } catch {
    return false;
  }
}

function registrationError(error: string): Response {
  return new Response(JSON.stringify({ error: "invalid_redirect_uri", error_description: error }), {
    status: 400,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export const OAUTH_REGISTRATION_DAILY_LIMIT = 100;

/** Protect the shared OAuth KV write quota from anonymous DCR floods. */
export async function consumeOAuthRegistrationQuota(env: Env, now = Date.now()): Promise<Response | null> {
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const result = await env.DB.prepare(
    `INSERT INTO oauth_registration_quota (id, window_start, registration_count)
     VALUES ('global', ?, 1)
     ON CONFLICT(id) DO UPDATE SET
       window_start = excluded.window_start,
       registration_count = CASE
         WHEN oauth_registration_quota.window_start = excluded.window_start
           THEN oauth_registration_quota.registration_count + 1
         ELSE 1
       END
     WHERE oauth_registration_quota.window_start <> excluded.window_start
        OR oauth_registration_quota.registration_count < ?`,
  ).bind(dayStart, OAUTH_REGISTRATION_DAILY_LIMIT).run();
  const changes = Number(result.meta.changes
    ?? (result.meta as D1Result["meta"] & { rows_written?: number }).rows_written
    ?? 0);
  if (changes === 1) return null;
  const retryAfter = Math.max(1, Math.ceil((dayStart + 86_400_000 - now) / 1_000));
  return new Response(JSON.stringify({
    error: "temporarily_unavailable",
    error_description: "OAuth client registration daily limit reached",
  }), {
    status: 429,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(retryAfter),
    },
  });
}

export async function augmentOAuthRegistrationRequest(request: Request): Promise<Request | Response> {
  if (request.method !== "POST") return request;
  const parsed = await readJsonBody<Record<string, unknown>>(request, 64 * 1024);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    return registrationError("At least one approved redirect URI is required");
  }
  if (body.redirect_uris.length > 8 || body.redirect_uris.some(uri => !isAllowedOAuthRedirectUri(uri))) {
    return registrationError("Only approved MCP callbacks and local loopback callbacks are allowed");
  }
  const redirectUris = [...new Set(body.redirect_uris as string[])];
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  return new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, redirect_uris: redirectUris }),
  });
}
