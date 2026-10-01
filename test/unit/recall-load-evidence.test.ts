import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compareReports, validateReport } from "../../experiments/recall-load/compare.mjs";

// Synthetic records test the comparator, not the model or the actual replay.
function fixture() {
  const settings = { sizes: [200], repeats: 1,
    modes: ["healthy", "quota", "embedding-failure", "vector-failure"],
    workloads: ["ordinary-noise", "excluded-window", "equal-authority-overflow", "no-answer"],
    languages: ["en", "ja"], candidateCap: 128, topK: 5, hops: 0, cache: "fresh-kv-per-invocation" };
  return { schema: "recall-load-local.v1", environment: "node-sqlite-synthetic",
    remoteMeasurements: false, realModelQualityMeasured: false, node: "v22-test", platform: "test",
    sourceSha256: "a".repeat(64), schemaSha256: "b".repeat(64), harnessSha256: "c".repeat(64), searchBlob: "d".repeat(40),
    settings, samples: settings.workloads.flatMap(workload => settings.languages.flatMap(language => settings.modes.map(mode => ({
      id: `200/${workload}/${language}/${mode}/0`, size: 200, workload, language, mode, repetition: 0,
      fixtureSha256: "e".repeat(64), expectation: workload === "no-answer" ? "empty"
        : workload === "equal-authority-overflow" && mode !== "healthy" ? "known-limit" : "find-answer",
      rank: workload === "no-answer" ? null : workload === "equal-authority-overflow" && mode !== "healthy" ? 0 : 1,
      returned: workload === "no-answer" ? 0 : 5, keywordCandidates: 128,
      candidateSelects: mode === "healthy" ? 1 : 2, candidateRowsReturned: mode === "vector-failure" ? 160 : 128,
      handlerMs: 2, completedMs: 3, candidateSqlMs: 1, nodeProcessCpuMs: 2,
      semanticUnavailable: mode !== "healthy", d1BindingCalls: 12, aiCalls: mode === "quota" ? 0 : 1,
      vectorQueries: mode === "healthy" && workload === "no-answer" ? 2
        : ["healthy", "vector-failure"].includes(mode) ? 1 : 0,
      cloudflareRowsRead: null, publicWorkerCpuMs: null, durableObjectCpuMs: null,
    })))) };
}

describe("complete local recall load evidence", () => {
  it("separates required cases and known limits without authorizing remote rollout", () => {
    const result = compareReports(fixture(), fixture());
    expect(result.after).toMatchObject({ samples: 32, requiredCases: 26, requiredPassed: 26, knownLimitCases: 6, knownLimitHits: 0 });
    expect(result).toMatchObject({ remoteRolloutReady: false, realModelQualityMeasured: false, provenanceVerified: false });
  });
  it("records improved outcomes, not just more passing test assertions", () => {
    const before = fixture(), after = fixture(); before.samples[0].rank = 0;
    expect(compareReports(before, after)).toMatchObject({ improvements: 1, regressions: 0, candidateRequiredCasesPassed: true });
  });
  it("reports a lost answer as a regression", () => {
    const after = fixture(); after.samples[0].rank = 0;
    expect(compareReports(fixture(), after)).toMatchObject({ improvements: 0, regressions: 1, candidateRequiredCasesPassed: false });
  });
  it("reports new false-positive results in an absent-answer case", () => {
    const after = fixture(); after.samples.find(row => row.workload === "no-answer")!.returned = 1;
    expect(compareReports(fixture(), after).regressions).toBe(1);
  });
  const mutations: [string, (report: ReturnType<typeof fixture>) => void][] = [
    ["missing row", r => { r.samples.pop(); }],
    ["duplicate row", r => { r.samples[0] = r.samples[1]; }],
    ["unknown ID", r => { r.samples[0].id = "unknown"; }],
    ["omitted mode", r => { r.settings.modes.pop(); }],
    ["unbounded size", r => { r.settings.sizes[0] = 10001; }],
    ["duplicate size", r => { r.settings.sizes.push(200); }],
    ["zero repeats", r => { r.settings.repeats = 0; }],
    ["invented remote measurement", r => { r.remoteMeasurements = true; }],
    ["null local timing", r => { (r.samples[0] as any).handlerMs = null; }],
    ["NaN CPU", r => { r.samples[0].nodeProcessCpuMs = NaN; }],
    ["negative duration", r => { r.samples[0].candidateSqlMs = -1; }],
    ["fabricated D1 read count", r => { (r.samples[0] as any).cloudflareRowsRead = 128; }],
    ["invented Worker CPU", r => { (r.samples[0] as any).publicWorkerCpuMs = 0; }],
    ["over-cap candidates", r => { r.samples[0].keywordCandidates = 129; }],
    ["over-budget rows", r => { r.samples[0].candidateRowsReturned = 161; }],
    ["hidden missing answer", r => { r.samples[0].expectation = "known-limit"; }],
    ["wrong failure mode", r => { r.samples[0].semanticUnavailable = true; }],
    ["fixture changes between modes", r => { r.samples[0].fixtureSha256 = "f".repeat(64); }],
    ["quota AI request", r => { r.samples.find(row => row.mode === "quota")!.aiCalls = 1; }],
  ];
  it.each(mutations)("rejects %s", (_name, mutate) => {
    const report = fixture(); mutate(report);
    expect(() => validateReport(report)).toThrow("Invalid or incomparable");
  });
  it.each(["harnessSha256", "schemaSha256", "node", "platform"] as const)("rejects different %s", field => {
    const after = fixture(); after[field] = field.endsWith("Sha256") ? "f".repeat(64) : "other";
    expect(() => compareReports(fixture(), after)).toThrow();
  });
  it("rejects a changed fixture even when each input is internally consistent", () => {
    const after = fixture(); after.samples.forEach(row => { row.fixtureSha256 = "f".repeat(64); });
    expect(() => compareReports(fixture(), after)).toThrow();
  });
  it("does not confuse fetched rows with the smaller final candidate set", () => {
    const report = fixture(); expect(() => validateReport(report)).not.toThrow();
    expect(compareReports(report, report).after).toMatchObject({ maxCandidates: 128, maxCandidateRowsReturned: 160 });
  });
});


describe("known limits are exempt from mandatory hits, not regression checks", () => {
  const transitions = [
    { name: "lost hit", beforeRank: 1, afterRank: 0, regressions: 1, improvements: 0, exit: 1 },
    { name: "still missing", beforeRank: 0, afterRank: 0, regressions: 0, improvements: 0, exit: 0 },
    { name: "new hit", beforeRank: 0, afterRank: 1, regressions: 0, improvements: 1, exit: 0 },
    { name: "retained hit", beforeRank: 1, afterRank: 1, regressions: 0, improvements: 0, exit: 0 },
  ];
  const reports = (beforeRank: number, afterRank: number) => {
    const before = fixture(), after = fixture();
    const index = before.samples.findIndex(row => row.expectation === "known-limit");
    before.samples[index].rank = beforeRank; after.samples[index].rank = afterRank;
    return { before, after };
  };
  it.each(transitions)("counts $name without changing the required denominator", transition => {
    const { before, after } = reports(transition.beforeRank, transition.afterRank);
    const result = compareReports(before, after);
    expect(result).toMatchObject({ regressions: transition.regressions, improvements: transition.improvements,
      candidateRequiredCasesPassed: true, remoteRolloutReady: false, realModelQualityMeasured: false });
    expect(result.before).toMatchObject({ requiredCases: 26, requiredPassed: 26, knownLimitCases: 6,
      knownLimitHits: transition.beforeRank > 0 ? 1 : 0 });
    expect(result.after).toMatchObject({ requiredCases: 26, requiredPassed: 26, knownLimitCases: 6,
      knownLimitHits: transition.afterRank > 0 ? 1 : 0 });
  });

  it.each(transitions)("CLI reports $name with exit=$exit and preserves both inputs", transition => {
    const directory = mkdtempSync(join(tmpdir(), "recall-comparison-"));
    try {
      const { before, after } = reports(transition.beforeRank, transition.afterRank);
      const baseline = join(directory, "before.json"), candidate = join(directory, "after.json");
      const originalBefore = JSON.stringify(before), originalAfter = JSON.stringify(after);
      writeFileSync(baseline, originalBefore); writeFileSync(candidate, originalAfter);
      const run = spawnSync(process.execPath, [resolve("experiments/recall-load/compare.mjs"),
        "--baseline", baseline, "--candidate", candidate], { encoding: "utf8", timeout: 10_000 });
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(transition.exit);
      expect(run.stderr).toBe("");
      expect(JSON.parse(run.stdout)).toMatchObject({ regressions: transition.regressions,
        improvements: transition.improvements, candidateRequiredCasesPassed: true });
      expect(readFileSync(baseline, "utf8")).toBe(originalBefore);
      expect(readFileSync(candidate, "utf8")).toBe(originalAfter);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not cancel a known-limit lost hit against a different new hit", () => {
    const { before, after } = reports(1, 0);
    const known = after.samples.filter(row => row.expectation === "known-limit");
    known[1].rank = 1;
    const result = compareReports(before, after);
    expect(result.before.knownLimitHits).toBe(1);
    expect(result.after.knownLimitHits).toBe(1);
    expect(result).toMatchObject({ regressions: 1, improvements: 1, candidateRequiredCasesPassed: true });
  });
});
