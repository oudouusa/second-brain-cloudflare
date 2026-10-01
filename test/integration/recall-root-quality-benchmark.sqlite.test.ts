/**
 * Task 7 (#374 FTS5 lexical arm): real-SQLite port of
 * recall-root-quality-benchmark.test.ts.
 *
 * The mock-based original runs on test/helpers/d1-mock.ts, whose
 * installControlledQueries returns CANNED keyword rows for the normal "WHERE content
 * LIKE ... ORDER BY ... created_at DESC LIMIT" query shape, regardless of what the
 * corpus actually contains. That measures the fusion/graph pipeline around the
 * keyword arm, but not the keyword arm itself — LIKE and FTS are equally
 * invisible to it. This file seeds the same fixture cases into real SQLite
 * (test/helpers/sqlite-d1.ts, node:sqlite with FTS5 trigram) via genuine
 * INSERTs, so the sync triggers index them and keywordSearch's real SQL runs.
 *
 * Same cases, queries, expected answers, and scoring (imported from
 * test/helpers/recall-benchmark-scoring.ts, extracted from the original so
 * both suites compare against one frozen baseline). Only the corpus's storage
 * and the keyword arm's execution path change: mocked Vectorize/embeddings
 * stay exactly as the original does them.
 *
 * Three modes distinguish Task 3 (candidate selection) from Task 6 (fusion
 * order):
 *   - like:          fts:ready unset — keywordSearchLike serves the rows.
 *   - fts-orderless: fts:ready "1", Task 6's bm25 fusion order forced off via
 *                    internal.keywordPreRankedOverride — isolates Task 3.
 *   - fts:           fts:ready "1", Task 6 as shipped.
 *
 * Gates: fts-orderless must not score below like, and fts must not score
 * below fts-orderless, on authoritativeAnswers and directTopFourRegressions.
 * The LIKE-mode numbers are NOT gated against the mock's canned 14/4/0 —
 * real LIKE sees the real corpus, the mock never did, so a difference is a
 * finding to report, not a regression (see the last test in this file).
 */
import { describe, expect, it, vi } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ftsEligibleToken, resetFtsReadyMemo } from "../../src/recall/fts";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { recallEntries } from "../../src/recall/search";
import { tokenizeQuery } from "../../src/text/tokenize";
import type { RecallDiagnostics, RecallInternalOptions } from "../../src/recall/types";
import type { Env } from "../../src/env";
import {
  ROOT_QUALITY_CASES,
  type CandidateFixture,
  type RootQualityCase,
  type RootQualitySplit,
} from "../fixtures/recall-root-quality";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import {
  baselineRecall,
  directTopFourRegressed,
  rawCandidates,
} from "../helpers/recall-benchmark-scoring";

const TOP_K = 5;
const MODES = ["like", "fts-orderless", "fts"] as const;
type Mode = typeof MODES[number];

interface CaseObservation {
  id: string;
  split: RootQualitySplit;
  candidateAvailable: boolean;
  fused: boolean;
  seed: boolean;
  expanded: boolean;
  selectedRelatedIds: string[];
  authoritative: boolean;
  baselineAuthoritative: boolean;
  directTopFourRegression: boolean;
  extraAiCalls: number;
  extraVectorizeQueries: number;
  ftsUsed?: boolean;
  hasShortToken: boolean;
}

interface BenchmarkMetrics {
  cases: number;
  candidateAvailability: number;
  fusionSurvival: number;
  seedHits: number;
  neighborhoodReach: number;
  authoritativeAnswers: number;
  baselineAuthoritativeAnswers: number;
  improvement: number;
  usefulGraphPrecision: number;
  directTopFourRegressions: number;
  extraAiCalls: number;
  extraVectorizeQueries: number;
}

const caseId = (c: RootQualityCase) => `${c.domain}/${c.failureShape}`;

/**
 * Mirrors the widest token source buildRetrievalTokens ever appends from (the
 * un-distilled query tokenized the same way as its "evidence" set), so "no
 * sub-3-codepoint token" is checked against every token that could reach
 * keywordSearch, not just the distilled subset.
 */
function hasSubThreeToken(query: string): boolean {
  return tokenizeQuery(query).some(t => !ftsEligibleToken(t));
}

async function buildFixture(c: RootQualityCase, mode: Mode) {
  resetDatabaseInit();
  resetFtsReadyMemo();
  const sqlite = makeSqliteD1();
  const query = vi.fn().mockResolvedValue({
    matches: c.candidates
      .filter((candidate): candidate is CandidateFixture & { denseScore: number } => candidate.denseScore !== undefined)
      .sort((a, b) => b.denseScore - a.denseScore)
      .map(candidate => ({
        id: candidate.id,
        score: candidate.denseScore,
        metadata: {
          parentId: candidate.id,
          content: candidate.vectorContent,
          created_at: candidate.createdAt ?? 1,
        },
      })),
  });
  const env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query }),
  });
  await initializeDatabase(env);

  // Real INSERTs for the whole fixture corpus (dense-only, keyword-only, and
  // both), so the FTS triggers index it and LIKE/FTS both see the real thing —
  // not just the candidates the original mock labeled keywordCandidate.
  for (const candidate of c.candidates) {
    sqlite.seed({
      id: candidate.id,
      content: candidate.content,
      createdAt: candidate.createdAt ?? 1,
      tags: [...(candidate.tags ?? [])],
      source: "benchmark",
    });
    if (candidate.recallCount) {
      await sqlite.db.prepare(`UPDATE entries SET recall_count = ? WHERE id = ?`)
        .bind(candidate.recallCount, candidate.id).run();
    }
  }
  for (const [index, edge] of c.edges.entries()) {
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', 1, 1)`,
    ).bind(`${caseId(c)}-edge-${index}`, edge.sourceId, edge.targetId, edge.type, edge.weight, edge.provenance).run();
  }

  if (mode !== "like") {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
  }

  // Tracked (not discarded): recallEntries fires a background recall_count
  // UPDATE via ctx.waitUntil. runCase awaits these before closing the sqlite
  // handle, or that write races the close and logs a spurious "database is
  // not open".
  const pendingWaits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pendingWaits.push(p); } } as unknown as ExecutionContext;
  const internal: RecallInternalOptions = mode === "fts-orderless" ? { keywordPreRankedOverride: false } : {};
  return { env, ctx, query, sqlite, internal, pendingWaits };
}

async function runCase(c: RootQualityCase, mode: Mode): Promise<CaseObservation> {
  const graph = await buildFixture(c, mode);
  try {
    const diagnostics: RecallDiagnostics = {};
    const withGraph = await recallEntries(
      { query: c.query, topK: TOP_K, hops: 1, synthesize: false },
      graph.env,
      graph.ctx,
      undefined,
      { diagnostics, ...graph.internal },
    );
    const acceptableRoots = new Set(c.acceptableRootIds);
    const authoritative = new Set(c.authoritativeIds);
    const candidateAvailable = rawCandidates(c).some(candidate => acceptableRoots.has(candidate.id) || authoritative.has(candidate.id));
    const fused = (diagnostics.fusedIds ?? []).some(id => acceptableRoots.has(id));
    const seed = (diagnostics.rootSelections ?? []).some(selection => acceptableRoots.has(selection.id));
    const expanded = (diagnostics.expandedIds ?? []).some(id => authoritative.has(id));
    const outputIds = withGraph.matches.map(match => match.id);
    const baseline = baselineRecall(c, withGraph.queryTokens ?? [], TOP_K);
    const graphAiCalls = (graph.env.AI.run as ReturnType<typeof vi.fn>).mock.calls.length;
    await Promise.all(graph.pendingWaits);

    return {
      id: caseId(c),
      split: c.split,
      candidateAvailable,
      fused,
      seed,
      expanded,
      selectedRelatedIds: diagnostics.selectedRelatedIds ?? [],
      authoritative: outputIds.some(id => authoritative.has(id)),
      baselineAuthoritative: baseline.outputIds.some(id => authoritative.has(id)),
      directTopFourRegression: directTopFourRegressed(outputIds, baseline.directIds),
      extraAiCalls: Math.max(0, graphAiCalls - 1),
      extraVectorizeQueries: Math.max(0, graph.query.mock.calls.length - 1),
      ftsUsed: diagnostics.ftsUsed,
      hasShortToken: hasSubThreeToken(c.query),
    };
  } finally {
    graph.sqlite.close();
  }
}

function summarize(observations: CaseObservation[]): BenchmarkMetrics {
  const selectedRelatedIds = observations.flatMap(observation => observation.selectedRelatedIds.map(id => ({ observation, id })));
  const usefulRelated = selectedRelatedIds.filter(({ observation, id }) => {
    const c = ROOT_QUALITY_CASES.find(candidate => caseId(candidate) === observation.id)!;
    return c.authoritativeIds.includes(id);
  }).length;
  const authoritativeAnswers = observations.filter(observation => observation.authoritative).length;
  const baselineAuthoritativeAnswers = observations.filter(observation => observation.baselineAuthoritative).length;
  return {
    cases: observations.length,
    candidateAvailability: observations.filter(observation => observation.candidateAvailable).length,
    fusionSurvival: observations.filter(observation => observation.fused).length,
    seedHits: observations.filter(observation => observation.candidateAvailable && observation.seed).length,
    neighborhoodReach: observations.filter(observation => observation.expanded).length,
    authoritativeAnswers,
    baselineAuthoritativeAnswers,
    improvement: authoritativeAnswers - baselineAuthoritativeAnswers,
    usefulGraphPrecision: selectedRelatedIds.length ? usefulRelated / selectedRelatedIds.length : 1,
    directTopFourRegressions: observations.filter(observation => observation.directTopFourRegression).length,
    extraAiCalls: observations.reduce((sum, observation) => sum + observation.extraAiCalls, 0),
    extraVectorizeQueries: observations.reduce((sum, observation) => sum + observation.extraVectorizeQueries, 0),
  };
}

async function evaluate(cases: readonly RootQualityCase[], mode: Mode) {
  const observations: CaseObservation[] = [];
  for (const c of cases) observations.push(await runCase(c, mode));
  for (const observation of observations) {
    if (!observation.hasShortToken) {
      expect(observation.ftsUsed, `${observation.id} (${mode})`).toBe(mode !== "like");
    }
  }
  return { observations, metrics: summarize(observations) };
}

function reportMetrics(label: string, mode: Mode, metrics: BenchmarkMetrics): void {
  if (process.env.RECALL_BENCHMARK_REPORT === "1") {
    console.info(`RECALL_ROOT_QUALITY_SQLITE ${label} ${mode} ${JSON.stringify(metrics)}`);
  }
}

async function evaluateAllModes(cases: readonly RootQualityCase[], label: string) {
  const byMode = {} as Record<Mode, BenchmarkMetrics>;
  const byModeObs = {} as Record<Mode, CaseObservation[]>;
  for (const mode of MODES) {
    const { observations, metrics } = await evaluate(cases, mode);
    byMode[mode] = metrics;
    byModeObs[mode] = observations;
    reportMetrics(label, mode, metrics);
  }
  if (process.env.RECALL_BENCHMARK_REPORT === "1") {
    console.info(`RECALL_ROOT_QUALITY_SQLITE_COMPARISON ${label} ${JSON.stringify(byMode)}`);
  }
  return { byMode, byModeObs };
}

function assertCrossModeGates(byMode: Record<Mode, BenchmarkMetrics>, byModeObs: Record<Mode, CaseObservation[]>) {
  const flips = (a: Mode, b: Mode) => byModeObs[a]
    .map((obs, i) => ({ id: obs.id, [a]: obs.authoritative, [b]: byModeObs[b][i].authoritative }))
    .filter(row => (row as Record<string, unknown>)[a] !== (row as Record<string, unknown>)[b]);
  const details = JSON.stringify({
    byMode,
    likeToOrderlessFlips: flips("like", "fts-orderless"),
    orderlessToFtsFlips: flips("fts-orderless", "fts"),
  }, null, 2);

  expect(byMode["fts-orderless"].authoritativeAnswers, details).toBeGreaterThanOrEqual(byMode.like.authoritativeAnswers);
  expect(byMode["fts-orderless"].directTopFourRegressions, details).toBeLessThanOrEqual(byMode.like.directTopFourRegressions);
  expect(byMode.fts.authoritativeAnswers, details).toBeGreaterThanOrEqual(byMode["fts-orderless"].authoritativeAnswers);
  expect(byMode.fts.directTopFourRegressions, details).toBeLessThanOrEqual(byMode["fts-orderless"].directTopFourRegressions);
}

describe("real-SQLite recall root-quality benchmark", () => {
  it("development split: fts-orderless and fts never score below the mode they build on", async () => {
    const { byMode, byModeObs } = await evaluateAllModes(ROOT_QUALITY_CASES.filter(c => c.split === "development"), "development");
    assertCrossModeGates(byMode, byModeObs);
  });

  it("holdout split: fts-orderless and fts never score below the mode they build on", async () => {
    const { byMode, byModeObs } = await evaluateAllModes(ROOT_QUALITY_CASES.filter(c => c.split === "holdout"), "holdout");
    assertCrossModeGates(byMode, byModeObs);
  });

  it("20-case overall: fts-orderless and fts never score below the mode they build on", async () => {
    const { byMode, byModeObs } = await evaluateAllModes(ROOT_QUALITY_CASES, "overall");
    assertCrossModeGates(byMode, byModeObs);
    expect(byMode.like.cases).toBe(20);
  });

  it("real LIKE vs the mock's canned keyword rows (reported, not gated: the corpus differs)", async () => {
    const { metrics, observations } = await evaluate(ROOT_QUALITY_CASES, "like");
    const mockCanned = { authoritativeAnswers: 14, baselineAuthoritativeAnswers: 4, directTopFourRegressions: 0, candidateAvailability: 16, fusionSurvival: 16, seedHits: 16 };
    console.info(`RECALL_ROOT_QUALITY_SQLITE_LIKE_VS_MOCK ${JSON.stringify({
      real: {
        authoritativeAnswers: metrics.authoritativeAnswers,
        baselineAuthoritativeAnswers: metrics.baselineAuthoritativeAnswers,
        directTopFourRegressions: metrics.directTopFourRegressions,
        candidateAvailability: metrics.candidateAvailability,
        fusionSurvival: metrics.fusionSurvival,
        seedHits: metrics.seedHits,
      },
      mockCanned,
    })}`);
    // candidateAvailability is derived from the fixture (rawCandidates), not
    // from any query, so mode never moves it — this is the one number real
    // LIKE is guaranteed to match the mock on.
    expect(metrics.candidateAvailability, JSON.stringify(observations, null, 2)).toBe(mockCanned.candidateAvailability);
  });
});
