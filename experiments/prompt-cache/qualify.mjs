#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { accessApplicationUrl } from "./access-auth.mjs";
import { mcpServerUrl } from "./mcp-oauth-client.mjs";
import {
  CAPSULE_SOURCE_AUTH_MODES,
  capsuleEndpoint,
  SECOND_BRAIN_AUTH_TOKEN_ENV,
} from "./capsule-source.mjs";
import {
  OperatorCredentialError,
  PROXY_API_KEY_ENV,
  PROXY_SYSTEMD_CREDENTIAL,
  resolveProxyApiKey,
} from "./operator-credential.mjs";
import { transportLabel } from "./request.mjs";
import {
  buildProxyOnlyQualificationManifest,
  buildQualificationManifest,
} from "./qualification.mjs";
import {
  buildProxyCertificationArtifacts,
  buildProxyMeasurementManifest,
} from "./measurement.mjs";
import { PromptCacheEvidenceError, verifyEvidence } from "./verify.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const AB = resolve(ROOT, "ab.mjs");
const OFFICIAL_BASE_URL = "https://api.openai.com/v1";
const MAX_CHILD_OUTPUT_BYTES = 2 * 1024 * 1024;
const PER_REQUEST_TIMEOUT_MS = 185_000;
const CHILD_STARTUP_ALLOWANCE_MS = 30_000;

class QualificationError extends Error {
  constructor(code) {
    super(`Prompt-cache qualification failed: ${code}`);
    this.name = "QualificationError";
    this.code = code;
  }
}

function validModel(value) {
  return typeof value === "string" && value.trim() && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validSecret(value) {
  return typeof value === "string" && value.trim() && !/[\r\n]/.test(value);
}

export function qualificationTimeoutMs({ runs, delayMs, arm }) {
  if (!Number.isSafeInteger(runs) || runs < 2 || runs > 20) throw new TypeError("invalid runs");
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) throw new TypeError("invalid delay");
  if (arm !== "both" && arm !== "explicit") throw new TypeError("invalid arm");
  const armCount = arm === "both" ? 2 : 1;
  const requestCount = armCount * runs;
  const delayCount = armCount * (runs - 1);
  return (requestCount * PER_REQUEST_TIMEOUT_MS) + (delayCount * delayMs) + CHILD_STARTUP_ALLOWANCE_MS;
}

export function qualificationChildEnv({ environment, label, apiKey, baseUrl, model, sourceAuth = "bearer" }) {
  if (label !== "direct" && label !== "proxy") throw new TypeError("invalid label");
  if (!CAPSULE_SOURCE_AUTH_MODES.has(sourceAuth)) throw new TypeError("invalid source auth");
  const child = { ...environment };
  for (const key of [
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID",
    "PROMPT_CACHE_PROXY_API_KEY", "PROMPT_CACHE_PROXY_BASE_URL", "PROMPT_CACHE_DIRECT_MODEL",
    "PROMPT_CACHE_PROXY_MODEL", "PROMPT_CACHE_QUALIFICATION_MODE", "PROMPT_CACHE_SOURCE_AUTH",
    "SECOND_BRAIN_ACCESS_APP_URL", "SECOND_BRAIN_MCP_OAUTH_FILE", "CREDENTIALS_DIRECTORY",
  ]) delete child[key];
  if (sourceAuth === "access" || sourceAuth === "mcp-oauth") delete child[SECOND_BRAIN_AUTH_TOKEN_ENV];
  child.OPENAI_API_KEY = apiKey.trim();
  child.OPENAI_BASE_URL = baseUrl;
  child.OPENAI_MODEL = model;
  if (label === "direct") {
    if (validSecret(environment.OPENAI_ORG_ID)) child.OPENAI_ORG_ID = environment.OPENAI_ORG_ID.trim();
    if (validSecret(environment.OPENAI_PROJECT_ID)) child.OPENAI_PROJECT_ID = environment.OPENAI_PROJECT_ID.trim();
  }
  return child;
}

function parseArgs(argv) {
  const options = {
    workerUrl: null,
    projectId: null,
    workspace: "personal",
    team: null,
    runs: 4,
    delayMs: 2_000,
    minLaterHitRate: 0.5,
    workspaceKey: process.env.PROMPT_CACHE_WORKSPACE_KEY || "second-brain-cf-qualification",
    profile: process.env.PROMPT_CACHE_PROFILE || "capsule-v1",
    directModel: process.env.PROMPT_CACHE_DIRECT_MODEL || null,
    proxyModel: process.env.PROMPT_CACHE_PROXY_MODEL || null,
    proxyBaseUrl: process.env.PROMPT_CACHE_PROXY_BASE_URL || null,
    mode: process.env.PROMPT_CACHE_QUALIFICATION_MODE || "compare",
    sourceAuth: process.env.PROMPT_CACHE_SOURCE_AUTH || null,
    accessAppUrl: process.env.SECOND_BRAIN_ACCESS_APP_URL || null,
    mcpCredentialFile: process.env.SECOND_BRAIN_MCP_OAUTH_FILE || null,
    allowIncompleteCapsules: false,
    output: "qualification",
    pretty: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new QualificationError("missing_argument_value");
      return value;
    };
    if (arg === "--worker-url") options.workerUrl = next();
    else if (arg === "--project-id") options.projectId = next();
    else if (arg === "--workspace") options.workspace = next();
    else if (arg === "--team") options.team = next();
    else if (arg === "--runs") options.runs = Number(next());
    else if (arg === "--delay-ms") options.delayMs = Number(next());
    else if (arg === "--min-later-hit-rate") options.minLaterHitRate = Number(next());
    else if (arg === "--workspace-key") options.workspaceKey = next();
    else if (arg === "--profile") options.profile = next();
    else if (arg === "--direct-model") options.directModel = next();
    else if (arg === "--proxy-model") options.proxyModel = next();
    else if (arg === "--proxy-base-url") options.proxyBaseUrl = next();
    else if (arg === "--mode") options.mode = next();
    else if (arg === "--source-auth") options.sourceAuth = next();
    else if (arg === "--access-app-url") options.accessAppUrl = next();
    else if (arg === "--mcp-credential-file") options.mcpCredentialFile = next();
    else if (arg === "--allow-incomplete-capsules") options.allowIncompleteCapsules = true;
    else if (arg === "--output") options.output = next();
    else if (arg === "--pretty") options.pretty = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new QualificationError("unknown_argument");
  }

  if (options.help) return options;
  if (!options.workerUrl) throw new QualificationError("worker_url_required");
  if (!options.proxyBaseUrl) throw new QualificationError("proxy_base_url_required");
  if (options.mode !== "compare" && options.mode !== "proxy-only") {
    throw new QualificationError("invalid_mode");
  }
  if (!["qualification", "measurement", "artifacts"].includes(options.output)) {
    throw new QualificationError("invalid_output");
  }
  if (options.output === "measurement" && options.mode !== "proxy-only") {
    throw new QualificationError("measurement_requires_proxy_only");
  }
  if (options.output === "artifacts" && options.mode !== "proxy-only") {
    throw new QualificationError("artifacts_require_proxy_only");
  }
  options.sourceAuth ||= options.mode === "proxy-only" ? "mcp-oauth" : "bearer";
  if (!CAPSULE_SOURCE_AUTH_MODES.has(options.sourceAuth)) throw new QualificationError("invalid_source_auth");
  if (options.accessAppUrl && options.sourceAuth !== "access") {
    throw new QualificationError("access_app_requires_access_auth");
  }
  if (options.sourceAuth === "mcp-oauth" && !options.mcpCredentialFile) {
    throw new QualificationError("mcp_credential_file_required");
  }
  if (options.mcpCredentialFile && options.sourceAuth !== "mcp-oauth") {
    throw new QualificationError("mcp_credential_requires_mcp_oauth");
  }
  if (options.mode === "compare") {
    if (!validModel(options.directModel)) throw new QualificationError("direct_model_required");
    options.directModel = options.directModel.trim();
    options.proxyModel ||= options.directModel;
  }
  if (!validModel(options.proxyModel)) throw new QualificationError("invalid_proxy_model");
  options.proxyModel = options.proxyModel.trim();
  if (options.workspace !== "personal" && options.workspace !== "company") throw new QualificationError("invalid_workspace");
  if (options.team && options.workspace !== "company") throw new QualificationError("team_requires_company");
  if (!Number.isSafeInteger(options.runs) || options.runs < 2 || options.runs > 20) throw new QualificationError("invalid_runs");
  if (!Number.isSafeInteger(options.delayMs) || options.delayMs < 0 || options.delayMs > 60_000) {
    throw new QualificationError("invalid_delay");
  }
  if (typeof options.minLaterHitRate !== "number" || !Number.isFinite(options.minLaterHitRate)
    || options.minLaterHitRate < 0 || options.minLaterHitRate > 1) {
    throw new QualificationError("invalid_hit_rate");
  }
  if (options.sourceAuth === "mcp-oauth") {
    mcpServerUrl(options.workerUrl);
  } else {
    capsuleEndpoint({
      workerUrl: options.workerUrl,
      kind: "core",
      workspace: options.workspace,
      team: options.team,
      authMode: options.sourceAuth,
    });
  }
  if (options.sourceAuth === "access") {
    accessApplicationUrl({ workerUrl: options.workerUrl, accessAppUrl: options.accessAppUrl });
  }
  if (options.projectId && options.sourceAuth !== "mcp-oauth") {
    capsuleEndpoint({
      workerUrl: options.workerUrl,
      kind: "project",
      projectId: options.projectId,
      workspace: options.workspace,
      team: options.team,
      authMode: options.sourceAuth,
    });
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    "Usage: node experiments/prompt-cache/qualify.mjs --worker-url URL --proxy-base-url URL --mode compare|proxy-only [options]\n\n" +
    "Compare mode runs official Responses first. Proxy-only mode certifies only the exact CLIProxyAPI route.\n" +
    "Prompts, Worker URLs, credentials, project/team ids, and model output are never printed.\n\n" +
    "Authentication:\n" +
    "  proxy-only defaults to MCP Managed OAuth and does not read OPENAI_API_KEY or SECOND_BRAIN_AUTH_TOKEN\n" +
    `  CLIProxy inbound auth: ${PROXY_API_KEY_ENV}, or systemd credential ${PROXY_SYSTEMD_CREDENTIAL}\n` +
    "  compare mode additionally requires OPENAI_API_KEY; bearer source auth requires SECOND_BRAIN_AUTH_TOKEN\n\n" +
    "Options:\n" +
    "  --worker-url URL              Deployed Second Brain Worker\n" +
    "  --proxy-base-url URL          Exact proxy base route, for example http://127.0.0.1:8317/v1\n" +
    "  --project-id ID               Include one project Capsule\n" +
    "  --workspace personal|company  Capsule workspace (default: personal)\n" +
    "  --team ID                     Company workspace id when required\n" +
    "  --mode compare|proxy-only      Qualification contract (default: compare)\n" +
    "  --source-auth bearer|access|mcp-oauth  Capsule authentication (proxy-only default: mcp-oauth)\n" +
    "  --access-app-url URL           Access app URL (default: Worker /dashboard)\n" +
    "  --mcp-credential-file PATH     Host-local Managed OAuth credential (mode 0600)\n" +
    "  --direct-model ID             Explicit official API model (compare only)\n" +
    "  --proxy-model ID              Explicit proxy model (required in proxy-only)\n" +
    "  --runs N                      Requests per arm, 2-20 (default: 4)\n" +
    "  --delay-ms N                  Delay between requests (default: 2000)\n" +
    "  --min-later-hit-rate N        Strict later hit-rate threshold, 0-1\n" +
    "  --allow-incomplete-capsules   Permit omitted low-priority slots\n" +
    "  --output qualification|measurement|artifacts  Emit one gate, metrics, or both from one run\n" +
    "  --pretty                      Pretty-print the safe qualification manifest\n",
  );
}

function commonArgs(options, experimentId) {
  const args = [
    AB,
    "--worker-url", options.workerUrl,
    "--workspace", options.workspace,
    "--runs", String(options.runs),
    "--delay-ms", String(options.delayMs),
    "--workspace-key", options.workspaceKey,
    "--profile", options.profile,
    "--experiment-id", experimentId,
  ];
  if (options.projectId) args.push("--project-id", options.projectId);
  if (options.team) args.push("--team", options.team);
  args.push("--source-auth", options.sourceAuth);
  if (options.accessAppUrl) args.push("--access-app-url", options.accessAppUrl);
  if (options.mcpCredentialFile) args.push("--mcp-credential-file", options.mcpCredentialFile);
  if (options.allowIncompleteCapsules) args.push("--allow-incomplete-capsules");
  return args;
}

function runExperiment({ options, label, baseUrl, apiKey, model, arm, experimentId }) {
  if (!validSecret(apiKey)) throw new QualificationError(`${label}_api_key_missing`);
  const child = spawnSync(process.execPath, [
    ...commonArgs(options, experimentId),
    "--arm", arm,
    "--model", model,
    "--base-url", baseUrl,
  ], {
    encoding: "utf8",
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    timeout: qualificationTimeoutMs({ runs: options.runs, delayMs: options.delayMs, arm }),
    env: qualificationChildEnv({
      environment: process.env,
      label,
      apiKey,
      baseUrl,
      model,
      sourceAuth: options.sourceAuth,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.error || child.signal || child.status !== 0 || typeof child.stdout !== "string" || !child.stdout.trim()) {
    throw new QualificationError(`${label}_experiment_failed`);
  }
  return child.stdout;
}

function safeErrorCode(error) {
  if (error instanceof QualificationError) return error.code;
  if (error instanceof OperatorCredentialError) return error.code;
  if (error instanceof PromptCacheEvidenceError) return `invalid_evidence_${error.code}`;
  return "invalid_cli_or_runtime";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.sourceAuth === "bearer" && !validSecret(process.env[SECOND_BRAIN_AUTH_TOKEN_ENV])) {
    throw new QualificationError("worker_auth_token_missing");
  }
  if (options.mode === "compare" && !validSecret(process.env.OPENAI_API_KEY)) {
    throw new QualificationError("direct_api_key_missing");
  }
  const proxyCredential = resolveProxyApiKey();

  const proxyTransport = transportLabel(options.proxyBaseUrl);
  if (!/^custom-[0-9a-f]{12}$/.test(proxyTransport)) throw new QualificationError("proxy_route_must_be_custom");
  const qualificationId = randomUUID();

  if (options.mode === "proxy-only") {
    const proxyJsonl = runExperiment({
      options,
      label: "proxy",
      baseUrl: options.proxyBaseUrl,
      apiKey: proxyCredential.value,
      model: options.proxyModel,
      arm: "explicit",
      experimentId: `${qualificationId}:proxy`,
    });
    const proxy = verifyEvidence(proxyJsonl, {
      gate: "proxy",
      requireWorkerSource: true,
      allowIncompleteCapsules: options.allowIncompleteCapsules,
      minLaterHitRate: options.minLaterHitRate,
      expectedTransport: proxyTransport,
    });
    const artifactOptions = {
      expectedProxyTransport: proxyTransport,
      proxyCredentialSource: proxyCredential.source,
      allowIncompleteCapsules: options.allowIncompleteCapsules,
      minLaterHitRate: options.minLaterHitRate,
    };
    const manifest = options.output === "artifacts"
      ? buildProxyCertificationArtifacts(proxyJsonl, artifactOptions)
      : options.output === "measurement"
        ? buildProxyMeasurementManifest(proxyJsonl, artifactOptions)
        : buildProxyOnlyQualificationManifest(proxy, {
            expectedProxyTransport: proxyTransport,
            proxyCredentialSource: proxyCredential.source,
          });
    process.stdout.write(`${JSON.stringify(manifest, null, options.pretty ? 2 : 0)}\n`);
    if (!manifest.verified) process.exitCode = 2;
    return;
  }

  const directJsonl = runExperiment({
    options,
    label: "direct",
    baseUrl: OFFICIAL_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
    model: options.directModel,
    arm: "both",
    experimentId: `${qualificationId}:direct`,
  });
  const direct = verifyEvidence(directJsonl, {
    gate: "direct",
    requireWorkerSource: true,
    allowIncompleteCapsules: options.allowIncompleteCapsules,
    minLaterHitRate: options.minLaterHitRate,
  });

  if (!direct.verified) {
    const manifest = buildQualificationManifest(direct, null, { expectedProxyTransport: proxyTransport });
    process.stdout.write(`${JSON.stringify(manifest, null, options.pretty ? 2 : 0)}\n`);
    process.exitCode = 2;
    return;
  }

  const proxyJsonl = runExperiment({
    options,
    label: "proxy",
    baseUrl: options.proxyBaseUrl,
    apiKey: proxyCredential.value,
    model: options.proxyModel,
    arm: "explicit",
    experimentId: `${qualificationId}:proxy`,
  });
  const proxy = verifyEvidence(proxyJsonl, {
    gate: "proxy",
    requireWorkerSource: true,
    allowIncompleteCapsules: options.allowIncompleteCapsules,
    minLaterHitRate: options.minLaterHitRate,
    expectedTransport: proxyTransport,
  });

  const manifest = buildQualificationManifest(direct, proxy, { expectedProxyTransport: proxyTransport });
  process.stdout.write(`${JSON.stringify(manifest, null, options.pretty ? 2 : 0)}\n`);
  if (!manifest.verified) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      event: "prompt_cache_qualification_error",
      code: safeErrorCode(error),
    })}\n`);
    process.exitCode = 1;
  });
}
