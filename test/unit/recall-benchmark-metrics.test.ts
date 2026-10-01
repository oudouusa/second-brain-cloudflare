import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { summarizeResults } from "../../benchmarks/recall-v1/evaluate.mjs";

describe("recall benchmark no-hit metrics", () => {
  for (const category of ["ja", "mixed", "identifier"]) {
    it(`counts rank zero as a miss in ${category}, overall and must-pass metrics`, () => {
      const summary = summarizeResults([{ category, rank: 0, mustPass: true }]);
      const miss = { queries: 1, recallAt1: 0, recallAt5: 0, mrr: 0 };

      assert.deepEqual(summary.overall, miss);
      assert.deepEqual(summary.categories[category], miss);
      assert.deepEqual(summary.mustPass, { ...miss, passedTop5: 0, required: 1 });
    });
  }

  it("keeps misses in the denominator without counting them as top-k hits", () => {
    const summary = summarizeResults([
      { category: "ja", rank: 0, mustPass: true },
      { category: "ja", rank: 1, mustPass: true },
      { category: "mixed", rank: 5, mustPass: true },
      { category: "identifier", rank: 6, mustPass: false },
    ]);

    assert.deepEqual(summary.overall, {
      queries: 4, recallAt1: 0.25, recallAt5: 0.5, mrr: 0.341667,
    });
    assert.deepEqual(summary.categories.ja, {
      queries: 2, recallAt1: 0.5, recallAt5: 0.5, mrr: 0.5,
    });
    assert.deepEqual(summary.categories.mixed, {
      queries: 1, recallAt1: 0, recallAt5: 1, mrr: 0.2,
    });
    assert.deepEqual(summary.categories.identifier, {
      queries: 1, recallAt1: 0, recallAt5: 0, mrr: 0.166667,
    });
    assert.deepEqual(summary.mustPass, {
      queries: 3, recallAt1: 0.333333, recallAt5: 0.666667, mrr: 0.4,
      passedTop5: 2, required: 3,
    });
  });

  it("returns zero metrics for empty results and categories", () => {
    const empty = { queries: 0, recallAt1: 0, recallAt5: 0, mrr: 0 };
    assert.deepEqual(summarizeResults([]), {
      overall: empty,
      categories: { ja: empty, mixed: empty, identifier: empty },
      mustPass: { ...empty, passedTop5: 0, required: 0 },
    });
  });

  it("preserves positive-rank metrics when no query is marked must-pass", () => {
    const summary = summarizeResults([
      { category: "ja", rank: 1, mustPass: false },
      { category: "mixed", rank: 5, mustPass: false },
      { category: "identifier", rank: 10, mustPass: false },
    ]);

    assert.deepEqual(summary.overall, {
      queries: 3, recallAt1: 0.333333, recallAt5: 0.666667, mrr: 0.433333,
    });
    assert.deepEqual(summary.mustPass, {
      queries: 0, recallAt1: 0, recallAt5: 0, mrr: 0,
      passedTop5: 0, required: 0,
    });
  });
});
