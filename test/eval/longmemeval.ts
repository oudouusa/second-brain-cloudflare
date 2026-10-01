/**
 * T-0089.1.4 phase A: LongMemEval-style external benchmark, offline (01-foundations.md ~line 177,
 * 00-holistic-plan.md ~line 120). Retrieval only (Recall@k, NDCG@k against evidence sessions, per
 * category) -- phase B (QA accuracy with a local judge) is a 4.x follow-up, not built here.
 *
 * Dataset (fetched by scripts/eval-fetch-public.mjs longmemeval, normalized by its own
 * normalizeLongMemEval into .eval-cache/public/longmemeval/): xiaowu0162/longmemeval-cleaned on
 * Hugging Face, "s" split only (longmemeval_s_cleaned.json). MIT license (the dataset card and the
 * upstream github.com/xiaowu0162/LongMemEval LICENSE file both confirm MIT). Attribution: Wu et al.,
 * "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory", ICLR 2025. Local
 * evaluation use only; nothing from the dataset is committed (test/eval/data/ never receives its
 * files, and .eval-cache/ is git-ignored) -- only this code, its config and summary reports are.
 *
 * Isolation (extension point 5): every LongMemEval question has its own haystack of ~40-50 sessions,
 * and sessions are reused across questions' haystacks (19,195 distinct sessions serve 500 questions'
 * 23,867 haystack slots). Rather than build new per-question workspace/identity plumbing, isolation
 * here is structural: scoreQuestions runs one tiny, freshly-built CorpusSpec per question (its own
 * haystack only, via loadCorpus+runVariant), so no other question's sessions ever exist in that D1
 * instance to leak into its ranking. buildRecordingCorpus is the one exception -- a single combined
 * corpus used ONLY to record every session's and query's embedding once, in one efficient pass; its
 * own rankings mix every haystack together and are never scored (see its own comment).
 *
 * Categories: LongMemEval's six question_type values do not map onto this harness's closed
 * QUERY_CATEGORIES 1:1 (extension point 3). CATEGORY_MAP below picks the closest existing bucket for
 * gate-shaped reporting; the real LongMemEval type is preserved verbatim as a `subset:` tag so a
 * report can still break down by the original taxonomy. Abstention questions (empty gold,
 * question_id ending "_abs") are excluded, matching LongMemEval's own published protocol ("30
 * instances excluded from retrieval evaluation").
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadCorpus } from "./corpus/loader";
import { ACTORS, WORKSPACES, type CorpusEntry, type CorpusSpec } from "./corpus/types";
import { runVariant } from "./runner";
import { getVariant } from "./variants";
import type { GoldenQuery, QueryCategory, QueryResult } from "./types";
import type { makeReplayAi } from "./ai-replay";

export const CORPUS_ID = "longmemeval";
export const EMBEDDING_MODEL = "@cf/google/embeddinggemma-300m";

export function dataDir(root: string = process.env.SB_EVAL_ROOT ?? resolve(import.meta.dirname, "../..")): string {
  return resolve(root, ".eval-cache/public/longmemeval");
}

export interface RawSession { id: string; text: string; createdAt: number }
export interface RawQuestion { id: string; category: string; text: string; date: number; gold: string[]; haystack: string[] }

/** The closest existing QUERY_CATEGORIES bucket per LongMemEval question_type -- reused, not
 * widened, per extension point 3's own suggestion. The real type survives as a `subset:` tag. */
export const CATEGORY_MAP: Record<string, QueryCategory> = {
  "single-session-user": "paraphrase",
  "single-session-assistant": "paraphrase",
  "single-session-preference": "paraphrase",
  "multi-session": "multi-hop",
  "temporal-reasoning": "temporal",
  "knowledge-update": "knowledge-update",
};

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l) as T);
}

/** Loads the normalized dataset. Abstention questions (empty gold) are dropped here, once, so every
 * caller below sees only the 470 retrieval-eligible questions. */
export function loadLongMemEvalData(root?: string): { sessions: Map<string, RawSession>; questions: RawQuestion[] } {
  const dir = dataDir(root);
  const manifestPath = resolve(dir, "MANIFEST.json");
  if (!existsSync(manifestPath)) throw new Error(`${manifestPath} not found; run: node scripts/eval-fetch-public.mjs longmemeval`);
  const sessions = new Map(readJsonl<RawSession>(resolve(dir, "corpus.jsonl")).map(s => [s.id, s] as const));
  const questions = readJsonl<RawQuestion>(resolve(dir, "questions.jsonl")).filter(q => q.gold.length > 0);
  return { sessions, questions };
}

function entryFor(s: RawSession): CorpusEntry {
  return { id: s.id, content: s.text, tags: [], source: "api", createdAt: s.createdAt, workspaceId: WORKSPACES.avery, actorId: ACTORS.avery };
}

export function questionQuery(q: RawQuestion): GoldenQuery {
  const category = CATEGORY_MAP[q.category];
  if (!category) throw new Error(`unmapped LongMemEval question_type: ${q.category}`);
  return {
    id: q.id, category, text: q.text, gold: q.gold.map(id => ({ id, grade: 2 as const })),
    viewer: "avery", tags: ["public", "longmemeval", `subset:${q.category}`], clusterKey: q.id, asOf: q.date,
  };
}

/**
 * One combined CorpusSpec over every distinct session and every question, for `prepare()` alone:
 * one efficient dry/record/replay pass records each session's and query's embedding exactly once
 * (deduplicated by text, the same way the replay store already dedupes any corpus). Its own
 * rankings put all 19,195 sessions in scope for every query at once, which is not what LongMemEval
 * measures -- never score this corpus's own report; scoreQuestions' per-question runs are the real
 * measurement, and they hit nothing but this same cache once it is warm.
 */
export function buildRecordingCorpus(root?: string): CorpusSpec {
  const { sessions, questions } = loadLongMemEvalData(root);
  return {
    id: CORPUS_ID, intent: "discriminate",
    entries: [...sessions.values()].map(entryFor), edges: [],
    queries: questions.map(questionQuery),
  };
}

export function questionCorpus(q: RawQuestion, sessions: Map<string, RawSession>): CorpusSpec {
  // A session id can recur within one question's own haystack (LongMemEval's own data, not a
  // normalizer artifact -- e.g. question 58bf7951 lists 57 haystack ids for 56 distinct sessions).
  // entries.id is unique per memory, so a duplicate must collapse to one entry, not fail the insert.
  return {
    id: CORPUS_ID, intent: "discriminate",
    entries: [...new Set(q.haystack)].map((id) => {
      const s = sessions.get(id);
      if (!s) throw new Error(`question ${q.id} haystack references missing session ${id}`);
      return entryFor(s);
    }),
    edges: [], queries: [questionQuery(q)],
  };
}

/**
 * The real measurement: one small, isolated CorpusSpec per question (its own haystack only), scored
 * with the shipped "baseline" variant. Cheap once buildRecordingCorpus's pass has warmed the cache --
 * every call here should be pure replay, no live model calls.
 */
export async function scoreQuestions(o: {
  questions: RawQuestion[];
  sessions: Map<string, RawSession>;
  replay: ReturnType<typeof makeReplayAi>;
  embeddingModel: string;
  backend: "sqlite" | "workerd";
  /** Defaults to "baseline" (the shipped reranker in its auto mode) -- the closest real-world
   * measurement. Tests that stub the local embedder can pass "no-rerank" to avoid needing a
   * reranker mock too, since phase A's own metrics are retrieval-only (Recall@k, NDCG@k). */
  variant?: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<QueryResult[]> {
  const variant = getVariant(o.variant ?? "baseline");
  const results: QueryResult[] = [];
  let done = 0;
  for (const q of o.questions) {
    const query = questionQuery(q);
    const corpus = await loadCorpus({ spec: questionCorpus(q, o.sessions), backend: o.backend, replay: o.replay, embeddingModel: o.embeddingModel });
    try {
      const report = await runVariant({ corpus, variant, queries: [query], isolate: "warm", embeddingModel: o.embeddingModel });
      results.push(...report.results);
    } finally {
      await corpus.close();
    }
    o.onProgress?.(++done, o.questions.length);
  }
  return results;
}
