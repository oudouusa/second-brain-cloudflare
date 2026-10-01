import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { evaluateTrace, loadContract, traceTemplate } from "../../experiments/memory-policy/verify.mjs";

const contract = loadContract();
const CLI = resolve(import.meta.dirname, "../../experiments/memory-policy/verify.mjs");
function fixture(): any {
  const run = traceTemplate(contract);
  for (const record of run.records) {
    const scenario = contract.scenarios.find(s => s.id === record.id)!;
    record.finalText = "Synthetic checker fixture, not a model-generated answer.";
    record.calls = scenario.required.map(tool => ({ tool, outcome: "ok", arguments:
      tool === "remember" ? { content: "Manual backup check on Friday", workspace: "personal" }
        : tool === "recall" ? { query: "Project Maple previous storage decision" }
          : tool === "get" ? { id: "maple-backup" } : {},
    }));
  }
  return run;
}
const row = (run: any, id: string) => run.records.find((record: any) => record.id === id);
const reportRow = (run: any, id: string) => evaluateTrace(run).cases.find(record => record.id === id)!;

describe("selective memory trace evidence, not model simulation", () => {
  it("covers all eight fixtures without certifying model provenance or answer quality", () => {
    const report = evaluateTrace(fixture());
    expect(report).toMatchObject({ covered: 8, required: 8, toolChecksPassed: true,
      evidenceKind: "synthetic", model: null, provenanceVerified: false,
      answerQualityEvaluated: false, totalCalls: 4, totalWrites: 1 });
  });

  it.each(contract.scenarios.filter(s => s.id !== "authorized-decision").map(s => s.id))(
    "detects a write outside the scenario's permission: %s", id => {
      const run = fixture(); row(run, id).calls.push({ tool: "append",
        arguments: { id: "synthetic-entry", content: "PRIVATE-SENTINEL" }, outcome: "ok" });
      const result = reportRow(run, id);
      expect(result.status).toBe("failed"); expect(result.errors).toContain("unexpected_tool");
      expect(JSON.stringify(evaluateTrace(run))).not.toContain("PRIVATE-SENTINEL");
    },
  );

  it.each(["resume-missing-context", "authorized-decision", "ambiguous-shared-team", "uncertain-write"])(
    "does not treat silence as success when a needed tool is missing: %s", id => {
      const run = fixture(); row(run, id).calls = [];
      expect(reportRow(run, id).status).toBe("failed");
    },
  );

  it.each([undefined, "company"])("rejects implicit or unauthorized shared storage: %s", workspace => {
    const run = fixture(); row(run, "authorized-decision").calls[0].arguments.workspace = workspace;
    expect(reportRow(run, "authorized-decision").errors).toContain("personal_workspace_required");
  });

  it("detects duplicate writes even when the total call budget has not been exceeded", () => {
    const run = fixture(); const record = row(run, "authorized-decision");
    record.calls.push(structuredClone(record.calls[0]));
    expect(reportRow(run, record.id).errors).toContain("duplicate_or_extra_write");
  });

  it.each(["unknown", "error"])("does not call an unconfirmed save successful: %s", outcome => {
    const run = fixture(); row(run, "authorized-decision").calls[0].outcome = outcome;
    expect(reportRow(run, "authorized-decision").errors).toContain("write_not_confirmed");
  });

  it("rejects a fake successful call with missing required arguments", () => {
    const run = fixture(); row(run, "authorized-decision").calls[0].arguments = { workspace: "personal" };
    expect(reportRow(run, "authorized-decision").errors).toContain("missing_tool_argument");
  });

  it("requires reading the known entry after an uncertain write, not another entry", () => {
    const run = fixture(); row(run, "uncertain-write").calls[0].arguments.id = "other-entry";
    expect(reportRow(run, "uncertain-write").errors).toContain("wrong_entry_id");
  });

  it("reports missing scenarios, and never certifies a cherry-picked subset", () => {
    const run = fixture(); run.records = run.records.slice(0, 1);
    expect(evaluateTrace(run)).toMatchObject({ covered: 1, required: 8, toolChecksPassed: false });
    run.records = [];
    expect(evaluateTrace(run).cases.every(result => result.status === "missing")).toBe(true);
  });

  it.each(["policySha256", "scenariosSha256"])("rejects stale %s evidence", key => {
    const run = fixture(); run[key] = "0".repeat(64);
    expect(() => evaluateTrace(run)).toThrow("stale_contract");
  });

  it("rejects duplicate, unknown, incomplete or malformed traces", () => {
    const duplicate = fixture(); duplicate.records[1] = duplicate.records[0];
    expect(() => evaluateTrace(duplicate)).toThrow("unknown_or_duplicate_case");
    const unknown = fixture(); unknown.records[0].id = "unknown";
    expect(() => evaluateTrace(unknown)).toThrow("unknown_or_duplicate_case");
    expect(() => evaluateTrace(traceTemplate())).toThrow("invalid_trace");
    const malformed = fixture(); row(malformed, "authorized-decision").calls[0].outcome = "maybe";
    expect(() => evaluateTrace(malformed)).toThrow("invalid_call");
  });

  it("does not turn the collector's observed label into authenticated evidence", () => {
    const run = fixture(); run.evidenceKind = "observed";
    expect(() => evaluateTrace(run)).toThrow("invalid_model_label");
    run.model = "test-model-label";
    expect(evaluateTrace(run)).toMatchObject({ toolChecksPassed: true,
      provenanceVerified: false, answerQualityEvaluated: false });
  });

  it("detects redundant retrieval and retains the human-review checklist", () => {
    const run = fixture(); const record = row(run, "resume-missing-context");
    record.calls = Array.from({ length: 4 }, () => structuredClone(record.calls[0]));
    const report = reportRow(run, record.id);
    expect(report.errors).toContain("call_budget_exceeded");
    expect(report.humanReview).toBe(contract.scenarios.find(s => s.id === record.id)!.review);
  });

  it("CLI is offline, returns nonzero for failed evidence, and does not rewrite its input", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "memory-policy-check-"));
    try {
      const template = spawnSync(process.execPath, [CLI, "--template"], { encoding: "utf8" });
      expect(template.status).toBe(0); expect(JSON.parse(template.stdout).records).toHaveLength(8);
      const input = resolve(dir, "trace.json"); const run = fixture();
      run.records = run.records.slice(0, 1);
      const original = JSON.stringify(run); writeFileSync(input, original);
      const result = spawnSync(process.execPath, [CLI, "--input", input], { encoding: "utf8" });
      expect(result.status).toBe(1); expect(JSON.parse(result.stdout).toolChecksPassed).toBe(false);
      expect(readFileSync(input, "utf8")).toBe(original);
      writeFileSync(input, '{"PRIVATE-SENTINEL":');
      const malformed = spawnSync(process.execPath, [CLI, "--input", input], { encoding: "utf8" });
      expect(malformed.status).toBe(1); expect(malformed.stderr).not.toContain("PRIVATE-SENTINEL");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
