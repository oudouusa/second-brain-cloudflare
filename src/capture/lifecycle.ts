import { assertMemoryWritesAllowed, memoryWriteMarker } from "../migration/write-lock";
import type { Env } from "../env";
import { getStatus, withStatus, type MemoryStatus } from "../memory/status";
import { submitLifecycleVectorCleanup } from "../vectorize/cleanup";
import { NOT_HELD_SQL } from "../quarantine/tags";
import { reembedOrDegrade, discardUpload } from "./store";
import type { Config } from "../config";
import type { ChangeContext } from "../lib/audit";
import { OWNER_WRITE_CONTEXT, type WriteContext } from "../lib/scope";
import { buildCasGuard, changesOf, Params, pruneStatement, snapshotStatement } from "../memory/versions";
import { TRASH_PURGE_ON_FORGET, FORGET_PURGE_ROWS } from "../constants";
import { planTrash, purgeLimit, purgeTrash, readTrashCandidates, trashHookOffset, trashManyStatements, type TrashReason } from "../memory/trash";
import {
  auditValidity, NO_VALIDITY_CHANGE, outcomeOf, retractionHook, unretractionHook, type ValidityOutcome,
} from "../memory/validity";
import { standingTouched } from "../standing/cache";

/** True when either tag set carries standing:active: a status change that enters or leaves it (spec 15 2.6). */
const touchesStanding = (a: readonly string[], b: readonly string[]): boolean =>
  a.includes("standing:active") || b.includes("standing:active");

export type ForgetResult =
  | { status: "not_found" }
  | { status: "deleted"; vectorCount: number; trashed: boolean; edgesDropped: boolean; validity: ValidityOutcome };

export interface ForgetOptions {
  beforeMutation?: () => Promise<void>;
  reason: TrashReason;
  config: Readonly<Config>;
  /** Run one bounded purge batch afterwards. Mirror and disconnect pass false: they audit and bound their own work. */
  purge?: boolean;
  /** Trash row budget in bytes; tests shrink it to reach the fallback tiers. */
  budget?: number;
}

/**
 * Forget moves the entry to the trash: one batch inserts the trash row (with its edges), then
 * deletes the edges and the entry. An entry too large for the trash is hard deleted, versions
 * included. `not_found` when the batch's entry delete removed nothing (a racing deleter won).
 */
export async function forgetEntry(
  id: string, env: Env, change: ChangeContext, opts: ForgetOptions,
  /** The workspace the caller's own scoped read authorized (R2-3): a row that moved out of it in
   * the awaited gap between that read and this call's own is not this caller's to trash, even
   * though readTrashCandidates (by-id, trash.ts) would otherwise still find it. */
  authorizedWorkspaceId: string,
  ctx?: ExecutionContext,
): Promise<ForgetResult> {
  await assertMemoryWritesAllowed(env);
  const [row] = await readTrashCandidates(env, [id]);
  if (!row) return { status: "not_found" };
  // A legacy row's workspace_id column can be null/undefined rather than "" (readTrashCandidates
  // reads it raw); the caller's own scoped read normalizes the same way, so pin against that, not
  // the raw column value, or a legitimate legacy row's forget always reports not_found.
  if ((row.workspace_id ?? "") !== (authorizedWorkspaceId ?? "")) return { status: "not_found" };

  const vectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");
  const plan = planTrash([row], opts.budget);
  const cleanupOpId = crypto.randomUUID();
  const now = Date.now();
  // D-RET: the rows this one closed reopen, in the same batch, before its edges and row are deleted.
  // The dependent cascade runs for a person's forget only; bulk integration removals apply the restore rule alone (P10).
  const hook = retractionHook(env, [{ id, workspaceId: row.workspace_id ?? "" }], () => "1", change, opts.config, now, { cascade: opts.reason === "forget" });
  await opts.beforeMutation?.();
  const results = await env.DB.batch(trashManyStatements(env, plan, { reason: opts.reason, change, now, hook: hook.statements, workspacePairs: [{ id, workspaceId: row.workspace_id ?? "" }], cleanupOperations: [{ entryId: id, opId: cleanupOpId }] }));
  // A racing deleter removed it between the read and the batch: it owns the cleanup and the audit.
  if (changesOf(results[results.length - 1]) === 0) return { status: "not_found" };
  const done = hook.read(results, trashHookOffset(plan));
  await auditValidity(env, change, done);

  try {
    await submitLifecycleVectorCleanup(env, cleanupOpId, id, vectorIds, opts.beforeMutation ? () => opts.beforeMutation!() : undefined);
  } catch (e) {
    console.error("Vectorize delete failed (non-fatal):", e);
  }

  if (opts.purge !== false) {
    try {
      await purgeTrash(env, opts.config, {
        ceiling: purgeLimit(opts.config.VERSION_KEEP, TRASH_PURGE_ON_FORGET, FORGET_PURGE_ROWS),
        rowTarget: FORGET_PURGE_ROWS,
      });
    } catch (e) {
      console.error("Trash purge failed (non-fatal):", e);
    }
  }

  if (ctx) {
    let tags: string[] = [];
    try { tags = JSON.parse(row.tags ?? "[]"); } catch { /* leave empty: an unparsable tags column touches nothing */ }
    if (tags.includes("standing:active")) standingTouched(env, ctx, opts.config, [row.workspace_id ?? ""]);
  }
  return { status: "deleted", vectorCount: vectorIds.length, trashed: plan.tier3.length === 0, edgesDropped: plan.tier2.length > 0, validity: outcomeOf(done) };
}

/**
 * SQL for "this entry is still supposed to be in the index".
 *
 * `deprecateEntry` empties `vector_ids` and deletes the vectors on purpose, so
 * an empty `vector_ids` means one of two opposite things: an entry that failed
 * to embed and should be retried, or one that was deliberately taken out of the
 * index and must not be. Reading it as only the first is how dismissing a
 * pattern raised the "not searchable" count and then re-embedded the very thing
 * the user had just dismissed when they pressed "Vectorize now".
 *
 * This lives beside the function that creates the state, so anything counting
 * or repairing unindexed entries can recognise it. (`vector_ids` is named bare
 * here on purpose — test/unit/updated-at-coalesced.test.ts reads every
 * backtick-delimited span in src/ as SQL, comments included.)
 *
 * W4 (16-t3-t4-trust-spec.md 5.3 point 1): a held row's vector_ids is ALSO empty, for the same
 * reason a deprecated row's is — but it must never be re-embedded, so every re-indexing path
 * behind this one constant skips it too: /vectorize-pending, the embedding migration and the
 * brief's "unindexed" count.
 */
export const INDEXABLE_SQL = `tags NOT LIKE '%"status:deprecated"%' AND ${NOT_HELD_SQL}`;

/**
 * `workspaceId` pins both the read and the write to it (R2-3): a row that moved since the caller's
 * own scoped read, in the awaited gap before this call's own read, is left alone and false is
 * returned. Required so a new caller cannot forget it; routes pass the workspace getReadableEntry
 * just authorized, captureEntry passes the writer's own.
 */
export async function deprecateEntry(
  id: string,
  env: Env,
  change: ChangeContext,
  config: Readonly<Config>,
  workspaceId: string,
  opts: { meta?: Record<string, unknown> } = {},
  ctx?: ExecutionContext,
): Promise<boolean> {
  return (await deprecateWithValidity(id, env, change, config, workspaceId, opts, ctx)).ok;
}

/**
 * deprecateEntry, reporting what the retraction hook (D-RET) reopened.
 *
 * `ctx` is optional (spec 15 2.6): a caller that omits it (an internal or test caller with no
 * ExecutionContext to give) simply does not touch the standing cache — the next revalidation
 * repairs it within STANDING_CACHE_MAX_AGE_MS regardless (P7.4), so a missing invalidation can
 * only delay a NEW fire, never leave a stopped one live.
 */
export async function deprecateWithValidity(
  id: string,
  env: Env,
  change: ChangeContext,
  config: Readonly<Config>,
  workspaceId: string,
  opts: { meta?: Record<string, unknown> } = {},
  ctx?: ExecutionContext,
): Promise<{ ok: boolean; validity: ValidityOutcome }> {
  // A route's own scoped read can carry workspace_id as null/undefined for a legacy row; SQL NULL
  // never equals another NULL via `=`, so an un-normalized pin would fail this read and every
  // later write forever, even against the row's own real state. Coalesce to "" like every other
  // read of this column.
  await assertMemoryWritesAllowed(env);
  const pinnedWorkspaceId = workspaceId ?? "";
  const row = await env.DB.prepare(
    `SELECT tags, vector_ids FROM entries WHERE id = ? AND workspace_id = ?`
  ).bind(id, pinnedWorkspaceId).first() as Record<string, any> | null;
  if (!row) return { ok: false, validity: NO_VALIDITY_CHANGE };

  const tags: string[] = JSON.parse(row.tags ?? "[]");
  const vectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");
  // validity: retraction-hooked
  const deprecatedTags = withStatus(tags, "deprecated");
  // vector_ids pinned too (round 6): the ids deleted below are exactly the ones this clear removed.
  const casColumns = { workspace_id: pinnedWorkspaceId, vector_ids: row.vector_ids ?? null };
  const now = Date.now();
  // D-RET: lands only once this row reads as deprecated, in the same batch.
  const hook = retractionHook(env, [{ id, workspaceId: pinnedWorkspaceId }], () => `x.tags LIKE '%"status:deprecated"%'`, change, config, now, { cascade: true });

  const cleanupOpId = crypto.randomUUID();
  const results = await env.DB.batch([
    snapshotStatement(env, {
      entryId: id, reason: "status", change, content: { kind: "unchanged" }, nextTags: deprecatedTags, meta: opts.meta, now,
      guard: p => buildCasGuard(p, casColumns),
    }),
    (() => {
      const p = new Params();
      const tagsIdx = p.add(JSON.stringify(deprecatedTags));
      const idIdx = p.add(id);
      // versioning: snapshot
      return env.DB.prepare(`UPDATE entries AS e SET write_marker = ${p.add(memoryWriteMarker(env))}, tags = ${tagsIdx}, vector_ids = '[]', pending_append_passages = '[]' WHERE e.id = ${idIdx} AND ${buildCasGuard(p, casColumns)}`).bind(...p.values());
    })(),
    pruneStatement(env, id, config.VERSION_KEEP),
    ...hook.statements,
    env.DB.prepare(`INSERT INTO vector_cleanup_ops (op_id, entry_id, vector_ids, created_at, ready, expires_at, write_marker)
      SELECT ?, id, ?, ?, 1, ?, ? FROM entries WHERE id = ? AND workspace_id = ? AND tags = ? AND vector_ids = '[]'`)
      .bind(cleanupOpId, JSON.stringify(vectorIds), now, now, memoryWriteMarker(env), id, pinnedWorkspaceId, JSON.stringify(deprecatedTags)),
  ]);
  if (changesOf(results[1]) === 0) return { ok: false, validity: NO_VALIDITY_CHANGE };
  const done = hook.read(results, 3);
  await auditValidity(env, change, done);

  try {
    await submitLifecycleVectorCleanup(env, cleanupOpId, id, vectorIds);
  } catch (e) {
    console.error("Vectorize deleteByIds failed during deprecate (non-fatal):", e);
  }
  if (ctx && touchesStanding(tags, deprecatedTags)) standingTouched(env, ctx, config, [pinnedWorkspaceId]);
  return { ok: true, validity: outcomeOf(done) };
}

export type ApplyStatusResult =
  | {
      status: "ok"; indexed: boolean; validity: ValidityOutcome;
      /** Round 3 re-review MAJOR (undo-group walk-back): this write's own version carries this
       * same id at meta.event_id, minted here and not by auditEventStatement's own default, so the
       * caller's audit event for it (event: "status_changed") can pass it straight through as that
       * event's own id — the exact link classifyFromRows now requires. */
      eventId: string;
    }
  | { status: "not_found" }
  /** A transient embed failure while leaving "deprecated": nothing below was written, the entry
   * is unchanged. Vectorize being unreachable is NOT this — that degrades to keyword-only instead
   * (indexed: false on the "ok" result), the same fallback restoreEntry uses (P8). */
  | { status: "reembed_failed" };

export async function applyStatus(id: string, status: MemoryStatus, env: Env, change: ChangeContext, config: Readonly<Config>, workspaceId: string, ctx?: ExecutionContext): Promise<ApplyStatusResult> {
  const eventId = crypto.randomUUID();
  if (status === "deprecated") {
    const r = await deprecateWithValidity(id, env, change, config, workspaceId, { meta: { status, event_id: eventId } }, ctx);
    return r.ok ? { status: "ok", indexed: false, validity: r.validity, eventId } : { status: "not_found" };
  }
  // R2-3: pinned to the caller's authorized workspace, same reasoning as deprecateEntry above
  // (including its null/undefined normalization for a legacy row's column value).
  await assertMemoryWritesAllowed(env);
  const pinnedWorkspaceId = workspaceId ?? "";
  const row = await env.DB.prepare(`SELECT content, tags, source, vector_ids FROM entries WHERE id = ? AND workspace_id = ?`).bind(id, pinnedWorkspaceId).first() as Record<string, any> | null;
  if (!row) return { status: "not_found" };
  const currentTags: string[] = JSON.parse(row.tags ?? "[]");
  const nextTags = withStatus(currentTags, status);
  // BE-9 (T-0101.8.2): deprecateEntry empties vector_ids on the way INTO "deprecated" (recall
  // must not find it), so leaving deprecated for any other status re-embeds before the status
  // commits, or the row would sit un-deprecated with a stale empty index. reembedOrDegrade is the
  // same fail-closed contract every other content writer uses: a transient failure throws (nothing
  // below runs, nothing is written); Vectorize being unreachable returns null and this degrades to
  // keyword-only, same as restoreEntry's own P8 fallback.
  let newVectorIdsJson: string | undefined;
  let indexed = (JSON.parse(row.vector_ids ?? "[]") as unknown[]).length > 0;
  const leavingDeprecated = getStatus(currentTags) === "deprecated";
  if (leavingDeprecated) {
    const writeCtx: WriteContext = { workspaceId: pinnedWorkspaceId, actorId: change.actorId || OWNER_WRITE_CONTEXT.actorId };
    let stored;
    try {
      stored = await reembedOrDegrade(env, id, row.content as string, nextTags, row.source as string, config, writeCtx);
    } catch (e) {
      console.error("Status re-embed failed while leaving deprecated (nothing written):", e);
      return { status: "reembed_failed" };
    }
    newVectorIdsJson = JSON.stringify(stored?.vectorIds ?? []);
    indexed = stored !== null;
  }

  // Replacing vector_ids pins the value read (round 6): the row decides which upload won.
  const casColumns = { workspace_id: pinnedWorkspaceId, ...(newVectorIdsJson !== undefined ? { vector_ids: row.vector_ids ?? null } : {}) };
  // A status set to what the row already has (tags may merely reorder) writes no version.
  const p = new Params();
  const tagsIdx = p.add(JSON.stringify(nextTags));
  const idIdx = p.add(id);
  const vectorIdsSet = newVectorIdsJson !== undefined ? `, vector_ids = ${p.add(newVectorIdsJson)}` : "";
  const now = Date.now();
  // D-RET undone: leaving deprecated closes again what this row's retraction reopened.
  const hook = leavingDeprecated
    ? unretractionHook(env, [{ id, workspaceId: pinnedWorkspaceId }], () => `x.tags NOT LIKE '%"status:deprecated"%'`, change, config, now, { cascade: true })
    : null;
  const results = await env.DB.batch([
    snapshotStatement(env, {
      entryId: id, reason: "status", change, content: { kind: "unchanged" }, nextTags, meta: { status, event_id: eventId }, now,
      guard: p2 => buildCasGuard(p2, casColumns),
    }),
    // versioning: snapshot
    env.DB.prepare(`UPDATE entries AS e SET write_marker = ${p.add(memoryWriteMarker(env))}, tags = ${tagsIdx}${vectorIdsSet} WHERE e.id = ${idIdx} AND ${buildCasGuard(p, casColumns)}`).bind(...p.values()),
    pruneStatement(env, id, config.VERSION_KEEP),
    ...(hook?.statements ?? []),
  ]);
  if (changesOf(results[1]) === 0) {
    // This call's own upload never became the row's: delete it (its ids are this upload's alone).
    if (newVectorIdsJson !== undefined) await discardUpload(env, id, JSON.parse(newVectorIdsJson) as string[]);
    return { status: "not_found" };
  }
  const done = hook ? [hook.read(results, 3)] : [];
  await auditValidity(env, change, ...done);
  if (ctx && touchesStanding(currentTags, nextTags)) standingTouched(env, ctx, config, [pinnedWorkspaceId]);
  return { status: "ok", indexed, validity: outcomeOf(...done), eventId };
}
