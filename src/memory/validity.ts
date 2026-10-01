import { assertMemoryWritesAllowed, memoryWriteMarker } from "../migration/write-lock";
/**
 * Validity windows (Track 2, T-0089.2.1; spec 14-t2-time-spec.md 5.3 and 5.4).
 *
 * A fact is true from COALESCE(valid_from, created_at) until valid_until (NULL = still true).
 * Validity decides WHETHER a row is true at T; record-time versions decide WHICH TEXT (P1).
 * Pure helpers and statement builders only: every generated statement numbers its placeholders
 * through Params, and every writer compare-and-sets the values it read.
 */
import type { Env } from "../env";
import { writeAuditEvents, type AuditEventInput, type ChangeContext } from "../lib/audit";
import type { Config } from "../config";
import type { MemoryStatus } from "./status";
import { zonedTimeMs } from "../when/timezone";
import { edgeEndpointsReadableSql } from "../graph/edges";
import { RETRACTED_SOURCE_TAG } from "../tags/system";

export { RETRACTED_SOURCE_TAG };
import { buildDerivedSnapshot, changesOf, Params, pruneStatement, snapshotStatement } from "./versions";
import { buildStandingCache, standingTouched } from "../standing/cache";
// This used to hand-roll its own quarantine:-prefix LIKE check instead of the shared exact-match
// notHeldSqlFor (the aliased form: this query joins two tag-bearing tables).
import { notHeldSqlFor } from "../quarantine/tags";

/**
 * A stated start of "unknown": a fact told only with its end ("I lived in Boston until 2020"),
 * or an end earlier than an unstated start. Coalesces like any stated start, so the fact is true
 * at every T before its end. Readers show it as "until <date>" with no start.
 */
export const UNKNOWN_START = 0;

const DEPRECATED_LIKE = `'%"status:deprecated"%'`;

export const EFFECTIVE_FROM = (a: string) => `COALESCE(${a}.valid_from, ${a}.created_at)`;

/**
 * Current: open, or ends after `nowSql`. Stated starts are never in the future (P5), so no start
 * check. The one definition of "current": `alias` "" reads bare columns (a fragment spliced into a
 * single-table statement), and `nowSql` is a bound placeholder or SQL_NOW_MS.
 */
export function currentValidityAt(alias: string, nowSql: string): string {
  const col = alias ? `${alias}.valid_until` : "valid_until";
  return `(${col} IS NULL OR ${col} > ${nowSql})`;
}

/**
 * The database's own clock in epoch ms, for a static SQL fragment that has no binding of its own
 * (STALE_REVIEW_SQL). julianday works on every SQLite D1 runs; request paths that have a clock of
 * their own bind it through currentValiditySql instead, so a frozen test or eval clock still applies.
 */
export { SQL_NOW_MS } from "../constants";

/** Current at `now`, bound through Params. */
export function currentValiditySql(p: Params, alias: string, now: number): string {
  return currentValidityAt(alias, p.add(now));
}

/**
 * "Replaced by" for the outer row `outer` (spec 14 5.9): the newest live, non-deprecated row that
 * superseded it at the moment its window closed, as {id, preview} JSON, or NULL. The one definition
 * every reader interpolates (R16): it walks idx_edges_target from the outer row and fetches each
 * closer by primary key (CROSS JOIN fixes that order; a join SQLite may reorder drove it from
 * idx_entries_workspace_created and read the whole workspace per returned row), and an open row
 * (valid_until NULL, nearly every row) skips it entirely.
 */
export function supersededBySql(outer: string): string {
  // scope-checked: the closer s is pinned to the outer row's own workspace, which the embedding statement scopes
  // R18 class sweep (review): a held (quarantined) row must not surface here either — it reads
  // outside the candidate pipeline (recall's own NOT_HELD_SQL filter never runs over it), and the
  // preview it returns is caller-facing content.
  return `CASE WHEN ${outer}.valid_until IS NULL THEN NULL ELSE (SELECT json_object('id', s.id, 'preview', substr(s.content, 1, 60))
       FROM edges g CROSS JOIN entries s ON s.id = g.source_id
      WHERE g.target_id = ${outer}.id AND g.type = 'supersedes'
        AND s.tags NOT LIKE '%"status:deprecated"%'
        AND ${notHeldSqlFor("s")}
        AND s.workspace_id = ${outer}.workspace_id
        AND COALESCE(s.valid_from, s.created_at) = ${outer}.valid_until
      ORDER BY s.created_at DESC LIMIT 1) END`;
}

/** Actually true at T: starts at or before T and ends after T. */
export function validAtSql(p: Params, alias: string, t: number): string {
  const at = p.add(t);
  return `(${EFFECTIVE_FROM(alias)} <= ${at} AND (${alias}.valid_until IS NULL OR ${alias}.valid_until > ${at}))`;
}

/**
 * The window a new memory is stored with, from what the caller stated. A fact told only with its end,
 * or with an end before the moment it is recorded and no start, starts at UNKNOWN_START.
 */
export function statedWindow(
  v: { from?: number | null; until?: number | null } | undefined, createdAt: number,
): { valid_from: number | null; valid_until: number | null } | { error: string } {
  const from = v?.from ?? null;
  const until = v?.until ?? null;
  if (until === null) return { valid_from: from, valid_until: null };
  if (from === null) return { valid_from: until < createdAt ? UNKNOWN_START : null, valid_until: until };
  if (until < from) return { error: "valid_until is before valid_from." };
  return { valid_from: from, valid_until: until };
}

/** A validity date in replies: "Jun 1, 2026", in the brain's TIMEZONE. */
export function formatValidityDate(ms: number, timezone: string): string {
  return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: timezone });
}

/** The `remember` reply for a supersede (spec 14 5.4). `closed` is CaptureResult.supersede. */
export function supersedeReply(
  id: string, conflictId: string,
  closed: { at: number; direction: "older" | "newer"; conflictPreview: string }, timezone: string,
): string {
  const date = formatValidityDate(closed.at, timezone);
  return closed.direction === "older"
    ? `Stored. ID: ${id}. It replaces memory ${conflictId} ("${closed.conflictPreview}"), which is kept as history: true until ${date}. If that was wrong, undo(${conflictId}) makes ${conflictId} current again.`
    : `Stored. ID: ${id} as history: it was true until ${date}, when memory ${conflictId} began.`;
}

export interface Window { id: string; from: number; until: number | null; workspaceId: string; status: MemoryStatus | null }

export type SupersedePlan =
  | { action: "close-older"; olderId: string; at: number }
  | { action: "close-newer"; newerId: string; at: number }
  | { action: "none"; reason: "disjoint" | "already-closed-earlier" | "enclosed" };

/**
 * Compares effective windows, not arrival order (P4). Pure interval logic: canonical protection
 * is the caller's, and applies only to close-older.
 *
 * - newer starts later: close the older row at the newer start, unless the older one had already
 *   ended by then, or the newer fact is a closed episode inside the older window ("enclosed": a
 *   fact told as already over never ends a current one).
 * - newer starts at or before the older start (late-told, or a tie): close the newcomer at the
 *   older start, unless its stated end is at or before that start (disjoint).
 */
export function planSupersede(older: Window, newer: Window): SupersedePlan {
  if (newer.from > older.from) {
    if (older.until !== null && older.until <= newer.from) return { action: "none", reason: "already-closed-earlier" };
    if (newer.until !== null && (older.until === null || older.until >= newer.until)) return { action: "none", reason: "enclosed" };
    return { action: "close-older", olderId: older.id, at: newer.from };
  }
  if (newer.until !== null && newer.until <= older.from) return { action: "none", reason: "disjoint" };
  return { action: "close-newer", newerId: newer.id, at: older.from };
}

/**
 * The supersede batch for a plan: [validity snapshot, guarded UPDATE, prune, edge]. Empty for a
 * plan of none. The row closed is pinned to its window's workspace, compare-and-sets the
 * valid_until it was read with, and is never a deprecated row; `guard` (a system job's own CAS,
 * e.-qualified, values only through its Params) joins both the snapshot and the UPDATE. The edge
 * lands only if the window did close, so a lost CAS writes no version and no edge. Vectors and
 * updated_at are untouched: a superseded fact is history, not wrong (D2.1).
 */
export function supersedeStatements(
  env: Env, plan: SupersedePlan, older: Window, newer: Window, change: ChangeContext,
  cfg: Readonly<Config>, guard?: (p: Params) => string,
): D1PreparedStatement[] {
  if (plan.action === "none") return [];
  const [target, closer] = plan.action === "close-older" ? [older, newer] : [newer, older];
  const at = plan.at;
  const cas = (p: Params) => [
    `e.workspace_id = ${p.add(target.workspaceId)}`,
    `e.valid_until IS ${p.add(target.until)}`,
    `e.tags NOT LIKE ${DEPRECATED_LIKE}`,
    ...(guard ? [`(${guard(p)})`] : []),
  ].join(" AND ");

  const up = new Params();
  // versioning: snapshot
  // scope-exempt: by-id: the conflict row read pinned to the writer's workspace; the CAS re-pins it
  const updateSql = `UPDATE entries AS e SET write_marker = ${up.add(memoryWriteMarker(env))}, valid_until = ${up.add(at)} WHERE e.id = ${up.add(target.id)} AND ${cas(up)}`;

  const ep = new Params();
  const edgeValues = [crypto.randomUUID(), closer.id, target.id, "supersedes", 1.0, "system", "{}", Date.now(), Date.now(), target.workspaceId].map(v => ep.add(v));
  const sameWorkspace = JSON.stringify([target.workspaceId]);
  const edgeSql =
    // scope-exempt: by-id: both endpoints pinned to the closed row's workspace; lands only if the window closed
    `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id, write_marker)
     SELECT ${edgeValues.join(", ")}, ${ep.add(memoryWriteMarker(env))}
      WHERE ${edgeEndpointsReadableSql(ep.add(closer.id), ep.add(target.id), ep.add(sameWorkspace))} AND ${windowClosedSql(ep, target.id, at)}
     ON CONFLICT(source_id, target_id, type) DO UPDATE SET weight = max(weight, excluded.weight), updated_at = excluded.updated_at, write_marker = excluded.write_marker`;

  return [
    snapshotStatement(env, {
      entryId: target.id, reason: "validity", change, content: { kind: "unchanged" }, nextTags: "unchanged",
      nextState: { valid_until: at }, meta: { cause: "supersede", by: closer.id }, now: Date.now(), guard: cas,
    }),
    env.DB.prepare(updateSql).bind(...up.values()),
    pruneStatement(env, target.id, cfg.VERSION_KEEP),
    env.DB.prepare(edgeSql).bind(...ep.values()),
  ];
}

/** True once `id`'s window is closed at `at`: a hook statement's "the write it rides on landed" guard. */
export function windowClosedSql(p: Params, id: string, at: number): string {
  // scope-exempt: by-id: the row this batch's own guarded UPDATE just wrote
  return `EXISTS (SELECT 1 FROM entries x WHERE x.id = ${p.add(id)} AND x.valid_until = ${p.add(at)})`;
}

// ── Retraction: restore rule and un-retraction (T-0089.2.4, D-RET; spec 14 5.6) ──
//
// Invariant: a closed window needs a live, non-deprecated closer (P3). When a row that closed others
// is retracted (marked wrong, dismissed, forgotten, trashed, reverted to wrong), the rows it closed
// at its own start reopen, or inherit its end when it had itself been closed; undoing the retraction
// closes them again. The hooks are set-based SQL keyed by the retracted ids, appended to the entry
// point's own batch after its write, so they cost no extra execution and land only with it: the
// first statement carries the entry point's "landed" guard over the retracted row `x`, and every
// later one keys off the per-hook nonce the first wrote into each row's new version.

/** A retracted (or un-retracted) row, pinned to the workspace its caller authorized. */
export interface HookRow { id: string; workspaceId: string }
/** SQL over the retracted row aliased `x`: true once the entry point's own write has landed. */
export type LandedGuard = (p: Params) => string;
export interface ValidityChange { id: string; preview: string; by: string; until: number | null }
/** A memory built on a retracted one (T-0089.2.4 cascade), flagged or unflagged by a hook. */
export interface DependentChange { id: string; by: string; demoted: boolean }
/** What one hook changed, read back from its batch results. */
export interface HookResult { restored: ValidityChange[]; reclosed: ValidityChange[]; flagged: DependentChange[]; unflagged: DependentChange[] }
export interface ValidityHook {
  statements: D1PreparedStatement[];
  /** What this hook changed; `offset` is where its statements start in the batch. */
  read(results: D1Result[], offset: number): HookResult;
}

const DEPRECATED = `'%"status:deprecated"%'`;
const EMPTY_RESULT: HookResult = { restored: [], reclosed: [], flagged: [], unflagged: [] };
/** The newest version's meta of the row aliased `a`. */
const NEWEST_META = (a: string) =>
  // scope-exempt: by-id: versions of a row the enclosing statement already pinned
  `(SELECT v.meta FROM entry_versions v WHERE v.entry_id = ${a}.id ORDER BY v.seq DESC LIMIT 1)`;
const NEWEST_REASON = (a: string) =>
  // scope-exempt: by-id: versions of a row the enclosing statement already pinned
  `(SELECT v.reason FROM entry_versions v WHERE v.entry_id = ${a}.id ORDER BY v.seq DESC LIMIT 1)`;
/** Rows some retracted id closed: the indexed pre-filter every restore statement starts from. */
const closedBy = (p: Params, pairs: string) =>
  // scope-exempt: by-id: supersedes targets of the caller's authorized rows; each statement pins the workspace
  `(SELECT g.target_id FROM edges g WHERE g.type = 'supersedes' AND g.source_id IN (SELECT json_extract(k.value, '$[0]') FROM json_each(${pairs}) k))`;
const authorized = (pairs: string, x: string) =>
  `EXISTS (SELECT 1 FROM json_each(${pairs}) k WHERE json_extract(k.value, '$[0]') = ${x}.id AND json_extract(k.value, '$[1]') = ${x}.workspace_id)`;
const ids = (pairs: string) => `(SELECT json_extract(k.value, '$[0]') FROM json_each(${pairs}) k)`;

/** The digest a source's "[Digest: <id>]" marker names (compression/digest.ts markSourcesRolledUp), or NULL. */
const digestOf = (x: string) =>
  `CASE WHEN instr(${x}.content, '[Digest: ') > 0 THEN substr(${x}.content, instr(${x}.content, '[Digest: ') + 9, instr(substr(${x}.content, instr(${x}.content, '[Digest: ') + 9), ']') - 1) END`;
/** Memories built on the retracted rows: insights drawn from them, memories caused by them, their digests. */
const dependentsOf = (pairs: string) =>
  // scope-exempt: by-id: dependents of the caller's authorized rows; each statement pins the workspace
  `(SELECT g.source_id FROM edges g WHERE g.type IN ('drawn_from', 'caused_by') AND g.target_id IN ${ids(pairs)}
     UNION SELECT ${digestOf("xd")} FROM entries xd WHERE xd.id IN ${ids(pairs)})`;
/**
 * The retracted row the dependent `d` was built on, when the entry point's write landed. A digest
 * counts only as what markSourcesRolledUp made it: a synthesized row named by a rolled-up source,
 * so a hand-written "[Digest: id]" cannot flag an ordinary memory.
 */
const builtOn = (p: Params, pairs: string, d: string, landed: LandedGuard) =>
  // scope-checked: x is one of the caller's authorized rows (pairs pin id and workspace), d shares its workspace
  `(SELECT x.id FROM entries x
     WHERE x.id IN ${ids(pairs)} AND ${authorized(pairs, "x")} AND x.workspace_id = ${d}.workspace_id AND x.id <> ${d}.id
       AND (EXISTS (SELECT 1 FROM edges g WHERE g.source_id = ${d}.id AND g.target_id = x.id AND g.type IN ('drawn_from', 'caused_by'))
            OR (${d}.id = ${digestOf("x")} AND x.tags LIKE '%"rolled-up"%' AND ${d}.tags LIKE '%"synthesized"%'))
       AND (${landed(p)})
     ORDER BY x.id LIMIT 1)`;
/** System-derived and not canonical: its only reason to exist was its inputs (D2.4), so it is demoted. */
const systemDerived = (d: string) =>
  `((${d}.tags LIKE '%"auto-insight"%' OR ${d}.tags LIKE '%"synthesized"%') AND COALESCE(${d}.actor_id, '') = '' AND ${d}.tags NOT LIKE '%"status:canonical"%')`;
const CASCADE_VERSION = (v: string) => `${v}.reason = 'status' AND json_extract(${v}.meta, '$.cause') = 'retraction'`;
export const CASCADE_LIMIT = 25;

// RETURNING cannot name the UPDATE's alias, so its correlated reads use the table name (`entries`).
function readChanged(results: D1Result[], index: number): ValidityChange[] {
  const rows = (results[index]?.results ?? []) as { id: string; preview: string | null; by_id: string | null; until_ms: number | null }[];
  return rows.map(r => ({ id: r.id, preview: r.preview ?? "", by: r.by_id ?? "", until: r.until_ms ?? null }));
}
function readDependents(results: D1Result[], index: number): DependentChange[] {
  const rows = (results[index]?.results ?? []) as { id: string; by_id: string | null; demoted: number | null }[];
  return rows.map(r => ({ id: r.id, by: r.by_id ?? "", demoted: r.demoted === 1 }));
}

/**
 * Restore rule. For each row y a retracted x closed at x's own start (y.valid_until = x's effective
 * start, same workspace, x not an empty window): y's window reopens to x's own end (NULL when x was
 * current), recorded as a validity version (cause retraction), and when x had itself been closed by
 * a live z, the edge z supersedes y keeps "replaced by" true. A y whose end was changed since is left
 * alone. Four statements: [snapshot, update, inherited edge, prune], then with `cascade` three more
 * that flag what was built on x (flagStatements).
 */
export function retractionHook(
  env: Env, xs: HookRow[], landed: LandedGuard, change: ChangeContext, cfg: Readonly<Config>, now: number,
  opts: { cascade?: boolean } = {},
): ValidityHook {
  const nonce = crypto.randomUUID();
  const pairsJson = JSON.stringify(xs.map(x => [x.id, x.workspaceId]));
  const closer = (p: Params, pairs: string) =>
    // scope-checked: x is one of the caller's authorized rows (pairs pin id and workspace), y shares its workspace
    `(SELECT x.id FROM edges g JOIN entries x ON x.id = g.source_id
       WHERE g.target_id = e.id AND g.type = 'supersedes' AND ${authorized(pairs, "x")} AND x.workspace_id = e.workspace_id
         AND e.valid_until = COALESCE(x.valid_from, x.created_at)
         AND (x.valid_until IS NULL OR x.valid_until > COALESCE(x.valid_from, x.created_at))
         AND (${landed(p)})
       ORDER BY x.id LIMIT 1)`;
  const snapshot = buildDerivedSnapshot({
    writeMarker: memoryWriteMarker(env),
    reason: "validity", change, now,
    meta: p => { const pairs = p.add(pairsJson); return `json_object('cause', 'retraction', 'retracted', ${closer(p, pairs)}, 'nonce', ${p.add(nonce)})`; },
    where: p => { const pairs = p.add(pairsJson); return `WHERE e.id IN ${closedBy(p, pairs)} AND ${closer(p, pairs)} IS NOT NULL`; },
  });
  const mine = (p: Params, a: string) => `${a}.id IN ${closedBy(p, p.add(pairsJson))} AND json_extract(${NEWEST_META(a)}, '$.nonce') = ${p.add(nonce)}`;

  const up = new Params();
  // versioning: snapshot
  // scope-checked: only rows whose newest version is this hook's own (nonce), found through the authorized pairs
  const updateSql = `UPDATE entries AS e SET write_marker = ${up.add(memoryWriteMarker(env))}, valid_until = (SELECT x.valid_until FROM entries x WHERE x.id = json_extract(${NEWEST_META("e")}, '$.retracted'))
     WHERE ${mine(up, "e")}
     RETURNING id, substr(content, 1, 60) AS preview, json_extract(${NEWEST_META("entries")}, '$.retracted') AS by_id, valid_until AS until_ms`;

  const ep = new Params();
  const at = ep.add(now);
  // scope-checked: y is this hook's own restored row; x its retracted closer; z x's live closer in the same workspace
  const inheritFrom = `FROM entries y, entries x, entries z
      WHERE ${mine(ep, "y")}
        AND x.id = json_extract(${NEWEST_META("y")}, '$.retracted')
        AND z.id = (SELECT g2.source_id FROM edges g2, entries z2
                     WHERE z2.id = g2.source_id AND g2.target_id = x.id AND g2.type = 'supersedes' AND z2.workspace_id = x.workspace_id
                       AND z2.id <> y.id AND z2.tags NOT LIKE ${DEPRECATED}
                       AND COALESCE(z2.valid_from, z2.created_at) = x.valid_until
                     ORDER BY z2.id LIMIT 1)`;
  const edgeSql =
    // scope-exempt: by-id: see inheritFrom; both endpoints re-checked readable in y's workspace
    `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id, write_marker)
     SELECT lower(hex(randomblob(16))), z.id, y.id, 'supersedes', 1.0, 'system', '{}', ${at}, ${at}, y.workspace_id, ${ep.add(memoryWriteMarker(env))}
       ${inheritFrom} AND ${edgeEndpointsReadableSql("z.id", "y.id", "json_array(y.workspace_id)")}
     ON CONFLICT(source_id, target_id, type) DO NOTHING`;

  const flag = opts.cascade ? flagStatements(env, pairsJson, landed, change, cfg, now) : null;
  return {
    statements: [
      env.DB.prepare(snapshot.sql).bind(...snapshot.bindings),
      env.DB.prepare(updateSql).bind(...up.values()),
      env.DB.prepare(edgeSql).bind(...ep.values()),
      hookPrune(env, closedBy, pairsJson, nonce, cfg),
      ...(flag ?? []),
    ],
    read: (results, offset) => ({ ...EMPTY_RESULT, restored: readChanged(results, offset + 1), flagged: flag ? readDependents(results, offset + 5) : [] }),
  };
}

/**
 * The cascade (T-0089.2.4, D2.4): every memory built on a retracted row, one hop, same workspace, at
 * most CASCADE_LIMIT, gets the `retracted-source` tag; a system-derived one is also demoted to draft.
 * Flag, never block. One status version per (dependent, retracted source), cause retraction, so undo
 * knows every source a flag stands for. [snapshot, update, prune].
 */
function flagStatements(env: Env, pairsJson: string, landed: LandedGuard, change: ChangeContext, cfg: Readonly<Config>, now: number): D1PreparedStatement[] {
  const nonce = crypto.randomUUID();
  const snapshot = buildDerivedSnapshot({
    writeMarker: memoryWriteMarker(env),
    reason: "status", change, now,
    meta: p => {
      const pairs = p.add(pairsJson);
      return `json_object('cause', 'retraction', 'retracted', ${builtOn(p, pairs, "e", landed)}, 'demoted', CASE WHEN ${systemDerived("e")} AND e.tags NOT LIKE '%"status:draft"%' THEN 1 ELSE 0 END, 'nonce', ${p.add(nonce)})`;
    },
    where: p => {
      const pairs = p.add(pairsJson);
      // scope-checked: d is a dependent of the caller's authorized rows, pinned to their workspace by builtOn
      return `WHERE e.id IN (SELECT d.id FROM entries d
         WHERE d.id IN ${dependentsOf(pairs)} AND d.tags NOT LIKE ${DEPRECATED}
           AND ${builtOn(p, pairs, "d", landed)} IS NOT NULL
           AND (d.tags NOT LIKE '%"${RETRACTED_SOURCE_TAG}"%'
                OR (${systemDerived("d")} AND d.tags NOT LIKE '%"status:draft"%')
                OR NOT EXISTS (SELECT 1 FROM entry_versions v WHERE v.entry_id = d.id AND ${CASCADE_VERSION("v")}
                                AND json_extract(v.meta, '$.retracted') = ${builtOn(p, pairs, "d", landed)}))
         ORDER BY d.id LIMIT ${p.add(CASCADE_LIMIT)})`;
    },
  });
  const up = new Params();
  const pairs = up.add(pairsJson);
  const flagged = `json_insert(e.tags, '$[#]', '${RETRACTED_SOURCE_TAG}')`;
  const drafted = `(SELECT json_group_array(value) FROM (SELECT value FROM json_each(e.tags) WHERE value NOT LIKE 'status:%' AND value <> '${RETRACTED_SOURCE_TAG}'
                      UNION ALL SELECT 'status:draft' UNION ALL SELECT '${RETRACTED_SOURCE_TAG}'))`;
  // versioning: snapshot
  // scope-checked: only rows whose newest version is this cascade's own (nonce), found through the authorized pairs
  const updateSql = `UPDATE entries AS e SET write_marker = ${up.add(memoryWriteMarker(env))}, tags = CASE
         WHEN json_extract(${NEWEST_META("e")}, '$.demoted') = 1 THEN ${drafted}
         WHEN e.tags LIKE '%"${RETRACTED_SOURCE_TAG}"%' THEN e.tags
         ELSE ${flagged} END
     WHERE e.id IN ${dependentsOf(pairs)} AND json_extract(${NEWEST_META("e")}, '$.nonce') = ${up.add(nonce)}
     RETURNING id, json_extract(${NEWEST_META("entries")}, '$.retracted') AS by_id, json_extract(${NEWEST_META("entries")}, '$.demoted') AS demoted`;
  return [
    env.DB.prepare(snapshot.sql).bind(...snapshot.bindings),
    env.DB.prepare(updateSql).bind(...up.values()),
    hookPrune(env, (_p, pairs) => dependentsOf(pairs), pairsJson, nonce, cfg),
  ];
}

/**
 * Un-retraction (undo of Wrong, leaving deprecated, restore from the trash). For each row y the
 * un-retracted x had reopened (y still ends where x ends, and y's newest version is x's retraction
 * version, so nothing has changed y since), y closes again at x's start (cause unretraction).
 * Three statements: [snapshot, update, prune], then with `cascade` three that unflag (unflagStatements).
 */
export function unretractionHook(
  env: Env, xs: HookRow[], landed: LandedGuard, change: ChangeContext, cfg: Readonly<Config>, now: number,
  opts: { cascade?: boolean } = {},
): ValidityHook {
  const nonce = crypto.randomUUID();
  const pairsJson = JSON.stringify(xs.map(x => [x.id, x.workspaceId]));
  const retractedBy = (p: Params, pairs: string) =>
    // scope-checked: x is one of the caller's authorized rows (pairs pin id and workspace), y shares its workspace
    `(SELECT x.id FROM edges g JOIN entries x ON x.id = g.source_id
       WHERE g.target_id = e.id AND g.type = 'supersedes' AND ${authorized(pairs, "x")} AND x.workspace_id = e.workspace_id
         AND e.valid_until IS x.valid_until
         AND ${NEWEST_REASON("e")} = 'validity'
         AND json_extract(${NEWEST_META("e")}, '$.cause') = 'retraction'
         AND json_extract(${NEWEST_META("e")}, '$.retracted') = x.id
         AND (${landed(p)})
       ORDER BY x.id LIMIT 1)`;
  const snapshot = buildDerivedSnapshot({
    writeMarker: memoryWriteMarker(env),
    reason: "validity", change, now,
    meta: p => { const pairs = p.add(pairsJson); return `json_object('cause', 'unretraction', 'by', ${retractedBy(p, pairs)}, 'nonce', ${p.add(nonce)})`; },
    where: p => { const pairs = p.add(pairsJson); return `WHERE e.id IN ${closedBy(p, pairs)} AND ${retractedBy(p, pairs)} IS NOT NULL`; },
  });
  const up = new Params();
  // versioning: snapshot
  // scope-checked: only rows whose newest version is this hook's own (nonce), found through the authorized pairs
  const updateSql = `UPDATE entries AS e SET write_marker = ${up.add(memoryWriteMarker(env))}, valid_until = (SELECT COALESCE(x.valid_from, x.created_at) FROM entries x WHERE x.id = json_extract(${NEWEST_META("e")}, '$.by'))
     WHERE e.id IN ${closedBy(up, up.add(pairsJson))} AND json_extract(${NEWEST_META("e")}, '$.nonce') = ${up.add(nonce)}
     RETURNING id, substr(content, 1, 60) AS preview, json_extract(${NEWEST_META("entries")}, '$.by') AS by_id, valid_until AS until_ms`;
  const unflag = opts.cascade ? unflagStatements(env, pairsJson, landed, change, cfg, now) : null;
  return {
    statements: [
      env.DB.prepare(snapshot.sql).bind(...snapshot.bindings),
      env.DB.prepare(updateSql).bind(...up.values()),
      hookPrune(env, closedBy, pairsJson, nonce, cfg),
      ...(unflag ?? []),
    ],
    read: (results, offset) => ({ ...EMPTY_RESULT, reclosed: readChanged(results, offset + 1), unflagged: unflag ? readDependents(results, offset + 4) : [] }),
  };
}

/**
 * Undo of the cascade. The marker comes off a dependent of the un-retracted x only when every source
 * its cascade versions record is live and not wrong again, and its history reaches back unpruned
 * (seq 1 kept), so no recorded source can be missing; otherwise it stays, and Keep clears it. A
 * dependent the cascade demoted, and still draft, gets its status from before the first cascade.
 */
function unflagStatements(env: Env, pairsJson: string, landed: LandedGuard, change: ChangeContext, cfg: Readonly<Config>, now: number): D1PreparedStatement[] {
  const nonce = crypto.randomUUID();
  const snapshot = buildDerivedSnapshot({
    writeMarker: memoryWriteMarker(env),
    reason: "status", change, now,
    meta: p => { const pairs = p.add(pairsJson); return `json_object('cause', 'unretraction', 'by', ${builtOn(p, pairs, "e", landed)}, 'nonce', ${p.add(nonce)})`; },
    where: p => {
      const pairs = p.add(pairsJson);
      // scope-exempt: by-id: versions of the dependent the enclosing statement already pinned
      return `WHERE e.id IN ${dependentsOf(pairs)} AND e.tags LIKE '%"${RETRACTED_SOURCE_TAG}"%'
         AND ${builtOn(p, pairs, "e", landed)} IS NOT NULL
         AND EXISTS (SELECT 1 FROM entry_versions v WHERE v.entry_id = e.id AND ${CASCADE_VERSION("v")})
         AND NOT EXISTS (SELECT 1 FROM entry_versions v WHERE v.entry_id = e.id AND ${CASCADE_VERSION("v")}
                          AND NOT EXISTS (SELECT 1 FROM entries c WHERE c.id = json_extract(v.meta, '$.retracted') AND c.workspace_id = e.workspace_id AND c.tags NOT LIKE ${DEPRECATED}))
         AND (SELECT MIN(v.seq) FROM entry_versions v WHERE v.entry_id = e.id) = 1`;
    },
  });
  const up = new Params();
  const pairs = up.add(pairsJson);
  // scope-exempt: by-id: versions of the row the enclosing UPDATE already pinned
  const priorStatus = `(SELECT value FROM json_each((SELECT v.tags FROM entry_versions v WHERE v.entry_id = e.id AND ${CASCADE_VERSION("v")} ORDER BY v.seq ASC LIMIT 1)) WHERE value LIKE 'status:%' LIMIT 1)`;
  const restoreStatus = `(e.tags LIKE '%"status:draft"%' AND COALESCE(${priorStatus}, '') <> 'status:draft')`;
  // versioning: snapshot
  // scope-checked: only rows whose newest version is this unflag's own (nonce), found through the authorized pairs
  const updateSql = `UPDATE entries AS e SET write_marker = ${up.add(memoryWriteMarker(env))}, tags = (SELECT json_group_array(value) FROM (
         SELECT value FROM json_each(e.tags) WHERE value <> '${RETRACTED_SOURCE_TAG}' AND NOT (${restoreStatus} AND value LIKE 'status:%')
         UNION ALL SELECT ${priorStatus} WHERE ${restoreStatus} AND ${priorStatus} IS NOT NULL))
     WHERE e.id IN ${dependentsOf(pairs)} AND json_extract(${NEWEST_META("e")}, '$.nonce') = ${up.add(nonce)}
     RETURNING id, json_extract(${NEWEST_META("entries")}, '$.by') AS by_id, 0 AS demoted`;
  return [
    env.DB.prepare(snapshot.sql).bind(...snapshot.bindings),
    env.DB.prepare(updateSql).bind(...up.values()),
    hookPrune(env, (_p, pairs) => dependentsOf(pairs), pairsJson, nonce, cfg),
  ];
}

/** Prunes only the rows this hook versioned (its nonce): never another row's history. */
function hookPrune(env: Env, candidates: (p: Params, pairs: string) => string, pairsJson: string, nonce: string, cfg: Readonly<Config>): D1PreparedStatement {
  const p = new Params();
  // scope-exempt: by-id: rows this hook's own versions name (nonce), found through the caller's authorized pairs
    // write-fence: parent-capability=entry_versions（同batchのsnapshot・認可済み記憶をtriggerで検証）
  const sql = `DELETE FROM entry_versions WHERE entry_id IN (
       SELECT v.entry_id FROM entry_versions v WHERE v.entry_id IN ${candidates(p, p.add(pairsJson))} AND json_extract(v.meta, '$.nonce') = ${p.add(nonce)})
     AND seq <= (SELECT MAX(w.seq) FROM entry_versions w WHERE w.entry_id = entry_versions.entry_id) - ${p.add(cfg.VERSION_KEEP)}`;
  return env.DB.prepare(sql).bind(...p.values());
}

/** `validity_changed` and `flagged` events for what hooks changed. */
export function validityEvents(change: ChangeContext, ...hooks: HookResult[]): AuditEventInput[] {
  const channel = change.channel;
  return hooks.flatMap(h => [
    ...h.restored.map(c => ({ entryId: c.id, actorId: change.actorId, event: "validity_changed" as const, payload: { cause: "retraction", retracted: c.by, until: c.until, channel } })),
    ...h.reclosed.map(c => ({ entryId: c.id, actorId: change.actorId, event: "validity_changed" as const, payload: { cause: "unretraction", by: c.by, until: c.until, channel } })),
    ...h.flagged.map(d => ({ entryId: d.id, actorId: change.actorId, event: "flagged" as const, payload: { cause: "retraction", retracted: d.by, demoted: d.demoted, channel } })),
    ...h.unflagged.map(d => ({ entryId: d.id, actorId: change.actorId, event: "flagged" as const, payload: { action: "unflag", cause: "unretraction", by: d.by, channel } })),
  ]);
}

/** The same events as one audit batch, written only when a hook changed something. */
export async function auditValidity(env: Env, change: ChangeContext, ...hooks: HookResult[]): Promise<void> {
  const events = validityEvents(change, ...hooks);
  if (events.length) await writeAuditEvents(env, events);
}

/** Result field every retraction entry point returns (spec 14 5.6). */
export interface ValidityOutcome { restored: { id: string; preview: string }[]; reclosed: { id: string; preview: string }[]; flagged: number; unflagged: number }
export const NO_VALIDITY_CHANGE: ValidityOutcome = { restored: [], reclosed: [], flagged: 0, unflagged: 0 };
export function outcomeOf(...hooks: HookResult[]): ValidityOutcome {
  return {
    restored: hooks.flatMap(h => h.restored.map(c => ({ id: c.id, preview: c.preview }))),
    reclosed: hooks.flatMap(h => h.reclosed.map(c => ({ id: c.id, preview: c.preview }))),
    flagged: hooks.reduce((n, h) => n + h.flagged.length, 0),
    unflagged: hooks.reduce((n, h) => n + h.unflagged.length, 0),
  };
}

/**
 * The sentences a retraction entry point appends to its reply (spec 14 5.9; the forget wording is the
 * director's Q1 copy). `subject` is the memory the call acted on. Empty when nothing changed.
 */
export function validityReplySuffix(v: ValidityOutcome, subject: string, kind: "status" | "forget" | "undo"): string {
  let text = "";
  if (v.restored.length === 1) {
    const [r] = v.restored;
    text += kind === "forget" ? ` The older memory ${r.id} is current again.` : ` Memory ${r.id} ("${r.preview}") is current again.`;
  } else if (v.restored.length > 1) {
    text += ` ${v.restored.length} older memories are current again: ${v.restored.map(r => r.id).join(", ")}.`;
  }
  if (v.reclosed.length === 1) text += ` Memory ${v.reclosed[0].id} is replaced by ${subject} again.`;
  else if (v.reclosed.length > 1) text += ` Memories ${v.reclosed.map(r => r.id).join(", ")} are replaced by ${subject} again.`;
  if (v.flagged === 1) text += " 1 memory built on it was flagged for a check.";
  else if (v.flagged > 1) text += ` ${v.flagged} memories built on it were flagged for a check.`;
  return text;
}

// ── Explicit validity (T-0089.2.1, D2.2; spec 14 5.4) ──────────────────────

export const VALIDITY_WITH_CONTENT_ERROR = "To record that something changed, remember the new fact; the old one is kept as history.";

/**
 * valid_from / valid_until as a surface received them: absent (undefined), a date string, or null
 * (update only: back to "since created_at", or "still true"). Parsed in the brain's TIMEZONE; the
 * first bad field is named so REST can return it.
 */
export function parseValidityInput(
  raw: { valid_from?: unknown; valid_until?: unknown }, now: number, timezone: string, opts: { allowNull: boolean },
): { value: { from?: number | null; until?: number | null } } | { error: string; field: "valid_from" | "valid_until" } {
  const value: { from?: number | null; until?: number | null } = {};
  for (const [field, key] of [["valid_from", "from"], ["valid_until", "until"]] as const) {
    const v = raw[field];
    if (v === undefined) continue;
    if (v === null && opts.allowNull) { value[key] = null; continue; }
    if (typeof v !== "string") return { error: `${field} must be a date like 2026-06-15, a month like 2026-06, or a year like 2026.`, field };
    const parsed = parseValidityDate(v, now, timezone, "start");
    if (typeof parsed !== "number") return { error: parsed.error, field };
    value[key] = parsed;
  }
  if (typeof value.from === "number" && typeof value.until === "number" && value.until < value.from) {
    return { error: "valid_until is before valid_from.", field: "valid_until" };
  }
  return { value };
}

export type UpdateValidityResult =
  | { status: "updated"; validFrom: number | null; validUntil: number | null; effectiveFrom: number; propagated: string[]; changed: { from: boolean; until: boolean } }
  | { status: "no_change" }
  | { status: "not_found" }
  | { status: "conflict" }
  | { status: "refused"; error: string; field: "valid_from" | "valid_until" };

const PROPAGATE_LIMIT = 10;

/**
 * update(valid_from / valid_until) without new content: one read, one batch. The row compare-and-sets
 * the window it was read with and its workspace; the caller has already authorized it (the same scoped
 * read and author lock as a content edit). When the start moves, every row this one closed at its old
 * start (at most PROPAGATE_LIMIT, same workspace) moves its end to match (cause propagate), so
 * "replaced by" stays true; a move to or before such a row's own start is refused, naming it.
 */
export async function updateEntryValidity(
  env: Env, id: string, next: { from?: number | null; until?: number | null }, change: ChangeContext, cfg: Readonly<Config>,
  authorizedWorkspaceId: string,
  ctx?: ExecutionContext,
): Promise<UpdateValidityResult> {
  const ws = authorizedWorkspaceId ?? "";
  const row = await env.DB.prepare(
    // scope-checked: pinned to the workspace the caller's own scoped read authorized; the replaced rows share it
    `SELECT e.created_at, e.valid_from, e.valid_until, e.tags,
            (SELECT json_group_array(json_object('id', t.id, 'from', t.start)) FROM (
               SELECT y.id AS id, COALESCE(y.valid_from, y.created_at) AS start FROM edges g JOIN entries y ON y.id = g.target_id
                WHERE g.source_id = e.id AND g.type = 'supersedes' AND y.workspace_id = e.workspace_id
                  AND y.valid_until = COALESCE(e.valid_from, e.created_at)
                ORDER BY y.id LIMIT ${PROPAGATE_LIMIT}) t) AS replaced_json
       FROM entries e WHERE e.id = ? AND e.workspace_id = ?`,
  ).bind(id, ws).first<{ created_at: number; valid_from: number | null; valid_until: number | null; tags: string; replaced_json: string | null }>();
  if (!row) return { status: "not_found" };

  const validFrom = next.from !== undefined ? next.from : row.valid_from;
  const validUntil = next.until !== undefined ? next.until : row.valid_until;
  const oldStart = row.valid_from ?? row.created_at;
  const effectiveFrom = validFrom ?? row.created_at;
  if (validUntil !== null && validUntil < effectiveFrom) {
    return {
      status: "refused", field: "valid_until",
      error: `That end date is before this memory's start (${formatValidityDate(effectiveFrom, cfg.TIMEZONE)}). Pass valid_from too if it began earlier.`,
    };
  }
  const changed = { from: validFrom !== row.valid_from, until: validUntil !== row.valid_until };
  if (!changed.from && !changed.until) return { status: "no_change" };

  const replaced = (JSON.parse(row.replaced_json ?? "[]") as { id: string; from: number }[]).filter(r => r && r.id);
  const moving = effectiveFrom !== oldStart ? replaced : [];
  const blocking = moving.find(r => effectiveFrom <= r.from);
  if (blocking) {
    return {
      status: "refused", field: "valid_from",
      error: `Memory ${blocking.id} began on ${formatValidityDate(blocking.from, cfg.TIMEZONE)}, so ${id} cannot start before that. Nothing changed.`,
    };
  }

  const now = Date.now();
  const cas = (p: Params) => `e.workspace_id = ${p.add(ws)} AND e.valid_from IS ${p.add(row.valid_from)} AND e.valid_until IS ${p.add(row.valid_until)}`;
  const up = new Params();
  // versioning: snapshot
  // scope-exempt: by-id: the row the caller's scoped read authorized; the CAS re-pins its workspace
  const updateSql = `UPDATE entries AS e SET write_marker = ${up.add(memoryWriteMarker(env))}, valid_from = ${up.add(validFrom)}, valid_until = ${up.add(validUntil)} WHERE e.id = ${up.add(id)} AND ${cas(up)}`;
  const statements: D1PreparedStatement[] = [
    snapshotStatement(env, {
      entryId: id, reason: "validity", change, content: { kind: "unchanged" }, nextTags: "unchanged",
      nextState: { valid_from: validFrom, valid_until: validUntil }, meta: { cause: "explicit" }, now, guard: cas,
    }),
    env.DB.prepare(updateSql).bind(...up.values()),
    pruneStatement(env, id, cfg.VERSION_KEEP),
  ];
  // Each replaced row moves only if this row's new start landed, and only if its end still meets the old one.
  const landed = (p: Params) =>
    // scope-exempt: by-id: the row this batch's own UPDATE just wrote
    `EXISTS (SELECT 1 FROM entries x WHERE x.id = ${p.add(id)} AND COALESCE(x.valid_from, x.created_at) = ${p.add(effectiveFrom)})`;
  for (const r of moving) {
    const guard = (p: Params) => `e.workspace_id = ${p.add(ws)} AND e.valid_until = ${p.add(oldStart)} AND ${landed(p)}`;
    const pp = new Params();
    // versioning: snapshot
    // scope-exempt: by-id: a row this one replaced, read above in the same workspace; the guard re-pins it
    const sql = `UPDATE entries AS e SET write_marker = ${pp.add(memoryWriteMarker(env))}, valid_until = ${pp.add(effectiveFrom)} WHERE e.id = ${pp.add(r.id)} AND ${guard(pp)}`;
    statements.push(
      snapshotStatement(env, {
        entryId: r.id, reason: "validity", change, content: { kind: "unchanged" }, nextTags: "unchanged",
        nextState: { valid_until: effectiveFrom }, meta: { cause: "propagate", by: id }, now, guard,
      }),
      env.DB.prepare(sql).bind(...pp.values()),
      pruneStatement(env, r.id, cfg.VERSION_KEEP),
    );
  }
  const results = await env.DB.batch(statements);
  if (changesOf(results[1]) === 0) return { status: "conflict" };
  const propagated = moving.filter((_, i) => changesOf(results[4 + i * 3]) > 0).map(r => r.id);
  await writeAuditEvents(env, [
    { entryId: id, actorId: change.actorId, event: "validity_changed", payload: { cause: "explicit", valid_from: validFrom, valid_until: validUntil, channel: change.channel } },
    ...propagated.map(pid => ({ entryId: pid, actorId: change.actorId, event: "validity_changed" as const, payload: { cause: "propagate", by: id, until: effectiveFrom, channel: change.channel } })),
  ]);
  // Review NIT (spec 15 2.6): a standing row whose window just opened or closed changes whether
  // the cache build's own currentValidityAt filter admits it. Hydration already re-checks this
  // independently (2.4/2.6), so a missed touch is never unsafe, but it would otherwise sit stale
  // for up to 24h and GET /standing would keep reporting firing: true. Propagated rows are not
  // checked here — a standing row is never itself in a supersede chain via valid_from/until
  // propagation, and if it were, the same 24h self-heal applies.
  {
    let tags: string[] = [];
    try { tags = JSON.parse(row.tags ?? "[]"); } catch { /* leave empty: an unparsable tags column touches nothing */ }
    if (tags.includes("standing:active")) {
      // ctx is optional here (unlike the other lane D writers): a validity edit is rare enough
      // that a caller with no ExecutionContext to defer into still gets a correct rebuild, just
      // an awaited one instead of one off the response path.
      if (ctx) standingTouched(env, ctx, cfg, [ws]);
      else await buildStandingCache(env, cfg, ws);
    }
  }
  return { status: "updated", validFrom, validUntil, effectiveFrom, propagated, changed };
}

/** The update reply for a validity change (spec 14 5.4). */
export function updateValidityReply(id: string, r: Extract<UpdateValidityResult, { status: "updated" }>, timezone: string): string {
  const d = (ms: number) => formatValidityDate(ms, timezone);
  let text: string;
  if (r.changed.from && r.validUntil !== null) text = `Memory ${id} is now recorded as true from ${d(r.effectiveFrom)} until ${d(r.validUntil)}. It stays in history and is left out of current answers. Undo is available.`;
  else if (r.changed.from) text = `Memory ${id} is now recorded as true from ${d(r.effectiveFrom)}.`;
  else if (r.validUntil === null) text = `Memory ${id} is current again. Undo is available.`;
  else text = `Memory ${id} is now recorded as true until ${d(r.validUntil)}. It stays in history and is left out of current answers. Undo is available.`;
  if (r.propagated.length === 1) text += ` Memory ${r.propagated[0]}'s end date moved to match.`;
  else if (r.propagated.length > 1) text += ` Memories ${r.propagated.join(", ")} had their end dates moved to match.`;
  return text;
}

// ── Date grammar ─────────────────────────────────────────────────────────────

const FUTURE_ERROR = "That date is in the future. Use when for plans and deadlines; valid dates are for what has already happened.";
const PARSE_ERROR = "Use a date like 2026-06-15, a month like 2026-06, or a year like 2026.";
const PERIOD_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const OFFSET_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const BARE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** The calendar date `ms` falls on in `timezone`. */
function zonedDate(ms: number, timezone: string): { y: number; m0: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ms);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
  return { y: get("year"), m0: get("month") - 1, d: get("day") };
}

const validDay = (y: number, m0: number, d: number) => {
  const probe = new Date(Date.UTC(y, m0, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m0 && probe.getUTCDate() === d;
};

/**
 * A validity date in the brain's TIMEZONE (spec 14 5.4). `start` is the first instant of the named
 * period: valid_from, and valid_until (the first day it was no longer true). `end` is its last
 * instant: as_of, which includes the whole day, month or year asked about, cut at the end of today.
 * Anything later than the end of today is refused (P5).
 */
export function parseValidityDate(raw: string, now: number, timezone: string, bound: "start" | "end"): number | { error: string } {
  const s = typeof raw === "string" ? raw.trim() : "";
  const today = zonedDate(now, timezone);
  const endOfToday = zonedTimeMs(today.y, today.m0, today.d + 1, 0, 0, 0, timezone) - 1;
  let start: number;
  let end: number;
  const period = PERIOD_RE.exec(s);
  const bare = BARE_DATETIME_RE.exec(s);
  if (period) {
    const y = Number(period[1]);
    const m0 = period[2] !== undefined ? Number(period[2]) - 1 : 0;
    const d = period[3] !== undefined ? Number(period[3]) : 1;
    if (m0 < 0 || m0 > 11 || !validDay(y, m0, d)) return { error: PARSE_ERROR };
    start = zonedTimeMs(y, m0, d, 0, 0, 0, timezone);
    const next = period[3] !== undefined ? [y, m0, d + 1] : period[2] !== undefined ? [y, m0 + 1, 1] : [y + 1, 0, 1];
    end = zonedTimeMs(next[0], next[1], next[2], 0, 0, 0, timezone) - 1;
  } else if (bare) {
    const [y, m0, d, h, mi, sec] = [Number(bare[1]), Number(bare[2]) - 1, Number(bare[3]), Number(bare[4]), Number(bare[5]), Number(bare[6] ?? 0)];
    if (!validDay(y, m0, d) || h > 23 || mi > 59 || sec > 59) return { error: PARSE_ERROR };
    start = end = zonedTimeMs(y, m0, d, h, mi, sec, timezone);
  } else if (OFFSET_DATETIME_RE.test(s)) {
    start = end = Date.parse(s);
    if (Number.isNaN(start)) return { error: PARSE_ERROR };
  } else {
    return { error: PARSE_ERROR };
  }
  if (start > endOfToday) return { error: FUTURE_ERROR };
  return bound === "start" ? start : Math.min(end, endOfToday);
}
