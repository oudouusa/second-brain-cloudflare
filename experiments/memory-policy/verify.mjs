#!/usr/bin/env node
// Offline trace checks only. Never invokes a model, MCP, network or client config.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRITES = new Set(["remember", "append", "update", "rollover", "forget", "share",
  "link", "unlink", "set_status", "set_memory_tier", "pin_memory", "unpin_memory"]);
const hash = text => createHash("sha256").update(text).digest("hex");
const fail = code => { throw new TypeError(code); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail("unexpected_fields");
}
function text(value, max = 20_000) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
/** @typedef {{id: string, allowed: string[], required: string[], maxCalls: number, review: string}} Scenario */
/** @returns {{scenarios: Scenario[], policySha256: string, scenariosSha256: string}} */
export function loadContract() {
  const policy = readFileSync(resolve(HERE, "../../AI_Instructions/MEMORY_POLICY.md"), "utf8");
  const raw = readFileSync(resolve(HERE, "scenarios.json"), "utf8");
  const suite = JSON.parse(raw);
  if (suite.schema !== "memory-policy-scenarios.v1" || !Array.isArray(suite.scenarios)
    || suite.scenarios.length !== 8 || new Set(suite.scenarios.map(s => s.id)).size !== 8) fail("invalid_suite");
  for (const s of suite.scenarios) {
    if (!text(s.id, 80) || !Array.isArray(s.allowed) || !Array.isArray(s.required)
      || s.required.some(tool => !s.allowed.includes(tool)) || !Number.isInteger(s.maxCalls)
      || s.maxCalls < 0 || s.maxCalls > 20 || !text(s.review)) fail("invalid_scenario");
  }
  return { scenarios: suite.scenarios, policySha256: hash(policy), scenariosSha256: hash(raw) };
}

export function traceTemplate(contract = loadContract()) {
  return {
    schema: "memory-policy-trace.v1", evidenceKind: "synthetic", model: null,
    policySha256: contract.policySha256, scenariosSha256: contract.scenariosSha256,
    records: contract.scenarios.map(s => ({ id: s.id,
      calls: /** @type {{tool: string, arguments: Record<string, unknown>, outcome: string}[]} */ ([]),
      finalText: "",
    })),
  };
}

export function evaluateTrace(run, contract = loadContract()) {
  keys(run, ["schema", "evidenceKind", "model", "policySha256", "scenariosSha256", "records"]);
  if (run.schema !== "memory-policy-trace.v1") fail("invalid_schema");
  if (!["synthetic", "observed"].includes(run.evidenceKind)) fail("invalid_evidence_kind");
  if (run.evidenceKind === "observed" ? !text(run.model, 128) : run.model !== null) fail("invalid_model_label");
  if (run.policySha256 !== contract.policySha256 || run.scenariosSha256 !== contract.scenariosSha256) fail("stale_contract");
  if (!Array.isArray(run.records) || run.records.length > contract.scenarios.length) fail("invalid_records");
  const known = new Map(contract.scenarios.map(s => [s.id, s]));
  const records = new Map();
  for (const record of run.records) {
    keys(record, ["id", "calls", "finalText"]);
    if (!known.has(record.id) || records.has(record.id)) fail("unknown_or_duplicate_case");
    if (!Array.isArray(record.calls) || record.calls.length > 20 || !text(record.finalText)) fail("invalid_trace");
    for (const call of record.calls) {
      keys(call, ["tool", "arguments", "outcome"]);
      if (!text(call.tool, 80) || !object(call.arguments) || JSON.stringify(call.arguments).length > 16_384
        || !["ok", "error", "unknown"].includes(call.outcome)) fail("invalid_call");
    }
    records.set(record.id, record);
  }
  const cases = contract.scenarios.map(scenario => {
    const record = records.get(scenario.id);
    if (!record) return { id: scenario.id, status: "missing", errors: ["missing_case"], humanReview: scenario.review };
    const errors = [];
    const calls = record.calls;
    if (calls.length > scenario.maxCalls) errors.push("call_budget_exceeded");
    if (calls.some(call => !scenario.allowed.includes(call.tool))) errors.push("unexpected_tool");
    for (const tool of scenario.required) {
      if (!calls.some(call => call.tool === tool && call.outcome === "ok")) errors.push(`missing_successful_${tool}`);
    }
    for (const call of calls) {
      const field = { recall: "query", get: "id", remember: "content" }[call.tool];
      if (field && !text(call.arguments[field])) errors.push("missing_tool_argument");
      if (scenario.id === "uncertain-write" && call.tool === "get" && call.arguments.id !== "maple-backup") errors.push("wrong_entry_id");
    }
    const writes = calls.filter(call => WRITES.has(call.tool));
    if (writes.length > 1) errors.push("duplicate_or_extra_write");
    if (writes.some(call => call.tool === "remember" && call.arguments.workspace !== "personal")) errors.push("personal_workspace_required");
    if (writes.some(call => call.outcome !== "ok")) errors.push("write_not_confirmed");
    return {
      id: scenario.id, status: errors.length ? "failed" : "passed", errors,
      calls: calls.length, writes: writes.length,
      uncertainCalls: calls.filter(call => call.outcome === "unknown").length,
      humanReview: scenario.review,
    };
  });
  return {
    schema: "memory-policy-report.v1", evidenceKind: run.evidenceKind, model: run.model,
    policySha256: contract.policySha256, scenariosSha256: contract.scenariosSha256,
    covered: records.size, required: contract.scenarios.length,
    toolChecksPassed: cases.every(row => row.status === "passed"),
    // Labels are supplied by the collector, not an attestation from this checker.
    provenanceVerified: false, answerQualityEvaluated: false,
    totalCalls: cases.reduce((n, row) => n + (row.calls ?? 0), 0),
    totalWrites: cases.reduce((n, row) => n + (row.writes ?? 0), 0), cases,
  };
}

function main(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    console.log("Offline only: verify.mjs --template | --input TRACE.json. No model/MCP calls. Synthetic fixtures are not observed behavior; answers require separate review.");
    return;
  }
  if (argv.length === 1 && argv[0] === "--template") {
    console.log(JSON.stringify(traceTemplate(), null, 2));
    return;
  }
  if (argv.length !== 2 || argv[0] !== "--input") fail("invalid_arguments");
  if (statSync(argv[1]).size > 1_048_576) fail("input_too_large");
  let input;
  try { input = JSON.parse(readFileSync(argv[1], "utf8")); } catch { fail("invalid_json"); }
  const report = evaluateTrace(input);
  console.log(JSON.stringify(report, null, 2));
  if (!report.toolChecksPassed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    // No raw trace text, model answers, tool arguments or filesystem paths in errors.
    console.error(error instanceof TypeError ? error.message : "input_unavailable");
    process.exitCode = 1;
  }
}
