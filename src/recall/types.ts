import type { EdgeDirection, EdgeProvenance, EdgeType } from "../graph/types";
import type { MemoryStatus } from "../memory/status";
import type { EmbeddingQueryMode } from "./query-profile";
import type { RankMultipliers } from "./math";
import type { RootView } from "./root-selector";
import type { Identity } from "../lib/identity";
import type { SupersededBy, ValidityState } from "./validity-view";

/** A deprecated memory found at as-of time T: what was believed then, later retracted (spec 14 5.7). */
export interface RetractedBelief {
  /** The record time of the newest version whose prior tags were not deprecated: when it was last marked wrong. */
  retractedAt: number;
  /** The id of the true-at-T result it replaced, when found via a `supersedes` edge; null when standalone. */
  attachedTo: string | null;
}

export interface CompoundStaleSignal {
  count: number;
  oldestUpdatedAt: number;
}

/** How one query term matched a note: level 2 = as a word of its own, 1 = only inside a longer word. */
export interface KeywordTermTrace {
  term: string;
  level: 1 | 2;
  idf: number;
}

/** Where in the returned list a memory was seated. */
export type WhySlot = "direct" | "linked" | "evidence" | "deeper";

/** Why one memory came back: data recall had already computed, returned only when `explain` is asked for. */
export interface WhyTrace {
  /** 1-based rank in the dense (meaning) arm, null when that arm did not return it. */
  dense_rank: number | null;
  keyword_terms: KeywordTermTrace[];
  /** Null on memories that were not scored through the direct ranking (linked ones). */
  multipliers: RankMultipliers | null;
  /** The cross-encoder's percentile among what it scored (1 best, 0 worst), null when it did not score this memory. */
  rerank_percentile: number | null;
  /** Whether blending the model's scores moved this memory up or down the list; null when it did not move or was not scored. */
  rerank_move: "up" | "down" | null;
  /** False when the vector carried no created_at, so recency was scored as brand new; null when not scored directly. */
  age_known: boolean | null;
  graph: { provenance: EdgeProvenance; type: EdgeType; from: string } | null;
  slot: WhySlot;
}

export interface RecallMatch {
  id: string;
  content: string;
  score: number;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  source: string;
  isUpdate: boolean;
  hop: number;
  staleAsOf?: boolean;
  /** Which layer this memory lives in, so clients can show or act on it. */
  workspace?: "personal" | "company" | "system";
  /** Resolved author label on company-layer matches (shared memories). */
  actorName?: string;
  // Set only on graph-expanded matches (hop > 0): why / when / whence the edge that surfaced this memory.
  viaProvenance?: EdgeProvenance; // "explicit" (you linked) / "inferred" (auto) / "system"
  viaType?: EdgeType;
  viaLinkedAt?: number;           // when the edge was formed
  viaFrom?: string;               // id of the memory this one was reached from
  viaSourceId?: string;           // stored edge source
  viaTargetId?: string;           // stored edge target
  viaDirection?: EdgeDirection;   // direction from viaFrom toward this memory
  /** Present only when the caller asked to explain the ranking. */
  why?: WhyTrace;
  /** Recurring notices this row's near-duplicate collapse absorbed, newest first, up to 5 (4.4). */
  similar?: { id: string; createdAt: number }[];
  /** Effective start: COALESCE(valid_from, created_at) (T-0089.2.1). */
  validFrom: number;
  /** Whether valid_from was stated, not defaulted from createdAt. */
  validFromStated: boolean;
  validUntil: number | null;
  validityState: ValidityState;
  /** The live closer, when validityState is "replaced"; null otherwise. */
  supersededBy: SupersededBy | null;
  retractedSource: boolean;
  /**
   * As-of fields (spec 14 5.7), present only when `asOf` was set. A true-at-T result carries
   * asOfTextChangedAt/statusAt/recordedAfterAsOf/asOfPruned/asOfTextHidden/asOfHeld; a belief
   * entry carries only retractedBelief.
   */
  asOfTextChangedAt?: number | null;
  statusAt?: MemoryStatus | null;
  recordedAfterAsOf?: boolean;
  /** The oldest version history still kept ran out before reaching a row at or before T (item 6). */
  asOfPruned?: boolean;
  /** D-SH cut the version chain before reaching a row at or before T (item 6). */
  asOfTextHidden?: boolean;
  /** The text/tags this row had at T were held then (T-0102 MAJOR fix): `content` is "" here, whatever the row's current hold status. */
  asOfHeld?: boolean;
  retractedBelief?: RetractedBelief | null;
}

/** A standing instruction that fired above the results (spec 15 2.7-2.9), hydrated fresh from D1, never from KV. */
export interface StandingFire {
  id: string;
  content: string;
  createdAt: number;
  workspace: "personal" | "company" | "system";
  /** Set only when the row is not the caller's own (2.9: "set by Dana, Jul 3, 2026"). */
  actorName?: string;
  project: string | null;
  score: number;
  /** Present only when the caller asked to explain the ranking (2.9). */
  why?: string;
}

export interface RecallGraphContribution {
  requestedHops: number;
  seedCount: number;
  expandedCount: number;
  eligibleCount: number;
  selectedCount: number;
}

export interface RecallSearchResult {
  matches: RecallMatch[];
  insight: string;
  querySignalCacheHit: boolean;
  /** True when the advisory rollover-lineage lookup failed and recall kept the legacy ranking. */
  lineageFallbackUsed: boolean;
  semanticUnavailable: boolean;
  semanticUnavailableReason?: "workers_ai_quota_exhausted" | "embedding_unavailable" | "vectorize_unavailable";
  semanticRetryAt?: number;
  queryUsed?: string;
  // Distilled query terms, reused to pick a query-relevant excerpt when a long
  // memory has to be shortened for the response.
  queryTokens?: string[];
  /** Non-saturated query evidence plus numeric identifiers; current intent without time bounds. */
  currentQueryTokens?: string[];
  compoundStale?: CompoundStaleSignal;
  graphContribution: RecallGraphContribution;
  /** Present only when `asOf` was set (spec 14 5.7/5.9). */
  asOf?: { at: number; notRecordedBefore: number | null };
  /** Standing instructions that fired, capped at STANDING_MAX_FIRES, present only when non-empty (spec 15 2.8/2.9). */
  standing?: StandingFire[];
  /** Part C (05-proof.md, T-0089.5.3): a short, citable id for this recall — the recall_log
   * row's id when RECALL_LOG is on and this call logged, otherwise a hash of the query and
   * the time bucket. Always present; zero D1 cost when the log is off. */
  receipt: string;
}

export interface RecallDiagnostics {
  embeddingMode?: EmbeddingQueryMode;
  denseIds?: string[];
  keywordIds?: string[];
  candidateIds?: string[];
  fusedIds?: string[];
  rootSelections?: { id: string; selectedBy: RootView }[];
  expandedIds?: string[];
  eligibleRelatedIds?: string[];
  selectedRelatedIds?: string[];
  finalIds?: string[];
  collapsedDirectRolloverIds?: string[];
  collapsedGraphRolloverIds?: string[];
  promotedDirectRolloverIds?: string[];
  lineageFallbackUsed?: boolean;
  rejections?: { id: string; reason: string }[];
  operations?: RecallOperationDiagnostics;
  /** Observation anomalies, e.g. a first() statement that returned more than one row. Absent when there are none. */
  warnings?: string[];
  stageMs?: Partial<Record<RecallStage, number>>;
  /** #326 visibility: how many tokens reached keywordSearch, and whether it was skipped for want of any. */
  retrievalTokenCount?: number;
  lexicalArmSkipped?: boolean;
  /** Whether fusion could use corpus-wide DF for every lexical token (false = fetch-window estimate). */
  corpusIdfUsed?: boolean;
  /** Whether the FTS5 path served the keyword rows (false = LIKE, including any degrade-on-error). */
  ftsUsed?: boolean;
  /** Why the keyword arm served FTS or LIKE on the last recall; memberFirst recalls never reach keywordSearch. */
  ftsRoute?: "fts" | "fts-bounded" | "like-not-ready" | "like-ineligible-token" | "like-match-budget" | "like-error" | "like-member-first" | "skipped-by-variant";
  /** T-0059: how df/total were obtained on the last recall's term distillation. */
  distillSource?: "fts" | "like" | "scan" | "shortcut";
  /** What the cross-encoder step did on the last recall; "applied" means one model call reordered the candidates. */
  rerankRoute?: RerankRoute;
  /** Set when single-term keyword evidence was withheld: the term is too common (df over the saturation fraction, or the keyword window filled) or the corpus size was unavailable. */
  rerankEvidence?: "suppressed-saturated" | "suppressed-no-total";
  /** Wall time of the model call, when one was made. */
  rerankMs?: number;
}

export type RerankRoute = "off" | "not-ready" | "too-few" | "exact-id" | "clear-leader" | "attempted" | "applied" | "error" | "timeout";

export type RecallStage = "setup" | "querySignals" | "candidateGeneration" | "candidateHydration"
  | "graphExpansion" | "finalHydration" | "selection" | "synthesis" | "total";

export interface RecallOperationDiagnostics {
  aiCalls: number;
  embeddingCalls: number;
  vectorizeQueries: number;
  vectorizeGets: number;
  d1Statements: number;
  d1RowsRead: number | null;
  d1RowsWritten: number | null;
  kvReads: number;
  kvWrites: number;
}

/** Eval-only switches. Future variants add optional fields here; absent means default recall. */
export interface RecallVariantFlags {
  /** Tag and project recalls use both arms regardless of this ablation. */
  arms?: "both" | "dense-only" | "keyword-only";
  /** true forces the reranker on for the run (still subject to tenancy and the exact-identifier skip); no route sets it. */
  rerank?: boolean;
  /** Eval-only overrides of the reranker's blend weight, batch size and excerpt length; absent means the shipped values. */
  rerankTuning?: RerankTuning;
}

export interface RerankTuning {
  weight?: number; floor?: number; maxCandidates?: number; excerptChars?: number;
  /** Eval-only: how long one reranker call may take before recall falls back. `prepare`'s record pass raises it because local CPU inference can exceed the production budget; replay and gate runs never set it. */
  timeoutMs?: number;
}

export interface RecallInternalOptions {
  embeddingQueryMode?: EmbeddingQueryMode;
  diagnostics?: RecallDiagnostics;
  /**
   * When present, every entries read in the pipeline is scoped to the caller's
   * readable workspaces (personal ∪ company). Absent — internal callers and the
   * pre-tenancy tests — the SQL is exactly what it was before v3.
   */
  identity?: Identity;
  /**
   * Narrows the read to ONE layer of the readable set ("personal" or "company")
   * instead of the union. Only ever narrows: the ids still come from the
   * identity, so this cannot name a workspace the caller does not belong to.
   */
  workspaceFilter?: "personal" | "company";
  /** Narrows reads to one company team workspace (validated at the route edge). */
  teamId?: string;
  /**
   * Test-only escape hatch: forces fuseDenseAndKeyword's keywordPreRanked
   * argument regardless of whether FTS served the rows. No route may set this;
   * it exists so benchmarks can isolate Task 6's fusion-order change from
   * Task 3's candidate-selection change (FTS-ready but bm25 order disabled).
   */
  keywordPreRankedOverride?: boolean;
  /** Eval-only experiment switches; no route or MCP tool sets these. */
  variant?: RecallVariantFlags;
  /**
   * As-of recall (spec 14 5.7): what was actually true at this moment, not what is true now.
   * Set, this skips parseTimePhrase's bounds, swaps the keyword and hydration predicates for
   * validity-at-T, and appends retracted beliefs after every actually-true result.
   */
  asOf?: number;
}

export interface KeywordRow {
  /** タグ検索が取得した派生索引状態。通常のkeyword検索では未取得。 */
  vector_ids?: string;
  id: string;
  /** The note's text. Absent on rows the keyword arm reads: it returns `hits` instead and never the text (see keyword-rows.ts). */
  content?: string;
  tags: string;
  source: string;
  created_at: number;
  /** Per query term, how the note holds it: 0 not at all, 1 only inside longer words, 2 as a word of its own. */
  hits?: ReadonlyMap<string, 0 | 1 | 2>;
  /** The note holds U+212A or U+0130, which lowercase turns into ASCII: its `hits` are settled from the text (keyword-rows.ts). */
  odd?: boolean;
}

export type { RankMultipliers, VectorizeMatch } from "./math";
