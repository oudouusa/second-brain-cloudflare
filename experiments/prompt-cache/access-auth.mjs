import { execFileSync } from "node:child_process";

const MAX_ACCESS_TOKEN_BYTES = 16 * 1024;
const ACCESS_TOKEN_TIMEOUT_MS = 30_000;
const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export class CapsuleAccessError extends Error {
  constructor(code) {
    super(`Cloudflare Access authentication failed: ${code}`);
    this.name = "CapsuleAccessError";
    this.code = code;
  }
}

function safeApplicationUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new TypeError(`${label} must use HTTPS (HTTP is allowed only for localhost)`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError(`${label} must not contain credentials, query parameters, or a fragment`);
  }
  return url;
}

export function accessApplicationUrl({ workerUrl, accessAppUrl } = {}) {
  const worker = safeApplicationUrl(workerUrl, "workerUrl");
  const app = accessAppUrl
    ? safeApplicationUrl(accessAppUrl, "accessAppUrl")
    : new URL("/dashboard", worker);
  if (app.origin !== worker.origin) {
    throw new TypeError("accessAppUrl must use the same origin as workerUrl");
  }
  return app;
}

function validatedAccessToken(value) {
  if (typeof value !== "string") throw new CapsuleAccessError("invalid_access_token");
  const token = value.trim();
  if (!token
    || Buffer.byteLength(token, "utf8") > MAX_ACCESS_TOKEN_BYTES
    || /[\r\n]/.test(token)
    || !COMPACT_JWT.test(token)) {
    throw new CapsuleAccessError("invalid_access_token");
  }
  return token;
}

/**
 * Resolve one short-lived user Access JWT from cloudflared's existing login
 * cache. The command is executed directly (never through a shell), and neither
 * stdout nor stderr is copied into an error or operational descriptor.
 */
export function resolveCloudflareAccessToken({
  workerUrl,
  accessAppUrl,
  environment = process.env,
  execFileSyncImpl = execFileSync,
} = {}) {
  const app = accessApplicationUrl({ workerUrl, accessAppUrl });
  const binary = typeof environment.CLOUDFLARED_BIN === "string" && environment.CLOUDFLARED_BIN.trim()
    ? environment.CLOUDFLARED_BIN.trim()
    : "cloudflared";
  if (/[\r\n\0]/.test(binary)) throw new CapsuleAccessError("invalid_cloudflared_binary");

  let stdout;
  try {
    stdout = execFileSyncImpl(binary, ["access", "token", "--app", app.toString()], {
      encoding: "utf8",
      timeout: ACCESS_TOKEN_TIMEOUT_MS,
      maxBuffer: MAX_ACCESS_TOKEN_BYTES + 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: environment,
    });
  } catch {
    throw new CapsuleAccessError("access_token_unavailable");
  }
  return validatedAccessToken(stdout);
}
