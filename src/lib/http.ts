import { BodyTooLargeError, readBoundedBytes } from "./body";
import type { Env } from "../env";
import type { AuthFailureCode, Identity } from "./identity";
import { readTeamParam } from "./scope";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, If-None-Match",
  "Access-Control-Expose-Headers": "ETag, X-Counts-Approximate",
};

/** Narrow a readable memory set to one user-facing layer. */
export function readWorkspaceParam(url: URL): "personal" | "company" | undefined | Response {
  const raw = url.searchParams.get("workspace")?.trim();
  if (!raw) return undefined;
  if (raw !== "personal" && raw !== "company") {
    return json({ ok: false, error: 'workspace must be "personal" or "company"' }, 400);
  }
  return raw;
}

/** Narrow a company-layer read to one validated team workspace. */
export function readTeamQueryParam(
  url: URL,
  identity: Identity,
  layer?: "personal" | "company",
): string | undefined | Response {
  const raw = url.searchParams.get("team");
  if (raw === null) return undefined;
  const result = readTeamParam(raw, identity, layer);
  if (result.error) return json({ ok: false, error: result.error }, 400);
  return result.teamId;
}

export const VERIFIED_AUTH_HEADER = "X-Second-Brain-Auth-Verified";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export async function readBodyBytes(
  body: ReadableStream<Uint8Array> | null,
  declared: string | null,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; response: Response }> {
  try {
    return { ok: true, bytes: await readBoundedBytes(body, declared, maxBytes) };
  } catch (error) {
    return error instanceof BodyTooLargeError
      ? { ok: false, response: json({ ok: false, error: "Request body is too large" }, 413) }
      : { ok: false, response: json({ ok: false, error: "Invalid request body" }, 400) };
  }
}

/** Buffer an authenticated request once, with a hard cap even for chunked bodies. */
export async function boundRequestBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; request: Request; bytes: Uint8Array } | { ok: false; response: Response }> {
  const result = await readBodyBytes(request.body, request.headers.get("Content-Length"), maxBytes);
  if (!result.ok) return result;
  return {
    ok: true,
    // Always override the source body, including when it is a zero-byte stream.
    // `undefined` means "inherit from request" to the Request constructor; after
    // readBodyBytes has drained that stream, workerd rejects the reconstruction as
    // "Cannot reconstruct a Request with a used body".
    request: new Request(request, { body: result.bytes }),
    bytes: result.bytes,
  };
}

export async function readJsonBody<T>(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const result = await readBodyBytes(request.body, request.headers.get("Content-Length"), maxBytes);
  if (!result.ok) {
    if (result.response.status === 413) {
      return { ok: false, response: json({ ok: false, error: "JSON body is too large" }, 413) };
    }
    return result;
  }
  if (result.bytes.byteLength === 0) {
    return { ok: false, response: json({ ok: false, error: "Invalid JSON" }, 400) };
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(result.bytes)) as T };
  } catch {
    return { ok: false, response: json({ ok: false, error: "Invalid JSON" }, 400) };
  }
}

export async function readFormUrlEncodedBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: URLSearchParams } | { ok: false; response: Response }> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return { ok: false, response: json({ ok: false, error: "Unsupported form content type" }, 415) };
  }
  const result = await readBodyBytes(request.body, request.headers.get("Content-Length"), maxBytes);
  if (!result.ok) return result;
  return { ok: true, value: new URLSearchParams(new TextDecoder().decode(result.bytes)) };
}

async function tokenDigest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

export async function isValidAuthToken(candidate: unknown, env: Env): Promise<boolean> {
  const configured = env.AUTH_TOKEN;
  if (typeof configured !== "string" || configured.length === 0 || typeof candidate !== "string") {
    return false;
  }
  const [candidateHash, configuredHash] = await Promise.all([
    tokenDigest(candidate),
    tokenDigest(configured),
  ]);
  return crypto.subtle.timingSafeEqual(candidateHash, configuredHash);
}

export async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  const bearer = authorization?.match(/^Bearer (.+)$/i);
  return bearer ? isValidAuthToken(bearer[1], env) : false;
}

/**
 * Marks a request only after the outer Worker has verified its static token.
 * Any client-supplied marker is removed first, so inner route handlers can
 * retain their synchronous early-return shape without comparing a secret.
 */
export async function withVerifiedAuth(request: Request, env: Env): Promise<Request> {
  const verified = await isAuthorized(request, env);
  if (!verified && !request.headers.has(VERIFIED_AUTH_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(VERIFIED_AUTH_HEADER);
  if (verified) headers.set(VERIFIED_AUTH_HEADER, "1");
  return new Request(request, { headers });
}

// Returns a 401 Response if the request lacks a valid token, otherwise null —
// lets routes early-return with `const authErr = requireAuth(...); if (authErr) return authErr;`
export function requireAuth(request: Request, _env: Env): Response | null {
  if (request.headers.get(VERIFIED_AUTH_HEADER) === "1") return null;
  return json({ ok: false, error: "Unauthorized", code: "invalid_token" }, 401);
}

// Anchored so the whole value has to be an integer. parseInt stops at the first
// character it cannot use, which is how "7abc" became 7, "1e3" became 1 and
// "0x10" became 0 — each of them a value the caller never wrote, accepted
// silently. Whatever it could not salvage became NaN, and NaN survives every
// Math.min/Math.max clamp, so the bad value reached the database: bound as a
// LIMIT it is a D1 SQLITE_MISMATCH (an HTTP 500), and compared against
// created_at it matches nothing, so a malformed date filter reads to the caller
// as an empty brain rather than a bad request.
const INTEGER = /^[+-]?\d+$/;

/**
 * Reads an integer query parameter, or returns the 400 to send back.
 *
 * Malformed is rejected rather than defaulted, which is how every other bad
 * value on this surface is already treated (an unknown `type`, `status` or
 * `action` is a 400, as is any bad value on the config write path) and how the
 * MCP twins of these routes behave, since zod rejects a non-integer outright.
 * `after` and `before` have no default to fall back to either — defaulting them
 * would drop the filter and answer with more rows than were asked for, which is
 * wrong data wearing a 200, the one failure a caller cannot detect.
 *
 * Out of range is still clamped, not rejected: `?n=200` means "as many as
 * you'll give me" and has always been answered with 100.
 *
 * Only an absent parameter gets the default. A present one must parse, and that
 * includes the empty forms `?after=` and `?after` — for the same reason as
 * above, since defaulting them drops the filter. It also means `?n=$UNSET` from
 * a shell says so instead of quietly becoming 20. This is a deliberate
 * divergence from the string parameters beside these, where `?tag=` reads as
 * absent: an empty tag filter has one obvious meaning, an empty timestamp does
 * not.
 *
 * Used as `const n = intParam(url, "n", …); if (n instanceof Response) return n;`
 * — the same early-return shape as requireAuth above.
 */
export function intParam(url: URL, name: string, opts: { fallback: number; min?: number; max?: number }): number | Response;
export function intParam(url: URL, name: string, opts?: { min?: number; max?: number }): number | undefined | Response;
export function intParam(
  url: URL,
  name: string,
  opts: { fallback?: number; min?: number; max?: number } = {},
): number | undefined | Response {
  const raw = url.searchParams.get(name);
  if (raw === null) return opts.fallback;

  // An empty value falls through to the check below and is rejected: it is
  // present, so it has to parse.
  const text = raw.trim();
  const value = Number(text);
  if (!INTEGER.test(text) || !Number.isSafeInteger(value)) {
    return json({ ok: false, error: `${name} must be an integer` }, 400);
  }

  const floored = opts.min === undefined ? value : Math.max(opts.min, value);
  return opts.max === undefined ? floored : Math.min(opts.max, floored);
}
