#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();

function readText(relativePath) {
  const path = join(root, relativePath);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function command(args) {
  try {
    return execFileSync(args[0], args.slice(1), {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    return `ERROR(${error.status ?? "unknown"}): ${stderr || error.message}`;
  }
}

function check(id, ok, evidence) {
  return { id, ok, evidence };
}

const src = readText("src/index.ts");
const readme = readText("README.md");
const codexInstructions = readText("AI_Instructions/CODEX_INSTRUCTIONS.md");
const packageJson = readText("package.json");
const gitHead = command(["git", "rev-parse", "--short", "HEAD"]);
const gitBranch = command(["git", "branch", "--show-current"]);
const gitStatus = command(["git", "status", "--porcelain"]);

const usageImplemented =
  /usage_events/.test(src) &&
  /["'`]\/usage(?:\?|["'`])/.test(src);
const usageDocumented = /\/usage|usage ledger|usage endpoint|AI usage/i.test(readme);
const readmeToolsCurrent = [
  "remember",
  "append",
  "update",
  "set_status",
  "recall",
  "list_recent",
  "link",
  "connections",
  "usage",
  "forget",
].every((tool) => new RegExp(`\\|\\s*\`${tool}\`\\s*\\|`).test(readme));
const aggressiveCodexInstructions =
  /At the start of EVERY conversation/.test(codexInstructions) &&
  /Store EVERYTHING important automatically/.test(codexInstructions);
const quotaAwareCodexInstructions =
  /quota|budget|free[- ]?plan|rate[- ]?limit|usage cap|cost control/i.test(codexInstructions);

const checks = [
  check(
    "usage-ledger-implemented",
    usageImplemented,
    "src/index.ts contains usage_events and a /usage route",
  ),
  check(
    "usage-ledger-documented",
    usageDocumented,
    "README.md mentions /usage, usage ledger, usage endpoint, or AI usage",
  ),
  check(
    "readme-memory-tools-current",
    readmeToolsCurrent,
    "README.md Memory tools table covers current MCP tools including status, graph, and usage helpers",
  ),
  check(
    "codex-instructions-quota-aware",
    !aggressiveCodexInstructions || quotaAwareCodexInstructions,
    "AI_Instructions/CODEX_INSTRUCTIONS.md avoids unconditional recall/write guidance or documents quota controls",
  ),
  check(
    "vectorize-health-covered",
    /checkVectorizeHealth/.test(src) &&
      existsSync(join(root, "test/integration/health.test.ts")) &&
      existsSync(join(root, "test/integration/vectorize-pending.test.ts")),
    "Vectorize health and pending-vector repair have implementation and tests",
  ),
  check(
    "local-quality-gates-present",
    /"test"\s*:/.test(packageJson) && /"typecheck"\s*:/.test(packageJson),
    "package.json exposes test and typecheck scripts for L2 gates",
  ),
];

const candidates = [];

if (usageImplemented && !usageDocumented) {
  candidates.push({
    title: "Document the /usage ledger for quota-aware operation",
    evidence: "The Worker records usage_events and exposes /usage, but README.md does not mention the endpoint.",
    next: "Add a small README section explaining what /usage reports and how to use it before increasing automatic Second Brain calls.",
  });
}

if (!readmeToolsCurrent) {
  candidates.push({
    title: "Sync the README memory tools table with current MCP tools",
    evidence: "The Worker exposes lifecycle, graph, and usage helpers, but the README Memory tools table does not list all of them.",
    next: "Update the table so setup readers can discover set_status, link, connections, and usage alongside the core memory tools.",
  });
}

if (aggressiveCodexInstructions && !quotaAwareCodexInstructions) {
  candidates.push({
    title: "Add a quota-aware Codex instruction profile",
    evidence: "AI_Instructions/CODEX_INSTRUCTIONS.md requires recall at every conversation start and automatic storage of everything important, but does not describe quota/budget controls.",
    next: "Add an alternate bounded profile or revise the Codex instructions so free-plan users can choose controlled recall/write behavior.",
  });
}

console.log("# second-brain-cloudflare L1 improvement observation");
console.log("");
console.log(`- repo: ${root}`);
console.log(`- branch: ${gitBranch || "(detached)"}`);
console.log(`- head: ${gitHead}`);
console.log(`- working_tree: ${gitStatus ? "dirty" : "clean"}`);
console.log("- mode: read-only; no network, MCP writes, Cloudflare writes, or deploy");
console.log("");
console.log("## Checks");
for (const item of checks) {
  console.log(`- ${item.ok ? "ok" : "needs-attention"} ${item.id}: ${item.evidence}`);
}
console.log("");
console.log("## Candidate slices");

if (candidates.length === 0) {
  console.log("- none: expected health/docs surfaces are present");
  process.exit(3);
}

for (const candidate of candidates) {
  console.log(`- ${candidate.title}`);
  console.log(`  evidence: ${candidate.evidence}`);
  console.log(`  next: ${candidate.next}`);
}

console.log("");
console.log("## L2 admission note");
console.log("- Promote exactly one candidate at a time only after human review; L2 gate should be `npm run typecheck` and `npm test`.");
