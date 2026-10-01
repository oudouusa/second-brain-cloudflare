import { assertMemoryWritesAllowed, memoryWriteMarker } from "../migration/write-lock";
import type { Env } from "../env";
import type { ChangeContext } from "../lib/audit";
import {
  TRASH_ROW_BUDGET_BYTES, VERSION_DELETE_CHUNK, DISCONNECT_PURGE_CHUNK, MIRRORED_SOURCES,
} from "../constants";
import type { Identity } from "../lib/identity";
import { scopeWhere } from "../lib/scope";
import { assertCanMutateEntry } from "../lib/entry-access";
import { writeAuditEvents, type AuditEventInput } from "../lib/audit";
import { deleteEntryVectors } from "../vectorize/batch";
import { edgeEndpointsReadableSql } from "../graph/edges";
import { EDGE_ROW_COLUMNS, edgesJsonSql, restoreColumnsSql, rowJsonSql } from "./entry-columns";
import { upsertEntryVectors, deleteStaleVectors, discardUpload } from "../capture/store";
import { isVectorizeUnavailable } from "../vectorize/health";
import { resolveConfig, type Config } from "../config";
import { getStatus } from "./status";
import { isHeld } from "../quarantine/tags";
import { normalizeTagList } from "../tags/system";
import { Params } from "./params";
import { chunkText } from "../text/chunk";
import { auditValidity, outcomeOf, retractionHook, unretractionHook, type ValidityOutcome } from "./validity";
import { standingTouched } from "../standing/cache";

export type TrashReason = "forget" | "mirror" | "disconnect";

/** Exact bytes a trash insert would write for one entry, read in the same statement as its vector ids. */
export interface TrashSizes {
  content_bytes: number;
  row_json_bytes: number;
  edges_json_bytes: number;
  // Round 2 adversary: vector_ids is now itself a stored trash column (not just read for
  // cleanup), and a heavily-chunked row's ids run to tens of KB — real width, not slack.
  vector_ids_bytes: number;
}

export interface TrashCandidate extends TrashSizes {
  id: string;
  workspace_id: string;
  actor_id: string;
  vector_ids: string;
  /** Standing invalidation (spec 15 2.6) needs to know, before the row leaves entries, whether it was standing:active. */
  tags: string;
}

/**
 * Which trash form an entry gets, chosen from the sizes SQL computed (never from a D1
 * error): 1 = full row, 2 = without edges, 3 = too large for the trash, hard delete.
 * The 512 bytes cover the fixed columns; the budget leaves headroom under the 2 MB row limit.
 */
export function chooseTrashTier(sizes: TrashSizes, budget = TRASH_ROW_BUDGET_BYTES): 1 | 2 | 3 {
  const base = sizes.content_bytes + sizes.row_json_bytes + sizes.vector_ids_bytes + 512;
  if (base + sizes.edges_json_bytes <= budget) return 1;
  if (base <= budget) return 2;
  return 3;
}

export interface TrashPlan { tier1: string[]; tier2: string[]; tier3: string[] }

export function planTrash(rows: TrashCandidate[], budget = TRASH_ROW_BUDGET_BYTES): TrashPlan {
  const plan: TrashPlan = { tier1: [], tier2: [], tier3: [] };
  for (const r of rows) {
    const tier = chooseTrashTier(r, budget);
    plan[tier === 1 ? "tier1" : tier === 2 ? "tier2" : "tier3"].push(r.id);
  }
  return plan;
}

/**
 * The size read that replaces forget's `SELECT vector_ids`. `ids` is one JSON array, so the
 * statement binds one parameter however many entries it covers. Callers that need a scope
 * (the disconnect purge) build their own read with the same select list.
 */
export function trashSizeSelect(alias = "e"): string {
  return `${alias}.id, ${alias}.workspace_id, ${alias}.actor_id, ${alias}.vector_ids, ${alias}.tags,
       length(CAST(${alias}.content AS BLOB)) AS content_bytes,
       length(CAST(${rowJsonSql(alias)} AS BLOB)) AS row_json_bytes,
       COALESCE(length(CAST(${edgesJsonSql(alias)} AS BLOB)), 2) AS edges_json_bytes,
       length(CAST(${alias}.vector_ids AS BLOB)) AS vector_ids_bytes`;
}

export async function readTrashCandidates(env: Env, ids: string[]): Promise<TrashCandidate[]> {
  if (!ids.length) return [];
  const p = new Params();
  try {
    const { results } = await env.DB.prepare(
      // scope-exempt: by-id: routes gate with getReadableEntry before calling
      `SELECT ${trashSizeSelect("e")} FROM entries e WHERE e.id IN (SELECT value FROM json_each(${p.add(JSON.stringify(ids))}))`,
    ).bind(...p.values()).all<TrashCandidate>();
    return results ?? [];
  } catch (e) {
    if (!isTooBig(e)) throw e;
    return readTrashCandidatesIsolating(env, ids);
  }
}

/** D1's shape for SQLite's own per-value size ceiling, hit by edgesJsonSql's aggregate on a row with too many edges. */
function isTooBig(e: unknown): boolean {
  return /too big/i.test(String((e as { message?: string })?.message ?? e));
}

/**
 * Larger than any TRASH_ROW_BUDGET_BYTES this codebase will ever pass chooseTrashTier, so a row
 * carrying it in content_bytes fails both the tier 1 and the tier 2 check and always lands in
 * tier 3, whatever budget the caller uses. content_bytes specifically (not a fourth field) so
 * this reuses chooseTrashTier's own arithmetic instead of adding a rule that duplicates it.
 */
const SIZE_UNMEASURABLE = Number.POSITIVE_INFINITY;

/**
 * One id in a batch has more edges than edgesJsonSql's json_group_array aggregate can even be
 * measured at all: past roughly 10,000+ edges it exceeds real D1's per-value size ceiling and
 * the batched read above throws SQLITE_TOOBIG before chooseTrashTier ever runs. Retried one id
 * at a time so the OTHER ids in the same batch (the common case: everything else has a normal
 * edge count) are not punished for the one that does not: only the id(s) that themselves also
 * throw fall back to readTrashCandidateForcedTier3. `scope`, when given, is applied to both the
 * per-id retry and the fallback so a row outside the caller's scope is still silently excluded,
 * exactly as the batched read that just failed would have excluded it.
 */
async function readTrashCandidatesIsolating(
  env: Env, ids: string[], scope?: { clause: string; bindings: unknown[] },
): Promise<TrashCandidate[]> {
  const out: TrashCandidate[] = [];
  for (const id of ids) {
    const where = scope ? `e.id = ? AND ${scope.clause}` : `e.id = ?`;
    const bindings = [id, ...(scope?.bindings ?? [])];
    try {
      // scope-checked: by-id (readTrashCandidates, unscoped, same as its own batched read above)
      // or scoped (trashMirroredEntries): the caller's clause IS applied into `where` above when
      // given; the lexer cannot see into this JS-assembled fragment.
      const row = await env.DB.prepare(`SELECT ${trashSizeSelect("e")} FROM entries e WHERE ${where}`)
        .bind(...bindings).first<TrashCandidate>();
      if (row) out.push(row);
    } catch (e) {
      if (!isTooBig(e)) throw e;
      const forced = await readTrashCandidateForcedTier3(env, id, scope);
      if (forced) out.push(forced);
    }
  }
  return out;
}

/**
 * The safe fallback once an id's own edge aggregate has proven too big to measure: this id is
 * always tier 3 (hard delete, no trash-row snapshot), never re-attempting the aggregate and
 * never guessing whether tier 2 (trash without edges) might otherwise have fit. Only the
 * identity columns forget/the disconnect purge actually need (workspace_id for the authorization
 * check, vector_ids for the Vectorize cleanup) are read; the size columns are the sentinel that
 * drives chooseTrashTier to tier 3 unconditionally, not real measurements.
 */
async function readTrashCandidateForcedTier3(
  env: Env, id: string, scope?: { clause: string; bindings: unknown[] },
): Promise<TrashCandidate | null> {
  const where = scope ? `e.id = ? AND ${scope.clause}` : `e.id = ?`;
  const bindings = [id, ...(scope?.bindings ?? [])];
  const row = await env.DB.prepare(
    // scope-checked: by-id (unscoped) or scoped to mirror the batch read this id's caller already
    // applied: the caller's clause IS applied into `where` above when given; the lexer cannot
    // see into this JS-assembled fragment. No content, row_json or edges_json read here at all;
    // this id is going to tier 3 regardless.
    `SELECT e.id, e.workspace_id, e.actor_id, e.vector_ids, e.tags FROM entries e WHERE ${where}`,
  ).bind(...bindings).first<Pick<TrashCandidate, "id" | "workspace_id" | "actor_id" | "vector_ids" | "tags">>();
  if (!row) return null;
  return { ...row, content_bytes: SIZE_UNMEASURABLE, row_json_bytes: 0, edges_json_bytes: 0, vector_ids_bytes: 0 };
}

const TRASH_COLUMNS = "id, workspace_id, actor_id, content, row_json, edges_json, vector_ids, deleted_at, deleted_by, channel, reason, nonce";

/**
 * The statements that move entries to the trash, in one batch: the trash inserts (they read
 * the rows and their edges, so they run first), the tier-3 version delete, then the edge and
 * entry deletes. The LAST statement is the entries delete: its `changes` is how many rows this
 * batch actually removed, so a racing deleter is reported as not found.
 */
export function trashManyStatements(
  env: Env,
  plan: TrashPlan,
  meta: {
    reason: TrashReason; change: ChangeContext; now: number;
    /** Retraction hook statements (validity.ts, D-RET): run after the trash inserts, while the rows and their edges still exist. */
    hook?: D1PreparedStatement[];
    /**
     * Codex review, T-0102 F2 (NIT), then MAJOR (director follow-up after a cloud re-review): the
     * exact (id, workspace) pairs the caller's own scoped read authorized this batch's rows
     * under -- the same pairs `retractionHook` (validity.ts) already builds its own `authorized()`
     * guard from, so every statement this batch runs, `meta.hook` included, is keyed on the
     * identical guard rather than merely similar ones. A blanket "workspace is somewhere in this
     * set" check (the F2 fix's own first version) does not: two rows read from two different
     * allowed workspaces, then one moved into the other's between the read and this commit, still
     * pass a set-membership check while `authorized()`'s own exact pair for it would not, so the
     * hook silently skipped a row every other statement in the batch still processed -- the same
     * class of half-applied batch D1 (undo.ts) closed. Optional and additive: a caller that omits
     * it keeps the pre-existing by-id-only behavior.
     */
    workspacePairs?: readonly { id: string; workspaceId: string }[];
    /** 単一lifecycle操作が同batchで作った台帳を送信するためのID。 */
    cleanupOperations?: readonly { entryId: string; opId: string }[];
  },
): D1PreparedStatement[] {
  const all = [...plan.tier1, ...plan.tier2, ...plan.tier3];
  if (!all.length) return [];
  const stmts: D1PreparedStatement[] = [];
  const pairsJson = meta.workspacePairs ? JSON.stringify(meta.workspacePairs.map(x => [x.id, x.workspaceId])) : undefined;
  /** For a statement directly on `entries` (aliased `alias`): its own row must be one of the
   * authorized pairs. */
  const entriesGuardSql = (p: Params, alias: string) =>
    pairsJson
      ? ` AND EXISTS (SELECT 1 FROM json_each(${p.add(pairsJson)}) k WHERE json_extract(k.value, '$[0]') = ${alias}.id AND json_extract(k.value, '$[1]') = ${alias}.workspace_id)`
      : "";
  /** For a statement on another table that references an entry via `idCols` (`entry_versions`,
   * `edges`): the LIVE `entries` row for whichever id matches must still be at the pair's
   * workspace -- not this table's own workspace_id column, which is a point-in-time copy
   * (`entry_versions`: the workspace at change time; `edges`: denormalized at write time) that a
   * race moving the live entry does not update, so checking it would not detect the same race the
   * entries DELETE itself refuses on. Runs while `entries` still holds the row (this statement
   * always lands before the entries DELETE in the batch). */
  const referencedEntryGuardSql = (p: Params, idCols: readonly string[]) =>
    // scope-checked: the EXISTS clause below IS the scope guard, assembled here in JS from
    // meta.workspacePairs -- every call site interpolates it (or the "" no-op when there are no
    // pairs to check).
    pairsJson
      ? ` AND EXISTS (SELECT 1 FROM entries en, json_each(${p.add(pairsJson)}) k
            WHERE (${idCols.map(c => `en.id = ${c}`).join(" OR ")}) AND json_extract(k.value, '$[0]') = en.id AND json_extract(k.value, '$[1]') = en.workspace_id)`
      : "";
  // nonce (last column, TRASH_COLUMNS): a fresh per-row identity (adv-final MAJOR 1), the same
  // randomblob-per-row pattern entry_events uses for its own id below — evaluated once per row
  // of the INSERT...SELECT, never the same value across a multi-row tier1/tier2 batch.
  const insert = (ids: string[], withEdges: boolean) => {
    const p = new Params();
    const idList = p.add(JSON.stringify(ids));
    const nowIdx = p.add(meta.now);
    const actorIdx = p.add(meta.change.actorId);
    const channelIdx = p.add(meta.change.channel);
    const reasonIdx = p.add(meta.reason);
    // A plain INSERT (T-0089.1.1): ids are unique across entries and entries_trash, so an existing
    // trash row under this id is a PRIMARY KEY error that fails the whole batch closed, never a replace.
    stmts.push(env.DB.prepare(
      // scope-exempt: by-id: callers authorize the entries before building the batch.
      // vector_ids is the live row's own value at deletion time (round 2 adversary): a short
      // append's chunk (id-update-<ts>, store.ts) is not a function of content, so it cannot be
      // rederived later — Delete forever needs the real ids stored, not just guessed at.
      `INSERT INTO entries_trash (${TRASH_COLUMNS}, write_marker)
       SELECT e.id, e.workspace_id, e.actor_id, e.content, ${rowJsonSql("e")}, ${withEdges ? edgesJsonSql("e") : "'[]'"}, e.vector_ids,
              ${nowIdx}, ${actorIdx}, ${channelIdx}, ${reasonIdx}, lower(hex(randomblob(16))), ${p.add(memoryWriteMarker(env))}
         FROM entries e WHERE e.id IN (SELECT value FROM json_each(${idList}))${entriesGuardSql(p, "e")}`,
    ).bind(...p.values()));
  };
  if (plan.tier1.length) insert(plan.tier1, true);
  if (plan.tier2.length) insert(plan.tier2, false);
  stmts.push(...(meta.hook ?? []));
  {
    const p = new Params();
    const ids = p.add(JSON.stringify(all));
    // versioning: exempt: 同batchでtrashへ移す行の削除許可markerのみ。
    stmts.push(env.DB.prepare(`UPDATE entries SET write_marker = ${p.add(memoryWriteMarker(env, "delete"))}
      WHERE id IN (SELECT value FROM json_each(${ids}))${entriesGuardSql(p, "entries")}`).bind(...p.values()));
  }

  const entryDelete = (() => {
    const p = new Params();
    const idIdx = p.add(JSON.stringify(all));
    return env.DB.prepare(
      // validity: retraction-hooked (forget and the disconnect purge pass meta.hook, D-RET)
      // versioning: trash
      // scope-exempt: by-id delete: callers authorize the entries before building the batch
      `DELETE FROM entries WHERE id IN (SELECT value FROM json_each(${idIdx}))${entriesGuardSql(p, "entries")}`,
    ).bind(...p.values());
  })();

  if (plan.tier3.length) {
    const p = new Params();
    // Codex review, T-0102, director follow-up MAJOR: keyed on the same workspace guard as the
    // trash INSERT and the entries DELETE below -- unguarded, this ran unconditionally even when
    // a share/unshare race made the INSERT or the entries DELETE affect zero rows, wiping a live
    // row's version history out from under it while the row itself stayed live (the batch
    // half-applied, same class as D1).
    stmts.push(env.DB.prepare(
      // scope-exempt: by-id: versions of entries the caller authorized (plus referencedEntryGuardSql's
      // own scope-checked EXISTS below); an oversized entry leaves no history behind. Guarded on the
      // id not already being trashed: a losing tier-3 forget (its stale size read predates a shrink
      // that let a racing forget trash the row normally) must not wipe the winner's trashed history.
    // write-fence: parent-capability=entries_trash（同batchのsnapshot・認可済み記憶をtriggerで検証）
      `DELETE FROM entry_versions WHERE entry_id IN (SELECT value FROM json_each(${p.add(JSON.stringify(plan.tier3))}))
         AND NOT EXISTS (SELECT 1 FROM entries_trash t WHERE t.id = entry_versions.entry_id)${referencedEntryGuardSql(p, ["entry_versions.entry_id"])}`,
    ).bind(...p.values()));
    // A life-end marker, in the SAME batch as the entries DELETE below and under the SAME guard
    // (plus NOT EXISTS on entries_trash) -- every event reader relies on one of these existing
    // before an id is safe to reuse, so it must land only when this DELETE actually removed the
    // row. The route layer's own richer "deleted" event (routes/entries.ts, mcp/server.ts) skips
    // this case to avoid writing two.
    {
      const tp = new Params();
      const tierIds = tp.add(JSON.stringify(plan.tier3));
      const tierNow = tp.add(meta.now);
      const tierActor = tp.add(meta.change.actorId);
      const tierChannel = tp.add(meta.change.channel);
      const tierReason = tp.add(meta.reason);
      stmts.push(env.DB.prepare(
        // scope-exempt: by-id: one life-end marker per tier-3 id this batch's own entries DELETE removes
        `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at)
           SELECT lower(hex(randomblob(16))), e.id, ${tierActor}, 'deleted',
                  json_object('reason', ${tierReason}, 'trash', json('false'), 'channel', ${tierChannel}), ${tierNow}
             FROM entries e
             WHERE e.id IN (SELECT value FROM json_each(${tierIds}))${entriesGuardSql(tp, "e")}
               AND NOT EXISTS (SELECT 1 FROM entries_trash t WHERE t.id = e.id)`,
      ).bind(...tp.values()));
    }
  }
  {
    const p = new Params();
    const ids = p.add(JSON.stringify(all));
    const opIdSql = meta.cleanupOperations
      ? `(SELECT json_extract(k.value, '$[1]') FROM json_each(${p.add(JSON.stringify(meta.cleanupOperations.map(o => [o.entryId, o.opId])))}) k WHERE json_extract(k.value, '$[0]') = e.id)`
      : "lower(hex(randomblob(16)))";
    // scope-checked: 直前のworkspacePairsから作るentriesGuardSqlで削除対象と同じ行だけ記録する。
    // validity: any: 同batchで削除する行の索引を台帳へ記録する。
    stmts.push(env.DB.prepare(`INSERT INTO vector_cleanup_ops
      (op_id, entry_id, vector_ids, created_at, ready, expires_at, write_marker)
      SELECT ${opIdSql}, e.id, e.vector_ids, ${p.add(meta.now)}, 1, ${p.add(meta.now)}, ${p.add(memoryWriteMarker(env))}
      FROM entries e WHERE e.id IN (SELECT value FROM json_each(${ids}))${entriesGuardSql(p, "e")}`).bind(...p.values()));
  }
  const ids = JSON.stringify(all);
  {
    const p = new Params();
    const list = p.add(ids);
    const guard = referencedEntryGuardSql(p, ["insight_candidates.a_id", "insight_candidates.b_id"]);
    const selected = `(a_id IN (SELECT value FROM json_each(${list})) OR b_id IN (SELECT value FROM json_each(${list})))${guard}`;
    stmts.push(env.DB.prepare(`UPDATE insight_candidates SET write_marker = ${p.add(memoryWriteMarker(env, "delete"))} WHERE ${selected}`).bind(...p.values()));
    const d = new Params();
    const dl = d.add(ids);
    stmts.push(env.DB.prepare(`DELETE FROM insight_candidates WHERE (a_id IN (SELECT value FROM json_each(${dl})) OR b_id IN (SELECT value FROM json_each(${dl})))${referencedEntryGuardSql(d, ["insight_candidates.a_id", "insight_candidates.b_id"])}`).bind(...d.values()));
  }
  {
    const p = new Params();
    const list = p.add(ids);
    stmts.push(env.DB.prepare(`DELETE FROM append_receipts WHERE entry_id IN (SELECT value FROM json_each(${list}))${referencedEntryGuardSql(p, ["append_receipts.entry_id"])}`).bind(...p.values()));
  }
  {
    const p = new Params();
    const list = p.add(ids);
    stmts.push(env.DB.prepare(`UPDATE edges SET write_marker = ${p.add(memoryWriteMarker(env, "delete"))}
      WHERE (source_id IN (SELECT value FROM json_each(${list})) OR target_id IN (SELECT value FROM json_each(${list})))${referencedEntryGuardSql(p, ["edges.source_id", "edges.target_id"])}`).bind(...p.values()));
  }

  {
    const p = new Params();
    const list = p.add(ids);
    stmts.push(env.DB.prepare(
      // scope-exempt: by-id cascade: edge endpoints of the rows being trashed
      // entries削除と同じworkspace guardで、競合時に生きた行の辺を消さない。
      `DELETE FROM edges WHERE (source_id IN (SELECT value FROM json_each(${list})) OR target_id IN (SELECT value FROM json_each(${list})))${referencedEntryGuardSql(p, ["edges.source_id", "edges.target_id"])}`,
    ).bind(...p.values()));
  }
  stmts.push(entryDelete);
  return stmts;
}

/** Where a hook passed to trashManyStatements starts in its batch: after the one or two trash inserts. */
export function trashHookOffset(plan: TrashPlan): number {
  return (plan.tier1.length ? 1 : 0) + (plan.tier2.length ? 1 : 0);
}

/** Rows one batch changed, on D1 (`changes`) and the test doubles (`rows_written`). */
export function changedRows(res: { meta?: { changes?: number; rows_written?: number } } | undefined): number {
  return res?.meta?.changes ?? res?.meta?.rows_written ?? 0;
}

// ── Disconnect purge ─────────────────────────────────────────────────────────

/**
 * Trash mirrored entries for the disconnect purge, in chunks of DISCONNECT_PURGE_CHUNK: per chunk one
 * scoped read, one batch (trash, edges, entries) and one audit batch. Rows the caller cannot see or
 * mutate, and ids already gone, are counted skipped and never touched. Nothing here runs a purge batch.
 */
export async function trashMirroredEntries(
  env: Env,
  auth: Identity,
  entryIds: string[],
  opts: { provider: string; budget?: number },
  ctx?: ExecutionContext,
): Promise<{ purged: number; skipped: number }> {
  let purged = 0;
  let skipped = 0;
  let cfg: Readonly<Config> | undefined;
  for (let i = 0; i < entryIds.length; i += DISCONNECT_PURGE_CHUNK) {
    const chunk = [...new Set(entryIds.slice(i, i + DISCONNECT_PURGE_CHUNK))];
    const scope = scopeWhere(auth, undefined, "e.workspace_id");
    let results: TrashCandidate[];
    try {
      const res = await env.DB.prepare(
        // Bare placeholders throughout: the scope clause brings its own.
        `SELECT ${trashSizeSelect("e")} FROM entries e WHERE e.id IN (SELECT value FROM json_each(?)) AND ${scope.clause}`,
      ).bind(JSON.stringify(chunk), ...scope.bindings).all<TrashCandidate>();
      results = res.results ?? [];
    } catch (e) {
      if (!isTooBig(e)) throw e;
      // One id in this chunk has too many edges to measure at all; isolate it (see readTrashCandidates).
      results = await readTrashCandidatesIsolating(env, chunk, scope);
    }
    // Same guard /forget applies: a purge removes only what this caller could delete one at a time.
    const allowed = results.filter((r) => !assertCanMutateEntry(auth, r));
    skipped += entryIds.slice(i, i + DISCONNECT_PURGE_CHUNK).length - allowed.length;
    if (!allowed.length) continue;

    const plan = planTrash(allowed, opts.budget);
    const now = Date.now();
    const change = { actorId: auth.userId, channel: "rest" as const };
    // D-RET restore rule only (P10): what a purged mirror row had replaced is current again.
    cfg ??= await resolveConfig(env);
    const workspacePairs = allowed.map((r) => ({ id: r.id, workspaceId: r.workspace_id ?? "" }));
    const hook = retractionHook(env, workspacePairs, () => "1", change, cfg, now);
    const batchResults = await env.DB.batch(trashManyStatements(env, plan, { reason: "disconnect", change, now, hook: hook.statements, workspacePairs }));
    await auditValidity(env, change, hook.read(batchResults, trashHookOffset(plan)));
    // `changes` on a DELETE FROM entries is not a reliable count here: real D1 folds in every
    // FTS/entry_counts trigger row it fired alongside the entries row (a single delete reported
    // `changes: 5`), so which of `allowed` actually landed is read back rather than counted.
    const p = new Params();
    const { results: landed } = await env.DB.prepare(
      // scope-exempt: by-id: the trash rows this batch just wrote, to tell them from a racer's deletes
      `SELECT id FROM entries_trash WHERE reason = 'disconnect' AND deleted_at = ${p.add(now)} AND deleted_by = ${p.add(auth.userId)}
          AND id IN (SELECT value FROM json_each(${p.add(JSON.stringify(allowed.map((r) => r.id)))}))`,
    ).bind(...p.values()).all<{ id: string }>();
    const landedIds = new Set((landed ?? []).map((r) => r.id));
    // A hard-deleted (tier 3) row leaves no trash row to find, so it is taken as removed.
    const hard = new Set(plan.tier3);
    const done = allowed.filter((r) => landedIds.has(r.id) || hard.has(r.id));
    purged += done.length;
    skipped += allowed.length - done.length;

    const owned = done.map((r) => { try { return { entryId: r.id, vectorIds: JSON.parse(r.vector_ids ?? "[]") as string[] }; } catch { return { entryId: r.id, vectorIds: [] }; } });
    try {
      await deleteEntryVectors(env, owned);
    } catch (e) {
      console.error("Vectorize delete failed during disconnect purge (non-fatal):", e);
    }

    // Bulk: once per workspace this chunk touched, not per row (spec 15 2.6).
    if (ctx) {
      const touchedWorkspaces = [...new Set(
        done.filter(r => { try { return (JSON.parse(r.tags ?? "[]") as string[]).includes("standing:active"); } catch { return false; } })
          .map(r => r.workspace_id ?? ""),
      )];
      if (touchedWorkspaces.length) standingTouched(env, ctx, cfg ?? await resolveConfig(env), touchedWorkspaces);
    }

    const tier3 = new Set(plan.tier3);
    const tier2 = new Set(plan.tier2);
    // A tier-3 row already got its own reliable life-end marker in trashManyStatements' batch
    // above; skip it here so it is not written twice (same as routes/entries.ts, mcp/server.ts).
    const events: AuditEventInput[] = done.filter((r) => !tier3.has(r.id)).map((r) => ({
      entryId: r.id,
      actorId: auth.userId,
      event: "deleted",
      payload: {
        reason: "disconnect", provider: opts.provider,
        deletedVectors: (() => { try { return (JSON.parse(r.vector_ids ?? "[]") as string[]).length; } catch { return 0; } })(),
        trash: !tier3.has(r.id), channel: "rest",
        ...(tier2.has(r.id) ? { edgesDropped: true } : {}),
      },
    }));
    await writeAuditEvents(env, events);
  }
  return { purged, skipped };
}

// ── Purge ────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** The lowest TRASH_RETENTION_DAYS the config accepts (src/config.ts RULES). */
const MIN_RETENTION_DAYS = 1;
/** Rows written to purge one trash row: the purged event (6, since idx_entry_events_life_end --
 *  R23 -- also indexes it: it matches its own predicate) and the trash row (3), plus 2 per version. */
const PURGE_ROW_COST = 10; // 有効な削除markerを付与する1行書込みを含む。

/** A ceiling on the trash rows a purge reads, sized for rows holding VERSION_KEEP versions (the batch is still costed from the real counts). */
export function purgeLimit(versionKeep: number, ceiling: number, rowTarget: number): number {
  return Math.max(1, Math.min(ceiling, Math.floor(rowTarget / (PURGE_ROW_COST + 2 * versionKeep))));
}

export interface PurgeResult {
  /** Trash rows the candidate read returned. */
  read: number;
  purged: number;
  /** Versions trimmed from one oversized row instead of purging it. */
  trimmed: number;
  rowsWritten: number;
  /**
   * True when this batch stopped short of `read` because the row-written budget ran out, not
   * because there was nothing more expired to purge. The nightly loop (runNightlyCleanup) must
   * keep going on a budget cut — stopping here, as it once did, halved the spec's purge pacing.
   */
  budgetCut: boolean;
}

/**
 * One bounded purge: a candidate read with the REAL version count of each, then one batch over
 * the longest prefix whose cost fits `rowTarget` (and `rowsLeft`, the night's remaining budget).
 * A row trashed at a higher VERSION_KEEP is therefore costed at what it holds, not at what the
 * current keep implies. A first candidate that alone exceeds the target has its oldest versions
 * deleted instead (bottom-up, so the chain stays valid until the final batch).
 */
export async function purgeTrash(
  env: Env,
  cfg: Readonly<Config> | (() => Promise<Readonly<Config>>),
  opts: { ceiling: number; rowTarget: number; rowsLeft?: number; now?: number },
): Promise<PurgeResult> {
  const now = opts.now ?? Date.now();
  // The shortest retention the config allows: nothing younger can be expired, so a night with an
  // empty trash never needs the config (one KV read saved on every nightly run).
  const earliest = now - MIN_RETENTION_DAYS * DAY_MS;
  const budget = Math.min(opts.rowTarget, opts.rowsLeft ?? Infinity);
  const none: PurgeResult = { read: 0, purged: 0, trimmed: 0, rowsWritten: 0, budgetCut: false };
  if (budget < PURGE_ROW_COST) return none;

  const rp = new Params();
  const { results } = await env.DB.prepare(
    // scope-exempt: retention purge: global by design, bounded by the LIMIT and the row budget
    `SELECT t.id, t.deleted_at, t.vector_ids, (SELECT COUNT(*) FROM entry_versions v WHERE v.entry_id = t.id) AS n
       FROM entries_trash t WHERE t.deleted_at < ${rp.add(earliest)}
      ORDER BY t.deleted_at, t.id LIMIT ${rp.add(opts.ceiling)}`,
  ).bind(...rp.values()).all<{ id: string; deleted_at: number; vector_ids: string; n: number }>();
  let candidates = results ?? [];
  if (!candidates.length) return none;
  // Oldest first, so the expired rows are a prefix: cut at the configured retention.
  const days = (typeof cfg === "function" ? await cfg() : cfg).TRASH_RETENTION_DAYS;
  const cutoff = now - days * DAY_MS;
  candidates = candidates.filter((c) => c.deleted_at < cutoff);
  if (!candidates.length) return none;

  const chosen: string[] = [];
  let cost = 0;
  for (const c of candidates) {
    const next = PURGE_ROW_COST + 2 * Number(c.n);
    if (cost + next > budget) break;
    chosen.push(c.id);
    cost += next;
  }

  if (!chosen.length) {
    // Even the first row does not fit. If it is the row itself that is oversized, trim its oldest versions.
    const first = candidates[0];
    const chunk = Math.min(VERSION_DELETE_CHUNK, Math.floor((budget - 1) / 2));
    if (chunk < 1) return { ...none, read: candidates.length, budgetCut: true };
    const tp = new Params();
    const trimId = tp.add(first.id);
    const trimCutoff = tp.add(cutoff);
    const trimStatement = env.DB.prepare(
      // scope-exempt: retention purge of one trashed entry's versions, oldest first, only while the id is not live
      // and its trash row is still genuinely expired: a restore plus a re-forget between the candidate
      // read and this statement gives the same id a fresh, unexpired trash row (round 2 adversary).
    // write-fence: parent-capability=entries_trash（同batchのsnapshot・認可済み記憶をtriggerで検証）
      `DELETE FROM entry_versions WHERE id IN (
         SELECT v.id FROM entry_versions v WHERE v.entry_id = ${trimId} AND NOT EXISTS (SELECT 1 FROM entries x WHERE x.id = v.entry_id)
           AND EXISTS (SELECT 1 FROM entries_trash t WHERE t.id = v.entry_id AND t.deleted_at < ${trimCutoff})
          ORDER BY v.seq LIMIT ${tp.add(chunk)})`,
    ).bind(...tp.values());
    const sp = new Params();
    const trashStamp = env.DB.prepare(`UPDATE entries_trash SET write_marker = ${sp.add(memoryWriteMarker(env, "delete"))} WHERE id = ${sp.add(first.id)} AND deleted_at < ${sp.add(cutoff)}`).bind(...sp.values());
    const [stamp, res] = await env.DB.batch([
      trashStamp,
      trimStatement,
    ]);
    const trimmed = changedRows(res);
    return { read: candidates.length, purged: 0, trimmed, rowsWritten: rowsWrittenOf([stamp, res], 1 + 2 * trimmed), budgetCut: true };
  }

  // Each statement gets its own dense Params: D1 rejects a bound value with no matching placeholder.
  // Every statement also re-checks deleted_at < cutoff (not just id IN (...)): a restore plus a
  // re-forget can land between the candidate read above and this batch, giving the same id a
  // fresh, unexpired trash row that must not be swept up just because it matched the id list.
  const idsJson = JSON.stringify(chosen);
  const auditP = new Params();
  const auditIds = auditP.add(idsJson);
  const auditNow = auditP.add(now);
  const auditCutoff = auditP.add(cutoff);
  const versionsP = new Params();
  const versionsIds = versionsP.add(idsJson);
  const versionsCutoff = versionsP.add(cutoff);
  const trashP = new Params();
  const trashIds = trashP.add(idsJson);
  const trashCutoff = trashP.add(cutoff);
  const stampP = new Params();
  const stampIds = stampP.add(idsJson);
  const stampCutoff = stampP.add(cutoff);
  const trashStamp = env.DB.prepare(`UPDATE entries_trash SET write_marker = ${stampP.add(memoryWriteMarker(env, "delete"))}
      WHERE id IN (SELECT value FROM json_each(${stampIds})) AND deleted_at < ${stampCutoff}`).bind(...stampP.values());
  const trashDelete = env.DB.prepare(
      // scope-exempt: retention purge: expired trash rows
      `DELETE FROM entries_trash WHERE id IN (SELECT value FROM json_each(${trashIds})) AND deleted_at < ${trashCutoff}`,
    ).bind(...trashP.values());
  const allResults = await env.DB.batch([
    trashStamp,
    env.DB.prepare(
      // scope-exempt: retention purge: the audit row of each expired trash row, in the batch that removes it
      `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at)
       SELECT lower(hex(randomblob(16))), t.id, '', 'purged',
              json_object('channel', 'system:purge', 'reason', t.reason, 'deleted_at', t.deleted_at), ${auditNow}
         FROM entries_trash t WHERE t.id IN (SELECT value FROM json_each(${auditIds})) AND t.deleted_at < ${auditCutoff}`,
    ).bind(...auditP.values()),
    env.DB.prepare(
      // scope-exempt: retention purge: versions of expired trash rows, never of a live entry, and only while that trash row is still expired
    // write-fence: parent-capability=entries_trash（同batchのsnapshot・認可済み記憶をtriggerで検証）
      `DELETE FROM entry_versions WHERE entry_id IN (SELECT value FROM json_each(${versionsIds}))
         AND NOT EXISTS (SELECT 1 FROM entries x WHERE x.id = entry_versions.entry_id)
         AND EXISTS (SELECT 1 FROM entries_trash t WHERE t.id = entry_versions.entry_id AND t.deleted_at < ${versionsCutoff})`,
    ).bind(...versionsP.values()),
    trashDelete,
  ]);
  const results3 = allResults.slice(1);
  const purged = changedRows(results3[2]);
  // 6 per purged event (R23: idx_entry_events_life_end also indexes it), 2 per version, 3 per trash row.
  const estimate = changedRows(allResults[0]) + 6 * changedRows(results3[0]) + 2 * changedRows(results3[1]) + 3 * purged;
  // Codex review, T-0102 F1: the DELETE above only ever removed entries_trash's own row -- the
  // vectors a forgotten note still carried (Vectorize keeps its own copy independent of D1) were
  // never told the row was gone, so a purge orphaned them permanently. Only the rows that
  // actually purged (chosen can outrun the batch's own re-checked cutoff on a race), keyed off
  // the same candidate read the batch itself trusts. Best-effort, after the batch commits, the
  // same "the caller deletes the vectors after commit" contract every other purge path here uses.
  if (purged > 0) {
    const chosenSet = new Set(chosen);
    const owned = candidates
      .filter(c => chosenSet.has(c.id))
      .map(c => {
        let vectorIds: string[] = [];
        try { vectorIds = JSON.parse(c.vector_ids ?? "[]"); } catch { /* malformed column, nothing to delete */ }
        return { entryId: c.id, vectorIds };
      })
      .filter(o => o.vectorIds.length);
    if (owned.length) {
      try { await deleteEntryVectors(env, owned); } catch (e) { console.error("Purge vector cleanup failed (non-fatal):", e); }
    }
  }
  return {
    read: candidates.length, purged, trimmed: 0, rowsWritten: rowsWrittenOf(allResults, estimate),
    budgetCut: chosen.length < candidates.length,
  };
}

/** Rows written by a batch: the larger of D1's own count and the estimate (the test doubles report only changes). */
function rowsWrittenOf(results: Array<{ meta?: { rows_written?: number } } | undefined>, estimate = 0): number {
  const sum = results.reduce((n, r) => n + (r?.meta?.rows_written ?? 0), 0);
  return Math.max(sum, estimate);
}

// ── Restore ──────────────────────────────────────────────────────────────────

export interface TrashedEntryRow {
  id: string;
  workspace_id: string;
  actor_id: string;
  content: string;
  row_json: string;
  edges_json: string;
  // The live row's own vector ids at deletion time (round 2 adversary): a short append's chunk
  // (id-update-<ts>, store.ts) isn't a function of content, so it can't be rederived later.
  vector_ids: string;
  deleted_at: number;
  reason: TrashReason | string;
  // Per-row identity (adv-final MAJOR 1): id alone is not stable (a purge frees it, a fresh
  // forget reuses it) and neither is SQLite's own rowid (it can be reused too, on the same
  // millisecond a fast enough race hits). Every mutation that consumes a row read earlier pins
  // to this instead. '' means the row predates the column: no mutation may treat that as a
  // value to match, only as "this row's identity cannot be verified" (see restoreEntry).
  nonce: string;
}

/** Scoped like `getReadableEntry`: an id outside the caller's readable trash reads as missing. */
export async function getTrashedEntry(env: Env, identity: Identity | undefined, id: string): Promise<TrashedEntryRow | null> {
  if (!identity) {
    // Reached only by a direct call with no request context: unit/integration fixtures and
    // pre-tenancy compatibility. Every production caller resolves a real Identity first —
    // routes/entries.ts's POST /forget (permanent) and POST /restore narrow `auth` past
    // requireIdentity's `Identity | Response`; revertEntry (memory/undo.ts) is the only other
    // caller, itself unreachable today (POST /undo and the MCP undo tool are T-0089.6.6, backlog).
    // scope-exempt: identity-less branch takes no live request; see above for why
    return env.DB.prepare(`SELECT * FROM entries_trash WHERE id = ?`).bind(id).first<TrashedEntryRow>();
  }
  const scope = scopeWhere(identity);
  return env.DB.prepare(
    `SELECT * FROM entries_trash WHERE id = ? AND ${scope.clause}`,
  ).bind(id, ...scope.bindings).first<TrashedEntryRow>();
}

function isPrimaryKeyConflict(e: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String((e as { message?: string })?.message ?? e));
}

export type RestoreResult =
  | { status: "not_found" }
  | { status: "conflict" }
  | { status: "reembed_failed" }
  | { status: "restored"; edgesRestored: number; trashedReason: string; vectorCount: number; validity: ValidityOutcome };

/**
 * A losing restore's cleanup: its upload's ids were minted for this attempt alone (round 6), so they
 * are deleted outright; a winner, live under the same entry id, lists ids of its own.
 */
async function deleteOrphanedRestoreVectors(
  env: Env, _id: string, vectorIds: string[], _source: string, _cfg: Readonly<Config>, _writeCtx: { workspaceId: string; actorId: string },
): Promise<void> {
  await discardUpload(env, _id, vectorIds);
}

/**
 * Restore a trashed entry with its links: embeds first (so a transient failure leaves it safely in
 * the trash), then one batch inserts the entries row, restores the edges whose other endpoint still
 * exists, and removes the trash row. No version is written — restore is the trash's own undo.
 */
export async function restoreEntry(
  env: Env,
  trashed: TrashedEntryRow,
  change: ChangeContext,
  config?: Readonly<Config>,
  ctx?: ExecutionContext,
): Promise<RestoreResult> {
  // A row that predates the nonce column (adv-final MAJOR 1) has no safe per-row identity to
  // pin this batch to: id can be reused after a purge, and so can SQLite's own rowid, on the
  // same millisecond a fast enough race hits. Fail closed before any embed work runs, rather
  // than trust '' as if it were a value that could ever uniquely match one row.
  if (trashed.nonce === "") return { status: "conflict" };

  const row = JSON.parse(trashed.row_json) as Record<string, unknown>;
  // Codex review class B (T-0089.4.2): normalized here too, defensively — a row trashed before
  // this normalization landed could still carry a stray leading/trailing space on a reserved tag.
  const tags: string[] = normalizeTagList((() => { try { return JSON.parse(String(row.tags ?? "[]")); } catch { return []; } })());
  const deprecated = getStatus(tags) === "deprecated";
  // Codex review class A (T-0089.4.2): a held row must never be embedded, restore included — the
  // one gate every embed-or-upsert site for a row's real content routes through.
  const heldRow = isHeld(tags);

  // A live-again id (the id was re-captured while its old copy sat in the trash) is a conflict
  // before anything else runs: the INSERT below would fail on the primary key anyway, and checking
  // first spares an embed that could only be thrown away.
  {
    const p = new Params();
    const liveId = p.add(trashed.id);
    // scope-exempt: by-id: only decides whether to embed at all; the batch below is the real guard
    if (await env.DB.prepare(`SELECT 1 FROM entries WHERE id = ${liveId}`).bind(...p.values()).first()) {
      return { status: "conflict" };
    }
  }

  const source = String(row.source ?? "api");
  const cfg = config ?? await resolveConfig(env);
  const writeCtx = { workspaceId: trashed.workspace_id, actorId: trashed.actor_id };
  let vectorIds: string[] = [];
  if (!deprecated && !heldRow) {
    try {
      // Budget auditor R20 (T-0089.4.2): a restore re-embeds the trashed row's existing content,
      // which can be large — batchEmbeds, same as every other re-embed of existing content.
      const stored = await upsertEntryVectors(env, trashed.id, trashed.content, tags, source, Date.now(), cfg, writeCtx, { batchEmbeds: true });
      vectorIds = stored.vectorIds;
    } catch (e) {
      if (!(await isVectorizeUnavailable(env))) return { status: "reembed_failed" };
      console.error("Vectorize unavailable — restoring keyword-only:", e);
      vectorIds = [];
    }
  }
  // A held row restores exactly as held: no vectors, same as any other hold (5.3 point 1) —
  // restoring it is not a release, and the next nightly rescan (or an explicit undo) still owns
  // that decision.

  const { names, exprs } = restoreColumnsSql("t");
  // workspace_id comes from the restored entry, not the trashed edge's own snapshot (spec: "taken from the source entry").
  const edgeCols = EDGE_ROW_COLUMNS.map((c) => c === "workspace_id" ? "t.workspace_id" : `json_extract(j.value, '$.${c}')`).join(", ");
  // Each statement gets its own dense Params: D1 rejects a bound value with no matching placeholder in that statement.
  // Every statement also pins to the exact physical row `trashed` came from (its own nonce, not
  // just its id): id alone is not a stable row identity (adv-final MAJOR 1) — a purge can free an
  // id and a different member's forget can reuse it before this batch runs, and an id-only match
  // would then restore (and delete) THEIR trash row under THIS caller's authorization. Nonce, not
  // rowid: SQLite can reuse a rowid too, on the same millisecond a fast enough race hits, which
  // rowid + deleted_at alone cannot rule out.
  const insertP = new Params();
  const insertId = insertP.add(trashed.id);
  const insertNonce = insertP.add(trashed.nonce);
  const vecJson = insertP.add(JSON.stringify(vectorIds));
  const edgeP = new Params();
  const edgeId = edgeP.add(trashed.id);
  const edgeNonce = edgeP.add(trashed.nonce);
  const deleteP = new Params();
  const deleteId = deleteP.add(trashed.id);
  const deleteNonce = deleteP.add(trashed.nonce);
  // D-RET undone: a restored memory that is not wrong closes again what its removal reopened. Lands
  // only with this restore: the row is live, not deprecated, and this exact trash row is gone.
  const hook = unretractionHook(env, [{ id: trashed.id, workspaceId: trashed.workspace_id }], (p) =>
    // scope-exempt: by-id: the trash row this restore consumed, pinned by its nonce
    `x.tags NOT LIKE '%"status:deprecated"%' AND NOT EXISTS (SELECT 1 FROM entries_trash tt WHERE tt.id = x.id AND tt.nonce = ${p.add(trashed.nonce)})`,
    change, cfg, Date.now(), { cascade: true });
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        // versioning: exempt: restore (P8): no version is written coming back from the trash;
        // the trash row and any surviving versions already are its history
        // scope-exempt: by-id: the caller authorized the trash row before building this batch
        `INSERT INTO entries (id, ${names}, content, vector_ids, write_marker)
         SELECT t.id, ${exprs}, t.content, ${vecJson}, ${insertP.add(memoryWriteMarker(env))} FROM entries_trash t
          WHERE t.id = ${insertId} AND t.nonce = ${insertNonce}`,
      ).bind(...insertP.values()),
      env.DB.prepare(
        // scope-exempt: by-id: edges of the trash row the caller authorized, restored only where both endpoints are live in its workspace
        `INSERT OR IGNORE INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id, write_marker)
         SELECT ${edgeCols}, ${edgeP.add(memoryWriteMarker(env))}
           FROM entries_trash t, json_each(t.edges_json) j
          WHERE t.id = ${edgeId} AND t.nonce = ${edgeNonce}
            AND ${edgeEndpointsReadableSql("json_extract(j.value, '$.source_id')", "json_extract(j.value, '$.target_id')", "json_array(t.workspace_id)")} RETURNING id`,
      ).bind(...edgeP.values()),
      // scope-exempt: by-id: the trash row the caller authorized before building this batch
      env.DB.prepare(
    // write-fence: parent-capability=entries（同batchで復元済みの行をtriggerで検証）
        `DELETE FROM entries_trash WHERE id = ${deleteId} AND nonce = ${deleteNonce}`,
      ).bind(...deleteP.values()),
      ...hook.statements,
    ]);
  } catch (e) {
    // This attempt's upload never became the row's: its ids are per upload (T-0089.1.1), so deleting
    // them can never touch a winning restore's vectors.
    await deleteOrphanedRestoreVectors(env, trashed.id, vectorIds, source, cfg, writeCtx);
    if (isPrimaryKeyConflict(e)) return { status: "conflict" };
    throw e;
  }

  if (changedRows(results[2]) === 0) {
    // Either genuinely gone (a racing restore or purge won the SAME row; this attempt's own upload
    // goes either way, its ids are per upload), or a DIFFERENT trash row now lives under this id
    // (adv-final MAJOR 1: the id was purged and reused). Tell those apart before answering: a
    // stale read of a row that still exists, just not the one we authorized against, is a
    // conflict to retry, not a 404 claiming nothing is there.
    await deleteOrphanedRestoreVectors(env, trashed.id, vectorIds, source, cfg, writeCtx);
    const stillP = new Params();
    const stillId = stillP.add(trashed.id);
    // scope-exempt: by-id: deciding only whether the id is gone or now belongs to a different row
    const stillThere = await env.DB.prepare(`SELECT 1 FROM entries_trash WHERE id = ${stillId}`).bind(...stillP.values()).first();
    return { status: stillThere ? "conflict" : "not_found" };
  }

  // The trash row's own stored ids (round 2 adversary): a short append embedded before this
  // entry was trashed under id-update-<ts>, which the fresh re-embed above never reproduces.
  // Only the winner cleans up — deleteStaleVectors itself no-ops when vectorIds is empty (the
  // keyword-only-degrade branch above), leaving the stored ids as the entry's only index.
  try {
    const storedIds = JSON.parse(trashed.vector_ids ?? "[]") as string[];
    await deleteStaleVectors(env, trashed.id, storedIds, vectorIds);
  } catch (e) {
    console.error("Stale trash vector cleanup failed (non-fatal):", e);
  }

  const done = hook.read(results, 3);
  await auditValidity(env, change, done);
  if (ctx && tags.includes("standing:active")) standingTouched(env, ctx, cfg, [trashed.workspace_id]);
  return {
    status: "restored",
    edgesRestored: results[1].results.length,
    trashedReason: trashed.reason,
    vectorCount: vectorIds.length,
    validity: outcomeOf(done),
  };
}

// ── Delete forever ───────────────────────────────────────────────────────────

export type DeleteForeverResult =
  | { status: "not_found" }
  | { status: "deleted"; deletedVectors: number };

/**
 * The deterministic ids 3.7's storeEntry produced for this content and source (a single-chunk row
 * under its own id, a multi-chunk row under `id-chunk-i`); uploads since T-0089.1.1 mint per-upload
 * ids and are always in the stored vector_ids, so this only matters for a legacy trash row.
 * Backstops the trash row's own stored vector_ids (schema.sql), which cover a short append's
 * id-update-<ts> chunk but default to '[]' for a trash row written before that column existed —
 * this recomputes the chunk count from the same text and source for that case, rather than
 * leaving a failed forget's orphaned vector in the index forever.
 */
function deterministicVectorIds(id: string, content: string, source: string): string[] {
  const allChunks = chunkText(content);
  const chunks = MIRRORED_SOURCES.has(source) ? allChunks.slice(0, 1) : allChunks;
  return chunks.map((_, i) => (chunks.length === 1 ? id : `${id}-chunk-${i}`));
}

/**
 * Delete forever (T-0089.4.7): hard deletes ONE trash row, named by its id and the nonce it got at
 * trash time, plus its history, any leftover edges, the `purged` audit row and its vectors. A live
 * memory is never deleted here: it is forgotten into the trash first (T-0089.1.1 close-out).
 *
 * Every statement is pinned to that exact physical row (id + authorized workspace + nonce), so a
 * request authorized against a row that was since purged, restored or replaced under a reused id
 * deletes nothing. History, edges and vectors are keyed by id alone, so they are also skipped when a
 * live row holds the same id: those belong to the live row.
 *
 * Not offered to agents: REST uses the same bearer token agents hold; there is no MCP tool.
 */
export async function deleteForever(
  env: Env, id: string, change: ChangeContext,
  /** The trash row's workspace, from the caller's own scoped read. */
  authorizedWorkspaceId: string,
  /** The trash row's own nonce. '' (a row from before the column) or a missing value deletes nothing. */
  nonce: string,
): Promise<DeleteForeverResult> {
  if (typeof nonce !== "string" || nonce === "") return { status: "not_found" };
  const now = Date.now();
  const trashRow = (p: Params, bid: string) =>
    `EXISTS (SELECT 1 FROM entries_trash h WHERE h.id = ${bid} AND h.workspace_id = ${p.add(authorizedWorkspaceId)} AND h.nonce = ${p.add(nonce)})`;
  const noLiveRow = (bid: string) =>
    // scope-exempt: existence probe only, any workspace: a live row with this id owns its history and vectors
    `NOT EXISTS (SELECT 1 FROM entries l WHERE l.id = ${bid})`;
  const byId = (sql: (bid: string, p: Params) => string) => {
    const p = new Params();
    const bid = p.add(id);
    return env.DB.prepare(sql(bid, p)).bind(...p.values());
  };

  const trashStamp = byId((bid, p) => `UPDATE entries_trash SET write_marker = ${p.add(memoryWriteMarker(env, "delete"))} WHERE id = ${bid} AND workspace_id = ${p.add(authorizedWorkspaceId)} AND nonce = ${p.add(nonce)}`);
  const trashDelete = byId((bid, p) => `DELETE FROM entries_trash WHERE id = ${bid} AND workspace_id = ${p.add(authorizedWorkspaceId)} AND nonce = ${p.add(nonce)}
       RETURNING content, json_extract(row_json, '$.source') AS source, vector_ids, ${noLiveRow(bid)} AS vectors_free`);
  const results = (await env.DB.batch([
    trashStamp,
    byId((bid, p) => `UPDATE edges SET write_marker = ${p.add(memoryWriteMarker(env, "delete"))} WHERE (source_id = ${bid} OR target_id = ${bid}) AND ${trashRow(p, bid)} AND ${noLiveRow(bid)}`),
    // scope-exempt: by-id, pinned to the authorized trash row's nonce
    byId((bid, p) => `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at)
       SELECT lower(hex(randomblob(16))), ${bid}, ${p.add(change.actorId)}, 'purged',
              json_object('reason', 'permanent', 'channel', ${p.add(change.channel)}, 'from', 'trash'), ${p.add(now)}
        WHERE ${trashRow(p, bid)}`),
    // scope-exempt: by-id, pinned to the authorized trash row's nonce
    byId((bid, p) => `DELETE FROM edges WHERE (source_id = ${bid} OR target_id = ${bid}) AND ${trashRow(p, bid)} AND ${noLiveRow(bid)}`),
    // scope-exempt: by-id, pinned to the authorized trash row's nonce
    // write-fence: parent-capability=entries_trash（同batchのsnapshot・認可済み記憶をtriggerで検証）
    byId((bid, p) => `DELETE FROM entry_versions WHERE entry_id = ${bid} AND ${trashRow(p, bid)} AND ${noLiveRow(bid)}`),
    // RETURNING the stored vector ids (they cover a short append's id-update-<ts> chunk) plus content
    // and source to rederive the rest for a row stored before that column existed.
    // scope-exempt: by-id, pinned to the authorized trash row's nonce
    trashDelete,
  ])).slice(2);
  if (changedRows(results[3]) === 0) return { status: "not_found" };

  const row = results[3].results?.[0] as { content?: string; source?: string; vector_ids?: string; vectors_free?: number } | undefined;
  let vectorIds: string[] = [];
  // 3.7's derived ids are the entry id's own: if a live row somehow holds this id, leave them to it.
  if (row?.content !== undefined && row.vectors_free) {
    let stored: string[] = [];
    try { stored = JSON.parse(row.vector_ids ?? "[]"); } catch { stored = []; }
    vectorIds = [...new Set([...stored, ...deterministicVectorIds(id, row.content, row.source ?? "api")])];
  }
  try {
    if (vectorIds.length) await deleteEntryVectors(env, [{ entryId: id, vectorIds }]);
  } catch (e) {
    console.error("Vectorize delete failed during Delete forever (non-fatal):", e);
  }
  return { status: "deleted", deletedVectors: vectorIds.length };
}
