/**
 * T-0089.5.1: `explain` says why each memory came back, and asking costs nothing else.
 *
 * 上流の説明なしgoldenにforkのgraph診断・relative score表示を反映している。
 * explainの追加で順位・本文・検索コストが変わらないことを固定出力と比較する。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import golden from "../fixtures/explain-off-golden.json";
import { makeExplainFixture, restRecall, mcpRecall, type ExplainFixture } from "../helpers/explain-fixture";

let f: ExplainFixture;
beforeEach(async () => { f = await makeExplainFixture(); });
afterEach(() => f.close());
// Each recall bumps recall_count, which feeds the next one's ranking: every comparison against a golden starts from a fresh brain.
const fresh = async () => { f.close(); f = await makeExplainFixture(); return f.env; };

const Q = "query=atlas%20ledger&topK=5";
const stripWhy = (body: any) => ({ ...body, results: body.results.map(({ why: _w, ...rest }: any) => rest) });
// Part C (05-proof.md, T-0089.5.3): receipt is a new, deliberate field on every recall
// response, predating this golden (captured before it existed). Stripped the same way `why`
// is, so this file keeps testing what it is for — explain's own isolation — not receipt.
const stripReceipt = (body: any) => { const { receipt: _r, ...rest } = body; return rest; };
const noReceiptLine = (text: string) => text.replace(/\n\nreceipt: \S+/, "");

describe("explain off (the default)", () => {
  it("REST JSON is byte-identical to the pre-feature output, receipt aside", async () => {
    const plain = await restRecall(await fresh(), Q);
    const hop = await restRecall(await fresh(), `${Q}&hops=1`);
    expect(JSON.stringify(stripReceipt(plain))).toBe(JSON.stringify(golden.rest));
    expect(JSON.stringify(stripReceipt(hop))).toBe(JSON.stringify(golden.restHops));
    expect(typeof plain.receipt).toBe("string");
  });

  it("MCP text is byte-identical to the pre-feature output, receipt aside", async () => {
    expect(noReceiptLine(await mcpRecall(await fresh(), { query: "atlas ledger", topK: 5 }))).toBe(golden.mcp);
    expect(noReceiptLine(await mcpRecall(await fresh(), { query: "atlas ledger", topK: 5, hops: 1 }))).toBe(golden.mcpHops);
    expect(noReceiptLine(await mcpRecall(await fresh(), { query: "atlas ledger", topK: 5, explain: false }))).toBe(golden.mcp);
  });

  it("carries no why key on any result", async () => {
    const body = await restRecall(f.env, Q);
    for (const r of body.results) expect(r).not.toHaveProperty("why");
  });
});

describe("explain on", () => {
  it("REST: the same results in the same order and scores, plus a why object per result", async () => {
    const on = await restRecall(await fresh(), `${Q}&explain=1`);
    expect(stripReceipt(stripWhy(on))).toEqual(golden.rest);
    for (const r of on.results) {
      expect(Object.keys(r.why).sort()).toEqual(["age_known", "dense_rank", "graph", "keyword_terms", "multipliers", "rerank_move", "rerank_percentile", "slot"]);
    }
  });

  it("REST: reports dense rank, keyword terms, multipliers and slot from what recall computed", async () => {
    const { results } = await restRecall(f.env, `${Q}&explain=1`);
    const e1 = results.find((r: any) => r.id === "e1").why;
    expect(e1.dense_rank).toBe(1);
    expect(e1.keyword_terms.map((t: any) => t.term).sort()).toEqual(["atlas", "ledger"]);
    for (const t of e1.keyword_terms) {
      expect(t.level).toBe(2);
      expect(t.idf).toBeGreaterThan(0);
    }
    expect(Object.keys(e1.multipliers).sort()).toEqual(["append_penalty", "combined", "frequency", "importance", "recency", "rolled_up_penalty", "source_weight", "stale_penalty", "tag_boost"]);
    expect(e1.multipliers.frequency).toBeCloseTo(1 + Math.log1p(2), 2);
    expect(e1.multipliers.importance).toBeGreaterThan(1);
    expect(e1.rerank_percentile).toBeNull();
    expect(e1.graph).toBeNull();
    expect(e1.slot).toBe("direct");
    const e2 = results.find((r: any) => r.id === "e2").why;
    expect(e2.dense_rank).toBe(2);
    expect(e2.multipliers.recency).toBeLessThan(e1.multipliers.recency);
  });

  it("REST: works with hops and a tag filter", async () => {
    const hop = await restRecall(await fresh(), `${Q}&hops=1&explain=1`);
    expect(stripReceipt(stripWhy(hop))).toEqual(golden.restHops);
    const tagged = await restRecall(f.env, `${Q}&tag=idea&explain=1`);
    expect(tagged.results.length).toBeGreaterThan(0);
    for (const r of tagged.results) expect(r.why).toBeDefined();
  });

  it("MCP: one why line per result after its ID line, everything else unchanged", async () => {
    const on = await mcpRecall(await fresh(), { query: "atlas ledger", topK: 5, explain: true });
    expect(on).toMatch(/\n\nreceipt: \S+$/);
    const lines = noReceiptLine(on).split("\n");
    const whyLines = lines.filter(l => l.startsWith("why: "));
    expect(whyLines).toHaveLength(3);
    for (const [i, l] of lines.entries()) if (l.startsWith("ID: ")) expect(lines[i + 1]).toMatch(/^why: /);
    expect(whyLines[0]).toBe('why: meaning #1 · keywords "atlas", "ledger" · canonical · recent (Sep 23) · high importance · recalled before');
    expect(lines.filter(l => !l.startsWith("why: ")).join("\n")).toBe(golden.mcp);
    expect(on).not.toContain("—");
  });

  it("costs no extra D1 statements, model calls or Vectorize queries", async () => {
    const counts = () => ({
      d1: vi.spyOn(f.env.DB, "prepare"),
      ai: vi.spyOn((f.env.AI as any), "run"),
      vec: vi.spyOn(f.env.VECTORIZE, "query"),
    });
    await restRecall(f.env, Q); // warms per-isolate caches so both measured calls start alike
    const off = counts();
    off.d1.mockClear(); off.ai.mockClear(); off.vec.mockClear(); // the AI and Vectorize mocks already hold the warm-up call
    await restRecall(f.env, Q);
    const base = [off.d1.mock.calls.length, off.ai.mock.calls.length, off.vec.mock.calls.length];
    off.d1.mockClear(); off.ai.mockClear(); off.vec.mockClear();
    await restRecall(f.env, `${Q}&explain=1`);
    expect([off.d1.mock.calls.length, off.ai.mock.calls.length, off.vec.mock.calls.length]).toEqual(base);
    expect(base[0]).toBeGreaterThan(0);
  });
});

describe("the MCP recall tool", () => {
  it("advertises explain in its schema and says when to use it, in one short sentence", async () => {
    const { RECALL_DESCRIPTION } = await import("../../src/mcp/server");
    expect(RECALL_DESCRIPTION).toMatch(/explain/);
    expect(RECALL_DESCRIPTION.split("EXPLAIN.")[1].split("\n")[0]).not.toContain("—");
  });
});
