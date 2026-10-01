#!/usr/bin/env node

import { CapsuleAccessError, resolveCloudflareAccessToken } from "./access-auth.mjs";
import {
  CAPSULE_REST_AUTH_MODES,
  CapsuleSourceError,
  SECOND_BRAIN_AUTH_TOKEN_ENV,
} from "./capsule-source.mjs";
import {
  PROMPT_CAPSULE_REVALIDATION_VERSION,
  capsuleRefreshDescriptor,
  createPromptCapsuleRevalidator,
} from "./capsule-revalidate.mjs";

function parseArgs(argv) {
  const options = {
    workerUrl: null,
    projectId: null,
    workspace: "personal",
    team: null,
    runs: 3,
    delayMs: 500,
    allowIncomplete: false,
    require304: false,
    sourceAuth: process.env.PROMPT_CACHE_SOURCE_AUTH || "bearer",
    accessAppUrl: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new TypeError(`Missing value after ${arg}`);
      return value;
    };
    if (arg === "--worker-url") options.workerUrl = next();
    else if (arg === "--project-id") options.projectId = next();
    else if (arg === "--workspace") options.workspace = next();
    else if (arg === "--team") options.team = next();
    else if (arg === "--runs") options.runs = Number(next());
    else if (arg === "--delay-ms") options.delayMs = Number(next());
    else if (arg === "--source-auth") options.sourceAuth = next();
    else if (arg === "--access-app-url") options.accessAppUrl = next();
    else if (arg === "--allow-incomplete-capsules") options.allowIncomplete = true;
    else if (arg === "--require-304") options.require304 = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new TypeError(`Unknown argument: ${arg}`);
  }

  if (!options.help && !options.workerUrl) throw new TypeError("--worker-url is required");
  if (options.workspace !== "personal" && options.workspace !== "company") {
    throw new TypeError('--workspace must be "personal" or "company"');
  }
  if (!CAPSULE_REST_AUTH_MODES.has(options.sourceAuth)) {
    throw new TypeError('--source-auth must be "access" or "bearer"');
  }
  if (options.accessAppUrl && options.sourceAuth !== "access") {
    throw new TypeError("--access-app-url requires --source-auth access");
  }
  if (options.team && options.workspace !== "company") {
    throw new TypeError("--team requires --workspace company");
  }
  if (!Number.isSafeInteger(options.runs) || options.runs < 2 || options.runs > 10) {
    throw new TypeError("--runs must be an integer from 2 through 10");
  }
  if (!Number.isSafeInteger(options.delayMs) || options.delayMs < 0 || options.delayMs > 60_000) {
    throw new TypeError("--delay-ms must be an integer from 0 through 60000");
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    "Usage: node experiments/prompt-cache/source-revalidate.mjs --worker-url URL [options]\n\n" +
    "Fetches deployed Prompt Capsules repeatedly and proves strong ETag 304 reuse.\n" +
    "Capsule text, credentials, Worker URLs, team ids, and project ids are never printed.\n\n" +
    "Options:\n" +
    "  --project-id ID                 Also probe one project Capsule\n" +
    "  --workspace personal|company    Workspace layer (default: personal)\n" +
    "  --team ID                        Explicit company workspace id\n" +
    "  --source-auth access|bearer      Authentication mode (default: bearer)\n" +
    "  --access-app-url URL             Access application URL (default: Worker /dashboard)\n" +
    "  --runs N                         Refreshes per Capsule, 2-10 (default: 3)\n" +
    "  --delay-ms N                     Delay between rounds (default: 500)\n" +
    "  --allow-incomplete-capsules      Deliberately accept omitted low-priority slots\n" +
    "  --require-304                    Exit 2 unless every target proves a later 304\n",
  );
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function errorRecord(error, kind, run) {
  return {
    event: "prompt_capsule_revalidation_error",
    version: PROMPT_CAPSULE_REVALIDATION_VERSION,
    kind,
    run,
    error_code: error instanceof CapsuleSourceError ? error.code : "invalid_request",
    http_status: error instanceof CapsuleSourceError && Number.isInteger(error.status)
      ? error.status
      : null,
  };
}

function summarize(kind, records) {
  const success = records.filter(record => record.kind === kind
    && record.event === "prompt_capsule_revalidation");
  const errors = records.filter(record => record.kind === kind
    && record.event === "prompt_capsule_revalidation_error");
  const hashes = success.map(record => record.prompt_hash).filter(Boolean);
  const stablePrompt = hashes.length > 0 && new Set(hashes).size === 1;
  const initial = success.some(record => record.run === 1
    && record.http_status === 200
    && record.revalidation === "initial");
  const later304 = success.some(record => record.run > 1
    && record.http_status === 304
    && record.revalidation === "not-modified");
  return {
    kind,
    successful_refreshes: success.length,
    failed_refreshes: errors.length,
    initial_200_observed: initial,
    later_304_observed: later304,
    stable_prompt_hash: stablePrompt,
    verified: errors.length === 0 && initial && later304 && stablePrompt,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
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
  if (sourceCredential.authMode === "bearer" && !sourceCredential.authToken) {
    throw new CapsuleSourceError("auth_token_missing");
  }

  const targetOptions = [
    { kind: "core" },
    ...(options.projectId ? [{ kind: "project", projectId: options.projectId }] : []),
  ];
  const targets = targetOptions.map(target => ({
    ...target,
    client: createPromptCapsuleRevalidator({
      workerUrl: options.workerUrl,
      kind: target.kind,
      projectId: target.projectId,
      workspace: options.workspace,
      team: options.team,
      ...sourceCredential,
      allowIncomplete: options.allowIncomplete,
    }),
  }));

  process.stdout.write(`${JSON.stringify({
    event: "prompt_capsule_revalidation_start",
    version: PROMPT_CAPSULE_REVALIDATION_VERSION,
    kinds: targets.map(target => target.kind),
    target_hashes: targets.map(target => ({
      kind: target.kind,
      endpoint_hash: target.client.targetHash,
    })),
    runs_per_target: options.runs,
    delay_ms: options.delayMs,
    workspace: options.workspace,
    source_auth: options.sourceAuth,
    incomplete_capsules_allowed: options.allowIncomplete,
  })}\n`);

  const records = [];
  for (let run = 1; run <= options.runs; run++) {
    for (const target of targets) {
      try {
        const result = await target.client.refresh();
        const record = {
          event: "prompt_capsule_revalidation",
          kind: target.kind,
          run,
          ...capsuleRefreshDescriptor(result),
        };
        records.push(record);
        process.stdout.write(`${JSON.stringify(record)}\n`);
      } catch (error) {
        const record = errorRecord(error, target.kind, run);
        records.push(record);
        process.stdout.write(`${JSON.stringify(record)}\n`);
      }
    }
    if (run < options.runs && options.delayMs) await sleep(options.delayMs);
  }

  const summaries = targets.map(target => summarize(target.kind, records));
  process.stdout.write(`${JSON.stringify({
    event: "prompt_capsule_revalidation_summary",
    version: PROMPT_CAPSULE_REVALIDATION_VERSION,
    summaries,
  })}\n`);

  if (options.require304 && summaries.some(summary => !summary.verified)) {
    process.exitCode = 2;
  }
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    event: "prompt_capsule_revalidation_fatal",
    version: PROMPT_CAPSULE_REVALIDATION_VERSION,
    error_code: error instanceof CapsuleSourceError || error instanceof CapsuleAccessError
      ? error.code
      : "invalid_request",
    http_status: error instanceof CapsuleSourceError && Number.isInteger(error.status)
      ? error.status
      : null,
  })}\n`);
  process.exitCode = 1;
});
