import { syntheticGemmaPricing } from "./fork-synthetic";
syntheticGemmaPricing();
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { ReplayStore, makeReplayAi, type LiveAi } from "./ai-replay";
import { ACTORS, EVAL_NOW, WORKSPACES, type CorpusEntry, type CorpusSpec } from "./corpus/types";
import { RECORD_RERANK_TIMEOUT_MS, exportCache, prepare, withRecordTimeout } from "./prepare";
import { RERANK_MODEL, RERANK_TIMEOUT_MS } from "../../src/constants";
import { hashVector } from "./vectors";
import { getVariant, registerVariant, unregisterVariant } from "./variants";
import { cleanTemp } from "../helpers/tmp";

afterEach(cleanTemp);

const MODEL = "@cf/google/embeddinggemma-300m";
const entry = (id: string, content: string): CorpusEntry => ({ id, content, tags: [], source: "api", createdAt: EVAL_NOW - 86_400_000, workspaceId: WORKSPACES.avery, actorId: ACTORS.avery });
const spec: CorpusSpec = {
  id: "tiny-prepare", intent: "tie",
  entries: [entry("a", "xylo alpha plan"), entry("b", "beta gardening note"), entry("c", "gamma tomato note")],
  edges: [],
  queries: [{ id: "q", category: "rare-word", text: "xylo alpha", gold: [{ id: "a", grade: 2 }], viewer: "avery" }],
};
const PRODUCER = { kind: "local-transformers-js", library: "@huggingface/transformers", libraryVersion: "4.3.0", onnxRuntime: "onnxruntime-node@1.30.0", repo: "BAAI/bge-small-en-v1.5", revision: "abc", dtype: "fp32" } as const;
const live = (): LiveAi & { run: ReturnType<typeof vi.fn> } => ({
  producer: () => PRODUCER,
  run: vi.fn(async (_model: string, input: unknown) => ({
    data: (input as { text: string[] }).text.map(t => hashVector(t, 768)),
    usage: { prompt_tokens: 4, total_tokens: 4 },
  })),
});

// The store only accepts paths inside <root>/.eval-cache, so each test gets a temp root.
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "eval-prepare-"));
  mkdirSync(join(root, ".eval-cache"), { recursive: true });
  return { root, file: join(root, ".eval-cache", "c.jsonl") };
};

describe("prepare", () => {
  const args = (store: ReplayStore, l: LiveAi, maxNeurons = 1000) => ({
    spec, variant: getVariant("no-rerank"), backend: "sqlite" as const, model: MODEL, store, live: l, maxNeurons, concurrency: 2, log: () => {},
  });

  it("records every missing text once, verifies a clean replay, and is a no-op the second time", async () => {
    const { root, file } = scratch();
    const l = live();
    const first = await prepare(args(new ReplayStore([], file, { root }), l));
    expect(first.missing).toBeGreaterThan(0);
    expect(l.run.mock.calls.length).toBe(first.missing);
    const calls = l.run.mock.calls.length;
    const second = await prepare(args(new ReplayStore([file], file, { root }), l));
    expect(second.missing).toBe(0);
    expect(l.run.mock.calls.length).toBe(calls);
  });

  describe("with tags", () => {
    const tagged: CorpusSpec = {
      ...spec, id: "tiny-tagged", entries: spec.entries.map(e => ({ ...e, tags: ["gardening", "planning"] })),
      queries: [{ id: "q", category: "paraphrase", text: "tomato advice", gold: [{ id: "c", grade: 2 }], viewer: "avery" }],
    };

    it("records no tag embeddings, because recall no longer asks a model to pick query tags", async () => {
      const { root, file } = scratch();
      const l = live();
      await prepare({ ...args(new ReplayStore([], file, { root }), l), spec: tagged });
      const embedded = l.run.mock.calls.map(c => (c[1] as { text: string[] }).text[0]);
      expect(embedded).not.toContain("gardening");
      expect(embedded).not.toContain("planning");
    });
  });

  it("aborts before any live call when the estimate exceeds the neuron cap", async () => {
    const l = live();
    const { root, file } = scratch();
    const store = new ReplayStore([], file, { root });
    await expect(prepare(args(store, l, 0.000001))).rejects.toThrow(/max-neurons/);
    expect(l.run).not.toHaveBeenCalled();
  });

  it("exports exactly the keys a replay run used, with the producer, as a layer another process can read", async () => {
    const { root, file } = scratch();
    const store = new ReplayStore([], file, { root });
    const { missing } = await prepare(args(store, live()));
    const out = join(root, ".eval-cache", "core.jsonl.gz");
    const n = await exportCache({ spec, variant: getVariant("no-rerank"), backend: "sqlite", model: MODEL, readPaths: [file], outPath: out, root });
    expect(n).toBe(missing);
    const layer = new ReplayStore([out], undefined, { root });
    expect(layer.producerOf(MODEL)).toEqual(PRODUCER);
    const corpus = await (await import("./corpus/loader")).loadCorpus({ spec, backend: "sqlite", replay: makeReplayAi({ store: layer, mode: "replay" }), embeddingModel: MODEL });
    await corpus.close(); // loads with no live provider and no local cache: the gz layer alone is complete
  });

  it("refuses to extend a cache that has rows but no producer record, before any live call", async () => {
    const { root, file } = scratch();
    const plain = makeReplayAi({ store: new ReplayStore([], file, { root }), mode: "record", live: { run: live().run } }); // no producer(): unlabeled rows
    await plain.ai.run(MODEL as never, { text: ["old"] } as never);
    const l = live();
    await expect(prepare(args(new ReplayStore([file], file, { root }), l))).rejects.toThrow(/no producer record/);
    expect(l.run).not.toHaveBeenCalled();
  });

  describe("a reranker slower than the production budget", () => {
    /** A live model whose reranker takes `ms` (local CPU inference on a busy machine); embeddings are instant. */
    const slowLive = (ms: number): LiveAi & { run: ReturnType<typeof vi.fn> } => ({
      producer: () => PRODUCER,
      run: vi.fn(async (model: string, input: unknown) => {
        if (model === RERANK_MODEL) {
          await new Promise(r => setTimeout(r, ms));
          const n = (input as { contexts: unknown[] }).contexts.length;
          return { response: Array.from({ length: n }, (_, id) => ({ id, score: n - id })), usage: { prompt_tokens: 12, total_tokens: 12 } };
        }
        return { data: (input as { text: string[] }).text.map(t => hashVector(t, 768)), usage: { prompt_tokens: 4, total_tokens: 4 } };
      }),
    });

    // A variant that reranks in "on" mode but, like baseline, goes through the readiness latch and the circuit breaker
    // (the forced `rerank` variant skips both, which is why prepare only failed for baseline).
    const AUTO_LIKE = "tmp-auto-like";
    const queries5 = ["xylo alpha", "beta gardening", "gamma tomato", "alpha beta", "plan note"].map((text, i) => ({ id: `q${i}`, category: "rare-word" as const, text, gold: [{ id: "a", grade: 2 as const }], viewer: "avery" as const }));

    it(`is still recorded by prepare although it takes longer than RERANK_TIMEOUT_MS (${RERANK_TIMEOUT_MS} ms)`, async () => {
      registerVariant({ name: AUTO_LIKE, description: "test", config: { RERANK_MODE: "on" } });
      try {
        const { root, file } = scratch();
        const l = slowLive(RERANK_TIMEOUT_MS + 300);
        const many = { ...spec, queries: queries5 };
        const res = await prepare({ ...args(new ReplayStore([], file, { root }), l), spec: many, variant: getVariant(AUTO_LIKE) });
        expect(res.missing).toBeGreaterThan(0);
        expect(l.run.mock.calls.filter(c => c[0] === RERANK_MODEL).length).toBeGreaterThanOrEqual(queries5.length);
        // the verification pass replays with the PRODUCTION timeout and found the cache complete: prepare would have thrown otherwise
        const again = await prepare({ ...args(new ReplayStore([file], file, { root }), l), spec: many, variant: getVariant(AUTO_LIKE) });
        expect(again.missing).toBe(0);
      } finally { unregisterVariant(AUTO_LIKE); }
    }, 120_000);

    it("does not record under the production timeout alone (the failure the override exists for)", async () => {
      const { root, file } = scratch();
      const l = slowLive(RERANK_TIMEOUT_MS + 1500);
      // the same record pass without the override: the recall times out and falls back, so the reranker's row is never asked for
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { loadCorpus } = await import("./corpus/loader");
      const { runVariant } = await import("./runner");
      const { NeuronBudget } = await import("./ai-replay");
      const replay = makeReplayAi({ store: new ReplayStore([], file, { root }), mode: "record", live: l, budget: new NeuronBudget(1000) });
      const corpus = await loadCorpus({ spec, backend: "sqlite", replay, embeddingModel: MODEL });
      try {
        // cold: no warm-up query, whose timed-out call would still finish in the background and record the row for the scored one
        const report = await runVariant({ corpus, variant: getVariant("rerank"), queries: spec.queries, isolate: "cold", embeddingModel: MODEL });
        expect(report.results[0].error).toMatch(/reranker step ended in "timeout"/);
      } finally { await corpus.close(); spy.mockRestore(); }
    }, 60_000);

    it("the override is a record-pass variant only: it raises the timeout, keeps every other flag, and does not touch the registry", () => {
      const base = getVariant("rerank");
      const rec = withRecordTimeout(base);
      expect(rec.internal?.variant?.rerank).toBe(true);
      expect(rec.internal?.variant?.rerankTuning?.timeoutMs).toBe(RECORD_RERANK_TIMEOUT_MS);
      expect(RECORD_RERANK_TIMEOUT_MS).toBeGreaterThan(RERANK_TIMEOUT_MS);
      expect(getVariant("rerank").internal?.variant?.rerankTuning).toBeUndefined();
      expect(withRecordTimeout(getVariant("baseline")).internal?.variant?.rerank).toBeUndefined(); // a non-forced variant stays non-forced
    });
  });
});
