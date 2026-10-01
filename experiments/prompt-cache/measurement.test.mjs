import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProxyCertificationArtifacts,
  buildProxyMeasurementManifest,
} from "./measurement.mjs";

const H = "a".repeat(64);
const H2 = "b".repeat(64);
const H3 = "c".repeat(64);
const H4 = "d".repeat(64);
const TRANSPORT = "custom-123456789abc";

function evidence({
  cached = [0, 1792, 0, 1792],
  cacheWrites = [null, null, null, null],
  missingUsage = false,
} = {}) {
  const start = {
    event: "prompt_cache_experiment_start",
    version: "prompt-cache-ab.v1",
    transport: TRANSPORT,
    model: "gpt-5.6-luna",
    arms: ["explicit"],
    runs_per_arm: 4,
    delay_ms: 2000,
    experiment_id_hash: H4,
    core_source: "worker-mcp-oauth",
    project_source: null,
    core_hash: H,
    core_chars: 8727,
    project_hash: null,
    project_chars: null,
    core_complete: true,
    project_complete: null,
    core_endpoint_hash: H2,
    project_endpoint_hash: null,
    core_etag_hash: H3,
    project_etag_hash: null,
    dry_run: false,
  };
  const records = [start];
  for (let run = 1; run <= 4; run++) {
    const current = {
      event: "prompt_cache_usage",
      version: "prompt-cache-ab.v1",
      transport: TRANSPORT,
      arm: "explicit",
      run,
      model: "gpt-5.6-luna",
      prompt_cache_key_hash: H2,
      mode: "explicit",
      ttl: "30m",
      explicit_breakpoints: 1,
      core_hash: H,
      core_chars: 8727,
      project_hash: null,
      project_chars: null,
      suffix_hash: String(run).repeat(64),
      suffix_chars: 60,
      request_id_hash: H3,
      input_tokens: 2048,
      cache_write_tokens: cacheWrites[run - 1],
      cached_tokens: cached[run - 1],
      output_tokens: 1,
      total_tokens: 2049,
      cache_hit_ratio: cached[run - 1] / 2048,
      cache_write_ratio: cacheWrites[run - 1] === null ? null : cacheWrites[run - 1] / 2048,
      latency_ms: [400, 100, 300, 200][run - 1],
    };
    if (missingUsage && run === 2) current.input_tokens = null;
    if (missingUsage && run === 2) current.cache_hit_ratio = null;
    records.push(current);
  }
  records.push({
    event: "prompt_cache_experiment_summary",
    version: "prompt-cache-ab.v1",
    summaries: [{
      arm: "explicit",
      successful_requests: 4,
      failed_requests: 0,
      cache_write_observed: cacheWrites.some(value => Number(value) > 0),
      later_cache_read_observed: true,
      later_cached_tokens_min: 0,
      later_cached_tokens_max: 1792,
      verified: cacheWrites.some(value => Number(value) > 0),
    }],
  });
  return records.map(JSON.stringify).join("\n") + "\n";
}

function build(text, minLaterHitRate = 0.5) {
  return buildProxyMeasurementManifest(text, {
    expectedProxyTransport: TRANSPORT,
    proxyCredentialSource: "systemd-credential",
    minLaterHitRate,
  });
}

test("CLIProxy cache reads produce separate request, token, latency, and billing claims", () => {
  const manifest = build(evidence());
  assert.equal(manifest.verified, true);
  assert.equal(manifest.cache_proof.basis, "cache-read-observed");
  assert.deepEqual(manifest.criteria, {
    require_worker_source: true,
    require_complete_capsules: true,
    min_later_hit_rate: 0.5,
    expected_transport: TRANSPORT,
  });
  assert.equal(manifest.metrics.later_request_cache_hits, 2);
  assert.equal(manifest.metrics.later_request_cache_hit_rate, 0.666667);
  assert.equal(manifest.metrics.all_token_usage.input_tokens, 8192);
  assert.equal(manifest.metrics.all_token_usage.cached_tokens, 3584);
  assert.equal(manifest.metrics.all_token_usage.cached_input_ratio, 0.4375);
  assert.equal(manifest.metrics.later_token_usage.cached_input_ratio, 0.583333);
  assert.deepEqual(manifest.metrics.response_latency_ms, {
    samples: 4,
    min: 100,
    median: 200,
    p90: 400,
    max: 400,
    mean: 250,
  });
  assert.equal(manifest.metrics.cache_write_counter.samples, 0);
  assert.deepEqual(manifest.metrics.cached_tokens_per_hit, {
    samples: 2,
    min: 1792,
    max: 1792,
    mean: 1792,
  });
  assert.equal(manifest.metrics.later_cache_hit_latency_ms.median, 100);
  assert.equal(manifest.metrics.later_cache_miss_latency_ms.median, 300);
  assert.equal(manifest.claims.provider_billing_discount_verified, false);
  assert.equal(manifest.claims.initial_cache_write_observed, false);
  assert.equal(manifest.claims.cache_write_observed, false);
  assert.equal(manifest.billing.estimated_cost, null);
  assert.deepEqual(manifest.failures, []);
});

test("a later positive write counter is reported without relabelling it as the initial write", () => {
  const manifest = build(evidence({ cacheWrites: [0, 256, 0, 0] }));
  assert.equal(manifest.verified, true);
  assert.equal(manifest.cache_proof.cache_write_observed, false);
  assert.equal(manifest.metrics.cache_write_counter.samples, 4);
  assert.equal(manifest.metrics.cache_write_counter.tokens, 256);
  assert.equal(manifest.claims.initial_cache_write_observed, false);
  assert.equal(manifest.claims.cache_write_observed, true);
});

test("a high hit-rate threshold remains fail closed", () => {
  const manifest = build(evidence(), 0.75);
  assert.equal(manifest.verified, false);
  assert.ok(manifest.failures.includes("proxy_not_verified"));
});

test("missing token counters cannot produce a verified aggregate", () => {
  const manifest = build(evidence({ missingUsage: true }));
  assert.equal(manifest.verified, false);
  assert.ok(manifest.failures.includes("usage_counters_incomplete"));
  assert.equal(manifest.metrics.all_token_usage.input_tokens, null);
  assert.equal(manifest.metrics.response_latency_ms.samples, 0);
});

test("one ephemeral evidence stream emits separate matching qualification and measurement artifacts", () => {
  const artifacts = buildProxyCertificationArtifacts(evidence(), {
    expectedProxyTransport: TRANSPORT,
    proxyCredentialSource: "systemd-credential",
    minLaterHitRate: 0.5,
  });
  assert.equal(artifacts.schema, "prompt-cache-proxy-artifacts.v1");
  assert.equal(artifacts.verified, true);
  assert.equal(artifacts.qualification.schema, "prompt-cache-proxy-qualification.v1");
  assert.equal(artifacts.measurement.schema, "prompt-cache-proxy-measurement.v1");
  assert.equal(artifacts.qualification.proxy.evidence_sha256, artifacts.evidence_sha256);
  assert.equal(artifacts.measurement.evidence_sha256, artifacts.evidence_sha256);
  assert.equal(artifacts.qualification.proxy.model, artifacts.measurement.model);
  assert.equal(artifacts.qualification.proxy.transport, artifacts.measurement.transport);
  assert.deepEqual(artifacts.failures, []);
  assert.doesNotMatch(JSON.stringify(artifacts), /https?:\/\/|\bBearer\s+|\bsk-[A-Za-z0-9_-]{16,}/i);
});

test("artifact envelope fails when detailed usage is incomplete even if the cache gate passes", () => {
  const artifacts = buildProxyCertificationArtifacts(evidence({ missingUsage: true }), {
    expectedProxyTransport: TRANSPORT,
    proxyCredentialSource: "environment",
    minLaterHitRate: 0.5,
  });
  assert.equal(artifacts.qualification.verified, true);
  assert.equal(artifacts.measurement.verified, false);
  assert.equal(artifacts.verified, false);
  assert.deepEqual(artifacts.failures, ["usage_counters_incomplete"]);
});
