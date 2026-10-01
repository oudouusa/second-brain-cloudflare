#!/usr/bin/env node
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  MAX_EVIDENCE_BYTES,
  PromptCacheEvidenceError,
  parseEvidenceJsonl,
} from "./evidence-format.mjs";
import { verifyEvidence } from "./evidence-manifest.mjs";

export { PromptCacheEvidenceError, parseEvidenceJsonl, verifyEvidence };

function parseArgs(argv) {
  const options = {
    input: null,
    gate: "structure",
    requireWorkerSource: false,
    allowIncompleteCapsules: false,
    minLaterHitRate: 0.5,
    expectedTransport: process.env.PROMPT_CACHE_EXPECTED_TRANSPORT || null,
    pretty: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value after ${arg}`);
      return value;
    };
    if (arg === "--input") options.input = next();
    else if (arg === "--gate") options.gate = next();
    else if (arg === "--min-later-hit-rate") options.minLaterHitRate = Number(next());
    else if (arg === "--expected-transport") options.expectedTransport = next();
    else if (arg === "--require-worker-source") options.requireWorkerSource = true;
    else if (arg === "--allow-incomplete-capsules") options.allowIncompleteCapsules = true;
    else if (arg === "--pretty") options.pretty = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help && !options.input) throw new Error("--input PATH or --input - is required");
  return options;
}

function printHelp() {
  process.stdout.write(
    "Usage: node experiments/prompt-cache/verify.mjs --input PATH [options]\n\n" +
    "Validate sanitized JSONL emitted by ab.mjs and print a deterministic evidence manifest.\n\n" +
    "Options:\n" +
    "  --input PATH|-                 JSONL evidence file or stdin\n" +
    "  --gate structure|direct|proxy  Readiness gate (default: structure)\n" +
    "  --expected-transport LABEL     Exact custom-<hash> required by proxy gate\n" +
    "  --require-worker-source        Require deployed Worker Capsules\n" +
    "  --allow-incomplete-capsules    Permit source Capsules with omitted slots\n" +
    "  --min-later-hit-rate N         Minimum later explicit hit rate, 0-1 (default: 0.5)\n" +
    "  --pretty                       Pretty-print the safe manifest\n",
  );
}

async function readBounded(stream) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_EVIDENCE_BYTES) throw new PromptCacheEvidenceError("input_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function readInput(path) {
  if (path === "-") return readBounded(process.stdin);
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (metadata.size > MAX_EVIDENCE_BYTES) throw new PromptCacheEvidenceError("input_too_large");
    return await readBounded(handle.createReadStream({ autoClose: false }));
  } finally {
    await handle.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const text = await readInput(options.input);
  const manifest = verifyEvidence(text, options);
  process.stdout.write(`${JSON.stringify(manifest, null, options.pretty ? 2 : 0)}\n`);
  if (!manifest.verified) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      event: "prompt_cache_evidence_error",
      code: error instanceof PromptCacheEvidenceError ? error.code : "invalid_cli_or_io",
    })}\n`);
    process.exitCode = 1;
  });
}
