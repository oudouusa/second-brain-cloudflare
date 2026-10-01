import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rerankWithTimeDecay, rerankWithTimeDecayTraced } from "../../src/recall/math";
import { fuseDenseAndKeyword } from "../../src/recall/search";
import { renderRecallText } from "../../src/recall/render";
import type { KeywordRow, RecallMatch, WhyTrace } from "../../src/recall/types";
import { DEFAULTS } from "../../src/config";

const NOW = Date.now();
const DAY = 86400000;
const mk = (id: string, score: number, created_at: number, tags: string[] = []) => ({ id, score, metadata: { parentId: id, created_at, tags } });

describe("rerankWithTimeDecayTraced", () => {
  const matches = [mk("a", 0.9, NOW - 60 * DAY, ["work"]), mk("b", 0.8, NOW - DAY, ["task", "alpha"]), mk("c", 0.7, NOW - 400 * DAY)];
  const args = [new Map([["a", 3]]), new Map([["b", 5]]), ["alpha"] as string[], new Map([["b", 2]]), new Map(), new Map(), DEFAULTS] as const;

  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it("orders and scores exactly like rerankWithTimeDecay", () => {
    const plain = rerankWithTimeDecay(matches, ...args);
    const traced = rerankWithTimeDecayTraced(matches, ...args);
    expect(traced.map(t => t.match)).toEqual(plain);
    expect(traced.map(t => t.match.score)).toEqual(plain.map(m => m.score));
  });

  it("reports the four multipliers that shaped each score", () => {
    const traced = rerankWithTimeDecayTraced(matches, ...args);
    const b = traced.find(t => t.match.id === "b")!.multipliers;
    expect(Object.keys(b).sort()).toEqual(["append_penalty", "combined", "frequency", "importance", "recency", "rolled_up_penalty", "source_weight", "stale_penalty", "tag_boost"]);
    expect(b.tag_boost).toBeGreaterThan(1);
    expect(b.importance).toBeGreaterThan(1);
    expect(b.recency).toBeGreaterThan(0.9);
    const a = traced.find(t => t.match.id === "a")!.multipliers;
    expect(a.frequency).toBeCloseTo(1 + Math.log1p(3), 10);
    expect(a.tag_boost).toBe(1);
  });

  it("reports frequency 1 when recall frequency is switched off", () => {
    const [t] = rerankWithTimeDecayTraced([mk("a", 0.9, NOW)], new Map([["a", 9]]), new Map(), [], new Map(), new Map(), new Map(), DEFAULTS, { useRecallFrequency: false });
    expect(t.multipliers.frequency).toBe(1);
  });
});

describe("fuseDenseAndKeyword keyword trace", () => {
  const row = (id: string, hits: [string, 0 | 1 | 2][]): KeywordRow => ({ id, tags: "[]", source: "api", created_at: NOW, hits: new Map(hits) });
  const corpus = { df: new Map([["gatewright", 1], ["plan", 40]]), total: 200 };

  it("fills the trace with per-term level and idf only for terms the row holds", () => {
    const trace = new Map();
    fuseDenseAndKeyword([], [row("k1", [["gatewright", 2], ["plan", 1]]), row("k2", [["gatewright", 0], ["plan", 2]])], ["gatewright", "plan"], true, corpus, 0.5, false, 0, trace);
    expect(trace.get("k1")).toEqual([
      { term: "gatewright", level: 2, idf: Math.log(1 + 200 / 2) },
      { term: "plan", level: 1, idf: Math.log(1 + 200 / 41) },
    ]);
    expect(trace.get("k2")).toEqual([{ term: "plan", level: 2, idf: Math.log(1 + 200 / 41) }]);
  });

  it("leaves results unchanged whether or not a trace is asked for", () => {
    const rows = [row("k1", [["gatewright", 2]]), row("k2", [["plan", 2]])];
    const a = fuseDenseAndKeyword([], rows, ["gatewright", "plan"], true, corpus, 0.5);
    const b = fuseDenseAndKeyword([], rows, ["gatewright", "plan"], true, corpus, 0.5, false, 0, new Map());
    expect(b).toEqual(a);
  });
});

describe("renderRecallText why line", () => {
  const why = (over: Partial<WhyTrace> = {}): WhyTrace => ({
    dense_rank: 2,
    keyword_terms: [{ term: "gatewright", level: 2, idf: 5.3 }],
    multipliers: { recency: 0.99, frequency: 1, combined: 0.99, importance: 1, tag_boost: 1, append_penalty: 1, rolled_up_penalty: 1, source_weight: 1, stale_penalty: 1 },
    rerank_percentile: 0.9,
    rerank_move: "up",
    age_known: true,
    graph: null,
    slot: "direct",
    ...over,
  });
  const m = (over: Partial<RecallMatch> = {}): RecallMatch => ({
    id: "e1", content: "Body text", score: 1, createdAt: Date.UTC(2026, 8, 20, 12), updatedAt: Date.UTC(2026, 8, 20, 12),
    tags: ["status:canonical"], source: "claude", isUpdate: false, hop: 0,
    validFrom: Date.UTC(2026, 8, 20, 12), validFromStated: false, validUntil: null, validityState: "current",
    supersededBy: null, retractedSource: false,
    ...over,
  });

  it("adds one plain why line after the ID line", () => {
    const out = renderRecallText([m({ why: why() })], "");
    expect(out).toBe(
      `1. [Sep 20, 2026 · claude [status:canonical]] (relative score: 1.00)\nID: e1\nwhy: meaning #2 · keywords "gatewright" (rare) · canonical · recent (Sep 20) · reranked up\nBody text`,
    );
  });

  it("names the memory a linked result was reached from", () => {
    const seed = m({ id: "seed", content: "FTS5 plan", tags: [] });
    const rel = m({ id: "rel", hop: 1, viaProvenance: "inferred", viaFrom: "seed", tags: [], why: why({ dense_rank: null, keyword_terms: [], multipliers: null, rerank_percentile: null, rerank_move: null, age_known: null, graph: { provenance: "inferred", type: "relates_to", from: "seed" }, slot: "linked" }) });
    const out = renderRecallText([seed, rel], "");
    expect(out).toContain('why: linked from "FTS5 plan"');
    expect(out).not.toContain("meaning");
  });

  it("marks a demoted rerank and a partial keyword hit", () => {
    const out = renderRecallText([m({ tags: [], why: why({ keyword_terms: [{ term: "plan", level: 1, idf: 1 }], rerank_percentile: 0.1, rerank_move: "down", multipliers: { recency: 0.5, frequency: 1.4, combined: 0.7, importance: 1, tag_boost: 1.2, append_penalty: 1, rolled_up_penalty: 1, source_weight: 1, stale_penalty: 1 } }) })], "");
    expect(out).toContain('keywords "plan" (inside a longer word)');
    expect(out).toContain("reranked down");
    expect(out).toContain("tag match");
    expect(out).toContain("recalled before");
    expect(out).not.toContain("recent");
  });

  it("does not spend the output budget on why lines", () => {
    const many = Array.from({ length: 5 }, (_, i) => m({ id: `e${i}`, content: "z".repeat(1800), tags: [], why: why() }));
    const withWhy = renderRecallText(many, "");
    const without = renderRecallText(many.map(({ why: _w, ...rest }) => rest), "");
    expect((withWhy.match(/^ID: /gm) ?? []).length).toBe((without.match(/^ID: /gm) ?? []).length);
  });

  it("is byte-identical to the pre-explain rendering when no match carries a why", () => {
    const out = renderRecallText([m({ tags: ["work"] })], "");
    expect(out).toBe(`1. [Sep 20, 2026 · claude [work]] (relative score: 1.00)\nID: e1\nBody text`);
  });
});

describe("rerankWithTimeDecay untraced path", () => {
  it("scores and orders matches exactly like the traced path, with no trace fields riding along", () => {
    const now = Date.UTC(2026, 8, 25, 12, 0, 0);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const matches = [
      { id: "a", score: 0.8, metadata: { parentId: "a", created_at: now, tags: [] } },
      { id: "b", score: 0.6, metadata: { parentId: "b", created_at: now - 400 * 86_400_000, tags: ["rolled-up"] } },
    ];
    const out = rerankWithTimeDecay(matches);
    expect(out).toEqual(rerankWithTimeDecayTraced(matches).map(t => t.match));
    expect((out[0] as any).multipliers).toBeUndefined();
    expect((out[0] as any).ageKnown).toBeUndefined();
    vi.restoreAllMocks();
  });
});
