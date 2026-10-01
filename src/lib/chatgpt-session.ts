import type { Env } from "../env";
import { cancelBody, readBoundedResponseText } from "./body";
import { resolveIdentityFromToken } from "./identity";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const MAX_JSON_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const AAD = encoder.encode("second-brain-cf:chatgpt-session:v1");

export class ChatGptError extends Error {
  constructor(readonly code: string, readonly upstreamStatus?: number) {
    super(`ChatGPT接続に失敗しました: ${code}`);
    this.name = "ChatGptError";
  }
}
export interface ChatGptSession {
  client_id: string;
  ext_agent_host_id: string;
  subject: string;
  id_token: string;
  access_token: string;
  refresh_token: string;
  scope: string;
  expires_at: number;
  earliest_refresh_at: number;
  owner_workspace_id?: string;
  account?: { client_id: string; subject: string; email?: string; name?: string };
}
interface SessionRow { cipher: string; revision: string; state: string; changed_at: number }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChatGptError("invalid_response");
  return value as Record<string, unknown>;
}
function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 32_768) throw new ChatGptError("invalid_credentials");
  return value;
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), ch => ch.charCodeAt(0));
}
function base64(value: Uint8Array): string { return btoa(String.fromCharCode(...value)); }

export async function readChatGptJson(response: Response, limit = MAX_JSON_BYTES): Promise<Record<string, unknown>> {
  try { return object(JSON.parse(await readBoundedResponseText(response, limit))); }
  catch { throw new ChatGptError("invalid_response", response.status); }
}
// 外部の任意のエラー文・codeをログや応答に転記しない。
const UPSTREAM_CODES = new Set(["subscription_sharing_user_not_eligible", "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_usage_unavailable", "subscription_sharing_unsupported_capability", "subscription_sharing_route_not_supported",
  "subscription_sharing_invalid_user", "subscription_sharing_user_unavailable", "chatpass_v2_invalid_authorization_context",
  "usage_unavailable", "unsupported_capability", "route_not_supported", "invalid_user",
  "chatpass_v2_scope_not_authorized", "invalid_authorization_context", "user_unavailable",
  "invalid_grant", "invalid_refresh_token", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused",
  "token_expired", "refresh_token_expired_or_invalidated"]);
export function chatGptUpstreamCode(value: unknown): string {
  try {
    const root = object(value);
    const code = typeof root.error === "string" ? root.error : object(root.error).code;
    return typeof code === "string" && UPSTREAM_CODES.has(code) ? code : "upstream_error";
  } catch { return "upstream_error"; }
}
export async function checkChatGptResponse(response: Response): Promise<void> {
  if (response.ok) return;
  let code = "upstream_error";
  try { code = chatGptUpstreamCode(await readChatGptJson(response)); } catch { cancelBody(response.body); }
  throw new ChatGptError(code, response.status);
}

async function credentialKey(env: Env): Promise<CryptoKey> {
  if (!env.CHATGPT_CREDENTIAL_KEY) throw new ChatGptError("credential_key_missing");
  try {
    const raw = bytes(env.CHATGPT_CREDENTIAL_KEY);
    if (raw.length !== 32) throw new Error();
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch { throw new ChatGptError("credential_key_invalid"); }
}
async function seal(env: Env, session: ChatGptSession): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD },
    await credentialKey(env), encoder.encode(JSON.stringify(session))));
  return `v1.${base64(iv)}.${base64(encrypted)}`;
}
async function unseal(env: Env, cipher: string): Promise<ChatGptSession> {
  try {
    const [version, iv, data, extra] = cipher.split(".");
    if (version !== "v1" || extra !== undefined || bytes(iv).length !== 12) throw new Error();
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(iv), additionalData: AAD },
      await credentialKey(env), bytes(data)))) as ChatGptSession;
  } catch (error) {
    if (error instanceof ChatGptError) throw error;
    throw new ChatGptError("credentials_unreadable");
  }
}

async function signingKeys(): Promise<Record<string, unknown>[]> {
  let response: Response;
  try { response = await fetch(`${ISSUER}/.well-known/jwks.json`, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(10_000) }); }
  catch { throw new ChatGptError("signing_keys_unavailable"); }
  await checkChatGptResponse(response);
  const { keys } = await readChatGptJson(response);
  if (!Array.isArray(keys) || !keys.length || keys.length > 32) throw new ChatGptError("invalid_signing_keys");
  return keys.map(object);
}
async function verifyToken(token: string, keys: Record<string, unknown>[], audience: string): Promise<Record<string, unknown>> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error();
    const header = object(JSON.parse(new TextDecoder().decode(bytes(parts[0]))));
    const claims = object(JSON.parse(new TextDecoder().decode(bytes(parts[1]))));
    const jwk = keys.find(key => typeof header.kid === "string" && key.kid === header.kid && key.kty === "RSA"
      && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig")
      && (!key.key_ops || (Array.isArray(key.key_ops) && key.key_ops.includes("verify"))));
    if (header.alg !== "RS256" || !jwk) throw new Error();
    if (typeof jwk.n !== "string" || typeof jwk.e !== "string") throw new Error();
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const now = Date.now() / 1000;
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, bytes(parts[2]), encoder.encode(parts.slice(0, 2).join(".")))
      || claims.iss !== ISSUER || !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience)
      || typeof claims.exp !== "number" || claims.exp <= now - 5
      || typeof claims.iat !== "number" || claims.iat > now + 5
      || (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + 5))
      || typeof claims.sub !== "string" || !claims.sub) throw new Error();
    return claims;
  } catch { throw new ChatGptError("invalid_credentials"); }
}
function grant(claims: Record<string, unknown>, clientId: string, subject: string): string {
  const scope = requiredString(claims.scope);
  const scopes = scope.split(/\s+/);
  if (claims.client_id !== clientId || claims.sub !== subject || !scopes.includes("chatgpt.tokens.use.direct")
    || !scopes.includes("resource.invoke") || !scopes.includes("offline_access")) throw new ChatGptError("scope_not_granted");
  return scope;
}
function earliestRefresh(value: unknown): number {
  if (value === undefined) return 0;
  // token endpointはUnix秒。ISO時刻も検証して受け付ける。
  const ms = typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || ms < 0) throw new ChatGptError("invalid_credentials");
  return ms;
}

// Provider管理tableはownerの接続時だけ作る。memory schema/versionには依存しない。
export async function initializeChatGptSession(env: Env): Promise<void> {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS chatgpt_session (
    id INTEGER PRIMARY KEY CHECK (id = 1), cipher TEXT NOT NULL, revision TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ready', 'refreshing', 'reauth')), changed_at INTEGER NOT NULL
  )`).run();
}

/** hostはWorkerに属する。アカウントの追加・切断・端末変更で作り直さない。 */
export async function chatGptHostId(env: Env): Promise<string> {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS chatgpt_host (
    id INTEGER PRIMARY KEY CHECK (id = 1), host_id TEXT NOT NULL
  )`).run();
  await env.DB.prepare("INSERT INTO chatgpt_host (id, host_id) VALUES (1, ?) ON CONFLICT(id) DO NOTHING")
    .bind(`urn:uuid:${crypto.randomUUID()}`).run();
  const row = await env.DB.prepare("SELECT host_id FROM chatgpt_host WHERE id = 1").first<{ host_id: string }>();
  if (!row) throw new ChatGptError("host_unavailable");
  return row.host_id;
}
export async function importChatGptSession(env: Env, input: unknown): Promise<void> {
  const value = object(input);
  const clientId = requiredString(value.client_id);
  if (!clientId.startsWith("oaiapp_") || clientId === "dynamic_agent_client") throw new ChatGptError("invalid_credentials");
  const keys = await signingKeys();
  const identity = await verifyToken(requiredString(value.id_token), keys, clientId);
  if (identity.nonce !== requiredString(value.nonce)) throw new ChatGptError("invalid_credentials");
  const access = await verifyToken(requiredString(value.access_token), keys, RESOURCE);
  const subject = requiredString(identity.sub);
  const hostId = await chatGptHostId(env);
  if (requiredString(value.ext_agent_host_id) !== hostId) throw new ChatGptError("invalid_credentials");
  const owner = await resolveIdentityFromToken(env.AUTH_TOKEN, env);
  if (!owner) throw new ChatGptError("owner_unavailable");
  const display = (value: unknown): string | undefined => typeof value === "string" && value.length <= 200 ? value : undefined;
  const session: ChatGptSession = {
    client_id: clientId, ext_agent_host_id: hostId, subject,
    id_token: requiredString(value.id_token), access_token: requiredString(value.access_token),
    refresh_token: requiredString(value.refresh_token), scope: grant(access, clientId, subject),
    expires_at: Number(access.exp) * 1000, earliest_refresh_at: earliestRefresh(value.earliest_refresh_at),
    owner_workspace_id: owner.personalWorkspaceId,
    account: { client_id: clientId, subject, email: display(identity.email), name: display(identity.name) },
  };
  const cipher = await seal(env, session);
  await initializeChatGptSession(env);
  // 新しい認証grantのimportは、古い更新が進行中でもrevisionを替えて上書きを防ぐ。
  await env.DB.prepare(`INSERT INTO chatgpt_session (id, cipher, revision, state, changed_at) VALUES (1, ?, ?, 'ready', ?)
    ON CONFLICT(id) DO UPDATE SET cipher = excluded.cipher, revision = excluded.revision, state = 'ready', changed_at = excluded.changed_at`)
    .bind(cipher, crypto.randomUUID(), Date.now()).run();
}
async function readRow(env: Env): Promise<SessionRow | null> {
  return env.DB.prepare("SELECT cipher, revision, state, changed_at FROM chatgpt_session WHERE id = 1").first<SessionRow>();
}
export async function chatGptSessionStatus(env: Env): Promise<{
  connected: boolean; state: string; expires_at?: number; host_id: string;
  owner_workspace_id?: string; account?: ChatGptSession["account"];
}> {
  await initializeChatGptSession(env);
  const host_id = await chatGptHostId(env);
  const row = await readRow(env);
  if (!row) return { connected: false, state: "disconnected", host_id };
  const session = await unseal(env, row.cipher);
  return { connected: row.state === "ready", state: row.state, expires_at: session.expires_at,
    host_id, owner_workspace_id: session.owner_workspace_id, account: session.account };
}

/** D1の条件付きUPDATEでMCP・夜間・RESTを横断して更新を排他する。 */
export async function chatGptAccessToken(env: Env, workspaceId?: string): Promise<string> {
  const row = await readRow(env);
  if (!row) throw new ChatGptError("not_connected");
  if (row.state !== "ready") throw new ChatGptError(row.state === "refreshing" ? "refresh_in_progress" : "reauth_required");
  const session = await unseal(env, row.cipher);
  if (workspaceId !== undefined && (!session.owner_workspace_id || session.owner_workspace_id !== workspaceId)) {
    throw new ChatGptError("personal_scope_required");
  }
  const now = Date.now();
  if (session.expires_at > now + 60_000 || (session.earliest_refresh_at > now && session.expires_at > now + 5_000)) return session.access_token;
  if (session.earliest_refresh_at > now) throw new ChatGptError("refresh_not_yet_allowed");
  const locked = await env.DB.prepare("UPDATE chatgpt_session SET state = 'refreshing', changed_at = ? WHERE id = 1 AND revision = ? AND state = 'ready'")
    .bind(now, row.revision).run();
  if (locked.meta.changes !== 1) throw new ChatGptError("refresh_in_progress");
  let tokenAccepted = false;
  try {
    const response = await fetch(`${ISSUER}/api/accounts/oauth/token`, { method: "POST", redirect: "manual", cache: "no-store",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: session.client_id, refresh_token: session.refresh_token, resource: RESOURCE }),
      signal: AbortSignal.timeout(15_000) });
    await checkChatGptResponse(response);
    tokenAccepted = true;
    const value = await readChatGptJson(response);
    const accessToken = requiredString(value.access_token);
    const keys = await signingKeys();
    const access = await verifyToken(accessToken, keys, RESOURCE);
    const next = { ...session, access_token: accessToken, refresh_token: requiredString(value.refresh_token),
      scope: grant(access, session.client_id, session.subject), expires_at: Number(access.exp) * 1000,
      earliest_refresh_at: earliestRefresh(value.earliest_refresh_at) };
    if (typeof value.id_token === "string") {
      const identity = await verifyToken(value.id_token, keys, session.client_id);
      if (identity.sub !== session.subject) throw new ChatGptError("invalid_credentials");
      next.id_token = value.id_token;
    }
    const updated = await env.DB.prepare("UPDATE chatgpt_session SET cipher = ?, revision = ?, state = 'ready', changed_at = ? WHERE id = 1 AND revision = ? AND state = 'refreshing'")
      .bind(await seal(env, next), crypto.randomUUID(), Date.now(), row.revision).run();
    if (updated.meta.changes !== 1) throw new ChatGptError("session_changed");
    return next.access_token;
  } catch (error) {
    // 応答消失・中断後に古いrefresh tokenを再送しない。明示的な5xx拒否だけは再試行可能。
    const retryable = !tokenAccepted && error instanceof ChatGptError && error.upstreamStatus !== undefined && error.upstreamStatus >= 500;
    await env.DB.prepare("UPDATE chatgpt_session SET state = ?, changed_at = ? WHERE id = 1 AND revision = ? AND state = 'refreshing'")
      .bind(retryable ? "ready" : "reauth", Date.now(), row.revision).run();
    throw error instanceof ChatGptError ? error : new ChatGptError("reauth_required");
  }
}

export async function disconnectChatGptSession(env: Env, expectedClientId?: string): Promise<{ revoked: boolean }> {
  await initializeChatGptSession(env);
  const row = await readRow(env);
  if (!row) return { revoked: true };
  if (row.state === "refreshing") throw new ChatGptError("refresh_in_progress");
  const session = await unseal(env, row.cipher);
  if (expectedClientId !== undefined && session.client_id !== expectedClientId) throw new ChatGptError("session_changed");
  const locked = await env.DB.prepare("UPDATE chatgpt_session SET state = 'reauth' WHERE id = 1 AND revision = ? AND state != 'refreshing'")
    .bind(row.revision).run();
  if (locked.meta.changes !== 1) throw new ChatGptError("session_changed");
  let revoked = false;
  try {
    const discovery = await fetch(`${ISSUER}/.well-known/openid-configuration`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    await checkChatGptResponse(discovery);
    const endpoint = new URL(requiredString((await readChatGptJson(discovery)).revocation_endpoint));
    if (endpoint.origin !== ISSUER || endpoint.username || endpoint.password) throw new ChatGptError("invalid_revocation_endpoint");
    const response = await fetch(endpoint, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: session.client_id, token: session.refresh_token, token_type_hint: "refresh_token" }) });
    revoked = response.status === 200;
    cancelBody(response.body);
  } catch { /* ローカル切断を完了し、remote失効の未確認を返す。 */ }
  await env.DB.prepare("DELETE FROM chatgpt_session WHERE id = 1 AND revision = ?").bind(row.revision).run();
  return { revoked };
}
