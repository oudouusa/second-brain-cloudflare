import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DUPLICATE_BLOCK_THRESHOLD,
  DUPLICATE_FLAG_THRESHOLD,
  RECALL_WIDEN_THRESHOLD,
  CHUNK_MAX_CHARS,
} from "../../src/constants";
import { EDGE_INFER_THRESHOLD } from "../../src/graph/edges";
import { MIN_SIMILARITY } from "../../src/insight/score";
import {
  PROFILES,
  normalizeAndProject,
  summarizeResults,
  validateCorpus,
} from "../../benchmarks/recall-v1/evaluate.mjs";
import { validateThresholdCorpus } from "../../benchmarks/recall-v1/calibrate-thresholds.mjs";

describe("thin-fork recall benchmark", () => {
  it("freezes the required 30/15/15 corpus and at least 20 must-pass queries", async () => {
    const corpus = JSON.parse(await readFile("benchmarks/recall-v1/corpus.json", "utf8"));
    expect(validateCorpus(corpus)).toEqual({
      documents: 60,
      queries: 60,
      categories: { ja: 30, mixed: 15, identifier: 15 },
      mustPass: 20,
    });
  });

  it("freezes balanced exact, near-duplicate, related and unrelated threshold cases", async () => {
    const corpus = JSON.parse(await readFile("benchmarks/recall-v1/corpus.json", "utf8"));
    const calibration = JSON.parse(await readFile("benchmarks/recall-v1/threshold-corpus.json", "utf8"));
    expect(validateThresholdCorpus(calibration, corpus.documents)).toEqual({
      cases: 40,
      labels: { exact_duplicate: 10, near_duplicate: 10, related: 10, unrelated: 10 },
    });
  });

  it("records a Gemma result that clears the fork recall gates against BGE", async () => {
    const [bge, gemma] = await Promise.all([
      readFile("benchmarks/recall-v1/results-bge384.json", "utf8").then(JSON.parse),
      readFile("benchmarks/recall-v1/results-embeddinggemma-mrl128-v1.json", "utf8").then(JSON.parse),
    ]);

    expect(gemma.profile).toMatchObject({
      profileId: "embeddinggemma-mrl128-v1",
      rawDimensions: 768,
      dimensions: 128,
      promptVersion: 1,
    });
    expect(gemma.metrics.mustPass).toMatchObject({ passedTop5: 20, required: 20 });
    expect(gemma.metrics.categories.ja.recallAt5).toBeGreaterThan(bge.metrics.categories.ja.recallAt5);
    for (const category of ["mixed", "identifier"]) {
      expect(gemma.metrics.categories[category].recallAt5)
        .toBeGreaterThanOrEqual(bge.metrics.categories[category].recallAt5 - 0.05);
    }
  });

  it("pins calibrated thresholds without admitting observed false positives", async () => {
    const report = JSON.parse(await readFile(
      "benchmarks/recall-v1/thresholds-embeddinggemma-mrl128-v1.json",
      "utf8",
    ));
    const scores = (label: string) => report.cases.filter((item: { label: string }) => item.label === label)
      .map((item: { score: number }) => item.score);
    const exact = scores("exact_duplicate");
    const near = scores("near_duplicate");
    const related = scores("related");
    const unrelated = scores("unrelated");

    expect(exact.every((score: number) => score >= DUPLICATE_BLOCK_THRESHOLD)).toBe(true);
    expect(near.every((score: number) => score >= DUPLICATE_FLAG_THRESHOLD && score < DUPLICATE_BLOCK_THRESHOLD)).toBe(true);
    expect([...related, ...unrelated].every((score: number) => score < DUPLICATE_FLAG_THRESHOLD)).toBe(true);
    expect(related.filter((score: number) => score >= EDGE_INFER_THRESHOLD)).toHaveLength(8);
    expect(unrelated.filter((score: number) => score >= EDGE_INFER_THRESHOLD)).toHaveLength(0);
    expect(near.every((score: number) => score >= MIN_SIMILARITY)).toBe(true);
    expect([...related, ...unrelated].every((score: number) => score < MIN_SIMILARITY)).toBe(true);
    expect(RECALL_WIDEN_THRESHOLD).toBe(0.60);
  });

  it("pins the 1,600-character chunk only after hosted input probing", async () => {
    const report = JSON.parse(await readFile(
      "benchmarks/recall-v1/input-limits-embeddinggemma-mrl128-v1.json",
      "utf8",
    ));
    expect(report.lengths).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ja-500", status: 200, dimensions: 768 }),
      expect.objectContaining({ id: "ja-1000", status: 200, dimensions: 768 }),
      expect.objectContaining({ id: "ja-1600", status: 200, dimensions: 768 }),
      expect.objectContaining({ id: "en-1600", status: 200, dimensions: 768 }),
      expect.objectContaining({ id: "code-1600", status: 200, dimensions: 768 }),
    ]));
    expect(report.suffixSensitivity.every((item: { suffixInfluencedEmbedding: boolean }) => item.suffixInfluencedEmbedding)).toBe(true);
    expect(CHUNK_MAX_CHARS).toBe(1600);
  });

  it("truncates Gemma to 128 dimensions and L2-normalizes it", () => {
    const projected = normalizeAndProject(new Array(768).fill(2), PROFILES["embeddinggemma-mrl128-v1"]);
    expect(projected).toHaveLength(128);
    expect(Math.sqrt(projected.reduce((sum: number, value: number) => sum + value * value, 0))).toBeCloseTo(1, 12);
  });

  it("does not leak evaluator-only titles into production-equivalent document inputs", () => {
    expect(PROFILES["embeddinggemma-mrl128-v1"].documentInput({ title: "評価用", text: "本文" }))
      .toBe("title: none | text: 本文");
  });

  it("rejects a profile dimension mismatch", () => {
    expect(() => normalizeAndProject(new Array(127).fill(1), PROFILES["embeddinggemma-mrl128-v1"]))
      .toThrow(/expected 768/);
  });

  it("computes Recall@1, Recall@5 and MRR deterministically", () => {
    const summary = summarizeResults([
      { category: "ja", rank: 1, mustPass: true },
      { category: "mixed", rank: 5, mustPass: true },
      { category: "identifier", rank: 10, mustPass: false },
    ]);
    expect(summary.overall).toEqual({ queries: 3, recallAt1: 0.333333, recallAt5: 0.666667, mrr: 0.433333 });
    expect(summary.mustPass).toMatchObject({ passedTop5: 2, required: 2 });
  });
});
