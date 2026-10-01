#!/usr/bin/env node
import { resolveCloudflareAccessToken } from "./access-auth.mjs";
import {
  CAPSULE_SOURCE_AUTH_MODES,
  SECOND_BRAIN_AUTH_TOKEN_ENV,
  fetchPromptCapsule,
  readCapsuleFile,
} from "./capsule-source.mjs";
import { fetchPromptCapsulesViaMcp } from "./mcp-capsule-source.mjs";
import {
  PROMPT_CACHE_EXPERIMENT_VERSION,
  buildResponsesRequest,
  promptCacheKey,
  requestDescriptor,
  sha256,
  syntheticCapsule,
  transportLabel,
  usageMetrics,
} from "./request.mjs";

function parseArgs(argv) {
  const options = {
    arm: "both",
    runs: 4,
    delayMs: 2_000,
    model: process.env.OPENAI_MODEL || "gpt-5.6-luna",
    effort: undefined,
    maxOutputTokens: 4096,
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    workspaceKey: process.env.PROMPT_CACHE_WORKSPACE_KEY || "second-brain-cf-experiment",
    profile: process.env.PROMPT_CACHE_PROFILE || "capsule-v1",
    experimentId: process.env.PROMPT_CACHE_EXPERIMENT_ID || new Date().toISOString(),
    dryRun: false,
    requireExplicitHit: false,
    coreFile: null,
    projectFile: null,
    workerUrl: null,
    projectId: null,
    workspace: "personal",
    team: null,
    allowIncompleteCapsules: false,
    sourceAuth: process.env.PROMPT_CACHE_SOURCE_AUTH || "bearer",
    accessAppUrl: null,
    mcpCredentialFile: null,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value after ${arg}`);
      return value;
    };
    if (arg === "--arm") options.arm = next();
    else if (arg === "--runs") options.runs = Number(next());
    else if (arg === "--delay-ms") options.delayMs = Number(next());
    else if (arg === "--model") options.model = next();
    else if (arg === "--effort") options.effort = next();
    else if (arg === "--max-output-tokens") options.maxOutputTokens = Number(next());
    else if (arg === "--base-url") options.baseUrl = next();
    else if (arg === "--workspace-key") options.workspaceKey = next();
    else if (arg === "--profile") options.profile = next();
    else if (arg === "--experiment-id") options.experimentId = next();
    else if (arg === "--core-file") options.coreFile = next();
    else if (arg === "--project-file") options.projectFile = next();
    else if (arg === "--worker-url") options.workerUrl = next();
    else if (arg === "--project-id") options.projectId = next();
    else if (arg === "--workspace") options.workspace = next();
    else if (arg === "--team") options.team = next();
    else if (arg === "--source-auth") options.sourceAuth = next();
    else if (arg === "--access-app-url") options.accessAppUrl = next();
    else if (arg === "--mcp-credential-file") options.mcpCredentialFile = next();
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--require-explicit-hit") options.requireExplicitHit = true;
    else if (arg === "--allow-incomplete-capsules") options.allowIncompleteCapsules = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!["implicit", "explicit", "both"].includes(options.arm)) {
    throw new Error('--arm must be "implicit", "explicit", or "both"');
  }
  if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1) {
    throw new Error("--max-output-tokens must be a positive integer");
  }
  if (!Number.isSafeInteger(options.runs) || options.runs < 2 || options.runs > 20) {
    throw new Error("--runs must be an integer from 2 through 20");
  }
  if (!Number.isSafeInteger(options.delayMs) || options.delayMs < 0 || options.delayMs > 60_000) {
    throw new Error("--delay-ms must be an integer from 0 through 60000");
  }
  if (options.workspace !== "personal" && options.workspace !== "company") {
    throw new Error('--workspace must be "personal" or "company"');
  }
  if (options.workerUrl && (options.coreFile || options.projectFile)) {
    throw new Error("--worker-url cannot be combined with --core-file or --project-file");
  }
  if (!options.workerUrl && (options.projectId || options.team || options.workspace !== "personal")) {
    throw new Error("--project-id, --workspace and --team require --worker-url");
  }
  if (options.team && options.workspace !== "company") {
    throw new Error("--team requires --workspace company");
  }
  if (!CAPSULE_SOURCE_AUTH_MODES.has(options.sourceAuth)) {
    throw new Error('--source-auth must be "bearer", "access", or "mcp-oauth"');
  }
  if (options.accessAppUrl && options.sourceAuth !== "access") {
    throw new Error("--access-app-url requires --source-auth access");
  }
  if (options.sourceAuth === "mcp-oauth" && !options.mcpCredentialFile) {
    throw new Error("--mcp-credential-file is required with --source-auth mcp-oauth");
  }
  if (options.sourceAuth === "mcp-oauth" && !options.workerUrl) {
    throw new Error("--source-auth mcp-oauth requires --worker-url");
  }
  if (options.mcpCredentialFile && options.sourceAuth !== "mcp-oauth") {
    throw new Error("--mcp-credential-file requires --source-auth mcp-oauth");
  }
  options.transport = transportLabel(options.baseUrl);
  return options;
}

function printHelp() {
  process.stdout.write(`Usage: node experiments/prompt-cache/ab.mjs [options]\n\n` +
    `Runs changing-suffix prompt-cache requests through the Responses API.\n` +
    `Prompt text, bearer tokens, and provider response text are never printed.\n\n` +
    `Capsule sources:\n` +
    `  (no source flags)             Deterministic synthetic core + project\n` +
    `  --core-file PATH              Capsule response JSON or plain prompt text\n` +
    `  --project-file PATH           Capsule response JSON or plain prompt text\n` +
    `  --worker-url URL              Fetch one deployed core capsule\n` +
    `  --project-id ID               Also fetch one deployed project capsule\n` +
    `  --workspace personal|company  Capsule workspace (default: personal)\n` +
    `  --team ID                     Required when company membership is ambiguous\n` +
    `  --source-auth bearer|access|mcp-oauth  Worker source auth (default: bearer)\n` +
    `  --access-app-url URL           Access app URL (default: Worker /dashboard)\n` +
    `  --mcp-credential-file PATH     Host-local Managed OAuth credential (mode 0600)\n` +
    `  --allow-incomplete-capsules   Permit a capsule with omitted low-priority slots\n\n` +
    `Experiment options:\n` +
    `  --arm implicit|explicit|both  A/B arm (default: both)\n` +
    `  --runs N                     Requests per arm, 2-20 (default: 4)\n` +
    `  --delay-ms N                  Delay between requests (default: 2000)\n` +
    `  --model ID                    Model (default: OPENAI_MODEL or gpt-5.6-luna)\n` +
    `  --effort VALUE                Explicit provider setting (default: omitted)\n` +
    `  --max-output-tokens N         Output ceiling (default: 4096)\n` +
    `  --base-url URL                API base (default: OPENAI_BASE_URL or official API)\n` +
    `  --workspace-key VALUE         Stable non-identifying routing namespace\n` +
    `  --profile VALUE               Agent/profile namespace\n` +
    `  --experiment-id VALUE         Cache-isolation namespace\n` +
    `  --dry-run                     Print sanitized request descriptors only\n` +
    `  --require-explicit-hit        Exit non-zero unless explicit write+read are observed\n`);
}

function syntheticSource(kind) {
  const text = syntheticCapsule(kind, "synthetic-v1");
  return {
    text,
    source: "synthetic",
    promptHash: `sha256:${sha256(text)}`,
    complete: true,
    charCount: text.length,
    endpointHash: null,
    etagHash: null,
  };
}

async function capsuleSources(options) {
  if (options.workerUrl) {
    if (options.sourceAuth === "mcp-oauth") {
      return fetchPromptCapsulesViaMcp({
        workerUrl: options.workerUrl,
        credentialFile: options.mcpCredentialFile,
        projectId: options.projectId,
        workspace: options.workspace,
        team: options.team,
        allowIncomplete: options.allowIncompleteCapsules,
      });
    }
    const sourceCredential = options.sourceAuth === "access"
      ? {
          authMode: "access",
          accessToken: resolveCloudflareAccessToken({
            workerUrl: options.workerUrl,
            accessAppUrl: options.accessAppUrl,
          }),
        }
      : {
          authMode: "bearer",
          authToken: process.env[SECOND_BRAIN_AUTH_TOKEN_ENV],
        };
    const common = {
      workerUrl: options.workerUrl,
      workspace: options.workspace,
      team: options.team,
      ...sourceCredential,
      allowIncomplete: options.allowIncompleteCapsules,
    };
    const [core, project] = await Promise.all([
      fetchPromptCapsule({ ...common, kind: "core" }),
      options.projectId
        ? fetchPromptCapsule({ ...common, kind: "project", projectId: options.projectId })
        : Promise.resolve(null),
    ]);
    return { core, project };
  }

  const [core, project] = await Promise.all([
    options.coreFile
      ? readCapsuleFile(options.coreFile, "core", { allowIncomplete: options.allowIncompleteCapsules })
      : Promise.resolve(syntheticSource("core")),
    options.projectFile
      ? readCapsuleFile(options.projectFile, "project", { allowIncomplete: options.allowIncompleteCapsules })
      : Promise.resolve(syntheticSource("project")),
  ]);
  return { core, project };
}

function responsesUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

function safeRequestId(response) {
  return response.headers.get("x-request-id") || response.headers.get("request-id") || null;
}

async function callResponses({ apiKey, organization, project, url, request }) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (organization) headers["OpenAI-Organization"] = organization;
  if (project) headers["OpenAI-Project"] = project;

  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(180_000),
  });
  const latencyMs = performance.now() - started;
  const requestId = safeRequestId(response);
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(`Responses API returned HTTP ${response.status}`);
    error.status = response.status;
    error.requestId = requestId;
    throw error;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Responses API returned invalid JSON");
  }
  return { payload, latencyMs, requestId };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runArm(options, arm, coreText, projectText) {
  const cacheKey = promptCacheKey({
    workspaceKey: options.workspaceKey,
    profile: options.profile,
    experimentId: options.experimentId,
    arm,
  });
  const records = [];

  for (let run = 1; run <= options.runs; run++) {
    const userText = `Prompt-cache A/B suffix ${run}. Reply with only the word OK.`;
    const request = buildResponsesRequest({
      model: options.model,
      effort: options.effort,
      maxOutputTokens: options.maxOutputTokens,
      cacheKey,
      coreText,
      projectText,
      userText,
      arm,
    });
    const descriptor = requestDescriptor(request);

    if (options.dryRun) {
      const record = {
        event: "prompt_cache_dry_run",
        version: PROMPT_CACHE_EXPERIMENT_VERSION,
        transport: options.transport,
        arm,
        run,
        ...descriptor,
      };
      process.stdout.write(`${JSON.stringify(record)}\n`);
      records.push(record);
    } else {
      try {
        const result = await callResponses({
          apiKey: process.env.OPENAI_API_KEY,
          organization: options.transport === "openai-official" ? process.env.OPENAI_ORG_ID : null,
          project: options.transport === "openai-official" ? process.env.OPENAI_PROJECT_ID : null,
          url: responsesUrl(options.baseUrl),
          request,
        });
        const record = {
          event: "prompt_cache_usage",
          version: PROMPT_CACHE_EXPERIMENT_VERSION,
          transport: options.transport,
          arm,
          run,
          request_id_hash: result.requestId ? sha256(result.requestId) : null,
          ...descriptor,
          ...usageMetrics(result.payload, result.latencyMs),
        };
        process.stdout.write(`${JSON.stringify(record)}\n`);
        records.push(record);
      } catch (error) {
        const record = {
          event: "prompt_cache_error",
          version: PROMPT_CACHE_EXPERIMENT_VERSION,
          transport: options.transport,
          arm,
          run,
          error_name: error instanceof Error ? error.name : "UnknownError",
          http_status: Number.isInteger(error?.status) ? error.status : null,
          request_id_hash: error?.requestId ? sha256(error.requestId) : null,
          ...descriptor,
        };
        process.stdout.write(`${JSON.stringify(record)}\n`);
        records.push(record);
      }
    }

    if (run < options.runs && options.delayMs) await sleep(options.delayMs);
  }
  return records;
}

function summarize(arm, records) {
  const usage = records.filter(record => record.event === "prompt_cache_usage");
  const later = usage.filter(record => record.run > 1);
  const writeObserved = usage.some(record => Number(record.cache_write_tokens) > 0);
  const readObserved = later.some(record => Number(record.cached_tokens) > 0);
  const cached = later.map(record => record.cached_tokens).filter(Number.isFinite);
  return {
    arm,
    successful_requests: usage.length,
    failed_requests: records.filter(record => record.event === "prompt_cache_error").length,
    cache_write_observed: writeObserved,
    later_cache_read_observed: readObserved,
    later_cached_tokens_min: cached.length ? Math.min(...cached) : null,
    later_cached_tokens_max: cached.length ? Math.max(...cached) : null,
    verified: writeObserved && readObserved,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.dryRun && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required unless --dry-run is used");
  }

  const { core, project } = await capsuleSources(options);
  const arms = options.arm === "both" ? ["implicit", "explicit"] : [options.arm];
  process.stdout.write(`${JSON.stringify({
    event: "prompt_cache_experiment_start",
    version: PROMPT_CACHE_EXPERIMENT_VERSION,
    transport: options.transport,
    model: options.model,
    arms,
    runs_per_arm: options.runs,
    delay_ms: options.delayMs,
    experiment_id_hash: sha256(options.experimentId),
    core_source: core.source,
    project_source: project?.source ?? null,
    core_hash: sha256(core.text),
    core_chars: core.charCount,
    project_hash: project ? sha256(project.text) : null,
    project_chars: project?.charCount ?? null,
    core_complete: core.complete,
    project_complete: project?.complete ?? null,
    core_endpoint_hash: core.endpointHash,
    project_endpoint_hash: project?.endpointHash ?? null,
    core_etag_hash: core.etagHash,
    project_etag_hash: project?.etagHash ?? null,
    dry_run: options.dryRun,
  })}\n`);

  const summaries = [];
  for (const arm of arms) {
    const records = await runArm(options, arm, core.text, project?.text ?? null);
    summaries.push(summarize(arm, records));
  }
  process.stdout.write(`${JSON.stringify({
    event: "prompt_cache_experiment_summary",
    version: PROMPT_CACHE_EXPERIMENT_VERSION,
    summaries,
  })}\n`);

  if (options.requireExplicitHit && !options.dryRun) {
    const explicit = summaries.find(summary => summary.arm === "explicit");
    if (!explicit?.verified) process.exitCode = 2;
  }
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    event: "prompt_cache_fatal",
    error_name: error instanceof Error ? error.name : "UnknownError",
    error_code: error instanceof Error ? sha256(error.message).slice(0, 16) : null,
  })}\n`);
  process.exitCode = 1;
});
