import type { Env } from "../env";

/**
 * Immutable audit trail writes. entry_events is INSERT-only by design — there is
 * no update or delete path anywhere in src/, so tamper evidence is the absence
 * of a way to rewrite it.
 *
 * Fire-and-forget by contract: callers hand this to ctx.waitUntil (or call it
 * inside one) so an audit write never blocks or fails a user-visible operation.
 * A lost audit row is acceptable; a lost memory is not.
 */
export type EntryEventName =
  | "created"
  | "updated"
  | "appended"
  | "deleted"
  | "status_changed"
  | "shared"
  | "unshared"
  | "insight_confirmed"
  | "insight_dismissed"
  | "reverted"
  | "restored"
  | "purged"
  // Track 2 (T-0089.2.1, T-0089.2.4): a supersede closed this row's window, a retraction or an
  // explicit write moved it, or a retraction flagged a memory built on the retracted one.
  | "superseded"
  | "validity_changed"
  | "flagged"
  // Track 4 (16-t3-t4-trust-spec.md 5.4, 5.6): a write's scorer quarantined it out of recall, or a
  // person or agent released a hold via undo.
  | "held"
  | "released";

/** Where a change came from. Recorded on every version and on the events the domain layer writes. */
export type AuditChannel = "rest" | "mcp" | `system:${string}` | "unspecified";

/** Who changed a memory and through which surface. Required on every content, tag or due-date
 * writer. `client` (BE-5, T-0101.5.1) is the resolved MCP client label — Claude, Cursor, and so
 * on — set only for `channel: "mcp"`; absent for REST and system writes. */
export interface ChangeContext { actorId: string; channel: AuditChannel; client?: string }

export interface AuditEventInput {
  entryId: string;
  actorId: string;
  event: EntryEventName;
  payload?: Record<string, unknown>;
  /** Round 3 re-review MAJOR (undo-group walk-back): a caller that also snapshots a version for
   * this same write mints this id itself and embeds it in that version's own meta.event_id, so the
   * two rows this one write produces can be told apart from any other row's, later, by nothing
   * looser than an exact id -- never a time window, never actor or client. Defaults to a fresh id
   * (the prior, only behavior) when the caller has no version to link. */
  id?: string;
}

/**
 * The one INSERT, prepared and bound but not run.
 *
 * `auditEvent` below is the ordinary way in and hands this to ctx.waitUntil. A
 * caller ruling on MANY entries in one request collects these instead and hands
 * ONE env.DB.batch to ctx.waitUntil — same statement, same table, same
 * never-blocks contract, one subrequest rather than N. POST /patterns/resolve
 * is that caller: it exists because a per-id loop puts a ceiling on the batch
 * size (a free-plan invocation gets roughly 50 D1 queries), and its cost is
 * pinned flat in the number of ids in test/integration/patterns.test.ts. A
 * per-id audit write would have reintroduced exactly the ceiling the route was
 * built to remove.
 *
 * This is a seam in the existing mechanism, not a second one: there is still
 * one place that knows the entry_events INSERT and one EntryEventName union.
 */
export function auditEventStatement(env: Env, event: AuditEventInput): D1PreparedStatement {
  const { entryId, actorId, event: name, payload, id } = event;
  return env.DB.prepare(
    `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id ?? crypto.randomUUID(), entryId, actorId, name, JSON.stringify(payload ?? {}), Date.now());
}

/**
 * The fire-and-forget contract itself, in ONE place, so the singular and
 * batched forms below cannot hold different versions of it.
 *
 * The try is not redundant with the catch. `.catch` only covers a REJECTED
 * promise; prepare, bind, run and batch are all called while `write()` is being
 * evaluated, and a synchronous throw from any of them would escape into the
 * caller — which for POST /patterns/resolve means failing a resolution that has
 * already been committed to D1, the exact thing fire-and-forget exists to make
 * impossible. `write` is a thunk rather than a promise for that reason: taking
 * a promise would move the throwing part back to the call site, which is
 * precisely how the two forms drifted apart in the first place.
 */
function fireAndForget(
  ctx: { waitUntil(promise: Promise<unknown>): void },
  message: string,
  write: () => Promise<unknown>,
): void {
  try {
    ctx.waitUntil(write().catch((e: unknown) => console.error(message, e)));
  } catch (e: unknown) {
    console.error(message, e);
  }
}

export function auditEvent(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  event: AuditEventInput,
): void {
  fireAndForget(ctx, "entry_events insert failed (non-fatal):", () =>
    auditEventStatement(env, event).run());
}

/**
 * The batched form. Callers that already build a statement list use this so the
 * whole trail for one request costs one subrequest; it keeps the same
 * fire-and-forget contract — literally the same, via fireAndForget above — so a
 * failed trail can never fail the operation it describes.
 */
export function auditEvents(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  events: AuditEventInput[],
): void {
  if (!events.length) return;
  fireAndForget(ctx, "entry_events batch insert failed (non-fatal):", () =>
    env.DB.batch(events.map((e) => auditEventStatement(env, e))));
}

/** Most audit rows in one batch, so a large delete stays inside the ~50 statements a request allows. */
export const AUDIT_BATCH_MAX = 50;

/**
 * Awaited, chunked form for callers that must have the rows written before they
 * go on (a purge or sync with no ExecutionContext to defer to): one env.DB.batch
 * per AUDIT_BATCH_MAX rows. A failed chunk is logged and does not stop the next,
 * or fail the operation the rows describe.
 */
export async function writeAuditEvents(env: Env, events: AuditEventInput[]): Promise<void> {
  for (let i = 0; i < events.length; i += AUDIT_BATCH_MAX) {
    try {
      await env.DB.batch(events.slice(i, i + AUDIT_BATCH_MAX).map(e => auditEventStatement(env, e)));
    } catch (e) {
      console.error("entry_events batch insert failed (non-fatal):", e);
    }
  }
}
