import { CHUNK_OVERLAP_CHARS } from "../constants";
import { getStatus } from "../memory/status";
import { getVolatility } from "../memory/volatility";
import { hasStaleAsOf } from "../memory/stale";
import { RETRACTED_SOURCE_TAG } from "../memory/validity";
import { DEFAULTS, type Config } from "../config";
import { sourceClass, sourceWeight } from "./source-trust";
import type { RecallIntent } from "./query-profile";

export interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
  values?: number[] | Float32Array | Float64Array;
}

export interface RerankOptions {
  useRecallFrequency?: boolean;
  /** D1's source column, keyed by parentId. Wins over Vectorize metadata's `source`, exactly as d1Tags wins over metadata tags (4.2). */
  d1Sources?: Map<string, string>;
  /** The query's classified intent (spec 14 5.8/B6): stale_penalty applies only under "current". */
  intent?: RecallIntent;
}

// Recency-decay floors: the minimum fraction of its semantic relevance a memory
// keeps regardless of age (applied in rerankWithTimeDecay). Because decay now
// bottoms out at a floor instead of exp()-ing toward zero, recency becomes a
// tie-breaker rather than a gate — a strong old match can no longer be buried
// under a fresh weak one. Durability sets the floor via volatility: (preferred)
// or legacy proxies (canonical / importance / task). Time-triggered staleness
// warnings use stale:as-of tags set by the nightly pass.
export const RECENCY_FLOOR = 0.6;
export const RECENCY_FLOOR_DURABLE = 0.9;
export const RECENCY_FLOOR_VOLATILE = 0.15;

// MMR diversity: how much the final top-K trades relevance for variety. Higher =
// more relevance-focused, lower = more diverse. 0.7 keeps the top hit intact while
// stopping near-duplicate (usually recent) memories from taking every slot.
export const MMR_LAMBDA = 0.7;

export function getRecencyFloor(tags: string[], imp: number, config: Readonly<Config> = DEFAULTS): number {
  if (getStatus(tags) === "canonical" || imp >= 4) return config.RECENCY_FLOOR_DURABLE;
  const vol = getVolatility(tags);
  if (vol === "durable") return config.RECENCY_FLOOR_DURABLE;
  if (vol === "volatile") return config.RECENCY_FLOOR_VOLATILE;
  if (vol === "state") return config.RECENCY_FLOOR;
  if (tags.includes("task")) return config.RECENCY_FLOOR_VOLATILE;
  return config.RECENCY_FLOOR;
}

export function getHalfLifeMs(tags: string[]): number {
  if (tags.includes("task")) return 7 * 24 * 60 * 60 * 1000;
  if (tags.includes("context")) return 180 * 24 * 60 * 60 * 1000;
  if (tags.includes("work")) return 90 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

export function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

/**
 * The factors rerankWithTimeDecay applied, reported per match (data only: see WhyTrace in types.ts).
 * combined * importance * tag_boost * append_penalty * rolled_up_penalty is the score's multiplier.
 */
export interface RankMultipliers {
  recency: number;
  frequency: number;
  /** min(1, recency x frequency), the cap the score actually used. */
  combined: number;
  importance: number;
  tag_boost: number;
  append_penalty: number;
  rolled_up_penalty: number;
  /** The source-class demotion (4.2); 1.0 for direct and for any canonical row regardless of class. */
  source_weight: number;
  /** Mild demotion for a stale:as-of row under a "current" query intent (spec 14 5.8/B6); 1.0 otherwise. */
  stale_penalty: number;
}

type RerankArgs = [
  matches: VectorizeMatch[],
  recallCounts: Map<string, number>,
  importanceScores: Map<string, number>,
  queryTags: string[],
  contradictionWins: Map<string, number>,
  contradictionLosses: Map<string, number>,
  d1Tags: Map<string, string[]>,
  config: Readonly<Config>,
  options: Readonly<RerankOptions>,
];

const rerankDefaults = (args: Partial<RerankArgs>): RerankArgs => [
  args[0] ?? [], args[1] ?? new Map(), args[2] ?? new Map(), args[3] ?? [],
  args[4] ?? new Map(), args[5] ?? new Map(), args[6] ?? new Map(), args[7] ?? DEFAULTS, args[8] ?? {},
];

/** The multiplier the score actually applied, plus the age-known flag `why` reports: shared by both entry points below. */
function scoredMultiplier(
  match: VectorizeMatch,
  recallCounts: Map<string, number>,
  importanceScores: Map<string, number>,
  queryTags: string[],
  contradictionWins: Map<string, number>,
  contradictionLosses: Map<string, number>,
  d1Tags: Map<string, string[]>,
  config: Readonly<Config>,
  options: Readonly<RerankOptions>,
) {
  const now = Date.now();
  const meta = match.metadata as any;
  const ageKnown = typeof meta?.created_at === "number";
  const createdAt = meta?.created_at ?? now;
  const parentId = (meta?.parentId ?? match.id) as string;
  const metaTags: string[] = Array.isArray(meta?.tags) ? meta.tags : [];
  const tags: string[] = d1Tags.get(parentId) ?? metaTags;
  const ageMs = now - createdAt;
  const rc = recallCounts.get(parentId) ?? 0;

  const halfLifeMs = getHalfLifeMs(tags);
  const imp = importanceScores.get(parentId) ?? 0;

  const recencyFloor = getRecencyFloor(tags, imp, config);
  const recency = recencyFloor + (1 - recencyFloor) * Math.exp(-ageMs / halfLifeMs);
  const frequency = options.useRecallFrequency === false ? 1 : 1 + Math.log1p(rc);
  const combined = Math.min(1.0, recency * frequency);
  // metadata.isUpdate marks an append's own chunk; "-update-" is 3.7's deterministic id for one.
  const isShortAppend = (meta?.isUpdate === true || match.id.includes("-update-")) &&
    typeof meta?.content === "string" && meta.content.length < CHUNK_OVERLAP_CHARS && meta?.keywordSupported !== true;
  const appendPenalty = isShortAppend ? 0.2 : 1.0;
  const rolledUpPenalty = tags.includes("rolled-up") ? 0.4 : 1.0;

  const wins = contradictionWins.get(parentId) ?? 0;
  const losses = contradictionLosses.get(parentId) ?? 0;
  const net = wins - losses;
  let importance: number;
  if (imp === 0 && net === 0) {
    importance = 1.0;
  } else {
    const base = imp === 0 ? 3 : imp;
    const adj = Math.sign(net) * Math.log1p(Math.abs(net)) * config.CONTRADICTION_IMPORTANCE_STEP;
    const effectiveImp = Math.max(1, Math.min(5, base + adj));
    importance = 0.8 + (effectiveImp / 5) * 0.4;
  }

  const overlap = queryTags.length ? tags.filter(t => queryTags.includes(t)).length : 0;
  const tagBoost = overlap ? Math.min(config.TAG_BOOST_MAX, 1 + overlap * config.TAG_BOOST_STEP) : 1.0;

  const source = options.d1Sources?.get(parentId) ?? (typeof meta?.source === "string" ? meta.source : undefined);
  const srcWeight = getStatus(tags) === "canonical" ? 1.0 : sourceWeight(sourceClass(source, tags), config);

  const stalePenalty = options.intent === "current" && hasStaleAsOf(tags) && !tags.includes(RETRACTED_SOURCE_TAG)
    ? config.STALE_PENALTY
    : 1.0;

  return {
    factor: combined * appendPenalty * rolledUpPenalty * importance * tagBoost * srcWeight * stalePenalty,
    recency, frequency, combined, importance, tagBoost, appendPenalty, rolledUpPenalty, ageKnown, srcWeight, stalePenalty,
  };
}

/**
 * Standalone: explain off never builds a RankMultipliers or ageKnown value for a match it is
 * about to throw away. Same ordering and scores as rerankWithTimeDecayTraced.
 */
export function rerankWithTimeDecay(...args: Partial<RerankArgs>): VectorizeMatch[] {
  const [matches, recallCounts, importanceScores, queryTags, contradictionWins, contradictionLosses, d1Tags, config, options] = rerankDefaults(args);
  return matches
    .map(match => {
      const { factor } = scoredMultiplier(match, recallCounts, importanceScores, queryTags, contradictionWins, contradictionLosses, d1Tags, config, options);
      return { ...match, score: match.score * factor };
    })
    .sort((a, b) => b.score - a.score);
}

/** Same ordering and scores as rerankWithTimeDecay, with the multipliers that shaped each score alongside it. */
export function rerankWithTimeDecayTraced(...args: Partial<RerankArgs>): { match: VectorizeMatch; multipliers: RankMultipliers; ageKnown: boolean }[] {
  const [matches, recallCounts, importanceScores, queryTags, contradictionWins, contradictionLosses, d1Tags, config, options] = rerankDefaults(args);
  return matches
    .map(match => {
      const m = scoredMultiplier(match, recallCounts, importanceScores, queryTags, contradictionWins, contradictionLosses, d1Tags, config, options);
      return {
        match: { ...match, score: match.score * m.factor },
        multipliers: { recency: m.recency, frequency: m.frequency, combined: m.combined, importance: m.importance, tag_boost: m.tagBoost, append_penalty: m.appendPenalty, rolled_up_penalty: m.rolledUpPenalty, source_weight: m.srcWeight, stale_penalty: m.stalePenalty },
        ageKnown: m.ageKnown,
      };
    })
    .sort((a, b) => b.match.score - a.match.score);
}

export function mmrRerank<T extends VectorizeMatch>(candidates: T[], lambda: number, k: number): T[] {
  if (candidates.length <= 1 || k <= 1) return candidates.slice(0, k);
  const pool = [...candidates].sort((a, b) => b.score - a.score);
  const maxRel = pool[0].score || 1;
  const rel = (m: VectorizeMatch) => (maxRel > 0 ? m.score / maxRel : 0);

  const selected: T[] = [pool.shift()!];
  while (selected.length < k && pool.length) {
    let bestIdx = 0;
    let bestMmr = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      let maxSim = 0;
      if (cand.values) {
        for (const s of selected) {
          if (s.values) maxSim = Math.max(maxSim, cosineSim(cand.values, s.values));
        }
      }
      const mmr = lambda * rel(cand) - (1 - lambda) * maxSim;
      if (mmr > bestMmr) { bestMmr = mmr; bestIdx = i; }
    }
    selected.push(pool.splice(bestIdx, 1)[0]);
  }
  return selected;
}
