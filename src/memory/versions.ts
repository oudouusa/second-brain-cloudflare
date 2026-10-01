import { assertMemoryWritesAllowed, memoryWriteMarker } from "../migration/write-lock";
import type { Env } from "../env";
import type { ChangeContext } from "../lib/audit";
import type { Identity } from "../lib/identity";
import { assertCanEditContent } from "../lib/entry-access";
import { readableWorkspaces } from "../lib/scope";
import { ensureTenantBootstrap } from "../lib/tenancy";
import { VERSIONS_SINCE_KV_KEY } from "../constants";
import { isHeld } from "../quarantine/tags";

export type VersionReason = "update" | "append" | "merge" | "replace" | "rollup" | "status" | "due" | "mirror" | "revert" | "validity";
export type ContentChange = { kind: "unchanged" } | { kind: "suffix" } | { kind: "next"; content: string };
/** when_* columns the batch's UPDATE writes, and to what; omitted keys are untouched. */
export type WhenChange = Partial<{ when_at: number | null; when_kind: string | null; when_source: string | null; when_label: string | null }>;
/** Every non-text column a version's `state` records: when_* plus the validity window (T-0089.2.1). */
export type StateChange = WhenChange & Partial<{ valid_from: number | null; valid_until: number | null }>;
/** meta.cause on a `validity` version (spec 14 P7). */
export type ValidityCause = "supersede" | "explicit" | "retraction" | "unretraction" | "propagate";

const STATE_COLUMNS = ["when_at", "when_kind", "when_source", "when_label", "valid_from", "valid_until"] as const;

/**
 * Dense placeholder allocator. D1 rejects a statement whose numbered placeholders have gaps
 * ("Wrong number of parameter bindings") though node:sqlite accepts them, so every generated
 * statement takes its numbers from here: `?1..?n`, a repeated value reusing its number.
 */
export class Params {
  private readonly vals: unknown[] = [];
  private readonly seen = new Map<unknown, number>();

  add(value: unknown): string {
    const known = this.seen.get(value);
    if (known !== undefined) return `?${known}`;
    this.vals.push(value);
    this.seen.set(value, this.vals.length);
    return `?${this.vals.length}`;
  }

  values(): unknown[] {
    return [...this.vals];
  }
}

export interface SnapshotInput {
  writeMarker?: string | null;
  entryId: string;
  reason: VersionReason;
  change: ChangeContext;
  content: ContentChange;
  /** "unchanged": a write that leaves tags alone (validity writes), so the no-op check needs no tag read. */
  nextTags: string[] | "unchanged";
  nextWhen?: WhenChange;
  /** The validity columns the batch's UPDATE writes; merged over nextWhen for the no-op check. */
  nextState?: StateChange;
  meta?: Record<string, unknown>;
  /** This write's own prior content, read moments ago in JS — its native UTF-16 length, so a later
   * reconstruction never has to re-derive the boundary by scanning (ADV-10). Ignored (and left NULL)
   * on a row that lands as a full copy rather than a delta; only store.ts's writers have it to give. */
  priorLengthUtf16?: number;
  /** e.-qualified copy of the UPDATE's compare-and-set predicate; values only through p. */
  guard?: (p: Params) => string;
  /** Revert only: snapshot only if MAX(seq) still equals this. */
  expectNewestSeq?: number;
  /** Default true; a revert passes false (undo handles no-ops before the batch). */
  skipNoOp?: boolean;
  now: number;
}

export interface BuiltStatement { sql: string; bindings: unknown[] }

/** Tag set as SQLite will compare it: sorted, compact JSON, like JSON.stringify of a sorted array. */
const SORTED_TAGS = `(SELECT json_group_array(value) FROM (SELECT value FROM json_each(e.tags) ORDER BY value))`;
// scope-exempt: by-id: correlated to entries e, which every embedding caller (buildSnapshot,
// buildSnapshotMany) restricts to an already-authorized id before this fragment runs
const NEWEST_SEQ = `COALESCE((SELECT MAX(v.seq) FROM entry_versions v WHERE v.entry_id = e.id), 0)`;

const INSERT_COLUMNS = `INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, prior_length_utf16, tags, state, actor_id, channel, reason, meta, valid_from, created_at, write_marker)`;

/**
 * SELECT list shared by the one-row and many-row snapshots. `delta` is a SQL boolean over e.content.
 *
 * R2-6: a Worker's own clock read (s.now) is taken before the batch travels to D1, so a slower
 * isolate's write can commit after a faster one's — created_at is clamped to at least the
 * previous version's own created_at (or the row's updated_at/created_at with no version yet), the
 * same floor valid_from above already uses, so seq order and created_at order cannot disagree.
 * A `--` SQL comment does not belong inside the string this builds: node:sqlite's test double
 * still runs it, but a bare `--` between two lines of one statement makes it report changes: 0
 * for a write that actually landed, silently defeating every compare-and-set guard's caller.
 */
function selectList(
  p: Params, delta: string,
  s: { writeMarker?: string | null; reason: VersionReason; change: ChangeContext; meta?: Record<string, unknown>; metaSql?: string; now: number; priorLengthUtf16?: number },
): string {
  // Every version's own meta carries the calling client, the same way its entry_events row
  // already does -- history-view.ts's changeItems and every reader of it (mcp/server.ts's
  // historyActorVia, history-view.js's item.client) read it off the version, not just the event.
  // A caller's own explicit meta.client (none today) always wins; metaSql callers build their own
  // JSON in SQL and are responsible for their own client field, same as before this comment.
  const meta = s.metaSql === undefined && s.change.client && (s.meta === undefined || s.meta.client === undefined)
    ? { ...s.meta, client: s.change.client }
    : s.meta;
  // scope-exempt: by-id: callers authorize the entry (or entries) before building the batch
  return `SELECT e.id, e.workspace_id,
       ${NEWEST_SEQ} + 1,
       CASE WHEN ${delta} THEN NULL ELSE e.content END,
       CASE WHEN ${delta} THEN length(e.content) ELSE NULL END,
       CASE WHEN ${delta} THEN ${s.priorLengthUtf16 !== undefined ? p.add(s.priorLengthUtf16) : "NULL"} ELSE NULL END,
       e.tags,
       json_object('when_at', e.when_at, 'when_kind', e.when_kind, 'when_source', e.when_source, 'when_label', e.when_label, 'valid_from', e.valid_from, 'valid_until', e.valid_until),
       ${p.add(s.change.actorId)}, ${p.add(s.change.channel)}, ${p.add(s.reason)}, ${s.metaSql ?? p.add(JSON.stringify(meta ?? {}))},
       COALESCE((SELECT v.created_at FROM entry_versions v WHERE v.entry_id = e.id AND v.seq = (SELECT MAX(x.seq) FROM entry_versions x WHERE x.entry_id = e.id)),
                COALESCE(e.updated_at, e.created_at)),
       MAX(${p.add(s.now)}, COALESCE((SELECT v.created_at FROM entry_versions v WHERE v.entry_id = e.id AND v.seq = (SELECT MAX(x.seq) FROM entry_versions x WHERE x.entry_id = e.id)),
                COALESCE(e.updated_at, e.created_at)))
       , ${p.add(s.writeMarker ?? null)}
  FROM entries e`;
}

export function buildSnapshot(s: SnapshotInput): BuiltStatement {
  const p = new Params();
  const noNul = `instr(e.content, char(0)) = 0`;
  const state: StateChange | undefined = s.nextWhen || s.nextState ? { ...s.nextWhen, ...s.nextState } : undefined;
  // Allocated only when used: a placeholder that never reaches the SQL leaves a gap D1 rejects.
  const stateSame = () => state
    ? STATE_COLUMNS.filter(c => c in state).map(c => `${p.add(state[c] ?? null)} IS e.${c}`).join(" AND ") || "1"
    : "1";
  const tagsSame = () => s.nextTags === "unchanged" ? "1" : `${p.add(JSON.stringify([...new Set(s.nextTags)].sort()))} = ${SORTED_TAGS}`;
  let delta: string;
  let skip: () => string;
  if (s.content.kind === "next") {
    const next = p.add(s.content.content);
    delta = `${noNul} AND instr(${next}, char(0)) = 0 AND substr(${next}, 1, length(e.content)) = e.content`;
    skip = () => `${next} IS e.content AND ${tagsSame()} AND ${stateSame()}`;
  } else if (s.content.kind === "suffix") {
    delta = noNul;
    skip = () => "0";
  } else {
    delta = noNul;
    skip = () => `${tagsSame()} AND ${stateSame()}`;
  }
  const list = selectList(p, delta, s);
  const conditions = [`e.id = ${p.add(s.entryId)}`];
  if (s.skipNoOp !== false) conditions.push(`NOT (${skip()})`);
  if (s.guard) conditions.push(`(${s.guard(p)})`);
  if (s.expectNewestSeq !== undefined) conditions.push(`${NEWEST_SEQ} = ${p.add(s.expectNewestSeq)}`);
  return {
    sql: `${INSERT_COLUMNS}\n${list}\n WHERE ${conditions.join("\n   AND ")}`,
    bindings: p.values(),
  };
}

export function snapshotStatement(env: Env, s: SnapshotInput): D1PreparedStatement {
  const b = buildSnapshot({ ...s, writeMarker: memoryWriteMarker(env) });
  return env.DB.prepare(b.sql).bind(...b.bindings);
}

export interface SnapshotManyInput {
  writeMarker?: string | null;
  entryIds: string[];
  reason: VersionReason;
  change: ChangeContext;
  content: { kind: "unchanged" | "suffix" };
  meta?: Record<string, unknown>;
  now: number;
}

/** One statement for many rows: the id list is a single JSON parameter, whatever its length. Never skips a no-op. */
export function buildSnapshotMany(s: SnapshotManyInput): BuiltStatement {
  const p = new Params();
  const list = selectList(p, `instr(e.content, char(0)) = 0`, s);
  return {
    sql: `${INSERT_COLUMNS}\n${list}\n WHERE e.id IN (SELECT value FROM json_each(${p.add(JSON.stringify(s.entryIds))}))`,
    bindings: p.values(),
  };
}

export interface DerivedSnapshotInput {
  writeMarker?: string | null;
  reason: VersionReason;
  change: ChangeContext;
  now: number;
  /** A SQL expression over the row `e` for its meta JSON (json_object(...)); values only through p. */
  meta: (p: Params) => string;
  /** Everything after the snapshot's own FROM over entries (alias e): the rows to snapshot (WHERE ...); values only through p. */
  where: (p: Params) => string;
}

/**
 * Content-unchanged snapshots of every row `where` selects, each with its own meta, in one statement.
 * The Track 2 retraction hooks (validity.ts) use it: the rows are found in SQL, inside the batch of
 * the write that retracted their closer, so no read runs first. Never skips a no-op.
 */
export function buildDerivedSnapshot(s: DerivedSnapshotInput): BuiltStatement {
  const p = new Params();
  const metaSql = s.meta(p);
  const list = selectList(p, `instr(e.content, char(0)) = 0`, { reason: s.reason, change: s.change, now: s.now, metaSql, writeMarker: s.writeMarker });
  return { sql: `${INSERT_COLUMNS}\n${list}\n ${s.where(p)}`, bindings: p.values() };
}

export function snapshotManyStatement(env: Env, s: SnapshotManyInput): D1PreparedStatement {
  const b = buildSnapshotMany({ ...s, writeMarker: memoryWriteMarker(env) });
  return env.DB.prepare(b.sql).bind(...b.bindings);
}

export interface GuardedSnapshotManyInput {
  writeMarker?: string | null;
  /**
   * Per-row identity check: matches only if the live row's own values still equal these.
   * `rowVersion` is the caller's COALESCE(updated_at, created_at) at read time — entries.updated_at
   * is NULL until first edit (updated-at-coalesced.test.ts), so a raw read would silently fail to
   * guard every never-edited row.
   */
  entries: { id: string; rowVersion: number; contentBytes: number }[];
  workspaceId: string;
  reason: VersionReason;
  change: ChangeContext;
  content: { kind: "unchanged" | "suffix" };
  meta?: Record<string, unknown>;
  now: number;
}

/**
 * Many-row snapshot with a per-row compare-and-set, one statement regardless of row count. The
 * guard is a cheap proxy for "still exactly the row the caller read" — workspace_id (shared: every
 * row here belongs to one caller-known workspace) plus each row's own (rowVersion, byte length of
 * content) — rather than the row's full content: rebinding a whole row's text into the guard is
 * what this exists to avoid (digest.ts's markSourcesRolledUp, measured at ~100 MB in one batch for
 * 50 sources of up to 1 MB each on real workerd D1). The tuple list is one JSON parameter, whatever
 * its length — same shape as buildSnapshotMany's id list, extended with the two extra guard columns
 * per row. Never skips a no-op, like buildSnapshotMany.
 */
export function buildGuardedSnapshotMany(s: GuardedSnapshotManyInput): BuiltStatement {
  const p = new Params();
  const list = selectList(p, `instr(e.content, char(0)) = 0`, s);
  const ws = p.add(s.workspaceId);
  const tuples = p.add(JSON.stringify(s.entries.map(e => [e.id, e.rowVersion, e.contentBytes])));
  return {
    sql: `${INSERT_COLUMNS}\n${list}\n WHERE e.workspace_id = ${ws}
       AND EXISTS (
         SELECT 1 FROM json_each(${tuples}) t
         WHERE json_extract(t.value, '$[0]') = e.id
           AND json_extract(t.value, '$[1]') = COALESCE(e.updated_at, e.created_at)
           AND json_extract(t.value, '$[2]') = length(CAST(e.content AS BLOB))
       )`,
    bindings: p.values(),
  };
}

export function guardedSnapshotManyStatement(env: Env, s: GuardedSnapshotManyInput): D1PreparedStatement {
  const b = buildGuardedSnapshotMany({ ...s, writeMarker: memoryWriteMarker(env) });
  return env.DB.prepare(b.sql).bind(...b.bindings);
}

/** Bottom-up: keeps exactly the `keep` newest versions, never leaving a gap above the oldest kept. */
export function buildPrune(entryId: string, keep: number): BuiltStatement {
  const p = new Params();
  const id = p.add(entryId);
  return {
    // scope-exempt: by-id: pruneStatement's caller prunes only the entry it just snapshotted, already authorized
    // write-fence: parent-capability=entry_versions（同batchのsnapshot・認可済み記憶をtriggerで検証）
    sql: `DELETE FROM entry_versions WHERE entry_id = ${id}
     AND seq <= (SELECT MAX(v.seq) FROM entry_versions v WHERE v.entry_id = ${id}) - ${p.add(keep)}`,
    bindings: p.values(),
  };
}

export function pruneStatement(env: Env, entryId: string, keep: number): D1PreparedStatement {
  const b = buildPrune(entryId, keep);
  return env.DB.prepare(b.sql).bind(...b.bindings);
}

export function buildPruneMany(entryIds: string[], keep: number): BuiltStatement {
  const p = new Params();
  return {
    // scope-exempt: by-id: pruneManyStatement's caller prunes only the ids it just snapshotted together, already authorized
    // write-fence: parent-capability=entry_versions（同batchのsnapshot・認可済み記憶をtriggerで検証）
    sql: `DELETE FROM entry_versions WHERE entry_id IN (SELECT value FROM json_each(${p.add(JSON.stringify(entryIds))}))
     AND seq <= (SELECT MAX(v.seq) FROM entry_versions v WHERE v.entry_id = entry_versions.entry_id) - ${p.add(keep)}`,
    bindings: p.values(),
  };
}

export function pruneManyStatement(env: Env, entryIds: string[], keep: number): D1PreparedStatement {
  const b = buildPruneMany(entryIds, keep);
  return env.DB.prepare(b.sql).bind(...b.bindings);
}

/** Like prune, but only mirror versions below the oldest non-mirror version, so a user's version is never skipped over. */
export function buildMirrorPrune(entryId: string, keep: number): BuiltStatement {
  const p = new Params();
  const id = p.add(entryId);
  return {
    // scope-exempt: by-id: mirrorPruneStatement's caller prunes only the entry it just snapshotted, already authorized
    // write-fence: parent-capability=entry_versions（同batchのsnapshot・認可済み記憶をtriggerで検証）
    sql: `DELETE FROM entry_versions WHERE entry_id = ${id}
     AND seq <= (SELECT MAX(v.seq) FROM entry_versions v WHERE v.entry_id = ${id}) - ${p.add(keep)}
     AND seq < COALESCE((SELECT MIN(v.seq) FROM entry_versions v WHERE v.entry_id = ${id} AND v.reason <> 'mirror'), 9e18)`,
    bindings: p.values(),
  };
}

export function mirrorPruneStatement(env: Env, entryId: string, keep: number): D1PreparedStatement {
  const b = buildMirrorPrune(entryId, keep);
  return env.DB.prepare(b.sql).bind(...b.bindings);
}

/**
 * A compare-and-set predicate over `entries`, built once and shared VERBATIM between a snapshot's
 * guard and its UPDATE's WHERE clause (spec P3: "A snapshot of a CAS-guarded write carries the same
 * guard"). Passing the same `columns` object to two separate `Params` instances (the snapshot's own,
 * and the UPDATE's) cannot drift the two apart the way two hand-written fragments did (ADV-1: a guard
 * that checked fewer columns than its UPDATE let a miss the UPDATE correctly caught still commit a
 * version, under the caller's actor, for a change that never landed).
 *
 * `null` compares with `IS` (so an unset when_* column matches); everything else with `=`. The UPDATE
 * side aliases its table (`UPDATE entries AS e SET … WHERE …`, valid SQLite/D1) so the identical
 * `e.<col>` text works unmodified in both places.
 */
export function buildCasGuard(p: Params, columns: Record<string, unknown>): string {
  return Object.entries(columns)
    .map(([col, val]) => `e.${col} ${val === null ? "IS" : "="} ${p.add(val)}`)
    .join(" AND ");
}

/**
 * UPDATE guard for a revert: true only if THIS request's snapshot row exists (seq = expected + 1 and
 * meta.nonce = nonce). A timestamp is not an identity: Workers' Date.now() only advances after I/O.
 */
export function ownSnapshotLandedSql(p: Params, entryId: string, expectedNewestSeq: number, nonce: string): string {
  // scope-exempt: by-id: entryId is the row the enclosing UPDATE's own WHERE id = ... already pins;
  // revertEntry authorizes it (canRevert) before this guard is ever built
  return `EXISTS (SELECT 1 FROM entry_versions ov WHERE ov.entry_id = ${p.add(entryId)} AND ov.seq = ${p.add(expectedNewestSeq + 1)} AND json_extract(ov.meta, '$.nonce') = ${p.add(nonce)})`;
}

/** Rows a batch statement changed. Unknown (a test double without meta) counts as one, so only a real zero reads as a lost write. */
export function changesOf(result: { meta?: { changes?: number; rows_written?: number } } | undefined): number {
  return result?.meta?.changes ?? result?.meta?.rows_written ?? 1;
}

/** When history began: the marker init writes, else a conservative MIN(created_at) (pruning can only raise it). */
export async function getVersionsSince(env: Env): Promise<number> {
  const stored = await env.OAUTH_KV.get(VERSIONS_SINCE_KV_KEY);
  const parsed = stored === null ? NaN : Number(stored);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  // scope-exempt: system job: a deployment-wide bootstrap of the versions:since marker, one cursor
  // shared by every workspace, not driven by any caller's identity — recovery only, run once
  const row = await env.DB.prepare(`SELECT MIN(created_at) AS first FROM entry_versions`).first<{ first: number | null }>();
  const since = row?.first ?? Date.now();
  try {
    await env.OAUTH_KV.put(VERSIONS_SINCE_KV_KEY, String(since));
  } catch (e) {
    console.error("versions:since write failed (non-fatal):", e);
  }
  return since;
}

// ── Reconstruction ──

export interface VersionRow {
  seq: number;
  workspace_id: string;
  content: string | null;
  prior_length: number | null;
  /** UTF-16 boundary into the base, when the writer had it to give (ADV-10); null falls back to a scan. */
  prior_length_utf16: number | null;
  tags: string;
  state: string;
  actor_id: string;
  channel: string;
  reason: VersionReason;
  meta: string;
  valid_from: number | null;
  created_at: number;
}

export class VersionChainError extends Error {}

export interface VersionChain {
  rows: VersionRow[];
  truncatedAt: "none" | "unreadable" | "gap";
  /** The text this entry had before the change version `seq` recorded. Built on demand. */
  text(seq: number): string;
}

const SURROGATES = /[\uD800-\uDFFF]/;

/**
 * Rows arrive newest first. A delta row's text is the first `prior_length` code points of the next
 * newer state, so a run of consecutive delta rows shares one base (the nearest newer full copy, or
 * the live text) and their lengths never grow. Boundaries for a whole run are found in one pass.
 */
export function buildChain(
  current: string,
  rowsNewestFirst: VersionRow[],
  canRead: (workspaceId: string) => boolean,
  opts: { onScan?: (units: number) => void } = {},
): VersionChain {
  const rows: VersionRow[] = [];
  let truncatedAt: VersionChain["truncatedAt"] = "none";
  for (const r of rowsNewestFirst) {
    if (!canRead(r.workspace_id)) { truncatedAt = "unreadable"; break; }
    if (rows.length && r.seq !== rows[rows.length - 1].seq - 1) { truncatedAt = "gap"; break; }
    rows.push(r);
  }
  const indexOf = new Map(rows.map((r, i) => [r.seq, i]));
  // seq -> UTF-16 end index in its base, filled one run at a time.
  const ends = new Map<number, { base: string; end: number }>();

  const resolveRun = (from: number): void => {
    // `from` is the newest delta row of a run; its base is the row above it, or the live text.
    let to = from;
    while (to + 1 < rows.length && rows[to + 1].content === null) to++;
    const base = from === 0 ? current : rows[from - 1].content!;
    // The base of a run whose newest member is not at index 0 is the full copy just above it.
    let previous = Infinity;
    const wanted: number[] = [];
    // A run this size only ever happens once per shared base, so it is cheap regardless; the case
    // this exists for is a chain that ALTERNATES full copies and deltas, where every run has exactly
    // one member and each pays its own base's full length — 20 versions, 20 walks of ~1 MB, not one
    // (ADV-10). A row whose writer had its own prior content in hand (store.ts) already stamped the
    // UTF-16 boundary directly (prior_length_utf16): trust it and skip scanning for that row entirely.
    // A version with no such hint (an older write, or one of the writers that never reads content into
    // JS) still gets it the slow way below.
    for (let i = from; i <= to; i++) {
      const length = rows[i].prior_length!;
      if (length > previous) throw new VersionChainError(`version ${rows[i].seq} claims ${length} characters of a ${previous}-character state`);
      previous = length;
      const stored = rows[i].prior_length_utf16;
      if (stored == null) { wanted.push(length); continue; }
      // Cheap, O(1) sanity check before trusting a stamped boundary (R2-1): every codepoint is 1 or
      // 2 UTF-16 units, so the UTF-16 length can never be fewer than the codepoint count nor more
      // than twice it. A stamp outside that range is corrupt or describes a different string
      // entirely — reject it rather than build a chain on top of it, no scan required to catch it.
      if (stored < length || stored > length * 2) throw new VersionChainError(`version ${rows[i].seq} claims a ${stored}-unit boundary inconsistent with its own ${length}-character length`);
      if (stored > base.length) throw new VersionChainError(`version ${rows[i].seq} claims a boundary past its ${base.length}-unit base`);
      ends.set(rows[i].seq, { base, end: stored });
    }
    if (wanted.length) {
      const resolved = new Map<number, number>();
      if (!SURROGATES.test(base)) {
        for (const length of wanted) {
          if (length > base.length) throw new VersionChainError(`version claims ${length} characters of a ${base.length}-character base`);
          resolved.set(length, length);
        }
      } else {
        // Lengths are non-increasing, so walk once, ascending.
        let unit = 0;
        let count = 0;
        for (const length of [...new Set(wanted)].sort((a, b) => a - b)) {
          while (count < length) {
            if (unit >= base.length) throw new VersionChainError(`version claims ${length} characters of a shorter base`);
            const c = base.charCodeAt(unit);
            unit += c >= 0xd800 && c <= 0xdbff && unit + 1 < base.length && (base.charCodeAt(unit + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
            count++;
          }
          resolved.set(length, unit);
        }
        opts.onScan?.(unit);
      }
      for (let i = from; i <= to; i++) {
        if (rows[i].prior_length_utf16 == null) ends.set(rows[i].seq, { base, end: resolved.get(rows[i].prior_length!)! });
      }
    }
  };

  return {
    rows,
    truncatedAt,
    text(seq: number): string {
      const i = indexOf.get(seq);
      if (i === undefined) throw new VersionChainError(`no version ${seq} in this chain`);
      const row = rows[i];
      if (row.content !== null) return row.content;
      if (!ends.has(seq)) {
        let start = i;
        while (start > 0 && rows[start - 1].content === null) start--;
        resolveRun(start);
      }
      const hit = ends.get(seq)!;
      return hit.base.slice(0, hit.end);
    },
  };
}

// ── Held / released text, shared by every reader of a version's reconstructed content ──

function parseTagsSafe(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function parseMetaSafe(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** A `reason: "status"` version whose meta records a hold (5.4): the same structural check
 * undo.ts's own `isHoldVersion` makes (duplicated there -- its revert semantics are a different
 * concern from the display-redaction rule below, and lane ownership keeps the two independent). */
export function isHoldVersion(v: Pick<VersionRow, "reason" | "meta">): boolean {
  if (v.reason !== "status") return false;
  return !!parseMetaSafe(v.meta).hold;
}

/**
 * True when version `v`'s own reconstructed text must be treated as held: its own tags are held,
 * or it is itself the hold transition (isHoldVersion) -- a hold-transition version's OWN tags are
 * the pre-hold (unheld) state by definition, so isHeld(tags) alone misses exactly the version
 * whose reconstructed content IS the sensitive text (T-0102 cross-vendor review MAJOR).
 */
export function textHeldAt(v: Pick<VersionRow, "reason" | "meta" | "tags">): boolean {
  return isHeld(parseTagsSafe(v.tags)) || isHoldVersion(v);
}

/**
 * True when `text` is, at some point in `chain`, exactly the content a release (5.6) vouched for
 * on this row -- a human reviewed and approved it, even if the row was edited again since (cloud
 * re-review, T-0102, on top of 0b970baa's finding 1 fix). A hold or release never changes content
 * (only tags), so a release version's own reconstructed text is exactly what was live at that
 * moment; matching it against `text` needs no seq/ordering bookkeeping.
 *
 * Shared by every surface that redacts a version's text from textHeldAt above -- as-of.ts's
 * resolveAtT, history-view.ts's buildEntryHistoryFromReads (the history list) and
 * readEntryVersionFromRow (get(version)) -- so the same historical text can never read as held
 * from one surface and approved from another (cloud re-review MAJOR: "make history-view,
 * get(version) and as-of use one rule").
 */
export function wasReleasedContent(chain: Pick<VersionChain, "rows" | "text">, text: string): boolean {
  return chain.rows.some(v => {
    if (v.reason !== "status") return false;
    const meta = parseMetaSafe(v.meta);
    return meta.release != null && chain.text(v.seq) === text;
  });
}

// ── Who may read and revert ──

/** Whether `reader` may see a version or event stamped with workspace `ws`. `ownerUserId` is needed only for "". */
export function workspaceReadable(reader: Identity | undefined, ws: string, ownerUserId?: string): boolean {
  if (!reader) return true;
  // readableWorkspaces gives "" to every admin, which is right for legacy rows and wrong for history.
  if (ws === "") return ownerUserId !== undefined && reader.userId === ownerUserId;
  return readableWorkspaces(reader).includes(ws);
}

const HISTORY_COLUMNS = `seq, workspace_id, content, prior_length, prior_length_utf16, tags, state, actor_id, channel, reason, meta, valid_from, created_at`;

/** The one read of an entry's versions. Readability is enforced per row by buildChain (D-SH). */
export async function loadHistory(
  env: Env, reader: Identity | undefined, row: { id: string; content: string }, limit: number,
): Promise<VersionChain> {
  const capped = Math.min(500, Math.max(1, Math.floor(limit)));
  const { results } = await env.DB.prepare(
    // scope-checked: readability enforced per row by buildChain (D-SH). Callers are revertEntry
    // (memory/undo.ts), reached from POST /undo and the MCP undo tool (T-0089.6.6), and
    // buildEntryHistory (memory/history-view.ts, T-0101.1.1) — all resolve identity before calling
    // it, so `reader` here is never undefined on a live request.
    `SELECT ${HISTORY_COLUMNS} FROM entry_versions WHERE entry_id = ? ORDER BY seq DESC LIMIT ?`,
  ).bind(row.id, capped).all<VersionRow>();
  const rows = results ?? [];
  const ownerUserId = reader && rows.some(r => r.workspace_id === "") ? (await ensureTenantBootstrap(env)).ownerUserId : undefined;
  return buildChain(row.content, rows, ws => workspaceReadable(reader, ws, ownerUserId));
}

export type RevertVerdict = { ok: true } | { ok: false; code: "forbidden" | "stale" | "unreadable" };

/**
 * May `reader` revert the change version `target` recorded? Rule (1) is "R can read E and V is
 * visible to R (V is in loadHistory(R, E))" — checking only `target`'s own workspace is not enough
 * (ADV-6): a company-era version below a personal-era edit is unreadable to a non-author even though
 * its OWN workspace is one they could otherwise read, because `loadHistory`'s walk stops at the
 * intervening unreadable row and never reaches it. `visibleSeqs` is the seq set `loadHistory` (or
 * `revertEntry`'s own chain) actually returned, so this cannot be satisfied by a target the caller
 * never confirmed was in that walk.
 *
 * The author or an admin may revert any visible version (the normal content-edit rule); otherwise
 * the actor of the NEWEST version may revert exactly that one. The caller still guards the write
 * with the newest seq (M4), since this is checked on a read.
 */
export function canRevert(
  reader: Identity | undefined,
  entry: { workspace_id: string; actor_id: string },
  target: Pick<VersionRow, "seq" | "workspace_id" | "actor_id">,
  newestSeq: number,
  visibleSeqs: Iterable<number>,
  opts: { ownerUserId?: string } = {},
): RevertVerdict {
  if (!new Set(visibleSeqs).has(target.seq)) return { ok: false, code: "unreadable" };
  if (!workspaceReadable(reader, target.workspace_id, opts.ownerUserId)) return { ok: false, code: "unreadable" };
  if (!assertCanEditContent(reader, entry)) return { ok: true };
  if (!reader || target.actor_id === "" || target.actor_id !== reader.userId) return { ok: false, code: "forbidden" };
  return target.seq === newestSeq ? { ok: true } : { ok: false, code: "stale" };
}
