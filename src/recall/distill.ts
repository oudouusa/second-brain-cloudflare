import { CONTENT_LIKE_ESCAPE, contentLikePattern } from "../text/like";
import type { Env } from "../env";
import { DEFAULTS, type Config } from "../config";
import {
  D1_MAX_BOUND_PARAMS,
  FTS_MATCH_BUDGET,
  FTS_SHORT_TOKEN_SAMPLE,
  KEYWORD_MAX_TOKENS,
  MAX_QUERY_TERMS,
  QUERY_SATURATION_FRACTION,
} from "../constants";
import {
  likeContainsPattern,
  QUERY_LIKE_ESCAPE,
  tokenizeQueryDetailed,
  withoutContainedCjkBigrams,
  type LexicalToken,
} from "../text/lexical-query";
import type { Identity } from "../lib/identity";
import { scopeWhereForRead, type ScopeClause } from "../lib/scope";
import { extractHashtags } from "../text/hashtags";
import { isTopicTag } from "../compression/eligibility";
import { getTagVocabulary } from "../tags/vocabulary";
import { deterministicVariants } from "./query-profile";
import { FTS_LIVENESS_SQL, ftsCountSafeToken, ftsEligibleToken, ftsMatchQuery, ftsReady, ftsShortToken, isFtsLiveRows } from "./fts";

/**
 * `ctx` is optional only so this stays callable from tests and any future internal
 * caller; pass it wherever there is one, or an aged-out vocabulary is rebuilt on the
 * request's own critical path instead of behind it.
 */
export async function inferQueryTags(query: string, env: Env, ctx?: ExecutionContext, identity?: Identity, only?: "personal" | "company", teamId?: string): Promise<string[]> {
  const { hashtags } = extractHashtags(query);
  if (hashtags.length) return hashtags;

  // Cached (#288): this used to be a full table scan expanded per tag per row, on
  // every recall, and it was 82% of a recall's read cost.
  //
  // System tags are dropped rather than matched against. They say what the system
  // did to an entry, not what it is about, and the only thing a query tag does is
  // boost entries whose subject overlaps the question. Two of them — `auto-pattern`
  // and `status:deprecated` — name entries that recall's hydration filter removes
  // outright, so a boost they win is spent on rows that are then discarded. They are
  // also applied in bulk (the staleness pass alone writes `volatility:` and
  // `stale:as-of` across up to 25 entries a night), which makes them the highest-
  // count tags in a mature brain and exactly the ones that would crowd real topics
  // out of the 50 the LLM below is shown. The same predicate #278 used to keep them
  // out of digest candidates, so the two agree by construction.
  const knownTags = (await getTagVocabulary(env, ctx, identity, only, teamId)).filter(isTopicTag);

  const lowerQuery = query.toLowerCase();
  const keywordMatches = knownTags.filter(t =>
    new RegExp(`(?<![\\w-])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(lowerQuery)
  );

  return keywordMatches;
}

/**
 * The distilled query plus the corpus statistics the distillation already paid
 * for. `df` maps every scanned (normalized, lowercase) term to the number of
 * entries containing it, and `total` is the corpus row count — the real IDF
 * inputs, which fuseDenseAndKeyword would otherwise re-estimate from its
 * fetched sample. Both are null on every path that skipped or lost the scan,
 * so a consumer can trust that non-null stats are complete.
 */
export interface DistilledQuery {
  query: string;
  df: Map<string, number> | null;
  total: number | null;
  /** Present for runtime-produced queries; optional keeps fixture callers thin. */
  terms?: LexicalToken[];
  distillSource?: "fts" | "like" | "scan" | "shortcut";
}

export interface TimeBounds {
  after?: number;
  before?: number;
}

/** Shared by both the FTS and LIKE df sources so their ranking can never drift apart. */
function rankAndRebuild(
  uniq: string[],
  content: string[],
  tokensOf: Map<string, string[]>,
  df: Map<string, number>,
  total: number,
  // Terms whose df is a sampled guess, not a count (T-0074's short-token sample). They fill
  // slots the counted terms leave, never take one from them: a sample of the
  // newest rows can be wrong about the whole corpus in either direction.
  estimated: ReadonlySet<string> = new Set(),
): string {
  let candidates = uniq.filter(t => (df.get(t) ?? 0) / total <= QUERY_SATURATION_FRACTION);
  if (!candidates.length) candidates = uniq;
  const keep = new Set(
    [...candidates]
      .sort((a, b) => Number(estimated.has(a)) - Number(estimated.has(b)) || (df.get(a) ?? 0) - (df.get(b) ?? 0))
      .slice(0, MAX_QUERY_TERMS)
  );
  const rebuilt = [...new Set(content.filter(w => tokensOf.get(w)!.some(t => keep.has(t))))];
  return rebuilt.length ? rebuilt.join(" ") : content.join(" ");
}

/**
 * One term's scoped, time-bounded df, capped at the saturation point. LIKE is the one definition of df, on every route: the
 * trigram index folds some content characters LIKE does not (the Kelvin sign to "k", long s to "s"), so MATCH finds a superset
 * of LIKE's rows for a term of three or more characters, and MATCH AND LIKE is exactly LIKE, read through the index.
 */
function ftsTermCountStmt(
  env: Env,
  term: string,
  bounds: Readonly<TimeBounds>,
  scope: ScopeClause | null,
  cap: number,
) {
  const match = ftsMatchQuery([term])!; // pre-filtered eligible by the caller
  let timeWhere = "";
  const timeBindings: number[] = [];
  if (bounds.after !== undefined) { timeWhere += " AND e.created_at >= ?"; timeBindings.push(bounds.after); }
  if (bounds.before !== undefined) { timeWhere += " AND e.created_at < ?"; timeBindings.push(bounds.before); }
  const scopeSql = scope ? ` AND ${scope.clause}` : "";
  // scope-checked: the caller's clause IS applied — scopeSql is built as ` AND ${scope.clause}` above and appended here; the lexer sees only the fragment name. workspace_id exists only on entries, not on entries_fts's id/content columns, so the unqualified column in scope.clause resolves unambiguously to e.workspace_id in this join, same as keywordSearchFts in search.ts
  return env.DB.prepare(
    `SELECT count(*) AS n FROM (
       SELECT 1 FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid AND e.id = entries_fts.id
       WHERE entries_fts MATCH ? AND e.content LIKE ? ${CONTENT_LIKE_ESCAPE}${timeWhere}${scopeSql}
       LIMIT ?
     )`
  ).bind(match, contentLikePattern(term), ...timeBindings, ...(scope?.bindings ?? []), cap);
}

/** Scoped, time-bounded COUNT(*), batched with the liveness check (one subrequest). Time-bounded callers only — entry_counts has no time dimension. */
async function ftsScopedTotal(
  env: Env,
  bounds: Readonly<TimeBounds>,
  scope: ScopeClause | null,
): Promise<{ liveness: { name: string; sql: string | null }[] | undefined; total: number }> {
  let where = "";
  const bindings: number[] = [];
  if (bounds.after !== undefined) { where += " created_at >= ?"; bindings.push(bounds.after); }
  if (bounds.before !== undefined) { where += `${where ? " AND" : ""} created_at < ?`; bindings.push(bounds.before); }
  if (scope) where += `${where ? " AND" : ""} ${scope.clause}`;
  // scope-checked: the caller's clause IS applied when an identity is present — it is appended into `where` above; the lexer cannot see into a JS-assembled fragment
  const [livenessResult, totalResult] = await env.DB.batch([
    env.DB.prepare(FTS_LIVENESS_SQL),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM entries${where ? ` WHERE${where}` : ""}`)
      .bind(...bindings, ...(scope?.bindings ?? [])),
  ]);
  const totalRow = totalResult.results?.[0] as Record<string, number> | undefined;
  return {
    liveness: livenessResult.results as { name: string; sql: string | null }[] | undefined,
    total: (totalRow?.total as number) ?? 0,
  };
}

/**
 * The read-cost cap on a term's FTS count. Saturation alone (30% of the
 * corpus) is not enough: keywordSearch's cost router (T-0058) sums these same
 * df values against FTS_MATCH_BUDGET, an ABSOLUTE match-count threshold
 * unrelated to corpus size. On a corpus under ~6,700 rows, 30% is smaller than
 * the budget, so capping at the saturation point alone would report a common
 * term as cheaper than it is and route an expensive query to FTS. Flooring
 * the cap at FTS_MATCH_BUDGET + 1 keeps every count exact through the budget's
 * own threshold — the only range the router's `dfSum > FTS_MATCH_BUDGET`
 * comparison depends on — while still bounding the read on a saturating term
 * in a large corpus.
 */
function saturationCap(total: number): number {
  return Math.max(Math.floor(QUERY_SATURATION_FRACTION * total) + 1, FTS_MATCH_BUDGET + 1);
}

/**
 * T-0065: entry_counts' exact, O(1) total for the SAME scope, embedded as a
 * scalar subquery rather than passed as a JS-computed cap — the cap needs
 * total first, and embedding it lets total, every per-term count, AND the
 * liveness check ride in ONE batch (see distillViaFts) instead of a second
 * round trip. CAST(...AS INTEGER) truncates like Math.floor for the
 * non-negative totals here, and multi-arg max() is SQLite's scalar (not
 * aggregate) max, matching saturationCap's formula exactly.
 */
function saturationCapSql(scope: ScopeClause | null): { sql: string; bindings: string[] } {
  const scopeSql = scope ? ` WHERE ${scope.clause}` : "";
  return {
    sql: `(SELECT max(CAST(${QUERY_SATURATION_FRACTION} * COALESCE(SUM(n), 0) AS INTEGER) + 1, ${FTS_MATCH_BUDGET + 1}) FROM entry_counts${scopeSql})`,
    bindings: scope?.bindings ?? [],
  };
}

/** entry_counts' exact, unbounded, scoped total — no time dimension, no cache needed: it costs the same cold or warm. */
function entryCountsTotalStmt(env: Env, scope: ScopeClause | null) {
  const scopeSql = scope ? ` WHERE ${scope.clause}` : "";
  return env.DB.prepare(`SELECT COALESCE(SUM(n), 0) AS total FROM entry_counts${scopeSql}`).bind(...(scope?.bindings ?? []));
}

/** The caller's readable corpus size (entry_counts, exact and O(1)); null when the counter is unavailable. One statement. */
export async function scopedEntryTotal(env: Env, scope: ScopeClause | null): Promise<number | null> {
  try {
    const row = await entryCountsTotalStmt(env, scope).first<{ total: number }>();
    return typeof row?.total === "number" ? row.total : null;
  } catch {
    return null;
  }
}

/** One term's scoped df (MATCH AND LIKE, see ftsTermCountStmt), capped via a SQL subquery on entry_counts (see saturationCapSql) rather than a JS-bound number. No time bounds: those callers use ftsTermCountStmt/ftsScopedTotal instead. */
function ftsTermCountStmtSqlCap(env: Env, term: string, scope: ScopeClause | null) {
  const match = ftsMatchQuery([term])!; // pre-filtered eligible by the caller
  const scopeSql = scope ? ` AND ${scope.clause}` : "";
  const cap = saturationCapSql(scope);
  // scope-checked: the caller's clause IS applied, twice — once in scopeSql
  // (the row filter) and once inside cap.sql (entry_counts' own scope); the
  // lexer sees only the fragment names, both are `scope.clause`.
  return env.DB.prepare(
    `SELECT count(*) AS n FROM (
       SELECT 1 FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid AND e.id = entries_fts.id
       WHERE entries_fts MATCH ? AND e.content LIKE ? ${CONTENT_LIKE_ESCAPE}${scopeSql}
       LIMIT ${cap.sql}
     )`
  ).bind(match, contentLikePattern(term), ...(scope?.bindings ?? []), ...cap.bindings);
}

/**
 * A term's distinct trigrams, folded as the trigram tokenizer folds a count-safe term. Every row holding the term holds each
 * of them, so the smallest document count among them in entries_fts_vocab bounds the term's df from above.
 */
export function probeTrigrams(term: string): string[] {
  const cs = [...term.toLowerCase()];
  return [...new Set(cs.slice(2).map((_, i) => cs.slice(i, i + 3).join("")))];
}

/** The most vocabulary lookups one price may take: each reads its trigram's whole doclist (about 0.5 ms at 100k entries). */
const PRICE_MAX_LOOKUPS = 24;

/**
 * The price's lookups, in the order they are taken: one distinct trigram each, with the terms it bounds. Round-robin across
 * terms (each term's first and last trigram, then its middles), so every term's bound starts falling early.
 */
function priceSteps(terms: string[]): { trigram: string; terms: number[] }[] {
  const queues = terms.map(t => {
    const all = probeTrigrams(t);
    const middles = all.slice(1, -1);
    const ordered = all.length <= 2 ? all : [all[0], all[all.length - 1]];
    while (middles.length) ordered.push(middles.splice(Math.floor(middles.length / 2), 1)[0]);
    return ordered;
  });
  const steps = new Map<string, number[]>();
  for (let round = 0; queues.some(q => round < q.length); round++) {
    queues.forEach((q, k) => { if (round < q.length) steps.set(q[round], [...(steps.get(q[round]) ?? []), k]); });
  }
  return [...steps].map(([trigram, ks]) => ({ trigram, terms: [...new Set(ks)] }));
}

/**
 * Every term's df in one statement, from whichever source reads fewer rows. The per-term FTS counts read about two rows per
 * match (the index row and the entries row it joins), up to the saturation cap; one LIKE pass over the scope reads its total.
 * Both apply LIKE as the definition of df (see ftsTermCountStmt), and the caller caps the pass's counts as the counts route
 * caps them, so the route decides the cost and never the df.
 *
 * The price: a term's matches are bounded by its trigrams' document counts in entries_fts_vocab, which count every workspace,
 * so each is scaled by the scope's share of all entries. The pass is taken when these bounds, capped, still sum past the
 * scope's total once every trigram is read, that is when the counts would read at least twice what the pass reads; the
 * margin absorbs a loose bound (common trigrams, rare word). Lookups are lazy (a recursive walk takes the next trigram only
 * while the sum is still past the total), so a query that cannot reach the pass stops early, and one needing more than
 * PRICE_MAX_LOOKUPS keeps the counts without reading the vocabulary.
 *
 * Columns: total, n0..n<k-1> (null on the pass), and `scanned` (null on the counts), a JSON array [COUNT(*), d0..d<k-1>].
 * Null when the binds pass D1's limit.
 */
type DfRoute = "priced" | "counts" | "pass";

function dfCountsStmt(env: Env, terms: string[], scope: ScopeClause | null, route: DfRoute): D1PreparedStatement | null {
  const steps = route === "priced" ? priceSteps(terms) : [];
  if (steps.length > PRICE_MAX_LOOKUPS) return dfCountsStmt(env, terms, scope, "counts");
  const binds: unknown[] = [];
  const bind = (v: unknown) => `?${binds.push(v)}`;
  // Scope values are bound once and referenced by number from every subquery.
  const clause = scope ? scope.clause.replace(/\?/g, (i => () => bind(scope.bindings[i++]))(0)) : "";
  const whereScope = clause ? ` WHERE ${clause}` : "";
  const andScope = clause ? ` AND ${clause}` : "";
  // walk row i holds every term's bound m<k> with lookups 0..i-1 applied, and `e`, lookup i, taken only while their sum is
  // past the total. It ends with the lookups, so a price that settles early reads few rows.
  const bounds = terms.map((_, k) => `m${k}`);
  const trigrams = bind(JSON.stringify(steps.map(st => st.trigram)));
  const masks = bind(JSON.stringify(steps.map(st => st.terms.reduce((mask, k) => mask | (1 << k), 0))));
  const lookup = (i: string) =>
    `min(cap, coalesce((SELECT doc FROM entries_fts_vocab WHERE term = json_extract(${trigrams}, '$[' || (${i}) || ']')), 0) * total / everyone)`;
  const next = bounds.map((m, k) => `CASE WHEN (json_extract(${masks}, '$[' || w.i || ']') >> ${k}) & 1 THEN min(${m}, e) ELSE ${m} END`);
  // total, cap and everyone ride along in each row: reading g once per step would cost a row each.
  const walk = `walk(i, total, cap, everyone, ${bounds.join(", ")}, e) AS (
       SELECT 0, total, cap, everyone, ${bounds.map(() => "cap").join(", ")}, CASE WHEN ${terms.length} * cap > total THEN ${lookup("0")} END FROM g
       UNION ALL
       SELECT w.i + 1, total, cap, everyone, ${next.join(", ")},
         CASE WHEN ${next.join(" + ")} > total AND w.i + 1 < ${steps.length} THEN ${lookup("w.i + 1")} END
       FROM walk w WHERE w.e IS NOT NULL
     )`;
  const priced = route === "priced" && steps.length > 0;
  const price = priced
    // The sum only falls as lookups land, so its minimum is the last row's.
    ? `(SELECT min(${bounds.join(" + ")}) > total FROM walk)`
    : route === "pass" ? "1" : "0";
  // One LIKE pattern per term, shared by its count and the pass, so both routes apply the same definition of df.
  const like = terms.map(t => bind(contentLikePattern(t)));
  const counts = terms.map((t, i) =>
    // scope-checked: the caller's clause IS applied through andScope (scope.clause, placeholders numbered), same join as ftsTermCountStmt
    `CASE WHEN scan THEN NULL ELSE (SELECT count(*) FROM (SELECT 1 FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid AND e.id = entries_fts.id WHERE entries_fts MATCH ${bind(ftsMatchQuery([t])!)} AND e.content LIKE ${like[i]} ${CONTENT_LIKE_ESCAPE}${andScope} LIMIT (SELECT cap FROM g))) END AS n${i}`);
  const sums = like.map(p => `SUM(CASE WHEN content LIKE ${p} ${CONTENT_LIKE_ESCAPE} THEN 1 ELSE 0 END)`).join(", ");
  // scope-checked: the caller's clause IS applied to entry_counts, to each FTS count's entries join and to the pass, through
  // whereScope/andScope, which are scope.clause with its placeholders numbered; the lexer sees only the fragment names.
  // `everyone` is unscoped on purpose: it only scales the vocabulary's all-workspace counts, and never reaches a result.
  const sql = `WITH RECURSIVE g AS MATERIALIZED (
       SELECT total, everyone, max(CAST(${QUERY_SATURATION_FRACTION} * total AS INTEGER) + 1, ${FTS_MATCH_BUDGET + 1}) AS cap
       FROM (${priced
         // One read of entry_counts for both: the scope's total and, to scale the all-workspace vocabulary, everyone's.
         ? `SELECT COALESCE(SUM(CASE WHEN ${clause || "1"} THEN n END), 0) AS total, max(COALESCE(SUM(n), 0), 1) AS everyone FROM entry_counts`
         : `SELECT COALESCE(SUM(n), 0) AS total, 1 AS everyone FROM entry_counts${whereScope}`})
     ),${priced ? `\n     ${walk},` : ""}
     p AS MATERIALIZED (SELECT total, cap, ${price} AS scan FROM g)
     SELECT total, ${counts.join(", ")},
       CASE WHEN scan THEN (SELECT json_array(COUNT(*), ${sums}) FROM entries${whereScope}) END AS scanned
     FROM p`;
  if (binds.length <= D1_MAX_BOUND_PARAMS) return env.DB.prepare(sql).bind(...binds);
  return route === "priced" ? dfCountsStmt(env, terms, scope, "counts") : null;
}

/**
 * T-0074: a too-short token's df, estimated from the newest
 * FTS_SHORT_TOKEN_SAMPLE readable rows. The index cannot count it and the
 * exact count reads the whole partition. The sample is a bounded read that
 * usually tells a saturated substring ("io", "am") from a specific word ("ox",
 * a two-character CJK word), but it sees only recent rows, so on a corpus whose
 * recent rows differ from the rest it can be wrong either way. That is why
 * rankAndRebuild never lets it outrank a counted term.
 */
function shortTermSampleStmt(env: Env, terms: string[], bounds: Readonly<TimeBounds>, scope: ScopeClause | null) {
  const conds: string[] = [];
  const timeBindings: number[] = [];
  if (bounds.after !== undefined) { conds.push("created_at >= ?"); timeBindings.push(bounds.after); }
  if (bounds.before !== undefined) { conds.push("created_at < ?"); timeBindings.push(bounds.before); }
  if (scope) conds.push(scope.clause);
  const sums = terms.map((_, i) => `COALESCE(SUM(CASE WHEN content LIKE ? ${CONTENT_LIKE_ESCAPE} THEN 1 ELSE 0 END), 0) AS d${i}`).join(", ");
  // scope-checked: the caller's clause IS applied when an identity is present — it is pushed into `conds` above; the lexer cannot see into a JS-assembled fragment
  return env.DB.prepare(
    `SELECT COUNT(*) AS n, ${sums} FROM (SELECT content FROM entries${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?)`
  ).bind(...terms.map(contentLikePattern), ...timeBindings, ...(scope?.bindings ?? []), FTS_SHORT_TOKEN_SAMPLE);
}

/**
 * T-0059/T-0065: df/total via the FTS index instead of a full LIKE scan.
 * No time bounds (the common case): entry_counts' total is exact and O(1),
 * so total, every per-term count, and the liveness check ride in ONE batch
 * always — cold costs the same as warm, and there is no cache to go stale.
 * Time-bounded calls keep the two-batch shape (liveness+total, then counts
 * with a JS-computed cap): entry_counts has no time dimension, so their
 * total still comes from a scoped, bounded COUNT(*) on entries. Returns null
 * on any disqualifier (index not live, empty corpus) so the caller falls
 * back to the existing LIKE statement.
 */
async function distillViaFts(
  dfTerms: string[],
  shortTerms: string[],
  env: Env,
  bounds: Readonly<TimeBounds>,
  scope: ScopeClause | null,
): Promise<{ df: Map<string, number>; total: number; scanned?: { df: Map<string, number>; total: number } } | null> {
  const hasBounds = bounds.after !== undefined || bounds.before !== undefined;

  let total: number;
  let liveness: { name: string; sql: string | null }[] | undefined;
  let countResults: { results?: unknown[] }[];
  let scanned: { df: Map<string, number>; total: number } | undefined;

  // A short term's df is sampled on the FTS route only, so its query keeps the counts.
  const combined = hasBounds ? null : dfCountsStmt(env, dfTerms, scope, shortTerms.length ? "counts" : "priced");
  if (combined) {
    const results = await env.DB.batch([
      env.DB.prepare(FTS_LIVENESS_SQL),
      combined,
      ...(shortTerms.length ? [shortTermSampleStmt(env, shortTerms, bounds, scope)] : []),
    ]);
    liveness = results[0].results as { name: string; sql: string | null }[] | undefined;
    const row = (results[1].results?.[0] ?? {}) as Record<string, unknown>;
    total = (row.total as number) ?? 0;
    countResults = [
      ...dfTerms.map((_, i) => ({ results: [{ n: row[`n${i}`] }] })),
      ...results.slice(2),
    ];
    if (typeof row.scanned === "string") {
      const [scanTotal, ...counts] = JSON.parse(row.scanned) as (number | null)[];
      const cap = saturationCap(total);
      const exact = new Map(dfTerms.map((t, i) => [t, counts[i] ?? 0]));
      // Capped as the FTS counts would be: min(df, cap) is exactly what a LIMIT cap count returns.
      countResults = dfTerms.map(t => ({ results: [{ n: Math.min(exact.get(t)!, cap) }] }));
      scanned = { df: exact, total: scanTotal ?? 0 };
    }
  } else if (!hasBounds) {
    const results = await env.DB.batch([
      env.DB.prepare(FTS_LIVENESS_SQL),
      entryCountsTotalStmt(env, scope),
      ...dfTerms.map(t => ftsTermCountStmtSqlCap(env, t, scope)),
      ...(shortTerms.length ? [shortTermSampleStmt(env, shortTerms, bounds, scope)] : []),
    ]);
    liveness = results[0].results as { name: string; sql: string | null }[] | undefined;
    const totalRow = results[1].results?.[0] as Record<string, number> | undefined;
    total = (totalRow?.total as number) ?? 0;
    countResults = results.slice(2);
  } else {
    const scoped = await ftsScopedTotal(env, bounds, scope);
    liveness = scoped.liveness;
    total = scoped.total;
    if (!isFtsLiveRows(liveness) || !total) return null;
    const cap = saturationCap(total);
    countResults = await env.DB.batch([
      ...dfTerms.map(t => ftsTermCountStmt(env, t, bounds, scope, cap)),
      ...(shortTerms.length ? [shortTermSampleStmt(env, shortTerms, bounds, scope)] : []),
    ]);
  }

  if (!isFtsLiveRows(liveness) || !total) return null;
  const df = new Map(dfTerms.map((t, i) => {
    const row = countResults[i].results?.[0] as Record<string, number> | undefined;
    return [t, (row?.n as number) ?? 0];
  }));
  if (shortTerms.length) {
    const sample = countResults[dfTerms.length].results?.[0] as Record<string, number> | undefined;
    const n = sample?.n ?? 0;
    // Laplace-smoothed so an unseen token reads as rare-but-possible, not as absent from the corpus (which would inflate its IDF past any counted term's).
    shortTerms.forEach((t, i) => df.set(t, Math.min(total, Math.ceil((((sample?.[`d${i}`] ?? 0) + 1) * total) / (n + 2)))));
  }
  return { df, total, scanned };
}

function rebuildFromCounts(
  uniq: LexicalToken[], terms: LexicalToken[], content: string[],
  df: Map<string, number>, total: number, source: "fts" | "like" | "scan",
  estimated: ReadonlySet<string> = new Set(),
): DistilledQuery {
  // A token absent from the corpus cannot retrieve a row. CJK fallback
  // bigrams can cross a grammatical boundary (for example "じロ") and df=0
  // previously made those impossible terms look maximally discriminative,
  // consuming all three rare-term slots ahead of observed subject words.
  let candidates = uniq.map(term => term.value).filter(t => {
    const frequency = df.get(t) ?? 0;
    return frequency > 0 && frequency / total <= QUERY_SATURATION_FRACTION;
  });
  if (!candidates.length) {
    const observed = uniq.map(term => term.value).filter(t => (df.get(t) ?? 0) > 0);
    candidates = observed.length ? observed : uniq.map(term => term.value);
  }
  // 観測済みの単語と、その部分一致用bigramで複数の枠を使わない。
  // 単語が候補に残らなければbigramを維持し、従来の部分一致を救済する。
  const candidateSet = new Set(candidates);
  candidates = withoutContainedCjkBigrams(uniq.filter(term => candidateSet.has(term.value)))
    .map(term => term.value);
  const ranked = [...candidates].sort((a, b) => Number(estimated.has(a)) - Number(estimated.has(b)) || (df.get(a) ?? 0) - (df.get(b) ?? 0));
  // 既存の3枠のうち最大1枠を、観測済みで非頻出の構造付き識別子に割り当てる。
  // 単なる略語は対象外。質問の語尾や動詞でissue番号・path等を落とさない。
  // 通常候補へのfallback時も、未観測・頻出の識別子は優先しない。
  const anchor = ranked.find(value => uniq.some(term =>
    term.value === value && term.kind === "protected" && /[\d@#./:_-]/u.test(value)
    && (df.get(value) ?? 0) > 0 && df.get(value)! / total <= QUERY_SATURATION_FRACTION
  ));
  const keep = new Set(
    (anchor ? [anchor, ...ranked.filter(value => value !== anchor)] : ranked).slice(0, MAX_QUERY_TERMS)
  );
  const rebuiltTerms = terms.filter(term => keep.has(term.value));
  const rebuilt = rebuiltTerms.map(term => term.value);
  return {
    query: rebuilt.length ? rebuilt.join(" ") : content.join(" "),
    df,
    total,
    terms: rebuilt.length ? rebuiltTerms : terms,
    distillSource: source,
  };
}

export async function distillToRareTerms(
  query: string,
  env: Env,
  config: Readonly<Config> = DEFAULTS,
  bounds: Readonly<TimeBounds> = {},
  identity?: Identity,
  only?: "personal" | "company",
  teamId?: string,
): Promise<DistilledQuery> {
  const terms = tokenizeQueryDetailed(query);
  const content = terms.map(term => term.value);
  if (content.length === 0) {
    return { query: content.length ? content.join(" ") : query, df: null, total: null, terms, distillSource: "shortcut" };
  }

  const scope = identity ? scopeWhereForRead(identity, { layer: only, teamId }) : null;
  let where = "";
  const timeBindings: number[] = [];
  if (bounds.after !== undefined) {
    where += " created_at >= ?";
    timeBindings.push(bounds.after);
  }
  if (bounds.before !== undefined) {
    where += `${where ? " AND" : ""} created_at < ?`;
    timeBindings.push(bounds.before);
  }
  if (scope) {
    where += `${where ? " AND" : ""} ${scope.clause}`;
  }

  // Every term gets its normalized primary probe first. Compatibility probes
  // are added only from the remaining D1 variable budget, so a user with many
  // readable team workspaces cannot turn the optional NFKC rescue into a 100-
  // parameter failure.
  const probeBudget = Math.max(
    0,
    D1_MAX_BOUND_PARAMS - timeBindings.length - (scope?.bindings.length ?? 0),
  );
  const uniq = terms.slice(0, Math.min(KEYWORD_MAX_TOKENS, probeBudget));
  if (!uniq.length) return { query: content.join(" "), df: null, total: null, terms, distillSource: "shortcut" };
  // Retrieval appends deterministic variants after the original terms. Count
  // them as well so the match budget sees the same query as the keyword arm.
  const seen = new Set(uniq.map(term => term.value));
  const variants = deterministicVariants(query, content).filter(value => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  }).slice(0, Math.max(0, Math.min(KEYWORD_MAX_TOKENS, probeBudget) - uniq.length))
    .map(value => ({ value, kind: "word" as const, probes: [value] }));
  const countTerms: LexicalToken[] = [...uniq, ...variants];
  const probesByTerm = new Map(countTerms.map(term => [term.value, [term.probes[0]]]));
  let remainingProbeBudget = probeBudget - countTerms.length;
  for (const term of countTerms) {
    for (const probe of term.probes.slice(1)) {
      if (remainingProbeBudget <= 0) break;
      probesByTerm.get(term.value)!.push(probe);
      remainingProbeBudget--;
    }
  }

  // Compatibility surfaces and CJK bigrams require the existing LIKE probe
  // semantics. Every other token can use upstream's exact FTS count path.
  const dfTerms = countTerms.map(term => term.value);
  if (countTerms.every(term => term.kind !== "cjk-bigram" && term.probes.length === 1
    && (ftsEligibleToken(term.value) || ftsShortToken(term.value)) && ftsCountSafeToken(term.value)) && await ftsReady(env)) {
    try {
      const viaFts = await distillViaFts(dfTerms.filter(t => !ftsShortToken(t)), dfTerms.filter(ftsShortToken), env, bounds, scope);
      const unrankable = !!viaFts
        && uniq.every(term => (viaFts.df.get(term.value) ?? 0) / viaFts.total > QUERY_SATURATION_FRACTION)
        && uniq.some(term => (viaFts.df.get(term.value) ?? 0) === saturationCap(viaFts.total));
      if (viaFts && !unrankable) {
        const { df, total } = viaFts;
        return rebuildFromCounts(uniq, terms, content, df, total, viaFts.scanned ? "scan" : "fts", new Set(dfTerms.filter(ftsShortToken)));
      }
      // The pass already holds what the LIKE fallback below would count (the same terms, scope and rows).
      if (viaFts?.scanned) {
        const { df, total } = viaFts.scanned;
        if (!total) return { query: content.join(" "), df: null, total: null, distillSource: "like" };
        return rebuildFromCounts(uniq, terms, content, df, total, "like");
      }
    } catch (error) {
      console.error("FTS distillation count failed (degrading to LIKE):", error);
    }
  }

  try {
    const conditions = countTerms.map(term => probesByTerm.get(term.value)!
      .map(() => `content LIKE ? ${QUERY_LIKE_ESCAPE}`)
      .join(" OR "));
    const sums = conditions.map((condition, i) =>
      `SUM(CASE WHEN ${condition.includes(" OR ") ? `(${condition})` : condition} THEN 1 ELSE 0 END) AS d${i}`
    ).join(", ");
    // scope-checked: the caller's clause IS applied when an identity is present — it is appended into `where` above; the lexer cannot see into a JS-assembled fragment
    const row = await env.DB.prepare(`SELECT COUNT(*) AS total, ${sums} FROM entries${where ? ` WHERE${where}` : ""}`)
      .bind(
        ...countTerms.flatMap(term => probesByTerm.get(term.value)!.map(likeContainsPattern)),
        ...timeBindings,
        ...(scope?.bindings ?? []),
      ).first() as Record<string, number> | null;
    if (!row || !row.total) return { query: content.join(" "), df: null, total: null, terms, distillSource: "like" };
    const total = row.total;
    const df = new Map(countTerms.map((term, i) => [term.value, (row[`d${i}`] as number) ?? 0]));
    return rebuildFromCounts(uniq, terms, content, df, total, "like");
  } catch {
    return { query: content.join(" "), df: null, total: null, terms, distillSource: "like" };
  }
}

/** Test seam: every term's df through one forced route of dfCountsStmt, capped as distillation uses it. Null when the statement cannot be built. */
export async function dfThroughRoute(env: Env, terms: string[], scope: ScopeClause | null, route: "counts" | "pass"): Promise<Map<string, number> | null> {
  const stmt = dfCountsStmt(env, terms, scope, route);
  if (!stmt) return null;
  const row = ((await stmt.all()).results?.[0] ?? {}) as Record<string, unknown>;
  const cap = saturationCap((row.total as number) ?? 0);
  if (typeof row.scanned === "string") {
    const [, ...counts] = JSON.parse(row.scanned) as (number | null)[];
    return new Map(terms.map((t, i) => [t, Math.min(counts[i] ?? 0, cap)]));
  }
  return new Map(terms.map((t, i) => [t, (row[`n${i}`] as number) ?? 0]));
}
