import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import type { ProjectRow } from "../projects/registry";
import { projectFilterSql } from "../projects/filter";
import { scopeWhereForRead, readScopeWorkspaces, type ScopeClause } from "../lib/scope";
import { INDEXABLE_SQL } from "../capture/lifecycle";
import { isTopicTagSql } from "../compression/eligibility";
import { PENDING_INSIGHT_SQL } from "../memory/patterns";
import { STALE_REVIEW_SQL, STALE_AS_OF } from "../memory/stale";
import { openLoopSql } from "../memory/loops";
import { openOutboundSql, openInboundSql, OWED_TO_ME_SQL } from "../commitments/direction";
import { LEDGER_TAG } from "../tags/t7";
import { resolveConfig } from "../config";
import { calibrationQuery, decisionsActionable, parseDecisionOutcomeRow } from "../decisions/queries";
import { calibrate, type CalibrationResult } from "../decisions/calibration";
import { readStandingCaches } from "../standing/cache";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import { D1_MAX_BOUND_PARAMS } from "../constants";
import { DUE_WITHIN_MS, dueSql } from "../when/input";
import { parseTags } from "../insight/candidates";
import { STORED_DATA_NOTICE, storedLine } from "../lib/stored-data";
// Codex cross-vendor review, T-0102, director follow-up MINOR (round 2 re-review): already used
// throughout this file; line 544 (below) was the one hand-rolled quarantine:-prefix LIKE holdout,
// now the same one-line swap to this shared exact-match helper. This file belongs to the FX1 lane
// (230d0afe) -- flagged in the FX2 report for merge order.
import { NOT_HELD_SQL } from "../quarantine/tags";
import {
  excludedIds, readResurfaceState, withShown, writeResurfaceState,
} from "../runtime/resurface-state";
import { BRIEF_CHANGES_WINDOW_HOURS, getChanges, changesToRestJson, changesToLeanJson, renderChangesText } from "./changes";

/** Yesterday and today, so an early-morning open still has something to show. */
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Two weeks of activity: enough to show a rhythm, short enough to read. */
const ACTIVITY_DAYS = 14;

/** What the brain has been about lately, rather than all-time. */
const TOPIC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Old enough that resurfacing it is a genuine reminder rather than an echo. */
const RESURFACE_MIN_AGE_MS = 60 * 24 * 60 * 60 * 1000;

/** Below this, a memory is not worth interrupting someone with. */
const RESURFACE_MIN_IMPORTANCE = 3;

/**
 * Candidates worth resurfacing, written once so the row query and the count it
 * wraps against cannot drift apart — if they did, the offset would index into
 * a different set than the one being selected from.
 *
 * kind:episodic is excluded (v2): a live count against prod found the pool
 * dominated by episodic rows — the class that resurfaced a hotel stay two
 * months after the trip, a true-then, meaningless-now fact rather than a
 * genuine reminder. task:done is excluded because a finished commitment is
 * not a reminder either; it is history.
 */
// validity: current: a replaced memory is not resurfaced (5.5). `now` is interpolated,
// not bound, matching dueSql/openLoopSql (src/when/input.ts, src/memory/loops.ts).
const resurfaceFilter = (now: number) => `created_at < ? AND importance_score >= ?
         AND tags NOT LIKE '%"status:deprecated"%'
         AND tags NOT LIKE '%"auto-pattern"%'
         AND tags NOT LIKE '%"auto-insight"%'
         AND tags NOT LIKE '%"synthesized"%'
         AND tags NOT LIKE '%"kind:episodic"%'
         AND tags NOT LIKE '%"task:done"%'
         AND (valid_until IS NULL OR valid_until > ${now})
         AND ${NOT_HELD_SQL}`;

/** How far back "recently shown" reaches when excluding a repeat pick. */
const RESURFACE_RECENT_WINDOW_DAYS = 30;

/**
 * The DESIRED number of previously-shown/dismissed ids to bind into the
 * resurface exclusion clause — not a safety ceiling. `recent` can hold up to
 * 30 ids in KV and `dismissed` up to 60; this is the target when there is
 * room. pickResurface's dynamic budget is the actual ceiling: scope.bindings
 * is personal plus every company workspace the caller belongs to, unbounded
 * in principle (admin.ts's /stats/graph comment names ~32 real teams for an
 * admin today), and that clause is bound TWICE in the pick query — once for
 * the row, once for the OFFSET subquery it wraps against — so a FIXED
 * exclusion cap plus a wide-enough scope could still overflow D1's
 * 100-bound-parameter ceiling. See pickResurface for the arithmetic that
 * actually enforces the limit; this constant only sets what it aims for.
 */
const RESURFACE_EXCLUDE_BOUND_CAP = 20;

/**
 * Same predicate as scopeWhereForRead, but a single team keeps its own placeholder (=?, one bound
 * value — no reason to widen that) while the general many-workspace case binds the whole list as one
 * JSON parameter instead of one placeholder per workspace. Every brief query below combines this with
 * a project filter (up to MAX_PROJECT_PATTERNS LIKE patterns), and the combined width otherwise
 * crosses D1's 100-bound-parameter ceiling for a member in enough teams — the resurface pick already
 * has its own budget guard for the same reason; the other four brief queries did not.
 */
function briefWorkspaceScope(auth: Identity, layer?: "personal" | "company", teamId?: string): ScopeClause {
  if (teamId) return scopeWhereForRead(auth, { layer, teamId });
  return { clause: `workspace_id IN (SELECT value FROM json_each(?))`, bindings: [JSON.stringify(readScopeWorkspaces(auth, { layer }))] };
}

function briefScope(auth: Identity, projectRows?: ProjectRow[], layer?: "personal" | "company", teamId?: string): ScopeClause {
  const baseScope = briefWorkspaceScope(auth, layer, teamId);
  const project = projectRows ? projectFilterSql(projectRows) : null;
  return project
    ? { clause: `${baseScope.clause} AND ${project.clause}`, bindings: [...baseScope.bindings, ...project.bindings] }
    : baseScope;
}

/** The dashboard brief: counts every readable row, unlike the caller-only agent brief below. */
export async function computeBrief(env: Env, auth: Identity, preview = false, projectRows?: ProjectRow[], revealHeld = false) {
  const scope = briefScope(auth, projectRows);
  const now = Date.now();
  const since = now - RECENT_WINDOW_MS;
  const resurfaceBefore = now - RESURFACE_MIN_AGE_MS;
  const today = dayNumber(now);
  // Resolved once, up front (S2, T-0089.4.3): getChanges needs it too, and computing it here
  // instead of at its old spot below (once decisionsResolved was known) saves the second
  // resolveConfig call that would otherwise cost every brief its own KV read.
  const cfg = await resolveConfig(env);

  const [recentRows, patternRows, activityRows, topicRows, attentionRow, loopItemRows, changesResult] = await Promise.all([
    // What arrived, and from where. Grouped rather than listed: the point is
    // "your brain grew, from these places", not another feed of rows.
    env.DB.prepare(
      // validity: any: ダッシュボードの捕捉件数・活動・話題は過去の記憶も集計する。
      `SELECT source, COUNT(*) AS n FROM entries
       WHERE created_at >= ? AND ${scope.clause} GROUP BY source ORDER BY n DESC`,
    ).bind(since, ...scope.bindings).all(),

    // Insights the weekly pass proposed and nobody has ruled on. These are
    // excluded from recall until confirmed, so leaving them unseen in a menu
    // is the same as throwing them away.
    env.DB.prepare(
      // validity: current: 既存のPENDING_INSIGHT_SQL・STALE_REVIEW_SQL・compressionEligibilitySqlで現在の適格性を検査する。
      `SELECT id, content FROM entries
       WHERE ${PENDING_INSIGHT_SQL} AND ${scope.clause}
       ORDER BY created_at DESC LIMIT 3`,
    ).bind(...scope.bindings).all(),

    // Captures per day. Bucketed in SQL rather than by shipping timestamps and
    // grouping in the client, because the row count is the whole point and
    // there is no reason to send two weeks of rows to count them.
    env.DB.prepare(
      // validity: any: ダッシュボードの捕捉件数・活動・話題は過去の記憶も集計する。
      `SELECT CAST(created_at / 86400000 AS INTEGER) AS day, COUNT(*) AS n
       FROM entries WHERE created_at >= ? AND ${scope.clause}
       GROUP BY day ORDER BY day`,
    ).bind(now - ACTIVITY_DAYS * 86400000, ...scope.bindings).all(),

    // What the brain has been about this week, in the user's own vocabulary.
    // Same exclusions as /stats: the reserved namespaces are bookkeeping, and
    // hex-shaped tags are commit SHAs and colour codes a #token scan collected.
    // Scoped like every sibling query here. It was the one in this block that
    // was not, and the omission was visible on the front page: the topic chips
    // are rendered straight from this list, so a member's Home screen named
    // their colleagues' private tags back at them — "job-hunting" and
    // "confidential" alongside their own — while the counts beside them came
    // from correctly scoped queries and said something different.
    env.DB.prepare(
      // validity: any: ダッシュボードの捕捉件数・活動・話題は過去の記憶も集計する。
      `SELECT value AS tag, COUNT(*) AS n FROM entries, json_each(entries.tags)
       WHERE entries.created_at >= ?
         AND ${isTopicTagSql()}
         AND value NOT GLOB '[0-9]*'
         AND ${scope.clause}
       GROUP BY value ORDER BY n DESC LIMIT 6`,
    ).bind(now - TOPIC_WINDOW_MS, ...scope.bindings).all(),

    // The two things that make recall quietly worse, counted together so they
    // cost one query: memories recall cannot see, and memories the staleness
    // pass has flagged as possibly out of date.
    //
    // Deprecated entries are excluded from BOTH counts, for the same reason in
    // two forms. Their vectors were deleted on purpose — dismissing a pattern is
    // the common way — so counting them as "not searchable" reported the user's
    // own decision back to them as a problem, and grew the number every time they
    // dismissed one. A deprecated memory is likewise retired from recall, so
    // asking anyone to re-verify it is make-work.
    //
    // The stale count shares STALE_REVIEW_SQL with `GET /stale`, the queue this
    // chip opens. They are two readings of one fact: a chip that promises a
    // number the queue then fails to produce is the defect this replaced, and
    // one predicate is what stops it coming back.
    // open_loops and due both ride this same aggregate — one more CASE/SUM
    // each on a query already scanning every row, rather than a query of
    // their own — the same reasoning that put unindexed and stale here
    // together. due shares DUE_SQL with GET /due itself (src/when/input.ts),
    // deliberately NOT OPEN_LOOP_SQL: a "when" reaches a row through three
    // producers (explicit, regex, model) with no task-tag requirement, and
    // gating the chip on one while the feed had none meant an untagged
    // remember(when: ...) moved GET /due but never this count (review
    // finding). The two share one predicate so they cannot disagree again.
    // validity: current: open_loops and due must not count a replaced row (5.5)
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN vector_ids = '[]' AND ${INDEXABLE_SQL} THEN 1 ELSE 0 END) AS unindexed,
         SUM(CASE WHEN ${STALE_REVIEW_SQL} THEN 1 ELSE 0 END) AS stale,
         SUM(CASE WHEN ${openOutboundSql(now)} THEN 1 ELSE 0 END) AS open_loops,
         SUM(CASE WHEN ${openInboundSql(now)} THEN 1 ELSE 0 END) AS owed_to_me,
         SUM(CASE WHEN instr(lower(tags), '"${LEDGER_TAG}"') > 0
                   AND (tags LIKE '%"outcome:right"%' OR tags LIKE '%"outcome:wrong"%' OR tags LIKE '%"outcome:mixed"%')
                   AND tags NOT LIKE '%"status:deprecated"%'
              THEN 1 ELSE 0 END) AS decisions_resolved,
         SUM(CASE WHEN ${dueSql(now)} AND when_at <= ? THEN 1 ELSE 0 END) AS due,
         COUNT(*) AS total
       FROM entries WHERE ${scope.clause}`,
    ).bind(now + DUE_WITHIN_MS, ...scope.bindings).first() as Promise<Record<string, any> | null>,

    // The loop queue's own preview: up to three most recent open commitments PER DIRECTION
    // (Design 5.3 L2), same row shape GET /loops returns, so the panel and the sheet behind it
    // read identically. Still one statement: the inner query partitions by direction and the
    // outer filter keeps only each partition's newest 3.
    // validity: current: a replaced loop is not open (5.5)
    env.DB.prepare(
      `SELECT id, content, source, tags, created_at, direction FROM (
         SELECT id, content, source, tags, created_at,
           (CASE WHEN ${OWED_TO_ME_SQL} THEN 'in' ELSE 'out' END) AS direction,
           ROW_NUMBER() OVER (PARTITION BY (CASE WHEN ${OWED_TO_ME_SQL} THEN 1 ELSE 0 END) ORDER BY created_at DESC, id DESC) AS rn
         FROM entries WHERE ${TASK_INDEXED} AND ${openLoopSql(now)} AND ${scope.clause} AND ${NOT_HELD_SQL}
       ) WHERE rn <= 3
       ORDER BY direction, rn`,
    ).bind(...scope.bindings).all(),

    // What AI tools changed (S2, T-0089.4.3, 5.8): +1 statement, deliberately (spec Budget note).
    getChanges(env, auth, BRIEF_CHANGES_WINDOW_HOURS, cfg),
  ]);

  const bySource = (recentRows.results as { source: string | null; n: number }[]).map(r => ({
    source: r.source ?? "unknown",
    count: r.n,
  }));
  const captured = bySource.reduce((sum, r) => sum + r.count, 0);

  const patterns = (patternRows.results as { id: string; content: string }[]).map(r => ({
    id: r.id,
    content: r.content,
  }));

  // Days with no captures are absent from the GROUP BY and have to be filled
  // in, or the strip would silently compress a quiet week into a busy-looking
  // one — the shape of the rhythm is the information.
  const byDay = new Map<number, number>();
  for (const r of activityRows.results as { day: number; n: number }[]) byDay.set(r.day, r.n);
  const activity: { day: number; count: number }[] = [];
  for (let d = today - (ACTIVITY_DAYS - 1); d <= today; d++) {
    activity.push({ day: d, count: byDay.get(d) ?? 0 });
  }

  const topics = (topicRows.results as { tag: string; n: number }[]).map(r => ({ tag: r.tag, count: r.n }));

  // Resurface v2. Sequential rather than in the Promise.all above because the
  // topic-preference step needs `topics`, computed from that same batch — it
  // cannot join a race it depends on the result of.
  const workspaceKey = auth.personalWorkspaceId;
  const priorState = await readResurfaceState(env, workspaceKey);
  // Uncapped here — dismissed-first, most-recent-shown-next (excludedIds) —
  // because how many of these can actually be bound depends on the caller's
  // OWN scope size, which pickResurface does not know until it runs. Capping
  // here to a fixed number and letting pickResurface double THAT plus scope
  // is exactly the shape that overflowed D1's bound-parameter ceiling.
  const excluded = excludedIds(priorState, today, RESURFACE_RECENT_WINDOW_DAYS);

  // "Not newly excluded" means not dismissed since being shown — checked
  // against `dismissed` alone, not the full `excluded` set: today's own pick
  // is trivially "recently shown" (it IS the most recent), so testing it
  // against `excluded` would always fail and this shortcut would never fire.
  let resurfaceRow = priorState.day === today && priorState.shownId && !priorState.dismissed.includes(priorState.shownId)
    // Same-day stability: fetch the exact row rather than re-selecting, so a
    // second app open the same day shows the same memory. Falls through to a
    // fresh pick below if the row is gone (deleted, moved out of scope, or
    // replaced since it was shown — a superseded fact is not worth re-reading).
    // validity: current: a row replaced since it was shown falls through to a fresh pick (5.5)
    ? await env.DB.prepare(
        `SELECT id, content, source, tags, created_at FROM entries WHERE id = ? AND (valid_until IS NULL OR valid_until > ?) AND ${scope.clause} AND ${NOT_HELD_SQL}`,
      ).bind(priorState.shownId, now, ...scope.bindings).first() as ResurfaceRow | null
    : null;

  let nextState = priorState;
  if (!resurfaceRow) {
    resurfaceRow = await pickResurface(env, scope, resurfaceBefore, topics, excluded, today, now) ?? null;
    if (resurfaceRow) nextState = withShown(priorState, resurfaceRow.id, today);
  }
  // T-0102 MINOR fix (finding 8): the persisted state is keyed by workspace only, never by
  // project, so a project-scoped pick (from a narrower `scope`) would overwrite the same slot the
  // unscoped brief's own same-day stability reads from -- on every ?project= call whose scope
  // does not already match whatever the last write left there, not just once. Treated like
  // `preview`: a project-scoped pick is read fine (same-day stability still applies if the prior
  // pick happens to fall inside this project's scope), but never written back.
  if (!preview && !projectRows?.length && nextState !== priorState) {
    await writeResurfaceState(env, workspaceKey, nextState);
  }

  const loopItems = (loopItemRows.results as {
    id: string; content: string; source: string; tags: string; created_at: number; direction: "in" | "out";
  }[]).map(r => ({
    id: r.id,
    content: r.content,
    source: r.source,
    tags: parseTags(r.tags),
    created_at: r.created_at,
    direction: r.direction,
  }));

  // C11: gated on the aggregate's own decisions_resolved column, so the calibration read costs
  // nothing until the brain actually has enough resolved decisions to say anything with it.
  const decisionsResolved = (attentionRow?.decisions_resolved as number) ?? 0;
  let calibration: { ready: boolean; line: string; n: number } | undefined;
  if (decisionsResolved >= cfg.CALIBRATION_MIN_N) {
    const calibScope = briefWorkspaceScope(auth);
    const { sql, bindings } = calibrationQuery(calibScope, decisionsActionable(auth));
    const { results } = await env.DB.prepare(sql).bind(...bindings).all();
    const rows = (results as { tags: string }[]).map(r => parseDecisionOutcomeRow(r.tags));
    const result = calibrate(rows, { minN: cfg.CALIBRATION_MIN_N, minBucketN: cfg.CALIBRATION_MIN_BUCKET_N, minTopicN: cfg.CALIBRATION_MIN_TOPIC_N });
    calibration = { ready: result.ready, line: result.line, n: result.n };
  }

  return {
    ok: true,
    window_hours: RECENT_WINDOW_MS / 3600000,
    captured,
    sources: bySource,
    patterns,
    resurface: resurfaceRow
      ? {
          id: resurfaceRow.id,
          content: resurfaceRow.content,
          source: resurfaceRow.source,
          // A malformed tags column (hand-edited, or a migration bug) must not
          // 500 the whole endpoint every day this row is picked, see
          // src/insight/candidates.ts's parseTags, the shared safe parser.
          tags: parseTags(resurfaceRow.tags),
          created_at: resurfaceRow.created_at,
        }
      : null,
    activity,
    topics,
    total: (attentionRow?.total as number) ?? 0,
    attention: {
      unindexed: (attentionRow?.unindexed as number) ?? 0,
      stale: (attentionRow?.stale as number) ?? 0,
      patterns: patterns.length,
      due: (attentionRow?.due as number) ?? 0,
    },
    loops: {
      open: (attentionRow?.open_loops as number) ?? 0,
      items: loopItems,
    },
    owed_to_me: (attentionRow?.owed_to_me as number) ?? 0,
    changes: changesToRestJson(changesResult, revealHeld),
    ...(calibration ? { calibration } : {}),
  };
}

// Each term repeats a LIKE predicate as the instr(...) expression its partial index is defined on
// (src/db/init.ts), so the planner scans only the matching rows instead of every memory.
const TASK_INDEXED = `instr(lower(tags), '"task"') > 0`;
const INSIGHT_INDEXED = `instr(lower(tags), '"auto-insight"') > 0`;
const STALE_INDEXED = `instr(lower(tags), '"${STALE_AS_OF}"') > 0`;

/**
 * The caller's own rows: their personal workspace (or a pre-tenancy '' row, which is the owner's)
 * or anything they authored. The dashboard brief counts every READABLE row, a teammate's company
 * task included; this agent view lists only what the caller owes and can settle, for admins too,
 * because resolve would otherwise send them to a refusal or hand them the team's commitments.
 */
function actionable(auth: Identity): ScopeClause {
  return { clause: "(workspace_id IN (?, '') OR actor_id = ?)", bindings: [auth.personalWorkspaceId, auth.userId] };
}

export type BriefPart = "due" | "loops" | "stale" | "insights";
export interface BriefRow { id: string; content: string; when_at?: number }
export interface BriefSection { total: number; items: BriefRow[] }
export interface AgentBriefData {
  due?: BriefSection;
  /** Decisions due for review (C10): split out of the due query by the same statement, never
   * duplicated into `due` — a decision review appears here only. */
  decisions_due?: BriefSection;
  /** Open outbound loops ("You owe"). Kept under the `loops` key for backward compatibility
   * with the lean brief's existing shape. */
  loops?: BriefSection;
  /** Open inbound loops ("Owed to you"), split from `loops` by the same statement (Design 5.3 L3). */
  owed_to_you?: BriefSection;
  stale?: BriefSection;
  insights?: BriefSection;
}

/** The four agent-brief reads, each optional. stale and insights are one bounded statement each;
 * due and loops each split into two sections, from two statements each (an items read and a
 * separate totals aggregate — see dueSplit/loopsSplit below for why) (Design 5.3, C10). */
export async function readAgentBrief(
  env: Env, auth: Identity,
  opts: { parts: BriefPart[]; projectRows?: ProjectRow[]; layer?: "personal" | "company"; teamId?: string },
): Promise<AgentBriefData> {
  const scope = briefScope(auth, opts.projectRows, opts.layer, opts.teamId);
  const mine = actionable(auth);
  const now = Date.now();
  // Pending insights carry no author lock, so their query omits the actionable clause and bindings.
  const run = async (sql: string, cap: number, extra: unknown[] = [], withMine = true): Promise<BriefSection> => {
    const { results } = await env.DB.prepare(sql).bind(...extra, ...scope.bindings, ...(withMine ? mine.bindings : [])).all();
    const rows = results as unknown as (BriefRow & { total: number })[];
    return { total: rows[0]?.total ?? 0, items: rows.slice(0, cap).map(({ id, content, when_at }) => ({ id, content, ...(when_at != null ? { when_at } : {}) })) };
  };

  /** due (≤5) and decisions_due (≤3), partitioned by whether the row is a logged decision (C10).
   * A decision row's own when_at never appears under `due`.
   *
   * Two statements, not the one window-function statement this used to be: PARTITION BY on a
   * computed CASE (not a column) can't ride idx_entries_when's own (workspace_id, when_at)
   * ordering, so SQLite materialized and sorted every due row to number and count each partition
   * — a review found this reading 11,507 rows at 10k memories where 86 was enough. The items read
   * is now a plain ORDER BY ... LIMIT per branch, which SQLite can satisfy by walking the index
   * and stopping as soon as it has enough rows; the total is a separate, sort-free SUM/CASE
   * aggregate over the same index (still one full pass, but a cheap one — no partition, no sort).
   * validity: current: a replaced due item must not appear in this agent's own brief (5.5) */
  const dueSplit = async (): Promise<{ due: BriefSection; decisions_due: BriefSection }> => {
    const isDecisionSql = `instr(lower(tags), '"${LEDGER_TAG}"') > 0`;
    const dueAt = now + DUE_WITHIN_MS;
    const [itemsResult, totalsRow] = await Promise.all([
      // validity: current: dueSql carries the predicate (5.5)
      env.DB.prepare(
        `SELECT id, content, when_at, is_decision FROM (
           SELECT id, content, when_at, 0 AS is_decision FROM entries
              WHERE ${dueSql(now)} AND when_at <= ? AND NOT (${isDecisionSql}) AND ${scope.clause} AND ${mine.clause} AND ${NOT_HELD_SQL}
              ORDER BY when_at ASC, id ASC LIMIT 5
         )
         UNION ALL
         SELECT id, content, when_at, is_decision FROM (
           SELECT id, content, when_at, 1 AS is_decision FROM entries
              WHERE ${dueSql(now)} AND when_at <= ? AND ${isDecisionSql} AND ${scope.clause} AND ${mine.clause} AND ${NOT_HELD_SQL}
              ORDER BY when_at ASC, id ASC LIMIT 3
         )`,
      ).bind(dueAt, ...scope.bindings, ...mine.bindings, dueAt, ...scope.bindings, ...mine.bindings).all(),
      // validity: current: dueSql carries the predicate (5.5)
      env.DB.prepare(
        `SELECT
           SUM(CASE WHEN NOT (${isDecisionSql}) THEN 1 ELSE 0 END) AS due_total,
           SUM(CASE WHEN ${isDecisionSql} THEN 1 ELSE 0 END) AS decisions_due_total
         FROM entries WHERE ${dueSql(now)} AND when_at <= ? AND ${scope.clause} AND ${mine.clause} AND ${NOT_HELD_SQL}`,
      ).bind(dueAt, ...scope.bindings, ...mine.bindings).first() as Promise<{ due_total: number; decisions_due_total: number } | null>,
    ]);
    const rows = itemsResult.results as unknown as { id: string; content: string; when_at: number; is_decision: number }[];
    const toSection = (isDecision: number, total: number): BriefSection => {
      const matching = rows.filter(r => r.is_decision === isDecision);
      return { total, items: matching.map(({ id, content, when_at }) => ({ id, content, when_at })) };
    };
    return { due: toSection(0, totalsRow?.due_total ?? 0), decisions_due: toSection(1, totalsRow?.decisions_due_total ?? 0) };
  };

  /** loops (≤5, outbound, "You owe") and owed_to_you (≤5, inbound), partitioned by direction
   * (Design 5.3 L3). Same two-statement split as dueSplit above and for the same reason: a
   * partitioned window read over idx_entries_task forced a full sorted scan of every open loop
   * (11,507 rows at 10k where 86 was enough); a plain per-direction ORDER BY ... LIMIT lets the
   * index walk stop early, with the totals taken from one sort-free aggregate.
   * validity: current: openLoopSql/openOutboundSql/openInboundSql carry the predicate (5.5) */
  const loopsSplit = async (): Promise<{ loops: BriefSection; owed_to_you: BriefSection }> => {
    const [itemsResult, totalsRow] = await Promise.all([
      // validity: current: openOutboundSql/openInboundSql carry the predicate (5.5)
      env.DB.prepare(
        `SELECT id, content, is_inbound FROM (
           SELECT id, content, 0 AS is_inbound FROM entries
              WHERE ${TASK_INDEXED} AND ${openOutboundSql(now)} AND ${scope.clause} AND ${mine.clause} AND ${NOT_HELD_SQL}
              ORDER BY created_at DESC, id DESC LIMIT 5
         )
         UNION ALL
         SELECT id, content, is_inbound FROM (
           SELECT id, content, 1 AS is_inbound FROM entries
              WHERE ${TASK_INDEXED} AND ${openInboundSql(now)} AND ${scope.clause} AND ${mine.clause} AND ${NOT_HELD_SQL}
              ORDER BY created_at DESC, id DESC LIMIT 5
         )`,
      ).bind(...scope.bindings, ...mine.bindings, ...scope.bindings, ...mine.bindings).all(),
      // validity: current: openLoopSql carries the predicate (5.5)
      env.DB.prepare(
        `SELECT
           SUM(CASE WHEN ${OWED_TO_ME_SQL} THEN 0 ELSE 1 END) AS loops_total,
           SUM(CASE WHEN ${OWED_TO_ME_SQL} THEN 1 ELSE 0 END) AS owed_to_you_total
         FROM entries WHERE ${TASK_INDEXED} AND ${openLoopSql(now)} AND ${scope.clause} AND ${mine.clause} AND ${NOT_HELD_SQL}`,
      ).bind(...scope.bindings, ...mine.bindings).first() as Promise<{ loops_total: number; owed_to_you_total: number } | null>,
    ]);
    const rows = itemsResult.results as unknown as { id: string; content: string; is_inbound: number }[];
    const toSection = (isInbound: number, total: number): BriefSection => {
      const matching = rows.filter(r => r.is_inbound === isInbound);
      return { total, items: matching.map(({ id, content }) => ({ id, content })) };
    };
    return { loops: toSection(0, totalsRow?.loops_total ?? 0), owed_to_you: toSection(1, totalsRow?.owed_to_you_total ?? 0) };
  };

  // validity: current: 既存のPENDING_INSIGHT_SQL・STALE_REVIEW_SQL・compressionEligibilitySqlで現在の適格性を検査する。
  const stalePart = async (): Promise<BriefSection> => run(`SELECT id, content, COUNT(*) OVER() AS total FROM entries
      WHERE ${STALE_INDEXED} AND ${STALE_REVIEW_SQL} AND ${scope.clause} AND ${mine.clause} AND ${NOT_HELD_SQL}
      ORDER BY COALESCE(updated_at, created_at) ASC, id ASC LIMIT 2`, 2);
  // validity: current: 既存のPENDING_INSIGHT_SQL・STALE_REVIEW_SQL・compressionEligibilitySqlで現在の適格性を検査する。
  const insightsPart = async (): Promise<BriefSection> => run(`SELECT id, content, COUNT(*) OVER() AS total FROM entries
      WHERE ${INSIGHT_INDEXED} AND ${PENDING_INSIGHT_SQL} AND ${scope.clause} AND ${NOT_HELD_SQL}
      ORDER BY created_at DESC, id DESC LIMIT 1`, 1, [], false);

  const wants = new Set(opts.parts);
  const [due, loops, stale, insights] = await Promise.all([
    wants.has("due") ? dueSplit() : Promise.resolve(undefined),
    wants.has("loops") ? loopsSplit() : Promise.resolve(undefined),
    wants.has("stale") ? stalePart() : Promise.resolve(undefined),
    wants.has("insights") ? insightsPart() : Promise.resolve(undefined),
  ]);
  return {
    ...(due ?? {}),
    ...(loops ?? {}),
    ...(stale ? { stale } : {}),
    ...(insights ? { insights } : {}),
  };
}

/** Text for the MCP tool: sections omitted when empty, stored text framed as data. Order:
 * Due, Decisions due for review, You owe, Owed to you, [standing, calibration appended by the
 * caller], May be out of date, Pending insights. */
export function formatAgentBrief(data: AgentBriefData, extraSections: string[] = []): string {
  const line = (r: BriefRow) => `- ${storedLine(r.id, 64)}: ${storedLine(r.content, 120)}`;
  const sections: string[] = [];
  const add = (title: string, part: BriefSection | undefined, render: (r: BriefRow) => string = line) => {
    if (part?.items.length) sections.push(`${title}\n${part.items.map(render).join("\n")}`);
  };
  add("Due", data.due, r => `${line(r)} (${new Date(r.when_at as number).toISOString()})`);
  add("Decisions due for review", data.decisions_due, r => `${line(r)} (due ${new Date(r.when_at as number).toISOString().slice(0, 10)})`);
  add("You owe", data.loops);
  add("Owed to you", data.owed_to_you);
  sections.push(...extraSections);
  add(`May be out of date (${data.stale?.total ?? 0})`, data.stale);
  add(`Pending insights (${data.insights?.total ?? 0})`, data.insights);
  return sections.length ? `${STORED_DATA_NOTICE}\n\n${sections.join("\n\n")}` : "Nothing needs attention.";
}

/**
 * Standing instructions for this project (Design 2.11): only with a project given, oldest first,
 * at most 3. One conditional hydration statement, only when at least one cached item matches.
 */
async function standingBriefItems(
  env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }, auth: Identity,
  projectRows: ProjectRow[] | undefined, layer: "personal" | "company" | undefined, teamId: string | undefined,
): Promise<{ id: string; content: string }[]> {
  if (!projectRows?.length) return [];
  const slugs = new Set<string>();
  for (const p of projectRows) { slugs.add(p.id); for (const alias of p.aliases) slugs.add(alias); }

  const cfg = await resolveConfig(env);
  const workspaceIds = readScopeWorkspaces(auth, { layer, teamId });
  const caches = await readStandingCaches(env, ctx, cfg, workspaceIds);
  const matches: { id: string; createdAt: number }[] = [];
  for (const cache of caches) {
    for (const item of cache.items) {
      if (item.projects.length && item.projects.some(p => slugs.has(p))) matches.push({ id: item.id, createdAt: item.createdAt });
    }
  }
  if (!matches.length) return [];
  matches.sort((a, b) => a.createdAt - b.createdAt);
  const ids = matches.slice(0, 3).map(m => m.id);

  const scope = briefWorkspaceScope(auth, layer, teamId);
  // validity: any: hydrates ids readStandingCaches already picked with its own currentValidityAt filter
  const { results } = await env.DB.prepare(
    `SELECT id, content, created_at FROM entries
      WHERE id IN (SELECT value FROM json_each(?)) AND ${scope.clause}
        AND tags LIKE '%"standing:active"%' AND tags NOT LIKE '%"status:deprecated"%' AND ${NOT_HELD_SQL}`,
  ).bind(JSON.stringify(ids), ...scope.bindings).all();
  return (results as { id: string; content: string; created_at: number }[])
    .sort((a, b) => a.created_at - b.created_at)
    .map(r => ({ id: r.id, content: r.content }));
}

/** The full MCP brief's calibration line (C11): always one statement, reading only idx_entries_ledger rows. */
async function calibrationLine(env: Env, auth: Identity, cfg: Awaited<ReturnType<typeof resolveConfig>>): Promise<CalibrationResult> {
  const scope = briefWorkspaceScope(auth);
  const { sql, bindings } = calibrationQuery(scope, decisionsActionable(auth));
  const { results } = await env.DB.prepare(sql).bind(...bindings).all();
  const rows = (results as { tags: string }[]).map(r => parseDecisionOutcomeRow(r.tags));
  return calibrate(rows, { minN: cfg.CALIBRATION_MIN_N, minBucketN: cfg.CALIBRATION_MIN_BUCKET_N, minTopicN: cfg.CALIBRATION_MIN_TOPIC_N });
}

/** Compact attention view for agents. Shares the scope and queue predicates with dashboard brief. */
export async function computeAgentBrief(
  env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }, auth: Identity,
  projectRows?: ProjectRow[], layer?: "personal" | "company", teamId?: string,
): Promise<string> {
  const cfg = await resolveConfig(env);
  const [data, standingItems, calibration, changes] = await Promise.all([
    readAgentBrief(env, auth, { parts: ["due", "loops", "stale", "insights"], projectRows, layer, teamId }),
    standingBriefItems(env, ctx, auth, projectRows, layer, teamId),
    calibrationLine(env, auth, cfg),
    // S2, T-0089.4.3: +1 statement, deliberately (spec Budget note).
    getChanges(env, auth, BRIEF_CHANGES_WINDOW_HOURS, cfg, layer, teamId),
  ]);
  const extraSections: string[] = [];
  if (standingItems.length) {
    extraSections.push(`Standing instructions for this project\n${standingItems.map(i => `- ${storedLine(i.id, 64)}: ${storedLine(i.content, 120)}`).join("\n")}`);
  }
  // Design brief section list: "Calibration (one line, when ready)" — omitted, not the
  // not-ready wording, when there is nothing to say yet.
  if (calibration.ready) extraSections.push(`Calibration\n${calibration.line}`);
  // Never touches `preview` — see renderChangesText's own comment (P7).
  const changesText = renderChangesText(changes, cfg.TIMEZONE);
  if (changesText) extraSections.push(`What AI tools changed\n${changesText}`);
  return formatAgentBrief(data, extraSections);
}

/**
 * The session-start hook's brief: due and open commitments only, in the shape GET /brief uses for
 * them. No resurface, topics or activity, so it reads only the rows those two queues hold. Adds
 * owed_to_you and standing (Design 2.11); never decisions or calibration — the hook is not a
 * place for informational lines.
 */
export async function computeLeanBrief(
  env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }, auth: Identity,
  projectRows?: ProjectRow[], layer?: "personal" | "company", teamId?: string,
) {
  const [{ due, loops, owed_to_you }, standingItems, changes] = await Promise.all([
    readAgentBrief(env, auth, { parts: ["due", "loops"], projectRows, layer, teamId }),
    standingBriefItems(env, ctx, auth, projectRows, layer, teamId),
    // S2, T-0089.4.3, Q-H approved: +1 statement, counts and groups only, never items (6.2).
    getChanges(env, auth, BRIEF_CHANGES_WINDOW_HOURS, undefined, layer, teamId),
  ]);
  return {
    ok: true,
    lean: true,
    attention: { due: due?.total ?? 0 },
    loops: { open: loops?.total ?? 0, items: (loops?.items ?? []).slice(0, 3).map(({ id, content }) => ({ id, content })) },
    owed_to_you: { open: owed_to_you?.total ?? 0, items: (owed_to_you?.items ?? []).slice(0, 2).map(({ id, content }) => ({ id, content })) },
    standing: { items: standingItems.map(({ id, content }) => ({ id, content })) },
    changes: changesToLeanJson(changes),
  };
}

/** Days since the epoch: changes once a day, stable within it. */
function dayNumber(now: number): number {
  return Math.floor(now / 86400000);
}

interface ResurfaceRow {
  id: string; content: string; source: string; tags: string; created_at: number;
}

/**
 * Fresh resurface pick: prefer a candidate sharing one of this week's top
 * topic tags, falling back to the full candidate pool when that preferred
 * subset is empty (no topics this week, or none of the candidates carry one).
 *
 * Costs one D1 query when there is nothing to prefer (skips straight to the
 * fallback pool) or two when there is: a COUNT probe to test whether the
 * preferred subset has anything at all, then the pick itself against
 * whichever pool the probe selected. The pick query keeps the OFFSET-wraps-
 * inside-SQL trick from v1: the filter clause is bound twice, once for the
 * row and once for the count it wraps against, so a brain with fewer
 * candidates than the rotation constant never silently shows nothing.
 *
 * BOUND-PARAMETER BUDGET. That doubling is exactly what makes this query's
 * size someone else's decision, not this function's: it binds
 * RESURFACE_FILTER (2) + up to 6 topic patterns + up to
 * RESURFACE_EXCLUDE_BOUND_CAP exclusion ids + scope.bindings — TWICE — plus
 * one placeholder for `today`. scope.bindings is not a small constant, it is
 * personal plus every company workspace the caller belongs to (readableWorkspaces,
 * src/lib/scope.ts), unbounded in principle and ~32 real teams for an admin
 * today (see the /stats/graph comment in admin.ts making the same point). A
 * fixed exclusion cap plus that scope size overflowed D1's 100-bound-parameter
 * ceiling — this function has no try/catch, so the overflow 500'd the WHOLE
 * GET /brief response, every field, not just the pick.
 *
 * Solving `2 * (2 + topicN + excludedN + scopeN) + 1 <= D1_MAX_BOUND_PARAMS`
 * for the combined topicN + excludedN slack once scopeN is known gives the
 * budget below. Mirrors POST /patterns/resolve's per-request bulkLimit
 * (admin.ts), generalized to a statement that binds its scope clause twice.
 *
 * Correctness outranks relevance when the two compete for that budget: the
 * exclusion list (a dismissed or just-shown id must not come back) claims it
 * first, up to RESURFACE_EXCLUDE_BOUND_CAP; topic preference (a nicety) only
 * survives in whatever room is left, and is dropped OUTRIGHT rather than
 * partially — a topic clause missing some of this week's tags would silently
 * bias toward whichever happened to fit, which is worse than no preference at
 * all. At zero budget (an admin in enough company workspaces on their own),
 * both drop to nothing and this degrades to a v1-style unfiltered pick:
 * RESURFACE_FILTER and scope alone, still safe because THAT doubled shape
 * costs `2 * (2 + scopeN) + 1`, comfortably under the ceiling until scopeN
 * itself exceeds roughly 47 — a pre-existing v1 shape this fix does not
 * change, since scope.clause cannot be dropped without breaking isolation.
 */
async function pickResurface(
  env: Env,
  scope: ScopeClause,
  resurfaceBefore: number,
  topics: { tag: string; count: number }[],
  excluded: string[],
  today: number,
  now: number,
): Promise<ResurfaceRow | undefined> {
  const budget = Math.max(0, Math.floor((D1_MAX_BOUND_PARAMS - 1) / 2) - 2 - scope.bindings.length);
  // This is the one statement that binds scope twice. When workspaces plus a wide project filter
  // alone would pass D1's ceiling, skip the pick rather than fail the whole brief.
  if (scope.bindings.length + 2 > Math.floor((D1_MAX_BOUND_PARAMS - 1) / 2)) return undefined;

  let topicTags = topics.map(t => t.tag);
  let boundExcluded = excluded.slice(0, Math.min(RESURFACE_EXCLUDE_BOUND_CAP, excluded.length, budget));
  if (topicTags.length + boundExcluded.length > budget) {
    topicTags = [];
    boundExcluded = excluded.slice(0, budget);
  }

  const exclusionClause = boundExcluded.length ? `AND id NOT IN (${boundExcluded.map(() => "?").join(", ")})` : "";

  let activeFilter = resurfaceFilter(now);
  let extraFilterBindings: string[] = [];

  if (topicTags.length) {
    const topicClause = `(${topicTags.map(() => `tags LIKE ? ${TAG_LIKE_ESCAPE}`).join(" OR ")})`;
    const topicPatterns = topicTags.map(tagLikePattern);
    // validity: current: resurfaceFilter carries the predicate (5.5)
    const preferredCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM entries
       WHERE (${resurfaceFilter(now)}) AND ${topicClause} ${exclusionClause} AND ${scope.clause}`,
    ).bind(resurfaceBefore, RESURFACE_MIN_IMPORTANCE, ...topicPatterns, ...boundExcluded, ...scope.bindings)
      .first() as Record<string, any> | null;
    if (((preferredCount?.n as number) ?? 0) > 0) {
      activeFilter = `(${resurfaceFilter(now)}) AND ${topicClause}`;
      extraFilterBindings = topicPatterns;
    }
  }

  const filterBindings = [resurfaceBefore, RESURFACE_MIN_IMPORTANCE, ...extraFilterBindings];
  // validity: current: resurfaceFilter (in activeFilter) carries the predicate (5.5)
  const { results } = await env.DB.prepare(
    `SELECT id, content, source, tags, created_at FROM entries
     WHERE (${activeFilter}) ${exclusionClause} AND ${scope.clause}
     ORDER BY id
     LIMIT 1
     OFFSET (? % MAX((SELECT COUNT(*) FROM entries WHERE (${activeFilter}) ${exclusionClause} AND ${scope.clause}), 1))`,
  ).bind(
    ...filterBindings, ...boundExcluded, ...scope.bindings,
    today,
    ...filterBindings, ...boundExcluded, ...scope.bindings,
  ).all();

  return (results as unknown as ResurfaceRow[])[0];
}
