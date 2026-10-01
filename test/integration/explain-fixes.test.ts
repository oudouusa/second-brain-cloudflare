/** T-0089.5.1 fix round: explain must not leak other members' data, and must add up. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeExplainFixture, restRecall, mcpRecall, NOW, type ExplainFixture } from "../helpers/explain-fixture";
import { rerankWithTimeDecayTraced, type VectorizeMatch } from "../../src/recall/math";
import { renderRecallText } from "../../src/recall/render";
import type { RecallMatch, WhyTrace } from "../../src/recall/types";
import { embeddingMetadata } from "../../src/embedding/profile";
import { DEFAULTS } from "../../src/config";

const DAY = 86_400_000;
let f: ExplainFixture;
beforeEach(async () => { f = await makeExplainFixture(); });
afterEach(() => f.close());

const Q = "query=atlas%20ledger&topK=5&explain=1";
const vec = (id: string, score: number, ageDays: number, tags: string[], extra: Record<string, unknown> = {}) =>
  ({ id, score, metadata: { ...embeddingMetadata(), parentId: id, isUpdate: false, created_at: NOW - ageDays * DAY, tags, ...extra } });

describe("dense_rank leaks no private match", () => {
  it("a foreign vector ranked above the caller's does not shift the caller's dense_rank", async () => {
    const base = await restRecall(f.env, Q);
    f.close(); f = await makeExplainFixture();
    // The filter was rejected: an unfiltered fallback hands back another member's private vector on top.
    (f.env.VECTORIZE.query as any).mockResolvedValue({ matches: [
      vec("foreign-private", 0.99, 1, []),
      vec("e1", 0.9, 2, ["status:canonical", "work"]),
      vec("e2", 0.8, 100, ["idea"]),
      vec("e3", 0.7, 10, []),
    ] });
    const leaked = await restRecall(f.env, Q);
    const ranks = (b: any) => Object.fromEntries(b.results.map((r: any) => [r.id, r.why.dense_rank]));
    expect(ranks(leaked)).toEqual(ranks(base));
    expect(ranks(leaked).e1).toBe(1);
    expect(leaked.results.map((r: any) => r.id)).toEqual(base.results.map((r: any) => r.id));
  });
});

describe("multipliers reconstruct the applied score", () => {
  const fixtures: { name: string; m: VectorizeMatch; tags: string[] }[] = [
    { name: "fresh", m: vec("a", 0.8, 1, []), tags: [] },
    { name: "rolled-up, a year old", m: vec("b", 0.8, 365, ["rolled-up"]), tags: ["rolled-up"] },
    { name: "short append", m: vec("c-update-1", 0.8, 3, [], { content: "short", parentId: "c" }), tags: [] },
    { name: "recalled often, tagged", m: vec("d", 0.8, 400, ["work"]), tags: ["work"] },
  ];
  for (const fx of fixtures) {
    it(`product of reported factors equals the score: ${fx.name}`, () => {
      const [t] = rerankWithTimeDecayTraced([fx.m], new Map([["d", 6], ["a", 2]]), new Map([["a", 4]]), ["work"], new Map(), new Map(), new Map([[(fx.m.metadata as any).parentId, fx.tags]]));
      const x = t.multipliers;
      expect(Object.keys(x).sort()).toEqual(["append_penalty", "combined", "frequency", "importance", "recency", "rolled_up_penalty", "source_weight", "stale_penalty", "tag_boost"]);
      expect(x.combined).toBeCloseTo(Math.min(1, x.recency * x.frequency), 12);
      const product = fx.m.score * x.combined * x.importance * x.tag_boost * x.append_penalty * x.rolled_up_penalty * x.source_weight * x.stale_penalty;
      expect(t.match.score).toBeCloseTo(product, 12);
    });
  }
  it("rolled-up and append penalties are reported, 1 when absent", () => {
    const [r] = rerankWithTimeDecayTraced([vec("b", 0.8, 365, ["rolled-up"])], new Map(), new Map(), [], new Map(), new Map(), new Map([["b", ["rolled-up"]]]));
    expect(r.multipliers.rolled_up_penalty).toBe(0.4);
    expect(r.multipliers.append_penalty).toBe(1);
  });
  it("source_weight is reported and included in the reconstructed product (T-0089.3.1)", () => {
    const cfg = { ...DEFAULTS, SOURCE_WEIGHT_MIRROR: 0.85 };
    const d1Sources = new Map([["e", "email-gmail"]]);
    const [r] = rerankWithTimeDecayTraced(
      [vec("e", 0.8, 5, [])], new Map(), new Map(), [], new Map(), new Map(), new Map([["e", []]]), cfg, { d1Sources },
    );
    expect(r.multipliers.source_weight).toBe(0.85);
    const x = r.multipliers;
    const product = 0.8 * x.combined * x.importance * x.tag_boost * x.append_penalty * x.rolled_up_penalty * x.source_weight;
    expect(r.match.score).toBeCloseTo(product, 12);
  });
});

describe("why line honesty", () => {
  const why = (over: Partial<WhyTrace>): WhyTrace => ({
    dense_rank: 1, keyword_terms: [], multipliers: null, rerank_percentile: null, rerank_move: null, age_known: null, graph: null, slot: "direct", ...over,
  });
  const mult = { recency: 1, frequency: 1, combined: 1, importance: 1, tag_boost: 1, append_penalty: 1, rolled_up_penalty: 1, source_weight: 1, stale_penalty: 1 };
  const line = (w: WhyTrace, source?: string) => {
    const m = { id: "x", content: "hello", score: 1, tags: [], source, createdAt: NOW, hop: 0, why: w } as unknown as RecallMatch;
    return renderRecallText([m], {} as any).split("\n").find(l => l.startsWith("why: "))!;
  };
  it("says nothing about reranking when the position did not move", () => {
    expect(line(why({ rerank_percentile: 0.9, rerank_move: null }))).not.toMatch(/reranked/);
  });
  it("says reranked up or down only when it moved", () => {
    expect(line(why({ rerank_percentile: 0.9, rerank_move: "up" }))).toContain("reranked up");
    expect(line(why({ rerank_percentile: 0.1, rerank_move: "down" }))).toContain("reranked down");
  });
  it("says age unknown, not recent, when the vector had no created_at", () => {
    const l = line(why({ multipliers: mult, age_known: false }));
    expect(l).toContain("age unknown");
    expect(l).not.toContain("recent");
    expect(line(why({ multipliers: mult, age_known: true }))).toContain("recent");
  });
  it("names the source and its demotion only when source_weight is below 1 (T-0089.3.1)", () => {
    const demoted = { ...mult, source_weight: 0.85 };
    const l = line(why({ multipliers: demoted, age_known: true }), "email-gmail");
    expect(l).toContain("mirror source ×0.85");
    expect(line(why({ multipliers: mult, age_known: true }), "email-gmail")).not.toMatch(/source ×/);
  });
});

describe("explain off does not take the traced path", () => {
  it("still returns the golden-equal MCP text (smoke)", async () => {
    expect(await mcpRecall(f.env, { query: "atlas ledger", topK: 5 })).not.toContain("why:");
  });
});

describe("dense_rank leaks nothing through the real filter-rejection retry", () => {
  it("Vectorize rejects the workspace filter, the unfiltered retry returns a foreign vector on top", async () => {
    const base = await restRecall(f.env, Q);
    f.close(); f = await makeExplainFixture();
    const seen: unknown[] = [];
    (f.env.VECTORIZE.query as any).mockImplementation(async (_v: unknown, opts: any) => {
      seen.push(opts?.filter);
      if (opts?.filter) throw new Error("VECTOR_QUERY_ERROR: metadata filter not supported");
      return { matches: [
        vec("foreign-private", 0.99, 1, []),
        vec("e1", 0.9, 2, ["status:canonical", "work"]),
        vec("e2", 0.8, 100, ["idea"]),
        vec("e3", 0.7, 10, []),
      ] };
    });
    const leaked = await restRecall(f.env, Q);
    expect(seen.some(x => x !== undefined), "the filtered attempt happened").toBe(true);
    expect(seen.some(x => x === undefined), "the unfiltered retry happened").toBe(true);
    const ranks = (b: any) => Object.fromEntries(b.results.map((r: any) => [r.id, r.why.dense_rank]));
    expect(ranks(leaked)).toEqual(ranks(base));
    expect(JSON.stringify(leaked)).not.toContain("foreign-private");
  });
});
