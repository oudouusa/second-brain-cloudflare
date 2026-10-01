import {
  ARM_NAMES,
  SOURCE_NAMES,
  PROMPT_CACHE_EXPERIMENT_VERSION,
  asRecord,
  fail,
  isHex64,
  isNullableHex64,
  isNonNegativeNumber,
  isNullableNonNegativeNumber,
  isPositiveSafeInteger,
  safeTransport,
} from "./evidence-format.mjs";

export function assertAllowedKeys(record, allowed, code = "unexpected_field") {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(code);
  }
}

function isWorkerSource(value) {
  return value === "worker" || value === "worker-access" || value === "worker-mcp-oauth";
}

const START_KEYS = new Set([
  "event", "version", "transport", "model", "arms", "runs_per_arm", "delay_ms",
  "experiment_id_hash", "core_source", "project_source", "core_hash", "core_chars",
  "project_hash", "project_chars", "core_complete", "project_complete",
  "core_endpoint_hash", "project_endpoint_hash", "core_etag_hash", "project_etag_hash",
  "dry_run",
]);
const DESCRIPTOR_KEYS = [
  "event", "version", "transport", "arm", "run", "model", "prompt_cache_key_hash",
  "mode", "ttl", "explicit_breakpoints", "core_hash", "core_chars", "project_hash",
  "project_chars", "suffix_hash", "suffix_chars",
];
export const DRY_RUN_KEYS = new Set(DESCRIPTOR_KEYS);
export const USAGE_KEYS = new Set([
  ...DESCRIPTOR_KEYS, "request_id_hash", "input_tokens", "cache_write_tokens", "cached_tokens",
  "output_tokens", "total_tokens", "cache_hit_ratio", "cache_write_ratio", "latency_ms",
]);
export const ERROR_KEYS = new Set([...DESCRIPTOR_KEYS, "error_name", "http_status", "request_id_hash"]);
export const SUMMARY_KEYS = new Set(["event", "version", "summaries"]);
export const SUMMARY_ARM_KEYS = new Set([
  "arm", "successful_requests", "failed_requests", "cache_write_observed",
  "later_cache_read_observed", "later_cached_tokens_min", "later_cached_tokens_max", "verified",
]);

export function validateStart(record) {
  assertAllowedKeys(record, START_KEYS);
  if (record.event !== "prompt_cache_experiment_start") fail("start_missing");
  if (record.version !== PROMPT_CACHE_EXPERIMENT_VERSION) fail("unsupported_experiment_version");
  if (!safeTransport(record.transport)) fail("invalid_transport");
  if (typeof record.model !== "string" || !record.model.trim() || record.model.length > 128) fail("invalid_model");
  if (!Array.isArray(record.arms) || record.arms.length < 1 || record.arms.length > 2) fail("invalid_arms");
  if (new Set(record.arms).size !== record.arms.length || record.arms.some(arm => !ARM_NAMES.has(arm))) fail("invalid_arms");
  if (!Number.isSafeInteger(record.runs_per_arm) || record.runs_per_arm < 2 || record.runs_per_arm > 20) fail("invalid_run_count");
  if (!Number.isSafeInteger(record.delay_ms) || record.delay_ms < 0 || record.delay_ms > 60_000) fail("invalid_delay");
  if (!isHex64(record.experiment_id_hash)) fail("invalid_experiment_hash");
  if (!SOURCE_NAMES.has(record.core_source)) fail("invalid_core_source");
  if (!isHex64(record.core_hash) || !isPositiveSafeInteger(record.core_chars)) fail("invalid_core_descriptor");
  if (typeof record.core_complete !== "boolean") fail("invalid_core_completeness");
  if (!isNullableHex64(record.core_endpoint_hash) || !isNullableHex64(record.core_etag_hash)) fail("invalid_core_source_hash");
  if (isWorkerSource(record.core_source)) {
    if (!isHex64(record.core_endpoint_hash) || !isHex64(record.core_etag_hash)) fail("worker_source_hash_missing");
  } else if (record.core_endpoint_hash !== null || record.core_etag_hash !== null) {
    fail("non_worker_source_hash_present");
  }

  const hasProject = record.project_hash !== null;
  if (hasProject) {
    if (!SOURCE_NAMES.has(record.project_source)) fail("invalid_project_source");
    if (!isHex64(record.project_hash) || !isPositiveSafeInteger(record.project_chars)) fail("invalid_project_descriptor");
    if (typeof record.project_complete !== "boolean") fail("invalid_project_completeness");
    if (!isNullableHex64(record.project_endpoint_hash) || !isNullableHex64(record.project_etag_hash)) fail("invalid_project_source_hash");
    if (isWorkerSource(record.project_source)) {
      if (!isHex64(record.project_endpoint_hash) || !isHex64(record.project_etag_hash)) fail("worker_source_hash_missing");
    } else if (record.project_endpoint_hash !== null || record.project_etag_hash !== null) {
      fail("non_worker_source_hash_present");
    }
  } else if (
    record.project_source !== null
    || record.project_chars !== null
    || record.project_complete !== null
    || record.project_endpoint_hash !== null
    || record.project_etag_hash !== null
  ) {
    fail("project_nullability_mismatch");
  }
  if (typeof record.dry_run !== "boolean") fail("invalid_dry_run_flag");
  return { ...record, hasProject };
}

export function expectedSummary(records) {
  const usage = records.filter(record => record.event === "prompt_cache_usage");
  const later = usage.filter(record => record.run > 1);
  const writeObserved = usage.some(record => Number(record.cache_write_tokens) > 0);
  const readObserved = later.some(record => Number(record.cached_tokens) > 0);
  const cached = later.map(record => record.cached_tokens).filter(Number.isFinite);
  return {
    successful_requests: usage.length,
    failed_requests: records.filter(record => record.event === "prompt_cache_error").length,
    cache_write_observed: writeObserved,
    later_cache_read_observed: readObserved,
    later_cached_tokens_min: cached.length ? Math.min(...cached) : null,
    later_cached_tokens_max: cached.length ? Math.max(...cached) : null,
    verified: writeObserved && readObserved,
  };
}
