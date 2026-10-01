import { createHash } from "node:crypto";

export const PROMPT_CACHE_EVIDENCE_SCHEMA = "prompt-cache-evidence.v1";
export const PROMPT_CACHE_EXPERIMENT_VERSION = "prompt-cache-ab.v1";

export const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
export const ARM_NAMES = new Set(["implicit", "explicit"]);
export const SOURCE_NAMES = new Set(["synthetic", "file", "worker", "worker-access", "worker-mcp-oauth"]);
const FORBIDDEN_KEYS = new Set([
  "api_key",
  "auth_token",
  "authorization",
  "bearer_token",
  "content",
  "error_body",
  "model_output",
  "output_text",
  "project_id",
  "prompt",
  "prompt_cache_key",
  "prompt_text",
  "response_body",
  "team",
  "team_id",
  "text",
  "worker_url",
]);

export class PromptCacheEvidenceError extends Error {
  constructor(code) {
    super(`Prompt-cache evidence is invalid: ${code}`);
    this.name = "PromptCacheEvidenceError";
    this.code = code;
  }
}

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function fail(code) {
  throw new PromptCacheEvidenceError(code);
}

export function isHex64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isNullableHex64(value) {
  return value === null || isHex64(value);
}

export function isNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isNullableNonNegativeNumber(value) {
  return value === null || isNonNegativeNumber(value);
}

export function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function safeTransport(value) {
  return value === "openai-official" || (typeof value === "string" && /^custom-[0-9a-f]{12}$/.test(value));
}

function inspectSanitized(value, seen = new Set()) {
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (/\bBearer\s+/i.test(value) || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(value) || /https?:\/\//i.test(value)) {
      fail("unsafe_string_value");
    }
    return;
  }
  if (typeof value !== "object") fail("unsupported_json_value");
  if (seen.has(value)) fail("cyclic_json_value");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) inspectSanitized(child, seen);
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) fail("forbidden_field");
      inspectSanitized(child, seen);
    }
  }
  seen.delete(value);
}

export function parseEvidenceJsonl(text) {
  if (typeof text !== "string" || !text.trim()) fail("empty_input");
  if (Buffer.byteLength(text, "utf8") > MAX_EVIDENCE_BYTES) fail("input_too_large");
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  const records = lines.map((line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail("invalid_jsonl");
    }
    const record = asRecord(parsed);
    if (!record) fail("record_not_object");
    inspectSanitized(record);
    return record;
  });
  if (records.length < 3) fail("record_count_too_small");
  return records;
}
