import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PROMPT_CAPSULE_SCHEMA = "prompt-capsule.v1";
export const PROMPT_CAPSULE_MIME = "application/vnd.second-brain.prompt-capsule+json";
export const SECOND_BRAIN_AUTH_TOKEN_ENV = "SECOND_BRAIN_AUTH_TOKEN";
export const CAPSULE_SOURCE_AUTH_MODES = new Set(["bearer", "access", "mcp-oauth"]);
export const CAPSULE_REST_AUTH_MODES = new Set(["bearer", "access"]);

const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export class CapsuleSourceError extends Error {
  constructor(code, status) {
    super(`Prompt capsule source failed: ${code}`);
    this.name = "CapsuleSourceError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function assertKind(kind) {
  if (kind !== "core" && kind !== "project") throw new TypeError('kind must be "core" or "project"');
}

function assertAuthMode(authMode) {
  if (!CAPSULE_REST_AUTH_MODES.has(authMode)) {
    throw new TypeError('authMode must be "bearer" or "access"');
  }
}

function safeBaseUrl(workerUrl) {
  let url;
  try {
    url = new URL(workerUrl);
  } catch {
    throw new TypeError("workerUrl must be an absolute URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new TypeError("workerUrl must use HTTPS (HTTP is allowed only for localhost)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("workerUrl must not contain credentials, query parameters, or a fragment");
  }
  return url;
}

function validTeam(team) {
  return typeof team === "string"
    && team.length > 0
    && team.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(team);
}

export function capsuleEndpoint({
  workerUrl,
  kind,
  projectId,
  workspace = "personal",
  team,
  authMode = "bearer",
}) {
  assertKind(kind);
  assertAuthMode(authMode);
  if (workspace !== "personal" && workspace !== "company") {
    throw new TypeError('workspace must be "personal" or "company"');
  }
  if (kind === "project" && !PROJECT_ID.test(projectId ?? "")) {
    throw new TypeError("projectId must be a lowercase opaque id of at most 64 characters");
  }
  if (team !== undefined && team !== null && !validTeam(team)) {
    throw new TypeError("team must be a non-empty identifier of at most 128 characters");
  }
  if (team && workspace !== "company") {
    throw new TypeError("team is valid only with workspace=company");
  }

  const url = safeBaseUrl(workerUrl);
  const prefix = url.pathname.replace(/\/+$/, "");
  const trustedPrefix = authMode === "access" ? "/dashboard/api" : "";
  url.pathname = kind === "core"
    ? `${prefix}${trustedPrefix}/prompt-capsules/core`
    : `${prefix}${trustedPrefix}/prompt-capsules/projects/${encodeURIComponent(projectId)}`;
  url.searchParams.set("workspace", workspace);
  if (team) url.searchParams.set("team", team);
  return url;
}

async function readBoundedText(response) {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new CapsuleSourceError("response_too_large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CapsuleSourceError("response_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function validateResponseTarget(root, { kind, projectId, workspace, team }) {
  if (kind === "project") {
    if (typeof root.project_id !== "string" || !PROJECT_ID.test(root.project_id)) {
      throw new CapsuleSourceError("invalid_payload");
    }
    if (projectId !== undefined && root.project_id !== projectId) {
      throw new CapsuleSourceError("target_mismatch");
    }
  } else if (root.project_id !== undefined) {
    throw new CapsuleSourceError("invalid_payload");
  }

  if (root.workspace !== "personal" && root.workspace !== "company") {
    throw new CapsuleSourceError("invalid_payload");
  }
  if (root.workspace === "personal") {
    if (root.team !== null) throw new CapsuleSourceError("invalid_payload");
  } else if (!validTeam(root.team)) {
    throw new CapsuleSourceError("invalid_payload");
  }

  if (workspace !== undefined && root.workspace !== workspace) {
    throw new CapsuleSourceError("target_mismatch");
  }
  if (team !== undefined && team !== null && root.team !== team) {
    throw new CapsuleSourceError("target_mismatch");
  }
}

export function validateCapsulePayload(payload, {
  kind,
  projectId,
  workspace,
  team,
  allowIncomplete = false,
} = {}) {
  assertKind(kind);
  const root = asRecord(payload);
  if (!root || root.ok !== true || root.schema !== PROMPT_CAPSULE_SCHEMA || root.kind !== kind) {
    throw new CapsuleSourceError("invalid_payload");
  }
  validateResponseTarget(root, { kind, projectId, workspace, team });
  if (!Array.isArray(root.sections) || !Array.isArray(root.omitted_slots)) {
    throw new CapsuleSourceError("invalid_payload");
  }
  if (typeof root.complete !== "boolean") {
    throw new CapsuleSourceError("invalid_payload");
  }
  if (typeof root.text !== "string" || !root.text) {
    throw new CapsuleSourceError("invalid_payload");
  }
  if (!Number.isSafeInteger(root.char_count) || root.char_count !== root.text.length) {
    throw new CapsuleSourceError("invalid_payload");
  }
  if (!Number.isSafeInteger(root.max_chars) || root.max_chars < root.char_count) {
    throw new CapsuleSourceError("invalid_payload");
  }
  const expectedHash = `sha256:${sha256(root.text)}`;
  if (root.prompt_hash !== expectedHash) {
    throw new CapsuleSourceError("hash_mismatch");
  }

  let prompt;
  try {
    prompt = JSON.parse(root.text);
  } catch {
    throw new CapsuleSourceError("invalid_prompt_text");
  }
  const promptRoot = asRecord(prompt);
  if (!promptRoot || promptRoot.schema !== PROMPT_CAPSULE_SCHEMA || promptRoot.kind !== kind || !Array.isArray(promptRoot.sections)) {
    throw new CapsuleSourceError("invalid_prompt_text");
  }

  // Current upstream also marks empty/invalid/duplicate projections incomplete.
  // Older response files omit these diagnostic fields; retain that compatibility.
  const populated = promptRoot.sections.length > 0;
  if (root.populated !== undefined && root.populated !== populated) {
    throw new CapsuleSourceError("invalid_payload");
  }
  const diagnostics = [root.invalid_entries ?? [], root.duplicate_slots ?? []];
  if (diagnostics.some(value => !Array.isArray(value))) {
    throw new CapsuleSourceError("invalid_payload");
  }
  const complete = populated && root.omitted_slots.length === 0
    && diagnostics.every(value => value.length === 0);
  if (root.complete !== complete) throw new CapsuleSourceError("invalid_payload");
  if (!complete && !allowIncomplete) throw new CapsuleSourceError("incomplete_capsule");

  return {
    text: root.text,
    promptHash: root.prompt_hash,
    complete: root.complete === true,
    charCount: root.char_count,
  };
}

const CAPSULE_SLOTS = {
  core: ["identity", "preferences", "constraints", "principles"],
  project: ["current-state", "decisions", "open-questions"],
};

/** Check a validated source result for a particular consumer without rewriting its text. */
export function inspectCapsuleForUse(capsule, kind, { requiredSlots = [], maxChars = 12_000 } = {}) {
  assertKind(kind);
  const order = CAPSULE_SLOTS[kind];
  if (!Array.isArray(requiredSlots) || requiredSlots.some(slot => !order.includes(slot))) {
    throw new TypeError("invalid_required_slots");
  }
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 12_000) {
    throw new TypeError("invalid_capsule_budget");
  }
  if (!capsule || typeof capsule.text !== "string" || capsule.text.length > maxChars
    || capsule.charCount !== capsule.text.length || capsule.promptHash !== `sha256:${sha256(capsule.text)}`) {
    throw new CapsuleSourceError("invalid_capsule_source");
  }
  if (capsule.complete !== true) throw new CapsuleSourceError("incomplete_capsule");
  let prompt;
  try { prompt = JSON.parse(capsule.text); } catch { throw new CapsuleSourceError("invalid_prompt_text"); }
  if (prompt?.schema !== PROMPT_CAPSULE_SCHEMA || prompt.kind !== kind || !Array.isArray(prompt.sections)) {
    throw new CapsuleSourceError("invalid_prompt_text");
  }
  let previous = -1;
  for (const section of prompt.sections) {
    const position = order.indexOf(section?.slot);
    if (position <= previous || typeof section.content !== "string" || !section.content.trim()) {
      throw new CapsuleSourceError("invalid_prompt_text");
    }
    previous = position;
  }
  const slots = prompt.sections.map(section => section.slot);
  if (!slots.length) throw new CapsuleSourceError("empty_capsule");
  if (requiredSlots.some(slot => !slots.includes(slot))) throw new CapsuleSourceError("required_slot_missing");
  return Object.freeze({ text: capsule.text, promptHash: capsule.promptHash, slots: Object.freeze(slots) });
}

export async function fetchPromptCapsule({
  workerUrl,
  kind,
  projectId,
  workspace = "personal",
  team,
  authMode = "bearer",
  authToken,
  accessToken,
  allowIncomplete = false,
  fetchImpl = fetch,
}) {
  assertAuthMode(authMode);
  if (authMode === "bearer" && accessToken !== undefined) {
    throw new CapsuleSourceError("ambiguous_authentication");
  }
  if (authMode === "access" && authToken !== undefined) {
    throw new CapsuleSourceError("ambiguous_authentication");
  }
  const suppliedToken = authMode === "access" ? accessToken : authToken;
  if (typeof suppliedToken !== "string" || !suppliedToken.trim() || /[\r\n]/.test(suppliedToken)) {
    throw new CapsuleSourceError(authMode === "access" ? "access_token_missing" : "auth_token_missing");
  }
  const token = suppliedToken.trim();
  const endpoint = capsuleEndpoint({ workerUrl, kind, projectId, workspace, team, authMode });
  const credentialHeader = authMode === "access"
    ? {
        "Cf-Access-Token": token,
        "X-Second-Brain-Dashboard": "1",
      }
    : { Authorization: `Bearer ${token}` };
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        ...credentialHeader,
        Accept: PROMPT_CAPSULE_MIME,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof CapsuleSourceError) throw error;
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new CapsuleSourceError("timeout");
    }
    throw new CapsuleSourceError("network");
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new CapsuleSourceError("upstream_http", response.status);
  }
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== PROMPT_CAPSULE_MIME) {
    await response.body?.cancel();
    throw new CapsuleSourceError("invalid_content_type");
  }

  const raw = await readBoundedText(response);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new CapsuleSourceError("invalid_json");
  }
  const validated = validateCapsulePayload(payload, {
    kind,
    projectId,
    workspace,
    team,
    allowIncomplete,
  });
  const etag = response.headers.get("ETag");
  if (!etag || etag.startsWith("W/") || !/^"[^"\r\n]+"$/.test(etag)) {
    throw new CapsuleSourceError("invalid_etag");
  }

  return {
    ...validated,
    source: authMode === "access" ? "worker-access" : "worker",
    endpointHash: sha256(endpoint.toString()),
    etagHash: sha256(etag),
  };
}

export async function readCapsuleFile(path, kind, { allowIncomplete = false } = {}) {
  assertKind(kind);
  if (typeof path !== "string" || !path) throw new TypeError("path is required");
  const raw = await readFile(path, "utf8");
  if (!raw) throw new CapsuleSourceError("empty_file");

  try {
    const parsed = JSON.parse(raw);
    const root = asRecord(parsed);
    const isResponse = root?.ok === true || typeof root?.text === "string";
    if (isResponse) {
      const validated = validateCapsulePayload(parsed, { kind, allowIncomplete });
      return {
        ...validated,
        source: "file",
        endpointHash: null,
        etagHash: null,
      };
    }
    if (root?.schema === PROMPT_CAPSULE_SCHEMA) {
      if (root.kind !== kind || !Array.isArray(root.sections)) {
        throw new CapsuleSourceError("invalid_prompt_text");
      }
      return {
        text: raw,
        source: "file",
        promptHash: `sha256:${sha256(raw)}`,
        complete: true,
        charCount: raw.length,
        endpointHash: null,
        etagHash: null,
      };
    }
  } catch (error) {
    if (error instanceof CapsuleSourceError) throw error;
  }
  return {
    text: raw,
    source: "file",
    promptHash: `sha256:${sha256(raw)}`,
    complete: true,
    charCount: raw.length,
    endpointHash: null,
    etagHash: null,
  };
}
