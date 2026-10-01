/**
 * T-0089.5.1 (QA): explain off is byte-identical, and explain on changes nothing but the why data,
 * across the query shapes the small fixture in explain-recall.test.ts does not reach: the graph slot,
 * keyword-only and semantic-down recall, empty results, truncated snippets and the compound-stale note.
 *
 * The golden was captured by running these same shapes against release/v4 (before the feature).
 */
import { describe, it, expect } from "vitest";
import golden from "../fixtures/explain-shapes-off-golden.json";
import { SHAPES, runShape } from "../helpers/explain-shapes";

const names = Object.keys(SHAPES);
const stripWhy = (body: any) => body.results ? { ...body, results: body.results.map(({ why: _w, ...r }: any) => r) } : body;
// Part C (05-proof.md, T-0089.5.3): receipt is a new, deliberate field on every recall
// response, predating neither this golden (captured before it existed) nor the explain
// feature this file actually tests. Stripped here the same way `why` is, so this file keeps
// testing what it is for — that explain adds only why data — without re-litigating receipt.
const stripReceipt = (body: any) => { const { receipt: _r, ...rest } = body; return rest; };
// forkの検索診断と経路情報は上流goldenに含まれない。元の結果はそのまま照合し、
// 追加情報がexplainの有無で変わらないことも下で独立に確認する。
const stripForkFields = (body: any) => {
  const { graph_contribution: _g, semantic_unavailable_reason: _s, semantic_retry_at: _t,
    query_signal_cache_hit: _q, ...rest } = body;
  return { ...rest, results: rest.results.map(({ via_source_id: _a, via_target_id: _b,
    via_direction: _d, ...r }: any) => r) };
};
const stripExtras = (body: any) => stripForkFields(stripReceipt(stripWhy(body)));
const stripMcpDiagnostics = (text: string) => text.replace(/\n\nreceipt: \S+(?:\n\nGraph contribution: [^\n]+)?$/, "");
// forkの表示契約を期待値に適用する。結果の本文・順序・丸め済みスコアはgoldenを維持。
const forkMcp = (text: string) => text
  .replace(/\((\d+)% match\)/g, (_m, score) => `(relative score: ${(Number(score) / 100).toFixed(2)})`)
  .replace(/ · from "/g, ' · undirected · from "')
  .replace("second-brain-vectors --dimensions=384", "second-brain-cf-eg128-v1 --dimensions=128");

describe.each(names)("explain shape: %s", (name) => {
  const want = (golden as any)[name];

  it("off: REST JSON and MCP text are byte-identical to release/v4, receipt aside", async () => {
    const off = await runShape(name, false);
    expect(JSON.stringify(stripForkFields(stripReceipt(off.rest)))).toBe(JSON.stringify(want.rest));
    expect(stripMcpDiagnostics(off.mcp)).toBe(forkMcp(want.mcp));
    expect(typeof off.rest.receipt).toBe("string");
    expect(off.mcp).toMatch(/receipt: \S+(?:\n\nGraph contribution: [^\n]+)?$/);
  });

  it("on: same results, order and text; one why line per MCP result; a why object per REST result", async () => {
    const on = await runShape(name, true);
    expect(JSON.stringify(stripExtras(on.rest))).toBe(JSON.stringify(want.rest));
    expect(typeof on.rest.receipt).toBe("string");
    const results = on.rest.results ?? [];
    for (const r of results) expect(Object.keys(r.why).sort()).toEqual(["age_known", "dense_rank", "graph", "keyword_terms", "multipliers", "rerank_move", "rerank_percentile", "slot"]);
    expect(on.mcp).toMatch(/\n\nreceipt: \S+(?:\n\nGraph contribution: [^\n]+)?$/);
    const mcpWithoutReceipt = stripMcpDiagnostics(on.mcp);
    const lines = mcpWithoutReceipt.split("\n");
    const ids = lines.filter(l => l.startsWith("ID: ")).length;
    expect(lines.filter(l => l.startsWith("why: ")).length).toBe(ids);
    expect(ids).toBe(results.length);
    for (const [i, l] of lines.entries()) if (l.startsWith("ID: ")) expect(lines[i + 1]).toMatch(/^why: /);
    expect(lines.filter(l => !l.startsWith("why: ")).join("\n")).toBe(forkMcp(want.mcp));
    expect(on.mcp).not.toContain("—");
  });
});

describe("explain costs nothing on any shape", () => {
  it.each(names)("%s: same D1 statements, model calls and Vectorize queries with explain on", async (name) => {
    const off = await runShape(name, false);
    const on = await runShape(name, true);
    expect(on.cost).toEqual(off.cost);
    expect(on.mcp.split("\n").filter(l => !l.startsWith("why: ")).join("\n")
      .replace(/receipt: \S+/, "receipt: NONCE")).toBe(off.mcp.replace(/receipt: \S+/, "receipt: NONCE"));
    expect(stripReceipt(stripWhy(on.rest))).toEqual(stripReceipt(off.rest));
    expect(off.rest).toHaveProperty("graph_contribution");
    expect(off.rest).toHaveProperty("semantic_unavailable_reason");
    expect(off.rest).toHaveProperty("semantic_retry_at");
    expect(off.rest).toHaveProperty("query_signal_cache_hit", false);
    expect(off.cost[0]).toBeGreaterThan(0);
  });
});

describe("explain shape coverage is real", () => {
  it("graph shapes actually seat a linked or evidence result", async () => {
    for (const name of ["graphSlot", "linkedFew"]) {
      const on = await runShape(name, true);
      const slots = on.rest.results.map((r: any) => r.why.slot);
      expect(slots.some((s: string) => s === "evidence" || s === "linked"), `${name}: ${slots}`).toBe(true);
      const linked = on.rest.results.filter((r: any) => r.hop > 0);
      for (const r of linked) {
        expect(r.why.graph).toEqual({ provenance: "explicit", type: "relates_to", from: expect.any(String) });
        expect(r.why.multipliers === null || typeof r.why.multipliers.recency === "number").toBe(true);
      }
      if (linked.length) expect(on.mcp).toMatch(/why: .*linked from/);
    }
  });

  it("keyword-only shapes report a null dense rank and matched terms", async () => {
    for (const name of ["keywordOnly", "semanticDown"]) {
      const on = await runShape(name, true);
      expect(on.rest.results.length).toBeGreaterThan(0);
      for (const r of on.rest.results) {
        expect(r.why.dense_rank).toBeNull();
        expect(r.why.keyword_terms.length).toBeGreaterThan(0);
      }
    }
  });

  it("the empty, truncated and compound-stale shapes exercise their branches", async () => {
    expect((await runShape("empty", false)).rest.results).toEqual([]);
    expect((await runShape("truncated", false)).mcp).toMatch(/truncated/);
    expect((await runShape("compoundStale", false)).mcp).toMatch(/stale|as of|older/i);
  });
});
