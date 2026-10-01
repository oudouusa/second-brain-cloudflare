import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PromptCacheEvidenceError,
  parseEvidenceJsonl,
  verifyEvidence,
} from "./verify.mjs";

const H = "a".repeat(64);
const H2 = "b".repeat(64);
const H3 = "c".repeat(64);
const H4 = "d".repeat(64);

function evidence({
  transport = "openai-official",
  dryRun = false,
  source = "worker",
  complete = true,
  run1Write = 3000,
  laterCached = [2800, 2800, 2800],
  errorRun = null,
  project = true,
} = {}) {
  const workerSource = ["worker", "worker-access", "worker-mcp-oauth"].includes(source);
  const arms = ["implicit", "explicit"];
  const runs = 4;
  const start = {
    event: "prompt_cache_experiment_start",
    version: "prompt-cache-ab.v1",
    transport,
    model: "gpt-5.6-luna",
    arms,
    runs_per_arm: runs,
    delay_ms: 2000,
    experiment_id_hash: H4,
    core_source: source,
    project_source: project ? source : null,
    core_hash: H,
    core_chars: 9000,
    project_hash: project ? H2 : null,
    project_chars: project ? 9000 : null,
    core_complete: complete,
    project_complete: project ? complete : null,
    core_endpoint_hash: workerSource ? H3 : null,
    project_endpoint_hash: project && workerSource ? H4 : null,
    core_etag_hash: workerSource ? H4 : null,
    project_etag_hash: project && workerSource ? H3 : null,
    dry_run: dryRun,
  };
  const records = [start];
  for (const arm of arms) {
    for (let run = 1; run <= runs; run++) {
      const common = {
        version: "prompt-cache-ab.v1",
        transport,
        arm,
        run,
        model: "gpt-5.6-luna",
        prompt_cache_key_hash: arm === "explicit" ? H2 : H3,
        mode: arm,
        ttl: arm === "explicit" ? "30m" : null,
        explicit_breakpoints: arm === "explicit" ? (project ? 2 : 1) : 0,
        core_hash: H,
        core_chars: 9000,
        project_hash: project ? H2 : null,
        project_chars: project ? 9000 : null,
        suffix_hash: String(run).repeat(64),
        suffix_chars: 60,
      };
      if (dryRun) {
        records.push({ event: "prompt_cache_dry_run", ...common });
      } else if (run === errorRun && arm === "explicit") {
        records.push({
          event: "prompt_cache_error",
          ...common,
          error_name: "Error",
          http_status: 503,
          request_id_hash: null,
        });
      } else {
        const cached = arm === "explicit" && run > 1 ? laterCached[run - 2] : 0;
        const write = arm === "explicit" && run === 1 ? run1Write : 0;
        records.push({
          event: "prompt_cache_usage",
          ...common,
          request_id_hash: H,
          input_tokens: 4000,
          cache_write_tokens: write,
          cached_tokens: cached,
          output_tokens: 1,
          total_tokens: 4001,
          cache_hit_ratio: cached / 4000,
          cache_write_ratio: write / 4000,
          latency_ms: 100,
        });
      }
    }
  }
  const summaries = arms.map((arm) => {
    const selected = records.filter(record => record.arm === arm);
    const usage = selected.filter(record => record.event === "prompt_cache_usage");
    const later = usage.filter(record => record.run > 1);
    const cached = later.map(record => record.cached_tokens).filter(Number.isFinite);
    const writeObserved = usage.some(record => Number(record.cache_write_tokens) > 0);
    const readObserved = later.some(record => Number(record.cached_tokens) > 0);
    return {
      arm,
      successful_requests: usage.length,
      failed_requests: selected.filter(record => record.event === "prompt_cache_error").length,
      cache_write_observed: writeObserved,
      later_cache_read_observed: readObserved,
      later_cached_tokens_min: cached.length ? Math.min(...cached) : null,
      later_cached_tokens_max: cached.length ? Math.max(...cached) : null,
      verified: writeObserved && readObserved,
    };
  });
  records.push({ event: "prompt_cache_experiment_summary", version: "prompt-cache-ab.v1", summaries });
  return records.map(record => JSON.stringify(record)).join("\n") + "\n";
}

test("direct gate verifies an official live Worker experiment", () => {
  const manifest = verifyEvidence(evidence(), {
    gate: "direct",
    requireWorkerSource: true,
  });
  assert.equal(manifest.verified, true);
  assert.deepEqual(manifest.failures, []);
  assert.equal(manifest.arms.find(arm => arm.arm === "explicit").later_cache_hit_rate, 1);
  assert.equal(JSON.stringify(manifest).includes("Bearer"), false);
});

test("proxy gate requires an exact precomputed custom transport binding", () => {
  const expectedTransport = "custom-123456789abc";
  const manifest = verifyEvidence(evidence({ transport: "custom-123456789abc" }), {
    gate: "proxy",
    requireWorkerSource: true,
    expectedTransport,
  });
  assert.equal(manifest.verified, true);
  assert.equal(manifest.criteria.expected_transport, expectedTransport);

  const missing = verifyEvidence(evidence({ transport: expectedTransport }), { gate: "proxy" });
  assert.ok(missing.failures.includes("expected_proxy_transport_required"));

  const mismatch = verifyEvidence(evidence({ transport: expectedTransport }), {
    gate: "proxy",
    expectedTransport: "custom-abcdef123456",
  });
  assert.ok(mismatch.failures.includes("proxy_transport_mismatch"));

  const official = verifyEvidence(evidence(), {
    gate: "proxy",
    expectedTransport,
  });
  assert.ok(official.failures.includes("proxy_transport_required"));

  assert.throws(
    () => verifyEvidence(evidence({ transport: expectedTransport }), {
      gate: "proxy",
      expectedTransport: "https://private.example/v1",
    }),
    /safe custom transport label/,
  );
});

test("a dry run is structurally valid but cannot verify a live transport", () => {
  assert.equal(verifyEvidence(evidence({ dryRun: true }), { gate: "structure" }).verified, true);
  const manifest = verifyEvidence(evidence({ dryRun: true }), { gate: "direct" });
  assert.equal(manifest.verified, false);
  assert.ok(manifest.failures.includes("live_measurement_required"));
});

test("the strict gate requires the first explicit request to write and later requests to read", () => {
  const noWrite = verifyEvidence(evidence({ run1Write: 0 }), { gate: "direct" });
  assert.equal(noWrite.verified, false);
  assert.ok(noWrite.failures.includes("initial_cache_write_missing"));

  const noRead = verifyEvidence(evidence({ laterCached: [0, 0, 0] }), { gate: "direct" });
  assert.equal(noRead.verified, false);
  assert.ok(noRead.failures.includes("later_cache_read_missing"));
});

test("later cache hit rate and request failures are explicit gate failures", () => {
  const lowRate = verifyEvidence(evidence({ laterCached: [2800, 0, 0] }), {
    gate: "direct",
    minLaterHitRate: 0.75,
  });
  assert.ok(lowRate.failures.includes("later_cache_hit_rate_below_threshold"));

  const failed = verifyEvidence(evidence({ errorRun: 3 }), { gate: "direct" });
  assert.ok(failed.failures.includes("explicit_requests_failed"));
});

test("worker-source and completeness requirements are fail closed", () => {
  const fileSource = verifyEvidence(evidence({ source: "file" }), {
    gate: "direct",
    requireWorkerSource: true,
  });
  assert.ok(fileSource.failures.includes("worker_source_required"));

  const accessSource = verifyEvidence(evidence({ source: "worker-access" }), {
    gate: "direct",
    requireWorkerSource: true,
  });
  assert.equal(accessSource.verified, true);
  assert.equal(accessSource.sources.core.type, "worker-access");

  const mcpSource = verifyEvidence(evidence({ source: "worker-mcp-oauth" }), {
    gate: "direct",
    requireWorkerSource: true,
  });
  assert.equal(mcpSource.verified, true);
  assert.equal(mcpSource.sources.core.type, "worker-mcp-oauth");

  const incomplete = verifyEvidence(evidence({ complete: false }), { gate: "direct" });
  assert.ok(incomplete.failures.includes("incomplete_capsule"));
  assert.equal(verifyEvidence(evidence({ complete: false }), {
    gate: "direct",
    allowIncompleteCapsules: true,
  }).verified, true);
});

test("prefix mutations, duplicate suffixes, and summary drift are rejected", () => {
  const prefix = parseEvidenceJsonl(evidence());
  prefix[2].core_hash = H4;
  assert.throws(
    () => verifyEvidence(prefix.map(JSON.stringify).join("\n")),
    error => error instanceof PromptCacheEvidenceError && error.code === "core_prefix_changed",
  );

  const suffix = parseEvidenceJsonl(evidence());
  suffix[2].suffix_hash = suffix[1].suffix_hash;
  assert.throws(
    () => verifyEvidence(suffix.map(JSON.stringify).join("\n")),
    error => error instanceof PromptCacheEvidenceError && error.code === "suffix_not_changing",
  );

  const summary = parseEvidenceJsonl(evidence());
  summary.at(-1).summaries[1].successful_requests = 3;
  assert.throws(
    () => verifyEvidence(summary.map(JSON.stringify).join("\n")),
    error => error instanceof PromptCacheEvidenceError && error.code === "summary_metric_mismatch",
  );
});

test("evidence containing unknown fields, raw prompt, URL, or credential shapes is rejected", () => {
  const unknown = parseEvidenceJsonl(evidence());
  unknown[1].note = "private memory hidden under an innocent key";
  assert.throws(
    () => verifyEvidence(unknown.map(JSON.stringify).join("\n")),
    error => error instanceof PromptCacheEvidenceError && error.code === "unexpected_field",
  );

  const rawPrompt = parseEvidenceJsonl(evidence());
  rawPrompt[1].prompt = "private memory";
  assert.throws(
    () => verifyEvidence(rawPrompt.map(JSON.stringify).join("\n")),
    error => error instanceof PromptCacheEvidenceError && error.code === "forbidden_field",
  );

  const url = parseEvidenceJsonl(evidence());
  url[0].unexpected = "https://private.example";
  assert.throws(
    () => verifyEvidence(url.map(JSON.stringify).join("\n")),
    error => error instanceof PromptCacheEvidenceError && error.code === "unsafe_string_value",
  );
});

test("cache read and write subsets cannot jointly exceed input tokens", () => {
  const records = parseEvidenceJsonl(evidence());
  const usage = records.find(record => record.event === "prompt_cache_usage" && record.arm === "explicit" && record.run === 2);
  usage.cache_write_tokens = 2500;
  usage.cached_tokens = 2500;
  usage.cache_hit_ratio = 0.625;
  usage.cache_write_ratio = 0.625;
  assert.throws(
    () => verifyEvidence(records.map(JSON.stringify).join("\n")),
    error => error instanceof PromptCacheEvidenceError && error.code === "cache_tokens_exceed_input",
  );
});

test("CLI rejects oversized stdin before accepting the evidence body", () => {
  const verifyPath = fileURLToPath(new URL("./verify.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [verifyPath, "--input", "-"], {
    input: Buffer.alloc((2 * 1024 * 1024) + 1, 0x20),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"code":"input_too_large"/);
});

test("CLI rejects an oversized named input through the same bounded path", () => {
  const verifyPath = fileURLToPath(new URL("./verify.mjs", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "prompt-cache-evidence-"));
  const path = join(directory, "oversized.jsonl");
  try {
    writeFileSync(path, Buffer.alloc((2 * 1024 * 1024) + 1, 0x20));
    const result = spawnSync(process.execPath, [verifyPath, "--input", path], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /"code":"input_too_large"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("core-only experiments preserve a one-breakpoint explicit contract", () => {
  const manifest = verifyEvidence(evidence({ project: false }), { gate: "direct" });
  assert.equal(manifest.verified, true);
  assert.equal(manifest.sources.project, null);
});
