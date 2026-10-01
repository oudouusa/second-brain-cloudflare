#!/usr/bin/env node
// Repository-only renderer. No model calls, network access or client installation.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = "<!-- Generated from AI_Instructions/MEMORY_POLICY.md; edit the source and run node scripts/render-ai-instructions.mjs --write. -->\n";
const CLIENTS = [
  ["CLAUDE", "claude-desktop"],
  ["CODEX", "codex"],
  ["CURSOR", "cursor"],
  ["CHATGPT", "chatgpt"],
];
const CURSOR_CLI = "\nIf MCP discovery/calls fail and an authorized brain CLI is already configured,\nuse its documented commands as a fallback. Do not print its credential file or\nrepeat an uncertain write through another transport. Prefer MCP when available.\n";

export function renderInstructions(policy) {
  if (typeof policy !== "string" || !policy.trim()) throw new Error("memory policy is empty");
  const body = policy.replace(/\r\n/g, "\n").trim() + "\n";
  const outputs = new Map(CLIENTS.map(([client, source]) => [
    `AI_Instructions/${client}_INSTRUCTIONS.md`,
    GENERATED + body + `\nClient source for memory writes: ${source}. Use the loaded tool schema.\n`
      + (client === "CURSOR" ? CURSOR_CLI : ""),
  ]));
  outputs.set(".cursor/rules/second-brain-memory.mdc",
    "---\ndescription: Retrieve missing context and save authorized durable outcomes selectively\nalwaysApply: true\n---\n\n"
    + outputs.get("AI_Instructions/CURSOR_INSTRUCTIONS.md"));
  return outputs;
}

function main(argv) {
  const mode = argv[0] ?? "--check";
  if (argv.length > 1 || !["--check", "--write"].includes(mode)) {
    throw new Error("Usage: node scripts/render-ai-instructions.mjs [--check|--write]");
  }
  const outputs = renderInstructions(readFileSync(resolve(ROOT, "AI_Instructions/MEMORY_POLICY.md"), "utf8"));
  const stale = [];
  for (const [path, expected] of outputs) {
    let actual;
    try { actual = readFileSync(resolve(ROOT, path), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (actual === expected) continue;
    stale.push(path);
    if (mode === "--write") writeFileSync(resolve(ROOT, path), expected, "utf8");
  }
  if (mode === "--check" && stale.length) {
    throw new Error(`Instruction copies drifted: ${stale.join(", ")}. Run with --write.`);
  }
  console.log(`${outputs.size} instruction copies checked; ${mode === "--write" ? "updated" : "stale"}: ${stale.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
