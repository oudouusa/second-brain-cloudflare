import { assertMemoryWritesAllowed, memoryWriteMarker } from "../migration/write-lock";
import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import type { ChangeContext } from "../lib/audit";
import { writeAuditEvents } from "../lib/audit";
import { assertCanMutateEntry, getReadableEntry } from "../lib/entry-access";
import { ensureTenantBootstrap } from "../lib/tenancy";
import { getStatus, withStatus } from "./status";
import { withUserEditMarker } from "../tags/system";
import { isHeld, isRecognizedHoldTag, QUARANTINE_TAG_PREFIX, type HoldReason } from "../quarantine/tags";
import { heldTagsFor } from "../quarantine/hold";
import { deleteEntryVectors } from "../vectorize/batch";
import { discardUpload, upsertEntryVectors, type StoredEntry } from "../capture/store";
import { isVectorizeUnavailable } from "../vectorize/health";
import { OWNER_WRITE_CONTEXT, readScopeWorkspaces, type WriteContext } from "../lib/scope";
import { groupCandidates, UNDO_GROUP_PAGE, type ChangeFamily, type DecodedGroup } from "../brief/changes";
import type { Config } from "../config";
import { VERSION_ROW_BUDGET_BYTES, UNDO_MERGE_REEMBED_INLINE } from "../constants";
import { getTrashedEntry, restoreEntry } from "./trash";
import { isManagedMirror, mirrorRestoreWarning } from "../integrations/mirror";
import {
  buildCasGuard, canRevert, changesOf, loadHistory, ownSnapshotLandedSql, pruneStatement, snapshotStatement, Params,
  type StateChange, type VersionChain, type VersionRow, type WhenChange,
} from "./versions";
import { NO_VALIDITY_CHANGE, outcomeOf, retractionHook, unretractionHook, validityEvents, validityReplySuffix, type ValidityOutcome } from "./validity";
import { standingTouched } from "../standing/cache";

export type UndoResult =
  | { status: "reverted"; targetSeq: number; recreatedIncomingId?: string; incomingTruncated?: true; keptIncoming?: { id: string; reason: string }[]; deferredIncoming?: number; validity: ValidityOutcome }
  | { status: "restored"; mirrorSource?: string; validity: ValidityOutcome }
  // Track 4 (5.6): undo on a currently-held row releases it instead of reverting a change.
  | { status: "released" }
  | { status: "no_change" }
  | { status: "nothing_to_undo" }
  // `gone` is set whenever entry_events, read once and only for a caller who is on record as an
  // actor for this id, can say truthfully why: purged after the trash retention window, hard
  // deleted for being too large for the trash (tier 3), or deleted forever. Absent means either
  // the id never existed, it belongs to a workspace this caller cannot read, or its cause could
  // not be told apart from those; never a guess, and never another member's history (T-0089.6.6).
  | { status: "not_found"; gone?: { reason: "purged" | "tier3" | "deleted_forever"; at: number } }
  | { status: "forbidden" }
  // A version outside the caller's visible chain. Split from `pruned` below (T-0089.6.6): an
  // author sees the whole chain, so for them this can only mean the shared-history cut hid it;
  // never revealed, so a teammate's "no earlier version" reads the same whether or not history
  // predating a share exists.
  | { status: "unreadable" }
  // The requested version once existed but aged out past VERSION_KEEP. Only reachable for the
  // entry's own author (T-0089.6.6): a non-author gets `unreadable` instead, so this never tells
  // them apart from a version merely hidden from them.
  | { status: "pruned"; oldestKept: number }
  | { status: "stale" }
  | { status: "reembed_failed" }
  // The live row is a connected mirror (T-0089.6.6): the next sync would overwrite any revert, so
  // nothing here is written at all, unlike every other refusal above which at least read history.
  | { status: "mirrored"; source: string };

interface EntryRow {
  id: string; workspace_id: string; actor_id: string; content: string; tags: string; source: string;
  vector_ids: string; when_at: number | null; when_kind: string | null; when_source: string | null; when_label: string | null;
  valid_from: number | null; valid_until: number | null;
  content_bytes: number; tags_bytes: number;
}

const ENTRY_COLUMNS = "id, workspace_id, actor_id, content, tags, source, vector_ids, when_at, when_kind, when_source, when_label, valid_from, valid_until, "
  + "length(CAST(content AS BLOB)) AS content_bytes, length(CAST(tags AS BLOB)) AS tags_bytes";

/** Which merge (by its version seq) a re-created row's fact came from. No content, no owner fields:
 * a merge's incoming is re-created at most once, ever, so nothing here needs to describe the row —
 * only find it again (or find that it was already handled) without a byte of duplicated text. */
interface RecordedIncoming { id: string; merge_seq: number }
const isRecordedIncoming = (v: unknown): v is RecordedIncoming =>
  !!v && typeof v === "object" && typeof (v as Record<string, unknown>).id === "string" && typeof (v as Record<string, unknown>).merge_seq === "number";
const asRecordedIncoming = (v: unknown): RecordedIncoming[] => Array.isArray(v) ? v.filter(isRecordedIncoming) : [];

const sortedTagJson = (tags: string[]) => JSON.stringify([...new Set(tags)].sort());
/** A `reason: "status"` version whose meta records a hold (5.4) — D4.1 means there is at most one
 * per unbroken held streak, since an already-held row is never rescored. */
function isHoldVersion(v: Pick<VersionRow, "reason" | "meta">): boolean {
  if (v.reason !== "status") return false;
  try { return !!(JSON.parse(v.meta || "{}") as Record<string, unknown>).hold; } catch { return false; }
}
const whenEqual = (a: WhenChange, b: WhenChange) =>
  (a.when_at ?? null) === (b.when_at ?? null)
  && (a.when_kind ?? null) === (b.when_kind ?? null)
  && (a.when_source ?? null) === (b.when_source ?? null)
  && (a.when_label ?? null) === (b.when_label ?? null);
const validityEqual = (a: StateChange, b: StateChange) =>
  (a.valid_from ?? null) === (b.valid_from ?? null) && (a.valid_until ?? null) === (b.valid_until ?? null);
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * Same fail-closed / degrade-on-outage contract as `reembedOrDegrade`, but without its own
 * `UPDATE entries SET vector_ids` — a caller that already has an INSERT or UPDATE of its own to carry
 * the ids sets them there instead, so a batch never runs a second, redundant write for the same row
 * (U5, and U14's re-created rows).
 *
 * Budget auditor R20 (T-0089.4.2): always batchEmbeds — an undo can restore content of any size
 * (the row's own history), so this must cost the same one-AI-call-per-batch as every other
 * re-embed of existing content, not one call per chunk.
 */
async function reembedForRevert(
  env: Env, id: string, content: string, tags: string[], source: string, config: Readonly<Config>, writeCtx: WriteContext,
): Promise<StoredEntry | null> {
  try {
    const stored = await upsertEntryVectors(env, id, content, tags, source, Date.now(), config, writeCtx, { batchEmbeds: true });
    if (!stored.vectorIds.length) throw new Error("re-embed produced no vectors");
    return stored;
  } catch (e) {
    if (!(await isVectorizeUnavailable(env))) throw e;
    console.error("Vectorize unavailable — committing content without re-embedding:", e);
    return null;
  }
}

/**
 * Codex review class A (T-0089.4.2): releasing a hold must NEVER degrade to keyword-only —
 * `reembedForRevert`'s degrade-on-outage contract exists for an ordinary edit, where the row was
 * already searchable and a transient Vectorize outage just means the update itself waits for
 * indexing. A held row has NO index at all; committing its unheld state without one would leave
 * it silently unsearchable with nothing to say so, and no signal to ever retry. Throws on every
 * failure, Vectorize-unavailable included, so the caller always returns `reembed_failed` and the
 * row stays held rather than releasing without ever becoming findable.
 *
 * Budget auditor R20 (T-0089.4.2, T-0089.5.9): always batchEmbeds — a held row can be up to the
 * 128 KB content cap, and a single Release re-embeds all of it in one invocation. Without this,
 * releasing one 128 KB note alone costs roughly one AI call per chunk (T-0089.5.9 measured 97 for
 * a single note), which repeated across a night's worth of releases blew the 1,000-subrequest
 * Workers Free ceiling; embedMany batches embedBatchSize() chunks per call instead.
 */
async function reembedForRelease(
  env: Env, id: string, content: string, tags: string[], source: string, config: Readonly<Config>, writeCtx: WriteContext,
): Promise<StoredEntry> {
  const stored = await upsertEntryVectors(env, id, content, tags, source, Date.now(), config, writeCtx, { batchEmbeds: true });
  if (!stored.vectorIds.length) throw new Error("re-embed produced no vectors");
  return stored;
}

/**
 * 5.6, the "row was edited after the hold" case: the hold is not the newest version, so a plain
 * revert-of-newest would restore the wrong thing (the tags-only state just before that LATER
 * edit, which are still the held ones). This is a tags-only change instead: strip quarantine:*
 * from the row's CURRENT tags (keeping whatever the later edit changed), and restore the status
 * the hold version recorded as prior — but only if nothing else has moved the row off the draft
 * the hold itself set. Content is never touched. Re-embeds first, fail-closed, same as leaving
 * deprecated: a held row has no vectors, so this is the one path that adds them back.
 */
async function releaseHeldAfterEdit(
  env: Env, id: string, row: EntryRow, currentTags: string[], chain: VersionChain,
  change: ChangeContext, config: Readonly<Config>, authorizedWorkspaceId: string,
): Promise<UndoResult> {
  const holdVersion = chain.rows.find(isHoldVersion);
  const priorStatus = holdVersion ? getStatus(JSON.parse(holdVersion.tags)) : null;
  // Codex review, T-0102, director follow-up: strips only a recognized hold tag, never a 3.7 tag
  // that merely shares the quarantine: prefix (isRecognizedHoldTag matches heldReason exactly).
  const strippedCurrent = currentTags.filter(t => !isRecognizedHoldTag(t));
  const releasedTags = (getStatus(currentTags) === "draft" && priorStatus)
    ? withStatus(strippedCurrent, priorStatus)
    : strippedCurrent;
  // The oldest kept version is the closest fact still on hand when the hold itself aged out of
  // the visible chain (pruned or D-SH cut) — an approximation, stated here rather than guessed
  // silently.
  const ofSeq = holdVersion?.seq ?? chain.rows[chain.rows.length - 1].seq;

  const embedCtx: WriteContext = { workspaceId: row.workspace_id, actorId: change.actorId || OWNER_WRITE_CONTEXT.actorId };
  let newVectorIds: string[];
  try {
    // Codex review class A (T-0089.4.2): never degrades to keyword-only — see reembedForRelease.
    newVectorIds = (await reembedForRelease(env, id, row.content, releasedTags, row.source, config, embedCtx)).vectorIds;
  } catch (e) {
    console.error("Release re-embed failed — the hold is left in place:", e);
    return { status: "reembed_failed" };
  }

  const now = Date.now();
  // Round 3 re-review MAJOR (undo-group walk-back): minted here, not by writeAuditEvents' own
  // default, so this version's meta.event_id and the "released" event it lands with below share
  // the SAME id -- an exact link, never a time window or an actor/client re-check.
  const eventId = crypto.randomUUID();
  // Codex review, T-0102 D2: content added to the guard. Content is never touched by a release
  // (the comment above this function says so), but the re-embed above ran against the content
  // THIS call read -- a concurrent edit that changed content between that read and this commit
  // would otherwise still pass (tags/workspace/vector_ids unchanged) and release text nobody
  // reviewed: the re-embedded vectors, and the released tags, for a version of the row that no
  // longer exists.
  const casColumns = { tags: row.tags, content: row.content, workspace_id: authorizedWorkspaceId, vector_ids: row.vector_ids ?? null };
  const p = new Params();
  const tagsIdx = p.add(JSON.stringify(releasedTags));
  const vectorIdsIdx = p.add(JSON.stringify(newVectorIds));
  const nowIdx = p.add(now);
  const idIdx = p.add(id);
  let results;
  try {
    results = await env.DB.batch([
      snapshotStatement(env, {
        entryId: id, reason: "status", change, content: { kind: "unchanged" }, nextTags: releasedTags,
        meta: { release: { of_seq: ofSeq }, event_id: eventId }, now,
        guard: p2 => buildCasGuard(p2, casColumns),
      }),
      // versioning: snapshot
      env.DB.prepare(`UPDATE entries AS e SET write_marker = ${p.add(memoryWriteMarker(env))}, tags = ${tagsIdx}, vector_ids = ${vectorIdsIdx}, pending_append_passages = '[]', updated_at = MAX(${nowIdx}, COALESCE(e.updated_at, e.created_at) + 1) WHERE e.id = ${idIdx} AND ${buildCasGuard(p, casColumns)}`)
        .bind(...p.values()),
      pruneStatement(env, id, config.VERSION_KEEP),
    ]);
  } catch (e) {
    if (newVectorIds) await discardUpload(env, id, newVectorIds);
    throw e;
  }
  if (changesOf(results[1]) === 0) {
    if (newVectorIds) await discardUpload(env, id, newVectorIds);
    return { status: "stale" };
  }

  await writeAuditEvents(env, [{
    id: eventId,
    entryId: id, actorId: change.actorId, event: "released",
    payload: { of_seq: ofSeq, channel: change.channel, ...(change.client ? { client: change.client } : {}) },
  }]);
  return { status: "released" };
}

/**
 * Why an id is truly gone, for a caller who could have read it (T-0089.6.6). One read of its whole
 * entry_events history (never more than a handful of rows per id): entry_events carries no
 * workspace_id (it outlives the row it describes), so scoping falls back to something the events
 * themselves prove: the caller's own userId appears as the actor on at least one of them, meaning
 * they had read or write access to the row while it still existed. A teammate who never touched it
 * gets the plain not_found instead of this, which under-informs rather than ever naming what
 * happened to a row only someone else could see.
 */
async function describeGone(
  env: Env, identity: Identity | undefined, id: string,
): Promise<{ reason: "purged" | "tier3" | "deleted_forever"; at: number } | undefined> {
  if (!identity) return undefined;
  const { results } = await env.DB.prepare(
    // scope-checked: entry_events has no workspace_id; readability is enforced below by requiring
    // the caller's own userId among the actors this id's events recorded, not by this query.
    `SELECT actor_id, event, payload, created_at FROM entry_events WHERE entry_id = ? ORDER BY created_at ASC, rowid ASC`,
  ).bind(id).all<{ actor_id: string; event: string; payload: string; created_at: number }>();
  const rows = results ?? [];
  if (!rows.length || !rows.some(r => r.actor_id === identity.userId)) return undefined;
  const last = rows[rows.length - 1];
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(last.payload || "{}"); } catch { payload = {}; }
  if (last.event === "purged" && payload.reason === "permanent") return { reason: "deleted_forever", at: last.created_at };
  if (last.event === "purged") return { reason: "purged", at: last.created_at };
  if (last.event === "deleted" && payload.trash === false) return { reason: "tier3", at: last.created_at };
  return undefined;
}

/**
 * Reverses the most recent change to a memory, or a specific earlier version (`toVersion`), or
 * delegates to a trash restore when the row is gone. Design "Undo" (T-0089.1.3).
 */
export async function revertEntry(
  env: Env, identity: Identity | undefined, id: string, change: ChangeContext, config: Readonly<Config>, toVersion: number | undefined,
  /**
   * Pins the CAS guard to the workspace the caller's own scoped read authorized (Class 1,
   * T-0089.6.6's route and MCP tool), rather than the read this function makes moments later — an
   * unshare landing in that gap must miss the guard, not silently authorize against wherever the
   * row ended up. Required, not defaulted to this function's own read: a caller with no scoped
   * read of its own has no business calling this at all. When there is no live row (the trash
   * path), this value is never consumed — any string is fine, since restoreEntry has its own
   * scoping through getTrashedEntry.
   */
  authorizedWorkspaceId: string,
  /** Optional: the trash row the caller saw. Given, undo only restores that exact row, never reverts a live one. */
  trashNonce?: string,
  ctx?: ExecutionContext,
  /**
   * Round 4 re-review MAJOR (undo-group): the group's own classifyFromRows already found this
   * member's newest version's seq at classification time -- given, this is checked fresh here,
   * before any read-then-act work below (re-embedding included) rather than only at the write
   * itself, since only the undo-group path's toVersion can already be stale by the time its own
   * page reaches this member. A mismatch reports "stale" (the group maps it to changed_since) and
   * touches nothing. Every other caller (the single-entry /undo route and MCP tool) has no prior
   * classification to compare against, so this is always undefined for them.
   */
  expectedTipSeq?: number,
): Promise<UndoResult> {
  const row = await getReadableEntry(env, identity, id, ENTRY_COLUMNS) as EntryRow | null;
  if (row && trashNonce !== undefined) return { status: "not_found" };
  if (!row) {
    // No live row: undo of a forget, if the trash row is readable (author or admin, same as forget itself).
    const found = await getTrashedEntry(env, identity, id);
    const trashed = found && (trashNonce === undefined || found.nonce === trashNonce) ? found : null;
    if (!trashed) {
      const gone = await describeGone(env, identity, id);
      return gone ? { status: "not_found", gone } : { status: "not_found" };
    }
    // Same author lock POST /restore enforces (routes/entries.ts): visibility into the trash is not
    // itself permission to bring a company memory back.
    const denied = assertCanMutateEntry(identity, trashed);
    if (denied) return { status: "forbidden" };
    const restored = await restoreEntry(env, trashed, change, config, ctx);
    switch (restored.status) {
      case "restored": {
        await writeAuditEvents(env, [{
          entryId: id, actorId: change.actorId, event: "restored",
          payload: { channel: change.channel, edgesRestored: restored.edgesRestored, trashedReason: restored.trashedReason },
        }]);
        // A mirror row the integration itself removed still restores (T-0089.6.6): the integration
        // never asked for this row back, so the next sync would remove it again unless the person
        // also undoes it at the source.
        let mirrorSource: string | undefined;
        if (trashed.reason === "mirror") {
          try {
            const src = (JSON.parse(trashed.row_json) as { source?: string }).source;
            if (src && (await isManagedMirror(src, env))) mirrorSource = src;
          } catch { /* malformed row_json restores plain, same as everywhere else this is parsed */ }
        }
        return mirrorSource ? { status: "restored", mirrorSource, validity: restored.validity } : { status: "restored", validity: restored.validity };
      }
      case "reembed_failed": return { status: "reembed_failed" };
      // A racing restore or purge already claimed the trash row between the read above and the batch.
      case "not_found": case "conflict": return { status: "not_found" };
    }
  }

  const currentTagsList: string[] = JSON.parse(row.tags);
  const wasHeld = isHeld(currentTagsList);

  // A connected mirror row (T-0089.6.6): the next sync would overwrite any revert, so this refuses
  // before reading history at all, the same as the edit and append routes refuse before writing.
  // 5.6 exemption: releasing a hold changes tags only, and the next sync rewrites content, not
  // tags, so a held mirror row can still be released.
  if (!(wasHeld && toVersion === undefined) && await isManagedMirror(row.source, env)) {
    return { status: "mirrored", source: row.source };
  }

  const chain = await loadHistory(env, identity, { id, content: row.content }, config.VERSION_KEEP);
  if (!chain.rows.length) return { status: "nothing_to_undo" };

  const newest = chain.rows[0];
  // Round 4 re-review MAJOR: checked before any further work (re-embedding included) -- a third
  // party's edit landing between classification and this call already moved this row's own tip,
  // and toVersion (computed back at classification time) would otherwise still land, silently
  // overwriting that edit.
  if (expectedTipSeq !== undefined && newest.seq !== expectedTipSeq) return { status: "stale" };

  // 5.6: undo on a currently-held row releases it, whether or not the hold is the newest version.
  // The common case (hold IS newest) needs no dedicated path: falling through to the ordinary
  // revert-of-newest logic below already restores the hold version's recorded PRIOR tags (the
  // write's own requested tags, before quarantine), which is exactly the release; the generalized
  // needsReembed/nextVectorIds logic further down (wasHeld/willBeHeld) handles re-indexing it.
  if (toVersion === undefined && wasHeld && !isHoldVersion(newest)) {
    const ownerUserId = newest.workspace_id === "" ? (await ensureTenantBootstrap(env)).ownerUserId : undefined;
    const verdict = canRevert(identity, { workspace_id: row.workspace_id, actor_id: row.actor_id }, newest, newest.seq, chain.rows.map(r => r.seq), { ownerUserId });
    if (!verdict.ok) return { status: verdict.code };
    return releaseHeldAfterEdit(env, id, row, currentTagsList, chain, change, config, authorizedWorkspaceId);
  }
  const target: VersionRow | undefined = toVersion === undefined ? newest : chain.rows.find(r => r.seq === toVersion);
  if (!target) {
    // toVersion named a seq outside the visible chain. The author sees the whole chain (up to
    // VERSION_KEEP), so for them this can only mean it aged out (T-0089.6.6): the oldest kept
    // version is offered instead of a bare refusal. A non-author's chain can also be cut short by
    // the shared-history rule (D-SH), never told apart from pruning, so they get one neutral
    // "unreadable" either way, which reveals nothing about history that might exist before the cut.
    const isAuthor = identity !== undefined && row.actor_id !== "" && identity.userId === row.actor_id;
    if (isAuthor) return { status: "pruned", oldestKept: chain.rows[chain.rows.length - 1].seq };
    return { status: "unreadable" };
  }

  const ownerUserId = target.workspace_id === "" ? (await ensureTenantBootstrap(env)).ownerUserId : undefined;
  const verdict = canRevert(identity, { workspace_id: row.workspace_id, actor_id: row.actor_id }, target, newest.seq, chain.rows.map(r => r.seq), { ownerUserId });
  if (!verdict.ok) return { status: verdict.code };

  const isPerson = change.channel === "rest" || change.channel === "mcp";
  const restoredContent = chain.text(target.seq);
  // Cross-vendor re-review MINOR (T-0102, on top of 0b970baa): an EXPLICIT to_version reaching
  // back past a later edit to land exactly on the hold transition itself must restore it held --
  // target.tags is that version's own (pre-hold, unheld) tags by definition, so using it bare
  // would publish the held text with clean tags. An implicit undo (toVersion === undefined)
  // landing on the hold version is deliberately different: that already means "release" (the
  // common case, handled above), so this only fires when toVersion was actually given.
  const targetHoldMeta = toVersion !== undefined && isHoldVersion(target)
    ? (JSON.parse(target.meta || "{}") as { hold?: { reasons: HoldReason[] } }).hold
    : null;
  const restoredTagsRaw: string[] = targetHoldMeta
    ? heldTagsFor(JSON.parse(target.tags), targetHoldMeta.reasons)
    : JSON.parse(target.tags);
  const restoredTags = isPerson ? withUserEditMarker(restoredTagsRaw) : restoredTagsRaw;

  const targetState = JSON.parse(target.state || "{}") as StateChange;
  const targetMeta = JSON.parse(target.meta || "{}") as Record<string, unknown>;

  /**
   * Whether this merge's incoming row has already been re-created, anywhere in the visible chain,
   * whatever has happened to that row since — live, edited, moved, trashed or gone (U10, U13, U15,
   * U16). A merge's fact is re-created at MOST ONCE, EVER: this is a pure lookup over versions
   * already in hand, no DB read, so it costs nothing against the statement budget (U14).
   */
  function findRecordedIncoming(mergeSeq: number): RecordedIncoming | undefined {
    for (const r of chain.rows) {
      if (r.reason !== "revert") continue;
      let m: Record<string, unknown>;
      try { m = JSON.parse(r.meta || "{}"); } catch { continue; }
      const hit = asRecordedIncoming(m.recreated_incoming).find(s => s.merge_seq === mergeSeq);
      if (hit) return hit;
    }
    return undefined;
  }

  // Rolling back to (or past) a merge/replace pulls its absorbed text out of the live row, wherever
  // it sits in the chain: a to_version rollback can cross several merges at once, not only land on
  // one (U10), so every version between the target and the newest, inclusive, whose reason is merge
  // or replace gets its own re-created row — unless it was already re-created at some point, in which
  // case it is left exactly alone (never resurrected, never duplicated) and reported as kept.
  const mergesInRange = chain.rows.filter(r => r.seq >= target.seq && r.seq <= newest.seq && (r.reason === "merge" || r.reason === "replace"));
  const mergesToCreate: { merge: VersionRow; meta: Record<string, unknown>; id: string }[] = [];
  const keptIncoming: { id: string; reason: string }[] = [];
  let anyIncomingTruncated = false;
  for (const merge of mergesInRange) {
    const already = findRecordedIncoming(merge.seq);
    if (already) { keptIncoming.push({ id: already.id, reason: "already recreated" }); continue; }
    let mergeMeta: Record<string, unknown>;
    try { mergeMeta = JSON.parse(merge.meta || "{}"); } catch { mergeMeta = {}; }
    if (mergeMeta.incomingTruncated === true) { anyIncomingTruncated = true; continue; }
    if (!("incoming" in mergeMeta)) continue;
    mergesToCreate.push({ merge, meta: mergeMeta, id: crypto.randomUUID() });
  }

  // Undoing a merge undo (a redo) never removes the row that undo re-created (Director decision,
  // T-0089.1.3 round 3): it just restores the merged text and leaves that row exactly as it is,
  // reporting it every time so whoever is looking can see the fact now lives in two places and
  // remove one on purpose. The record travels forward on every hop so this keeps working no matter
  // how many undo/redo cycles run.
  // "re-created earlier" rather than a claim like "kept as its own memory" (U20): this report costs
  // no DB read, so it cannot say whether the row is still there, still that content, or gone for
  // good — Task 15 surfaces this text to users, and it must never assert a memory exists that does not.
  const inheritedIncoming = target.reason === "revert" ? asRecordedIncoming(targetMeta.recreated_incoming) : [];
  for (const entry of inheritedIncoming) keptIncoming.push({ id: entry.id, reason: "re-created earlier" });

  const recreatedForMeta: RecordedIncoming[] = [
    ...inheritedIncoming,
    ...mergesToCreate.map(m => ({ id: m.id, merge_seq: m.merge.seq })),
  ];

  // A due version, or an append that carried a when, restores when_* alongside content; so does a
  // full rollback to an older state (toVersion), which returns everything to that point in time.
  const restoreWhen = toVersion !== undefined || target.reason === "due" || targetMeta.when === true;
  const nextWhen: WhenChange | undefined = restoreWhen
    ? { when_at: targetState.when_at ?? null, when_kind: targetState.when_kind ?? null, when_source: targetState.when_source ?? null, when_label: targetState.when_label ?? null }
    : undefined;

  // Validity (T-0089.2.1), by the same rule: a validity version, a revert that restored it (a redo),
  // or a full rollback. Only from a state that recorded the keys: a version written before Track 2
  // has none, and its columns are then left alone rather than read as "open since created_at".
  const recordsValidity = "valid_until" in targetState;
  const restoreValidity = recordsValidity && (toVersion !== undefined || target.reason === "validity" || targetMeta.validity === true);
  const nextValidity: StateChange | undefined = restoreValidity
    ? { valid_from: targetState.valid_from ?? null, valid_until: targetState.valid_until ?? null }
    : undefined;

  const currentWhen: WhenChange = { when_at: row.when_at, when_kind: row.when_kind, when_source: row.when_source, when_label: row.when_label };
  const contentChanged = restoredContent !== row.content;
  const tagsChanged = sortedTagJson(restoredTags) !== sortedTagJson(JSON.parse(row.tags));
  const whenChanged = restoreWhen && !whenEqual(nextWhen!, currentWhen);
  const validityChanged = restoreValidity && !validityEqual(nextValidity!, { valid_from: row.valid_from, valid_until: row.valid_until });
  if (!contentChanged && !tagsChanged && !whenChanged && !validityChanged) return { status: "no_change" };

  const currentStatus = getStatus(JSON.parse(row.tags));
  const targetStatus = getStatus(restoredTagsRaw);
  const undeprecating = currentStatus === "deprecated" && targetStatus !== "deprecated";
  // 5.6: "re-embed when content changes, or when the row leaves deprecated OR HELD." willBeHeld
  // is also how a redo (undo of a release) re-enters held: it restores the release version's
  // recorded prior tags, which are the still-held ones.
  const willBeHeld = isHeld(restoredTagsRaw);
  const releasing = wasHeld && !willBeHeld;
  const needsReembed = targetStatus !== "deprecated" && !willBeHeld && (contentChanged || undeprecating || releasing);
  const embedCtx: WriteContext = { workspaceId: row.workspace_id, actorId: change.actorId || OWNER_WRITE_CONTEXT.actorId };
  const oldVectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");

  let newVectorIds: string[] | null = null;
  if (needsReembed) {
    try {
      // Codex review class A (T-0089.4.2): releasing a hold never degrades to keyword-only — see
      // reembedForRelease's own reasoning. Every other reason needsReembed fires keeps the
      // existing degrade-on-outage contract.
      newVectorIds = releasing
        ? (await reembedForRelease(env, id, restoredContent, restoredTags, row.source, config, embedCtx)).vectorIds
        : (await reembedForRevert(env, id, restoredContent, restoredTags, row.source, config, embedCtx))?.vectorIds ?? null;
    } catch (e) {
      console.error("Undo re-embed failed — entry left unchanged:", e);
      return { status: "reembed_failed" };
    }
  }
  // Only set when this revert actually touched the vector index (re-embedded, or deprecating/
  // undeprecating). Otherwise leaving it out of the UPDATE, rather than rebinding this call's own
  // stale read, is what stops a re-index that lands mid-undo from being erased (U11).
  const nextVectorIds = needsReembed ? (newVectorIds ? JSON.stringify(newVectorIds) : undefined) : (targetStatus === "deprecated" || willBeHeld) ? "[]" : undefined;

  const nonce = crypto.randomUUID();
  const now = Date.now();
  // D-RET (T-0089.2.4): a revert into "wrong" hands back what this row had replaced; a revert out of it
  // takes it again. Either lands only if this revert's own snapshot did.
  const retracting = currentStatus !== "deprecated" && targetStatus === "deprecated";
  const landed = (hp: Params) => ownSnapshotLandedSql(hp, id, newest.seq, nonce);
  const hookRow = [{ id, workspaceId: authorizedWorkspaceId }];
  const retraction = retracting ? retractionHook(env, hookRow, landed, change, config, now, { cascade: true }) : null;
  const unretraction = undeprecating ? unretractionHook(env, hookRow, landed, change, config, now, { cascade: true }) : null;
  // Round 6: replacing vector_ids also pins the value this undo read, so the row decides which
  // upload won and the old ids retired below are exactly the ones this commit replaced. Read here,
  // ahead of revertGuard below, so the guard can pin it too.
  const readVectorIds = row.vector_ids ?? "[]";
  // Pinned at authorization (the caller's own scoped read), never at the write: a share/unshare
  // writes no version, so without this a concurrent move leaves MAX(seq) unchanged and an admin's
  // undo can commit into the row after it left their reach (U3, R2-7, Class 1).
  //
  // Codex review, T-0102 D1: the SAME guard the UPDATE uses, not a lighter one just for the
  // snapshot. The snapshot's own guard used to be workspace_id alone, while the UPDATE also
  // pinned vector_ids whenever this revert touches the vector index (nextVectorIds !== undefined)
  // -- a concurrent re-embed that changed vector_ids between this read and the commit left the
  // snapshot (workspace unchanged) landing while the UPDATE's own vector_ids pin made it lose,
  // half-applying the revert: a phantom "revert" version in the history with the row's actual
  // content and tags never touched. Every statement downstream of ownSnapshotLandedSql (the
  // UPDATE, the retract/unretract hooks at `landed` above, the merge-recreate inserts below)
  // trusts that a landed snapshot means a real, consistent revert; that is only true once the
  // snapshot cannot land without the UPDATE being ABLE to land right behind it.
  const revertGuard = (guardP: Params) => {
    const cols: Record<string, unknown> = { workspace_id: authorizedWorkspaceId };
    if (nextVectorIds !== undefined) cols.vector_ids = readVectorIds;
    return buildCasGuard(guardP, cols);
  };
  const p = new Params();
  // The when_* columns are set only when this revert is actually restoring the date. Rebinding them
  // from this call's own stale JS read, as every other column here does, would silently erase a date
  // some other write (the unversioned when pass, when/pass.ts) set in the meantime (U7).
  const whenSet = restoreWhen
    ? `, when_at = ${p.add(nextWhen!.when_at ?? null)}, when_kind = ${p.add(nextWhen!.when_kind ?? null)}, when_source = ${p.add(nextWhen!.when_source ?? null)}, when_label = ${p.add(nextWhen!.when_label ?? null)}`
    : "";
  const validitySet = restoreValidity
    ? `, valid_from = ${p.add(nextValidity!.valid_from ?? null)}, valid_until = ${p.add(nextValidity!.valid_until ?? null)}`
    : "";
  const vectorIdsSet = nextVectorIds !== undefined ? `, vector_ids = ${p.add(nextVectorIds)}, pending_append_passages = '[]'` : "";
  // updated_at clamped strictly past its own previous value (the digest mark guard trusts it
  // plus byte length; a same-millisecond, same-length revert with no clamp would leave it unmoved).
  // versioning: snapshot
  const updateSql = `UPDATE entries AS e SET write_marker = ${p.add(memoryWriteMarker(env))}, content = ${p.add(restoredContent)}, tags = ${p.add(JSON.stringify(restoredTags))}, updated_at = MAX(${p.add(now)}, COALESCE(e.updated_at, e.created_at) + 1)${vectorIdsSet}${whenSet}${validitySet} WHERE e.id = ${p.add(id)} AND ${revertGuard(p)} AND ${ownSnapshotLandedSql(p, id, newest.seq, nonce)}`;

  // Embedded before the batch, like the main content above, so the insert below can carry its own
  // vector_ids the way restoreEntry does (U14). Each insert is guarded by the SAME "this request's own
  // snapshot landed" condition as the UPDATE, and runs INSIDE the revert's own batch, not a separate
  // one after it: the row and the meta that records it now commit together or not at all — a thrown
  // or lost insert can no longer leave the record saying a row exists that was never created, which
  // would otherwise block every future rollback from ever trying again (U18).
  const insertedAt = Date.now();
  const incomingInserts: { id: string; vectorIds: string[]; actorId: string }[] = [];
  const incomingStatements: D1PreparedStatement[] = [];
  let deferredIncoming = 0;
  for (const create of mergesToCreate) {
    const incoming = String(create.meta.incoming ?? "");
    const incomingTags: string[] = Array.isArray(create.meta.incomingTags) ? create.meta.incomingTags as string[] : [];
    const incomingSource = String(create.meta.incomingSource ?? row.source);
    let vectorIds: string[] = [];
    // Only the first UNDO_MERGE_REEMBED_INLINE re-created rows are embedded in this request: a
    // to_version rollback can cross hundreds of merges at once (up to VERSION_KEEP of them), and
    // one AI plus one Vectorize call per row would blow past the per-invocation service subrequest
    // limit long before D1 or KV even enter the count. The rest still get their own row here (the
    // fact is never lost), just with vector_ids left at '[]', same as POST /import defers embedding
    // (routes/entries.ts) — POST /vectorize-pending backfills them afterward.
    if (incomingInserts.length < UNDO_MERGE_REEMBED_INLINE) {
      try {
        vectorIds = (await reembedForRevert(env, create.id, incoming, incomingTags, incomingSource, config, { workspaceId: row.workspace_id, actorId: create.merge.actor_id }))?.vectorIds ?? [];
      } catch (e) {
        console.error("Undo-merge re-embed failed (non-fatal):", e);
      }
    } else {
      deferredIncoming++;
    }
    incomingInserts.push({ id: create.id, vectorIds, actorId: create.merge.actor_id });
    const ip = new Params();
    // versioning: exempt: creation — a re-created row has no prior state to keep
    incomingStatements.push(env.DB.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, write_marker)
       SELECT ${ip.add(create.id)}, ${ip.add(incoming)}, ${ip.add(JSON.stringify(incomingTags))}, ${ip.add(incomingSource)}, ${ip.add(insertedAt)}, ${ip.add(insertedAt)}, ${ip.add(JSON.stringify(vectorIds))}, ${ip.add(row.workspace_id)}, ${ip.add(create.merge.actor_id)}, ${ip.add(memoryWriteMarker(env))}
        WHERE ${ownSnapshotLandedSql(ip, id, newest.seq, nonce)}`,
    ).bind(...ip.values()));
  }

  // Row budget (U13, same rule the merge writer applies to its own version row, P16): a rollback from
  // a long, merged state back to a short one cannot use the delta encoding (that needs the CURRENT
  // text to be a PREFIX of what replaces it, never true going from longer to shorter), so the version
  // row holds a full copy of the current content. Computed here in JS from columns the one row read
  // above already carries — no extra statement — the same margin the merge writer uses (1024 bytes).
  const contentIsFullCopy = contentChanged
    && !(restoredContent.startsWith(row.content) && !row.content.includes("\0") && !restoredContent.includes("\0"));
  const projectedStateBytes = utf8Bytes(JSON.stringify({ when_at: row.when_at, when_kind: row.when_kind, when_source: row.when_source, when_label: row.when_label, valid_from: row.valid_from, valid_until: row.valid_until }));
  // Round 3 re-review MAJOR (undo-group walk-back): minted here, not by writeAuditEvents' own
  // default, so this version's meta.event_id and the "released"/"reverted" event it lands with
  // below share the SAME id -- an exact link, never a time window or an actor/client re-check.
  const eventId = crypto.randomUUID();
  const metaCandidate = {
    nonce, target_seq: target.seq, reverted_reason: target.reason, event_id: eventId,
    ...(restoreWhen ? { when: true } : {}),
    ...(restoreValidity ? { validity: true } : {}),
    ...(recreatedForMeta.length ? { recreated_incoming: recreatedForMeta } : {}),
  };
  const projectedRowBytes = (contentIsFullCopy ? row.content_bytes : 0) + row.tags_bytes + projectedStateBytes + utf8Bytes(JSON.stringify(metaCandidate)) + 1024;
  // recreated_incoming looks like the row's one optional part, the way meta.incoming is optional for
  // the merge writer's own row — but dropping it is not a safe fallback here (U19): a merge's incoming
  // is re-created at most once ever, and that promise is kept entirely by this record. A row that lost
  // it here would let a later rollback past the same merge re-create it a second time, permanently.
  // Unlike the merge writer's optional text, there is nothing else in this row safe to drop: content
  // is the row's own required history (shrinking it would corrupt reconstruction), so an oversized
  // full copy is only ever logged, the same residual risk the spec already accepts for a row that
  // grows past what a scoped read can predict.
  if (projectedRowBytes > VERSION_ROW_BUDGET_BYTES) console.error("Revert version row may exceed the row budget (non-fatal, nothing dropped):", { entryId: id, projectedRowBytes });

  let results;
  try {
    results = await env.DB.batch([
      snapshotStatement(env, {
        entryId: id, reason: "revert", change,
        content: contentChanged ? { kind: "next", content: restoredContent } : { kind: "unchanged" },
        nextTags: restoredTags, nextWhen, nextState: nextValidity, skipNoOp: false, expectNewestSeq: newest.seq, guard: revertGuard,
        // Recorded whenever this revert restores the date, so a later undo of THIS version (a redo)
        // knows to restore when_* too, the same way an append-with-when or a due version does (U2).
        // recreated_incoming carries only ids and which merge each belongs to (never content, never
        // owner fields) — enough to find a row again or tell a merge was already covered, at a
        // constant, tiny cost regardless of how large the fact itself is (U13).
        meta: metaCandidate, now,
      }),
      // versioning: snapshot
      env.DB.prepare(updateSql).bind(...p.values()),
      ...incomingStatements,
      pruneStatement(env, id, config.VERSION_KEEP),
      ...(retraction?.statements ?? []),
      ...(unretraction?.statements ?? []),
    ]);
  } catch (e) {
    // A thrown batch: this undo's own upload never became the row's (ids are per upload, T-0089.1.1),
    // so delete it; the row's listed vectors were never touched.
    if (needsReembed) await discardUpload(env, id, newVectorIds);
    // The incoming rows never landed either (same batch, same guard, and now nothing to undo — the
    // INSERTs are gone with the rest of the transaction). Their vectors are fresh ids under no row,
    // not a live row's own, so cleaning them up here breaks no rule (U18).
    for (const ins of incomingInserts) { if (ins.vectorIds.length) { try { await deleteEntryVectors(env, [{ entryId: ins.id, vectorIds: ins.vectorIds }]); } catch (e2) { console.error("Orphan vector cleanup failed (non-fatal):", e2); } } }
    throw e;
  }

  if (changesOf(results[1]) === 0) {
    // The existence read comes first (U12): if it throws, nothing below has run and the row still
    // names whatever committed its own vectors, never something this lost attempt already deleted.
    // scope-exempt: by-id: the row was read above under the caller's own scope
    const stillThere = await env.DB.prepare(`SELECT 1 AS ok FROM entries WHERE id = ?`).bind(id).first();
    if (!stillThere) {
      // The row is truly gone: the fresh vectors this undo wrote describe a row nothing owns now.
      if (newVectorIds) { try { await deleteEntryVectors(env, [{ entryId: id, vectorIds: newVectorIds }]); } catch (e) { console.error("Orphan vector cleanup failed (non-fatal):", e); } }
      // The incoming inserts share the UPDATE's own guard, so they missed too: nothing landed for
      // them either, and their fresh vectors are equally orphaned.
      for (const ins of incomingInserts) { if (ins.vectorIds.length) { try { await deleteEntryVectors(env, [{ entryId: ins.id, vectorIds: ins.vectorIds }]); } catch (e) { console.error("Orphan vector cleanup failed (non-fatal):", e); } } }
      return { status: "not_found" };
    }
    // The row is still there, committed by someone else: its vectors are its own, and this undo's
    // upload (per-upload ids) is deleted without touching them.
    if (needsReembed) await discardUpload(env, id, newVectorIds);
    // Same shared guard, same miss: the incoming inserts landed nowhere, so their vectors are orphans.
    for (const ins of incomingInserts) { if (ins.vectorIds.length) { try { await deleteEntryVectors(env, [{ entryId: ins.id, vectorIds: ins.vectorIds }]); } catch (e) { console.error("Orphan vector cleanup failed (non-fatal):", e); } } }
    return { status: "stale" };
  }

  if (targetStatus === "deprecated" || willBeHeld || needsReembed) {
    const stale = (targetStatus === "deprecated" || willBeHeld) ? oldVectorIds : oldVectorIds.filter(v => !(newVectorIds ?? []).includes(v));
    try { if (stale.length) await deleteEntryVectors(env, [{ entryId: id, vectorIds: stale }]); } catch (e) { console.error("Old vector cleanup failed (non-fatal):", e); }
  }

  const hookOffset = 3 + incomingStatements.length;
  const hookResults = [retraction, unretraction].filter(h => h !== null).map(h => h!.read(results, hookOffset));
  // 5.6: releasing a hold (the common case, hold is the newest version) gets its OWN event —
  // "released", not "reverted" — so the changes line (5.8) and the agent-facing copy (5.5) can
  // tell the two apart without inspecting tags.
  await writeAuditEvents(env, [releasing ? {
    id: eventId,
    entryId: id, actorId: change.actorId, event: "released",
    payload: { of_seq: target.seq, channel: change.channel, ...(change.client ? { client: change.client } : {}) },
  } : {
    id: eventId,
    entryId: id, actorId: change.actorId, event: "reverted",
    payload: { target_seq: target.seq, reverted_reason: target.reason, channel: change.channel },
  }, ...validityEvents(change, ...hookResults)]);

  // Release (undo of a quarantine hold) also touches: spec 15 2.13 calls it out by name, and the
  // gate is the same either way — whatever this revert restores the row TO is what decides.
  if (ctx) {
    const priorTags: string[] = (() => { try { return JSON.parse(row.tags); } catch { return []; } })();
    if (priorTags.includes("standing:active") || restoredTags.includes("standing:active")) {
      standingTouched(env, ctx, config, [row.workspace_id ?? ""]);
    }
  }
  if (releasing) return { status: "released" };

  const result: UndoResult = { status: "reverted", targetSeq: target.seq, validity: hookResults.length ? outcomeOf(...hookResults) : NO_VALIDITY_CHANGE };

  // Undo of a merge or replace re-creates the incoming memory it absorbed, as its own row — never
  // through captureEntry, which could merge it right back in. Fires for every merge a to_version
  // rollback crosses, not only when a merge is the newest change (U4, U10). Reaching this point means
  // the batch above landed, so every incoming insert landed with it (same guard, same transaction):
  // only the audits, which are fire-and-forget by contract anyway, remain to be written here (U18).
  if (anyIncomingTruncated) (result as { incomingTruncated?: true }).incomingTruncated = true;
  if (incomingInserts.length) {
    const createdEvents = incomingInserts.map(ins => ({
      entryId: ins.id, actorId: change.actorId, event: "created" as const,
      // The undoer performs the recreation, so the undoer is credited and the undo's own channel
      // rides along, the same as every other audit this function writes (U17).
      payload: { cause: "undo_merge", from: id, channel: change.channel },
    }));
    await writeAuditEvents(env, createdEvents);
    (result as { recreatedIncomingId?: string }).recreatedIncomingId = incomingInserts[0].id;
  }
  if (keptIncoming.length) (result as { keptIncoming?: { id: string; reason: string }[] }).keptIncoming = keptIncoming;
  if (deferredIncoming) (result as { deferredIncoming?: number }).deferredIncoming = deferredIncoming;

  return result;
}

// ── Undo/release a group (S3, 5.9) ──────────────────────────────────────────
//
// Membership is re-derived from the reader's own scoped read on every call
// (changes.ts's groupCandidates), never trusted from the client. Paging is
// stateless: UNDO_GROUP_PAGE members are taken from whichever candidates are
// still "actionable" this call, where a member drops out of "actionable" the
// moment its own current state shows it was already handled --
//   - held family: it is no longer held (isHeld(tags) is false);
//   - status/edit/revert families: its newest version's created_at, actor and
//     client no longer match the group's own recorded actor/client/window --
//     which is also true of a genuine third-party edit, so those two cases are
//     told apart by whether the newest version was written by the identity now
//     calling undo/group, after the window closed, with reason "revert" or a
//     release's "status" (5.6) -- i.e. whether it looks like OUR own earlier
//     page's write. A third-party edit that lands between two pages of the
//     SAME undo/group call, before this heuristic's page reaches it, is
//     reported as changed_since once and then (since nothing is written for
//     it) can be re-offered on a later call if the caller keeps going past
//     `remaining: 0` -- accepted: no write is ever duplicated or lost, only a
//     rare race's status line could repeat.
export interface UndoGroupResult {
  results: { id: string; result: string }[];
  done: boolean;
  remaining: number;
  group: string;
  capped: boolean;
  /** The group's total member count (after the UNDO_GROUP_MAX cap), stable across calls. */
  total: number;
  family: ChangeFamily;
}

function resultForStatus(status: UndoResult["status"]): string {
  return status;
}

async function resolveHeldGroup(
  env: Env, identity: Identity, ids: string[], change: ChangeContext, config: Readonly<Config>,
  ctx: ExecutionContext | undefined, groupKeyStr: string, capped: boolean, scope: string[],
): Promise<UndoGroupResult> {
  const { results: rows } = await env.DB.prepare(
    // scope-checked: workspace_id IN (?2) narrows to the reader's own scope; ids already come
    // from groupCandidates's own reader-scoped derivation, so this is defense in depth, not the
    // only check.
    `SELECT id, tags, workspace_id FROM entries WHERE id IN (SELECT value FROM json_each(?1)) AND workspace_id IN (SELECT value FROM json_each(?2))`,
  ).bind(JSON.stringify(ids), JSON.stringify(scope)).all<{ id: string; tags: string; workspace_id: string }>();
  const byId = new Map(rows.map(r => [r.id, r]));

  const actionable = ids.filter(id => {
    const row = byId.get(id);
    if (!row) return false;
    try { return isHeld(JSON.parse(row.tags) as string[]); } catch { return false; }
  });
  const page = actionable.slice(0, UNDO_GROUP_PAGE);

  const results: { id: string; result: string }[] = [];
  for (const id of page) {
    const row = byId.get(id)!;
    const outcome = await revertEntry(env, identity, id, change, config, undefined, row.workspace_id, undefined, ctx);
    results.push({ id, result: resultForStatus(outcome.status) });
  }
  const remaining = actionable.length - page.length;
  return { results, done: remaining === 0, remaining, group: groupKeyStr, capped, total: ids.length, family: "held" };
}

async function resolveTrashGroup(
  env: Env, identity: Identity, ids: string[], change: ChangeContext, config: Readonly<Config>,
  ctx: ExecutionContext | undefined, groupKeyStr: string, capped: boolean, scope: string[],
): Promise<UndoGroupResult> {
  const { results: rows } = await env.DB.prepare(
    // scope-checked: workspace_id IN (?2) narrows to the reader's own scope; ids already come
    // from groupCandidates's own reader-scoped derivation, so this is defense in depth, not the
    // only check.
    `SELECT id, workspace_id, nonce FROM entries_trash WHERE id IN (SELECT value FROM json_each(?1)) AND workspace_id IN (SELECT value FROM json_each(?2))`,
  ).bind(JSON.stringify(ids), JSON.stringify(scope)).all<{ id: string; workspace_id: string; nonce: string }>();
  const byId = new Map(rows.map(r => [r.id, r]));
  const actionable = ids.filter(id => byId.has(id));
  const page = actionable.slice(0, UNDO_GROUP_PAGE);

  const results: { id: string; result: string }[] = [];
  for (const id of page) {
    const row = byId.get(id)!;
    const outcome = await revertEntry(env, identity, id, change, config, undefined, row.workspace_id, row.nonce, ctx);
    results.push({ id, result: resultForStatus(outcome.status) });
  }
  const remaining = actionable.length - page.length;
  return { results, done: remaining === 0, remaining, group: groupKeyStr, capped, total: ids.length, family: "trash" };
}

interface ChainRow {
  entry_id: string; seq: number; meta: string; reason: string; channel: string; actor_id: string; created_at: number; workspace_id: string;
}

type MemberVerdict =
  | {
      kind: "pending"; toVersion: number; workspaceId: string;
      /** Round 4 re-review MAJOR: this member's own newest version's seq, AT CLASSIFICATION TIME
       * -- carried through to revertEntry as its own fresh compare-and-set, so a third party's
       * edit landing in the gap between this classification and that later call (another page's
       * worth of reverts, each with its own re-embed, can take real time) is caught before
       * anything is written, not silently overwritten by a now-stale toVersion. */
      tipSeq: number;
    }
  | { kind: "done" }
  | { kind: "changed_since" }
  | { kind: "not_found" };

function parseVersionMeta(r: ChainRow): Record<string, unknown> {
  try { return JSON.parse(r.meta || "{}"); } catch { return {}; }
}

/**
 * True exactly when `r` is the version one of the group's own recorded events produced (round 3
 * re-review MAJOR: "the group's versions are exactly the versions linked to the group's own event
 * ids. No time windows, and no matching by actor or client."). Every write that can join a group
 * mints its own event id before its batch and stamps it into BOTH the version's own meta.event_id
 * and the audit event it lands with moments later (src/capture/lifecycle.ts's applyStatus,
 * src/memory/undo.ts's releaseHeldAfterEdit/revertEntry) -- a plain set-membership check, so a
 * same-actor edit outside the group's own recorded events, or a third party's edit landing in
 * between two of them, can never be mistaken for the group's own work, whatever its reason,
 * channel, actor or client label happen to be.
 */
function isOwnVersion(r: ChainRow, ownEventIds: ReadonlySet<string>): boolean {
  const id = parseVersionMeta(r).event_id;
  return typeof id === "string" && ownEventIds.has(id);
}

/** Walks back from `rows[upto]` (inclusive) through consecutive own-versions. `ok` is true only
 * when the run found exactly `ownEventIds.size` of them -- not fewer (something else broke the
 * run before all of the group's own events for this member were accounted for) and, since a
 * version's own event id is unique to it, never more. */
function walkOwn(rows: readonly ChainRow[], upto: number, ownEventIds: ReadonlySet<string>): { firstIdx: number; ok: boolean } {
  let idx = upto;
  let count = 0;
  while (idx >= 0 && isOwnVersion(rows[idx], ownEventIds)) { idx--; count++; }
  return { firstIdx: idx + 1, ok: count === ownEventIds.size };
}

/**
 * "Revert a member only if its group versions are contiguous and are the newest versions. In
 * every other case, report changed_since and touch nothing: a version outside the group in
 * between, one after, or any doubt" (round 3 re-review MAJOR). `ownEventIds` is this one member's
 * own share of the group's event ids, from groupCandidates' own per-entry derivation (never this
 * whole group's ids -- a different member's own events say nothing about this one).
 */
function classifyFromRows(rows: readonly ChainRow[] | undefined, ownEventIds: ReadonlySet<string>): MemberVerdict {
  if (!rows?.length || !ownEventIds.size) return { kind: "not_found" };

  const tip = rows.length - 1;
  const atTip = walkOwn(rows, tip, ownEventIds);
  if (atTip.ok) return { kind: "pending", toVersion: rows[atTip.firstIdx].seq, workspaceId: rows[atTip.firstIdx].workspace_id, tipSeq: rows[tip].seq };

  // Not pending at the tip -- maybe it is already done: the newest version is a revert whose own
  // target_seq matches exactly what this same walk computes over everything before it, the group's
  // own work already undone (by this group's own undo call, or anyone else's -- once reverted to
  // that exact version, it no longer matters who did it).
  const newest = rows[tip];
  if (tip > 0 && newest.reason === "revert") {
    const target = parseVersionMeta(newest).target_seq;
    const underRevert = walkOwn(rows, tip - 1, ownEventIds);
    if (underRevert.ok && typeof target === "number" && rows[underRevert.firstIdx].seq === target) return { kind: "done" };
  }
  return { kind: "changed_since" };
}

/**
 * `classifyFromRows`, for every id in one bulk read (Codex review, T-0102 R23, auditor MINOR): a
 * separate SELECT per id meant each already-"done" member from a prior page's revert still cost
 * its own statement to reclassify on every later call (paging is stateless, so every call
 * rescans from ids[0]) -- growing by UNDO_GROUP_PAGE statements every page, 71 by the group's
 * tenth page against this lane's 40-statement-per-page target. One query for the whole page's
 * candidate ids keeps the read cost constant regardless of how many are already done. The window
 * function caps each id's own chain at the same 500 rows the per-id form's LIMIT did -- SQLite
 * has no per-group LIMIT, so it is expressed as a ROW_NUMBER filter instead.
 */
async function classifyMembers(
  env: Env, ids: readonly string[], eventIdsByEntry: ReadonlyMap<string, ReadonlySet<string>>, scope: string[],
): Promise<Map<string, MemberVerdict>> {
  const out = new Map<string, MemberVerdict>();
  if (!ids.length) return out;
  const { results } = await env.DB.prepare(
    // scope-checked: en.workspace_id IN (?2) narrows to the reader's own scope; ids also already
    // come from groupCandidates's own reader-scoped derivation, so this is defense in depth.
    `SELECT entry_id, seq, meta, reason, channel, actor_id, created_at, workspace_id FROM (
       SELECT ev.entry_id AS entry_id, ev.seq AS seq, ev.meta AS meta, ev.reason AS reason,
         ev.channel AS channel, ev.actor_id AS actor_id, ev.created_at AS created_at, en.workspace_id AS workspace_id,
         ROW_NUMBER() OVER (PARTITION BY ev.entry_id ORDER BY ev.seq ASC) AS rn
       FROM entry_versions ev JOIN entries en ON en.id = ev.entry_id
       WHERE ev.entry_id IN (SELECT value FROM json_each(?1)) AND en.workspace_id IN (SELECT value FROM json_each(?2))
     ) WHERE rn <= 500 ORDER BY entry_id ASC, seq ASC`,
  ).bind(JSON.stringify(ids), JSON.stringify(scope)).all<ChainRow>();

  const byEntry = new Map<string, ChainRow[]>();
  for (const r of results) {
    const rows = byEntry.get(r.entry_id);
    if (rows) rows.push(r); else byEntry.set(r.entry_id, [r]);
  }
  for (const id of ids) out.set(id, classifyFromRows(byEntry.get(id), eventIdsByEntry.get(id) ?? new Set()));
  return out;
}

async function resolveVersionGroup(
  env: Env, identity: Identity, decoded: DecodedGroup, ids: string[], eventIdsByEntry: ReadonlyMap<string, ReadonlySet<string>>,
  change: ChangeContext, config: Readonly<Config>,
  ctx: ExecutionContext | undefined, groupKeyStr: string, capped: boolean, scope: string[],
): Promise<UndoGroupResult> {
  const results: { id: string; result: string }[] = [];
  const verdicts = await classifyMembers(env, ids, eventIdsByEntry, scope);
  // Codex review, T-0102 E2: only an ACTUAL revert (verdict "pending") spends this call's page
  // budget now. The old bound (results.length, which also grew for "not_found"/"changed_since")
  // stopped the scan the moment UNDO_GROUP_PAGE blocked members turned up -- and since `i` is
  // local to this call, never persisted, the next call started over at ids[0] and hit the exact
  // same blocked members again: more than UNDO_GROUP_PAGE permanently-blocked members ahead of
  // any revertable one stalled the group forever. `i` still bounds the scan (ids.length, itself
  // capped at UNDO_GROUP_MAX = 50 members), and classifyMembers above already read every verdict
  // in one statement, so a call that turns out fully blocked costs no more reads than one that
  // doesn't.
  let acted = 0;
  let i = 0;
  for (; i < ids.length && acted < UNDO_GROUP_PAGE; i++) {
    const verdict = verdicts.get(ids[i])!;
    if (verdict.kind === "done") continue;
    if (verdict.kind === "not_found" || verdict.kind === "changed_since") { results.push({ id: ids[i], result: verdict.kind }); continue; }
    const outcome = await revertEntry(env, identity, ids[i], change, config, verdict.toVersion, verdict.workspaceId, undefined, ctx, verdict.tipSeq);
    // Round 4 re-review MAJOR: revertEntry's own "stale" (its fresh tip no longer matches
    // verdict.tipSeq, or the ordinary CAS below it lost) reads as changed_since here -- from the
    // group's own perspective the two mean the same thing, something moved since this was read.
    results.push({ id: ids[i], result: outcome.status === "stale" ? "changed_since" : resultForStatus(outcome.status) });
    acted++;
  }
  // Everything from i onward is still unexamined and stays actionable for the next call.
  const remaining = ids.length - i;
  return { results, done: remaining === 0, remaining, group: groupKeyStr, capped, total: ids.length, family: decoded.family };
}

/**
 * "Undo all" / "release all" (5.9). Returns null when `groupKeyStr` does not decode to a group
 * shape at all (a malformed or foreign string) -- the caller renders that as `not_found`, the
 * same neutral response an unreadable id gets elsewhere in this file.
 */
export async function undoGroup(
  env: Env, identity: Identity, groupKeyStr: string, change: ChangeContext, config: Readonly<Config>, ctx?: ExecutionContext,
): Promise<UndoGroupResult | null> {
  const candidates = await groupCandidates(env, identity, groupKeyStr, config);
  if (!candidates) return null;
  const { decoded, ids, eventIdsByEntry, capped } = candidates;
  if (!ids.length) return { results: [], done: true, remaining: 0, group: groupKeyStr, capped, total: 0, family: decoded.family };

  const scope = readScopeWorkspaces(identity);
  if (decoded.family === "held") return resolveHeldGroup(env, identity, ids, change, config, ctx, groupKeyStr, capped, scope);
  if (decoded.family === "trash") return resolveTrashGroup(env, identity, ids, change, config, ctx, groupKeyStr, capped, scope);
  return resolveVersionGroup(env, identity, decoded, ids, eventIdsByEntry, change, config, ctx, groupKeyStr, capped, scope);
}

/** "Undid 5 of 14 changes in that group; call undo with the same group again to continue." (5.9). */
export function undoGroupMcpReply(result: UndoGroupResult): string {
  const verb = result.family === "held" ? "Released" : "Undid";
  const noun = result.family === "held" ? "releases" : "changes";
  const done = result.total - result.remaining;
  if (result.remaining === 0) return `${verb} all ${result.total} ${noun} in that group.`;
  return `${verb} ${done} of ${result.total} ${noun} in that group; call undo with the same group again to continue.`;
}

// ── Reply text (T-0089.6.6) ──────────────────────────────────────────────────
//
// One function per result, called from both POST /undo (routes/entries.ts) and the MCP undo tool
// (mcp/server.ts), so the two surfaces' wording can never drift apart the way their rows and
// versions are already guaranteed not to (see the file header above and undo-surfaces.test.ts).

export function revertedMessage(id: string, result: Extract<UndoResult, { status: "reverted" }>): string {
  let text = `Reverted entry ${id} to how it was before its last change (version ${result.targetSeq}). Undo again to put it back.`;
  if (result.incomingTruncated) text += " The text that was merged in was too large to keep, so it could not be re-created.";
  if (result.recreatedIncomingId) text += ` The text that was merged in is now its own memory, ${result.recreatedIncomingId}.`;
  if (result.keptIncoming?.length) text += ` Memory ${result.keptIncoming.map(k => k.id).join(", ")}, which an earlier undo re-created, was kept.`;
  if (result.deferredIncoming) {
    text += ` ${result.deferredIncoming} of the memories this restored are still being indexed for semantic search (findable by keyword in the meantime); POST /vectorize-pending until remaining is 0.`;
  }
  return text + validityReplySuffix(result.validity, id, "undo");
}

export function restoredMessage(id: string, result: Extract<UndoResult, { status: "restored" }>): string {
  return (result.mirrorSource ? mirrorRestoreWarning(id, result.mirrorSource) : `Restored entry ${id} from the trash.`)
    + validityReplySuffix(result.validity, id, "undo");
}

/** `toVersion` is always defined here: `pruned` is only reachable when the caller named one. */
export function prunedMessage(id: string, toVersion: number, oldestKept: number, versionKeep: number): string {
  return `Only the last ${versionKeep} changes to entry ${id} are kept, and version ${toVersion} is older than that. The oldest kept is version ${oldestKept}.`;
}

/** Never distinguishes "aged out" from "hidden by the shared-history rule" (D-SH): see `pruned` above. */
export function unreadableMessage(id: string): string {
  return `No earlier version of entry ${id} is visible to you. Its author can undo older changes.`;
}

export function goneMessage(
  id: string, gone: Extract<UndoResult, { status: "not_found" }>["gone"], retentionDays: number,
): string {
  const date = new Date(gone!.at).toDateString();
  if (gone!.reason === "deleted_forever") return `Entry ${id} was deleted forever on ${date}.`;
  if (gone!.reason === "tier3") return `Entry ${id} was too large for the trash and was deleted for good on ${date}.`;
  return `Entry ${id} was in the trash for ${retentionDays} days and was removed for good on ${date}. It cannot be restored.`;
}
