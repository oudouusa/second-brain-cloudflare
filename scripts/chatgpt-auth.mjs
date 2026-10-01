#!/usr/bin/env node
// ChatGPTの初回認証だけをローカルで行い、更新の所有権をWorkerへ移す。
import { createServer } from "node:http";
import { randomBytes, randomUUID, createHash, createPublicKey, verify } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink, readdir, chmod, stat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

class CliError extends Error {}

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const ROOT = join(homedir(), ".config", "second-brain-cf");
const USAGE_URL = "https://chatgpt.com/settings/usage";
const SAFE_CODES = new Set(["invalid_credentials", "scope_not_granted", "not_connected", "refresh_in_progress", "reauth_required",
  "credential_key_missing", "credential_key_invalid", "credentials_unreadable", "personal_scope_required",
  "model_not_allowlisted", "subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable",
  "subscription_sharing_user_not_eligible", "owner_unavailable", "invalid_request", "upstream_error", "session_changed"]);

export async function boundedJson(response, limit = 128 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) throw new CliError("Response body is missing");
  let bytes = 0, raw = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new CliError("Response exceeds the size limit");
      raw += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(raw + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function verifyIdentity(token, keys, clientId, nonce) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new CliError("Invalid ID token");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  const jwk = keys.find(key => key.kid === header.kid && key.kty === "RSA"
    && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
  const now = Date.now() / 1000;
  if (header.alg !== "RS256" || !jwk || !verify("RSA-SHA256", Buffer.from(parts.slice(0, 2).join(".")),
    createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"))
    || claims.iss !== ISSUER || !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(clientId)
    || !Number.isFinite(claims.exp) || claims.exp <= now - 5
    || !Number.isFinite(claims.iat) || claims.iat > now + 5
    || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 5))
    || typeof claims.sub !== "string" || !claims.sub || claims.nonce !== nonce) {
    throw new CliError("ID token verification failed");
  }
  return claims;
}

// Workerごと、registrationごとに分離する。未選択の接続の資格情報を上書きしない。
export function paths(options) {
  const base = workerUrl(options);
  const profile = options.profile || "default";
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(profile)) throw new CliError("Use lowercase letters, numbers, underscores or hyphens for --profile");
  const host = createHash("sha256").update(base.origin).digest("hex");
  const dir = join(options["config-dir"] || ROOT, "hosts", host, "profiles", profile);
  return { dir, registration: join(dir, "registration.json"), credentials: join(dir, "pending.json"), origin: base.origin, profile };
}
export function workerUrl(options) {
  if (!options["worker-url"]) throw new CliError("Specify your Worker URL with --worker-url");
  const base = new URL(options["worker-url"]);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new CliError("Use an HTTPS Worker URL without credentials, a query, a fragment or a path");
  }
  return base;
}
async function save(path, value) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  try { await rename(temp, path); }
  finally { await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
async function load(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function ownerToken(options) {
  const path = options["auth-token-file"];
  if (!path) throw new CliError("Specify the owner token file with --auth-token-file");
  const info = await stat(path);
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077))) {
    throw new CliError("Restrict owner token file permissions to the owner (0600)");
  }
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new CliError("The owner token file is empty");
  return value;
}
export async function workerRequest(options, suffix, method = "GET", body) {
  const url = new URL(`/admin/chatgpt/${suffix}`, workerUrl(options));
  const response = await fetch(url, { method, redirect: "error", cache: "no-store",
    headers: { Authorization: `Bearer ${await ownerToken(options)}`, "Content-Type": "application/json", "User-Agent": "SecondBrainCF-OAuth/1.0", Accept: "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
  const result = await boundedJson(response);
  if (!response.ok || result.ok !== true) {
    const code = SAFE_CODES.has(result.code) ? result.code : "unknown";
    throw new CliError(`Worker rejected the request: HTTP ${response.status}, ${code}. Check the connection with status. Manage usage: ${USAGE_URL}`);
  }
  return result;
}
function displayStatus(result) {
  return { connected: result.connected, state: result.state, account: result.account ? { client_id: result.account.client_id, subject: result.account.subject, email: result.account.email, name: result.account.name } : undefined,
    expires_at: result.expires_at, host_id: result.host_id, owner_workspace_id: result.owner_workspace_id,
    configured_workspace_id: result.configured_workspace_id, operations: result.operations, usage_url: USAGE_URL };
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

async function login(options) {
  const location = paths(options);
  const REGISTRATION = location.registration, CREDENTIALS = location.credentials;
  const host = await workerRequest(options, "status");
  if (typeof host.host_id !== "string" || !host.host_id.startsWith("urn:uuid:")) throw new CliError("Could not obtain the Worker host ID");
  if (await load(CREDENTIALS)) throw new CliError("Pending credentials exist. Run import first");
  let registration = await load(REGISTRATION);
  registration ??= {};
  registration = { ...registration, ext_agent_host_id: host.host_id };
  await save(REGISTRATION, registration);
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let complete, fail, consumed = false;
  const callback = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  let authorizeUrl;
  const startPath = `/auth/start/${state}`;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    if (req.method === "GET" && url.pathname === startPath && authorizeUrl) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      res.end(`<html lang="en"><meta charset="utf-8"><title>Second Brain: Connect ChatGPT</title><h1>Connect ChatGPT</h1><p>Destination: ${escapeHtml(location.origin)} / ${escapeHtml(location.profile)}</p><p>Only operations you explicitly enable after connecting will use the owner's ChatGPT plan. Team and member operations are excluded.</p><p><a href="${escapeHtml(authorizeUrl.href)}" rel="noreferrer">Continue with ChatGPT</a></p><p><a href="${USAGE_URL}" rel="noreferrer">Manage usage</a></p></html>`);
      return;
    }
    if (req.method !== "GET" || url.pathname !== "/auth/callback") { res.writeHead(404).end(); return; }
    if (consumed || url.searchParams.get("state") !== state) { res.writeHead(400).end("Authentication state does not match"); return; }
    consumed = true;
    const clientId = url.searchParams.get("client_id") || registration.client_id;
    if (url.searchParams.has("error") || !url.searchParams.get("code") || !clientId
      || clientId === "dynamic_agent_client" || (registration.client_id && clientId !== registration.client_id)) {
      res.writeHead(400).end("Could not complete authentication"); fail(new CliError("Authentication was rejected")); return;
    }
    res.end("Authentication received. You can close this page.");
    complete({ code: url.searchParams.get("code"), clientId });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(Number(options.port || 1455), "127.0.0.1", resolve); });
  const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
  const timeout = setTimeout(() => fail(new CliError("Authentication timed out")), 15 * 60_000);
  try {
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    url.search = new URLSearchParams({ client_id: registration.client_id || "dynamic_agent_client",
      ...(!registration.client_id ? { agent_name_hint: "Second Brain CF" } : {}),
      ext_agent_host_id: registration.ext_agent_host_id, response_type: "code", redirect_uri: redirectUri,
      scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge: challenge, code_challenge_method: "S256" }).toString();
    if (registration.id_token_hint) url.searchParams.set("id_token_hint", registration.id_token_hint);
    if (registration.email) url.searchParams.set("login_hint", registration.email);
    if (options.consent) url.searchParams.set("prompt", "consent");
    authorizeUrl = url;
    // id_token_hintを含むOpenAIのURLはterminal・ログ・引数に出さない。
    console.log(`Open in a browser on this device: http://127.0.0.1:${server.address().port}${startPath}`);
    const { code, clientId } = await callback;
    registration = { ...registration, client_id: clientId };
    await save(REGISTRATION, registration);
    const response = await fetch(`${ISSUER}/api/accounts/oauth/token`, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code,
        code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) { await response.body?.cancel(); throw new CliError(`Token exchange failed: HTTP ${response.status}`); }
    const tokens = await boundedJson(response);
    const jwksResponse = await fetch(`${ISSUER}/.well-known/jwks.json`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!jwksResponse.ok) throw new CliError("Could not retrieve signing keys");
    const jwks = await boundedJson(jwksResponse);
    const identity = verifyIdentity(tokens.id_token, jwks.keys, clientId, nonce);
    if (registration.subject && registration.subject !== identity.sub) throw new CliError("The ChatGPT account differs from the previous registration");
    await save(REGISTRATION, { ...registration, subject: identity.sub, email: identity.email, name: identity.name, id_token_hint: tokens.id_token });
    const scopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/) : [];
    if (!scopes.includes("chatgpt.tokens.use.direct") || !scopes.includes("offline_access") || !scopes.includes("resource.invoke")
      || typeof tokens.access_token !== "string" || !tokens.access_token
      || typeof tokens.refresh_token !== "string" || !tokens.refresh_token
      || tokens.token_type?.toLowerCase() !== "bearer" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
      throw new CliError("ChatGPT plan usage was not authorized");
    }
    await save(CREDENTIALS, { ...tokens, ...registration, nonce, worker_origin: location.origin, saved_at: new Date().toISOString() });
    console.log(`Authenticated (${location.profile}). Credentials saved in an owner-only file. Run import with the same Worker and profile. Manage usage: ${USAGE_URL}`);
  } finally {
    clearTimeout(timeout);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

export async function main(args = process.argv.slice(2)) {
  const command = args.shift();
  const options = {};
  const allowed = new Set(["port", "model", "worker-url", "auth-token-file", "profile", "config-dir", "consent", "operations"]);
  while (args.length) {
    const key = args.shift();
    if (!key.startsWith("--") || !allowed.has(key.slice(2)) || options[key.slice(2)] !== undefined) throw new CliError("Invalid argument");
    if (key === "--consent") { options.consent = true; continue; }
    if (!args.length || args[0].startsWith("--")) throw new CliError("Argument value is missing");
    options[key.slice(2)] = args.shift();
  }
  if (!["login", "import", "status", "profiles", "models", "probe", "disconnect", "enable"].includes(command)) {
    console.log("Usage: node scripts/chatgpt-auth.mjs login|import|status|profiles|models|probe|disconnect|enable --worker-url https://your-worker.example --auth-token-file path [--profile default] [--port 1455] [--model slug] [--consent] [--operations answer] [--config-dir path]");
    return;
  }
  const location = paths(options);
  if (!["login", "import", "disconnect"].includes(command)) return runCommand(command, options, location);
  // 同じregistrationの並行認証・転送で、client/subjectやpendingを取り違えない。
  await mkdir(location.dir, { recursive: true, mode: 0o700 });
  const lockPath = join(location.dir, "operation.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new CliError("This profile is busy. After a forced exit, follow the recovery instructions for operation.lock");
    throw error;
  }
  try { return await runCommand(command, options, location); }
  finally { await lock.close(); await unlink(lockPath); }
}
async function runCommand(command, options, location) {
  if (command === "login") return login(options);
  if (command === "profiles") {
    const parent = join(location.dir, "..");
    let names;
    try { names = await readdir(parent); } catch (error) { if (error.code !== "ENOENT") throw error; names = []; }
    const profiles = [];
    for (const name of names.sort()) {
      const saved = await load(join(parent, name, "registration.json"));
      if (saved) profiles.push({ profile: name, client_id: saved.client_id, email: saved.email, name: saved.name });
    }
    console.log(JSON.stringify({ profiles })); return;
  }
  if (command === "import") {
    const credentials = await load(location.credentials);
    if (!credentials) throw new CliError("Run login with the same Worker and profile first");
    if (credentials.worker_origin !== location.origin) throw new CliError("Credential destination does not match");
    const result = await workerRequest(options, "session", "PUT", credentials);
    if (result.connected !== true) throw new CliError("Could not confirm credential storage on the Worker");
    await unlink(location.credentials);
    console.log("Connected. Only the Worker will refresh credentials. Check status and explicitly enable the operations you want to use."); return;
  }
  if (command === "status") { console.log(JSON.stringify(displayStatus(await workerRequest(options, command)))); return; }
  if (command === "models") {
    const result = await workerRequest(options, command);
    console.log(JSON.stringify({ models: result.models })); return;
  }
  if (command === "enable") {
    const status = await workerRequest(options, "status");
    if (!status.connected || !status.owner_workspace_id) throw new CliError("Complete login, then import, first");
    const model = options.model || "gpt-5.6-luna";
    if (!["gpt-5.6-luna", "gpt-5.6-terra"].includes(model)) throw new CliError("This model has not been evaluated for storage quality. Choose Luna or Terra");
    const result = await workerRequest(options, "models");
    const supported = new Set(["classify", "query-tags", "smart-merge", "contradiction", "recall-summary", "digest", "answer", "weekly-insight"]);
    const operations = (options.operations || "answer").split(",").map(value => value.trim());
    if (!operations.length || operations.some(value => !supported.has(value))) throw new CliError("Specify supported operations with --operations");
    const decisions = new Set(["smart-merge", "contradiction", "digest", "weekly-insight"]);
    const requiredModels = new Set(operations.map(op => decisions.has(op) ? "gpt-5.6-terra" : model));
    if (!result.models || ![...requiredModels].every(slug => result.models.some(m => m.slug === slug))) throw new CliError("A required model is unavailable for this account");
    // これは配備設定の候補。自動的に有効化・配備・推論しない。
    console.log(JSON.stringify({ vars: { CHATGPT_MODEL: model, CHATGPT_OWNER_WORKSPACE_ID: status.owner_workspace_id,
      CHATGPT_OPERATIONS: [...new Set(operations)].join(",") }, usage_url: USAGE_URL }, null, 2)); return;
  }
  if (command === "probe") {
    const result = await workerRequest(options, "probe", "POST", { model: options.model || "gpt-5.6-luna" });
    console.log(JSON.stringify({ completed: result.completed, matched: result.matched, model: result.model, latency_ms: result.latency_ms, usage_url: USAGE_URL })); return;
  }
  if (command === "disconnect") {
    const saved = await load(location.registration);
    const status = await workerRequest(options, "status");
    if (status.state !== "disconnected" && (!saved?.client_id || saved.client_id !== status.account?.client_id)) {
      throw new CliError("The selected profile differs from the connected Worker account. Check status and profiles");
    }
    const result = await workerRequest(options, "session", "DELETE", saved?.client_id ? { client_id: saved.client_id } : undefined);
    if (saved) { delete saved.id_token_hint; await save(location.registration, saved); }
    await unlink(location.credentials).catch(error => { if (error.code !== "ENOENT") throw error; });
    console.log(JSON.stringify({ revoked: result.revoked, usage_url: USAGE_URL })); return;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // こちらで構築した操作エラーだけを示す。fetch/JSON/暗号・filesystemの外部診断は表示しない。
    const safe = error instanceof CliError ? error.message : "Operation failed. Check status and, if needed, authenticate again with login, then import.";
    console.error(safe); process.exitCode = 1;
  });
}
