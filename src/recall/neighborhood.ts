import { VECTORIZE_TOP_K_MULTIPLIER } from "../constants";
import type { EdgeDirection, EdgeProvenance, EdgeType } from "../graph/types";
import type { DistilledQuery } from "./distill";
import { edgeIntentCompatibility, type GraphQueryDirection, type RecallIntent } from "./query-profile";
import { edgeScanBatchSize } from "../graph/traverse";
import { VIEW_SHARE } from "./root-selector";
import { queryRelevantWindow } from "./snippet";

const SUBSTRING_WEIGHT = 0.25;
const WEIGHT = {
  root: 0.30,
  linkedCoverage: 0.25,
  unionCoverage: 0.20,
  coverageGain: 0.10,
  edge: 0.05,
  provenance: 0.05,
  intent: 0.05,
} as const;
const MIN_NEIGHBORHOOD_SCORE = 0.5;
const MIN_EVIDENCE_GAIN = 0.1;
const MIN_LINKED_COVERAGE = 0.2;

export interface LinkedEvidenceInput {
  parentScore: number;
  parentContent: string;
  content: string;
  queryTokens: string[];
  evidenceTokens: string[];
  corpus: Pick<DistilledQuery, "df" | "total">;
  hop: number;
  edgeWeight: number;
  provenance: EdgeProvenance;
  hopDecay: number;
  replacementCoverage: number;
  intent: RecallIntent;
  edgeType: EdgeType;
  edgeDirection?: EdgeDirection;
  queryDirection?: GraphQueryDirection;
}

export interface NeighborhoodEvidenceScore {
  eligible: boolean;
  score: number;
  coverage: number;
  coverageGain: number;
  rejection?: "no-linked-evidence" | "weak-neighborhood" | "no-evidence-gain";
}

/**
 * Ceiling on the seeds one recall expands from, whichever arm found them: the
 * number expandGraph can scan for edges in a single D1 statement.
 *
 * It is the edge scan's own batch size, not a constant, because the scan binds
 * each seed twice and a scoped caller's workspace bindings come out of the same
 * budget. 50 is right only for an identity-less caller; a member reading their
 * two workspaces gets 49, and a 50-seed hop would have cost two statements.
 */
export const graphSeedCeiling = (scopeBindings = 0): number => edgeScanBatchSize(scopeBindings);

/** The dense arm's fetch window, the size this budget has always been. */
const denseSeedWindow = (topK: number, scopeBindings: number) =>
  Math.min(topK * VECTORIZE_TOP_K_MULTIPLIER, graphSeedCeiling(scopeBindings));

/**
 * The dense arm's graph seats, spent on rows the dense arm returned and on
 * nothing else.
 *
 * This number always meant "the dense arm's fetch window", but it used to be
 * handed the whole FUSED pool, so the two arms bid for one budget. Fusion gives
 * a keyword hit the sum of its matched IDF and a dense hit only 1/(k + rank),
 * so keyword-only rows outscore most of the dense arm: every one the real SQL
 * added took a seat from the bottom of the dense fetch, and a root the vector
 * arm did rank could fall out of the graph entirely. Truncating the dense arm
 * BY ITS OWN RANK is the design; being outbid by the other arm was not.
 */
export function graphSeedLimit(topK: number, denseCount: number, scopeBindings = 0): number {
  return Math.min(denseCount, denseSeedWindow(topK, scopeBindings));
}

/**
 * The keyword arm's graph seats: an allowance of its own, plus whatever of the
 * dense arm's window the dense arm did not fill.
 *
 * The allowance is deliberately a fraction of that window rather than a
 * matching budget: the keyword arm fetches KEYWORD_CANDIDATE_LIMIT rows, far
 * more than anything should expand from, and a row only it returned is a seed
 * on lexical evidence alone. The fraction is the share selectGraphRoots already
 * allots to its lexical view, so lexical evidence keeps about the seats it
 * always had — the dense arm simply stops paying for them.
 *
 * The unused-window term is what keeps a DEGRADED recall whole. With Vectorize
 * down, with a member whose rows have no vectors, or under the keyword-only
 * ablation, every root is keyword-only and there is no dense arm to reserve a
 * window for: on the allowance alone the surviving arm would be seeded from 9
 * roots at topK 10 where one shared budget seeded 30. The window is reserved
 * from the keyword arm only while the dense arm is actually using it, so the
 * TOTAL is the same whichever arm fills it.
 */
export function lexicalSeedLimit(topK: number, lexicalOnlyCount: number, denseSeats: number, scopeBindings = 0): number {
  const window = denseSeedWindow(topK, scopeBindings);
  return Math.max(0, Math.min(
    lexicalOnlyCount,
    Math.ceil(window * VIEW_SHARE.lexical) + (window - denseSeats),
    graphSeedCeiling(scopeBindings) - denseSeats,
  ));
}

/**
 * The result count the arms' graph seat budgets are sized for. graphSeedLimit and lexicalSeedLimit scale with the
 * topK they are given, so recall always passes this one: seats that followed the caller's topK would let a larger
 * topK change which roots are seeded and so reorder the head. It is the default call's value, which keeps that call
 * exactly as it was.
 */
export const RECALL_SEED_TOPK = 5;

/**
 * Result ranks (0-based) the graph may take, one linked memory each. Fixed so
 * topK never moves them: a call with topK <= 5 has none, and each further
 * slot appears only once topK reaches it.
 */
export const GRAPH_SLOT_INDICES = [4, 9] as const;
export const GRAPH_SLOT_INDEX = GRAPH_SLOT_INDICES[0];

export function relatedSlotLimit(topK: number): number {
  if (topK < 3) return 0;
  return topK < 6 ? 1 : 2;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface CoverageDetail {
  score: number;
  exactHighIdf: boolean;
}

export function queryCoverage(
  content: string,
  tokens: string[],
  corpus: Pick<DistilledQuery, "df" | "total">,
): CoverageDetail {
  const normalizedTokens = [...new Set(
    tokens.map(t => t.normalize("NFKC").toLowerCase()).filter(Boolean)
  )];
  if (!normalizedTokens.length) return { score: 0, exactHighIdf: false };

  const hasCorpusIdf = !!corpus.df && !!corpus.total && normalizedTokens.every(t => corpus.df!.has(t));
  const weightOf = (token: string) => hasCorpusIdf
    ? Math.log(1 + corpus.total! / ((corpus.df!.get(token) ?? 0) + 1))
    : 1;
  const lower = content.normalize("NFKC").toLowerCase();
  let matched = 0;
  let total = 0;
  let exactHighIdf = false;

  for (const token of normalizedTokens) {
    const weight = weightOf(token);
    total += weight;
    const isExactMatch = new RegExp(`(?<![\\w])${escapeRegExp(token)}(?![\\w])`).test(lower);
    if (isExactMatch) {
      matched += weight;
      exactHighIdf ||= !!corpus.df
        && !!corpus.total
        && (corpus.df.get(token) ?? Number.POSITIVE_INFINITY) <= corpus.total * 0.1;
    } else if (lower.includes(token)) {
      matched += weight * SUBSTRING_WEIGHT;
    }
  }

  return { score: total > 0 ? matched / total : 0, exactHighIdf };
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function exactQueryMatchCount(content: string, tokens: string[]): number {
  const lower = content.normalize("NFKC").toLowerCase();
  return [...new Set(
    tokens.map(token => token.normalize("NFKC").toLowerCase()).filter(Boolean)
  )]
    .filter(token => new RegExp(`(?<![\\w])${escapeRegExp(token)}(?![\\w])`).test(lower)).length;
}

export function scoreLinkedEvidence(input: LinkedEvidenceInput): NeighborhoodEvidenceScore {
  const linkedEvidence = queryRelevantWindow(
    input.content,
    [...input.queryTokens, ...input.evidenceTokens],
  );
  const parentCoverage = Math.max(
    queryCoverage(input.parentContent, input.queryTokens, input.corpus).score,
    queryCoverage(input.parentContent, input.evidenceTokens, input.corpus).score,
  );
  const precision = queryCoverage(linkedEvidence, input.queryTokens, input.corpus);
  const linkedCoverage = Math.max(
    precision.score,
    queryCoverage(linkedEvidence, input.evidenceTokens, input.corpus).score,
  );
  const unionContent = `${input.parentContent}\n${linkedEvidence}`;
  const unionCoverage = Math.max(
    queryCoverage(unionContent, input.queryTokens, input.corpus).score,
    queryCoverage(
      unionContent,
      input.evidenceTokens,
      input.corpus,
    ).score,
  );
  const coverageGain = Math.max(0, unionCoverage - parentCoverage);
  const structuredTypeCompatible = (input.intent === "causal" && input.edgeType === "caused_by")
    || (input.intent === "chronology" && ["follows", "supersedes"].includes(input.edgeType));
  const structuredEdgeEvidence = input.hop === 1
    && input.provenance !== "inferred"
    && input.edgeWeight >= 0.5
    && structuredTypeCompatible
    && input.edgeDirection !== undefined
    && input.edgeDirection !== "undirected"
    && (input.queryDirection === undefined
      || input.queryDirection === "either"
      || input.queryDirection === input.edgeDirection);
  if (linkedCoverage === 0 && !structuredEdgeEvidence) {
    return { eligible: false, score: 0, coverage: linkedCoverage, coverageGain, rejection: "no-linked-evidence" };
  }

  const rootRelevance = clamp(input.parentScore * Math.pow(clamp(input.hopDecay), input.hop));

  const provenanceFactor = input.provenance === "explicit"
    ? 1
    : input.provenance === "system"
      ? 0.9
      : 0.8;
  const score = clamp(
    WEIGHT.root * rootRelevance
    + WEIGHT.linkedCoverage * clamp(linkedCoverage)
    + WEIGHT.unionCoverage * clamp(unionCoverage)
    + WEIGHT.coverageGain * clamp(coverageGain)
    + WEIGHT.edge * clamp(input.edgeWeight)
    + WEIGHT.provenance * provenanceFactor
    + WEIGHT.intent * edgeIntentCompatibility(input.intent, input.edgeType),
  );
  if (structuredEdgeEvidence) {
    return {
      eligible: true,
      score: Math.max(MIN_NEIGHBORHOOD_SCORE, score),
      coverage: linkedCoverage,
      coverageGain,
    };
  }
  const meetsPrecisionGate = precision.exactHighIdf || exactQueryMatchCount(linkedEvidence, input.queryTokens) >= 2;
  const meetsLinkedEvidenceGate = (linkedCoverage >= MIN_LINKED_COVERAGE || precision.exactHighIdf)
    && meetsPrecisionGate;
  if (!meetsLinkedEvidenceGate || score < MIN_NEIGHBORHOOD_SCORE) {
    return { eligible: false, score: 0, coverage: linkedCoverage, coverageGain, rejection: "weak-neighborhood" };
  }
  if (unionCoverage < clamp(input.replacementCoverage) + MIN_EVIDENCE_GAIN) {
    return { eligible: false, score: 0, coverage: linkedCoverage, coverageGain, rejection: "no-evidence-gain" };
  }

  return {
    eligible: true,
    score,
    coverage: linkedCoverage,
    coverageGain,
  };
}
