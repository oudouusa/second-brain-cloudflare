import type { Env } from "../env";
import { isValidAuthToken, readFormUrlEncodedBody } from "../lib/http";
import { resolveIdentityFromToken } from "../lib/identity";
import { authorizeErrorHint, authorizeErrorHtml, loginHtml } from "./pages";

const CSRF_COOKIE = "sb_oauth_csrf";

function randomCsrfToken(): string {
  return crypto.randomUUID();
}

function csrfCookie(request: Request, value: string, maxAge = 600): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${CSRF_COOKIE}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function readCsrfCookie(request: Request): string | null {
  return /(?:^|;\s*)sb_oauth_csrf=([^;]*)/.exec(request.headers.get("Cookie") ?? "")?.[1] ?? null;
}

function loginResponse(
  request: Request,
  loginContext: { clientId?: string; redirectUri?: string },
  error?: string,
  status = 200,
): Response {
  const csrfToken = randomCsrfToken();
  return new Response(loginHtml(error, { ...loginContext, csrfToken }), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": csrfCookie(request, csrfToken),
      "X-Frame-Options": "DENY",
    },
  });
}

export async function handleOAuthAuthorize(request: Request, env: Env): Promise<Response> {
  let oauthReq: any;
  try {
    // workers-oauth-provider mis-parses POST bodies; pass a URL-only GET clone
    // so parseAuthRequest reads the query params cleanly.
    const parseReq = request.method === "POST" ? new Request(request.url, { method: "GET" }) : request;
    oauthReq = await (env as any).OAUTH_PROVIDER.parseAuthRequest(parseReq);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("OAuth authorize parse failed:", detail);
    return new Response(authorizeErrorHtml(authorizeErrorHint(detail), detail), {
      status: 400, headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  const loginContext = {
    clientId: typeof oauthReq.clientId === "string" ? oauthReq.clientId : undefined,
    redirectUri: typeof oauthReq.redirectUri === "string" ? oauthReq.redirectUri : undefined,
  };
  if (request.method === "POST") {
    const form = await readFormUrlEncodedBody(request, 8 * 1024);
    if (!form.ok) return form.response;
    const submittedCsrf = form.value.get("csrf_token");
    if (!submittedCsrf || submittedCsrf !== readCsrfCookie(request)) {
      return loginResponse(request, loginContext, "Sign-in session expired. Please try again.", 403);
    }
    const password = form.value.get("password") ?? "";
    let grantUserId = "owner";
    let propsUserId = "owner";
    if (!await isValidAuthToken(password, env)) {
      const identity = await resolveIdentityFromToken(password, env);
      if (!identity) return loginResponse(request, loginContext, "Invalid token", 401);
      grantUserId = identity.userId;
      propsUserId = identity.userId;
    }
    // BE-5: the client's own registered name, read once at sign-in so every later
    // request carries it on ctx.props at no extra cost (src/mcp/client-label.ts,
    // resolveClientLabel's source 1). Absent entirely, not stored as "", when the
    // client registered without one — an empty prop and a missing prop must not
    // read the same to a caller checking `"clientName" in props`.
    const client = await (env as any).OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
    const clientName = client?.clientName;
    const { redirectTo } = await (env as any).OAUTH_PROVIDER.completeAuthorization({
      request: oauthReq,
      userId: grantUserId,
      scope: oauthReq.scope,
      props: { userId: propsUserId, clientId: oauthReq.clientId, ...(clientName ? { clientName } : {}) },
    });
    return new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "no-store",
        "Location": redirectTo,
        "Set-Cookie": csrfCookie(request, "", 0),
      },
    });
  }
  return loginResponse(request, loginContext);
}
