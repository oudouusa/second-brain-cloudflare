import type { Env } from "../env";
import { readBoundedBytes } from "./body";

type AccessConfig = { issuer: string; audience: string; email: string };
type AccessJwk = JsonWebKey & { kid?: string; alg?: string; use?: string; key_ops?: string[] };
let accessJwks: { issuer: string; expires: number; keys: AccessJwk[] } | undefined;

function base64UrlBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), c => c.charCodeAt(0));
}

function jwtObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(new TextDecoder().decode(base64UrlBytes(value))) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid JWT");
  return parsed as Record<string, unknown>;
}

function cloudflareAccessConfig(env: Env, url: URL): AccessConfig | null {
  let team: URL;
  try { team = new URL(env.ACCESS_TEAM_DOMAIN ?? ""); } catch { return null; }
  const audience = (url.pathname.startsWith("/dashboard") ? env.DASHBOARD_ACCESS_AUD : env.ACCESS_AUD)?.trim() ?? "", email = env.ACCESS_ALLOWED_EMAIL?.trim().toLowerCase() ?? "";
  if (
    team.protocol !== "https:" || !team.hostname.endsWith(".cloudflareaccess.com")
    || team.username || team.password || team.port || team.pathname !== "/" || team.search || team.hash
    || !audience || audience.length > 512 || /\s|[\u0000-\u001f\u007f]/.test(audience)
    || !email.includes("@") || email.length > 320 || /[\u0000-\u001f\u007f]/.test(email)
  ) return null;
  return { issuer: team.origin, audience, email };
}

async function cloudflareAccessKeys(issuer: string, refresh = false): Promise<AccessJwk[]> {
  const now = Date.now();
  if (!refresh && accessJwks?.issuer === issuer && accessJwks.expires > now) return accessJwks.keys;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Access JWKS unavailable");
    const body = await readBoundedBytes(response.body, response.headers.get("Content-Length"), 64 * 1024);
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { keys?: unknown };
    if (!Array.isArray(parsed.keys) || parsed.keys.length === 0 || parsed.keys.length > 10) {
      throw new Error("Invalid Access JWKS");
    }
    const keys = parsed.keys.filter((key): key is AccessJwk => Boolean(key) && typeof key === "object");
    if (keys.length !== parsed.keys.length) throw new Error("Invalid Access JWKS");
    accessJwks = { issuer, expires: now + 5 * 60_000, keys };
    return keys;
  } finally {
    clearTimeout(timeout);
  }
}

function accessSigningKey(keys: AccessJwk[], kid: string): AccessJwk | undefined {
  return keys.find(key => key.kid === kid
    && key.kty === "RSA"
    && (!key.alg || key.alg === "RS256")
    && (!key.use || key.use === "sig")
    && (!key.key_ops || key.key_ops.includes("verify")));
}

/** Returns null only for a valid Access application token belonging to the owner. */
export async function verifyCloudflareAccess(request: Request, env: Env): Promise<403 | 503 | null> {
  const config = cloudflareAccessConfig(env, new URL(request.url));
  if (!config) return 503;
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion || assertion.length > 16 * 1024) return 403;
  try {
    const parts = assertion.split(".");
    if (parts.length !== 3 || parts.some(part => !part)) return 403;
    const header = jwtObject(parts[0]);
    const payload = jwtObject(parts[1]);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return 403;
    let keys = await cloudflareAccessKeys(config.issuer);
    let jwk = accessSigningKey(keys, header.kid);
    if (!jwk) {
      keys = await cloudflareAccessKeys(config.issuer, true);
      jwk = accessSigningKey(keys, header.kid);
    }
    if (!jwk) return 403;
    const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    const key = await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
    const valid = await crypto.subtle.verify(
      algorithm.name,
      key,
      base64UrlBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    const now = Date.now() / 1_000;
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    const subject = typeof payload.sub === "string" ? payload.sub : "";
    return valid
      && payload.iss === config.issuer
      && audience.includes(config.audience)
      && payload.type === "app"
      && email === config.email
      && typeof payload.exp === "number" && payload.exp > now
      && (payload.nbf === undefined || typeof payload.nbf === "number" && payload.nbf <= now)
      && subject.length > 0 && subject.length <= 512 && !/[\u0000-\u001f\u007f]/.test(subject)
      ? null : 403;
  } catch {
    return 403;
  }
}
