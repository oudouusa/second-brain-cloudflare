import { syntheticGemmaPricing } from "./fork-synthetic";
syntheticGemmaPricing();
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { UsageError, assertJsonPathAllowed, describeVerdict, exitCodeFor, formatKnownGapDelta, formatReport, main, parseCli, runProblems } from "./cli";
import { CORE_DATA_DIR } from "./corpus/build";
import { evaluateGate } from "./gate";
import { buildCorpus } from "./corpus/build";
import { resolve } from "node:path";
import { registerVariant, unregisterVariant } from "./variants";
import { registerCorpusProvider, resolveCorpus } from "./corpora";
import { ACTORS, EVAL_NOW, WORKSPACES, type CorpusEntry } from "./corpus/types";
import { RUNNER_VERSION, type CostSample, type GoldenQuery, type QueryResult, type VariantReport } from "./types";
import { cleanTemp } from "../helpers/tmp";

afterEach(cleanTemp);

const cost: CostSample = { d1Statements: 8, d1RowsRead: null, aiCalls: 1, embeddingCalls: 1, vectorizeQueries: 1, kvReads: 1, neurons: 2, neuronsEstimated: false, wallMs: 30 };
const result = (o: Partial<QueryResult> & { queryId: string }): QueryResult => ({
  category: "paraphrase", clusterKey: o.queryId, rankedIds: [], leaked: [],
  metrics: { recall5: 0.5, recall10: 0.75, mrr10: 0.4, ndcg10: 0.6 }, cost, ...o,
});
const report = (results: QueryResult[], o: Partial<VariantReport> = {}): VariantReport => ({
  schema: 1, variant: "baseline", corpus: "c", embeddingModel: "hash-smoke", d1Backend: "sqlite", isolate: "warm", topK: 10, runnerVersion: 1, results, ...o,
});

describe("parseCli", () => {
  it("parses --exclude-needles as id globs for a comparison and refuses anything else", () => {
    expect(parseCli(["--compare", "baseline,rerank", "--exclude-needles", "n-lcoh-*, h-long-*"])).toMatchObject({ kind: "compare", excludeNeedles: ["n-lcoh-*", "h-long-*"] });
    expect(parseCli(["--compare", "baseline,rerank"])).toMatchObject({ excludeNeedles: [] });
    expect(() => parseCli(["--compare", "baseline,rerank", "--exclude-needles", "n-lcoh;rm"])).toThrow(/id globs/);
  });

  it("prepare takes --exclude-needles too, so the reduced corpus's rows can be recorded", () => {
    expect(parseCli(["prepare", "--variant", "rerank-auto", "--exclude-needles", "n-lcoh-*"])).toMatchObject({ kind: "prepare", excludeNeedles: ["n-lcoh-*"] });
    expect(parseCli(["prepare", "--variant", "rerank-auto"])).toMatchObject({ excludeNeedles: [] });
  });

  it("parses the contract forms", () => {
    expect(parseCli(["--variant", "rerank", "--corpus", "scale-20k", "--json", "/tmp/x.json"]))
      .toMatchObject({ kind: "run", variant: "rerank", corpus: "scale-20k", json: "/tmp/x.json", d1: "sqlite", isolate: "warm" });
    expect(parseCli(["--compare", "baseline,rerank", "--target", "paraphrase,common-word", "--allow-unmeasured-rows"]))
      .toMatchObject({ kind: "compare", variants: ["baseline", "rerank"], corpus: "core-1k", target: ["paraphrase", "common-word"], allowUnmeasuredRows: true });
    expect(parseCli(["prepare", "--variant", "baseline", "--corpus", "core-1k", "--max-neurons", "500"]))
      .toMatchObject({ kind: "prepare", maxNeurons: 500 });
    expect(parseCli(["lock"])).toMatchObject({ kind: "lock", corpus: "core-1k" });
    expect(parseCli(["lock", "--accept-data-change", "new queries"])).toMatchObject({ kind: "lock", acceptDataChange: "new queries" });
    expect(parseCli(["--list"])).toEqual({ kind: "list" });
    expect(parseCli(["--compare", "a,b", "--target-gaps", "T-0072,T-0073"])).toMatchObject({ targetGaps: ["T-0072", "T-0073"] });
    expect(parseCli(["--compare", "a,b", "--target-subsets", "knowledge-update:ku-silent,temporal-during:backdated-past"]))
      .toMatchObject({ targetSubsets: ["knowledge-update:ku-silent", "temporal-during:backdated-past"] });
    expect(parseCli(["--compare", "a,b"])).toMatchObject({ targetSubsets: [] });
  });

  it("rejects bad input with a UsageError", () => {
    expect(() => parseCli([])).toThrow(UsageError);
    expect(() => parseCli(["--variant", "x", "--d1", "postgres"])).toThrow(/d1/);
    expect(() => parseCli(["--compare", "onlyone"])).toThrow(/two/);
    expect(() => parseCli(["--compare", "a,b", "--target", "nonsense"])).toThrow(/category/);
    expect(() => parseCli(["--variant", "x", "--isolate", "lukewarm"])).toThrow(/isolate/);
    expect(() => parseCli(["--variant", "x", "--limit", "abc"])).toThrow(/limit/);
    expect(() => parseCli(["prepare", "--variant", "x", "--max-neurons", "-1"])).toThrow(/max-neurons/);
    expect(() => parseCli(["--bogus"])).toThrow(UsageError);
    expect(() => parseCli(["--variant", "x", "--limit", "3.7"])).toThrow(/limit/);
    expect(() => parseCli(["--variant", "x", "--limit", "0"])).toThrow(/limit/);
    expect(() => parseCli(["prepare", "--variant", "x", "--limit", "5"])).toThrow(/limit/);
    expect(() => parseCli(["prepare", "--variant", "x", "--json", "/tmp/x.json"])).toThrow(/json/);
    expect(() => parseCli(["lock", "--json", "/tmp/x.json"])).toThrow(/json/);
    expect(() => parseCli(["lock", "--limit", "5"])).toThrow(/limit/);
    expect(() => parseCli(["lock", "--accept-data-change", " "])).toThrow(/reason/);
    expect(() => parseCli(["--variant", "x", "--accept-data-change", "why"])).toThrow(/only applies to lock/);
  });
});

describe("exit codes and formatting", () => {
  it("maps verdicts to 0, 1, and 3", () => {
    expect([exitCodeFor("PASS"), exitCodeFor("FAIL"), exitCodeFor("INCONCLUSIVE")]).toEqual([0, 1, 3]);
  });

  it("prints per-category metrics, cost, degraded counts, and a hash-embedding warning", () => {
    const text = formatReport(report([result({ queryId: "q", degraded: ["semantic-unavailable"] }), result({ queryId: "r" })]));
    expect(text).toMatch(/paraphrase/);
    expect(text).toMatch(/0\.750/);
    expect(text).toMatch(/rows_read: not measured/);
    expect(text).toMatch(/WARNING.*hash/i);
    expect(text).toMatch(/degraded 1/);
  });

  it("excludes known gaps from the headline, gives them their own block, and adds an all-queries line", () => {
    const text = formatReport(report([
      result({ queryId: "ok", category: "identifier", metrics: { recall5: 1, recall10: 1, mrr10: 1, ndcg10: 1 } }),
      result({ queryId: "gap", category: "identifier", tags: ["known-gap", "gap:T-0072"], metrics: { recall5: 0, recall10: 0, mrr10: 0, ndcg10: 0 } }),
    ]));
    const lines = text.split("\n");
    const identifier = lines.find(l => /^\s+identifier\s/.test(l))!;
    expect(identifier).toMatch(/n=1\s/);
    expect(identifier).toMatch(/recall@5 1\.000/);
    expect(text).toMatch(/known-gap queries are excluded from the headline/i);
    expect(text).toMatch(/known gaps:/i);
    expect(text).toMatch(/gap:T-0072\s+n=1\s.*recall@5 0\.000/);
    expect(lines.find(l => /all queries\s/.test(l))).toMatch(/n=2\s.*recall@5 0\.500/);
  });

  it("tells the reader exactly how to get a verdict when rows_read is unmeasured", () => {
    const many = report(Array.from({ length: 240 }, (_, i) => result({ queryId: `q${i}`, clusterKey: `c${i % 40}` })), { embeddingModel: "m", runnerVersion: RUNNER_VERSION });
    const better = { ...many, variant: "better", results: many.results.map(r => ({ ...r, metrics: { recall5: 1, recall10: 1, mrr10: 1, ndcg10: 1 } })) };
    const gate = evaluateGate(many, better); // sqlite reports: rows_read is null, and no --allow-unmeasured-rows
    expect(gate.verdict).toBe("INCONCLUSIVE");
    const text = describeVerdict(gate);
    expect(text).toMatch(/rows_read is unmeasured on the sqlite backend/);
    expect(text).toMatch(/--d1 workerd for a full verdict/);
    expect(text).toMatch(/--allow-unmeasured-rows for a cost-blind comparison/);
  });

  it("names the rule behind a verdict", () => {
    const rule = (r: string, status: "pass" | "fail" | "inconclusive") => ({ rule: r, status, detail: "" });
    const base = { deltas: [], mde: {}, subsetRegressions: [], floorFailures: [] };
    expect(describeVerdict({ ...base, verdict: "FAIL", rules: [rule("regression", "pass"), rule("improvement", "fail")] })).toMatch(/improvement only; no regression/);
    expect(describeVerdict({ ...base, verdict: "FAIL", rules: [rule("isolation", "fail"), rule("improvement", "fail")] })).toBe("FAIL (failed: isolation, improvement)");
    expect(describeVerdict({ ...base, verdict: "INCONCLUSIVE", rules: [{ rule: "power", status: "inconclusive", detail: "100 queries is below the 200-query floor" }] }))
      .toBe("INCONCLUSIVE (power: 100 queries is below the 200-query floor)");
    expect(describeVerdict({ ...base, verdict: "PASS", rules: [] })).toBe("PASS");
  });

  it("prints no known-gap block or all-queries line when no query is tagged", () => {
    const text = formatReport(report([result({ queryId: "a" })]));
    expect(text).not.toMatch(/known gap/i);
    expect(text).not.toMatch(/all queries\s+n=/);
  });

  it("compares known-gap groups between two reports", () => {
    const gap = (r5: number) => result({ queryId: "g", tags: ["gap:T-0073"], metrics: { recall5: r5, recall10: r5, mrr10: r5, ndcg10: r5 } });
    const text = formatKnownGapDelta(report([gap(0)]), report([gap(1)], { variant: "rerank" }));
    expect(text).toMatch(/gap:T-0073/);
    expect(text).toMatch(/0\.000 -> 1\.000/);
    expect(text).toMatch(/excluded from the headline/);
    expect(text).not.toMatch(/outside the headline/);
    expect(formatKnownGapDelta(report([result({ queryId: "a" })]), report([result({ queryId: "a" })]))).toBe("");
  });
});

describe("main (end to end on a tiny registered corpus)", () => {
  const entry = (id: string, content: string, ws: keyof typeof WORKSPACES = "avery"): CorpusEntry => ({
    id, content, tags: [], source: "api", createdAt: EVAL_NOW - 86_400_000, workspaceId: WORKSPACES[ws], actorId: ACTORS.avery,
  });
  const queries: GoldenQuery[] = Array.from({ length: 4 }, (_, i) => ({
    id: `q${i}`, category: "rare-word", text: `zebra${i} alpha`, gold: [{ id: `a${i}`, grade: 2 }], viewer: "avery", ...(i === 3 && { tags: ["known-gap", "gap:T-0072"] }),
  }));
  registerCorpusProvider("tiny-cli", id => id === "tiny-cli", () => ({
    id: "tiny-cli", intent: "tie",
    entries: [...queries.map((q, i) => entry(`a${i}`, `note about zebra${i} alpha planning`)), ...Array.from({ length: 12 }, (_, i) => entry(`f${i}`, `gardening note ${i}`))],
    edges: [], queries,
  }));
  const outPath = () => join(mkdtempSync(join(tmpdir(), "eval-cli-")), "r.json");

  it("runs a variant with hash embeddings, writes JSON carrying tags, and exits 0", async () => {
    const out = outPath();
    expect(await main(["--variant", "baseline", "--corpus", "tiny-cli", "--hash-embeddings", "--json", out])).toBe(0);
    const r = JSON.parse(readFileSync(out, "utf8")) as VariantReport;
    expect(r.results).toHaveLength(4);
    expect(r.embeddingModel).toBe("hash-smoke");
    expect(r.results[3].tags).toEqual(["known-gap", "gap:T-0072"]);
  });

  it("compare exits 3 (inconclusive) when the query set is below the power floor, and 2 on a usage error", async () => {
    expect(await main(["--compare", "baseline,like", "--corpus", "tiny-cli", "--hash-embeddings", "--allow-unmeasured-rows"])).toBe(3);
    expect(await main(["--compare", "baseline"])).toBe(2);
  });

  it("compares saved report files and returns 1 (FAIL) on a hard-invariant violation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-cli-"));
    const good = report([result({ queryId: "a" })]);
    const leaky = report([result({ queryId: "a", leaked: ["x"] })], { variant: "bad" });
    writeFileSync(join(dir, "b.json"), JSON.stringify(good));
    writeFileSync(join(dir, "c.json"), JSON.stringify(leaky));
    expect(await main(["--compare", `${join(dir, "b.json")},${join(dir, "c.json")}`, "--allow-unmeasured-rows"])).toBe(1);
  });

  it("compare prints the per-query losers, outside the verdict, even when winners outweigh them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-cli-"));
    const many = report(Array.from({ length: 240 }, (_, i) => result({ queryId: `q${i}`, category: "paraphrase", clusterKey: `c${i % 40}` })));
    const better = { ...many, variant: "better", results: many.results.map((r, i) => ({ ...r, metrics: i === 5 ? { recall5: 0, recall10: 0, mrr10: 0, ndcg10: 0 } : { recall5: 1, recall10: 1, mrr10: 1, ndcg10: 1 } })) };
    writeFileSync(join(dir, "b.json"), JSON.stringify(many));
    writeFileSync(join(dir, "c.json"), JSON.stringify(better));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main(["--compare", `${join(dir, "b.json")},${join(dir, "c.json")}`, "--allow-unmeasured-rows"]);
      const out = log.mock.calls.map(c => String(c[0])).join("\n");
      expect(out).toMatch(/losers: 1 query worsened/);
      expect(out).toMatch(/q5\s+paraphrase/);
      // the list sits after the verdict block, so it never reads as part of the ruling
      expect(out.indexOf("losers:")).toBeGreaterThan(out.indexOf("GATE:"));
    } finally {
      log.mockRestore();
    }
  });

  it("a hash-embedding comparison can never PASS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-cli-"));
    const many = report(Array.from({ length: 240 }, (_, i) => result({ queryId: `q${i}`, category: "paraphrase", clusterKey: `c${i % 40}` })));
    writeFileSync(join(dir, "b.json"), JSON.stringify(many));
    const better = { ...many, variant: "better", results: many.results.map(r => ({ ...r, metrics: { recall5: 1, recall10: 1, mrr10: 1, ndcg10: 1 } })) };
    writeFileSync(join(dir, "c.json"), JSON.stringify(better));
    expect(await main(["--compare", `${join(dir, "b.json")},${join(dir, "c.json")}`, "--allow-unmeasured-rows"])).toBe(3);
  });

  it("parses --llm-tags, defaulting to the stand-in, and refuses anything else", () => {
    expect(parseCli(["--variant", "baseline"])).toMatchObject({ llmTags: "stand-in" });
    expect(parseCli(["--variant", "baseline", "--llm-tags", "empty"])).toMatchObject({ llmTags: "empty" });
    expect(parseCli(["prepare", "--variant", "baseline", "--llm-tags", "empty"])).toMatchObject({ kind: "prepare", llmTags: "empty" });
    expect(() => parseCli(["--variant", "baseline", "--llm-tags", "oracle"])).toThrow(/--llm-tags must be stand-in or empty/);
  });

  it("formatReport names the tag arm and its caveats only when the LLM arm answered calls", () => {
    const called = report([result({ queryId: "a", cost: { ...cost, aiCalls: cost.embeddingCalls + 1 } })]);
    const stand = formatReport({ ...called, llmTags: "stand-in" });
    expect(stand).toMatch(/llm tags\s+stand-in/);
    expect(stand).toMatch(/agreement with the real model is unmeasured/);
    expect(stand).toMatch(/excludes synthesizeInsight/);
    const empty = formatReport({ ...called, llmTags: "empty" });
    expect(empty).toMatch(/llm tags\s+empty/);
    expect(empty).not.toMatch(/agreement with the real model/);
    expect(empty).toMatch(/excludes synthesizeInsight/);
  });

  it("formatReport calls the tag arm inert, with no unmeasured-agreement caveat, when no LLM call was made", () => {
    const quiet = report([result({ queryId: "a", cost: { ...cost, aiCalls: cost.embeddingCalls } })]);
    const text = formatReport({ ...quiet, llmTags: "stand-in" });
    expect(text).toMatch(/llm tags\s+stand-in \(inert: no LLM call was made\)/);
    expect(text).not.toMatch(/agreement with the real model/);
  });

  it("formatReport says @5 comes from the top-10 prefix, and never suggests --d1 workerd on a workerd run", () => {
    const base = report([result({ queryId: "a" }), result({ queryId: "b" })]);
    const text = formatReport(base);
    expect(text).toMatch(/caveat: recall@5 and MRR are read from the top-10 prefix/);
    expect(text).toMatch(/production's topK 5 is the first 5 of it/);
    expect(text).toMatch(/rows_read: not measured \(use --d1 workerd\)/);
    const partial = formatReport({ ...base, d1Backend: "workerd", results: base.results.map((r, i) => ({ ...r, cost: { ...r.cost, d1RowsRead: i ? null : 5 } })) });
    expect(partial).toMatch(/rows_read: 1 of 2 queries reported no rows_read/);
    expect(partial).not.toMatch(/use --d1 workerd/);
  });

  it("formatReport states where the neuron figures come from", () => {
    const base = report([result({ queryId: "a" })]);
    expect(formatReport({ ...base, neuronSource: "projected" })).toMatch(/neurons.*projected from local token counts/);
    expect(formatReport({ ...base, neuronSource: "provider" })).toMatch(/neurons.*provider-reported/);
  });

  it("parses export-cache and refuses what it cannot honor", async () => {
    expect(parseCli(["export-cache"])).toMatchObject({ kind: "export-cache", corpus: "core-1k" });
    expect(() => parseCli(["export-cache", "--limit", "5"])).toThrow(UsageError);
    expect(() => parseCli(["export-cache", "--json", "x.json"])).toThrow(UsageError);
    expect(() => parseCli(["export-cache", "--corpus", "scale-5k"])).toThrow(/only the core-1k cache is committed/);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try { expect(await main(["export-cache", "--hash-embeddings"])).toBe(2); } finally { err.mockRestore(); }
  });

  it("--list prints variants and corpora", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main(["--list"])).toBe(0);
      const out = log.mock.calls.map(c => String(c[0])).join("\n");
      expect(out).toMatch(/baseline/);
      expect(out).toMatch(/core-1k/);
    } finally {
      log.mockRestore();
    }
  });

  describe("a broken run is never a success", () => {
    it("runProblems names errors, leaks, and degraded queries across ALL queries, gaps included", () => {
      expect(runProblems(report([result({ queryId: "a" })]))).toEqual([]);
      expect(runProblems(report([result({ queryId: "a", error: "replay cache miss" })])).join()).toMatch(/1 query error/);
      expect(runProblems(report([result({ queryId: "a", leaked: ["x"] })])).join()).toMatch(/1 cross-workspace leak/);
      expect(runProblems(report([result({ queryId: "a", degraded: ["semantic-unavailable"] })])).join()).toMatch(/1 degraded/);
      expect(runProblems(report([result({ queryId: "a", tags: ["known-gap"], error: "boom" })])).join()).toMatch(/1 query error/);
    });

    it("run exits 1 on a degraded run and still writes --json for inspection", async () => {
      // an unknown embedding model has no neuron rate, so every query's dense arm fails and recall reports it
      registerVariant({ name: "broken-embed", description: "test only", config: { EMBEDDING_MODEL: "@cf/none/absent" } });
      try {
        const out = outPath();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          expect(await main(["--variant", "broken-embed", "--corpus", "tiny-cli", "--hash-embeddings", "--json", out])).toBe(1);
        } finally { log.mockRestore(); }
        const r = JSON.parse(readFileSync(out, "utf8")) as VariantReport;
        expect(r.results.some(x => x.degraded?.length || x.error)).toBe(true);
      } finally { unregisterVariant("broken-embed"); }
    });
  });

  describe("--json cannot overwrite committed data", () => {
    const data = resolve(CORE_DATA_DIR, "..");
    it("refuses paths under test/eval/data, including baselines that do not exist yet", () => {
      expect(() => assertJsonPathAllowed(resolve(data, "baselines/core-1k.bge-small-en-v1.5.json"))).toThrow(UsageError);
      expect(() => assertJsonPathAllowed(resolve(data, "core/queries.jsonl"))).toThrow(/test\/eval\/data/);
      expect(() => assertJsonPathAllowed(resolve(data, "core/../baselines/x.json"))).toThrow(UsageError);
      expect(() => assertJsonPathAllowed(join(tmpdir(), "ok.json"))).not.toThrow();
    });

    it("resolves symlinks: a link into the data dir, and a dangling link to a new baseline, are refused", () => {
      const dir = mkdtempSync(join(tmpdir(), "eval-link-"));
      symlinkSync(resolve(data, "core"), join(dir, "dirlink"));
      expect(() => assertJsonPathAllowed(join(dir, "dirlink/out.json"))).toThrow(UsageError);
      symlinkSync(resolve(data, "baselines/never-written.json"), join(dir, "filelink.json"));
      expect(() => assertJsonPathAllowed(join(dir, "filelink.json"))).toThrow(UsageError);
    });

    it("main refuses and writes nothing", async () => {
      const target = resolve(data, "baselines/should-not-exist.json");
      expect(await main(["--variant", "baseline", "--corpus", "tiny-cli", "--hash-embeddings", "--json", target])).toBe(2);
      expect(existsSync(target)).toBe(false);
    });
  });

  describe("report provenance", () => {
    it("core corpora fingerprint their golden-data files; other corpora have none", async () => {
      const fp = buildCorpus("core-1k").dataFingerprint!;
      const manifest = JSON.parse(readFileSync(resolve(CORE_DATA_DIR, "manifest.json"), "utf8")) as { files: Record<string, string> };
      expect(fp).toEqual(manifest.files);
      expect(await resolveCorpus("tiny-cli").then(c => c.dataFingerprint)).toBeUndefined();
    });

    it("run records limit and the golden-data fingerprint in the report", async () => {
      const out = outPath();
      registerCorpusProvider("tiny-fingerprint", id => id === "tiny-fingerprint", async () => ({ ...(await resolveCorpus("tiny-cli")), id: "tiny-fingerprint", dataFingerprint: buildCorpus("core-1k").dataFingerprint }));
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await main(["--variant", "baseline", "--corpus", "tiny-fingerprint", "--hash-embeddings", "--limit", "3", "--json", out])).toBe(0);
      } finally { log.mockRestore(); }
      const r = JSON.parse(readFileSync(out, "utf8")) as VariantReport;
      expect(r.limit).toBe(3);
      expect(r.dataFingerprint).toEqual(buildCorpus("core-1k").dataFingerprint);
      expect(r.runnerVersion).toBeGreaterThanOrEqual(2);
    });
  });

  it("lock on a core corpus refuses hash embeddings for that reason and writes no file", async () => {
    const baselines = resolve(CORE_DATA_DIR, "../baselines/core-1k.bge-small-en-v1.5.json");
    const manifest = resolve(CORE_DATA_DIR, "manifest.json");
    const before = readFileSync(manifest, "utf8");
    const existed = existsSync(baselines);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await main(["lock", "--corpus", "core-1k", "--hash-embeddings"])).toBe(2);
      expect(err.mock.calls.map(c => String(c[0])).join("\n")).toMatch(/hash-embeddings/);
      expect(existsSync(baselines)).toBe(existed);
      expect(readFileSync(manifest, "utf8")).toBe(before);
    } finally {
      err.mockRestore();
      if (!existed) rmSync(baselines, { force: true }); // a mutant that skips the guard must not leave a bogus lock behind
    }
  });
});
