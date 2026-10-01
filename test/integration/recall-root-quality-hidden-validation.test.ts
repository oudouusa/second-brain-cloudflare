import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import { buildQueryProfile } from "../../src/recall/query-profile";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import {
  HIDDEN_VALIDATION_CASES,
  HIDDEN_VALIDATION_MANIFEST,
  HIDDEN_VALIDATION_SERIALIZATION,
  HIDDEN_VALIDATION_SHA256,
} from "../fixtures/recall-root-quality-hidden";
import {
  ROOT_QUALITY_CASES,
  type CandidateFixture,
  type RootQualityCase,
} from "../fixtures/recall-root-quality";
import { D1Mock } from "../helpers/d1-mock";
import { makeTestEnv, makeVectorizeMock } from "../helpers/make-env";

// This sealed validation pins the pre-reranker pipeline: its mock AI cannot rank passages, and a probe would count as an extra AI call.
const NO_RERANK = Object.freeze({ ...DEFAULTS, RERANK_MODE: "off" });
import {
  baselineRecall,
  directTopFourRegressed,
  rawCandidates,
} from "../helpers/recall-benchmark-scoring";

const TOP_K = 5;

interface CaseObservation {
  id: string;
  domain: RootQualityCase["domain"];
  failureShape: RootQualityCase["failureShape"];
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
  diagnostics: RecallDiagnostics;
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

const caseId = (c: RootQualityCase) => `${c.domain}/${c.failureShape}/${c.query}`;

function installControlledQueries(db: D1Mock, c: RootQualityCase): void {
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (sql.includes("SELECT COUNT(*) AS total") && sql.includes("SUM(CASE WHEN content LIKE")) {
      return {
        bind: (...patterns: string[]) => {
          // The recall observer runs first() as all() to count rows_read, so the double answers both the same way.
          const first = async () => c.failureShape === "weak-generic-neighbor"
            || c.failureShape === "long-parent-pollution"
            ? Promise.reject(new Error("controlled corpus scan unavailable"))
            : Object.fromEntries([
              ["total", 100],
              ...patterns.map((_, index) => [`d${index}`, 2]),
            ]);
          return { first, all: async () => ({ results: [await first()], meta: {} }) };
        },
      };
    }
    if (/WHERE \(?content LIKE/.test(sql) && /ORDER BY (?:\(CASE WHEN content LIKE|created_at DESC LIMIT)/.test(sql)) {
      const results = c.candidates
        .filter(candidate => candidate.keywordCandidate)
        .map(candidate => ({
          id: candidate.id,
          content: candidate.content,
          tags: JSON.stringify(candidate.tags ?? []),
          source: "hidden-validation",
          created_at: candidate.createdAt ?? 1,
        }));
      return { bind: () => ({ all: async () => ({ results }) }) };
    }
    return prepare(sql);
  };
}

function buildFixture(c: RootQualityCase) {
  const db = new D1Mock();
  for (const candidate of c.candidates) {
    db.entries.push({
      id: candidate.id,
      content: candidate.content,
      tags: JSON.stringify(candidate.tags ?? []),
      source: "hidden-validation",
      created_at: candidate.createdAt ?? 1,
      updated_at: candidate.createdAt ?? 1,
      vector_ids: "[]",
      recall_count: candidate.recallCount ?? 0,
      importance_score: 0,
      contradiction_wins: 0,
      contradiction_losses: 0,
    });
  }
  for (const [index, edge] of c.edges.entries()) {
    db.edges.push({
      id: `${caseId(c)}-edge-${index}`,
      source_id: edge.sourceId,
      target_id: edge.targetId,
      type: edge.type,
      weight: edge.weight,
      provenance: edge.provenance,
      metadata: "{}",
      created_at: 1,
      updated_at: 1,
    });
  }
  installControlledQueries(db, c);
  const query = vi.fn().mockResolvedValue({
    matches: c.candidates
      .filter((candidate): candidate is CandidateFixture & { denseScore: number } =>
        candidate.denseScore !== undefined)
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
  const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query }) });
  const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined } as unknown as ExecutionContext;
  return { env, ctx, query };
}

async function runCase(c: RootQualityCase): Promise<CaseObservation> {
  const graph = buildFixture(c);
  const diagnostics: RecallDiagnostics = {};
  const withGraph = await recallEntries(
    { query: c.query, topK: TOP_K, hops: 1, synthesize: false },
    graph.env,
    graph.ctx,
    NO_RERANK,
    { diagnostics },
  );
  const acceptableRoots = new Set(c.acceptableRootIds);
  const authoritative = new Set(c.authoritativeIds);
  const raw = rawCandidates(c);
  const candidateAvailable = raw.some(candidate =>
    acceptableRoots.has(candidate.id) || authoritative.has(candidate.id));
  const baseline = baselineRecall(c, withGraph.queryTokens ?? [], TOP_K);
  const outputIds = withGraph.matches.map(match => match.id);
  const graphAiCalls = (graph.env.AI.run as ReturnType<typeof vi.fn>).mock.calls.length;
  return {
    id: caseId(c),
    domain: c.domain,
    failureShape: c.failureShape,
    candidateAvailable,
    fused: (diagnostics.fusedIds ?? []).some(id => acceptableRoots.has(id)),
    seed: (diagnostics.rootSelections ?? []).some(selection => acceptableRoots.has(selection.id)),
    expanded: (diagnostics.expandedIds ?? []).some(id => authoritative.has(id)),
    selectedRelatedIds: diagnostics.selectedRelatedIds ?? [],
    authoritative: outputIds.some(id => authoritative.has(id)),
    baselineAuthoritative: baseline.outputIds.some(id => authoritative.has(id)),
    directTopFourRegression: directTopFourRegressed(outputIds, baseline.directIds),
    extraAiCalls: Math.max(0, graphAiCalls - 1),
    extraVectorizeQueries: Math.max(0, graph.query.mock.calls.length - 1),
    diagnostics,
  };
}

function summarize(observations: CaseObservation[]): BenchmarkMetrics {
  const selected = observations.flatMap(observation =>
    observation.selectedRelatedIds.map(id => ({ observation, id })));
  const useful = selected.filter(({ observation, id }) => {
    const c = HIDDEN_VALIDATION_CASES.find(candidate => caseId(candidate) === observation.id)!;
    return c.authoritativeIds.includes(id);
  }).length;
  const authoritativeAnswers = observations.filter(row => row.authoritative).length;
  const baselineAuthoritativeAnswers = observations.filter(row => row.baselineAuthoritative).length;
  return {
    cases: observations.length,
    candidateAvailability: observations.filter(row => row.candidateAvailable).length,
    fusionSurvival: observations.filter(row => row.fused).length,
    seedHits: observations.filter(row => row.candidateAvailable && row.seed).length,
    neighborhoodReach: observations.filter(row => row.expanded).length,
    authoritativeAnswers,
    baselineAuthoritativeAnswers,
    improvement: authoritativeAnswers - baselineAuthoritativeAnswers,
    usefulGraphPrecision: selected.length ? useful / selected.length : 1,
    directTopFourRegressions: observations.filter(row => row.directTopFourRegression).length,
    extraAiCalls: observations.reduce((sum, row) => sum + row.extraAiCalls, 0),
    extraVectorizeQueries: observations.reduce((sum, row) => sum + row.extraVectorizeQueries, 0),
  };
}

async function evaluate(cases: readonly RootQualityCase[]) {
  const observations: CaseObservation[] = [];
  for (const c of cases) observations.push(await runCase(c));
  return { observations, metrics: summarize(observations) };
}

function geometry(c: RootQualityCase) {
  const dense = c.candidates
    .filter((candidate): candidate is CandidateFixture & { denseScore: number } =>
      candidate.denseScore !== undefined)
    .slice()
    .sort((a, b) => b.denseScore - a.denseScore);
  const rootPositions = c.acceptableRootIds.map(id => dense.findIndex(candidate => candidate.id === id));
  const root = dense.find(candidate => c.acceptableRootIds.includes(candidate.id));
  return {
    rawCount: rawCandidates(c).length,
    denseCount: dense.length,
    keywordCount: c.candidates.filter(candidate => candidate.keywordCandidate).length,
    rootPositions: JSON.stringify(rootPositions),
    rootGap: root ? Number((dense[0].denseScore - root.denseScore).toFixed(3)) : null,
    recallMax: Math.max(0, ...c.candidates.map(candidate => candidate.recallCount ?? 0)),
    edgeShape: JSON.stringify(c.edges.map(edge => [
      edge.type,
      edge.weight,
      edge.provenance,
      edge.sourceId === c.acceptableRootIds[0],
    ])),
    queryShape: `${c.query.split(/\s+/).length}/${new Set(c.query.toLowerCase().split(/\s+/)).size}`,
  };
}

// Scope: these run against test/helpers/d1-mock.ts, whose canned keyword rows make them a
// test of fusion, root selection, and the graph with a controlled candidate pool. They say
// nothing about the keyword arm. Real-SQL coverage of the same 30 cases (with a baseline
// that sees the same keyword pool) is test/eval/legacy-parity.test.ts; retrieval quality on
// corpora large enough to discriminate keyword strategies is `npm run eval:recall` (T-0043).
describe("hidden recall validation structure", () => {
  it("preserves the sealed manifest digest and recursive freeze", () => {
    expect(HIDDEN_VALIDATION_SERIALIZATION).toBe("UTF-8 JSON.stringify insertion-order v1");
    expect(createHash("sha256").update(JSON.stringify(HIDDEN_VALIDATION_MANIFEST), "utf8").digest("hex"))
      .toBe(HIDDEN_VALIDATION_SHA256);
    expect(HIDDEN_VALIDATION_SHA256)
      .toBe("319c2553d379d2bf215f97ae89018e01658de15f8ddaceb21feda38f67ee9462");
    expect(Object.isFrozen(HIDDEN_VALIDATION_MANIFEST)).toBe(true);
    expect(Object.isFrozen(HIDDEN_VALIDATION_CASES)).toBe(true);
    for (const c of HIDDEN_VALIDATION_CASES) {
      expect(Object.isFrozen(c), caseId(c)).toBe(true);
      expect(Object.isFrozen(c.candidates), caseId(c)).toBe(true);
      expect(Object.isFrozen(c.edges), caseId(c)).toBe(true);
      expect(Object.isFrozen(c.authoritativeIds), caseId(c)).toBe(true);
      expect(Object.isFrozen(c.acceptableRootIds), caseId(c)).toBe(true);
    }
  });

  it("keeps the sealed balance, literal oracles, declared intents, and raw availability", () => {
    expect(HIDDEN_VALIDATION_CASES).toHaveLength(10);
    expect(HIDDEN_VALIDATION_CASES.filter(c => c.candidateAvailable)).toHaveLength(8);
    expect(HIDDEN_VALIDATION_CASES.filter(c => !c.candidateAvailable)).toHaveLength(2);
    expect(new Set(HIDDEN_VALIDATION_CASES.map(c => c.failureShape))).toEqual(new Set([
      "crowded-lexical-root",
      "popular-broad-summary",
      "long-parent-pollution",
      "weak-generic-neighbor",
      "absent-cluster-control",
    ]));
    for (const shape of new Set(HIDDEN_VALIDATION_CASES.map(c => c.failureShape))) {
      expect(HIDDEN_VALIDATION_CASES.filter(c => c.failureShape === shape)).toHaveLength(2);
    }
    expect(Object.fromEntries(
      ["personal", "enterprise", "product", "architecture"].map(domain => [
        domain,
        HIDDEN_VALIDATION_CASES.filter(c => c.domain === domain).length,
      ]),
    )).toEqual({ personal: 3, enterprise: 3, product: 2, architecture: 2 });
    for (const c of HIDDEN_VALIDATION_CASES) {
      expect(c.authoritativeIds.every(id => id.startsWith("fh-")), caseId(c)).toBe(true);
      const observed = rawCandidates(c).some(candidate =>
        c.acceptableRootIds.includes(candidate.id) || c.authoritativeIds.includes(candidate.id));
      expect(observed, caseId(c)).toBe(c.candidateAvailable);
      expect(["causal", "chronology", "current", "direct"], caseId(c)).toContain(c.intent);
    }
  });

  it("keeps every hidden geometry materially distinct from both existing splits", () => {
    const dimensions = Object.keys(geometry(HIDDEN_VALIDATION_CASES[0])) as
      (keyof ReturnType<typeof geometry>)[];
    for (const hidden of HIDDEN_VALIDATION_CASES) {
      for (const existing of ROOT_QUALITY_CASES.filter(c => c.failureShape === hidden.failureShape)) {
        const hiddenGeometry = geometry(hidden);
        const existingGeometry = geometry(existing);
        const differences = dimensions.filter(dimension =>
          hiddenGeometry[dimension] !== existingGeometry[dimension]);
        expect(
          differences.length,
          `${caseId(hidden)} vs ${caseId(existing)}: ${JSON.stringify({
            hiddenGeometry,
            existingGeometry,
          })}`,
        ).toBeGreaterThanOrEqual(5);
      }
    }
  });
});

describe("sealed hidden recall validation regression", () => {
  it("enforces the frozen ten-case ship gates", async () => {
    const { observations, metrics } = await evaluate(HIDDEN_VALIDATION_CASES);
    const byDomain = Object.fromEntries(
      (["personal", "enterprise", "product", "architecture"] as const).map(domain => [
        domain,
        summarize(observations.filter(row => row.domain === domain)),
      ]),
    );
    const funnel = {
      runtimeIntentMismatches: HIDDEN_VALIDATION_CASES.flatMap(c => {
        const runtime = buildQueryProfile(c.query, { query: c.query, df: null, total: null, distillSource: "shortcut" }).intent;
        return runtime === c.intent ? [] : [{ id: caseId(c), declared: c.intent, runtime }];
      }),
      candidateGenerationMisses: observations.filter(row => !row.candidateAvailable).map(row => row.id),
      fusionMisses: observations.filter(row => row.candidateAvailable && !row.fused).map(row => row.id),
      seedMisses: observations.filter(row => row.candidateAvailable && !row.seed).map(row => row.id),
      reachMisses: observations.filter(row => row.candidateAvailable && !row.expanded).map(row => row.id),
      answerMisses: observations.filter(row => !row.authoritative).map(row => row.id),
    };
    const report = { digest: HIDDEN_VALIDATION_SHA256, metrics, byDomain, funnel, observations };
    console.info(`HIDDEN_VALIDATION_RESULT ${JSON.stringify(report)}`);

    expect(metrics.cases, JSON.stringify(report, null, 2)).toBe(10);
    expect(metrics.candidateAvailability, JSON.stringify(report, null, 2)).toBe(8);
    expect(metrics.seedHits, JSON.stringify(report, null, 2)).toBeGreaterThanOrEqual(7);
    expect(metrics.usefulGraphPrecision, JSON.stringify(report, null, 2)).toBeGreaterThanOrEqual(0.7);
    expect(metrics.improvement, JSON.stringify(report, null, 2)).toBeGreaterThanOrEqual(2);
    expect(metrics.directTopFourRegressions, JSON.stringify(report, null, 2)).toBe(0);
    expect(metrics.extraAiCalls, JSON.stringify(report, null, 2)).toBe(0);
    expect(metrics.extraVectorizeQueries, JSON.stringify(report, null, 2)).toBe(0);
    for (const domain of Object.keys(byDomain) as (keyof typeof byDomain)[]) {
      expect(
        byDomain[domain].authoritativeAnswers,
        JSON.stringify({ domain, metrics: byDomain[domain] }, null, 2),
      ).toBeGreaterThanOrEqual(byDomain[domain].baselineAuthoritativeAnswers);
    }
  });
});
