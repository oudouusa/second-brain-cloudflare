import { parseEvidenceJsonl } from "./evidence-format.mjs";
import { validateEvidenceRecords } from "./evidence-records.mjs";
import { buildProxyOnlyQualificationManifest } from "./qualification.mjs";
import { verifyEvidence } from "./verify.mjs";

export const PROMPT_CACHE_PROXY_MEASUREMENT_SCHEMA = "prompt-cache-proxy-measurement.v1";
export const PROMPT_CACHE_PROXY_ARTIFACTS_SCHEMA = "prompt-cache-proxy-artifacts.v1";

function round(value) {
  return Number(value.toFixed(6));
}

function sum(records, key) {
  return records.reduce((total, record) => total + Number(record[key]), 0);
}

function complete(records, keys) {
  return records.every(record => keys.every(key => (
    typeof record[key] === "number" && Number.isFinite(record[key]) && record[key] >= 0
  )));
}

function nearestRank(sorted, percentile) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function latencySummary(records) {
  const values = records.map(record => record.latency_ms).sort((left, right) => left - right);
  if (!values.length) {
    return { samples: 0, min: null, median: null, p90: null, max: null, mean: null };
  }
  return {
    samples: values.length,
    min: values[0],
    median: nearestRank(values, 0.5),
    p90: nearestRank(values, 0.9),
    max: values.at(-1),
    mean: round(values.reduce((total, value) => total + value, 0) / values.length),
  };
}

function positiveCachedTokenSummary(records) {
  const values = records
    .map(record => record.cached_tokens)
    .filter(value => typeof value === "number" && Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  return {
    samples: values.length,
    min: values.length ? values[0] : null,
    max: values.length ? values.at(-1) : null,
    mean: values.length ? round(values.reduce((total, value) => total + value, 0) / values.length) : null,
  };
}

function tokenSummary(records) {
  const inputTokens = sum(records, "input_tokens");
  const cachedTokens = sum(records, "cached_tokens");
  return {
    requests: records.length,
    input_tokens: inputTokens,
    cached_tokens: cachedTokens,
    non_cached_input_tokens: inputTokens - cachedTokens,
    cached_input_ratio: inputTokens > 0 ? round(cachedTokens / inputTokens) : null,
    output_tokens: sum(records, "output_tokens"),
    total_tokens: sum(records, "total_tokens"),
  };
}

/**
 * Turn one sanitized proxy JSONL run into an aggregate operational measurement.
 * The report deliberately makes no API-price claim: Codex OAuth usage is not an
 * OpenAI Platform invoice, even when cached_tokens is observable.
 */
export function buildProxyMeasurementManifest(evidenceText, {
  expectedProxyTransport,
  proxyCredentialSource,
  allowIncompleteCapsules = false,
  minLaterHitRate = 0.5,
} = {}) {
  const proxy = verifyEvidence(evidenceText, {
    gate: "proxy",
    requireWorkerSource: true,
    allowIncompleteCapsules,
    minLaterHitRate,
    expectedTransport: expectedProxyTransport,
  });
  const qualification = buildProxyOnlyQualificationManifest(proxy, {
    expectedProxyTransport,
    proxyCredentialSource,
  });
  const records = parseEvidenceJsonl(evidenceText);
  const { recordsByArm } = validateEvidenceRecords(records);
  const armRecords = recordsByArm.get("explicit") ?? [];
  const explicit = proxy.arms.find(arm => arm.arm === "explicit");
  const usage = armRecords.filter(record => record.event === "prompt_cache_usage");
  const laterUsage = usage.filter(record => record.run > 1);
  const requiredUsageKeys = [
    "input_tokens", "cached_tokens", "output_tokens", "total_tokens", "latency_ms",
  ];
  const usageComplete = usage.length === armRecords.length && complete(usage, requiredUsageKeys);
  const cacheWriteSamples = usage.filter(record => (
    typeof record.cache_write_tokens === "number" && Number.isFinite(record.cache_write_tokens)
  ));
  const anyCacheWriteObserved = cacheWriteSamples.some(record => record.cache_write_tokens > 0);
  const failures = [...qualification.failures];
  if (!usage.length || !usageComplete) failures.push("usage_counters_incomplete");

  const safeTokenSummary = selected => usageComplete
    ? tokenSummary(selected)
    : {
        requests: selected.length,
        input_tokens: null,
        cached_tokens: null,
        non_cached_input_tokens: null,
        cached_input_ratio: null,
        output_tokens: null,
        total_tokens: null,
      };

  return {
    schema: PROMPT_CACHE_PROXY_MEASUREMENT_SCHEMA,
    verified: failures.length === 0,
    evidence_sha256: proxy.evidence_sha256,
    experiment_id_hash: proxy.experiment_id_hash,
    transport: proxy.transport,
    model: proxy.model,
    sources: proxy.sources,
    request_plan: proxy.request_plan,
    criteria: proxy.criteria,
    authentication: qualification.authentication,
    cache_proof: qualification.cache_proof,
    metrics: {
      successful_requests: usage.length,
      failed_requests: armRecords.length - usage.length,
      later_request_cache_hits: explicit?.later_cache_hit_requests ?? 0,
      later_request_cache_hit_rate: explicit?.later_cache_hit_rate ?? 0,
      all_token_usage: safeTokenSummary(usage),
      later_token_usage: safeTokenSummary(laterUsage),
      cache_write_counter: {
        samples: cacheWriteSamples.length,
        tokens: cacheWriteSamples.length ? sum(cacheWriteSamples, "cache_write_tokens") : null,
      },
      cached_tokens_per_hit: usageComplete ? positiveCachedTokenSummary(laterUsage) : positiveCachedTokenSummary([]),
      response_latency_ms: usageComplete ? latencySummary(usage) : latencySummary([]),
      later_cache_hit_latency_ms: usageComplete
        ? latencySummary(laterUsage.filter(record => record.cached_tokens > 0))
        : latencySummary([]),
      later_cache_miss_latency_ms: usageComplete
        ? latencySummary(laterUsage.filter(record => record.cached_tokens === 0))
        : latencySummary([]),
    },
    claims: {
      cache_read_observed: qualification.cache_proof.cache_read_observed,
      initial_cache_write_observed: qualification.cache_proof.cache_write_observed,
      cache_write_observed: anyCacheWriteObserved,
      official_api_equivalence_verified: false,
      provider_billing_discount_verified: false,
    },
    billing: {
      basis: "not_available_for_cliproxy_oauth",
      currency: null,
      estimated_cost: null,
    },
    failures: [...new Set(failures)],
  };
}

/**
 * Emit the qualification verdict and operational measurement from the exact
 * same ephemeral JSONL. The wrapper is a transport envelope only: callers may
 * persist its two nested manifests as separate sanitized evidence files.
 */
export function buildProxyCertificationArtifacts(evidenceText, options = {}) {
  const proxy = verifyEvidence(evidenceText, {
    gate: "proxy",
    requireWorkerSource: true,
    allowIncompleteCapsules: options.allowIncompleteCapsules ?? false,
    minLaterHitRate: options.minLaterHitRate ?? 0.5,
    expectedTransport: options.expectedProxyTransport,
  });
  const qualification = buildProxyOnlyQualificationManifest(proxy, {
    expectedProxyTransport: options.expectedProxyTransport,
    proxyCredentialSource: options.proxyCredentialSource,
  });
  const measurement = buildProxyMeasurementManifest(evidenceText, options);
  if (qualification.proxy.evidence_sha256 !== measurement.evidence_sha256) {
    throw new TypeError("Prompt-cache certification artifact evidence mismatch");
  }
  return {
    schema: PROMPT_CACHE_PROXY_ARTIFACTS_SCHEMA,
    verified: qualification.verified && measurement.verified,
    evidence_sha256: measurement.evidence_sha256,
    experiment_id_hash: measurement.experiment_id_hash,
    qualification,
    measurement,
    failures: [...new Set([...qualification.failures, ...measurement.failures])],
  };
}
