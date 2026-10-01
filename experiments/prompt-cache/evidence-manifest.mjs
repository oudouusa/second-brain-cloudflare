import {
  PROMPT_CACHE_EVIDENCE_SCHEMA,
  PROMPT_CACHE_EXPERIMENT_VERSION,
  parseEvidenceJsonl,
  sha256,
} from "./evidence-format.mjs";
import { validateEvidenceRecords } from "./evidence-records.mjs";

function armManifest(arm, records, minLaterHitRate) {
  const usage = records.filter(record => record.event === "prompt_cache_usage");
  const errors = records.filter(record => record.event === "prompt_cache_error");
  const first = usage.find(record => record.run === 1);
  const later = records.filter(record => record.run > 1);
  const laterHits = later.filter(record => record.event === "prompt_cache_usage" && Number(record.cached_tokens) > 0);
  const cached = laterHits.map(record => Number(record.cached_tokens));
  const laterHitRate = later.length ? laterHits.length / later.length : 0;
  const allSuccessful = errors.length === 0 && usage.length === records.length;
  const run1Write = Number(first?.cache_write_tokens) > 0;
  const strictVerified = allSuccessful && run1Write && laterHits.length > 0 && laterHitRate >= minLaterHitRate;
  return {
    arm,
    explicit_breakpoints: records[0]?.explicit_breakpoints ?? null,
    prompt_cache_key_hash: records[0]?.prompt_cache_key_hash ?? null,
    requests: records.length,
    successful_requests: usage.length,
    failed_requests: errors.length,
    all_requests_successful: allSuccessful,
    run1_cache_write_tokens: first?.cache_write_tokens ?? null,
    run1_cache_write_observed: run1Write,
    later_requests: later.length,
    later_cache_hit_requests: laterHits.length,
    later_cache_hit_rate: Number(laterHitRate.toFixed(6)),
    later_cached_tokens_min: cached.length ? Math.min(...cached) : null,
    later_cached_tokens_max: cached.length ? Math.max(...cached) : null,
    strict_verified: strictVerified,
  };
}

function gateFailures(start, arms, options) {
  const failures = [];
  if (options.requireWorkerSource) {
    const coreWorker = ["worker", "worker-access", "worker-mcp-oauth"].includes(start.core_source);
    const projectWorker = ["worker", "worker-access", "worker-mcp-oauth"].includes(start.project_source);
    if (!coreWorker || (start.hasProject && !projectWorker)) {
      failures.push("worker_source_required");
    }
  }
  if (!options.allowIncompleteCapsules) {
    if (!start.core_complete || (start.hasProject && !start.project_complete)) failures.push("incomplete_capsule");
  }
  if (options.gate === "structure") return failures;
  if (start.dry_run) failures.push("live_measurement_required");
  if (options.gate === "direct" && start.transport !== "openai-official") failures.push("official_transport_required");
  if (options.gate === "proxy") {
    if (!/^custom-[0-9a-f]{12}$/.test(String(start.transport))) failures.push("proxy_transport_required");
    if (!/^custom-[0-9a-f]{12}$/.test(String(options.expectedTransport))) {
      failures.push("expected_proxy_transport_required");
    } else if (start.transport !== options.expectedTransport) {
      failures.push("proxy_transport_mismatch");
    }
  }
  const explicit = arms.find(arm => arm.arm === "explicit");
  if (!explicit) failures.push("explicit_arm_required");
  else {
    if (!explicit.all_requests_successful) failures.push("explicit_requests_failed");
    if (!explicit.run1_cache_write_observed) failures.push("initial_cache_write_missing");
    if (explicit.later_cache_hit_requests < 1) failures.push("later_cache_read_missing");
    if (explicit.later_cache_hit_rate < options.minLaterHitRate) failures.push("later_cache_hit_rate_below_threshold");
  }
  return [...new Set(failures)];
}

export function verifyEvidence(text, {
  gate = "structure",
  requireWorkerSource = false,
  allowIncompleteCapsules = false,
  minLaterHitRate = 0.5,
  expectedTransport = null,
} = {}) {
  if (!["structure", "direct", "proxy"].includes(gate)) throw new TypeError("invalid gate");
  if (typeof minLaterHitRate !== "number" || !Number.isFinite(minLaterHitRate) || minLaterHitRate < 0 || minLaterHitRate > 1) {
    throw new TypeError("minLaterHitRate must be from 0 through 1");
  }
  if (expectedTransport !== null && !/^custom-[0-9a-f]{12}$/.test(String(expectedTransport))) {
    throw new TypeError("expectedTransport must be a safe custom transport label");
  }
  const records = parseEvidenceJsonl(text);
  const { start, recordsByArm } = validateEvidenceRecords(records);
  const arms = start.arms.map(arm => armManifest(arm, recordsByArm.get(arm), minLaterHitRate));
  const failures = gateFailures(start, arms, {
    gate,
    requireWorkerSource,
    allowIncompleteCapsules,
    minLaterHitRate,
    expectedTransport,
  });
  return {
    schema: PROMPT_CACHE_EVIDENCE_SCHEMA,
    experiment_version: PROMPT_CACHE_EXPERIMENT_VERSION,
    evidence_sha256: sha256(text),
    gate,
    verified: failures.length === 0,
    transport: start.transport,
    model: start.model,
    dry_run: start.dry_run,
    experiment_id_hash: start.experiment_id_hash,
    sources: {
      core: {
        type: start.core_source,
        hash: start.core_hash,
        chars: start.core_chars,
        complete: start.core_complete,
        endpoint_hash: start.core_endpoint_hash,
        etag_hash: start.core_etag_hash,
      },
      project: start.hasProject ? {
        type: start.project_source,
        hash: start.project_hash,
        chars: start.project_chars,
        complete: start.project_complete,
        endpoint_hash: start.project_endpoint_hash,
        etag_hash: start.project_etag_hash,
      } : null,
    },
    request_plan: {
      arms: start.arms,
      runs_per_arm: start.runs_per_arm,
      delay_ms: start.delay_ms,
    },
    criteria: {
      require_worker_source: requireWorkerSource,
      require_complete_capsules: !allowIncompleteCapsules,
      min_later_hit_rate: minLaterHitRate,
      expected_transport: gate === "proxy" ? expectedTransport : null,
    },
    arms,
    failures,
  };
}
