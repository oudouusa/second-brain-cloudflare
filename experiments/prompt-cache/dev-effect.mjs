#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { fetchPromptCapsulesViaMcp } from "./mcp-capsule-source.mjs";
import { createMcpOAuthSession } from "./mcp-oauth-client.mjs";
import { resolveProxyApiKey } from "./operator-credential.mjs";
import { transportLabel, usageMetrics } from "./request.mjs";
import {
  assertSanitizedEvidence,
  DEV_EFFECT_ARMS,
  DEV_EFFECT_SCHEMA,
  DEV_EFFECT_TASKS,
  evidenceConclusion,
  evidenceSha256,
  gradeResponse,
  sha256,
  summarizeTrials,
} from "./dev-effect-lib.mjs";

const MAX_CONTEXT_BYTES = 96 * 1024;
const MAX_PROXY_RESPONSE_BYTES = 2 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 180_000;

class DevelopmentEffectError extends Error {
  constructor(code, options) {
    super(`Development effect experiment failed: ${code}`, options);
    this.name = "DevelopmentEffectError";
    this.code = code;
  }
}

function parseArgs(argv) {
  const options = {
    workerUrl: null,
    credentialFile: null,
    proxyBaseUrl: null,
    model: "gpt-5.6-luna",
    effort: undefined,
    maxOutputTokens: 4096,
    repetitions: 2,
    concurrency: 2,
    experimentId: null,
    pretty: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new DevelopmentEffectError("missing_argument_value");
      return value;
    };
    if (arg === "--worker-url") options.workerUrl = next();
    else if (arg === "--mcp-credential-file") options.credentialFile = next();
    else if (arg === "--proxy-base-url") options.proxyBaseUrl = next();
    else if (arg === "--model") options.model = next();
    else if (arg === "--effort") options.effort = next();
    else if (arg === "--max-output-tokens") options.maxOutputTokens = Number(next());
    else if (arg === "--repetitions") options.repetitions = Number(next());
    else if (arg === "--concurrency") options.concurrency = Number(next());
    else if (arg === "--experiment-id") options.experimentId = next();
    else if (arg === "--pretty") options.pretty = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new DevelopmentEffectError("unknown_argument");
  }
  if (options.help) return options;
  if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1) {
    throw new DevelopmentEffectError("invalid_output_budget");
  }
  for (const key of ["workerUrl", "credentialFile", "proxyBaseUrl", "experimentId"]) {
    if (typeof options[key] !== "string" || !options[key].trim()) {
      throw new DevelopmentEffectError(`missing_${key}`);
    }
  }
  if (!Number.isSafeInteger(options.repetitions) || options.repetitions < 1 || options.repetitions > 5) {
    throw new DevelopmentEffectError("invalid_repetitions");
  }
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4) {
    throw new DevelopmentEffectError("invalid_concurrency");
  }
  try {
    const credential = resolveProxyApiKey();
    options.proxyApiKey = credential.value;
    options.proxyCredentialSource = credential.source;
  } catch {
    throw new DevelopmentEffectError("proxy_api_key_missing");
  }
  const base = new URL(options.proxyBaseUrl);
  const loopback = base.hostname === "127.0.0.1" || base.hostname === "localhost" || base.hostname === "[::1]";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) {
    throw new DevelopmentEffectError("unsafe_proxy_url");
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new DevelopmentEffectError("unsafe_proxy_url");
  }
  options.transport = transportLabel(options.proxyBaseUrl);
  if (options.transport === "openai-official") throw new DevelopmentEffectError("official_api_not_allowed");
  return options;
}

function printHelp() {
  process.stdout.write(
    "Usage: node experiments/prompt-cache/dev-effect.mjs --worker-url URL "
    + "--mcp-credential-file ABSOLUTE_PATH --proxy-base-url URL --experiment-id ID [options]\n\n"
    + "Runs matched control/core/full development-decision trials through one Responses-compatible proxy.\n"
    + "Raw prompts, memories, model output, URLs, and credentials are never emitted.\n\n"
    + "Options:\n"
    + "  --model ID          Proxy model (default: gpt-5.6-luna)\n"
    + "  --effort VALUE      Explicit provider setting (default: omitted)\n"
    + "  --max-output-tokens N  Output ceiling (default: 4096)\n"
    + "  --repetitions N     Repetitions per task and arm, 1-5 (default: 2)\n"
    + "  --concurrency N     Concurrent proxy requests, 1-4 (default: 2)\n"
    + "  --pretty            Pretty-print sanitized evidence\n",
  );
}

function responseUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text) return payload.output_text;
  const texts = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if ((part?.type === "output_text" || part?.type === "text") && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  }
  return texts.join("\n");
}

function requestFor({ options, task, arm, repetition, context }) {
  const cacheKey = `sbde-${sha256(`${options.experimentId}\0${task.id}\0${arm}\0${repetition}`).slice(0, 55)}`;
  const input = [{
    role: "developer",
    content: [{
      type: "input_text",
      text: "Review the development decision conservatively. Use supplied context only as background and do not invent missing project facts. Return exactly one JSON object whose only top-level key is criterion_answers. criterion_answers must contain every requested criterion key exactly once and select exactly one of its listed string values. Return no explanation and no Markdown fences.",
    }],
  }];
  if (context) {
    input.push({
      role: "developer",
      content: [{ type: "input_text", text: context }],
    });
  }
  input.push({
    role: "user",
    content: [{
      type: "input_text",
      text: `${task.prompt}\n\nCriterion answer choices:\n${JSON.stringify(Object.fromEntries(task.criteria.map(item => [item.id, item.allowed])))}`,
    }],
  });
  return {
    model: options.model,
    store: false,
    prompt_cache_key: cacheKey,
    input,
    max_output_tokens: options.maxOutputTokens,
    ...(options.effort === undefined ? {} : { reasoning: { effort: options.effort } }),
    text: { verbosity: "low" },
  };
}

async function callProxy(options, request) {
  const started = performance.now();
  const response = await fetch(responseUrl(options.proxyBaseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.proxyApiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(RESPONSE_TIMEOUT_MS),
  });
  const latencyMs = performance.now() - started;
  const requestId = response.headers.get("x-request-id") || response.headers.get("request-id");
  if (!response.ok) {
    await response.body?.cancel();
    const error = new DevelopmentEffectError("proxy_http_error");
    error.httpStatus = response.status;
    error.requestId = requestId;
    throw error;
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROXY_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new DevelopmentEffectError("proxy_response_too_large");
  }
  let payload;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new DevelopmentEffectError("proxy_invalid_json");
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROXY_RESPONSE_BYTES) {
        await reader.cancel();
        throw new DevelopmentEffectError("proxy_response_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof DevelopmentEffectError) throw error;
    throw new DevelopmentEffectError("proxy_invalid_json", { cause: error });
  }
  return { payload, latencyMs, requestId };
}

function parseRecallResult(result) {
  if (result?.isError || !Array.isArray(result?.content)) {
    throw new DevelopmentEffectError("recall_tool_error");
  }
  const text = result.content
    .filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n");
  if (!text) throw new DevelopmentEffectError("recall_empty");
  if (Buffer.byteLength(text, "utf8") > MAX_CONTEXT_BYTES) {
    throw new DevelopmentEffectError("recall_too_large");
  }
  return text;
}

async function fetchCurrentStateRecall(options) {
  const session = await createMcpOAuthSession({
    workerUrl: options.workerUrl,
    credentialFile: options.credentialFile,
    redirectUrl: "http://127.0.0.1:8787/callback",
  });
  try {
    if (!session.provider.tokens()) throw new DevelopmentEffectError("mcp_authorization_required");
    try {
      await session.client.connect(session.transport);
    } catch (error) {
      if (error instanceof UnauthorizedError) throw new DevelopmentEffectError("mcp_authorization_required");
      throw new DevelopmentEffectError("mcp_connection_failed", { cause: error });
    }
    const result = await session.client.callTool({
      name: "recall",
      arguments: {
        query: "User wants to make safe development decisions about the completed second-brain-cf Prompt Capsule implementation — return the current lineage, cache result, OAuth and Access route decisions, deployment constraints, evidence privacy rules, and their reasons.",
        tag: "second-brain-cf",
        topK: 5,
        hops: 1,
      },
    });
    return parseRecallResult(result);
  } finally {
    await session.client.close().catch(() => {});
  }
}

function contextFor(arm, sources) {
  if (arm === "control") return null;
  if (arm === "core") return `Second Brain durable core capsule:\n${sources.coreText}`;
  return `Second Brain durable core capsule:\n${sources.coreText}\n\nSecond Brain project recall:\n${sources.recallText}`;
}

function jobOrder(repetitions) {
  const jobs = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    DEV_EFFECT_TASKS.forEach((task, taskIndex) => {
      const offset = (taskIndex + repetition - 1) % DEV_EFFECT_ARMS.length;
      const arms = [...DEV_EFFECT_ARMS.slice(offset), ...DEV_EFFECT_ARMS.slice(0, offset)];
      arms.forEach(arm => jobs.push({ task, arm, repetition }));
    });
  }
  return jobs;
}

async function runJob(options, sources, job) {
  const context = contextFor(job.arm, sources);
  const request = requestFor({ options, ...job, context });
  const descriptor = {
    task_id: job.task.id,
    arm: job.arm,
    repetition: job.repetition,
    context_sha256: context ? sha256(context) : null,
    context_chars: context?.length ?? 0,
  };
  try {
    const result = await callProxy(options, request);
    const output = extractOutputText(result.payload);
    const grade = gradeResponse(output, job.task);
    const usage = usageMetrics(result.payload, result.latencyMs);
    return {
      ...descriptor,
      http_success: true,
      http_status: 200,
      request_id_sha256: result.requestId ? sha256(result.requestId) : null,
      output_sha256: sha256(output),
      ...grade,
      ...usage,
    };
  } catch (error) {
    return {
      ...descriptor,
      http_success: false,
      http_status: Number.isInteger(error?.httpStatus) ? error.httpStatus : null,
      request_id_sha256: error?.requestId ? sha256(error.requestId) : null,
      output_sha256: null,
      json_valid: false,
      score: null,
      passed: false,
      criteria: Object.fromEntries(job.task.criteria.map(item => [item.id, false])),
      danger_count: 0,
      dangers: [],
      input_tokens: null,
      cache_write_tokens: null,
      cached_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cache_hit_ratio: null,
      cache_write_ratio: null,
      latency_ms: null,
      error_code: error instanceof DevelopmentEffectError ? error.code : "unexpected_error",
    };
  }
}

async function runPool(jobs, concurrency, run) {
  const results = new Array(jobs.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= jobs.length) return;
      results[index] = await run(jobs[index]);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const coreStarted = performance.now();
  const { core } = await fetchPromptCapsulesViaMcp({
    workerUrl: options.workerUrl,
    credentialFile: options.credentialFile,
    workspace: "personal",
  });
  const coreFetchMs = Math.round(performance.now() - coreStarted);
  if (!core.complete) throw new DevelopmentEffectError("core_capsule_incomplete");

  const recallStarted = performance.now();
  const recallText = await fetchCurrentStateRecall(options);
  const recallFetchMs = Math.round(performance.now() - recallStarted);
  const sources = { coreText: core.text, recallText };
  const jobs = jobOrder(options.repetitions);
  const trials = await runPool(jobs, options.concurrency, job => runJob(options, sources, job));
  const summary = summarizeTrials(trials);
  const completed = trials.every(trial => trial.http_success);
  const evidence = {
    schema: DEV_EFFECT_SCHEMA,
    experiment_id_sha256: sha256(options.experimentId),
    design: {
      tasks: DEV_EFFECT_TASKS.length,
      repetitions: options.repetitions,
      arms: DEV_EFFECT_ARMS,
      total_trials: trials.length,
      assignment: "matched deterministic rotation",
      interpretation: "decision-context benchmark; not a wall-clock coding productivity claim",
    },
    authentication: {
      capsule_source: "mcp-managed-oauth",
      llm_source: "cliproxyapi-codex-oauth",
      official_openai_api_key_used: false,
      second_brain_static_bearer_used: false,
      proxy_client_credential_source: options.proxyCredentialSource,
    },
    transport: options.transport,
    model: options.model,
    sources: {
      core: {
        sha256: core.promptHash.replace(/^sha256:/, ""),
        chars: core.charCount,
        complete: core.complete,
        endpoint_sha256: core.endpointHash,
        etag_sha256: core.etagHash,
        fetch_ms: coreFetchMs,
      },
      tagged_recall: {
        sha256: sha256(recallText),
        chars: recallText.length,
        fetch_ms: recallFetchMs,
        tag: "second-brain-cf",
        top_k: 5,
        hops: 1,
      },
    },
    completed,
    conclusion: evidenceConclusion(summary, completed),
    summary,
    trials,
  };
  evidence.evidence_sha256 = evidenceSha256(evidence);
  assertSanitizedEvidence(evidence);
  process.stdout.write(`${JSON.stringify(evidence, null, options.pretty ? 2 : 0)}\n`);
  if (!evidence.completed) process.exitCode = 1;
}

main().catch(error => {
  const code = error instanceof DevelopmentEffectError ? error.code : "unexpected_error";
  process.stderr.write(`${JSON.stringify({ schema: DEV_EFFECT_SCHEMA, ok: false, error_code: code })}\n`);
  process.exitCode = 1;
});
