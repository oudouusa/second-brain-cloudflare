import { syntheticGemmaPricing } from "./fork-synthetic";
syntheticGemmaPricing();
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/config";
import { ReplayStore, makeReplayAi } from "./ai-replay";
import { loadCorpus, type LoadedCorpus } from "./corpus/loader";
import { ACTORS, EVAL_NOW, WORKSPACES, type CorpusEntry } from "./corpus/types";
import { evaluateGate, formatGate } from "./gate";
import { runVariant } from "./runner";
import type { GoldenQuery } from "./types";
import { getVariant } from "./variants";

// The default-suite check of the eval harness, end to end, on a small synthetic corpus: build, load, recall, score, gate.
// It says nothing about ranking quality on the golden set; that is the full eval (test/eval/full.ts), run by hand.
const MODEL = DEFAULTS.EMBEDDING_MODEL;
const coined = (i: number) => `zq${i.toString(36)}vane`;
const entries: CorpusEntry[] = Array.from({ length: 150 }, (_, i) => ({
  id: `e${i}`, content: `Note ${i} about ${coined(i)} and the ${["garden", "budget", "roadmap", "kitchen"][i % 4]} plan.`, tags: [], source: "api",
  createdAt: EVAL_NOW - (i + 1) * 3_600_000, workspaceId: WORKSPACES.avery, actorId: ACTORS.avery,
}));
const queries: GoldenQuery[] = Array.from({ length: 40 }, (_, i) => ({
  id: `q${i}`, category: "rare-word", text: `${coined(i * 3)} plan`, gold: [{ id: `e${i * 3}`, grade: 2 }], viewer: "avery",
}));

let corpus: LoadedCorpus | undefined;
afterEach(async () => { await corpus?.close(); corpus = undefined; });

describe("eval harness smoke (synthetic corpus, no golden replay)", () => {
  it("runs a variant over 40 queries, finds the gold, leaks nothing, and the gate reads the report", async () => {
    corpus = await loadCorpus({
      spec: { id: "smoke", intent: "tie", entries, edges: [], queries },
      backend: "sqlite", replay: makeReplayAi({ store: new ReplayStore([]), mode: "dry" }), embeddingModel: MODEL,
    });
    const report = await runVariant({ corpus, variant: getVariant("no-rerank"), queries, isolate: "warm", embeddingModel: MODEL });
    expect(report.results).toHaveLength(queries.length);
    expect(report.results.every(r => !r.error && r.leaked.length === 0)).toBe(true);
    const found = report.results.filter((r, i) => r.rankedIds.slice(0, 5).includes(`e${i * 3}`)).length;
    expect(found).toBeGreaterThanOrEqual(38);
    const verdict = evaluateGate(report, report);
    expect(verdict.rules.length).toBeGreaterThan(0);
    expect(formatGate(verdict)).toContain(verdict.verdict);
  }, 60_000);
});
