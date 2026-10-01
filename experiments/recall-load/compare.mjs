import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODES = ["healthy", "quota", "embedding-failure", "vector-failure"];
const WORKLOADS = ["ordinary-noise", "excluded-window", "equal-authority-overflow", "no-answer"];
const LANGUAGES = ["en", "ja"];
const fail = () => { throw new Error("Invalid or incomparable local replay evidence"); };
const digest = value => /^[0-9a-f]{64}$/.test(value ?? "");
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const integer = value => number(value) && Number.isSafeInteger(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const expectation = (workload, mode) => workload === "equal-authority-overflow" && mode !== "healthy"
  ? "known-limit" : workload === "no-answer" ? "empty" : "find-answer";
const satisfies = sample => sample.expectation === "empty" ? sample.returned === 0 : sample.rank > 0;

/** Validates the complete prescribed local matrix, not just supplied rows. */
export function validateReport(report) {
  if (report?.schema !== "recall-load-local.v1" || report.environment !== "node-sqlite-synthetic"
    || report.remoteMeasurements !== false || report.realModelQualityMeasured !== false
    || !digest(report.sourceSha256) || !digest(report.schemaSha256) || !digest(report.harnessSha256)
    || !/^[0-9a-f]{40}$/.test(report.searchBlob ?? "")
    || typeof report.node !== "string" || typeof report.platform !== "string") fail();
  const settings = report.settings;
  if (!settings || !equal(settings.modes, MODES) || !equal(settings.workloads, WORKLOADS)
    || !equal(settings.languages, LANGUAGES) || settings.candidateCap !== 128 || settings.topK !== 5
    || settings.hops !== 0 || settings.cache !== "fresh-kv-per-invocation"
    || !integer(settings.repeats) || settings.repeats < 1 || settings.repeats > 20
    || !Array.isArray(settings.sizes) || !settings.sizes.length || settings.sizes.length > 3
    || new Set(settings.sizes).size !== settings.sizes.length
    || settings.sizes.some(size => !integer(size) || size < 200 || size > 10000)) fail();
  const expected = new Set(settings.sizes.flatMap(size => WORKLOADS.flatMap(workload =>
    LANGUAGES.flatMap(language => MODES.flatMap(mode => Array.from({ length: settings.repeats },
      (_, repetition) => `${size}/${workload}/${language}/${mode}/${repetition}`))))));
  if (!Array.isArray(report.samples) || report.samples.length !== expected.size) fail();
  const fixtures = new Map();
  for (const row of report.samples) {
    if (!row || row.id !== `${row.size}/${row.workload}/${row.language}/${row.mode}/${row.repetition}`
      || !expected.delete(row.id) || !digest(row.fixtureSha256)
      || row.expectation !== expectation(row.workload, row.mode)
      || row.semanticUnavailable !== (row.mode !== "healthy")) fail();
    for (const field of ["returned", "keywordCandidates", "candidateSelects", "candidateRowsReturned",
      "d1BindingCalls", "aiCalls", "vectorQueries"]) if (!integer(row[field])) fail();
    for (const field of ["handlerMs", "completedMs", "candidateSqlMs", "nodeProcessCpuMs"])
      if (!number(row[field])) fail();
    if (row.completedMs < row.handlerMs || row.returned > 5 || row.keywordCandidates > 128
      || row.candidateSelects > (row.mode === "healthy" ? 1 : 2)
      || row.candidateRowsReturned > (row.mode === "vector-failure" ? 160 : 128)
      || row.candidateRowsReturned < row.keywordCandidates || row.d1BindingCalls < row.candidateSelects
      || row.vectorQueries !== (row.mode === "healthy" && row.workload === "no-answer" ? 2
        : ["healthy", "vector-failure"].includes(row.mode) ? 1 : 0)
      || (row.mode === "quota" && row.aiCalls !== 0)
      || [row.cloudflareRowsRead, row.publicWorkerCpuMs, row.durableObjectCpuMs].some(value => value !== null)) fail();
    if (row.expectation === "empty" ? row.rank !== null : !integer(row.rank) || row.rank > row.returned) fail();
    const fixtureKey = `${row.size}/${row.workload}/${row.language}`;
    if (fixtures.has(fixtureKey) && fixtures.get(fixtureKey) !== row.fixtureSha256) fail();
    fixtures.set(fixtureKey, row.fixtureSha256);
  }
  if (expected.size) fail();
  return report;
}

function summary(rows) {
  const percentile = (field, p) => {
    const values = rows.map(row => row[field]).sort((a, b) => a - b);
    return values[Math.max(0, Math.ceil(p * values.length) - 1)];
  };
  return {
    samples: rows.length,
    requiredCases: rows.filter(row => row.expectation !== "known-limit").length,
    requiredPassed: rows.filter(row => row.expectation !== "known-limit" && satisfies(row)).length,
    knownLimitCases: rows.filter(row => row.expectation === "known-limit").length,
    knownLimitHits: rows.filter(row => row.expectation === "known-limit" && row.rank > 0).length,
    maxCandidates: Math.max(...rows.map(row => row.keywordCandidates)),
    maxCandidateRowsReturned: Math.max(...rows.map(row => row.candidateRowsReturned)),
    localTimingMs: Object.fromEntries(["handlerMs", "completedMs", "candidateSqlMs", "nodeProcessCpuMs"]
      .map(field => [field, { p50: percentile(field, .5), p95: percentile(field, .95) }])),
  };
}

export function compareReports(before, after) {
  validateReport(before); validateReport(after);
  if (!equal(before.settings, after.settings) || before.schemaSha256 !== after.schemaSha256
    || before.harnessSha256 !== after.harnessSha256 || before.node !== after.node || before.platform !== after.platform) fail();
  const baseline = new Map(before.samples.map(row => [row.id, row]));
  const groups = new Map();
  let regressions = 0, improvements = 0;
  for (const row of after.samples) {
    const old = baseline.get(row.id);
    if (!old || old.fixtureSha256 !== row.fixtureSha256) fail();
    // A known limit need not always pass, but losing a previously observed hit
    // is still a regression. Only the required-pass denominator excludes it.
    if (satisfies(old) && !satisfies(row)) regressions++;
    if (!satisfies(old) && satisfies(row)) improvements++;
    const key = `${row.size}/${row.workload}/${row.language}/${row.mode}`;
    if (!groups.has(key)) groups.set(key, { before: [], after: [] });
    groups.get(key).before.push(old); groups.get(key).after.push(row);
  }
  const current = summary(after.samples);
  return {
    schema: "recall-load-comparison.v1", environment: "node-sqlite-synthetic",
    before: { sourceSha256: before.sourceSha256, searchBlob: before.searchBlob, ...summary(before.samples) },
    after: { sourceSha256: after.sourceSha256, searchBlob: after.searchBlob, ...current },
    harnessSha256: before.harnessSha256, schemaSha256: before.schemaSha256,
    improvements, regressions,
    candidateRequiredCasesPassed: current.requiredPassed === current.requiredCases,
    // These reports cannot certify remote cost, model quality or provenance.
    remoteRolloutReady: false, realModelQualityMeasured: false, provenanceVerified: false,
    limitations: ["Local elapsed/Node CPU time is not Worker or DO CPU time.",
      "Returned rows are not D1 rows_read or billed rows.",
      "Healthy dense candidates are controlled stubs, not real model quality.",
      "Repeated deterministic fixtures are not independent retrieval examples.",
      "p95 is a descriptive nearest-rank sample statistic, not a production SLO."],
    groups: [...groups].map(([key, rows]) => ({ key, before: summary(rows.before), after: summary(rows.after) })),
  };
}

function main(argv) {
  const args = {};
  if (argv.length % 2) fail();
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--baseline", "--candidate", "--output"].includes(argv[i]) || args[argv[i]]) fail();
    args[argv[i]] = argv[i + 1];
  }
  if (!args["--baseline"] || !args["--candidate"]) fail();
  const read = path => {
    const data = readFileSync(path);
    if (data.length > 12 * 1024 * 1024) fail();
    return { data: JSON.parse(data.toString("utf8")), sha256: createHash("sha256").update(data).digest("hex") };
  };
  const before = read(args["--baseline"]), after = read(args["--candidate"]);
  const result = { ...compareReports(before.data, after.data), inputSha256: { baseline: before.sha256, candidate: after.sha256 } };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (args["--output"]) writeFileSync(args["--output"], text, { flag: "wx", mode: 0o600 });
  else process.stdout.write(text);
  if (result.regressions || !result.candidateRequiredCasesPassed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch { console.error("Local recall comparison failed: check inputs and unused output path."); process.exitCode = 1; }
}
