import {
  ARM_NAMES,
  PROMPT_CACHE_EXPERIMENT_VERSION,
  asRecord,
  fail,
  isHex64,
  isNonNegativeNumber,
  isNullableNonNegativeNumber,
  isPositiveSafeInteger,
} from "./evidence-format.mjs";
import {
  DRY_RUN_KEYS,
  ERROR_KEYS,
  SUMMARY_ARM_KEYS,
  SUMMARY_KEYS,
  USAGE_KEYS,
  assertAllowedKeys,
  expectedSummary,
  validateStart,
} from "./evidence-contract.mjs";

function validateMetricRecord(record, start, keyByArm, suffixesByArm) {
  const allowedKeys = record.event === "prompt_cache_dry_run"
    ? DRY_RUN_KEYS
    : record.event === "prompt_cache_usage"
      ? USAGE_KEYS
      : record.event === "prompt_cache_error"
        ? ERROR_KEYS
        : null;
  if (!allowedKeys) fail("unknown_record_event");
  assertAllowedKeys(record, allowedKeys);
  if (record.version !== PROMPT_CACHE_EXPERIMENT_VERSION) fail("record_version_mismatch");
  if (record.transport !== start.transport || record.model !== start.model) fail("record_transport_mismatch");
  if (!ARM_NAMES.has(record.arm) || !start.arms.includes(record.arm)) fail("record_arm_mismatch");
  if (!Number.isSafeInteger(record.run) || record.run < 1 || record.run > start.runs_per_arm) fail("record_run_invalid");
  if (!isHex64(record.prompt_cache_key_hash)) fail("invalid_cache_key_hash");
  const priorKey = keyByArm.get(record.arm);
  if (priorKey && priorKey !== record.prompt_cache_key_hash) fail("cache_key_changed_within_arm");
  keyByArm.set(record.arm, record.prompt_cache_key_hash);

  const expectedMode = record.arm === "explicit" ? "explicit" : "implicit";
  if (record.mode !== expectedMode) fail("record_mode_mismatch");
  if (record.ttl !== (record.arm === "explicit" ? "30m" : null)) fail("record_ttl_mismatch");
  const expectedBreakpoints = record.arm === "explicit" ? (start.hasProject ? 2 : 1) : 0;
  if (record.explicit_breakpoints !== expectedBreakpoints) fail("breakpoint_count_mismatch");
  if (record.core_hash !== start.core_hash || record.core_chars !== start.core_chars) fail("core_prefix_changed");
  if (record.project_hash !== start.project_hash || record.project_chars !== start.project_chars) fail("project_prefix_changed");
  if (!isHex64(record.suffix_hash) || !isPositiveSafeInteger(record.suffix_chars)) fail("invalid_suffix_descriptor");
  const suffixes = suffixesByArm.get(record.arm) ?? new Set();
  if (suffixes.has(record.suffix_hash)) fail("suffix_not_changing");
  suffixes.add(record.suffix_hash);
  suffixesByArm.set(record.arm, suffixes);

  if (start.dry_run) {
    if (record.event !== "prompt_cache_dry_run") fail("dry_run_record_mismatch");
    return;
  }
  if (record.event !== "prompt_cache_usage" && record.event !== "prompt_cache_error") fail("live_record_mismatch");
  if (record.event === "prompt_cache_usage") {
    for (const value of [record.input_tokens, record.cache_write_tokens, record.cached_tokens, record.output_tokens, record.total_tokens]) {
      if (!isNullableNonNegativeNumber(value)) fail("invalid_usage_metric");
    }
    if (!isNullableNonNegativeNumber(record.cache_hit_ratio) || !isNullableNonNegativeNumber(record.cache_write_ratio)) {
      fail("invalid_usage_ratio");
    }
    if (!isNonNegativeNumber(record.latency_ms)) fail("invalid_latency");
    if (record.request_id_hash !== null && !isHex64(record.request_id_hash)) fail("invalid_request_id_hash");
    if (record.input_tokens !== null && record.cached_tokens !== null && record.cached_tokens > record.input_tokens) {
      fail("cached_tokens_exceed_input");
    }
    if (record.input_tokens !== null && record.cache_write_tokens !== null && record.cache_write_tokens > record.input_tokens) {
      fail("cache_write_tokens_exceed_input");
    }
    if (record.input_tokens !== null && record.cached_tokens !== null && record.cache_write_tokens !== null
      && record.cached_tokens + record.cache_write_tokens > record.input_tokens) {
      fail("cache_tokens_exceed_input");
    }
    if (record.input_tokens !== null && record.cached_tokens !== null && record.cache_hit_ratio !== null) {
      const expected = Number((record.cached_tokens / record.input_tokens).toFixed(6));
      if (record.cache_hit_ratio !== expected) fail("cache_hit_ratio_mismatch");
    }
    if (record.input_tokens !== null && record.cache_write_tokens !== null && record.cache_write_ratio !== null) {
      const expected = Number((record.cache_write_tokens / record.input_tokens).toFixed(6));
      if (record.cache_write_ratio !== expected) fail("cache_write_ratio_mismatch");
    }
    if (record.input_tokens !== null && record.output_tokens !== null && record.total_tokens !== null
      && record.total_tokens < record.input_tokens + record.output_tokens) {
      fail("total_tokens_inconsistent");
    }
  } else {
    if (record.request_id_hash !== null && !isHex64(record.request_id_hash)) fail("invalid_request_id_hash");
    if (typeof record.error_name !== "string" || !record.error_name || record.error_name.length > 128) fail("invalid_error_record");
    if (record.http_status !== null && (!Number.isInteger(record.http_status) || record.http_status < 100 || record.http_status > 599)) {
      fail("invalid_error_status");
    }
  }
}

function validateSummary(record, start, recordsByArm) {
  assertAllowedKeys(record, SUMMARY_KEYS);
  if (record.event !== "prompt_cache_experiment_summary") fail("summary_missing");
  if (record.version !== PROMPT_CACHE_EXPERIMENT_VERSION) fail("summary_version_mismatch");
  if (!Array.isArray(record.summaries) || record.summaries.length !== start.arms.length) fail("summary_arm_count_mismatch");
  const seen = new Set();
  for (const summary of record.summaries) {
    const current = asRecord(summary);
    if (!current || !start.arms.includes(current.arm) || seen.has(current.arm)) fail("summary_arm_invalid");
    assertAllowedKeys(current, SUMMARY_ARM_KEYS, "unexpected_summary_field");
    seen.add(current.arm);
    const expected = expectedSummary(recordsByArm.get(current.arm) ?? []);
    for (const [key, value] of Object.entries(expected)) {
      if (current[key] !== value) fail("summary_metric_mismatch");
    }
  }
}

export function validateEvidenceRecords(records) {
  if (!Array.isArray(records) || records.length < 3) fail("record_count_too_small");
  const start = validateStart(records[0]);
  const summary = records.at(-1);
  const middle = records.slice(1, -1);
  const expectedCount = start.arms.length * start.runs_per_arm;
  if (middle.length !== expectedCount) fail("request_record_count_mismatch");

  const recordsByArm = new Map(start.arms.map(arm => [arm, []]));
  const seenRuns = new Set();
  const keyByArm = new Map();
  const suffixesByArm = new Map();
  for (const record of middle) {
    const key = `${record.arm}:${record.run}`;
    if (seenRuns.has(key)) fail("duplicate_arm_run");
    seenRuns.add(key);
    validateMetricRecord(record, start, keyByArm, suffixesByArm);
    recordsByArm.get(record.arm).push(record);
  }
  for (const arm of start.arms) {
    const armRecords = recordsByArm.get(arm).sort((left, right) => left.run - right.run);
    if (armRecords.length !== start.runs_per_arm) fail("arm_run_count_mismatch");
    for (let index = 0; index < armRecords.length; index++) {
      if (armRecords[index].run !== index + 1) fail("run_sequence_gap");
    }
  }
  if (start.arms.length === 2 && keyByArm.get(start.arms[0]) === keyByArm.get(start.arms[1])) {
    fail("cache_key_not_arm_isolated");
  }
  validateSummary(summary, start, recordsByArm);
  return { start, recordsByArm };
}
