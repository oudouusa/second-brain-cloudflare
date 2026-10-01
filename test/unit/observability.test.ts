import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import worker from "../../src/index";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { boundRequestBody } from "../../src/lib/http";
import { sanitizeConsoleArguments } from "../../src/lib/observability";

const ROOT = resolve(import.meta.dirname, "../..");

function wranglerConfig(): any {
  const raw = readFileSync(resolve(ROOT, "wrangler.jsonc"), "utf8");
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
}

describe("privacy-safe Workers observability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reconstructs an authenticated zero-byte POST after bounding its body", async () => {
    const original = new Request("https://brain.test/admin/backup", {
      method: "POST",
      body: new Uint8Array(),
    });
    expect(original.body).not.toBeNull();

    const bounded = await boundRequestBody(original, 1024);

    expect(bounded.ok).toBe(true);
    if (bounded.ok) expect((await bounded.request.arrayBuffer()).byteLength).toBe(0);
  });

  it("persists custom logs without automatic full-URL invocation logs", () => {
    const observability = wranglerConfig().observability;
    expect(observability).toMatchObject({
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 1, invocation_logs: false },
    });
  });

  it("logs recall outcome, duration, candidate count and fallback without private inputs", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const privateQuery = "PRIVATE-QUERY-DO-NOT-LOG";
    const env = makeTestEnv();
    const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

    const response = await worker.fetch(req("POST", "/recall", { body: { query: privateQuery } }), env, ctx);

    expect(response.status).toBe(200);
    const logs = [...info.mock.calls, ...error.mock.calls].flat().join("\n");
    expect(logs).toContain('"event":"recall_complete"');
    expect(logs).toContain('"event":"http_request"');
    expect(logs).toContain('"candidate_count"');
    expect(logs).toContain('"fallback_used"');
    expect(logs).toContain('"graph_hops"');
    expect(logs).toContain('"graph_seed_count"');
    expect(logs).toContain('"graph_expanded_count"');
    expect(logs).toContain('"graph_eligible_count"');
    expect(logs).toContain('"graph_selected_count"');
    expect(logs).toContain('"query_signal_cache_hit"');
    expect(logs).toContain('"lineage_fallback_used"');
    expect(logs).toContain('"duration_ms"');
    expect(logs).not.toContain(privateQuery);
    expect(logs).not.toContain("test-token");
    expect(logs).not.toContain("Authorization");
    expect(logs).not.toContain("query=");
  });

  it("records classify-pending as its own operation instead of other", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = makeTestEnv();
    const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

    const response = await worker.fetch(req("POST", "/classify-pending"), env, ctx);

    expect(response.status).toBe(200);
    const logs = info.mock.calls.flat().join("\n");
    expect(logs).toContain('"event":"http_request"');
    expect(logs).toContain('"operation":"classify-pending"');
  });

  it("reduces arbitrary console arguments and errors to a metadata-only event", () => {
    const secret = "PRIVATE-MEMORY-ID-AND-TAG";
    const [line] = sanitizeConsoleArguments("error", [
      `failed for ${secret}`,
      new Error(`stack contains ${secret}`),
    ]);

    expect(JSON.parse(line)).toEqual({ event: "internal_log", severity: "error" });
    expect(line).not.toContain(secret);
    expect(line).not.toContain("stack");
  });

  it("passes only allowlisted structured events and rejects extra dynamic fields", () => {
    const safe = JSON.stringify({
      event: "http_request",
      operation: "recall",
      method: "GET",
      status: 200,
      outcome: "success",
      duration_ms: 1.25,
    });
    expect(sanitizeConsoleArguments("log", [safe])).toEqual([safe]);

    const unsafe = JSON.stringify({ ...JSON.parse(safe), memory_id: "private-id" });
    const [line] = sanitizeConsoleArguments("log", [unsafe]);
    expect(JSON.parse(line)).toEqual({ event: "internal_log", severity: "info" });
    expect(line).not.toContain("private-id");

    const schema = JSON.stringify({
      event: "scheduled_job",
      operation: "graph_pass",
      outcome: "success",
      duration_ms: 1,
      schema_initialized: true,
    });
    expect(sanitizeConsoleArguments("log", [schema])).toEqual([schema]);

    const insight = JSON.stringify({
      event: "insight_weekly",
      candidates_drawn: 10,
      candidates_reasoned: 4,
      declined_by_model: 2,
      validation_deferred: 1,
      validation_exhausted: 1,
      invalid_format: 1,
      invalid_language: 0,
      invalid_evidence: 1,
      invalid_restatement: 0,
      restatements_suppressed: 1,
      written: 1,
    });
    expect(sanitizeConsoleArguments("log", [insight])).toEqual([insight]);

    const provider = JSON.stringify({
      event: "ai_provider_call",
      provider: "chatgpt",
      operation: "classify",
      model: "gpt-5.6-luna",
      status: "ok",
      latency_ms: 125,
      prompt_chars: 700,
      completion_chars: 58,
      prompt_tokens: 300,
      completion_tokens: 20,
      total_tokens: 320,
    });
    expect(sanitizeConsoleArguments("log", [provider])).toEqual([provider]);

    const unsafeProvider = JSON.stringify({
      ...JSON.parse(provider),
      prompt: "private memory content",
    });
    const [providerLine] = sanitizeConsoleArguments("log", [unsafeProvider]);
    expect(JSON.parse(providerLine)).toEqual({ event: "internal_log", severity: "info" });

    const lineageFallback = JSON.stringify({
      event: "recall_lineage_fallback",
      operation: "recall",
      outcome: "degraded",
      error_name: "Error",
    });
    expect(sanitizeConsoleArguments("error", [lineageFallback])).toEqual([lineageFallback]);
  });

  it("keeps the reranker step's route and numbers but drops its error text", () => {
    const applied = sanitizeConsoleArguments("info", [JSON.stringify({ rerank: "applied", ms: 412, n: 18 })]);
    expect(JSON.parse(applied[0])).toEqual({ event: "reranker_step", rerank: "applied", ms: 412, n: 18 });

    const secret = "PRIVATE-MEMORY-TEXT";
    const [failed] = sanitizeConsoleArguments("error", [JSON.stringify({ rerank: "error", ms: 20, reason: secret })]);
    expect(JSON.parse(failed)).toEqual({ event: "reranker_step", rerank: "error", ms: 20 });
    expect(failed).not.toContain(secret);

    for (const shape of [{ rerank: secret, ms: 1 }, { rerank: "applied", ms: 1, query: secret }, { rerank: "applied", ms: secret }]) {
      const [line] = sanitizeConsoleArguments("info", [JSON.stringify(shape)]);
      expect(JSON.parse(line)).toEqual({ event: "internal_log", severity: "info" });
    }
  });

  it("records scheduled jobs as blocked while an unfinished restore barrier exists", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const db = makeTestDb();
    db.restoreState = {
      id: "r2-v1",
      backup_id: "2026/08/1787661296000",
      backup_sha256: "sha256",
      run_id: "restore-run",
      started_at: Date.now(),
      next_offset: 40,
      next_edge_offset: 0,
      completed_at: null,
      lease_owner: null,
      lease_expires_at: null,
    };
    const env = makeTestEnv(db);
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
    } as unknown as ExecutionContext;

    await (worker as any).scheduled({ cron: "0 1 * * *" }, env, ctx);
    await Promise.all(pending);

    const logs = info.mock.calls.flat().join("\n");
    // This trigger admits the three SQLite writers together as
    // one job, so a restore barrier produces one blocked outcome, not three
    // concurrent jobs racing the same database.
    expect(logs.match(/"event":"scheduled_job"/g)).toHaveLength(1);
    expect(logs.match(/"outcome":"blocked"/g)).toHaveLength(1);
    expect(logs).toContain('"operation":"nightly_maintenance"');
    expect(db.entries).toHaveLength(0);
    expect(db.edges).toHaveLength(0);
  });

  it("turns a top-level exception into a generic 500 without logging its message or stack", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const privateValue = "PRIVATE-TOP-LEVEL-DETAIL";
    const env = makeTestEnv();
    Object.defineProperty(env, "AUTH_TOKEN", {
      get: () => { throw new Error(privateValue); },
    });
    const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

    const response = await worker.fetch(req("GET", "/health"), env, ctx);
    const body = await response.json() as Record<string, unknown>;
    const logs = error.mock.calls.flat().join("\n");

    expect(response.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "Internal server error" });
    expect(logs).toContain('"event":"http_request"');
    expect(logs).toContain('"error_name":"Error"');
    expect(logs).not.toContain(privateValue);
    expect(logs).not.toContain("stack");
  });
});
