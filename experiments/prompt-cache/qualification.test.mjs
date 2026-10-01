import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildProxyOnlyQualificationManifest,
  buildQualificationManifest,
} from "./qualification.mjs";
import { qualificationChildEnv, qualificationTimeoutMs } from "./qualify.mjs";

const H = "a".repeat(64);
const H2 = "b".repeat(64);
const H3 = "c".repeat(64);
const H4 = "d".repeat(64);
const EXPECTED_PROXY = "custom-123456789abc";

function source({ hash = H, endpoint = H2, etag = H3, project = false, type = "worker" } = {}) {
  if (project) return { type, hash, chars: 4000, complete: true, endpoint_hash: endpoint, etag_hash: etag };
  return { type, hash, chars: 8000, complete: true, endpoint_hash: endpoint, etag_hash: etag };
}

function evidence(gate, {
  verified = true,
  transport = gate === "direct" ? "openai-official" : "custom-123456789abc",
  model = "gpt-5.6-luna",
  core = source(),
  project = source({ hash: H4, endpoint: H3, etag: H2, project: true }),
  failures = [],
} = {}) {
  const runCount = 4;
  const expectedTransport = gate === "proxy" ? transport : null;
  const arm = name => ({
    arm: name,
    explicit_breakpoints: name === "explicit" ? (project ? 2 : 1) : 0,
    prompt_cache_key_hash: name === "explicit" ? H3 : H4,
    requests: runCount,
    successful_requests: runCount,
    failed_requests: 0,
    all_requests_successful: true,
    run1_cache_write_tokens: name === "explicit" ? 3000 : 0,
    run1_cache_write_observed: name === "explicit",
    later_requests: runCount - 1,
    later_cache_hit_requests: name === "explicit" ? runCount - 1 : 0,
    later_cache_hit_rate: name === "explicit" ? 1 : 0,
    later_cached_tokens_min: name === "explicit" ? 2800 : null,
    later_cached_tokens_max: name === "explicit" ? 2800 : null,
    strict_verified: name === "explicit",
  });
  const armNames = gate === "direct" ? ["implicit", "explicit"] : ["explicit"];
  return {
    schema: "prompt-cache-evidence.v1",
    experiment_version: "prompt-cache-ab.v1",
    evidence_sha256: gate === "direct" ? H : H2,
    gate,
    verified,
    transport,
    model,
    dry_run: false,
    experiment_id_hash: gate === "direct" ? H3 : H4,
    sources: { core, project },
    request_plan: { arms: armNames, runs_per_arm: runCount, delay_ms: 2000 },
    criteria: {
      require_worker_source: true,
      require_complete_capsules: true,
      min_later_hit_rate: 0.5,
      expected_transport: expectedTransport,
    },
    arms: armNames.map(arm),
    failures,
  };
}

function accessSources() {
  return {
    core: source({ type: "worker-access" }),
    project: source({ hash: H4, endpoint: H3, etag: H2, project: true, type: "worker-access" }),
  };
}

function mcpOauthSources() {
  return {
    core: source({ type: "worker-mcp-oauth" }),
    project: source({ hash: H4, endpoint: H3, etag: H2, project: true, type: "worker-mcp-oauth" }),
  };
}

function proxyReadOnlyEvidence() {
  const result = evidence("proxy", {
    verified: false,
    failures: ["initial_cache_write_missing"],
    ...accessSources(),
  });
  result.arms[0].run1_cache_write_tokens = 0;
  result.arms[0].run1_cache_write_observed = false;
  result.arms[0].strict_verified = false;
  return result;
}

function withoutLaterCacheRead(result) {
  const explicit = result.arms.find(arm => arm.arm === "explicit");
  explicit.later_cache_hit_requests = 0;
  explicit.later_cache_hit_rate = 0;
  explicit.later_cached_tokens_min = null;
  explicit.later_cached_tokens_max = null;
  explicit.strict_verified = false;
  return result;
}

test("qualification passes only two verified paths using the exact same Worker Capsules", () => {
  const manifest = buildQualificationManifest(evidence("direct"), evidence("proxy"), {
    expectedProxyTransport: EXPECTED_PROXY,
  });
  assert.equal(manifest.verified, true);
  assert.deepEqual(manifest.failures, []);
  assert.equal(manifest.consistency.core_match, true);
  assert.equal(manifest.consistency.project_match, true);
  assert.equal(manifest.consistency.model_match, true);
  assert.equal(manifest.consistency.explicit_breakpoints_match, true);
  assert.equal(JSON.stringify(manifest).includes("https://"), false);
});

test("proxy-only qualification records direct as not applicable and accepts Access sources", () => {
  const manifest = buildProxyOnlyQualificationManifest(evidence("proxy", {
    ...accessSources(),
  }), {
    expectedProxyTransport: EXPECTED_PROXY,
    proxyCredentialSource: "systemd-credential",
  });
  assert.equal(manifest.schema, "prompt-cache-proxy-qualification.v1");
  assert.equal(manifest.mode, "proxy-only");
  assert.equal(manifest.verified, true);
  assert.deepEqual(manifest.direct, {
    status: "not_applicable",
    reason: "cliproxy_oauth_only",
  });
  assert.deepEqual(manifest.authentication, {
    capsule_source: "cloudflare-access",
    official_openai_api_key_used: false,
    proxy_client_credential_source: "systemd-credential",
  });
  assert.deepEqual(manifest.cache_proof, {
    basis: "write-and-read-observed",
    cache_write_observed: true,
    cache_read_observed: true,
  });
});

test("proxy-only qualification recognizes host-local MCP Managed OAuth sources", () => {
  const manifest = buildProxyOnlyQualificationManifest(evidence("proxy", {
    ...mcpOauthSources(),
  }), {
    expectedProxyTransport: EXPECTED_PROXY,
    proxyCredentialSource: "systemd-credential",
  });
  assert.equal(manifest.verified, true);
  assert.equal(manifest.authentication.capsule_source, "mcp-managed-oauth");
  assert.equal(manifest.authentication.official_openai_api_key_used, false);
});

test("proxy-only qualification accepts observed cache reads without inventing a write counter", () => {
  const manifest = buildProxyOnlyQualificationManifest(proxyReadOnlyEvidence(), {
    expectedProxyTransport: EXPECTED_PROXY,
    proxyCredentialSource: "systemd-credential",
  });
  assert.equal(manifest.verified, true);
  assert.equal(manifest.proxy.verified, false);
  assert.deepEqual(manifest.proxy.failures, ["initial_cache_write_missing"]);
  assert.deepEqual(manifest.cache_proof, {
    basis: "cache-read-observed",
    cache_write_observed: false,
    cache_read_observed: true,
  });
  assert.deepEqual(manifest.failures, []);
});

test("proxy-only read proof rejects every failure beyond an unobserved write counter", () => {
  const missingRead = withoutLaterCacheRead(proxyReadOnlyEvidence());
  missingRead.failures = [
    "initial_cache_write_missing",
    "later_cache_read_missing",
    "later_cache_hit_rate_below_threshold",
  ];
  const manifest = buildProxyOnlyQualificationManifest(missingRead, {
    expectedProxyTransport: EXPECTED_PROXY,
    proxyCredentialSource: "systemd-credential",
  });
  assert.equal(manifest.verified, false);
  assert.ok(manifest.failures.includes("proxy_not_verified"));

  const incomplete = proxyReadOnlyEvidence();
  incomplete.sources.core.complete = false;
  assert.throws(() => buildProxyOnlyQualificationManifest(incomplete, {
    expectedProxyTransport: EXPECTED_PROXY,
    proxyCredentialSource: "systemd-credential",
  }), /inconsistent_proxy_failures/);

  const dryRun = proxyReadOnlyEvidence();
  dryRun.dry_run = true;
  assert.throws(() => buildProxyOnlyQualificationManifest(dryRun, {
    expectedProxyTransport: EXPECTED_PROXY,
    proxyCredentialSource: "systemd-credential",
  }), /inconsistent_proxy_failures/);
});

test("proxy-only qualification cannot certify a static-bearer Capsule source", () => {
  const manifest = buildProxyOnlyQualificationManifest(evidence("proxy"), {
    expectedProxyTransport: EXPECTED_PROXY,
    proxyCredentialSource: "environment",
  });
  assert.equal(manifest.verified, false);
  assert.ok(manifest.failures.includes("oauth_worker_source_required"));
  assert.throws(() => buildProxyOnlyQualificationManifest(evidence("proxy"), {
    expectedProxyTransport: EXPECTED_PROXY,
    proxyCredentialSource: "invented",
  }), /invalid_proxy_credential_source/);
});

test("a direct failure stops qualification before proxy", () => {
  const direct = evidence("direct", {
    verified: false,
    failures: ["initial_cache_write_missing"],
  });
  const explicit = direct.arms.find(arm => arm.arm === "explicit");
  explicit.run1_cache_write_tokens = 0;
  explicit.run1_cache_write_observed = false;
  explicit.strict_verified = false;
  const manifest = buildQualificationManifest(direct, null, { expectedProxyTransport: EXPECTED_PROXY });
  assert.equal(manifest.verified, false);
  assert.ok(manifest.failures.includes("direct_not_verified"));
  assert.ok(manifest.failures.includes("proxy_not_run"));
  assert.equal(manifest.proxy, null);
});

test("a proxy failure stays visible without copying raw evidence", () => {
  const proxy = withoutLaterCacheRead(evidence("proxy", {
    verified: false,
    failures: ["later_cache_read_missing", "later_cache_hit_rate_below_threshold"],
  }));
  const manifest = buildQualificationManifest(evidence("direct"), proxy, {
    expectedProxyTransport: EXPECTED_PROXY,
  });
  assert.equal(manifest.verified, false);
  assert.ok(manifest.failures.includes("proxy_not_verified"));
  assert.deepEqual(manifest.proxy.failures, [
    "later_cache_read_missing",
    "later_cache_hit_rate_below_threshold",
  ]);
});

test("Capsule changes between official and proxy paths fail closed", () => {
  const changedCore = source({ hash: "e".repeat(64) });
  const manifest = buildQualificationManifest(
    evidence("direct"),
    evidence("proxy", { core: changedCore }),
    { expectedProxyTransport: EXPECTED_PROXY },
  );
  assert.equal(manifest.verified, false);
  assert.ok(manifest.failures.includes("core_capsule_changed_between_paths"));
});

test("project presence and ETag changes are part of source consistency", () => {
  const absent = evidence("proxy", { project: null });
  const first = buildQualificationManifest(evidence("direct"), absent, { expectedProxyTransport: EXPECTED_PROXY });
  assert.ok(first.failures.includes("project_capsule_changed_between_paths"));
  assert.ok(first.failures.includes("breakpoint_mismatch_between_paths"));

  const changed = source({ hash: H4, endpoint: H3, etag: "f".repeat(64), project: true });
  const second = buildQualificationManifest(evidence("direct"), evidence("proxy", { project: changed }), {
    expectedProxyTransport: EXPECTED_PROXY,
  });
  assert.ok(second.failures.includes("project_capsule_changed_between_paths"));
});

test("gate labels, evidence schema, and source shape cannot be relabelled", () => {
  assert.throws(() => buildQualificationManifest(
    { ...evidence("direct"), gate: "proxy" },
    evidence("proxy"),
    { expectedProxyTransport: EXPECTED_PROXY },
  ), /invalid_direct_manifest/);

  assert.throws(() => buildQualificationManifest(
    evidence("direct"),
    { ...evidence("proxy"), schema: "other" },
    { expectedProxyTransport: EXPECTED_PROXY },
  ), /invalid_proxy_manifest/);

  assert.throws(() => buildQualificationManifest(
    evidence("direct", { core: { ...source(), endpoint_hash: null } }),
    evidence("proxy"),
    { expectedProxyTransport: EXPECTED_PROXY },
  ), /invalid_worker_source/);
});

test("the exact expected proxy fingerprint is mandatory", () => {
  assert.throws(
    () => buildQualificationManifest(evidence("direct"), evidence("proxy")),
    /expected_proxy_transport_required/,
  );
  assert.throws(
    () => buildQualificationManifest(evidence("direct"), evidence("proxy"), {
      expectedProxyTransport: "custom-abcdef123456",
    }),
    /invalid_proxy_transport/,
  );
});

test("model equality is a qualification requirement", () => {
  const manifest = buildQualificationManifest(
    evidence("direct"),
    evidence("proxy", { model: "another-model" }),
    { expectedProxyTransport: EXPECTED_PROXY },
  );
  assert.equal(manifest.verified, false);
  assert.ok(manifest.failures.includes("model_mismatch_between_paths"));
});

test("tampered verdicts and unknown schema fields fail closed", () => {
  const inconsistent = evidence("direct");
  inconsistent.arms[1].strict_verified = false;
  assert.throws(
    () => buildQualificationManifest(inconsistent, evidence("proxy"), {
      expectedProxyTransport: EXPECTED_PROXY,
    }),
    /inconsistent_arm_verdict/,
  );

  const unknown = { ...evidence("direct"), private_memory: "hidden" };
  assert.throws(
    () => buildQualificationManifest(unknown, evidence("proxy"), {
      expectedProxyTransport: EXPECTED_PROXY,
    }),
    /invalid_direct_manifest_fields/,
  );

  const incomplete = evidence("direct");
  incomplete.sources.core.complete = false;
  assert.throws(
    () => buildQualificationManifest(incomplete, evidence("proxy"), {
      expectedProxyTransport: EXPECTED_PROXY,
    }),
    /inconsistent_direct_verdict/,
  );
});

test("direct and proxy child environments cannot leak credentials across paths", () => {
  const environment = {
    PATH: "/usr/bin",
    SECOND_BRAIN_AUTH_TOKEN: "worker-secret",
    OPENAI_API_KEY: "stale-key",
    OPENAI_BASE_URL: "https://stale.example/v1",
    OPENAI_MODEL: "stale-model",
    OPENAI_ORG_ID: "org-official",
    OPENAI_PROJECT_ID: "project-official",
    PROMPT_CACHE_PROXY_API_KEY: "proxy-secret",
    PROMPT_CACHE_PROXY_BASE_URL: "https://proxy.example/v1",
    PROMPT_CACHE_DIRECT_MODEL: "direct-model",
    PROMPT_CACHE_PROXY_MODEL: "proxy-model",
    CREDENTIALS_DIRECTORY: "/run/credentials/qualify.service",
  };
  const direct = qualificationChildEnv({
    environment,
    label: "direct",
    apiKey: "direct-key",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-direct",
  });
  assert.equal(direct.OPENAI_API_KEY, "direct-key");
  assert.equal(direct.OPENAI_ORG_ID, "org-official");
  assert.equal(direct.OPENAI_PROJECT_ID, "project-official");
  assert.equal(direct.PROMPT_CACHE_PROXY_API_KEY, undefined);

  const proxy = qualificationChildEnv({
    environment,
    label: "proxy",
    apiKey: "proxy-key",
    baseUrl: "http://127.0.0.1:8317/v1",
    model: "gpt-proxy",
    sourceAuth: "access",
  });
  assert.equal(proxy.OPENAI_API_KEY, "proxy-key");
  assert.equal(proxy.OPENAI_ORG_ID, undefined);
  assert.equal(proxy.OPENAI_PROJECT_ID, undefined);
  assert.equal(proxy.PROMPT_CACHE_PROXY_API_KEY, undefined);
  assert.equal(proxy.SECOND_BRAIN_AUTH_TOKEN, undefined);
  assert.equal(proxy.CREDENTIALS_DIRECTORY, undefined);
  assert.equal(direct.CREDENTIALS_DIRECTORY, undefined);
});

test("child timeouts cover every request timeout and configured delay", () => {
  assert.equal(qualificationTimeoutMs({ runs: 4, delayMs: 2000, arm: "both" }),
    (8 * 185000) + (6 * 2000) + 30000);
  assert.equal(qualificationTimeoutMs({ runs: 4, delayMs: 2000, arm: "explicit" }),
    (4 * 185000) + (3 * 2000) + 30000);
});

test("CLI starts and requires an explicit direct model before network access", () => {
  const qualifyPath = fileURLToPath(new URL("./qualify.mjs", import.meta.url));
  const help = spawnSync(process.execPath, [qualifyPath, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--direct-model ID/);
  assert.match(help.stdout, /--output qualification\|measurement\|artifacts/);

  const result = spawnSync(process.execPath, [
    qualifyPath,
    "--worker-url", "https://brain.example",
    "--proxy-base-url", "http://127.0.0.1:8317/v1",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PROMPT_CACHE_DIRECT_MODEL: "",
      OPENAI_MODEL: "gpt-5.6-luna",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"code":"direct_model_required"/);
});

test("measurement and paired artifact output are restricted to the proxy-only contract", () => {
  const qualifyPath = fileURLToPath(new URL("./qualify.mjs", import.meta.url));
  for (const [output, code] of [
    ["measurement", "measurement_requires_proxy_only"],
    ["artifacts", "artifacts_require_proxy_only"],
  ]) {
    const result = spawnSync(process.execPath, [
      qualifyPath,
      "--mode", "compare",
      "--output", output,
      "--worker-url", "https://brain.example",
      "--proxy-base-url", "http://127.0.0.1:8317/v1",
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`"code":"${code}"`));
  }
});

test("proxy-only CLI does not require official OpenAI or Second Brain bearer credentials", () => {
  const qualifyPath = fileURLToPath(new URL("./qualify.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [
    qualifyPath,
    "--mode", "proxy-only",
    "--worker-url", "https://brain.example",
    "--proxy-base-url", "http://127.0.0.1:8317/v1",
    "--proxy-model", "gpt-5.6-luna",
    "--mcp-credential-file", "/tmp/nonexistent-second-brain-oauth.json",
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"code":"proxy_api_key_missing"/);
  assert.doesNotMatch(result.stderr, /direct_api_key_missing|worker_auth_token_missing/);
});
