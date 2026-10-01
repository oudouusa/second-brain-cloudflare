// LongMemEval's driver (T-0089.1.4 phase A), on a synthetic fixture: no download, no network, no
// real model inference (local-ai is stubbed with a deterministic fake embedder, the same pattern
// public-cli.test.ts uses for scifact/miracl-ja).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanTemp } from "../helpers/tmp";
import type { RawQuestion, RawSession } from "./longmemeval";

afterAll(cleanTemp);

// A deterministic embedder: each text's vector depends only on which of a few "topics" its content
// names, so two texts about the same topic score close and texts about different topics do not --
// enough signal to prove real ranking behavior (a wrong gold id must lose to the right one), without
// downloading or running the real bge-small model.
const TOPICS = ["kayak", "sourdough", "violin", "taxes"];
function fakeVector(text: string): number[] {
  const hit = TOPICS.findIndex(t => text.includes(t));
  return Array.from({ length: 768 }, (_, i) => (hit >= 0 && i % TOPICS.length === hit ? 1 : 0.01));
}
vi.mock("./local-ai", async orig => ({
  ...(await orig<typeof import("./local-ai")>()),
  makeLocalAi: () => ({
    run: async (_model: string, input: unknown) => {
      const { text } = input as { text: string[] };
      return { shape: [text.length, 768], data: text.map(fakeVector), usage: { prompt_tokens: 4, total_tokens: 4 } };
    },
    producer: () => ({ kind: "local-transformers-js" as const, library: "@huggingface/transformers", libraryVersion: "0", onnxRuntime: "onnxruntime-node@0", repo: "stub/stub", revision: "0", dtype: "fp32" as const }),
  }),
}));

const REAL_REPO = resolve(import.meta.dirname, "../..");
let root: string;
let mod: typeof import("./longmemeval");
let prepareMod: typeof import("./prepare");
let aiReplay: typeof import("./ai-replay");
let corporaMod: typeof import("./corpora");
let variantsMod: typeof import("./variants");

const EVAL_NOW = Date.UTC(2026, 8, 1);
const DAY_MS = 86_400_000;

/** A tiny, synthetic LongMemEval-shaped fixture: 3 questions, one shared session (reused across two
 * haystacks, proving isolation and the dedup fix), each haystack containing exactly one on-topic
 * session and a few off-topic distractors. */
function fixture() {
  const dir = join(root, ".eval-cache", "public", "longmemeval");
  mkdirSync(dir, { recursive: true });
  const session = (id: string, topic: string, daysAgo: number) => ({ id, text: `A note about ${topic} and how to get better at it.`, createdAt: EVAL_NOW - daysAgo * DAY_MS });
  const sessions = [
    // All the same age: recency must not be what separates the right session from a wrong one here.
    session("s-kayak", "kayak", 7),
    session("s-sourdough", "sourdough", 7),
    session("s-violin", "violin", 7),
    session("s-taxes-shared", "taxes", 7), // reused across two questions' haystacks
    session("s-noise-1", "sourdough", 7),
    session("s-noise-2", "violin", 7),
  ];
  const questions = [
    { id: "q-kayak", category: "single-session-user", text: "What did I say about my kayak?", date: EVAL_NOW - 1000, gold: ["s-kayak"], haystack: ["s-kayak", "s-noise-1", "s-noise-2"] },
    // Same session id listed twice in its own haystack (LongMemEval's own data shape, not a
    // normalizer artifact -- see longmemeval.ts's questionCorpus comment).
    { id: "q-taxes", category: "knowledge-update", text: "What did I decide about my taxes?", date: EVAL_NOW - 900, gold: ["s-taxes-shared"], haystack: ["s-taxes-shared", "s-taxes-shared", "s-noise-1"] },
    { id: "q-violin", category: "temporal-reasoning", text: "What did I say about my violin?", date: EVAL_NOW - 800, gold: ["s-violin"], haystack: ["s-violin", "s-taxes-shared", "s-noise-1"] },
  ];
  writeFileSync(join(dir, "corpus.jsonl"), sessions.map(s => JSON.stringify(s)).join("\n") + "\n");
  writeFileSync(join(dir, "questions.jsonl"), questions.map(q => JSON.stringify(q)).join("\n") + "\n");
  const derived = Object.fromEntries(["corpus.jsonl", "questions.jsonl"].map(f => [f, createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")]));
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ derived }));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "longmemeval-"));
  mkdirSync(join(root, "db"), { recursive: true });
  copyFileSync(join(REAL_REPO, "db/schema.sql"), join(root, "db/schema.sql"));
  copyFileSync(join(REAL_REPO, "db/fork-write-protection.sql"), join(root, "db/fork-write-protection.sql"));
  fixture();
  vi.stubEnv("SB_EVAL_ROOT", root);
  vi.resetModules();
  mod = await import("./longmemeval");
  prepareMod = await import("./prepare");
  aiReplay = await import("./ai-replay");
  corporaMod = await import("./corpora");
  variantsMod = await import("./variants");
  // 合成試験専用の仮単価。実測CLIの価格表には追加しない。
  aiReplay.NEURON_RATES[mod.EMBEDDING_MODEL] = { inputPerMillionTokens: 1841 };
});
afterAll(() => { delete aiReplay.NEURON_RATES[mod.EMBEDDING_MODEL]; vi.unstubAllEnvs(); vi.resetModules(); });

describe("loadLongMemEvalData", () => {
  it("parses the neutral layout, keeping every question with at least one gold session", () => {
    const { sessions, questions } = mod.loadLongMemEvalData(root);
    expect(sessions.size).toBe(6);
    expect(questions).toHaveLength(3);
    expect(questions.map(q => q.id).sort()).toEqual(["q-kayak", "q-taxes", "q-violin"]);
  });
});

describe("buildRecordingCorpus", () => {
  it("puts every distinct session (deduplicated across all haystacks) and every question into one spec", () => {
    const spec = mod.buildRecordingCorpus(root);
    expect(spec.entries).toHaveLength(6); // s-taxes-shared is not doubled just because two questions use it
    expect(new Set(spec.entries.map(e => e.id)).size).toBe(6);
    expect(spec.queries.map(q => q.id).sort()).toEqual(["q-kayak", "q-taxes", "q-violin"]);
  });
});

describe("questionQuery", () => {
  it("maps LongMemEval's own category to an existing QUERY_CATEGORIES bucket, and keeps the real type as a subset tag", () => {
    const { questions } = mod.loadLongMemEvalData(root);
    const q = mod.questionQuery(questions.find(x => x.id === "q-taxes")!);
    expect(q.category).toBe("knowledge-update"); // exact match in CATEGORY_MAP
    expect(q.tags).toContain("subset:knowledge-update");
    expect(q.tags).toContain("longmemeval");
    expect(q.gold).toEqual([{ id: "s-taxes-shared", grade: 2 }]);
  });
  it("throws on a question_type this harness has never seen, rather than silently dropping it", () => {
    expect(() => mod.questionQuery({ id: "x", category: "unknown-type", text: "t", date: 0, gold: ["a"], haystack: ["a"] })).toThrow(/unmapped/);
  });
});

// Records against each question's own ISOLATED corpus, exactly the shape scoreQuestions replays
// against later -- recording against the combined buildRecordingCorpus() instead would still warm
// the session/query embedding cache, but a tiny per-question corpus can route a query differently
// (the keyword/LIKE arm's behavior depends on corpus size), so recording and replay must see the
// same corpus shape for every cached call to be a real hit, not a coincidental one.
async function recordQuestion(q: RawQuestion, sessions: Map<string, RawSession>) {
  const paths = corporaMod.replayPaths(mod.EMBEDDING_MODEL, "longmemeval");
  await prepareMod.prepare({
    spec: mod.questionCorpus(q, sessions), variant: variantsMod.getVariant("no-rerank"), backend: "sqlite", model: mod.EMBEDDING_MODEL,
    store: new aiReplay.ReplayStore(paths.read, paths.write), live: (await import("./local-ai")).makeLocalAi(),
    maxNeurons: 100_000, concurrency: 1, log: () => {},
  });
}

describe("scoreQuestions: isolation and the gate's own sensitivity", () => {
  it("scores each question against its own haystack only -- a session absent from a question's haystack never appears in its ranking", async () => {
    const { sessions, questions } = mod.loadLongMemEvalData(root);
    for (const q of questions) await recordQuestion(q, sessions);
    const paths = corporaMod.replayPaths(mod.EMBEDDING_MODEL, "longmemeval");
    const replay = aiReplay.makeReplayAi({ store: new aiReplay.ReplayStore(paths.read), mode: "replay" });
    const results = await mod.scoreQuestions({ questions, sessions, replay, embeddingModel: mod.EMBEDDING_MODEL, backend: "sqlite", variant: "no-rerank" });
    expect(results).toHaveLength(3);
    for (const r of results) {
      // s-violin and s-kayak belong to no OTHER question's haystack; if isolation leaked, a wrong
      // question's ranking could still contain them without it being a visible bug -- so the
      // structural check is that every ranked id came from THAT question's own haystack.
      const q = questions.find(x => x.id === r.queryId)!;
      for (const id of r.rankedIds) expect(q.haystack).toContain(id);
    }
  });

  it("a duplicate session id within one question's own haystack does not fail the load (58bf7951-style data)", async () => {
    const { sessions, questions } = mod.loadLongMemEvalData(root);
    const taxes = questions.find(q => q.id === "q-taxes")!;
    expect(taxes.haystack.filter(id => id === "s-taxes-shared")).toHaveLength(2); // the fixture's own duplicate
    const replay = aiReplay.makeReplayAi({ store: new aiReplay.ReplayStore(corporaMod.replayPaths(mod.EMBEDDING_MODEL, "longmemeval").read), mode: "replay" });
    const [result] = await mod.scoreQuestions({ questions: [taxes], sessions, replay, embeddingModel: mod.EMBEDDING_MODEL, backend: "sqlite", variant: "no-rerank" });
    expect(result.error).toBeUndefined();
    expect(result.metrics.recall10).toBe(1);
  });

  it("the gate works both ways: the real gold session ranks first (mrr10 = 1), a wrong one does not -- on the same recorded cache, nothing re-embedded", async () => {
    const { sessions, questions } = mod.loadLongMemEvalData(root);
    const kayak = questions.find(q => q.id === "q-kayak")!;
    const replay = aiReplay.makeReplayAi({ store: new aiReplay.ReplayStore(corporaMod.replayPaths(mod.EMBEDDING_MODEL, "longmemeval").read), mode: "replay" });

    // The haystack has only 3 candidates, so recall@10 is trivially 1 for anything in it -- mrr10 is
    // the metric that actually depends on WHERE the gold id ranks, which is what "wrong gold" should break.
    const right = await mod.scoreQuestions({ questions: [kayak], sessions, replay, embeddingModel: mod.EMBEDDING_MODEL, backend: "sqlite", variant: "no-rerank" });
    expect(right[0].rankedIds[0]).toBe("s-kayak"); // the on-topic session wins this fixture's embeddings
    expect(right[0].metrics.mrr10).toBe(1);

    const wrong = { ...kayak, gold: ["s-noise-1"] }; // s-noise-1 is a sourdough note, not the kayak one
    const wrongResult = await mod.scoreQuestions({ questions: [wrong], sessions, replay, embeddingModel: mod.EMBEDDING_MODEL, backend: "sqlite", variant: "no-rerank" });
    expect(wrongResult[0].metrics.mrr10).toBeLessThan(1);
  });
});
