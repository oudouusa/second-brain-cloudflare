import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const PATH = new URL("./results/2026-09-03-cliproxy-cache-live-v1.json", import.meta.url);
const PAIRED_QUALIFICATION_PATH = new URL(
  "./results/2026-09-03-cliproxy-cache-paired-v1.qualification.json",
  import.meta.url,
);
const PAIRED_MEASUREMENT_PATH = new URL(
  "./results/2026-09-03-cliproxy-cache-paired-v1.measurement.json",
  import.meta.url,
);
const round = value => Number(value.toFixed(6));

test("checked-in CLIProxy measurement stays internally consistent and bounded", () => {
  const text = readFileSync(PATH, "utf8");
  const value = JSON.parse(text);
  const metrics = value.metrics;
  const all = metrics.all_token_usage;
  const later = metrics.later_token_usage;

  assert.equal(value.schema, "prompt-cache-proxy-measurement.v1");
  assert.equal(value.verified, true);
  assert.deepEqual(value.failures, []);
  assert.equal(metrics.successful_requests + metrics.failed_requests, value.request_plan.runs_per_arm);
  assert.equal(metrics.later_request_cache_hit_rate,
    round(metrics.later_request_cache_hits / (value.request_plan.runs_per_arm - 1)));
  assert.equal(value.criteria.min_later_hit_rate, 0.8);
  assert.equal(value.criteria.require_worker_source, true);
  assert.equal(value.criteria.require_complete_capsules, true);
  assert.equal(value.criteria.expected_transport, value.transport);
  assert.equal(all.cached_tokens + all.non_cached_input_tokens, all.input_tokens);
  assert.equal(later.cached_tokens + later.non_cached_input_tokens, later.input_tokens);
  assert.equal(all.cached_input_ratio, round(all.cached_tokens / all.input_tokens));
  assert.equal(later.cached_input_ratio, round(later.cached_tokens / later.input_tokens));
  assert.equal(value.cache_proof.basis, "cache-read-observed");
  assert.equal(value.claims.initial_cache_write_observed, false);
  assert.equal(value.claims.cache_write_observed, false);
  assert.equal(value.claims.official_api_equivalence_verified, false);
  assert.equal(value.claims.provider_billing_discount_verified, false);
  assert.equal(value.billing.estimated_cost, null);
  assert.doesNotMatch(text, /https?:\/\/|\bBearer\s+|\bsk-[A-Za-z0-9_-]{16,}/i);
});

test("checked-in paired artifacts are separate, verified, and share exact evidence", () => {
  const qualificationText = readFileSync(PAIRED_QUALIFICATION_PATH, "utf8");
  const measurementText = readFileSync(PAIRED_MEASUREMENT_PATH, "utf8");
  const qualification = JSON.parse(qualificationText);
  const measurement = JSON.parse(measurementText);
  const metrics = measurement.metrics;

  assert.equal(qualification.schema, "prompt-cache-proxy-qualification.v1");
  assert.equal(measurement.schema, "prompt-cache-proxy-measurement.v1");
  assert.equal(qualification.verified, true);
  assert.equal(measurement.verified, true);
  assert.equal(qualification.proxy.evidence_sha256, measurement.evidence_sha256);
  assert.equal(qualification.mode, "proxy-only");
  assert.equal(qualification.direct.status, "not_applicable");
  assert.equal(qualification.authentication.official_openai_api_key_used, false);
  assert.equal(qualification.cache_proof.basis, "cache-read-observed");
  assert.equal(metrics.successful_requests + metrics.failed_requests, measurement.request_plan.runs_per_arm);
  assert.equal(metrics.later_request_cache_hit_rate,
    round(metrics.later_request_cache_hits / (measurement.request_plan.runs_per_arm - 1)));
  assert.ok(metrics.later_request_cache_hit_rate >= measurement.criteria.min_later_hit_rate);
  assert.equal(metrics.all_token_usage.cached_input_ratio,
    round(metrics.all_token_usage.cached_tokens / metrics.all_token_usage.input_tokens));
  assert.equal(metrics.later_token_usage.cached_input_ratio,
    round(metrics.later_token_usage.cached_tokens / metrics.later_token_usage.input_tokens));
  assert.equal(measurement.claims.initial_cache_write_observed, false);
  assert.equal(measurement.claims.official_api_equivalence_verified, false);
  assert.equal(measurement.claims.provider_billing_discount_verified, false);
  assert.doesNotMatch(
    `${qualificationText}\n${measurementText}`,
    /https?:\/\/|\bBearer\s+|\bsk-[A-Za-z0-9_-]{16,}/i,
  );
});
