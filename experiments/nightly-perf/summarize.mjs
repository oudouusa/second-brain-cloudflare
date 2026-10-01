import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const [beforeDir, afterDir, beforeSha, afterSha, output] = process.argv.slice(2);
if (!output || ![beforeSha, afterSha].every(sha => /^[a-f0-9]{40}$/.test(sha))) {
  throw new Error("使用法: node summarize.mjs BEFORE_DIR AFTER_DIR BEFORE_SHA AFTER_SHA OUTPUT_JSON");
}
const cases = [];
const plans = new Map();
for (const size of [200, 1000, 10000]) for (const multi of [false, true]) {
  const name = `${size}-${multi ? "multi" : "solo"}.json`;
  const before = JSON.parse(readFileSync(resolve(beforeDir, name), "utf8"));
  const after = JSON.parse(readFileSync(resolve(afterDir, name), "utf8"));
  for (const [result, sha] of [[before, beforeSha], [after, afterSha]]) {
    assert.equal(result.schema, "nightly-local-probe.v1");
    assert.equal(result.source, sha);
    assert.equal(result.sizePerWorkspace, size);
    assert.equal(result.workspaceCount, multi ? 2 : 1);
    assert.equal(result.totalSourceRows, size * (multi ? 2 : 1));
    assert.equal(result.afterOriginalHash, result.originalHash);
    assert.equal(result.otherWorkspaceUnchanged, true);
    assert.deepEqual(result.errors, []);
    assert.ok(result.trace.length > 0 && result.trace.every(item => !item.error));
    assert.equal(result.invocations.reduce((sum, row) => sum + row.statements, 0), result.trace.length);
    assert.ok(result.synthesized > 0);
    assert.equal(result.remoteCpuMeasured, false);
    assert.equal(result.billedRowsMeasured, false);
  }
  assert.equal(before.now, after.now, "固定時刻が異なる");
  assert.deepEqual(before.hashes, after.hashes, "adapter・SQLite補助実装・schema・依存の不一致");
  assert.equal(before.originalHash, after.originalHash, "原記憶fixtureが異なる");
  assert.equal(before.topology, "split");
  assert.equal(after.topology, "combined");
  assert.ok(after.invocations.every(row => row.statements <= 50));
  const budget = after.logs.filter(row => row.event === "nightly_budget");
  assert.equal(budget.length, 1);
  assert.equal(budget[0].used, after.trace.length);
  assert.equal(budget[0].deferred, 0);
  cases.push({ fixture: name, totalSourceRows: after.totalSourceRows,
    before: { invocations: before.invocations, counts: before.counts, digests: before.synthesized },
    after: { invocations: after.invocations, counts: after.counts, digests: after.synthesized },
    sourcePreserved: true, otherWorkspaceUnchanged: true });
  for (const item of after.trace) {
    if (!item.sql.startsWith("SELECT")) continue;
    const details = item.plan.map(row => row.detail);
    if (details.some(detail => /SCAN |TEMP B-TREE/.test(detail))) plans.set(item.sql, details);
  }
}
writeFileSync(output, JSON.stringify({ schema: "nightly-local-comparison.v1", beforeSha, afterSha,
  cases, queryPlans: [...plans].map(([sql, details]) => ({ sql, details })),
  localIntegrityPassed: true, remoteAcceptancePassed: false,
  note: "実scheduledのローカルSQL/計画診断。EXPLAIN自体は計数対象外。課金行数、実CPU、遅延、実モデル品質の証拠ではない。処理件数も異なるため性能改善率に換算しない。",
}, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log("6条件の比較整合性を確認。remoteAcceptancePassed=false。");
