import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSanitizedEvidence,
  DEV_EFFECT_ARMS,
  DEV_EFFECT_TASKS,
  evidenceConclusion,
  evidenceSha256,
  gradeResponse,
  summarizeTrials,
} from "./dev-effect-lib.mjs";

function responseFor(task, overrides = {}) {
  return JSON.stringify({
    criterion_answers: Object.fromEntries(task.criteria.map(item => [
      item.id,
      overrides[item.id] ?? item.expected,
    ])),
  });
}

test("development-effect task and criterion ids are unique", () => {
  assert.equal(new Set(DEV_EFFECT_TASKS.map(task => task.id)).size, DEV_EFFECT_TASKS.length);
  for (const task of DEV_EFFECT_TASKS) {
    assert.equal(new Set(task.criteria.map(item => item.id)).size, task.criteria.length);
    assert.ok(task.criteria.length >= 3);
  }
});

test("grades a complete cache evidence decision without overstating write proof", () => {
  const task = DEV_EFFECT_TASKS.find(candidate => candidate.id === "cache-evidence-claim");
  const result = gradeResponse(responseFor(task), task);
  assert.equal(result.json_valid, true);
  assert.equal(result.score, 1);
  assert.equal(result.passed, true);
  assert.equal(result.danger_count, 0);
});

test("rejects malformed model output without retaining it", () => {
  const task = DEV_EFFECT_TASKS[0];
  assert.deepEqual(gradeResponse("not-json", task), {
    json_valid: false,
    score: 0,
    passed: false,
    criteria: Object.fromEntries(task.criteria.map(item => [item.id, false])),
    danger_count: 0,
    dangers: [],
  });
});

test("detects an affirmative unsafe Access recommendation", () => {
  const task = DEV_EFFECT_TASKS.find(candidate => candidate.id === "access-boundary");
  const result = gradeResponse(responseFor(task, { access_boundary: "remove-access" }), task);
  assert.equal(result.danger_count, 1);
  assert.equal(result.score, 0.666667);
  assert.equal(result.passed, false);
});

test("does not award structured credit to negated or alternative prose", () => {
  const task = DEV_EFFECT_TASKS.find(candidate => candidate.id === "access-boundary");
  const adversarial = gradeResponse(JSON.stringify({
    decision: "Do not use /oauth-mcp. Cloudflare Access must not remain. Validate the token only, not its audience.",
    actions: [],
    risks: [],
  }), task);
  assert.equal(adversarial.json_valid, false);
  assert.equal(adversarial.score, 0);
  assert.equal(adversarial.passed, false);
});

test("rejects missing, unknown, and out-of-enum criterion answers", () => {
  const task = DEV_EFFECT_TASKS.find(candidate => candidate.id === "access-boundary");
  const correct = JSON.parse(responseFor(task));

  const missing = structuredClone(correct);
  delete missing.criterion_answers.machine_route;
  assert.equal(gradeResponse(JSON.stringify(missing), task).json_valid, false);

  const unknown = structuredClone(correct);
  unknown.criterion_answers.extra = "unknown";
  assert.equal(gradeResponse(JSON.stringify(unknown), task).json_valid, false);

  const invalid = structuredClone(correct);
  invalid.criterion_answers.machine_route = "do-whatever";
  assert.equal(gradeResponse(JSON.stringify(invalid), task).json_valid, false);
});

test("summarizes paired score effects and token metrics", () => {
  const trials = [];
  for (const task of DEV_EFFECT_TASKS) {
    for (const [arm, score, passed, latency] of [
      ["control", 0.25, false, 100],
      ["core", 0.5, false, 120],
      ["full", 1, true, 140],
    ]) {
      trials.push({
        task_id: task.id,
        arm,
        repetition: 1,
        http_success: true,
        json_valid: true,
        score,
        passed,
        danger_count: 0,
        latency_ms: latency,
        input_tokens: arm === "control" ? 100 : 500,
        output_tokens: 20,
        cached_tokens: arm === "full" ? 128 : 0,
      });
    }
  }
  const summary = summarizeTrials(trials);
  assert.equal(summary.arms.control.mean_score, 0.25);
  assert.equal(summary.arms.full.exact_pass_rate, 1);
  assert.equal(summary.arms.full.cached_tokens_total, 128 * DEV_EFFECT_TASKS.length);
  assert.equal(summary.paired_effects.core_vs_control.mean_score_delta, 0.25);
  assert.equal(summary.paired_effects.full_vs_control.mean_score_delta, 0.75);
  assert.equal(summary.paired_effects.full_vs_control.ci95_low, 0.75);
});

test("excludes transport failures from arm scores and paired effects", () => {
  const task = DEV_EFFECT_TASKS[0];
  const summary = summarizeTrials([
    {
      task_id: task.id,
      arm: "control",
      repetition: 1,
      http_success: false,
      json_valid: false,
      score: null,
      passed: false,
      danger_count: 0,
      criteria: Object.fromEntries(task.criteria.map(item => [item.id, false])),
      latency_ms: null,
      input_tokens: null,
      output_tokens: null,
      cached_tokens: null,
    },
    {
      task_id: task.id,
      arm: "full",
      repetition: 1,
      http_success: true,
      json_valid: true,
      score: 1,
      passed: true,
      danger_count: 0,
      criteria: Object.fromEntries(task.criteria.map(item => [item.id, true])),
      latency_ms: 100,
      input_tokens: 500,
      output_tokens: 20,
      cached_tokens: 0,
    },
  ]);
  assert.equal(summary.arms.control.observed_trials, 0);
  assert.equal(summary.arms.control.mean_score, null);
  assert.equal(summary.paired_effects.full_vs_control.pairs, 0);
  assert.equal(summary.paired_effects.full_vs_control.mean_score_delta, null);
  assert.equal(evidenceConclusion(summary, false), "incomplete-run");
});

test("evidence digest is independent of object insertion order", () => {
  assert.equal(evidenceSha256({ b: 2, a: { d: 4, c: 3 } }), evidenceSha256({ a: { c: 3, d: 4 }, b: 2 }));
});

test("sanitized evidence rejects prompt and credential-bearing fields", () => {
  const safe = { schema: "x", input_tokens: 10 };
  assert.equal(assertSanitizedEvidence(safe), safe);
  for (const field of ["prompt", "content", "worker_url", "authorization", "api_key", "credential_file"]) {
    assert.throws(() => assertSanitizedEvidence({ nested: { [field]: "secret" } }), /forbidden evidence field/);
  }
});

test("all three matched benchmark arms remain present", () => {
  assert.deepEqual(DEV_EFFECT_ARMS, ["control", "core", "full"]);
});
