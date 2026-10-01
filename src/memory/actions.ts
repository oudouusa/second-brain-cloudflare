import { assertMemoryWritesAllowed, memoryWriteMarker } from "../migration/write-lock";
import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import { getReadableEntry, assertCanEditContent, type EntryAccessRow } from "../lib/entry-access";
import { auditEvent, auditEvents, type AuditEventInput, type ChangeContext } from "../lib/audit";
import { withTaskDone, withoutTask } from "./loops";
import { hasStaleAsOf, withoutStaleAsOf } from "./stale";
import { parseTags } from "../insight/candidates";
import { parseExplicitWhen } from "../when/input";
import { resolveConfig } from "../config";
import { withStatus, getStatus } from "./status";
import { withKind } from "./kind";
import { deleteEntryVectors, type OwnedVectors } from "../vectorize/batch";
import { buildCasGuard, changesOf, Params, pruneManyStatement, pruneStatement, snapshotStatement, type WhenChange } from "./versions";
import { LEDGER_TAG, STANDING_TAG } from "../tags/t7";
import { OWED_TO_ME_TAG } from "../commitments/direction";
import { standingTouched, type StandingCacheConfig } from "../standing/cache";
import { buildOutcomeUpdate, isLedgerDecision, outcomeNoteText, type DecisionOutcomeResult } from "../decisions/outcome";
import { auditValidity, retractionHook, RETRACTED_SOURCE_TAG, type ValidityHook } from "./validity";
import { isHeld } from "../quarantine/tags";

export type ResolveAction = "done" | "not_a_task" | "snooze" | "clear_date" | "still_true" | "received" | "stop_standing";
export type ActionResult = { ok: true; id: string; action: ResolveAction; when_at?: number; content?: string; held?: boolean } | { ok: false; error: string; status: number };
export type OutcomeActionResult =
  { ok: true; id: string; reply: string; reviewAt: number | null; reviewsDone: boolean }
  | { ok: false; error: string; status: number };

type AuditContext = { waitUntil(promise: Promise<unknown>): void };
/** BE-5/BE-6 (T-0101.5.1/T-0101.5.2): every audit event this file writes carries the same
 * channel-and-client pair a version's own meta does, so the history and trash surfaces can name
 * the client without a special case for resolve/forget/set_status. `client` is spread only when
 * present, so an old event payload's shape (channel alone) is unchanged for REST and system writes. */
const channelPayload = (change: ChangeContext) => ({ channel: change.channel, ...(change.client ? { client: change.client } : {}) });

/** The REST routes and MCP resolve tool use this same read, guard, write and audit path. */
export async function resolveEntryAction(
  env: Env, ctx: AuditContext, identity: Identity, id: string,
  action: ResolveAction, untilInput: string | undefined, change: ChangeContext,
): Promise<ActionResult> {
  await assertMemoryWritesAllowed(env);
  const cfg = await resolveConfig(env);
  let until: number | undefined;
  if (action === "snooze") {
    if (!untilInput?.trim()) return { ok: false, error: "until is required", status: 400 };
    const parsed = parseExplicitWhen(untilInput, undefined, undefined, cfg.TIMEZONE);
    if (parsed.error) return { ok: false, error: parsed.error, status: 400 };
    until = parsed.value!.at;
    if (until <= Date.now()) return { ok: false, error: "until must be in the future", status: 400 };
  }
  if (action === "still_true") {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await getReadableEntry(env, identity, id, `id, workspace_id, actor_id, tags, COALESCE(updated_at, created_at) AS prior_updated_at, staleness_checked_at`) as (EntryAccessRow & Record<string, any> | null);
      if (!row) return { ok: false, error: `No memory found with ID: ${id}`, status: 404 };
      const denied = assertCanEditContent(identity, row);
      if (denied) return { ok: false, error: denied.message, status: 403 };
      const tags: string[] = JSON.parse(row.tags ?? "[]");
      // Keep clears both review markers: out of date, and built on a retracted memory (T-0089.2.4).
      if (!hasStaleAsOf(tags) && !tags.includes(RETRACTED_SOURCE_TAG)) return { ok: false, error: "Entry is not flagged as out of date", status: 400 };
      const now = Date.now();
      const nextTags = withoutStaleAsOf(tags).filter(t => t !== RETRACTED_SOURCE_TAG);
      // Guarded on tags and workspace_id (buildCasGuard, spec P3, ADV-1/ADV-2): a concurrent edit
      // (a user-edited tag, say) between this read and the write must be kept, not overwritten by a
      // confirm that no longer describes the row as it stands, and a row moved out of this caller's
      // workspace must miss rather than commit there.
      const casColumns = { tags: row.tags, workspace_id: row.workspace_id };
      const p = new Params();
      const tagsIdx = p.add(JSON.stringify(nextTags));
      const nowIdx = p.add(now);
      const idIdx = p.add(id);
      const results = await env.DB.batch([
        snapshotStatement(env, {
          entryId: id, reason: "status", change, content: { kind: "unchanged" }, nextTags, meta: { stale_confirmed: true }, now,
          guard: p2 => buildCasGuard(p2, casColumns),
        }),
        // versioning: snapshot
        env.DB.prepare(`UPDATE entries AS e SET write_marker = ${p.add(memoryWriteMarker(env))}, tags = ${tagsIdx}, updated_at = ${nowIdx}, staleness_checked_at = ${nowIdx} WHERE e.id = ${idIdx} AND ${buildCasGuard(p, casColumns)}`)
          .bind(...p.values()),
        pruneStatement(env, id, cfg.VERSION_KEEP),
      ]);
      if (changesOf(results[1]) === 0) continue;
      auditEvents(env, ctx, [{ entryId: id, actorId: identity.userId, event: "updated", payload: {
        stale_confirmed: true,
        prior: { tags, updated_at: row.prior_updated_at, staleness_checked_at: row.staleness_checked_at ?? null },
        ...channelPayload(change),
      } }]);
      return { ok: true, id, action };
    }
    return { ok: false, error: "Could not resolve, try again", status: 409 };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id, tags, content, when_at, when_kind, when_label, when_source") as (EntryAccessRow & Record<string, any> | null);
    if (!row) return { ok: false, error: `No memory found with ID: ${id}`, status: 404 };
    const denied = assertCanEditContent(identity, row);
    if (denied) return { ok: false, error: denied.message, status: 403 };
    const tags = parseTags(row.tags as string);
    // C13: a decision without a task tag is a review, not a commitment — Done would silently
    // close it with no outcome recorded. Checked every retry: a concurrent edit could add or
    // remove either tag between attempts.
    if (action === "done" && tags.includes(LEDGER_TAG) && !tags.includes("task")) {
      return { ok: false, error: "This is a decision. Record how it went with outcome, or snooze the review.", status: 400 };
    }
    if (action === "received" && !tags.includes(OWED_TO_ME_TAG)) {
      return { ok: false, error: "received is for things owed to you; use done.", status: 400 };
    }
    if (action === "stop_standing" && !tags.includes(STANDING_TAG)) {
      return { ok: false, error: `${id} is not a standing instruction.`, status: 400 };
    }
    const priorWhen = { when_at: row.when_at ?? null, when_kind: row.when_kind ?? null, when_label: row.when_label ?? null, when_source: row.when_source ?? null };
    const now = Date.now();
    let statement: D1PreparedStatement;
    let payload: Record<string, unknown>;
    let snapshot: D1PreparedStatement;
    // The guard is built once and fed to both the snapshot and the UPDATE (spec P3, ADV-1): a
    // hand-written second copy is exactly how the snapshot's guard fell out of step with the
    // UPDATE's own WHERE clause and kept writing versions for changes that never landed. It also
    // pins workspace_id (ADV-2): a row that moved to a workspace this request was never authorized
    // to write into must miss the CAS, not just miss unnoticed — the retry above then re-reads
    // through getReadableEntry, which returns not_found or forbidden once the row is truly gone
    // from this caller's reach, rather than committing into wherever it ended up.
    if (action === "done" || action === "not_a_task" || action === "received") {
      // received is an alias of done (Design 5.4): same task:done write, guarded above to only
      // ever apply to an owed-to-me row.
      const nextTags = action === "not_a_task" ? withoutTask(tags) : withTaskDone(tags);
      const loopAction = action === "not_a_task" ? "not-task" : action === "received" ? "received" : "done";
      const casColumns = { tags: row.tags, content: row.content, workspace_id: row.workspace_id };
      snapshot = snapshotStatement(env, {
        entryId: id, reason: "status", change, content: { kind: "unchanged" }, nextTags, meta: { loop_action: loopAction }, now,
        guard: p => buildCasGuard(p, casColumns),
      });
      const p = new Params();
      const nextTagsIdx = p.add(JSON.stringify(nextTags));
      // versioning: snapshot
      statement = env.DB.prepare(`UPDATE entries AS e SET write_marker = ${p.add(memoryWriteMarker(env))}, tags = ${nextTagsIdx} WHERE e.id = ${p.add(id)} AND ${buildCasGuard(p, casColumns)}`).bind(...p.values());
      payload = { loop_action: loopAction, prior: { tags } };
    } else if (action === "stop_standing") {
      // Design 2.2: removes only standing:active, versioned and CAS-guarded like done, so undo
      // restores it. standingTouched fires below, once the write actually lands.
      const nextTags = tags.filter(t => t !== STANDING_TAG);
      const casColumns = { tags: row.tags, content: row.content, workspace_id: row.workspace_id };
      snapshot = snapshotStatement(env, {
        entryId: id, reason: "status", change, content: { kind: "unchanged" }, nextTags, meta: { standing_action: "stop" }, now,
        guard: p => buildCasGuard(p, casColumns),
      });
      const p = new Params();
      const nextTagsIdx = p.add(JSON.stringify(nextTags));
      // versioning: snapshot
      statement = env.DB.prepare(`UPDATE entries AS e SET write_marker = ${p.add(memoryWriteMarker(env))}, tags = ${nextTagsIdx} WHERE e.id = ${p.add(id)} AND ${buildCasGuard(p, casColumns)}`).bind(...p.values());
      payload = { standing_action: "stop", prior: { tags } };
    } else if (action === "snooze") {
      const nextWhen: WhenChange = { when_at: until };
      const casColumns = { tags: row.tags, content: row.content, workspace_id: row.workspace_id, ...priorWhen };
      snapshot = snapshotStatement(env, {
        entryId: id, reason: "due", change, content: { kind: "unchanged" }, nextTags: tags, nextWhen, meta: { due_action: "snooze", until }, now,
        guard: p => buildCasGuard(p, casColumns),
      });
      const p = new Params();
      const untilIdx = p.add(until);
      // versioning: snapshot
      statement = env.DB.prepare(`UPDATE entries AS e SET write_marker = ${p.add(memoryWriteMarker(env))}, when_at = ${untilIdx} WHERE e.id = ${p.add(id)} AND ${buildCasGuard(p, casColumns)}`).bind(...p.values());
      payload = { due_action: "snooze", until, prior: priorWhen };
    } else {
      const nextWhen: WhenChange = { when_at: null, when_kind: null, when_source: "cleared", when_label: null };
      const casColumns = { tags: row.tags, content: row.content, workspace_id: row.workspace_id, ...priorWhen };
      snapshot = snapshotStatement(env, {
        entryId: id, reason: "due", change, content: { kind: "unchanged" }, nextTags: tags, nextWhen, meta: { due_action: "clear" }, now,
        guard: p => buildCasGuard(p, casColumns),
      });
      const p = new Params();
      const idIdx = p.add(id);
      // versioning: snapshot
      statement = env.DB.prepare(`UPDATE entries AS e SET write_marker = ${p.add(memoryWriteMarker(env))}, when_at = NULL, when_kind = NULL, when_label = NULL, when_source = 'cleared' WHERE e.id = ${idIdx} AND ${buildCasGuard(p, casColumns)}`).bind(...p.values());
      payload = { due_action: "clear", prior: priorWhen };
    }
    const results = await env.DB.batch([snapshot, statement, pruneStatement(env, id, cfg.VERSION_KEEP)]);
    if (changesOf(results[1]) > 0) {
      auditEvent(env, ctx, { entryId: id, actorId: identity.userId, event: "status_changed", payload: { ...payload, ...channelPayload(change) } });
      if (action === "stop_standing") {
        standingTouched(env, ctx, cfg as StandingCacheConfig, [row.workspace_id as string]);
      }
      return {
        ok: true, id, action,
        ...(action === "snooze" ? { when_at: until } : {}),
        // T-0102 MINOR fix: a held row's content must never echo into the reply, even for an
        // action the row's own guard (OWED_TO_ME_TAG) permits regardless of hold status.
        ...(action === "received" ? { content: isHeld(tags) ? "" : (row.content as string), held: isHeld(tags) } : {}),
      };
    }
  }
  const verb = action === "snooze" ? "snooze" : action === "clear_date" ? "clear" : "resolve";
  return { ok: false, error: `Could not ${verb} — try again`, status: 409 };
}

/** "\n\n[Update Sep 28, 2026]: Outcome (2026-09-28): right. Shipped early." — same dated-suffix
 * shape src/capture/store.ts's appendToEntry uses for every other append, so an outcome note
 * reads like any other addition to the memory. */
function outcomeNoteSuffix(result: DecisionOutcomeResult, note: string, now: number): string {
  const timestamp = new Date(now).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  return `\n\n[Update ${timestamp}]: ${outcomeNoteText(result, note, now)}`;
}

/**
 * `resolve(id, "outcome", result, note?)` and `POST /decisions/outcome` (Design 4.2). A note
 * lands in the SAME CAS batch as the tag/when_* change — one version, so one undo reverts the
 * whole action (a review found that a separate append version let an undo strip only the note
 * and leave the outcome tag in place, while the reply still promised "Undo is available.").
 *
 * The row's vector is deliberately NOT re-embedded for the note: a background re-embed here
 * raced this same function's own undo path (its CAS write landing between the caller's read and
 * revertEntry's own guard check reported a spurious "stale", not a real conflict) and re-fetching
 * the row inside the batch's own transaction is not available through the batch() API. The
 * decision's own content, which is what the calibration and recall paths actually care about,
 * is unaffected; only the appended note text is unindexed until the row is next edited by
 * something else.
 */
export async function resolveDecisionOutcome(
  env: Env, ctx: AuditContext, identity: Identity, id: string,
  result: DecisionOutcomeResult, note: string | undefined, change: ChangeContext,
): Promise<OutcomeActionResult> {
  await assertMemoryWritesAllowed(env);
  const cfg = await resolveConfig(env);
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id, tags, content, when_at, when_kind, when_label, when_source") as (EntryAccessRow & Record<string, any> | null);
    if (!row) return { ok: false, error: `No entry found with ID: ${id}`, status: 404 };
    const denied = assertCanEditContent(identity, row);
    if (denied) return { ok: false, error: denied.message, status: 403 };
    const tags = parseTags(row.tags as string);
    if (!isLedgerDecision(tags)) return { ok: false, error: `${id} is not a logged decision.`, status: 400 };

    const priorWhen = { when_at: row.when_at ?? null, when_kind: row.when_kind ?? null, when_label: row.when_label ?? null, when_source: row.when_source ?? null };
    const now = Date.now();
    // T-0102 MINOR fix: buildOutcomeUpdate's `content` param feeds only its reply's
    // shortDecision(...) subject (see its own doc comment) -- never the write itself (nextContent,
    // below, always reads the real row.content) -- so a held row gets a blind, grammatical subject
    // ("it") in the reply text without touching what gets written or reverted.
    const update = buildOutcomeUpdate(tags, result, isHeld(tags) ? "it" : (row.content as string), now, { reviewDefaultDays: cfg.DECISION_REVIEW_DEFAULT_DAYS, timezone: cfg.TIMEZONE });
    const trimmedNote = note?.trim();
    const nextContent = trimmedNote ? `${row.content as string}${outcomeNoteSuffix(result, trimmedNote, now)}` : (row.content as string);
    const casColumns = { tags: row.tags, content: row.content, workspace_id: row.workspace_id, ...priorWhen };
    const nextWhen: WhenChange = update.nextWhen;
    const snapshot = snapshotStatement(env, {
      // meta.when: true (src/memory/undo.ts's restoreWhen) tells a plain undo to restore
      // when_* too — this is a "status"-reason version (spec 4.2) that also changes when_*,
      // unlike an ordinary status change, so it needs the same escape hatch "due"-reason
      // versions get automatically.
      entryId: id, reason: "status", change,
      content: trimmedNote ? { kind: "next", content: nextContent } : { kind: "unchanged" },
      nextTags: update.nextTags, nextWhen, meta: { decision_outcome: result, when: true }, now,
      guard: p => buildCasGuard(p, casColumns),
    });
    const p = new Params();
    const contentIdx = trimmedNote ? p.add(nextContent) : undefined;
    const tagsIdx = p.add(JSON.stringify(update.nextTags));
    const whenAtIdx = p.add(update.nextWhen.when_at);
    const whenKindIdx = p.add(update.nextWhen.when_kind);
    const whenSourceIdx = p.add(update.nextWhen.when_source);
    const idIdx = p.add(id);
    // versioning: snapshot
    const statement = env.DB.prepare(
      `UPDATE entries AS e SET write_marker = ${p.add(memoryWriteMarker(env))}, ${contentIdx ? `content = ${contentIdx}, ` : ""}tags = ${tagsIdx}, when_at = ${whenAtIdx}, when_kind = ${whenKindIdx}, when_source = ${whenSourceIdx} WHERE e.id = ${idIdx} AND ${buildCasGuard(p, casColumns)}`,
    ).bind(...p.values());
    const results = await env.DB.batch([snapshot, statement, pruneStatement(env, id, cfg.VERSION_KEEP)]);
    if (changesOf(results[1]) === 0) continue;

    auditEvent(env, ctx, { entryId: id, actorId: identity.userId, event: "status_changed", payload: { decision_outcome: result, prior: { tags, ...priorWhen }, ...channelPayload(change) } });

    return { ok: true, id, reply: update.reply, reviewAt: update.reviewAt, reviewsDone: update.reviewsDone };
  }
  return { ok: false, error: "Could not resolve, try again", status: 409 };
}

export type InsightAction = "confirm" | "dismiss";
export interface InsightResolution { resolved: string[]; skipped: number }

/** Apply already scoped insight rows in one D1 batch, also for the one-id MCP form. */
export async function applyInsightResolution(
  env: Env, ctx: AuditContext, change: ChangeContext,
  found: Record<string, any>[], requestedCount: number, action: InsightAction,
): Promise<InsightResolution> {
  await assertMemoryWritesAllowed(env);
  const cfg = await resolveConfig(env);
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  // Each row's own guard equals its own snapshot's guard (buildCasGuard, spec P3, ADV-1) and pins
  // workspace_id (ADV-2): a row moved out of scope since the caller's own read misses both, instead
  // of the bulk form's old bare-id UPDATE committing a decision the row no longer accounts for.
  const rows: { id: string; tags: string[]; vectorIds: string[]; updateAt: number }[] = [];
  for (const row of found) {
    const tags: string[] = JSON.parse(row.tags ?? "[]");
    if (!tags.includes("auto-insight") || getStatus(tags) === "deprecated") continue;
    // vector_ids pinned too (round 6): a dismiss clears them and deletes exactly the ids it read.
    const casColumns = { tags: row.tags ?? "[]", workspace_id: row.workspace_id, vector_ids: row.vector_ids ?? null };
    if (action === "confirm") {
      const promoted = withStatus(withKind(tags.filter(t => t !== "auto-insight"), "semantic"), "canonical");
      statements.push(snapshotStatement(env, {
        entryId: row.id, reason: "status", change, content: { kind: "unchanged" }, nextTags: promoted, meta: { insight_action: action }, now,
        guard: p => buildCasGuard(p, casColumns),
      }));
      const p = new Params();
      const tagsIdx = p.add(JSON.stringify(promoted));
      // versioning: snapshot
      statements.push(env.DB.prepare(`UPDATE entries AS e SET write_marker = ${p.add(memoryWriteMarker(env))}, tags = ${tagsIdx} WHERE e.id = ${p.add(row.id)} AND ${buildCasGuard(p, casColumns)}`).bind(...p.values()));
    } else {
      // validity: retraction-hooked
      const deprecated = withStatus(tags, "deprecated");
      statements.push(snapshotStatement(env, {
        entryId: row.id, reason: "status", change, content: { kind: "unchanged" }, nextTags: deprecated, meta: { insight_action: action }, now,
        guard: p => buildCasGuard(p, casColumns),
      }));
      const p = new Params();
      const tagsIdx = p.add(JSON.stringify(deprecated));
      const vecIdx = p.add("[]");
      // versioning: snapshot
      statements.push(env.DB.prepare(`UPDATE entries AS e SET write_marker = ${p.add(memoryWriteMarker(env))}, tags = ${tagsIdx}, vector_ids = ${vecIdx} WHERE e.id = ${p.add(row.id)} AND ${buildCasGuard(p, casColumns)}`).bind(...p.values()));
    }
    rows.push({ id: row.id as string, tags, vectorIds: JSON.parse(row.vector_ids ?? "[]"), updateAt: statements.length - 1 });
  }
  const resolved: string[] = [];
  const auditRows: AuditEventInput[] = [];
  const vectorsToDrop: OwnedVectors[] = [];
  let hook: ValidityHook | null = null;
  let hookOffset = 0;
  if (statements.length) {
    statements.push(pruneManyStatement(env, rows.map(r => r.id), cfg.VERSION_KEEP));
    // D-RET: a dismissed insight that had replaced an older one hands it back; lands per row once it reads deprecated.
    if (action === "dismiss") {
      hook = retractionHook(env, found.filter(r => rows.some(x => x.id === r.id)).map(r => ({ id: r.id as string, workspaceId: (r.workspace_id ?? "") as string })),
        () => `x.tags LIKE '%"status:deprecated"%'`, change, cfg, now, { cascade: true });
      hookOffset = statements.length;
      statements.push(...hook.statements);
    }
    const results = await env.DB.batch(statements);
    if (hook) await auditValidity(env, change, hook.read(results, hookOffset));
    for (const r of rows) {
      if (changesOf(results[r.updateAt]) === 0) continue;
      resolved.push(r.id);
      auditRows.push({ entryId: r.id, actorId: change.actorId, event: action === "confirm" ? "insight_confirmed" : "insight_dismissed", payload: { prior: { tags: r.tags }, ...channelPayload(change) } });
      if (action === "dismiss") vectorsToDrop.push({ entryId: r.id, vectorIds: r.vectorIds });
    }
  }
  auditEvents(env, ctx, auditRows);
  if (vectorsToDrop.length) {
    try { await deleteEntryVectors(env, vectorsToDrop); }
    catch (e) { console.error("Vectorize deleteByIds failed during bulk dismiss (non-fatal):", e); }
  }
  return { resolved, skipped: requestedCount - resolved.length };
}
