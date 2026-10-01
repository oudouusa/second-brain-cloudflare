import type { Env } from "../env";
import { chatGptEnvForWorkspaces } from "../lib/chatgpt";
import { memoryWriteMarker } from "../migration/write-lock";
import {
  D1_MAX_BOUND_PARAMS,
  D1_MAX_LIKE_PATTERN_BYTES,
  KEYWORD_MAX_TOKENS,
  QUERY_SATURATION_FRACTION,
  VECTORIZE_GET_BY_IDS_BATCH,
  RECALL_BLOCK,
  RECALL_DEEP_POOL_SIZE,
  RECALL_POOL_SIZE,
  STANDING_MAX_FIRES,
  VECTORIZE_WIDEN_MAX_CANDIDATES,
  VECTORIZE_WORKSPACE_FILTER_UNSUPPORTED_KV_KEY,
} from "../constants";
import { isRerankMode, resolveConfig, type Config, type RerankMode } from "../config";
import { embedQuery, embedMany, readWorkersAiHealth, WorkersAiQuotaError } from "../lib/ai";
import {
  assertVectorProfiles,
  EmbeddingProfileMismatchError,
} from "../embedding/profile";
import { expandGraph } from "../graph/traverse";
import type { GraphNeighbor } from "../graph/types";
import { KIND_VALUES, type MemoryKind } from "../memory/kind";
import { parseTimePhrase } from "../text/temporal";
import {
  likeContainsPattern,
  QUERY_LIKE_ESCAPE,
  tokenizeQuery,
  withoutContainedCjkBigrams,
  type LexicalToken,
} from "../text/lexical-query";
import { distillToRareTerms, inferQueryTags, scopedEntryTotal, type DistilledQuery, type TimeBounds } from "./distill";
import { CONTENT_LIKE_ESCAPE, contentLikePattern } from "../text/like";
import { synthesizeInsight } from "./insight";
import { hasStaleAsOf } from "../memory/stale";
import { cosineSim, mmrRerank, rerankWithTimeDecay, rerankWithTimeDecayTraced, type RankMultipliers, type VectorizeMatch } from "./math";
import { rrfFuse } from "./rrf";
import { computeCompoundStale } from "./compound-stale";
import { exactQueryMatchCount, GRAPH_SLOT_INDEX, GRAPH_SLOT_INDICES, graphSeedLimit, lexicalSeedLimit, RECALL_SEED_TOPK, scoreLinkedEvidence } from "./neighborhood";
import { queryCoverage } from "./neighborhood";
import {
  buildQueryProfile,
  DEFAULT_EMBEDDING_QUERY_MODE,
  embeddingInput,
  type RecallIntent,
} from "./query-profile";
import { localEvidenceOf } from "./root-candidate";
import { readQuerySignalCache, writeQuerySignalCache } from "./query-signal-cache";
import { blendRerankerScores, rerankDirectCap, rerankStep } from "./model-reranker";
import { evidenceScoreOf, selectGraphRoots, type RootCandidate } from "./root-selector";
import type { KeywordRow, KeywordTermTrace, RecallDiagnostics, RecallGraphContribution, RecallInternalOptions, RecallMatch, RecallSearchResult, RecallStage, StandingFire, WhySlot, WhyTrace } from "./types";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import { projectFilterSql, projectMemberTags } from "../projects/filter";
import type { ProjectRow } from "../projects/registry";
import { workspaceFilter, queryVectorizeScoped } from "../vectorize/scope";
import { observeRecallEnv } from "./diagnostics";
import { parseSupersededBy, validitySummary } from "./validity-view";
import { chooseEvidenceSlot, type EvidenceSlotCandidate } from "./evidence-rescue";
import { queryRelevantWindow } from "./snippet";
import { durationMs, errorName, logErrorEvent, logEvent } from "../lib/observability";
import type { Identity } from "../lib/identity";
import { lookupActorLabels, resolveActorLabel } from "../lib/actors";
import { layerOf, readScopeWorkspaces, scopeWhereForIdRead, scopeWhereForRead } from "../lib/scope";
import { isTopicTag } from "../compression/eligibility";
import { FTS_LIVENESS_SQL, ftsEligibleToken, ftsReady, ftsShortToken, isFtsLiveRows, planFtsMatch } from "./fts";
import { levelInLower, rowWithLevels, settleLevels, withMatchLevels } from "./keyword-rows";
import { vectorSortKey } from "../vectorize/ids";
import { isHeld, NOT_HELD_SQL } from "../quarantine/tags";
import { applyOccupancyCap, CAP_LOOKAHEAD, collapseLift, collapseNearDuplicates, liftFor } from "./source-trust";
import { enrichWithAsOf, asOfPredicateSql, asOfPredicateBindings } from "./as-of";
import { getVersionsSince } from "../memory/versions";
import { currentValidityAt, supersededBySql } from "../memory/validity";
import { maybeLogRecall, receiptHash, type RecallLogChannel } from "./log";
import { readStandingCaches } from "../standing/cache";
import { selectStandingFires } from "../standing/fire";

/**
 * The terms whose matches all fit `limit` (the rarest first), and the rest, or null when the window needs no help:
 * a frequency is missing, every term fits, or even the rarest is too common to fit. The df sum over-counts rows that
 * carry several terms, so the fitted group can never truncate. Same greedy as planFtsMatch's bounded plan.
 */
function splitLikeTerms(terms: string[], df: ReadonlyMap<string, number> | null | undefined, limit: number): { rare: string[]; rest: string[] } | null {
  if (!df || !terms.every(t => df.has(t))) return null;
  const dfOf = (t: string) => df.get(t) ?? 0;
  if (terms.reduce((sum, t) => sum + dfOf(t), 0) <= limit) return null;
  const rare: string[] = [];
  let spent = 0;
  for (const t of [...terms].sort((a, b) => dfOf(a) - dfOf(b))) {
    if (spent + dfOf(t) > limit) break;
    spent += dfOf(t);
    rare.push(t);
  }
  return rare.length ? { rare, rest: terms.filter(t => !rare.includes(t)) } : null;
}

type RecallParams = {
  project?: readonly ProjectRow[];
  query: string;
  topK: number;
  tag?: string;
  after?: number;
  before?: number;
  kind?: MemoryKind;
  hops?: number;
  synthesize?: boolean;
  explain?: boolean;
  channel?: RecallLogChannel;
};

// Share lifecycle/kind predicates across candidate admission and the final read.
// Filtering after LIMIT cannot reclaim occupied slots.
function recallEligibilitySql(kind?: MemoryKind): string {
  let where = ` AND tags NOT LIKE '%"auto-pattern"%' AND tags NOT LIKE '%"auto-insight"%' AND tags NOT LIKE '%"status:deprecated"%'`;
  if (kind && (KIND_VALUES as readonly string[]).includes(kind)) {
    where += ` AND tags LIKE '%"kind:${kind}"%'`;
  }
  return where;
}

async function keywordSearchLexical(
  inputTerms: readonly LexicalToken[],
  env: Env,
  limit: number,
  bounds: Readonly<TimeBounds> = {},
  identity?: Identity,
  only?: "personal" | "company",
  teamId?: string,
  priorityTerms?: readonly LexicalToken[],
  previousRows?: readonly KeywordRow[],
  kind?: MemoryKind,
  answerOnly = false,
  corpus?: Pick<DistilledQuery, "df" | "total">,
  now = Date.now(),
  asOf?: number,
): Promise<KeywordRow[]> {
  if (!inputTerms.length) return [];
  // Capped here rather than at distillation's uncapped exits because this is
  // the place tokens and their optional raw compatibility probes become SQL.
  // Primary normalized probes are admitted first; raw probes use only the
  // remaining D1 variable budget after time, scope, and LIMIT bindings.
  const terms = inputTerms.slice(0, KEYWORD_MAX_TOKENS);
  let timeWhere = "";
  const timeBindings: number[] = [];
  if (bounds.after !== undefined) {
    timeWhere += " AND created_at >= ?";
    timeBindings.push(bounds.after);
  }
  if (bounds.before !== undefined) {
    timeWhere += " AND created_at < ?";
    timeBindings.push(bounds.before);
  }
  // Scoped before ORDER BY so LIMIT ranks only readable rows, not readable rows
  // plus strangers' rows truncated by the window.
  const scope = identity ? scopeWhereForRead(identity, { layer: only, teamId }) : null;
  const scopeSql = scope ? ` AND ${scope.clause}` : "";
  const validitySql = ` AND ${asOf === undefined ? "(valid_until IS NULL OR valid_until > ?)" : asOfPredicateSql()} AND ${NOT_HELD_SQL}`;
  const validityBindings = asOf === undefined ? [now] : asOfPredicateBindings(asOf);
  const probeBudget = Math.max(
    0,
    D1_MAX_BOUND_PARAMS - validityBindings.length - timeBindings.length - (scope?.bindings.length ?? 0) - 1,
  );
  const primaryProbes = terms.map(term => term.probes[0]).slice(0, probeBudget);
  const extraProbes = terms.flatMap(term => term.probes.slice(1));
  const probes = [...primaryProbes, ...extraProbes].slice(0, probeBudget);
  if (!probes.length) return [];
  const columns = "id, content, tags, source, created_at";
  const priorityRows: KeywordRow[] = [];
  // The keyword-only path reserves a small exact/conjunctive lane. Keep the
  // healthy dense path parallel. Known degradation returns <= limit rows across
  // both SELECTs; late failure reuses its initial rows and fetches only this lane.
  // That late path can fetch limit + min(32, floor(limit / 4)) rows in total.
  // LIKE/GLOB still cannot promise a bound on D1's billed/scanned rows.
  if (priorityTerms?.length && probes.length < probeBudget) {
    const admitted = new Set(probes);
    const strictBindings: string[] = [];
    let hasBoundary = false;
    const conditions = priorityTerms.map(term => {
      const allowed = term.probes.filter(probe => admitted.has(probe));
      if (!allowed.length) return "";
      return `(${allowed.map(probe => {
        // Conservative ASCII boundaries: a non-ASCII neighbor is NOT treated
        // as punctuation. Unicode/CJK scoring stays with the upstream scorer.
        const boundary = "[^a-z0-9_\u0080-\u{10ffff}]";
        const literal = probe.toLowerCase().replace(/[?*[]/g, char => `[${char}]`);
        const glob = `*${boundary}${literal}${boundary}*`;
        if (/^[\x21-\x7e]+$/.test(probe)
          && new TextEncoder().encode(glob).byteLength <= D1_MAX_LIKE_PATTERN_BYTES) {
          strictBindings.push(glob);
          hasBoundary = true;
          // Japanese sentence punctuation separates identifiers too. Normalize
          // only these two separators; Unicode letters must remain non-boundaries.
          return "(' ' || lower(replace(replace(content, '。', ' '), '、', ' ')) || ' ') GLOB ?";
        }
        strictBindings.push(likeContainsPattern(probe));
        return `content LIKE ? ${QUERY_LIKE_ESCAPE}`;
      }).join(" OR ")})`;
    });
    // A lone CJK token is ambiguous from text alone. In degraded mode, admit it
    // only when stored authority metadata provides an independent signal.
    const loneCjkAuthority = conditions.length === 1
      && !hasBoundary
      && priorityTerms.length === terms.length
      && priorityTerms[0]?.kind === "word"
      && CJK_TOKEN.test(priorityTerms[0].value);
    const strictEvidence = conditions.length > 1 || hasBoundary || priorityTerms.length < terms.length;
    const canonicalSql = "EXISTS (SELECT 1 FROM json_each(entries.tags) WHERE value = 'status:canonical')";
    if (conditions.every(Boolean) && (strictEvidence || loneCjkAuthority)
      && strictBindings.length <= probeBudget) {
      const authorityWhere = loneCjkAuthority
        ? ` AND (importance_score >= 5 OR ${canonicalSql})`
        : "";
      const { results } = await env.DB.prepare(
        // validity: as-of: 指定時点ではasOfPredicateSql、通常検索ではvaliditySqlで現在の適格性を検査する。
        `SELECT ${columns} FROM entries WHERE ${conditions.join(" AND ")}${authorityWhere}${recallEligibilitySql(kind)}${timeWhere}${scopeSql}${validitySql} ORDER BY CASE WHEN ${canonicalSql} THEN 1 ELSE 0 END DESC, importance_score DESC, created_at DESC LIMIT ?`,
      ).bind(...strictBindings, ...timeBindings, ...(scope?.bindings ?? []), ...validityBindings, Math.min(32, Math.floor(limit / 4))).all();
      priorityRows.push(...(results as unknown as KeywordRow[]).map(row => ({ ...row, __priority: true })));
    }
  }
  // A late dense failure already paid for the bounded OR query. Do not run it
  // again: place the bounded priority rows first and refill from that same read.
  // Hydration below still checks current existence, lifecycle and workspace.
  if (previousRows) {
    const reserved = new Set(priorityRows.map(row => row.id));
    return [...priorityRows, ...previousRows.filter(row => !reserved.has(row.id))].slice(0, limit);
  }
  const where = probes.map(() => `content LIKE ? ${QUERY_LIKE_ESCAPE}`).join(" OR ");
  // One bounded JSON binding excludes the reserved rows without spending one
  // SQL parameter per ID. Probe admission above reserves this only when spare.
  const exclusion = priorityRows.length ? " AND id NOT IN (SELECT value FROM json_each(?))" : "";
  const exclusionBindings = priorityRows.length ? [JSON.stringify(priorityRows.map(row => row.id))] : [];
  // Preserve every WHERE probe. Ranking may use only the variables left after
  // time, scope, priority exclusion and LIMIT have been reserved.
  const orderBudget = Math.max(0, probeBudget - probes.length - exclusionBindings.length);
  const orderProbes = [
    ...terms.map(term => ({ probe: term.probes[0], word: term.kind !== "cjk-bigram" })),
    ...terms.flatMap(term => term.probes.slice(1).map(probe => ({ probe, word: term.kind !== "cjk-bigram" }))),
  ].slice(0, probes.length)
    .filter(candidate => candidate.word)
    .map(candidate => candidate.probe)
    .slice(0, orderBudget);
  // Upstream #344: scope must govern every OR alternative before the LIMIT.
  // The literal-probe overlay also needs grouping before its exclusion filter.
  // graphの中継点は回答と異なるkindでもよい。直接検索だけで取得前に除外する。
  const eligibilitySql = answerOnly ? recallEligibilitySql(kind) : "";
  const tokenWhere = probes.length > 1 ? `(${where})` : where;
  const orderSql = orderProbes.length
    ? `(${orderProbes.map(() => `CASE WHEN content LIKE ? ${QUERY_LIKE_ESCAPE} THEN 1 ELSE 0 END`).join(" + ")}) DESC, created_at DESC`
    : "created_at DESC";
  // 上流の稀語窓を互換probeにも適用する。縮退時は既存のpriority laneを使う。
  // 各語のdfはprobeのOR件数なので、語単位で分け、raw表記も同じ窓に残す。
  // corpus全体が収まる場合やdf=0の語だけの窓は、救済する行がないため作らない。
  const split = !priorityTerms?.length && corpus?.total && corpus.total > limit ? splitLikeTerms(terms.map(t => t.value), corpus?.df, limit) : null;
  if (split && split.rare.some(t => (corpus?.df?.get(t) ?? 0) > 0)) {
    const rareValues = new Set(split.rare);
    const rareProbes = new Set(terms.filter(t => rareValues.has(t.value)).flatMap(t => t.probes));
    const rare = probes.filter(p => rareProbes.has(p));
    const rest = probes.filter(p => !rareProbes.has(p));
    const windowFor = (subset: string[], max: number, not: string[] = []) => {
      const where = subset.map(() => `content LIKE ? ${QUERY_LIKE_ESCAPE}`).join(" OR ");
      const exclude = not.length ? ` AND NOT (${not.map(() => `content LIKE ? ${QUERY_LIKE_ESCAPE}`).join(" OR ")})` : "";
      // scope-checked: scopeSqlは上で構築した読取スコープをすべてのOR候補に適用する
      return env.DB.prepare(
        // validity: as-of: 指定時点ではasOfPredicateSql、通常検索ではvaliditySqlで現在の適格性を検査する。
        `SELECT ${columns} FROM entries WHERE (${where})${timeWhere}${scopeSql}${validitySql}${exclude}${eligibilitySql} ORDER BY ${orderSql} LIMIT ?`,
      ).bind(...subset.map(likeContainsPattern), ...timeBindings, ...(scope?.bindings ?? []), ...validityBindings,
        ...not.map(likeContainsPattern), ...orderProbes.map(likeContainsPattern), max);
    };
    const room = limit - split.rare.reduce((sum, t) => sum + (corpus?.df?.get(t) ?? 0), 0);
    if (rare.length) {
      const windows = rest.length && room > 0
        ? await env.DB.batch([windowFor(rare, limit), windowFor(rest, room, rare)])
        : [await windowFor(rare, limit).all()];
      return windows.flatMap(result => result.results as unknown as KeywordRow[]).slice(0, limit);
    }
  }
  const { results } = await env.DB.prepare(
    // validity: as-of: 指定時点ではasOfPredicateSql、通常検索ではvaliditySqlで現在の適格性を検査する。
    `SELECT ${columns} FROM entries WHERE ${tokenWhere}${timeWhere}${scopeSql}${validitySql}${exclusion}${eligibilitySql} ORDER BY ${orderSql} LIMIT ?`
  ).bind(...probes.map(likeContainsPattern), ...timeBindings, ...(scope?.bindings ?? []), ...validityBindings, ...exclusionBindings,
    ...orderProbes.map(likeContainsPattern), limit - priorityRows.length).all();
  return [...priorityRows, ...results as unknown as KeywordRow[]];
}

async function keywordSearchLike(
  tokens: string[],
  env: Env,
  limit: number,
  bounds: Readonly<TimeBounds> = {},
  identity?: Identity,
  only?: "personal" | "company",
  teamId?: string,
  // Corpus df from distillation. With it, rows carrying the rarest terms are kept whole and recency fills the rest;
  // without it the window is the newest rows matching any term, as before.
  corpus?: Pick<DistilledQuery, "df" | "total">,
  lexical?: { terms: readonly LexicalToken[]; priorityTerms?: readonly LexicalToken[]; previousRows?: readonly KeywordRow[]; kind?: MemoryKind; answerOnly?: boolean; forceLike?: boolean },
  now: number = Date.now(),
  asOf?: number,
): Promise<KeywordRow[]> {
  // 互換probe・縮退救済・bind超過だけfork経路を使い、通常のLIKE窓は上流へ委譲する。
  // 上流窓はWHERE／除外で合計1枠、match levelで1枠を各tokenに使う。
  if (lexical && (lexical.forceLike || lexical.previousRows || lexical.priorityTerms?.length
    || lexical.terms.some(t => t.kind === "cjk-bigram" || t.probes.length > 1 || CJK_TOKEN.test(t.value))
    || Math.min(tokens.length, KEYWORD_MAX_TOKENS) * 2 + (identity ? scopeWhereForRead(identity, { layer: only, teamId }).bindings.length : 0)
      + Number(bounds.after !== undefined) + Number(bounds.before !== undefined)
      + (asOf === undefined ? 1 : asOfPredicateBindings(asOf).length) + 1 > D1_MAX_BOUND_PARAMS)) {
    return keywordSearchLexical(lexical.terms, env, limit, bounds, identity, only, teamId,
      lexical.priorityTerms, lexical.previousRows, lexical.kind, lexical.answerOnly, corpus, now, asOf);
  }
  if (!tokens.length) return [];
  // Capped here rather than at distillation's uncapped exits because this is
  // the only place a token count becomes SQL, and there are two such exits —
  // one of which needs nothing worse than an empty corpus to fire (#276). Query
  // order is the only ordering available on those paths: they are exactly the
  // paths where the frequencies that would rank the terms are missing.
  const terms = tokens.slice(0, KEYWORD_MAX_TOKENS);
  let timeWhere = "";
  const timeBindings: number[] = [];
  if (bounds.after !== undefined) {
    timeWhere += " AND created_at >= ?";
    timeBindings.push(bounds.after);
  }
  if (bounds.before !== undefined) {
    timeWhere += " AND created_at < ?";
    timeBindings.push(bounds.before);
  }
  // Scoped before ORDER BY so LIMIT ranks only readable rows, not readable rows
  // plus strangers' rows truncated by the window.
  const scope = identity ? scopeWhereForRead(identity, { layer: only, teamId }) : null;
  const scopeSql = scope ? ` AND ${scope.clause}` : "";
  // 局所評価が必要な長文だけ本文を返す。400文字は既存queryRelevantWindowの幅。
  // 候補窓・文数を変えず、離れた追記の単語を一つの根拠として数えない。
  const passage = lexical && terms.length > 1;
  const toRow = (raw: unknown): KeywordRow => {
    const value = raw as Record<string, unknown>;
    const row = rowWithLevels(value, terms);
    return passage && typeof value.content === "string" ? { ...row, content: value.content, hits: undefined } : row;
  };
  // `not` are terms whose rows are excluded (already read whole by an earlier window); `max` is the window's row cap.
  // The rows come back without their text: each carries, for every term, how the note holds it (see keyword-rows.ts).
  const validityBindings = asOf === undefined ? [now] : asOfPredicateBindings(asOf);
  const windowFor = (subset: string[], max: number, not: string[] = []) => {
    const where = subset.map(() => `content LIKE ? ${CONTENT_LIKE_ESCAPE}`).join(" OR ");
    const exclude = not.length ? ` AND NOT (${not.map(() => `content LIKE ? ${CONTENT_LIKE_ESCAPE}`).join(" OR ")})` : "";
    // Keep the alternatives as one predicate whenever an AND filter follows.
    // Without grouping, SQLite applies that filter only to the final LIKE term
    // because AND binds more tightly than OR. Leave the unfiltered SQL unchanged.
    const eligibilitySql = lexical?.answerOnly ? recallEligibilitySql(lexical.kind) : "";
    const tokenWhere = subset.length > 1 ? `(${where})` : where;
    // scope-checked: the caller's clause IS applied — scopeSql is built as ` AND ${scope.clause}` above and appended here; the lexer sees only the fragment name
    // validity: as-of: 指定時点ではasOfPredicateSql、通常検索ではvaliditySqlで現在の適格性を検査する。
    const inner = `SELECT id, created_at, tags, source, lower(content) AS lc${passage ? ", CASE WHEN length(content) > 400 THEN content END AS content" : ""} FROM entries WHERE ${tokenWhere}${timeWhere}${scopeSql} AND ${asOf === undefined ? "(valid_until IS NULL OR valid_until > ?)" : asOfPredicateSql()} AND ${NOT_HELD_SQL}${exclude}${eligibilitySql} ORDER BY created_at DESC LIMIT ?`;
    const levels = withMatchLevels(inner, ["id", "created_at", "tags", "source", ...(passage ? ["content"] : [])], terms, "created_at DESC");
    return env.DB.prepare(levels.sql)
      .bind(...subset.map(contentLikePattern), ...timeBindings, ...(scope?.bindings ?? []), ...validityBindings, ...not.map(contentLikePattern), max, ...levels.binds);
  };
  const split = splitLikeTerms(terms, corpus?.df, limit);
  if (!split) return ((await windowFor(terms, limit).all()).results ?? []).map(toRow);
  // The window would truncate. A row matching only common words must not push out one matching the rarest: those rows
  // are read whole (they fit the limit), then the newest rows for the remaining terms fill what is left. The rare rows
  // number at most their df sum, so the second window asks for no more than the slots that leaves, and skips the rows
  // the first already holds (they would only take those slots twice).
  const spent = split.rare.reduce((sum, t) => sum + (corpus?.df?.get(t) ?? 0), 0);
  const room = limit - spent;
  const [rare, rest] = room > 0
    ? await env.DB.batch([windowFor(split.rare, limit), windowFor(split.rest, room, split.rare)])
    : [await windowFor(split.rare, limit).all(), { results: [] as unknown[] }];
  const seen = new Set<string>();
  const out: KeywordRow[] = [];
  for (const row of [...(rare.results ?? []), ...(rest.results ?? [])].map(toRow)) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

async function keywordSearchFts(
  matches: string[],
  // matches[0] is the plan's AND tier: newest-first by FTS rowid with no bm25
  // sort, so its LIMIT stops the scan instead of scoring every co-occurring row
  // (see planFtsMatch).
  andTier: boolean,
  // Tokens too short for the index. They cannot retrieve, but they rank: rows
  // carrying them come first, so the word that makes the query specific ("io"
  // in "io scheduler") still decides which of the index's matches survive the
  // LIMIT. Evaluated on rows the MATCH already read, never a scan.
  shortTerms: string[],
  // Every term the query searches with (eligible or short): each row reports how it holds each one.
  terms: string[],
  env: Env,
  limit: number,
  bounds: Readonly<TimeBounds>,
  identity?: Identity,
  only?: "personal" | "company",
  teamId?: string,
  eligibilitySql = "",
  now: number = Date.now(),
  asOf?: number,
): Promise<KeywordRow[][]> {
  let timeWhere = "";
  const timeBindings: number[] = [];
  if (bounds.after !== undefined) { timeWhere += " AND e.created_at >= ?"; timeBindings.push(bounds.after); }
  if (bounds.before !== undefined) { timeWhere += " AND e.created_at < ?"; timeBindings.push(bounds.before); }
  const scope = identity ? scopeWhereForRead(identity, { layer: only, teamId }) : null;
  // workspace_id exists only on entries, not on entries_fts's id/content
  // columns, so the clause below resolves unambiguously though unqualified.
  const scopeSql = scope ? ` AND ${scope.clause}` : "";
  const shortHits = shortTerms.map(() => `(e.content LIKE ? ${CONTENT_LIKE_ESCAPE})`).join(" + ");
  const shortBindings = shortTerms.map(contentLikePattern);
  const validityBindings = asOf === undefined ? [now] : asOfPredicateBindings(asOf);
  // Rows come back without their text, with per-term match levels instead (keyword-rows.ts). `sh` and `rk` carry the ranking
  // (short-token hits, then bm25) so the outer SELECT keeps the order the LIMIT chose.
  // scope-checked: the caller's clause IS applied — scopeSql is built as ` AND ${scope.clause}` above and appended here; the lexer sees only the fragment name, and an allowlist on predicate position cannot see the leading AND inside it. Empty for an identity-less caller (pre-tenancy and unit fixtures), which is the pre-v3 whole-corpus keyword scan
  // validity: current: a superseded or ended row must not take a keyword pool slot from one that is still true (5.5); as-of (5.7 item 2) also lets through a belief the OR's second arm names, confirmed later by as-of.ts's belief batch
  const rankedInner = `SELECT e.id, e.created_at, e.tags, e.source, lower(e.content) AS lc, ${shortHits || "0"} AS sh, bm25(entries_fts) AS rk, entries_fts.rowid AS ord
       FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid AND e.id = entries_fts.id
       WHERE entries_fts MATCH ?${timeWhere}${scopeSql} AND ${asOf === undefined ? "(e.valid_until IS NULL OR e.valid_until > ?)" : asOfPredicateSql("e")} AND ${NOT_HELD_SQL}${eligibilitySql}
       ORDER BY sh DESC, rk, ord LIMIT ?`;
  // scope-checked: same clause, same reason as above
  // validity: current: same predicate as rankedInner above (5.5/5.7 item 2)
  const andTierInner = `SELECT e.id, e.created_at, e.tags, e.source, lower(e.content) AS lc, entries_fts.rowid AS ord
       FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid AND e.id = entries_fts.id
       WHERE entries_fts MATCH ?${timeWhere}${scopeSql} AND ${asOf === undefined ? "(e.valid_until IS NULL OR e.valid_until > ?)" : asOfPredicateSql("e")} AND ${NOT_HELD_SQL}${eligibilitySql}
       ORDER BY entries_fts.rowid DESC LIMIT ?`;
  const rankedLevels = withMatchLevels(rankedInner, ["id", "created_at", "tags", "source", "sh", "rk", "ord"], terms, "sh DESC, rk, ord", ["id", "created_at", "tags", "source"]);
  const andTierLevels = withMatchLevels(andTierInner, ["id", "created_at", "tags", "source", "ord"], terms, "ord DESC", ["id", "created_at", "tags", "source"]);
  // Join on rowid as well as id: rowids are unique, so a stale duplicate FTS
  // row for one id cannot fill two LIMIT slots, and a drifted row (an FTS id
  // at a rowid whose entries.id differs) maps to nothing instead of a wrong entry.
  //
  // Write-path isolation v2.2 INVARIANT: FTS is live only if entries_fts
  // exists AND all three sync triggers exist. A hot-path repair can drop a
  // trigger without ever touching KV, leaving a table that still answers
  // MATCH queries — successfully, no exception — but has silently stopped
  // syncing. The liveness check rides in the SAME env.DB.batch() as the FTS
  // queries (one subrequest, one extra statement) so that staleness is caught
  // structurally instead of relying on an error that never comes. Throwing
  // when not live reuses keywordSearch's existing catch-and-fall-back-to-LIKE
  // wiring below, rather than adding a second control path.
  const statementFor = (match: string, i: number, max: number) => andTier && i === 0
    ? env.DB.prepare(andTierLevels.sql).bind(match, ...timeBindings, ...(scope?.bindings ?? []), ...validityBindings, max, ...andTierLevels.binds)
    : env.DB.prepare(rankedLevels.sql).bind(...shortBindings, match, ...timeBindings, ...(scope?.bindings ?? []), ...validityBindings, max, ...rankedLevels.binds);
  const [livenessResult, ...firstTier] = await env.DB.batch([
    // scope-exempt: FTS_LIVENESS_SQL reads sqlite_master (schema catalogue),
    // never entries/edges rows — nothing here to scope by workspace.
    env.DB.prepare(FTS_LIVENESS_SQL),
    statementFor(matches[0], 0, limit),
  ]);
  if (!isFtsLiveRows(livenessResult.results as { name: string; sql: string | null }[] | undefined)) {
    throw new Error("entries_fts is not live (missing table, a sync trigger, or a trigger with an unexpected body)");
  }
  const asRows = (results: unknown) => ((results ?? []) as Record<string, unknown>[]).map(r => rowWithLevels(r, terms));
  const tiers = [asRows(firstTier[0].results)];
  // Later tiers only fill what the earlier ones leave under the limit (mergeTiers keeps a row's first tier and stops at
  // the limit), so each asks for that many rows: a tier that could not fit is not read at all.
  for (let i = 1; i < matches.length; i++) {
    const room = limit - new Set(tiers.flat().map(r => r.id)).size;
    if (room <= 0) break;
    // The AND tier came back short of its limit, so it holds every AND match: the OR tier excludes those in the index, or
    // overlap would spend its slots on rows already held and leave other matches unread.
    const match = andTier ? `(${matches[i]}) NOT (${matches[0]})` : matches[i];
    const [next] = await env.DB.batch([statementFor(match, i, room)]);
    tiers.push(asRows(next.results));
  }
  return tiers;
}

// Exported for the router tests (test/integration/keyword-router-bounded.test.ts); recallEntries is the only production caller.
export async function keywordSearch(
  tokens: string[],
  env: Env,
  limit: number,
  bounds: Readonly<TimeBounds> = {},
  identity?: Identity,
  only?: "personal" | "company",
  teamId?: string,
  corpus?: Pick<DistilledQuery, "df" | "total">,
  lexical?: { terms: readonly LexicalToken[]; priorityTerms?: readonly LexicalToken[]; previousRows?: readonly KeywordRow[]; kind?: MemoryKind; answerOnly?: boolean; forceLike?: boolean },
  now: number = Date.now(),
  asOf?: number,
): Promise<{ rows: KeywordRow[]; fts: boolean; route: RecallDiagnostics["ftsRoute"]; idfWindow?: number }> {
  const result = await keywordSearchRows(tokens, env, limit, bounds, identity, only, teamId, corpus, lexical, now, asOf);
  // Levels the SQL could not decide (non-ASCII terms, notes with U+212A or U+0130) are settled from the notes' text, for those rows only (keyword-rows.ts).
  await settleLevels(env, result.rows, tokens.slice(0, KEYWORD_MAX_TOKENS));
  // #103の単語一致順は返却行へ適用し、上流の最稀語窓と候補集合を保つ。
  if (!result.fts && lexical && result.rows.some(row => row.hits)) {
    const words = lexical.terms.filter(term => term.kind !== "cjk-bigram");
    const count = (row: KeywordRow) => words.filter(term => termLevel(row, term.value) > 0).length;
    result.rows.sort((a, b) => count(b) - count(a) || b.created_at - a.created_at);
  }
  return result;
}

async function keywordSearchRows(
  tokens: string[],
  env: Env,
  limit: number,
  bounds: Readonly<TimeBounds> = {},
  identity?: Identity,
  only?: "personal" | "company",
  teamId?: string,
  // The corpus document frequencies distillToRareTerms already computed.
  // Absent (or null) on every path that skipped or lost that scan, in which
  // case the cost estimate below cannot run and routing keeps today's rules.
  corpus?: Pick<DistilledQuery, "df" | "total">,
  lexical?: { terms: readonly LexicalToken[]; priorityTerms?: readonly LexicalToken[]; previousRows?: readonly KeywordRow[]; kind?: MemoryKind; answerOnly?: boolean; forceLike?: boolean },
  now: number = Date.now(),
  asOf?: number,
): Promise<{ rows: KeywordRow[]; fts: boolean; route: RecallDiagnostics["ftsRoute"]; idfWindow?: number }> {
  if (!tokens.length) return { rows: [], fts: false, route: "like-ineligible-token" };
  const terms = tokens.slice(0, KEYWORD_MAX_TOKENS);
  // ftsEligibleToken is the single source of truth for what the index can
  // match. A token that is only too short (T-0074) no longer sends the whole
  // query to the recency-window LIKE scan: the index serves the eligible
  // tokens and the short ones are weighed in fusion over the rows it returns.
  // A query with no eligible token, or one carrying a NUL token, still goes
  // to LIKE, which is the only arm that can match them.
  const compatibility = lexical?.forceLike || lexical?.previousRows || lexical?.terms.some(t => t.kind === "cjk-bigram" || t.probes.length > 1);
  const eligible = terms.filter(ftsEligibleToken);
  if (!compatibility && eligible.length && terms.every(t => ftsEligibleToken(t) || ftsShortToken(t))) {
    // Cost-aware routing (T-0058, T-0073): when distillation's frequency scan
    // covers every eligible term, its df sum estimates how many rows bm25 would
    // have to score. Past the budget the plan is bounded (planFtsMatch) instead
    // of falling to the newest-500 LIKE window, which cannot see an old memory
    // that matches only on common words. Any term the scan lacks (cap-bound)
    // keeps the full OR, as does every single-word query: the distill shortcut
    // computes no df for one-word inputs.
    const plan = planFtsMatch(eligible, corpus?.df, limit);
    if (!plan) {
      return { rows: await keywordSearchLike(tokens, env, limit, bounds, identity, only, teamId, corpus, lexical, now, asOf), fts: false, route: "like-match-budget" };
    }
    if (await ftsReady(env)) {
      try {
        const tiers = await keywordSearchFts(plan.matches, plan.andTier, terms.filter(ftsShortToken), terms, env, limit, bounds, identity, only, teamId, lexical?.answerOnly ? recallEligibilitySql(lexical.kind) : "", now, asOf);
        const rows = tiers.length === 1 ? tiers[0] : mergeTiers(tiers, limit);
        // A bounded plan that found nothing has not proven the tokens absent:
        // the recency window is the pre-bounded answer, so keep it as the floor.
        if (plan.bounded && !rows.length) {
          return { rows: await keywordSearchLike(tokens, env, limit, bounds, identity, only, teamId, corpus, lexical, now, asOf), fts: false, route: "like-match-budget" };
        }
        // Without corpus df, fusion estimates IDF from the fetched rows, whose
        // count is the denominator. LIKE always returned a full recency window
        // there; the index returns only the matches, so a query that used to be
        // LIKE-served because of a short token would weigh its keyword arm a
        // fraction of what it did. Pricing it against the window LIKE would have
        // filled keeps those weights where they were.
        const idfWindow = !corpus?.df && eligible.length < terms.length ? limit : undefined;
        return { rows, fts: true, route: plan.bounded ? "fts-bounded" : "fts", idfWindow };
      } catch (e) {
        console.error("FTS keyword search failed (degrading to LIKE):", e);
        return { rows: await keywordSearchLike(tokens, env, limit, bounds, identity, only, teamId, corpus, lexical, now, asOf), fts: false, route: "like-error" };
      }
    }
    return { rows: await keywordSearchLike(tokens, env, limit, bounds, identity, only, teamId, corpus, lexical, now, asOf), fts: false, route: "like-not-ready" };
  }
  return { rows: await keywordSearchLike(tokens, env, limit, bounds, identity, only, teamId, corpus, lexical, now, asOf), fts: false, route: "like-ineligible-token" };
}

// Tiers arrive in priority order (the AND tier newest-first, the OR tier by
// bm25); a row keeps its first, highest-priority position.
function mergeTiers(tiers: KeywordRow[][], limit: number): KeywordRow[] {
  const seen = new Set<string>();
  const out: KeywordRow[] = [];
  for (const row of tiers.flat()) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

// A keyword row read by the tag path carries its text; one read by the keyword arm carries per-term match levels instead
// (keyword-rows.ts). Either way `termLevel` answers how a note holds a term: 0 not at all, 1 only inside longer words, 2 as a word
// of its own (a token found at a word boundary earns full IDF; found only inside a longer word, "cat" in "concatenate", a fraction).
// Lookarounds rather than \b so identifier-shaped tokens ("#149", "v1.9") keep matching, \b treats their punctuation as the boundary.
// Text is lowercased once per row, not once per view and per term: notes can be tens of KB.
const lowerCache = new WeakMap<object, string>();
const lowerContent = (row: { content?: string }): string => {
  let lc = lowerCache.get(row);
  if (lc === undefined) lowerCache.set(row, lc = (row.content ?? "").toLowerCase());
  return lc;
};
function termLevel(row: KeywordRow, term: string): 0 | 1 | 2 {
  const known = row.hits?.get(term);
  if (known !== undefined) return known;
  return levelInLower(lowerContent(row), term.toLowerCase());
}


const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CJK_CONTEXT = "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]";
const CJK_TOKEN = new RegExp(CJK_CONTEXT, "u");
const UNICODE_WORD_CONTEXT = "[\\p{L}\\p{N}_]";

export function fuseDenseAndKeyword(
  denseMatches: VectorizeMatch[],
  keywordRows: KeywordRow[],
  input: readonly string[] | readonly LexicalToken[],
  allowKeywordOnly: boolean,
  corpus: Pick<DistilledQuery, "df" | "total">,
  substringWeight: number,
  keywordPreRanked = false,
  idfWindow = 0,
  // Explain only: filled with each matched row's per-term level and idf, computed here already.
  keywordTrace?: Map<string, KeywordTermTrace[]>,
  normalizeKeywordArm = false,
): VectorizeMatch[] {
  const terms: readonly LexicalToken[] = input.map(t => typeof t === "string" ? { value: t, kind: "word", probes: [t] } : t);
  const tokens = terms.map(term => term.value);
  const denseByParent = new Map<string, VectorizeMatch>();
  for (const m of [...denseMatches].sort((a, b) => b.score - a.score)) {
    const pid = ((m.metadata as any)?.parentId ?? m.id) as string;
    if (!denseByParent.has(pid)) denseByParent.set(pid, m);
  }
  const denseRanked = [...denseByParent.keys()];

  // Score one query-relevant passage, not the union of terms accumulated over
  // an append-grown entry's whole history. This keeps a focused memory ahead
  // of a broad history that mentions the same terms in unrelated updates,
  // while a coherent passage inside a long memory still receives full credit.
  const kwLower = keywordRows.map(r => ({
    row: r,
    // queryRelevantWindow preserves the stored surface; normalize the selected
    // evidence only for scoring.
    lc: queryRelevantWindow(lowerContent(r), tokens).normalize("NFKC"),
  }));

  // Matched against lowercased content, so lowercased here too. Canonical
  // tokens already are; raw-surface probes (#326) arrive as typed.
  const needle = new Map(tokens.map(t => [t, t.toLowerCase()]));

  // IDF from the corpus-wide frequencies distillToRareTerms already computed,
  // when they cover every token; otherwise the old estimate from the fetched
  // rows. All-or-nothing rather than per-token, because the two denominators
  // (corpus size vs fetch-window size) are different scales — mixing them in
  // one weight sum would let the source of a token's IDF, not its rarity,
  // decide the ranking.
  let idf: (t: string) => number;
  if (corpus.df && corpus.total && tokens.every(t => corpus.df!.has(t))) {
    const { df, total } = corpus;
    idf = t => Math.log(1 + total / ((df.get(t) ?? 0) + 1));
  } else {
    const kwN = Math.max(kwLower.length, idfWindow) || 1;
    const kwDf = new Map(tokens.map(t => [t, kwLower.reduce((n, x) => n + Number(x.row.hits ? (x.row.hits.get(t) ?? 0) > 0 : x.lc.includes(needle.get(t)!)), 0)]));
    idf = t => Math.log(1 + kwN / ((kwDf.get(t) ?? 0) + 1));
  }

  // A token found at a word boundary earns full IDF; found only inside a longer
  // word ("cat" in "concatenate") it earns a configured fraction. Lookarounds
  // rather than \b so identifier-shaped tokens ("#149", "v1.9") keep matching —
  // \b treats their punctuation as the boundary itself.
  const boundary = new Map(terms.map(term => [
    term.value,
    new RegExp(
      `(?<!${term.kind === "cjk-bigram" ? CJK_CONTEXT : UNICODE_WORD_CONTEXT})${escapeRegExp(term.value)}(?!${term.kind === "cjk-bigram" ? CJK_CONTEXT : UNICODE_WORD_CONTEXT})`,
      "u",
    ),
  ]));
  const isFullTokenMatch = (lc: string, term: LexicalToken) => lc.includes(term.value)
    && ((term.kind !== "cjk-bigram" && CJK_TOKEN.test(term.value)) || boundary.get(term.value)!.test(lc));
  // 未索引救済と構造付き識別子の重み付けで、日本語との文字種境界を共有する。
  // 一般語の重み付けと、Cedarwood / preSB-024post 等の部分一致は変えない。
  const japaneseContext = "[\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Han}]";
  const pendingIdentifierBoundary = new Map(terms
    .filter(term => /^[a-z0-9_#.@:/+\-]+$/i.test(term.value))
    .map(term => [term.value, new RegExp(
      `(?:(?<!${UNICODE_WORD_CONTEXT})|(?<=${japaneseContext}))${escapeRegExp(term.value)}(?:(?!${UNICODE_WORD_CONTEXT})|(?=${japaneseContext}))`,
      "u",
    )]));
  const tokenWeight = (lc: string, term: LexicalToken) => {
    const t = term.value;
    if (!lc.includes(t)) return 0;
    // Intl.Segmenter words are trusted even when Japanese particles touch them
    // in stored prose. Only fallback bigrams require an isolated CJK boundary;
    // inside a longer run they remain useful rescue evidence at substring weight.
    // 構造付き識別子は日本語の助詞に接しても一語として扱う。
    // 上流のASCII境界に近づけつつ、一般語とラテン文字内の部分一致は保護する。
    const identifierMatch = term.kind === "protected" && /[\d@#./:_-]/u.test(t)
      && pendingIdentifierBoundary.get(t)?.test(lc);
    return isFullTokenMatch(lc, term) || identifierMatch ? idf(t) : idf(t) * substringWeight;
  };

  const keywordRanked = kwLower
    .map(x => ({ row: x.row, lc: x.lc, weight: terms.reduce((s, term) => s + (x.row.hits ? ((x.row.hits.get(term.value) ?? 0) === 0 ? 0 : idf(term.value) * (x.row.hits.get(term.value) === 2 ? 1 : substringWeight)) : tokenWeight(x.lc, term)), 0) }))
    .filter(x => x.weight > 0 && (allowKeywordOnly || denseByParent.has(x.row.id)
      // AIだけが復旧した場合も、未索引の記憶の明確な一致を失わない。
      // 索引済みのsemantic-only選択と、弱い部分一致の扱いは維持する。
      || (x.row.vector_ids === "[]"
        && terms.every(term => isFullTokenMatch(x.lc, term)
          || pendingIdentifierBoundary.get(term.value)?.test(x.lc)))))
    .sort((a, b) => b.weight - a.weight
      || (keywordPreRanked ? 0 : b.row.created_at - a.row.created_at || (a.row.id < b.row.id ? -1 : 1)));
  const keywordWeightById = new Map(keywordRanked.map(item => [item.row.id, item.weight]));

  if (keywordTrace) {
    for (const { row } of keywordRanked) {
      const terms: KeywordTermTrace[] = [];
      for (const t of tokens) {
        const level = termLevel(row, t);
        if (level !== 0) terms.push({ term: t, level, idf: idf(t) });
      }
      keywordTrace.set(row.id, terms);
    }
  }

  // IDF sum is useful for ordering lexical candidates, but it is not calibrated
  // to the dense arm: three rare generic terms otherwise act like three separate
  // RRF votes and can overturn a strong semantic rank 1. Once the dense score is
  // above the existing recall calibration threshold, cap the keyword arm at one
  // vote while preserving its internal IDF ordering. Weak/unavailable semantic
  // retrieval deliberately keeps the full lexical rescue strength.
  const strongestKeywordWeight = normalizeKeywordArm
    ? keywordRanked.reduce((max, item) => Math.max(max, item.weight), 0)
    : 0;
  const keywordFusionRows = keywordRanked.map(item => ({
    id: item.row.id,
    weight: normalizeKeywordArm && strongestKeywordWeight > 0
      ? item.weight / strongestKeywordWeight
      : item.weight,
  }));
  const fused = rrfFuse(denseRanked, keywordFusionRows);
  const keywordRowById = new Map(keywordRows.map(r => [r.id, r]));

  const out: VectorizeMatch[] = [];
  for (const [pid, score] of fused) {
    const dm = denseByParent.get(pid);
    if (dm) {
      out.push({
        id: dm.id,
        score,
        metadata: { ...dm.metadata, keywordSupported: keywordWeightById.has(pid) },
        values: dm.values,
      });
    } else {
      const r = keywordRowById.get(pid)!;
      out.push({ id: pid, score, metadata: { parentId: pid, created_at: r.created_at, tags: JSON.parse(r.tags ?? "[]"), content: r.content, source: r.source } });
    }
  }
  return out;
}

const ROLLOVER_LINEAGE_MAX_DEPTH = 32;

interface RolloverCollapseView {
  direct: Set<string>;
  graph: Set<string>;
  promotedDirect: Set<string>;
  fallbackUsed: boolean;
}

const emptyRolloverCollapseView = (): RolloverCollapseView => ({
  direct: new Set(),
  graph: new Set(),
  promotedDirect: new Set(),
  fallbackUsed: false,
});

/**
 * Collapse an old rollover journal only when a readable continuation competes
 * with it for an ordinary/current-state result slot.
 *
 * The lineage edge, rather than the generic cold tier or `rolled-up` tag, is
 * the authority: cold is also a valid manual retention choice, and rollover
 * sources created before/without nightly compression need not carry that tag.
 * Causal and chronology searches keep the journal as direct evidence. An exact
 * source ID in the query does too, so operators can always retrieve the old row.
 */
async function rolloverJournalIdsToCollapse(
  directMatches: readonly VectorizeMatch[],
  graphMatches: readonly VectorizeMatch[],
  eligibleMemoryTiers: ReadonlyMap<string, string | null>,
  intent: RecallIntent,
  semanticQuery: string,
  env: Env,
): Promise<RolloverCollapseView> {
  if (intent === "causal" || intent === "chronology") return emptyRolloverCollapseView();

  const directCandidateIds = new Set<string>();
  const graphCandidateIds = new Set<string>();
  const coldIds: string[] = [];
  const seenCold = new Set<string>();
  const normalizedQuery = semanticQuery.normalize("NFKC").toLowerCase();
  const addCandidate = (match: VectorizeMatch, direct: boolean) => {
    const parentId = ((match.metadata as any)?.parentId ?? match.id) as string;
    // This map is populated only by the scoped D1 hydration for rows that also
    // pass the final status/kind/tag/time filters. An unreadable, deprecated or
    // out-of-window dense hit can therefore never hide a valid journal.
    if (!eligibleMemoryTiers.has(parentId)) return;
    if (direct) directCandidateIds.add(parentId);
    graphCandidateIds.add(parentId);
    if (eligibleMemoryTiers.get(parentId) !== "cold"
      || seenCold.has(parentId)
      || normalizedQuery.includes(parentId.normalize("NFKC").toLowerCase())) return;
    seenCold.add(parentId);
    // One bounded, index-backed D1 statement. Higher-ranked cold candidates
    // are the only ones that can displace a top-K continuation in practice.
    if (coldIds.length < D1_MAX_BOUND_PARAMS) coldIds.push(parentId);
  };
  directMatches.forEach(match => addCandidate(match, true));
  graphMatches.forEach(match => addCandidate(match, false));
  if (!coldIds.length) return emptyRolloverCollapseView();

  const placeholders = coldIds.map(() => "?").join(", ");
  try {
    const { results } = await env.DB.prepare(
      // scope-exempt: every target ID came from the scoped candidate hydration;
      // a returned continuation is acted on only if that ID is also in the same
      // scoped candidate set. No content or metadata from another entry leaves
      // this lookup.
      `WITH RECURSIVE rollover_lineage(continuation_id, journal_id, depth) AS (
         SELECT source_id, target_id, 1
           FROM edges
          WHERE target_id IN (${placeholders})
            AND type = 'drawn_from'
            AND provenance = 'system'
            AND json_valid(metadata)
            AND json_extract(metadata, '$.rollover.version') = 1
         UNION ALL
         SELECT edge.source_id, lineage.journal_id, lineage.depth + 1
           FROM edges edge
           JOIN rollover_lineage lineage ON edge.target_id = lineage.continuation_id
          WHERE lineage.depth < ${ROLLOVER_LINEAGE_MAX_DEPTH}
            AND edge.type = 'drawn_from'
            AND edge.provenance = 'system'
            AND json_valid(edge.metadata)
            AND json_extract(edge.metadata, '$.rollover.version') = 1
       )
       SELECT continuation_id, journal_id FROM rollover_lineage`,
    ).bind(...coldIds).all() as {
      results: { continuation_id: string; journal_id: string }[];
    };

    const direct = new Set<string>();
    const graph = new Set<string>();
    const promotedDirect = new Set<string>();
    for (const row of results) {
      if (row.continuation_id === row.journal_id) continue;
      if (directCandidateIds.has(row.journal_id) && graphCandidateIds.has(row.continuation_id)) {
        direct.add(row.journal_id);
        if (!directCandidateIds.has(row.continuation_id)) promotedDirect.add(row.continuation_id);
      }
      if (graphCandidateIds.has(row.journal_id) && graphCandidateIds.has(row.continuation_id)) {
        graph.add(row.journal_id);
      }
    }
    return { direct, graph, promotedDirect, fallbackUsed: false };
  } catch (error) {
    // Ranking lineage is advisory. An old schema or transient D1 read failure
    // must degrade to the existing ranking rather than fail the entire recall.
    logErrorEvent("recall_lineage_fallback", {
      operation: "recall",
      outcome: "degraded",
      error_name: errorName(error),
    });
    return { ...emptyRolloverCollapseView(), fallbackUsed: true };
  }
}

async function runRecallEntries(
  params: RecallParams,
  env: Env,
  ctx: ExecutionContext,
  // Resolved once at request entry by the route/MCP caller and threaded down.
  // Optional so this stays callable without a config in tests and any future
  // internal caller; the fallback costs one KV read.
  config?: Readonly<Config>,
  internal: RecallInternalOptions = {},
): Promise<RecallSearchResult> {
  const totalStartedAt = performance.now();
  let stageStartedAt = totalStartedAt;
  const markStage = (stage: RecallStage) => {
    if (internal.diagnostics) {
      internal.diagnostics.stageMs ??= {};
      internal.diagnostics.stageMs[stage] = performance.now() - stageStartedAt;
    }
    stageStartedAt = performance.now();
  };
  if (internal.diagnostics) env = observeRecallEnv(env, internal.diagnostics);
  const cfg = config ?? await resolveConfig(env);
  const { query, topK } = params;
  const synthesize = params.synthesize ?? true;
  // Off: nothing below records or attaches a trace, so results are what they were before explain existed.
  const explain = params.explain === true;
  let { tag, after, before, kind } = params;
  // A project narrows exactly like a tag: candidates come from the members first (the tag
  // or any alias), and the same OR group is re-applied at hydration and in the JS re-check.
  const projectFilter = params.project?.length ? projectFilterSql(params.project) : null;
  const projectTags = projectMemberTags(params.project ?? []);
  const memberFirst = Boolean(tag) || projectFilter !== null;
  // Off unless NOTICE_COLLAPSE is on, and off for this one call when the query
  // or tag names its own source (a source word, a mirror-written tag, or an
  // enumerating query): a deliberate "show all my emails" must not be thinned (4.4).
  const collapseActive = cfg.NOTICE_COLLAPSE === "on" && !collapseLift(query, tag);
  // Off at share 1.0, and off for this one call when the query or tag names
  // its own source. A `project` filter never lifts it (P3, Q-C): every
  // session-start hook passes project on every recall, so a lift there would
  // switch the defence off exactly where it runs most.
  const capActive = cfg.MIRROR_MAX_SHARE < 1.0 && !liftFor(query, tag);
  const lookaheadActive = collapseActive || capActive;
  const hops = Math.max(0, Math.min(cfg.GRAPH_MAX_HOPS, params.hops ?? cfg.DEFAULT_HOPS));
  const graphContribution: RecallGraphContribution = {
    requestedHops: hops,
    seedCount: 0,
    expandedCount: 0,
    eligibleCount: 0,
    selectedCount: 0,
  };
  const now = Date.now();
  const identity = internal.identity;
  const scope = identity
    ? scopeWhereForRead(identity, { layer: internal.workspaceFilter, teamId: internal.teamId })
    : null;
  let semanticUnavailable = false;
  let lineageFallbackUsed = false;
  let querySignalCacheHit = false;
  let semanticUnavailableReason: RecallSearchResult["semanticUnavailableReason"];
  let semanticRetryAt: number | undefined;
  const markSemanticUnavailable = (
    reason: NonNullable<RecallSearchResult["semanticUnavailableReason"]>,
    retryAt?: number,
  ) => {
    semanticUnavailable = true;
    // A quota failure is more actionable than the secondary Vectorize absence
    // it causes, so later fallback stages must not overwrite it.
    if (!semanticUnavailableReason || reason === "workers_ai_quota_exhausted") {
      semanticUnavailableReason = reason;
      semanticRetryAt = retryAt;
    }
  };
  const semanticState = () => ({
    semanticUnavailable,
    semanticUnavailableReason,
    semanticRetryAt,
    querySignalCacheHit,
    lineageFallbackUsed,
  });
  const requestedArms = internal.variant?.arms;
  if (requestedArms !== undefined && requestedArms !== "both" && requestedArms !== "dense-only" && requestedArms !== "keyword-only") {
    throw new Error(`Unknown recall variant arms: ${String(requestedArms)}`);
  }
  const arms = memberFirst ? "both" : requestedArms ?? "both";
  // As-of (spec 14 5.7 item 1): treated exactly like an explicit after/before, so phrase parsing is skipped.
  const asOf = internal.asOf;

  // Standing (spec 15 2.8): started here so its KV read overlaps distillation's D1 scan. An as-of
  // recall answers what was true then, not what applies now, so it never fires standing.
  const standingWorkspaceIds = identity ? readScopeWorkspaces(identity, { layer: internal.workspaceFilter, teamId: internal.teamId }) : [""];
  const standingCachesPromise = asOf === undefined
    ? readStandingCaches(env, ctx, cfg, standingWorkspaceIds, now)
    : Promise.resolve([]);

  let semanticQuery = query;
  if (after === undefined && before === undefined && asOf === undefined) {
    const parsed = parseTimePhrase(query, now, cfg.TIMEZONE);
    after = parsed.after;
    before = parsed.before;
    semanticQuery = parsed.cleanQuery;
  }
  const bounds = { after, before };
  const distilled = await distillToRareTerms(
    semanticQuery,
    env,
    cfg,
    bounds,
    identity,
    internal.workspaceFilter,
    internal.teamId,
  );
  const profile = buildQueryProfile(semanticQuery, distilled);
  if (internal.diagnostics) internal.diagnostics.distillSource = distilled.distillSource;
  const embeddingQueryMode = internal.embeddingQueryMode ?? DEFAULT_EMBEDDING_QUERY_MODE;
  const denseInput = embeddingInput(profile, embeddingQueryMode);
  const lexicalQuery = profile.lexicalQuery;
  if (internal.diagnostics) {
    internal.diagnostics.embeddingMode = embeddingQueryMode;
    // #326 visibility: an empty keywordIds used to be indistinguishable from
    // "the lexical arm never ran".
    internal.diagnostics.retrievalTokenCount = profile.retrievalTokens.length;
    internal.diagnostics.lexicalArmSkipped = profile.retrievalTokens.length === 0;
    internal.diagnostics.corpusIdfUsed = !!distilled.df && !!distilled.total
      && profile.lexicalTokens.every(t => distilled.df!.has(t));
  }
  markStage("setup");

  const tokens = profile.lexicalTokens;
  const standingCaches = await standingCachesPromise;
  const standingHasItems = arms !== "keyword-only" && standingCaches.some(c => c.items.length > 0);
  let standingVector: number[] | undefined;
  const cacheInput = {
    denseInput,
    lexicalQuery,
    tag,
    embeddingMode: embeddingQueryMode,
    scopeKey: identity
      ? JSON.stringify({
          personal: identity.personalWorkspaceId,
          companies: [...identity.companyWorkspaceIds].sort(),
          only: internal.workspaceFilter ?? null,
          team: internal.teamId ?? null,
        })
      : undefined,
  };
  const [embeddingSignal, queryTags] = await Promise.all([
    (async () => {
      if (arms === "keyword-only") return { ok: true as const, values: [] as number[] };
      const cachedSignals = await readQuerySignalCache(cacheInput, env, cfg);
      querySignalCacheHit = cachedSignals !== null;
      if (cachedSignals && !standingHasItems) return { ok: true as const, values: cachedSignals.values };

      // cache miss時だけquota markerを確認し、成功しないAI呼出しを短絡する。
      const aiHealth = await readWorkersAiHealth(env);
      if (aiHealth.ok === false) {
        return { ok: false as const, error: new WorkersAiQuotaError(aiHealth.resetAt) };
      }
      try {
        const needsStandingEmbed = standingHasItems && profile.semanticQuery !== denseInput;
        const vectors = needsStandingEmbed
          ? await embedMany([denseInput, profile.semanticQuery], env, cfg)
          : [await embedQuery(denseInput, env, cfg)];
        const values = vectors[0];
        standingVector = standingHasItems ? (vectors[1] ?? values) : undefined;
        ctx.waitUntil(writeQuerySignalCache(cacheInput, { values, queryTags: [] }, env, cfg));
        return { ok: true as const, values };
      } catch (error) {
        if (error instanceof EmbeddingProfileMismatchError) throw error;
        return { ok: false as const, error };
      }
    })(),
    // 旧cacheの推論tagは順位に使わず、毎回上流のliteral／既知tag判定を行う。
    tag
      ? Promise.resolve([tag.trim().toLowerCase()])
      : inferQueryTags(
          lexicalQuery, env, ctx, identity, internal.workspaceFilter, internal.teamId,
        ),
  ]);
  const values = embeddingSignal.ok ? embeddingSignal.values : null;
  if (!embeddingSignal.ok) {
    if (embeddingSignal.error instanceof WorkersAiQuotaError) {
      markSemanticUnavailable("workers_ai_quota_exhausted", embeddingSignal.error.retryAt);
    } else {
      markSemanticUnavailable("embedding_unavailable");
    }
    console.error("Query embedding failed (degrading to keyword-only):", embeddingSignal.error);
  }
  markStage("querySignals");

  // Pure candidate selection (spec 15 2.7): cheap, so computed unconditionally once a vector
  // exists. Whether it is actually used to fire is gated at each hydration site below by the
  // recall's own semanticUnavailable, which is not yet known this early in every arm.
  const standingProject = params.project?.length
    ? { slug: params.project[0].id, aliases: params.project.flatMap(p => p.aliases) }
    : undefined;
  const standingCandidates = standingVector
    ? selectStandingFires(standingVector, standingCaches, { threshold: cfg.STANDING_THRESHOLD, maxFires: STANDING_MAX_FIRES, project: standingProject })
    : [];

  /** Hydrated fresh from D1 (never from KV), so a stopped/forgotten/deprecated/moved/held row can never render (spec 15 2.9/2.10). */
  async function standingFiresFrom(rows: Record<string, any>[]): Promise<StandingFire[]> {
    if (!rows.length) return [];
    const scoreById = new Map(standingCandidates.map(c => [c.id, c.score]));
    const actorIds = [...new Set(rows.map(r => r.actor_id as string).filter(id => id && id !== identity?.userId))];
    const labelMap = actorIds.length ? await lookupActorLabels(env, actorIds) : new Map<string, string>();
    return rows
      .map(r => {
        const tags = JSON.parse(r.tags ?? "[]") as string[];
        const projectTag = tags.find(t => t.startsWith("project:"));
        return {
          id: r.id as string,
          content: r.content as string,
          createdAt: r.created_at as number,
          workspace: layerOf(identity, r.workspace_id),
          actorName: r.actor_id && r.actor_id !== identity?.userId
            ? resolveActorLabel(r.actor_id as string, labelMap, { viewerId: identity?.userId })
            : undefined,
          project: projectTag ? projectTag.slice("project:".length) : null,
          score: scoreById.get(r.id as string) ?? 0,
          ...(explain ? { why: `standing: similarity ${(scoreById.get(r.id as string) ?? 0).toFixed(2)} >= ${cfg.STANDING_THRESHOLD.toFixed(2)}` } : {}),
        } satisfies StandingFire;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, STANDING_MAX_FIRES);
  }

  /** The standalone arm (spec 15 2.8 step 5): one extra statement, run only when there is a candidate to hydrate. */
  async function fetchStandingFires(): Promise<StandingFire[]> {
    if (semanticUnavailable || !standingCandidates.length) return [];
    const placeholders = standingCandidates.map(() => "?").join(", ");
    const standingScopeSql = scope ? ` AND ${scopeWhereForIdRead(scope).clause}` : "";
    // validity: current: currentValidityAt re-checks what the cache build already filtered, because the cache can be up to 24h stale (spec 15 2.4/2.6)
    const { results } = await env.DB.prepare(
      `SELECT id, content, tags, created_at, workspace_id, actor_id FROM entries
        WHERE id IN (${placeholders}) AND tags LIKE '%"standing:active"%'
          AND tags NOT LIKE '%"status:deprecated"%' AND ${NOT_HELD_SQL} AND ${currentValidityAt("", "?")}${standingScopeSql}`
    ).bind(...standingCandidates.map(c => c.id), now, ...(scope?.bindings ?? [])).all() as { results: Record<string, any>[] };
    return standingFiresFrom(results);
  }

  /** No hydration will run on this path: the standing arm, if any candidate survives, is the only extra statement (spec 15 2.8 step 5). */
  async function noResultsWithStanding(): Promise<RecallSearchResult> {
    const standing = await fetchStandingFires();
    // No recall_log row is written on this path (maybeLogRecall never runs here), so the
    // receipt is always the hash, whatever RECALL_LOG is set to (Part C, 05-proof.md).
    return { matches: [], insight: "", ...semanticState(), graphContribution, receipt: receiptHash(query, now), ...(standing.length ? { standing } : {}) };
  }

  let keywordRows: KeywordRow[] = [];
  let keywordIdfWindow = 0;
  let ftsServedKeywords = false; // memberFirst never sets this: tag rows are not bm25-ordered
  let results: { matches: VectorizeMatch[] };
  // Deeper dense results, fetched only when the diversified list is shorter than topK (see the fill below).
  let denseFill: (() => Promise<VectorizeMatch[]>) | undefined;
  if (memberFirst) {
    ftsServedKeywords = false;
    if (internal.diagnostics) internal.diagnostics.ftsRoute = "like-member-first";
    // Escaped: a tag is user data and LIKE reads _ and % as wildcards. This is a read, so
    // the failure is over-broad results rather than the permanent rollup the same bug
    // caused in compressTag — but `?tag=%` silently defeats the filter entirely and
    // returns the whole brain, which is not a recoverable-looking answer either.
    const tagScopeSql = scope ? ` AND ${scope.clause}` : "";
    const memberConds: string[] = [];
    const memberBindings: string[] = [];
    if (tag) { memberConds.push(`tags LIKE ? ${TAG_LIKE_ESCAPE}`); memberBindings.push(tagLikePattern(tag)); }
    if (projectFilter) { memberConds.push(projectFilter.clause); memberBindings.push(...projectFilter.bindings); }
    // hops>0では期間外・別kindの中継点も維持する。新着LIMITは追加しない。
    let tagEligibilitySql = hops === 0 && asOf === undefined ? recallEligibilitySql(kind) : "";
    const tagTimeBindings: number[] = [];
    if (hops === 0 && after !== undefined) { tagEligibilitySql += " AND created_at >= ?"; tagTimeBindings.push(after); }
    if (hops === 0 && before !== undefined) { tagEligibilitySql += " AND created_at < ?"; tagTimeBindings.push(before); }
    // scope-checked: the caller's clause IS applied — tagScopeSql is built as ` AND ${scope.clause}` above and appended here; the lexer sees only the fragment name, and an allowlist on predicate position cannot see the leading AND inside it. Empty for an identity-less caller (pre-tenancy and unit fixtures), which is the pre-v3 whole-corpus tag scan
    const { results: tagRows } = await env.DB.prepare(
      // validity: any: project・タグの起点収集。最終hydrationのd1Filtersが現在の適格性を検査する。
      `SELECT id, vector_ids, content, tags, source, created_at FROM entries WHERE ${memberConds.join(" AND ")}${tagScopeSql}${tagEligibilitySql} AND ${NOT_HELD_SQL}`
    ).bind(...memberBindings, ...(scope?.bindings ?? []), ...tagTimeBindings).all();
    if (!tagRows.length) {
      if (internal.diagnostics) { internal.diagnostics.ftsUsed = false; internal.diagnostics.keywordIds = []; }
      return await noResultsWithStanding();
    }
    keywordRows = tagRows as unknown as KeywordRow[];

    const vectorIds = [...new Set(
      (tagRows as any[]).flatMap(r => JSON.parse((r.vector_ids as string) ?? "[]") as string[])
    )];

    const vectors: VectorizeVector[] = [];
    let getByIdsFailed = false;
    let getByIdsIncomplete = false;
    let filteredFallbackSucceeded = false;
    if (values && vectorIds.length) {
      try {
        for (let i = 0; i < vectorIds.length; i += VECTORIZE_GET_BY_IDS_BATCH) {
          vectors.push(...await env.VECTORIZE.getByIds(vectorIds.slice(i, i + VECTORIZE_GET_BY_IDS_BATCH)));
        }
        assertVectorProfiles(vectors);
        getByIdsIncomplete = vectors.length < vectorIds.length;
      } catch (e) {
        if (e instanceof EmbeddingProfileMismatchError) throw e;
        getByIdsFailed = true;
        console.error("Vectorize getByIds failed (trying filtered query fallback):", e);
      }

      // Vectorize can list a freshly processed vector while getByIds still returns an
      // empty array. Querying the already-indexed parentId metadata is an independent
      // retrieval path and preserves semantic tag recall during that failure mode.
      // `parentId` must have a string metadata index created before vectors are
      // upserted (see `npm run vectors:index-parent`). The compact batches also keep
      // the Vectorize filter below its 2,048-byte limit for UUID-sized IDs.
      if (getByIdsFailed || getByIdsIncomplete) {
        const parentIds = [...new Set((tagRows as any[])
          .filter(row => JSON.parse((row.vector_ids as string) ?? "[]").length > 0)
          .map(row => row.id as string))];
        try {
          const filteredVectors: VectorizeVector[] = [];
          for (let i = 0; i < parentIds.length; i += VECTORIZE_GET_BY_IDS_BATCH) {
            const batch = parentIds.slice(i, i + VECTORIZE_GET_BY_IDS_BATCH);
            const response = await env.VECTORIZE.query(values, {
              topK: VECTORIZE_WIDEN_MAX_CANDIDATES,
              filter: { parentId: { $in: batch } },
              returnMetadata: "all",
              returnValues: true,
            });
            filteredVectors.push(...response.matches.map(match => ({
              id: match.id,
              values: match.values as number[],
              metadata: match.metadata,
            })));
          }
          assertVectorProfiles(filteredVectors);
          if (filteredVectors.length) {
            vectors.splice(0, vectors.length, ...filteredVectors);
            filteredFallbackSucceeded = true;
          }
        } catch (e) {
          if (e instanceof EmbeddingProfileMismatchError) throw e;
          console.error("Vectorize tag-filter query failed (degrading to keyword-only):", e);
        }
      }
    }

    // An empty result is not proof that the D1 rows are irrelevant: Vectorize writes
    // and getByIds are asynchronous, and imported/cold rows can intentionally have no
    // vectors. Preserve exact/lexical recall instead of turning a valid tag into an
    // unexplained empty response.
    if (!vectors.length || ((getByIdsFailed || getByIdsIncomplete) && !filteredFallbackSucceeded)) {
      markSemanticUnavailable(values ? "vectorize_unavailable" : semanticUnavailableReason ?? "embedding_unavailable", semanticRetryAt);
    }

    results = {
      matches: vectors.map(v => ({
        id: v.id,
        score: values ? cosineSim(values, v.values as number[]) : 0,
        metadata: v.metadata,
        values: v.values as number[],
      })) as VectorizeMatch[],
    };
  } else {
    // A fixed pool, so a larger topK only extends the list and never reorders its head.
    const vectorizeTopK = RECALL_POOL_SIZE;
    // Scoped when an Identity is in play: the workspace filter keeps foreign
    // candidates out of the result slots. queryVectorizeScoped retries
    // unfiltered if Vectorize rejects the filter; hydration below is scoped at
    // the SQL layer either way, so correctness never rides on this.
    const wsFilter = identity ? workspaceFilter(identity, internal.workspaceFilter, internal.teamId)?.filter : undefined;
    // env-free code (src/vectorize/scope.ts) cannot reach KV itself, so the
    // caller hands it this callback. It fires at most once per isolate — see
    // queryVectorizeScoped's own transition guard — so it cannot move
    // recall-free-tier-budget, which never rejects a filter.
    const onDegrade = () => ctx.waitUntil(
      env.OAUTH_KV.put(VECTORIZE_WORKSPACE_FILTER_UNSUPPORTED_KV_KEY, String(Date.now()))
        .catch((error: unknown) => console.error(
          "Vectorize filter-degradation marker write failed (non-fatal):", error,
        )),
    );
    const denseAt = async (k: number): Promise<{ matches: VectorizeMatch[] }> => {
      if (!values) return { matches: [] };
      if (wsFilter) {
        const { matches } = await queryVectorizeScoped<VectorizeMatch>(
          env.VECTORIZE, values, { topK: k, filter: wsFilter, onDegrade, fallbackOnEmpty: true },
        );
        assertVectorProfiles(matches);
        return { matches };
      }
      const response = await env.VECTORIZE.query(values, { topK: k, returnMetadata: "all", returnValues: true });
      assertVectorProfiles(response.matches);
      return response;
    };
    let denseQueryFailed = false;
    const denseQuery = async (): Promise<{ matches: VectorizeMatch[] }> => {
      if (arms === "keyword-only") return { matches: [] as VectorizeMatch[] };
      try {
        return await denseAt(vectorizeTopK);
      } catch (e) {
        if (e instanceof EmbeddingProfileMismatchError) throw e;
        console.error("Vectorize query failed (degrading to keyword-only):", e);
        markSemanticUnavailable("vectorize_unavailable");
        denseQueryFailed = true;
        return { matches: [] as VectorizeMatch[] };
      }
    };
    const [denseResults, kw] = await Promise.all([
      denseQuery(),
      arms === "dense-only"
        ? Promise.resolve({ rows: [] as KeywordRow[], fts: false, route: "skipped-by-variant" as const, idfWindow: undefined })
        : keywordSearch(profile.retrievalTokens, env, cfg.KEYWORD_CANDIDATE_LIMIT, bounds, identity, internal.workspaceFilter, internal.teamId, distilled, { terms: profile.retrievalTerms, priorityTerms: values ? undefined : profile.lexicalTerms, kind, answerOnly: hops === 0 && asOf === undefined, forceLike: semanticQuery.includes("\0") }, now, asOf),
    ]);
    results = denseResults;
    keywordRows = kw.rows;
    ftsServedKeywords = kw.fts;
    keywordIdfWindow = kw.idfWindow ?? 0;
    if (internal.diagnostics) internal.diagnostics.ftsRoute = kw.route;

    if (denseQueryFailed && !kw.fts) {
      try {
        keywordRows = await keywordSearchLexical(profile.retrievalTerms, env, cfg.KEYWORD_CANDIDATE_LIMIT, bounds,
          identity, internal.workspaceFilter, internal.teamId, profile.lexicalTerms, kw.rows, kind, hops === 0, distilled, now, asOf);
      } catch (error) {
        console.error("追加のkeyword救済に失敗したため初回候補を維持:", error);
      }
    }
    // Governed by its own threshold, not the write-path duplicate flag: the two
    // shared a constant until #245, so retuning duplicate detection silently
    // retuned recall widening.
    if (values
      && !semanticUnavailable
      && vectorizeTopK < VECTORIZE_WIDEN_MAX_CANDIDATES
      && results.matches.length
      && results.matches[0].score < cfg.RECALL_WIDEN_THRESHOLD) {
      try {
        results = await denseAt(Math.min(RECALL_DEEP_POOL_SIZE, VECTORIZE_WIDEN_MAX_CANDIDATES));
      } catch (e) {
        if (e instanceof EmbeddingProfileMismatchError) throw e;
        console.error("Vectorize widen-query failed (non-fatal, keeping narrow results):", e);
      }
    }
    // A full pool means the index has more to give. Already widened: the deep list is in hand.
    if (!semanticUnavailable && results.matches.length >= vectorizeTopK) {
      const have = results.matches.length > vectorizeTopK ? results.matches : undefined;
      denseFill = async () => have ?? (await denseAt(Math.min(RECALL_DEEP_POOL_SIZE, VECTORIZE_WIDEN_MAX_CANDIDATES))).matches;
    }
  }

  const priorityKeywordIds = new Set(keywordRows
    .filter(row => (row as KeywordRow & { __priority?: boolean }).__priority === true)
    .map(row => row.id));

  if (internal.diagnostics) {
    internal.diagnostics.ftsUsed = ftsServedKeywords;
    internal.diagnostics.denseIds = [...new Set(results.matches.map(m => ((m.metadata as any)?.parentId ?? m.id) as string))];
    internal.diagnostics.keywordIds = [...new Set(keywordRows.map(row => row.id))];
  }
  markStage("candidateGeneration");

  const semanticRankByParent = new Map<string, number>();
  [...results.matches]
    .sort((a, b) => b.score - a.score || vectorSortKey(a.id).localeCompare(vectorSortKey(b.id)))
    .forEach(match => {
      const parentId = ((match.metadata as any)?.parentId ?? match.id) as string;
      if (!semanticRankByParent.has(parentId)) semanticRankByParent.set(parentId, semanticRankByParent.size + 1);
    });

  const strongestDenseMatch = results.matches.reduce<VectorizeMatch | undefined>(
    (best, match) => !best || match.score > best.score ? match : best,
    undefined,
  );
  const strongestDenseTags = Array.isArray(strongestDenseMatch?.metadata?.tags)
    ? strongestDenseMatch.metadata.tags.filter((value): value is string => typeof value === "string")
    : [];
  const normalizedSemanticQuery = semanticQuery.normalize("NFKC").toLowerCase();
  const strongestDenseQueryTags = strongestDenseTags.flatMap(rawTag => {
    const normalizedTag = rawTag.normalize("NFKC").toLowerCase();
    return normalizedTag.length > 0
      && isTopicTag(normalizedTag)
      && new RegExp(`(?<![\\w-])${escapeRegExp(normalizedTag)}(?![\\w-])`).test(normalizedSemanticQuery)
      ? [normalizedTag]
      : [];
  });
  // Preserve the existing topic-anchored untagged calibration. A tag already
  // anchors the topic for explicit current-state requests: rare generic words
  // must not cast multiple lexical votes and bury relevant status evidence.
  // Other tagged intents and weak/unavailable dense retrieval retain their
  // existing lexical rescue strength.
  const normalizeKeywordArm = !semanticUnavailable
    && (strongestDenseMatch?.score ?? Number.NEGATIVE_INFINITY) >= cfg.RECALL_WIDEN_THRESHOLD
    && (tag ? profile.intent === "current" : strongestDenseQueryTags.length > 0);
  // Tag inference runs on the distilled lexical query and can legitimately
  // omit a product name retained by the semantic query. When that exact name
  // also anchors a calibrated dense rank 1, carry it into the existing tag
  // reranker so an importance-only tie-break cannot erase the semantic win.
  const rankingQueryTags = normalizeKeywordArm && !tag
    ? [...new Set([...queryTags, ...strongestDenseQueryTags])]
    : queryTags;
  const keywordPreRanked = internal.keywordPreRankedOverride ?? ftsServedKeywords;
  // A one-word query skips distillation's frequency scan, and fusion then prices each word against the rows it fetched: a word
  // held only by its own matches then weighs about the same whether it is a name or "the". When the fetch holds every match,
  // the rows holding a word are its df, so weigh it against the corpus size (one entry_counts read) like any counted word.
  let corpus: Pick<DistilledQuery, "df" | "total"> = distilled;
  if (!distilled.df && keywordRows.length && keywordRows.length < cfg.KEYWORD_CANDIDATE_LIMIT) {
    const total = await scopedEntryTotal(env, scope);
    if (total) {
      const df = new Map([...profile.retrievalTokens, ...tokens].map(t => [t, keywordRows.filter(r => termLevel(r, t) > 0).length] as const));
      corpus = { df, total };
    }
  }
  const rootKeywordTrace = explain ? new Map<string, KeywordTermTrace[]>() : undefined;
  const lexicalKeywordTrace = explain ? new Map<string, KeywordTermTrace[]>() : undefined;
  const rootFusedMatches = fuseDenseAndKeyword(results.matches as VectorizeMatch[], keywordRows, profile.retrievalTerms, !memberFirst || semanticUnavailable, corpus, cfg.SUBSTRING_MATCH_WEIGHT, keywordPreRanked, keywordIdfWindow, rootKeywordTrace, normalizeKeywordArm);
  const lexicalFusedMatches = fuseDenseAndKeyword(results.matches as VectorizeMatch[], keywordRows, profile.lexicalTerms, !memberFirst || semanticUnavailable, corpus, cfg.SUBSTRING_MATCH_WEIGHT, keywordPreRanked, keywordIdfWindow, lexicalKeywordTrace, normalizeKeywordArm);
  const fusedMatches = lexicalFusedMatches.length ? lexicalFusedMatches : rootFusedMatches;
  const keywordTrace = lexicalFusedMatches.length ? lexicalKeywordTrace : rootKeywordTrace;
  if (!rootFusedMatches.length && !fusedMatches.length) return await noResultsWithStanding();

  const candidateIds = [...new Set([...fusedMatches, ...rootFusedMatches].map(m => (m.metadata as any)?.parentId ?? m.id))] as string[];
  internal.diagnostics && (internal.diagnostics.fusedIds = [...new Set(rootFusedMatches.map(m => (m.metadata as any)?.parentId ?? m.id))] as string[]);
  type CandidateSignalRow = { id: string; content?: string; source?: string; created_at: number; last_updated?: number; recall_count: number; importance_score: number; contradiction_wins: number; contradiction_losses: number; tags: string; memory_tier: string | null; valid_until?: number | null };
  const rcRows: CandidateSignalRow[] = [];
  // valid_until rides along so the evidence-slot re-check below (which reads
  // this row when a candidate never reached d1Map) can still enforce current
  // validity, not just deprecated status.
  const candidateSignalProjection = hops > 0
    ? `id, content, source, created_at, COALESCE(updated_at, created_at) AS last_updated, recall_count, importance_score, contradiction_wins, contradiction_losses, tags, memory_tier, workspace_id, actor_id, valid_until`
    : "id, created_at, recall_count, importance_score, contradiction_wins, contradiction_losses, tags, memory_tier, workspace_id, actor_id, valid_until";
  // Scoped too: this is the leak-catcher for unscoped Vectorize hits — until
  // namespaces land (P3) the dense arm can surface a stranger's id, and the
  // scope clause here is what stops that id from hydrating into signals. The
  // scope's two bindings count toward D1's bound-parameter ceiling exactly as
  // the ids do, so the batch shrinks by them rather than overrunning.
  const rcScopeSql = scope ? ` AND ${scopeWhereForIdRead(scope).clause}` : "";
  const rcBatchSize = D1_MAX_BOUND_PARAMS - (scope?.bindings.length ?? 0);
  for (let i = 0; i < candidateIds.length; i += rcBatchSize) {
    const batch = candidateIds.slice(i, i + rcBatchSize);
    const rcPlaceholders = batch.map(() => "?").join(", ");
    // validity: current: valid_until rides in candidateSignalProjection; the evidence-slot JS re-check below is this read's only current-only enforcement (5.5)
    // scope-checked: rcScopeSql applies the caller's clause through scopeWhereForIdRead above; the lexer cannot see the leading AND inside that JS fragment. Empty only for an identity-less caller
    const { results: rows } = await env.DB.prepare(
      `SELECT ${candidateSignalProjection} FROM entries WHERE id IN (${rcPlaceholders})${rcScopeSql}`
    ).bind(...batch, ...(scope?.bindings ?? [])).all() as { results: CandidateSignalRow[] };
    rcRows.push(...rows);
  }
  const recallCounts = new Map(rcRows.map(r => [r.id, r.recall_count ?? 0]));
  const importanceScores = new Map(rcRows.map(r => [r.id, r.importance_score ?? 0]));
  const contradictionWins = new Map(rcRows.map(r => [r.id, r.contradiction_wins ?? 0]));
  const contradictionLosses = new Map(rcRows.map(r => [r.id, r.contradiction_losses ?? 0]));
  const d1Tags = new Map(rcRows.map(r => [r.id, JSON.parse(r.tags ?? "[]") as string[]]));
  const normalizedTag = tag?.normalize("NFKC").toLowerCase();
  const eligibleMemoryTiers = new Map(rcRows.flatMap(row => {
    const rowTags = d1Tags.get(row.id) ?? [];
    const normalizedRowTags = rowTags.map(value => value.normalize("NFKC").toLowerCase());
    if (isHeld(rowTags)) return [];
    if (asOf === undefined && row.valid_until != null && row.valid_until <= now) return [];
    if (normalizedRowTags.some(value => ["auto-pattern", "auto-insight", ...(asOf === undefined ? ["status:deprecated"] : [])].includes(value))) return [];
    if (normalizedTag && !normalizedRowTags.includes(normalizedTag)) return [];
    if (kind && !rowTags.includes(`kind:${kind}`)) return [];
    if (after !== undefined && row.created_at < after) return [];
    if (before !== undefined && row.created_at >= before) return [];
    return [[row.id, row.memory_tier] as const];
  }));

  const d1Sources = new Map(rcRows.filter(r => r.source !== undefined).map(r => [r.id, r.source as string]));
  // Held rows: dropped here, before rerank, rather than only at hydration. A
  // held row briefly still carrying vectors (the race window between its hold
  // commit and its vector delete) would otherwise take a dense or keyword
  // slot and rank before the model ever runs (5.3).
  const notHeld = (list: VectorizeMatch[]) => list.filter(m => {
    const tags = d1Tags.get(((m.metadata as any)?.parentId ?? m.id) as string);
    return !tags || !isHeld(tags);
  });
  const fusedForRerank = notHeld(fusedMatches);
  const rootFusedForRerank = notHeld(rootFusedMatches);

  // The traced variant is for explain only: off, recall runs the plain reranker it always ran.
  // intent (5.8/B6): stale_penalty applies only under "current" — profile.intent is the same
  // classification authorityAlignment already reads above, not a second guess.
  const directOptions = { d1Sources, intent: profile.intent };
  const directTraced = explain ? rerankWithTimeDecayTraced(fusedForRerank, recallCounts, importanceScores, rankingQueryTags, contradictionWins, contradictionLosses, d1Tags, cfg, directOptions) : undefined;
  let directReranked = directTraced ? directTraced.map(t => t.match) : rerankWithTimeDecay(fusedForRerank, recallCounts, importanceScores, rankingQueryTags, contradictionWins, contradictionLosses, d1Tags, cfg, directOptions);
  // The root view is computed here, beside the direct one, so a single model batch can cover both.
  const rootOptions = { useRecallFrequency: false, d1Sources, intent: profile.intent };
  const rootTraced = explain && hops > 0 ? rerankWithTimeDecayTraced(rootFusedForRerank, recallCounts, importanceScores, rankingQueryTags, contradictionWins, contradictionLosses, d1Tags, cfg, rootOptions) : [];
  let rootReranked = rootTraced.length ? rootTraced.map(t => t.match)
    : hops > 0 ? rerankWithTimeDecay(rootFusedForRerank, recallCounts, importanceScores, rankingQueryTags, contradictionWins, contradictionLosses, d1Tags, cfg, rootOptions) : [];
  const rerankMode: RerankMode = semanticUnavailable ? "off" : internal.variant?.rerank === true ? "on" : internal.variant?.rerank === false ? "off" : isRerankMode(cfg.RERANK_MODE) ? cfg.RERANK_MODE : "off";
  // Only parents the scoped D1 read returned may reach the model: a foreign Vectorize hit has no row here.
  const scopedParents = new Set(rcRows.map(r => r.id));
  const inScope = (m: VectorizeMatch) => scopedParents.has(((m.metadata as any)?.parentId ?? m.id) as string);
  const parentOfMatch = (m: VectorizeMatch) => ((m.metadata as any)?.parentId ?? m.id) as string;
  // Explain shows only what the caller's own rows justify: a foreign vector D1 dropped must leave no trace in any rank.
  const scopedOrder = (list: VectorizeMatch[]) => {
    const order = new Map<string, number>();
    for (const m of list) if (inScope(m) && !order.has(parentOfMatch(m))) order.set(parentOfMatch(m), order.size);
    return order;
  };
  const displayedDenseRank = new Map<string, number>();
  if (explain) {
    [...results.matches].sort((a, b) => b.score - a.score || vectorSortKey(a.id).localeCompare(vectorSortKey(b.id))).forEach(match => {
      const id = parentOfMatch(match as VectorizeMatch);
      if (scopedParents.has(id) && !displayedDenseRank.has(id)) displayedDenseRank.set(id, displayedDenseRank.size + 1);
    });
  }
  const beforeBlend = explain ? { direct: scopedOrder(directReranked), root: scopedOrder(rootReranked) } : undefined;
  // Keyword evidence: rows the keyword arm returned that hold every distilled query term, in fused order. Scoped like
  // everything else here (inScope), and used only to choose ids: the model reads D1 text.
  const fusedOrder = new Map<string, number>();
  directReranked.forEach((m, i) => { const id = parentOfMatch(m); if (!fusedOrder.has(id)) fusedOrder.set(id, i); });
  const keywordEvidence = async (): Promise<string[]> => {
    if (!tokens.length) return [];
    const holding = keywordRows.filter(r => scopedParents.has(r.id) && tokens.every(t => termLevel(r, t) > 0));
    // Several terms were already through distillation's saturation filter. One term has no df there, so a common word
    // ("budget") must not count as evidence: apply the same rule (df over the corpus <= QUERY_SATURATION_FRACTION) with
    // the keyword rows holding the term as its df and one entry_counts read for the corpus size. Unknown = not evidence.
    if (tokens.length === 1) {
      const outsideHead = holding.some(r => (fusedOrder.get(r.id) ?? Infinity) >= rerankDirectCap(internal.variant?.rerankTuning?.maxCandidates));
      if (!outsideHead) return [];
      const total = await scopedEntryTotal(env, scope);
      if (total === null || total <= 0) { if (internal.diagnostics) internal.diagnostics.rerankEvidence = "suppressed-no-total"; return []; }
      if (holding.length >= cfg.KEYWORD_CANDIDATE_LIMIT || holding.length / total > QUERY_SATURATION_FRACTION) { if (internal.diagnostics) internal.diagnostics.rerankEvidence = "suppressed-saturated"; return []; }
    }
    return holding.map(r => r.id).sort((a, b) => (fusedOrder.get(a) ?? Infinity) - (fusedOrder.get(b) ?? Infinity));
  };
  const rerank = await rerankStep({
    mode: rerankMode, forced: internal.variant?.rerank === true, tuning: internal.variant?.rerankTuning, keywordEvidence, env, ctx, query: semanticQuery,
    queryTokens: profile.evidenceTokens, evidenceTokens: profile.evidenceTokens, direct: directReranked.filter(inScope), root: rootReranked.filter(inScope),
    loadContent: async ids => {
      const known = new Map(rcRows.filter(r => r.content !== undefined).map(r => [r.id, r.content as string]));
      // Codex review class E (T-0089.4.2): defense-in-depth, not the only guard — every id here
      // already passed notHeld() upstream (it entered directReranked/rootReranked through it), but
      // this reuses d1Tags (no extra read: rcRows already carries it) to keep loadContent's own
      // fallback fetch from ever becoming the one path that forgot to check, whatever feeds `ids`
      // in the future.
      const need = ids.filter(id => !known.has(id) && scopedParents.has(id) && !isHeld(d1Tags.get(id) ?? []));
      if (need.length) {
        // validity: current: every id here already passed the current-only filters above (d1Map or the evidence-slot re-check); this is a content-only re-fetch, not a new candidate source
        // scope-exempt: by-id: every id here came from rcRows, the scoped candidate-signal read above (inScope filters to it). The scope clause is left out on purpose: with it SQLite plans a scan of the caller's whole workspace instead of <=30 primary-key lookups, which costs rows_read in proportion to the brain's size on every recall
        const { results } = await env.DB.prepare(
          `SELECT id, content FROM entries WHERE id IN (${need.map(() => "?").join(", ")})`
        ).bind(...need).all() as { results: { id: string; content: string }[] };
        for (const r of results) known.set(r.id, r.content);
      }
      return known;
    },
  });
  if (internal.diagnostics) {
    internal.diagnostics.rerankRoute = rerank.route;
    if (rerank.ms !== undefined) internal.diagnostics.rerankMs = rerank.ms;
  }
  // Linked-evidence scoring is calibrated on heuristic root scores; a reranker blend rescales them (best x2, worst x0.25),
  // which would move which linked memories qualify even when the model agrees with the heuristic order. Keep the
  // pre-blend scores for it; the blend still decides the ORDER of the direct picks and of root selection.
  const heuristicRootScore = new Map<string, number>();
  for (const m of rootReranked) if (!heuristicRootScore.has(parentOfMatch(m))) heuristicRootScore.set(parentOfMatch(m), m.score);
  if (rerank.percentiles) {
    directReranked = blendRerankerScores(directReranked, rerank.percentiles, internal.variant?.rerankTuning?.weight, internal.variant?.rerankTuning?.floor, new Set(rerank.evidence ?? []));
    rootReranked = blendRerankerScores(rootReranked, rerank.percentiles, internal.variant?.rerankTuning?.weight, internal.variant?.rerankTuning?.floor, new Set(rerank.evidence ?? []));
  }
  const rerankMove = new Map<string, "up" | "down">();
  if (beforeBlend) {
    for (const [before, after] of [[beforeBlend.root, scopedOrder(rootReranked)], [beforeBlend.direct, scopedOrder(directReranked)]] as const) {
      for (const [id, pos] of after) {
        const was = before.get(id);
        if (was !== undefined && was !== pos) rerankMove.set(id, pos < was ? "up" : "down");
        else if (was !== undefined) rerankMove.delete(id);
      }
    }
  }
  internal.diagnostics && (internal.diagnostics.candidateIds = directReranked.map(m => ((m.metadata as any)?.parentId ?? m.id) as string));
  const collapsedRolloverJournals = await rolloverJournalIdsToCollapse(
    directReranked,
    rootReranked,
    eligibleMemoryTiers,
    profile.intent,
    semanticQuery,
    env,
  );
  lineageFallbackUsed = collapsedRolloverJournals.fallbackUsed;
  if (internal.diagnostics) {
    internal.diagnostics.collapsedDirectRolloverIds = [...collapsedRolloverJournals.direct].sort();
    internal.diagnostics.collapsedGraphRolloverIds = [...collapsedRolloverJournals.graph].sort();
    internal.diagnostics.promotedDirectRolloverIds = [...collapsedRolloverJournals.promotedDirect].sort();
    internal.diagnostics.lineageFallbackUsed = lineageFallbackUsed;
  }
  const isCollapsedDirectRolloverJournal = (id: string) => collapsedRolloverJournals.direct.has(id);
  const isCollapsedGraphRolloverJournal = (id: string) => collapsedRolloverJournals.graph.has(id);
  const promotedDirectMatches = rootReranked.filter(match => {
    const parentId = ((match.metadata as any)?.parentId ?? match.id) as string;
    return collapsedRolloverJournals.promotedDirect.has(parentId);
  });

  const seen = new Set<string>();
  const dedupedAll = [...directReranked, ...promotedDirectMatches].filter((m) => {
    const parentId = (m.metadata as any)?.parentId ?? m.id;
    if (isCollapsedDirectRolloverJournal(parentId)) return false;
    // AI正常時の未索引救済も、対象外の行で上位枠を消費させない。
    // 取得済みのD1適格性を使い、最終hydrateと同じ除外をMMR前に適用する。
    if (!eligibleMemoryTiers.has(parentId)) return false;
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    return true;
  });
  // MMR is greedy, so its first n picks do not depend on how many are asked for. Rounding the depth up to whole
  // blocks (each ordered by score below) keeps every block a topK cuts the same block a larger topK sees, and a
  // default topK 5 call diversifies and hydrates exactly the five it always did.
  let directCandidates = mmrRerank(dedupedAll, cfg.MMR_LAMBDA, Math.ceil(topK / RECALL_BLOCK) * RECALL_BLOCK + (lookaheadActive ? CAP_LOOKAHEAD : 0));
  if (semanticUnavailable && topK > 0 && dedupedAll.length > 0) {
    const authorityCandidate = dedupedAll
      .filter(match => {
        const parentId = ((match.metadata as any)?.parentId ?? match.id) as string;
        const tags = d1Tags.get(parentId) ?? [];
        // An ineligible row would be dropped by final hydration after evicting
        // a usable result. Reuse the already-hydrated eligibility decision.
        return priorityKeywordIds.has(parentId) && eligibleMemoryTiers.has(parentId)
          && (tags.includes("status:canonical") || (importanceScores.get(parentId) ?? 0) >= 5);
      })
      .sort((a, b) => {
        const aId = ((a.metadata as any)?.parentId ?? a.id) as string;
        const bId = ((b.metadata as any)?.parentId ?? b.id) as string;
        const aCanonical = Number((d1Tags.get(aId) ?? []).includes("status:canonical"));
        const bCanonical = Number((d1Tags.get(bId) ?? []).includes("status:canonical"));
        return bCanonical - aCanonical
          || (importanceScores.get(bId) ?? 0) - (importanceScores.get(aId) ?? 0)
          || b.score - a.score
          || aId.localeCompare(bId);
      })[0];
    if (authorityCandidate) {
      const authorityId = ((authorityCandidate.metadata as any)?.parentId ?? authorityCandidate.id) as string;
      const alreadySelected = directCandidates.slice(0, topK).some(match => (((match.metadata as any)?.parentId ?? match.id) as string) === authorityId);
      if (!alreadySelected) {
        directCandidates = [...directCandidates.slice(0, Math.max(0, topK - 1)), authorityCandidate];
      }
    }
  }
  // A topK larger than the diversified list draws the rest from a deeper dense list, after everything above. The
  // fetch happens only then, but what it adds is the same whatever topK is, and it only ever follows the list, so the
  // head of a smaller topK is a prefix of it.
  const parentOf = (m: VectorizeMatch) => ((m.metadata as any)?.parentId ?? m.id) as string;
  let fillCandidates: VectorizeMatch[] = [];
  if (denseFill && topK > directCandidates.length) {
    try {
      const taken = new Set(directCandidates.map(parentOf));
      fillCandidates = (await denseFill()).filter(m => !taken.has(parentOf(m)) && taken.add(parentOf(m)));
    } catch (e) {
      console.error("Vectorize deep query failed (non-fatal, returning the shorter list):", e);
    }
  }
  markStage("candidateHydration");

  const directParentIds = directCandidates.map((m) => (m.metadata as any)?.parentId ?? m.id);
  let selectedRoots: ReturnType<typeof selectGraphRoots> = [];
  let rootCandidates: RootCandidate[] = [];
  if (hops > 0) {
    const candidateContent = new Map(rcRows.map(r => [r.id, r.content ?? ""]));
    const rootSeen = new Set<string>();
    // Scoped like everything else here (inScope): a root the caller cannot read must
    // never anchor a traversal, or its id rides out on a readable neighbour's viaFrom
    // (why.graph.from, the MCP "linked from" line, REST related_to). This is a no-op
    // whenever the workspace filter held, since rootReranked already held only the
    // caller's own rows; it only bites when Vectorize rejected the filter and the
    // unfiltered retry handed back another member's private vector.
    rootCandidates = rootReranked.filter(inScope).flatMap(match => {
      const parentId = ((match.metadata as any)?.parentId ?? match.id) as string;
      // A readable root may fail the answer kind/time filters; an unhydrated
      // (missing or out-of-scope) row must never consume a graph seed slot.
      if (!candidateContent.has(parentId)) return [];
      // Graph-root and evidence-rescue candidates share the graph lineage view.
      // A continuation found only by the root arm is promoted when it replaces
      // a direct journal, so graph filtering cannot erase the sole direct result.
      if (isCollapsedGraphRolloverJournal(parentId)) return [];
      if (rootSeen.has(parentId)) return [];
      rootSeen.add(parentId);
      const tags = d1Tags.get(parentId) ?? [];
      const localEvidence = localEvidenceOf(match, candidateContent.get(parentId) ?? "", tokens);
      const tagAlignment = queryTags.length ? tags.filter(value => queryTags.includes(value)).length / queryTags.length : 0;
      const episodicAlignment = ["causal", "chronology"].includes(profile.intent) && tags.includes("kind:episodic") ? 1 : 0;
      const authorityAlignment = ["current", "direct"].includes(profile.intent) && tags.includes("status:canonical") ? 1 : 0;
      return [{ ...match, parentId, rootScore: match.score, evidenceScore: heuristicRootScore.get(parentId) ?? match.score, localEvidence, tags,
        lexicalCoverage: queryCoverage(localEvidence, tokens, distilled).score,
        metadataAlignment: Math.min(1, .6 * tagAlignment + .2 * episodicAlignment + .2 * authorityAlignment),
        semanticRank: semanticRankByParent.get(parentId) }];
    });
    // Diagnostic only: the graph root arm is a second source of candidates (a multi-hop answer arrives through it), so
    // a pool measure that ignored it would call reachable golds unreachable. Appended after the direct pool.
    internal.diagnostics && (internal.diagnostics.candidateIds = [...new Set([...(internal.diagnostics.candidateIds ?? []), ...rootCandidates.map(r => r.parentId)])]);
    // The seat budgets are sized for RECALL_SEED_TOPK, not the caller's topK, so a larger topK cannot change which
    // roots are seeded (and with them the head).
    // One selection per arm, against that arm's own budget: a row the dense arm
    // never returned has no semantic rank, so it cannot take a seat — or a seat
    // in the "semantic" view — from a row that does. The keyword arm still gets
    // the window back when the dense arm does not fill it (lexicalSeedLimit), so
    // a recall with Vectorize down is seeded from as many roots as a healthy one.
    //
    // The second pass labels its picks with the same RootView names, so a
    // keyword-only row can be tagged selectedBy "semantic" — it topped its own
    // partition's rootScore order, which for these rows IS the keyword order.
    // Nothing reads the label as proof of a dense rank: the one consumer,
    // chooseEvidenceSlot's semantic branch, tests semanticRank !== undefined as
    // well, which no row in this partition has.
    const denseRoots = rootCandidates.filter(root => root.semanticRank !== undefined);
    const lexicalRoots = rootCandidates.filter(root => root.semanticRank === undefined);
    const scopeBindings = scope?.bindings.length ?? 0;
    const denseSeats = graphSeedLimit(RECALL_SEED_TOPK, denseRoots.length, scopeBindings);
    selectedRoots = [
      ...selectGraphRoots(denseRoots, denseSeats, cfg.MMR_LAMBDA),
      ...selectGraphRoots(lexicalRoots, lexicalSeedLimit(RECALL_SEED_TOPK, lexicalRoots.length, denseSeats, scopeBindings), cfg.MMR_LAMBDA),
    ];
  }
  const graphSeedIds = selectedRoots.map(x => x.candidate.parentId);
  graphContribution.seedCount = graphSeedIds.length;
  // Direct answer eligibility is not graph-root eligibility. An authorized
  // event can lead to an eligible answer even when no direct hit can be returned.
  if (!directCandidates.length && !graphSeedIds.length) {
    return await noResultsWithStanding();
  }
  if (internal.diagnostics && hops > 0) {
    internal.diagnostics.rootSelections = selectedRoots.map(x => ({ id: x.candidate.parentId, selectedBy: x.selectedBy }));
    internal.diagnostics.rejections = [];
  }

  let expanded: GraphNeighbor[] = [];
  if (hops > 0) {
    expanded = await expandGraph(
      graphSeedIds,
      { hops, includeSeedNeighbors: true, only: internal.workspaceFilter, teamId: internal.teamId, asOf },
      env,
      cfg,
      identity,
    );
  }
  graphContribution.expandedCount = expanded.length;
  markStage("graphExpansion");
  if (internal.diagnostics && hops > 0) internal.diagnostics.expandedIds = expanded.map(x => x.id);

  // The graph view can include up to 50 roots and 50 expanded nodes in addition
  // to direct candidates. Keep the union unique and chunked: with a topK above
  // the public route's cap this can span multiple D1 statements, and time
  // filters consume bindings in every statement.
  const allParentIds = [...new Set([
    ...directParentIds,
    ...fillCandidates.map(parentOf),
    ...graphSeedIds,
    ...expanded.map(e => e.id),
  ])];
  // validity: current: a replaced or ended fact must never be presented as current (5.5); as-of (5.7 item 3) instead keeps what was true at T plus belief candidates (confirmed by as-of.ts's belief batch)
  let d1Filters = asOf === undefined
    ? ` AND tags NOT LIKE '%"auto-pattern"%' AND tags NOT LIKE '%"auto-insight"%' AND tags NOT LIKE '%"status:deprecated"%' AND (valid_until IS NULL OR valid_until > ?) AND ${NOT_HELD_SQL}`
    : ` AND tags NOT LIKE '%"auto-pattern"%' AND tags NOT LIKE '%"auto-insight"%' AND ${asOfPredicateSql()} AND ${NOT_HELD_SQL}`;
  const filterBindings: (string | number)[] = asOf === undefined ? [now] : asOfPredicateBindings(asOf);
  if (kind && (KIND_VALUES as readonly string[]).includes(kind)) d1Filters += ` AND tags LIKE '%"kind:${kind}"%'`;
  if (tag) {
    d1Filters += ` AND tags LIKE ? ${TAG_LIKE_ESCAPE}`;
    filterBindings.push(tagLikePattern(tag));
  }
  if (after !== undefined) { d1Filters += ` AND created_at >= ?`; filterBindings.push(after); }
  if (before !== undefined) { d1Filters += ` AND created_at < ?`; filterBindings.push(before); }
  // Last filter in, so the scope's bindings are already inside filterBindings
  // when idBatchSize subtracts them from the bound-parameter ceiling — the same
  // accounting every other filter's bindings get.
  if (scope) {
    d1Filters += ` AND ${scopeWhereForIdRead(scope).clause}`;
    filterBindings.push(...scope.bindings);
  }
  // Standing (spec 15 2.8 step 4): appended to the FIRST hydration statement only, as an OR arm that
  // ignores the caller's tag/project/kind/time filters on purpose — a standing instruction fires on
  // topic, not on the caller's result filters. A row this arm returns is never added to allParentIds,
  // so it can only ever leave d1Map unread (below) or be pulled out explicitly for `standing`; it can
  // never enter `matches`.
  const standingArmActive = !semanticUnavailable && standingCandidates.length > 0;
  const standingIds = standingCandidates.map(c => c.id);
  // validity: current: currentValidityAt re-checks what the cache build already filtered, because the cache can be up to 24h stale (spec 15 2.4/2.6)
  // scope-checked: the standing arm carries its own scopeWhereForIdRead(scope) copy, a second predicate group inside the same statement, not inside d1Filters
  const standingClause = standingArmActive
    ? ` OR (id IN (${standingIds.map(() => "?").join(", ")}) AND tags LIKE '%"standing:active"%' AND tags NOT LIKE '%"status:deprecated"%' AND ${NOT_HELD_SQL} AND ${currentValidityAt("", "?")}${scope ? ` AND ${scopeWhereForIdRead(scope).clause}` : ""})`
    : "";
  const standingBindings: (string | number)[] = standingArmActive
    ? [...standingIds, now, ...(scope?.bindings ?? [])]
    : [];

  const d1Rows: Record<string, any>[] = [];
  if (projectFilter) { d1Filters += ` AND ${projectFilter.clause}`; filterBindings.push(...projectFilter.bindings); }
  const idBatchSize = D1_MAX_BOUND_PARAMS - filterBindings.length - standingBindings.length;
  for (let i = 0; i < allParentIds.length; i += idBatchSize) {
    const batch = allParentIds.slice(i, i + idBatchSize);
    const placeholders = batch.map(() => "?").join(", ");
    // The unmarked form on an ordinary batch (or every batch when no standing candidate exists)
    // is BYTE-IDENTICAL to before the standing arm existed (spec 15 2.8's own invariant) — no
    // extra parenthesis, no extra bytes — which a D1 double that matches on the SQL string, not
    // just its meaning, also depends on.
    const withStanding = i === 0 && standingArmActive;
    const { results } = await env.DB.prepare(
      withStanding
        // scope-checked: d1Filters applies scopeWhereForIdRead(scope) above; the standing arm carries its own scopeWhereForIdRead(scope) copy above in standingClause; the lexer cannot see the leading AND inside either JS fragment
        // scope-checked: the superseded_by subquery pins its closer `s` to entries.workspace_id — the outer row's own, already scoped by d1Filters above — so it can never cross a workspace boundary
        // validity: current: d1Filters carries the predicate, and the standing arm carries currentValidityAt separately (5.5)
        ? `SELECT id, content, tags, source, created_at, updated_at, workspace_id, actor_id, valid_from, valid_until,
                  ${supersededBySql("entries")} AS superseded_by_json
             FROM entries WHERE (id IN (${placeholders})${d1Filters})${standingClause}`
        // scope-checked: d1Filters applies scopeWhereForIdRead(scope) above; the lexer cannot see the leading AND inside that JS fragment
        // scope-checked: the superseded_by subquery pins its closer `s` to entries.workspace_id — the outer row's own, already scoped by d1Filters above — so it can never cross a workspace boundary
        // validity: current: d1Filters carries the predicate (5.5)
        : `SELECT id, content, tags, source, created_at, updated_at, workspace_id, actor_id, valid_from, valid_until,
              ${supersededBySql("entries")} AS superseded_by_json
         FROM entries WHERE id IN (${placeholders})${d1Filters}`
    ).bind(...batch, ...filterBindings, ...(withStanding ? standingBindings : [])).all() as { results: Record<string, any>[] };
    d1Rows.push(...results);
  }

  const d1Map = new Map(d1Rows.map((r) => [r.id as string, r]));
  // Which layer a memory lives in, resolved against the caller's own workspace
  // ids: personal and company map to themselves, anything else ('' legacy rows,
  // system insights) reads as "system". Clients use this to offer share/unshare
  // and to badge results.
  const candidateSignalById = new Map(rcRows.map(row => [row.id, row]));
  // Pulled out by id membership, never by iterating d1Rows/d1Map wholesale (spec 15 2.8 step 4): a
  // row that is both a fire and a direct/graph result is looked up separately by each side below, so
  // the result keeps its place in `matches` and the fire still appears in `standing`.
  const standing = standingArmActive
    ? await standingFiresFrom(d1Rows.filter(r => standingIds.includes(r.id as string)))
    : [];
  markStage("finalHydration");

  // Blocks of five in MMR order, each ordered by score: the first block is what a topK 5 call always returned, and a
  // later block only depends on the picks before it, so no topK can reorder a block it does not cut.
  const pickBlocks = Array.from({ length: Math.ceil(directCandidates.length / RECALL_BLOCK) }, (_, b) =>
    directCandidates.slice(b * RECALL_BLOCK, (b + 1) * RECALL_BLOCK).sort((a, c) => c.score - a.score));
  const directMatchOf = (m: VectorizeMatch, score: number): RecallMatch[] => {
    const meta = m.metadata as Record<string, any>;
    const parentId = (meta?.parentId ?? m.id) as string;
    const row = d1Map.get(parentId);
    if (!row) return [];
    const tags = JSON.parse(row.tags ?? "[]");
    const validity = validitySummary({
      createdAt: row.created_at as number,
      validFrom: row.valid_from as number | null | undefined,
      validUntil: row.valid_until as number | null | undefined,
      tags,
      supersededBy: parseSupersededBy(row.superseded_by_json as string | null | undefined),
    });
    return [{
      id: parentId,
      content: row.content as string,
      score,
      createdAt: row.created_at as number,
      updatedAt: (row.updated_at as number | null) ?? (row.created_at as number),
      tags,
      source: row.source as string,
      isUpdate: !!meta?.isUpdate,
      hop: 0,
      workspace: layerOf(identity, row.workspace_id),
      staleAsOf: hasStaleAsOf(tags),
      ...validity,
    }];
  };
  // The direct matches that hydrated, per block. Every position below is decided against these blocks and the picks
  // that made them, never against how many of them survived, and only a topK past the last block can add one.
  const blockMatches = pickBlocks.map(block => block.flatMap(m => directMatchOf(m, m.score)));
  const directMatches: RecallMatch[] = blockMatches.flat();
  // The deeper matches rank below everything above, in dense order, so their scores step down from the lowest.
  const fillFloor = directMatches.length ? Math.min(...directMatches.map(m => m.score)) : 0;
  const fillMatches = fillCandidates.flatMap((m, i) => directMatchOf(m, fillFloor * (1 - 0.01 * (i + 1))));

  // Linked memories compete with the leading picks only (first block; first two for the second slot), whatever topK
  // is. They are the picks, not the survivors: a pick that did not hydrate cannot be a linked memory either.
  const headParentIds = directParentIds.slice(0, RECALL_BLOCK);
  const leadingParentIds = directParentIds.slice(0, 2 * RECALL_BLOCK);
  const maximumRootScore = Math.max(...selectedRoots.map(x => evidenceScoreOf(x.candidate)));
  const normalizedRootDivisor = maximumRootScore > 0 ? maximumRootScore : 1;
  const rootById = new Map(selectedRoots.map(x => [x.candidate.parentId, x.candidate]));
  const rootIdByNode = new Map(selectedRoots.map(x => [x.candidate.parentId, x.candidate.parentId]));
  for (const e of expanded) {
    if (!rootById.has(e.id)) rootIdByNode.set(e.id, rootIdByNode.get(e.viaFrom) ?? e.viaFrom);
  }
  const replacement = blockMatches[0]?.[GRAPH_SLOT_INDEX];
  const replacementCoverage = replacement ? Math.max(
    queryCoverage(replacement.content, tokens, distilled).score,
    queryCoverage(replacement.content, profile.evidenceTokens, distilled).score,
  ) : 0;
  const expandedMatches: { match: RecallMatch; eligible: boolean; evidenceText: string; coverage: number }[] = expanded.flatMap((e) => {
    // A current-state continuation can point back to its cold source through
    // the system rollover edge. Keep that source available to history intent,
    // but do not let graph expansion undo the graph-candidate collapse.
    if (isCollapsedGraphRolloverJournal(e.id)) return [];
    const row = d1Map.get(e.id);
    if (!row) return [];
    const root = rootById.get(e.hop === 1 ? e.viaFrom : (rootIdByNode.get(e.viaFrom) ?? e.viaFrom));
    // Every expanded node descends from a selected seed (expandGraph walks by hop from graphSeedIds and rootIdByNode is filled
    // in that order), so a root is always found; there is no made-up parent score to fall back on. Checked by throwing at
    // this point across the integration, frozen-benchmark and unit suites and both eval variants on core-1k: never reached.
    if (!root) { internal.diagnostics?.rejections?.push({ id: e.id, reason: "no-root" }); return []; }
    const rootScore = evidenceScoreOf(root) / normalizedRootDivisor;
    const evidence = scoreLinkedEvidence({
      parentScore: rootScore,
      parentContent: root?.localEvidence ?? "",
      content: row.content as string,
      queryTokens: tokens,
      evidenceTokens: profile.evidenceTokens,
      corpus: distilled,
      hop: e.hop,
      edgeWeight: e.viaWeight,
      provenance: e.viaProvenance,
      hopDecay: cfg.GRAPH_HOP_DECAY,
      replacementCoverage,
      intent: profile.intent,
      edgeType: e.viaType,
      edgeDirection: e.viaDirection,
      queryDirection: profile.graphDirection,
    });
    if (!evidence.eligible) internal.diagnostics?.rejections?.push({ id: e.id, reason: evidence.rejection ?? "weak-neighborhood" });
    const linkedEvidence = queryRelevantWindow(
      row.content as string,
      [...tokens, ...profile.evidenceTokens],
    );
    const evidenceText = `${root?.localEvidence ?? ""}\n${linkedEvidence}`;
    const coverage = queryCoverage(evidenceText, profile.evidenceTokens, distilled).score;
    const tags = JSON.parse(row.tags ?? "[]");
    const validity = validitySummary({
      createdAt: row.created_at as number,
      validFrom: row.valid_from as number | null | undefined,
      validUntil: row.valid_until as number | null | undefined,
      tags,
      supersededBy: parseSupersededBy(row.superseded_by_json as string | null | undefined),
    });
    return [{
      eligible: evidence.eligible,
      evidenceText,
      coverage,
      match: {
        id: e.id,
        content: row.content as string,
        score: evidence.score,
        createdAt: row.created_at as number,
        updatedAt: (row.updated_at as number | null) ?? (row.created_at as number),
        tags,
        source: row.source as string,
        isUpdate: false,
        hop: e.hop,
        workspace: layerOf(identity, row.workspace_id),
        staleAsOf: hasStaleAsOf(tags),
        viaProvenance: e.viaProvenance,
        viaType: e.viaType,
        viaLinkedAt: e.viaLinkedAt,
        viaFrom: e.viaFrom,
        viaSourceId: e.viaSourceId,
        viaTargetId: e.viaTargetId,
        viaDirection: e.viaDirection,
        ...validity,
      },
    }];
  });

  const sortedExpanded = expandedMatches
    .sort((a, b) => b.match.score - a.match.score || vectorSortKey(a.match.id).localeCompare(vectorSortKey(b.match.id)));
  if (internal.diagnostics) {
    internal.diagnostics.eligibleRelatedIds = sortedExpanded
      .filter(entry => entry.eligible && !headParentIds.includes(entry.match.id))
      .map(entry => entry.match.id);
  }
  // The first linked memory must be outside the first block of picks; the second outside the first two.
  const eligibleRelated = sortedExpanded.filter(e => e.eligible && !headParentIds.includes(e.match.id)).map(e => e.match);
  const selectedRelated = [
    ...eligibleRelated.slice(0, 1),
    ...eligibleRelated.slice(1).filter(match => !leadingParentIds.includes(match.id)).slice(0, GRAPH_SLOT_INDICES.length - 1),
  ];
  const [firstRelated, secondRelated] = selectedRelated;
  const [block1 = [], block2 = [], ...laterBlocks] = blockMatches;
  // The list is laid out block by block and cut to topK at the end:
  //  - the window is exactly what a topK 5 call returns: the first block's survivors with the first linked memory in
  //    the fifth place (or the fifth survivor when there is none);
  //  - the second block follows, with the second linked memory at rank 10 (or after the block's last item when it
  //    ends sooner); a linked memory is placed against the blocks, never against how many of their picks survived;
  //  - later blocks follow, and everything a deeper dense query adds follows them.
  // A topK past a block only adds that block after everything above it, so a larger topK only appends.
  const baselineMatches: RecallMatch[] = [...block1.slice(0, firstRelated ? GRAPH_SLOT_INDEX : GRAPH_SLOT_INDEX + 1), ...(firstRelated ? [firstRelated] : [])];
  let window: RecallMatch[] = baselineMatches;
  // A direct match the evidence slot pushed out, to be shown where the chosen match used to sit if that was further down.
  let displaced: RecallMatch | undefined;
  let evidenceSlotId: string | undefined;
  if (hops > 0 && baselineMatches.length > GRAPH_SLOT_INDEX) {
    const replacementIndex = GRAPH_SLOT_INDEX;
    const replacementMatch = baselineMatches[replacementIndex];
    const replacementEvidence = queryCoverage(
      replacementMatch.content,
      profile.evidenceTokens,
      distilled,
    ).score;
    const protectedIds = new Set(baselineMatches.slice(0, replacementIndex).map(match => match.id));
    const matchById = new Map<string, RecallMatch>();
    const candidates: EvidenceSlotCandidate[] = [];
    const selectedRootIds = new Set(selectedRoots.map(selection => selection.candidate.parentId));
    const omittedChallenger = rootCandidates
      .filter(root => !selectedRootIds.has(root.parentId) && !headParentIds.includes(root.parentId))
      .filter(root => root.semanticRank !== undefined)
      .sort((a, b) => a.semanticRank! - b.semanticRank!
        || b.rootScore - a.rootScore
        || a.parentId.localeCompare(b.parentId))[0];
    const rootsForEvidence = [
      ...selectedRoots.map(selection => ({ root: selection.candidate, semanticEligible: selection.selectedBy === "semantic" })),
      ...(omittedChallenger ? [{ root: omittedChallenger, semanticEligible: true }] : []),
    ];

    for (const { root, semanticEligible } of rootsForEvidence) {
      if (headParentIds.includes(root.parentId) || protectedIds.has(root.parentId)) continue;
      const row = d1Map.get(root.parentId) ?? candidateSignalById.get(root.parentId);
      if (!row) continue;
      const rowTags = JSON.parse(row.tags ?? "[]") as string[];
      const normalizedRowTags = rowTags.map(value => value.toLowerCase());
      if (isHeld(rowTags)) continue;
      if (asOf === undefined && row.valid_until != null && row.valid_until <= now) continue;
      if (normalizedRowTags.some(value => ["auto-pattern", "auto-insight", ...(asOf === undefined ? ["status:deprecated"] : [])].includes(value))) continue;
      // validity: current: candidateSignalById's read has no validity predicate of its own — this is its only current-only check
      const rowValidUntil = (row as { valid_until?: number | null }).valid_until;
      if (rowValidUntil !== null && rowValidUntil !== undefined && Number(rowValidUntil) <= now) continue;
      if (isHeld(rowTags)) continue;
      if (tag && !normalizedRowTags.includes(tag.toLowerCase())) continue;
      if (projectFilter && !normalizedRowTags.some(value => projectTags.has(value))) continue;
      if (kind && !rowTags.includes(`kind:${kind}`)) continue;
      if (after !== undefined && Number(row.created_at) < after) continue;
      if (before !== undefined && Number(row.created_at) >= before) continue;
      const supplemental = queryCoverage(root.localEvidence, profile.evidenceTokens, distilled);
      const match: RecallMatch = {
        id: root.parentId,
        content: row.content as string,
        score: root.rootScore,
        createdAt: row.created_at as number,
        updatedAt: "last_updated" in row
          ? row.last_updated as number
          : ((row as Record<string, any>).updated_at as number | null) ?? (row.created_at as number),
        tags: rowTags,
        source: row.source as string,
        isUpdate: false,
        hop: 0,
        workspace: layerOf(identity, (row as Record<string, unknown>).workspace_id),
        staleAsOf: hasStaleAsOf(rowTags),
        // candidateSignalById's narrower projection carries no valid_from or
        // superseded_by_json; a row that fell back to it degrades to "ended"
        // rather than "replaced" if it was in fact superseded (rare: only hit
        // when a candidate escaped the full hydration read).
        ...validitySummary({
          createdAt: row.created_at as number,
          validFrom: (row as { valid_from?: number | null }).valid_from,
          validUntil: (row as { valid_until?: number | null }).valid_until,
          tags: rowTags,
          supersededBy: parseSupersededBy((row as { superseded_by_json?: string | null }).superseded_by_json),
        }),
      };
      matchById.set(match.id, match);
      candidates.push({
        id: match.id,
        coverage: supplemental.score,
        exactHighIdf: supplemental.exactHighIdf,
        exactMatchCount: exactQueryMatchCount(root.localEvidence, profile.evidenceTokens),
        metadataAlignment: root.metadataAlignment,
        score: evidenceScoreOf(root), // same scale as the linked candidates below (scoreLinkedEvidence reads the pre-blend score)
        source: "omitted-root",
        semanticRank: root.semanticRank,
        semanticEligible,
        lexicalOnly: root.semanticRank === undefined,
      });
    }

    for (const entry of sortedExpanded) {
      if (!entry.eligible || protectedIds.has(entry.match.id) || headParentIds.includes(entry.match.id)) continue;
      const precision = queryCoverage(entry.evidenceText, profile.evidenceTokens, distilled);
      matchById.set(entry.match.id, entry.match);
      candidates.push({
        id: entry.match.id,
        coverage: entry.coverage,
        exactHighIdf: precision.exactHighIdf,
        exactMatchCount: exactQueryMatchCount(entry.evidenceText, profile.evidenceTokens),
        metadataAlignment: 0,
        score: entry.match.score,
        source: "related",
      });
    }

    const chosen = chooseEvidenceSlot({
      coverage: replacementEvidence,
      semanticRank: semanticRankByParent.get(replacementMatch.id),
      semanticAllowed: replacementMatch.hop === 0,
    }, candidates);
    const chosenMatch = chosen && matchById.get(chosen.id);
    if (chosenMatch) {
      evidenceSlotId = chosenMatch.id;
      window = [...baselineMatches.slice(0, replacementIndex), chosenMatch];
      if (replacementMatch.hop === 0) displaced = replacementMatch;
    }
  }
  const taken = new Set(window.map(match => match.id));
  // One pass over what follows the window: drop what the window already shows (it moved up), and put the direct
  // match the evidence slot displaced where the chosen match used to sit, so nothing is lost.
  const follow = (list: RecallMatch[]) => list.flatMap(match => {
    if (!taken.has(match.id)) return [match];
    return displaced && match.id === window[GRAPH_SLOT_INDEX]?.id && !taken.has(displaced.id) ? [displaced] : [];
  });
  const region = follow([...block1.slice(firstRelated ? GRAPH_SLOT_INDEX : GRAPH_SLOT_INDEX + 1), ...block2]);
  const later = follow(laterBlocks.flat());
  // The second linked memory belongs to the second block: a call that stops within the first never sees it. It is
  // the request that decides, not how many picks exist, so a small brain still gets it once topK reaches the block.
  if (secondRelated && topK > RECALL_BLOCK && !taken.has(secondRelated.id)) {
    const own = later.findIndex(match => match.id === secondRelated.id);
    if (own >= 0) later.splice(own, 1); // already listed further down: it moves up to its slot
    region.splice(Math.min(GRAPH_SLOT_INDICES[1] - window.length, region.length), 0, secondRelated);
  }
  const listed = new Set([...window, ...region, ...later].map(match => match.id));
  const preCollapse = [...window, ...region, ...later, ...fillMatches.filter(match => !listed.has(match.id))];
  // Collapse runs before the final cut so duplicates do not use up a result
  // slot; the lookahead above is what leaves later candidates to fill the
  // freed position (4.4, 4.5).
  const { kept: uncollapsed, similarById } = collapseActive ? collapseNearDuplicates(preCollapse) : { kept: preCollapse, similarById: new Map<string, { id: string; createdAt: number }[]>() };
  for (const m of uncollapsed) {
    const similar = similarById.get(m.id);
    if (similar) m.similar = similar;
  }
  // The occupancy cap runs last, on the assembled list, immediately before
  // the final cut (4.3). The graph-linked-evidence slot keeps its position
  // even when collapse moved it, so its pin is resolved against this
  // (post-collapse) list, not the original one.
  const pinnedAt = evidenceSlotId ? uncollapsed.findIndex(m => m.id === evidenceSlotId) : -1;
  const uncapped = capActive ? applyOccupancyCap(uncollapsed, cfg.MIRROR_MAX_SHARE, pinnedAt >= 0 ? pinnedAt : null) : uncollapsed;
  // As-of (5.7 item 7): a belief candidate the as-of hydration predicate let through never takes a
  // ranked slot from an actually-true result; it is set aside here and appended after topK below.
  const standaloneBeliefCandidates = asOf !== undefined ? uncapped.filter(m => m.validityState === "wrong") : [];
  const trueUncapped = asOf !== undefined ? uncapped.filter(m => m.validityState !== "wrong") : uncapped;
  let matches = trueUncapped.slice(0, topK);
  if (explain) {
    // Only what the stages above already computed: nothing is queried or scored here.
    const multipliers = new Map<string, { multipliers: RankMultipliers; ageKnown: boolean }>();
    for (const t of [...(directTraced ?? []), ...rootTraced]) {
      const id = parentOfMatch(t.match);
      if (!multipliers.has(id)) multipliers.set(id, t);
    }
    const fillIds = new Set(fillMatches.map(match => match.id));
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    for (const m of matches) {
      const applied = multipliers.get(m.id);
      const percentile = rerank.percentiles?.get(m.id);
      const slot: WhySlot = m.id === evidenceSlotId ? "evidence" : m.hop > 0 ? "linked" : fillIds.has(m.id) ? "deeper" : "direct";
      const why: WhyTrace = {
        dense_rank: displayedDenseRank.get(m.id) ?? null,
        keyword_terms: (keywordTrace?.get(m.id) ?? []).map(t => ({ term: t.term, level: t.level, idf: r3(t.idf) })),
        multipliers: applied ? Object.fromEntries(Object.entries(applied.multipliers).map(([k, v]) => [k, r3(v)])) as unknown as RankMultipliers : null,
        rerank_percentile: percentile === undefined ? null : r3(percentile),
        rerank_move: rerankMove.get(m.id) ?? null,
        age_known: applied ? applied.ageKnown : null,
        graph: m.hop > 0 && m.viaProvenance && m.viaType && m.viaFrom ? { provenance: m.viaProvenance, type: m.viaType, from: m.viaFrom } : null,
        slot,
      };
      m.why = why;
    }
  }
  graphContribution.eligibleCount = eligibleRelated.length;
  const finalDirectIds = new Set(matches.filter(match => match.hop === 0).map(match => match.id));
  const finalRelated = matches.filter(match => match.hop > 0);
  graphContribution.selectedCount = finalRelated.length;
  if (internal.diagnostics) internal.diagnostics.selectedRelatedIds = finalRelated.map(x => x.id);
  if (internal.diagnostics) internal.diagnostics.finalIds = matches.map(match => match.id);
  markStage("selection");

  const presentedDirectIds = finalDirectIds;
  const recalledAt = Date.now();
  const recallScope = identity
    ? scopeWhereForRead(identity, { layer: internal.workspaceFilter, teamId: internal.teamId })
    : null;
  // 返却したdirect行の計数は1 SQL。多数workspaceも1つのJSON bindへ固定する。
  if (presentedDirectIds.size) ctx.waitUntil(
    env.DB.prepare(
      // scope-checked: scopeWhereForReadが認可したworkspace集合をJSON bindで再検査する。
      // versioning: exempt: recall回数・最終参照時刻のみ。
      `UPDATE entries SET recall_count = recall_count + 1, last_recalled_at = ?, write_marker = ?
        WHERE id IN (SELECT value FROM json_each(?))${recallScope ? " AND workspace_id IN (SELECT value FROM json_each(?))" : ""}`,
    ).bind(recalledAt, memoryWriteMarker(env), JSON.stringify([...presentedDirectIds]),
      ...(recallScope ? [JSON.stringify(recallScope.bindings)] : [])).run()
      .catch(e => console.error("recall_count update failed (non-fatal):", e)),
  );
  // T-0089.5.2 Part A: opt-in (RECALL_LOG, off by default everywhere) and sampled — a
  // no-op below cfg.RECALL_LOG === "on", so this costs nothing on every brain that never
  // turns it on. Never touches `matches`, so ranking is unaffected either way.
  // Part C (05-proof.md, T-0089.5.3): pre-generated here so the response's receipt matches
  // the row this write might land, with no read-back. The write itself stays fire-and-forget
  // (ctx.waitUntil), so a call that loses the daily-cap race still returns this receipt, just
  // with no row behind it — the same "sampled" honesty the log itself already has.
  const receipt = cfg.RECALL_LOG === "on" ? crypto.randomUUID() : receiptHash(query, now);
  ctx.waitUntil(maybeLogRecall(env, cfg, {
    id: receipt,
    workspaceId: identity?.personalWorkspaceId ?? "",
    channel: params.channel ?? "rest",
    query,
    params: { topK, tag: tag ?? null, after: after ?? null, before: before ?? null, kind: kind ?? null, hops, project: params.project?.map(p => p.id) ?? null },
    returnedIds: matches.map(m => m.id),
    now,
  }));

  const maxScore = matches.reduce((mx, m) => Math.max(mx, m.score), 0);
  if (maxScore > 0) for (const m of matches) m.score = m.score / maxScore;

  if (identity) {
    const actorIdFor = (id: string): string =>
      (d1Map.get(id)?.actor_id as string | undefined)
      ?? (candidateSignalById.get(id) as { actor_id?: string } | undefined)?.actor_id
      ?? "";
    const companyMatches = matches.filter((m) => m.workspace === "company");
    const labelMap = await lookupActorLabels(env, companyMatches.map((m) => actorIdFor(m.id)));
    for (const m of companyMatches) {
      m.actorName = resolveActorLabel(actorIdFor(m.id), labelMap, { viewerId: identity.userId, source: m.source });
    }
  }

  // As-of (5.7 items 5-8): the one extra D1 execution, reconstructing text/status at T and
  // attaching retracted beliefs, appended after every actually-true result — never above one.
  let asOfHeader: RecallSearchResult["asOf"];
  if (asOf !== undefined) {
    const enriched = await enrichWithAsOf(matches, standaloneBeliefCandidates, asOf, env, identity, { workspaceFilter: internal.workspaceFilter, teamId: internal.teamId });
    matches = [...enriched.trueMatches, ...enriched.beliefMatches];
    const versionsSince = await getVersionsSince(env);
    asOfHeader = { at: asOf, notRecordedBefore: asOf < versionsSince ? versionsSince : null };
  }

  const compoundStale = computeCompoundStale(matches);

  // T-0102 (final cloud review, MAJOR class): as-of's own redaction already empties `content` for
  // a held-at-T match (resolveAtT), but an entry with no text to add is still noise in a synthesis
  // prompt -- drop it here rather than pass an empty-content row through, so the model never even
  // sees a marker that something was hidden.
  const synthesizable = matches.filter(m => !m.asOfHeld);
  const insight = synthesize && synthesizable.length > 1
    ? await synthesizeInsight(query, synthesizable.map(m => ({ id: m.id, content: m.content })), env, cfg)
    : "";

  markStage("synthesis");
  if (internal.diagnostics) {
    internal.diagnostics.stageMs ??= {};
    internal.diagnostics.stageMs.total = performance.now() - totalStartedAt;
  }

  return { matches, insight, ...semanticState(), queryUsed: lexicalQuery, queryTokens: tokens,
    currentQueryTokens: profile.intent === "current" && after === undefined && before === undefined
      ? withoutContainedCjkBigrams(profile.evidenceTerms.filter(term => /\d/.test(term.value)
        || (!!distilled.total && (distilled.df?.get(term.value) ?? 0) > 0
          && distilled.df!.get(term.value)! / distilled.total <= QUERY_SATURATION_FRACTION)))
        .map(term => term.value)
      : undefined,
    compoundStale, graphContribution, receipt, ...(asOfHeader ? { asOf: asOfHeader } : {}), ...(standing.length ? { standing } : {}) };
}

export async function recallEntries(
  params: RecallParams,
  env: Env,
  ctx: ExecutionContext,
  config?: Readonly<Config>,
  internal: RecallInternalOptions = {},
): Promise<RecallSearchResult> {
  env = chatGptEnvForWorkspaces(env, internal.identity
    ? readScopeWorkspaces(internal.identity, { layer: internal.workspaceFilter, teamId: internal.teamId }) : []);
  const startedAt = performance.now();
  try {
    const result = await runRecallEntries(params, env, ctx, config, internal);
    logEvent("recall_complete", {
      operation: "recall",
      outcome: "success",
      duration_ms: durationMs(startedAt),
      candidate_count: result.matches.length,
      fallback_used: result.semanticUnavailable,
      graph_hops: result.graphContribution.requestedHops,
      graph_seed_count: result.graphContribution.seedCount,
      graph_expanded_count: result.graphContribution.expandedCount,
      graph_eligible_count: result.graphContribution.eligibleCount,
      graph_selected_count: result.graphContribution.selectedCount,
      query_signal_cache_hit: result.querySignalCacheHit,
      lineage_fallback_used: result.lineageFallbackUsed,
    });
    return result;
  } catch (error) {
    logErrorEvent("recall_complete", {
      operation: "recall",
      outcome: "error",
      duration_ms: durationMs(startedAt),
      error_name: errorName(error),
    });
    throw error;
  }
}
