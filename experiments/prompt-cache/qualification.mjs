export const PROMPT_CACHE_QUALIFICATION_SCHEMA = "prompt-cache-qualification.v1";
export const PROMPT_CACHE_PROXY_QUALIFICATION_SCHEMA = "prompt-cache-proxy-qualification.v1";
export const PROMPT_CACHE_EVIDENCE_SCHEMA = "prompt-cache-evidence.v1";
const PROMPT_CACHE_EXPERIMENT_VERSION = "prompt-cache-ab.v1";

const TOP_LEVEL_KEYS = new Set([
  "schema", "experiment_version", "evidence_sha256", "gate", "verified", "transport",
  "model", "dry_run", "experiment_id_hash", "sources", "request_plan", "criteria", "arms", "failures",
]);
const SOURCE_KEYS = new Set(["type", "hash", "chars", "complete", "endpoint_hash", "etag_hash"]);
const SOURCES_KEYS = new Set(["core", "project"]);
const REQUEST_PLAN_KEYS = new Set(["arms", "runs_per_arm", "delay_ms"]);
const CRITERIA_KEYS = new Set([
  "require_worker_source", "require_complete_capsules", "min_later_hit_rate", "expected_transport",
]);
const ARM_KEYS = new Set([
  "arm", "explicit_breakpoints", "prompt_cache_key_hash", "requests", "successful_requests",
  "failed_requests", "all_requests_successful", "run1_cache_write_tokens", "run1_cache_write_observed",
  "later_requests", "later_cache_hit_requests", "later_cache_hit_rate", "later_cached_tokens_min",
  "later_cached_tokens_max", "strict_verified",
]);

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function isHex64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isCustomTransport(value) {
  return typeof value === "string" && /^custom-[0-9a-f]{12}$/.test(value);
}

function fail(code) {
  const error = new TypeError(`Invalid prompt-cache qualification input: ${code}`);
  error.code = code;
  throw error;
}

function assertExactKeys(value, expected, code) {
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some(key => !expected.has(key))) fail(code);
}

function sourceDescriptor(value, required = true) {
  if (value === null && !required) return null;
  const source = asRecord(value);
  if (!source) fail("invalid_source");
  assertExactKeys(source, SOURCE_KEYS, "invalid_source_fields");
  if (!["worker", "worker-access", "worker-mcp-oauth", "file", "synthetic"].includes(source.type)) fail("invalid_source");
  if (!isHex64(source.hash) || !Number.isSafeInteger(source.chars) || source.chars < 1) fail("invalid_source");
  if (typeof source.complete !== "boolean") fail("invalid_source");
  if (source.endpoint_hash !== null && !isHex64(source.endpoint_hash)) fail("invalid_source");
  if (source.etag_hash !== null && !isHex64(source.etag_hash)) fail("invalid_source");
  const workerSource = ["worker", "worker-access", "worker-mcp-oauth"].includes(source.type);
  if (workerSource && (!isHex64(source.endpoint_hash) || !isHex64(source.etag_hash))) {
    fail("invalid_worker_source");
  }
  if (!workerSource && (source.endpoint_hash !== null || source.etag_hash !== null)) {
    fail("invalid_non_worker_source");
  }
  return { ...source };
}

function armSummary(value, expectedRuns, projectPresent, minLaterHitRate) {
  const arm = asRecord(value);
  if (!arm) fail("invalid_arm");
  assertExactKeys(arm, ARM_KEYS, "invalid_arm_fields");
  if (arm.arm !== "implicit" && arm.arm !== "explicit") fail("invalid_arm");
  if (!isHex64(arm.prompt_cache_key_hash)) fail("invalid_arm");
  const integerMetrics = [
    "explicit_breakpoints", "requests", "successful_requests", "failed_requests",
    "later_requests", "later_cache_hit_requests",
  ];
  if (integerMetrics.some(key => !Number.isSafeInteger(arm[key]) || arm[key] < 0)) fail("invalid_arm_metrics");
  for (const key of ["run1_cache_write_tokens", "later_cached_tokens_min", "later_cached_tokens_max"]) {
    if (arm[key] !== null && (typeof arm[key] !== "number" || !Number.isFinite(arm[key]) || arm[key] < 0)) {
      fail("invalid_arm_metrics");
    }
  }
  if (typeof arm.all_requests_successful !== "boolean"
    || typeof arm.run1_cache_write_observed !== "boolean"
    || typeof arm.strict_verified !== "boolean"
    || typeof arm.later_cache_hit_rate !== "number"
    || !Number.isFinite(arm.later_cache_hit_rate)
    || arm.later_cache_hit_rate < 0
    || arm.later_cache_hit_rate > 1) {
    fail("invalid_arm_metrics");
  }
  const expectedBreakpoints = arm.arm === "explicit" ? (projectPresent ? 2 : 1) : 0;
  if (arm.explicit_breakpoints !== expectedBreakpoints) fail("invalid_breakpoint_count");
  if (arm.requests !== expectedRuns
    || arm.successful_requests + arm.failed_requests !== arm.requests
    || arm.later_requests !== Math.max(0, arm.requests - 1)
    || arm.later_cache_hit_requests > arm.later_requests) {
    fail("inconsistent_arm_metrics");
  }
  if (arm.all_requests_successful !== (arm.failed_requests === 0 && arm.successful_requests === arm.requests)) {
    fail("inconsistent_arm_metrics");
  }
  const expectedWriteObserved = Number(arm.run1_cache_write_tokens) > 0;
  const expectedHitRate = arm.later_requests ? arm.later_cache_hit_requests / arm.later_requests : 0;
  const expectedStrict = arm.all_requests_successful
    && expectedWriteObserved
    && arm.later_cache_hit_requests > 0
    && expectedHitRate >= minLaterHitRate;
  if (arm.run1_cache_write_observed !== expectedWriteObserved
    || arm.later_cache_hit_rate !== Number(expectedHitRate.toFixed(6))
    || arm.strict_verified !== expectedStrict) {
    fail("inconsistent_arm_verdict");
  }
  if (arm.later_cache_hit_requests > 0) {
    if (!(Number(arm.later_cached_tokens_min) > 0)
      || !(Number(arm.later_cached_tokens_max) >= Number(arm.later_cached_tokens_min))) {
      fail("inconsistent_arm_metrics");
    }
  } else if (arm.later_cached_tokens_min !== null || arm.later_cached_tokens_max !== null) {
    fail("inconsistent_arm_metrics");
  }
  return { ...arm };
}

function compactEvidence(value, expectedGate, expectedTransport) {
  const manifest = asRecord(value);
  if (!manifest || manifest.schema !== PROMPT_CACHE_EVIDENCE_SCHEMA || manifest.gate !== expectedGate) {
    fail(`invalid_${expectedGate}_manifest`);
  }
  assertExactKeys(manifest, TOP_LEVEL_KEYS, `invalid_${expectedGate}_manifest_fields`);
  if (manifest.experiment_version !== PROMPT_CACHE_EXPERIMENT_VERSION
    || !isHex64(manifest.evidence_sha256)
    || !isHex64(manifest.experiment_id_hash)
    || typeof manifest.verified !== "boolean"
    || typeof manifest.model !== "string"
    || !manifest.model.trim()
    || manifest.model.length > 128
    || /[\u0000-\u001f\u007f]/.test(manifest.model)
    || typeof manifest.dry_run !== "boolean"
    || !Array.isArray(manifest.failures)
    || manifest.failures.some(code => typeof code !== "string" || !/^[a-z0-9_]+$/.test(code))) {
    fail(`invalid_${expectedGate}_manifest`);
  }
  if (manifest.verified !== (manifest.failures.length === 0)) fail(`inconsistent_${expectedGate}_verdict`);
  if (expectedGate === "direct" && manifest.transport !== "openai-official") fail("invalid_direct_transport");
  if (expectedGate === "proxy" && (!isCustomTransport(manifest.transport) || manifest.transport !== expectedTransport)) {
    fail("invalid_proxy_transport");
  }

  const sources = asRecord(manifest.sources);
  if (!sources) fail(`invalid_${expectedGate}_sources`);
  assertExactKeys(sources, SOURCES_KEYS, `invalid_${expectedGate}_sources`);
  const normalizedSources = {
    core: sourceDescriptor(sources.core),
    project: sourceDescriptor(sources.project, false),
  };

  const plan = asRecord(manifest.request_plan);
  if (!plan) fail("invalid_request_plan");
  assertExactKeys(plan, REQUEST_PLAN_KEYS, "invalid_request_plan");
  const expectedArms = expectedGate === "direct" ? ["implicit", "explicit"] : ["explicit"];
  if (!Array.isArray(plan.arms) || plan.arms.length !== expectedArms.length
    || plan.arms.some((arm, index) => arm !== expectedArms[index])
    || !Number.isSafeInteger(plan.runs_per_arm) || plan.runs_per_arm < 2 || plan.runs_per_arm > 20
    || !Number.isSafeInteger(plan.delay_ms) || plan.delay_ms < 0 || plan.delay_ms > 60_000) {
    fail("invalid_request_plan");
  }

  const criteria = asRecord(manifest.criteria);
  if (!criteria) fail("invalid_evidence_criteria");
  assertExactKeys(criteria, CRITERIA_KEYS, "invalid_evidence_criteria");
  if (criteria.require_worker_source !== true
    || typeof criteria.require_complete_capsules !== "boolean"
    || typeof criteria.min_later_hit_rate !== "number"
    || !Number.isFinite(criteria.min_later_hit_rate)
    || criteria.min_later_hit_rate < 0
    || criteria.min_later_hit_rate > 1
    || criteria.expected_transport !== (expectedGate === "proxy" ? expectedTransport : null)) {
    fail("invalid_evidence_criteria");
  }
  const capsulesComplete = normalizedSources.core.complete
    && (normalizedSources.project === null || normalizedSources.project.complete);
  if (manifest.verified && criteria.require_complete_capsules && !capsulesComplete) {
    fail(`inconsistent_${expectedGate}_verdict`);
  }

  if (!Array.isArray(manifest.arms) || manifest.arms.length !== expectedArms.length) fail("invalid_arms");
  const arms = manifest.arms.map(arm => armSummary(
    arm,
    plan.runs_per_arm,
    normalizedSources.project !== null,
    criteria.min_later_hit_rate,
  ));
  if (arms.some((arm, index) => arm.arm !== expectedArms[index])) fail("invalid_arms");
  const explicit = arms.find(arm => arm.arm === "explicit");
  const expectedFailures = [];
  if (!isWorkerSource(normalizedSources.core)
    || (normalizedSources.project !== null && !isWorkerSource(normalizedSources.project))) {
    expectedFailures.push("worker_source_required");
  }
  if (criteria.require_complete_capsules && !capsulesComplete) expectedFailures.push("incomplete_capsule");
  if (manifest.dry_run) expectedFailures.push("live_measurement_required");
  if (!explicit?.all_requests_successful) expectedFailures.push("explicit_requests_failed");
  if (!explicit?.run1_cache_write_observed) expectedFailures.push("initial_cache_write_missing");
  if (!explicit || explicit.later_cache_hit_requests < 1) expectedFailures.push("later_cache_read_missing");
  if (!explicit || explicit.later_cache_hit_rate < criteria.min_later_hit_rate) {
    expectedFailures.push("later_cache_hit_rate_below_threshold");
  }
  const actualFailures = [...new Set(manifest.failures)];
  if (actualFailures.length !== manifest.failures.length
    || expectedFailures.length !== actualFailures.length
    || expectedFailures.some(code => !actualFailures.includes(code))) {
    fail(`inconsistent_${expectedGate}_failures`);
  }

  return {
    evidence_sha256: manifest.evidence_sha256,
    gate: manifest.gate,
    verified: manifest.verified,
    transport: manifest.transport,
    model: manifest.model,
    dry_run: manifest.dry_run,
    sources: normalizedSources,
    explicit,
    failures: [...manifest.failures],
  };
}

function sameSource(left, right) {
  if (left === null || right === null) return left === right;
  return left.type === right.type
    && left.hash === right.hash
    && left.chars === right.chars
    && left.complete === right.complete
    && left.endpoint_hash === right.endpoint_hash
    && left.etag_hash === right.etag_hash;
}

function isWorkerSource(source) {
  return ["worker", "worker-access", "worker-mcp-oauth"].includes(source?.type);
}

function allSourcesMatchType(evidence, type) {
  return evidence.sources.core.type === type
    && (evidence.sources.project === null || evidence.sources.project.type === type);
}

function proxyOnlyCacheProof(proxy) {
  const explicit = proxy.explicit;
  const cacheReadObserved = explicit?.later_cache_hit_requests > 0;
  const strictWriteAndRead = proxy.verified === true;
  // Codex OAuth currently exposes later cached_tokens but not a cache-write
  // counter. Accept only that one exact observability gap; every other strict
  // gate failure remains disqualifying and is recomputed above.
  const readObservedWithoutWriteCounter = proxy.verified === false
    && proxy.failures.length === 1
    && proxy.failures[0] === "initial_cache_write_missing"
    && explicit?.all_requests_successful === true
    && explicit.run1_cache_write_observed === false
    && cacheReadObserved;
  return {
    accepted: strictWriteAndRead || readObservedWithoutWriteCounter,
    basis: strictWriteAndRead
      ? "write-and-read-observed"
      : readObservedWithoutWriteCounter ? "cache-read-observed" : "insufficient",
    cache_write_observed: explicit?.run1_cache_write_observed === true,
    cache_read_observed: cacheReadObserved,
  };
}

/** Build one deterministic, sanitized verdict from the two strict gates. */
export function buildQualificationManifest(directValue, proxyValue, { expectedProxyTransport = null } = {}) {
  if (!isCustomTransport(expectedProxyTransport)) fail("expected_proxy_transport_required");
  const direct = compactEvidence(directValue, "direct", null);
  const proxy = proxyValue === null ? null : compactEvidence(proxyValue, "proxy", expectedProxyTransport);
  const failures = [];

  if (!direct.verified) failures.push("direct_not_verified");
  if (direct.dry_run) failures.push("direct_live_measurement_required");
  if (!isWorkerSource(direct.sources.core) || (direct.sources.project && !isWorkerSource(direct.sources.project))) {
    failures.push("direct_worker_source_required");
  }

  let coreMatch = false;
  let projectMatch = false;
  let modelMatch = false;
  let breakpointMatch = false;
  if (!proxy) {
    failures.push("proxy_not_run");
  } else {
    if (!proxy.verified) failures.push("proxy_not_verified");
    if (proxy.dry_run) failures.push("proxy_live_measurement_required");
    if (!isWorkerSource(proxy.sources.core) || (proxy.sources.project && !isWorkerSource(proxy.sources.project))) {
      failures.push("proxy_worker_source_required");
    }
    coreMatch = sameSource(direct.sources.core, proxy.sources.core);
    projectMatch = sameSource(direct.sources.project, proxy.sources.project);
    modelMatch = direct.model === proxy.model;
    breakpointMatch = direct.explicit?.explicit_breakpoints === proxy.explicit?.explicit_breakpoints;
    if (!coreMatch) failures.push("core_capsule_changed_between_paths");
    if (!projectMatch) failures.push("project_capsule_changed_between_paths");
    if (!modelMatch) failures.push("model_mismatch_between_paths");
    if (!breakpointMatch) failures.push("breakpoint_mismatch_between_paths");
  }

  return {
    schema: PROMPT_CACHE_QUALIFICATION_SCHEMA,
    verified: failures.length === 0,
    expected_proxy_transport: expectedProxyTransport,
    direct,
    proxy,
    consistency: {
      core_match: coreMatch,
      project_match: projectMatch,
      model_match: modelMatch,
      explicit_breakpoints_match: breakpointMatch,
    },
    failures: [...new Set(failures)],
  };
}


/**
 * Build a deliberately separate verdict for installations that use only the
 * CLIProxyAPI -> Codex OAuth path. It never fabricates an official direct gate
 * and only accepts Capsules fetched through an owner-controlled OAuth boundary.
 */
export function buildProxyOnlyQualificationManifest(proxyValue, {
  expectedProxyTransport = null,
  proxyCredentialSource = null,
} = {}) {
  if (!isCustomTransport(expectedProxyTransport)) fail("expected_proxy_transport_required");
  if (proxyCredentialSource !== "environment" && proxyCredentialSource !== "systemd-credential") {
    fail("invalid_proxy_credential_source");
  }
  const proxy = compactEvidence(proxyValue, "proxy", expectedProxyTransport);
  const cacheProof = proxyOnlyCacheProof(proxy);
  const failures = [];
  if (!cacheProof.accepted) failures.push("proxy_not_verified");
  if (proxy.dry_run) failures.push("proxy_live_measurement_required");
  const managedOauthSource = allSourcesMatchType(proxy, "worker-mcp-oauth");
  const accessSource = allSourcesMatchType(proxy, "worker-access");
  if (!managedOauthSource && !accessSource) failures.push("oauth_worker_source_required");

  return {
    schema: PROMPT_CACHE_PROXY_QUALIFICATION_SCHEMA,
    mode: "proxy-only",
    verified: failures.length === 0,
    expected_proxy_transport: expectedProxyTransport,
    direct: {
      status: "not_applicable",
      reason: "cliproxy_oauth_only",
    },
    authentication: {
      capsule_source: managedOauthSource ? "mcp-managed-oauth" : "cloudflare-access",
      official_openai_api_key_used: false,
      proxy_client_credential_source: proxyCredentialSource,
    },
    cache_proof: {
      basis: cacheProof.basis,
      cache_write_observed: cacheProof.cache_write_observed,
      cache_read_observed: cacheProof.cache_read_observed,
    },
    proxy,
    failures: [...new Set(failures)],
  };
}
