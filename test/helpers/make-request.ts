import { VERIFIED_AUTH_HEADER } from "../../src/lib/http";

const BASE = "http://localhost";
const TOKEN = "test-token";

export function req(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string | null } = {}
): Request {
  let { body } = opts;
  const { token = TOKEN } = opts;
  // POST route fixtures may use a query-shaped shorthand, but the requested HTTP
  // method is never rewritten. A test spelling GET now exercises GET.
  const privatePostRoutes = ["/recall", "/entry", "/entry/version", "/connections", "/digest"];
  const legacyUrl = new URL(`${BASE}${path}`);
  const convertsPrivatePostQuery = method === "POST" && (
    privatePostRoutes.includes(legacyUrl.pathname)
    || (legacyUrl.pathname === "/graph" && legacyUrl.searchParams.has("seed"))
    || (legacyUrl.pathname === "/list" && legacyUrl.searchParams.has("tag"))
  );
  if (convertsPrivatePostQuery) {
    const converted: Record<string, unknown> = {};
    for (const [key, value] of legacyUrl.searchParams) {
      if (["topK", "seq", "hops", "after", "before", "n", "limit"].includes(key) && /^-?\d+$/.test(value)) {
        converted[key] = Number(value);
      } else if (key === "full" || key === "explain" || key === "synthesize") {
        converted[key] = ["1", "true", "yes"].includes(value.toLowerCase());
      } else {
        converted[key] = value;
      }
    }
    path = legacyUrl.pathname;
    body = body ?? converted;
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) {
    headers["Authorization"] = `Bearer ${token}`;
    // Direct route-handler tests bypass src/index.ts, which is the production
    // boundary that sets this marker after timing-safe verification.
    if (token === TOKEN) headers[VERIFIED_AUTH_HEADER] = "1";
  }
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
