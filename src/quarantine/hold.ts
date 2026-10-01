import { assertMemoryWritesAllowed, memoryWriteMarker } from "../migration/write-lock";
// Pure builders for the statements that hold a row (16-t3-t4-trust-spec.md 5.4).
//
// A hold is its own version, written in the same D1 batch as the write it
// holds (P5): a status snapshot recording the held tags, a guarded UPDATE
// that sets them and empties vector_ids, and the usual prune. The version
// helpers are Track 1's (src/memory/versions.ts), so they arrive as
// parameters and this file imports none of them; Lane W wires the real ones.
import type { Env } from "../env";
import { withHold, type HoldReason } from "./tags";
import type { ScoreResult, SignalHit } from "./score";

/** Shared across every write path a hold can land on (5.4): what a caller needs to tell the
 * reader and the audit trail that this write ended up held. */
export interface HeldInfo { reasons: HoldReason[]; score: number }

/**
 * One policy, used by every write path that scores content (Codex review class D, T-0089.4.2,
 * simplified 2026-09-28 to drop the automatic nightly release): turns a scorer result into "does
 * this write hold, and with what reason." A write that scored `hold` on what it could scan holds
 * for that reason as before. A write that scored `partial` (over 32 KB — the scorer only scanned
 * the head and tail) but did NOT hold on what it scanned still holds, reason `too_long`, rather
 * than shipping unheld and indexable with an unscanned middle. There is no automatic release:
 * the owner reads it and releases it themselves, the same as any other hold.
 */
export function holdDecision(score: ScoreResult): { hold: true; reasons: HoldReason[]; score: number; signals: SignalHit[] } | { hold: false } {
  if (score.hold) return { hold: true, reasons: score.reasons, score: score.score, signals: score.signals };
  if (score.partial) return { hold: true, reasons: ["too_long"], score: score.score, signals: score.signals };
  return { hold: false };
}

/** Structural twin of Track 1's `Params`: allocates the next dense `?n` placeholder, reusing one for a repeated value. */
export interface PlaceholderSink {
  add(value: unknown): string;
}

/** The subset of Track 1's `SnapshotInput` a hold fills in. */
export interface HoldSnapshotInput<C> {
  entryId: string;
  reason: "status";
  change: C;
  content: { kind: "unchanged" };
  nextTags: string[];
  meta: { hold: { reasons: HoldReason[]; score: number; signals: SignalHit["id"][] } };
  now: number;
  /** Codex review, T-0102 D3: the SAME guard the UPDATE below uses -- see holdStatements' own note. */
  guard?: (p: PlaceholderSink) => string;
}

export interface HoldDeps<C> {
  snapshotStatement: (env: Env, s: HoldSnapshotInput<C>) => D1PreparedStatement;
  pruneStatement: (env: Env, entryId: string, keep: number) => D1PreparedStatement;
  versionKeep: number;
}

export interface HoldInput<C> {
  entryId: string;
  /** Largest contribution first, as scoreWrite returns them. */
  reasons: HoldReason[];
  score: number;
  signals: readonly SignalHit[];
  /** The write's ChangeContext, passed through to the snapshot untouched. */
  change: C;
  /** From heldTagsFor: the tags the write asked for, plus the hold. */
  heldTags: string[];
  now: number;
  /** The write's own compare-and-set predicate, so the hold lands only on the row the write just wrote. */
  guard?: (p: PlaceholderSink) => string;
}

class Placeholders implements PlaceholderSink {
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

/** The write's tags plus `quarantine:<primary reason>` and `status:draft` (5.4). */
export function heldTagsFor(requestedTags: readonly string[], reasons: readonly HoldReason[]): string[] {
  const primary = reasons[0];
  if (!primary) throw new Error("heldTagsFor: a hold needs at least one reason");
  return withHold(requestedTags, primary);
}

/**
 * Statements to append to the write's own batch, in order: the hold's status
 * snapshot, the guarded tags UPDATE (vector_ids emptied; the caller deletes
 * the vectors after commit, as deprecateEntry does), and the prune.
 */
export function holdStatements<C>(env: Env, deps: HoldDeps<C>, input: HoldInput<C>): D1PreparedStatement[] {
  // Codex review, T-0102 D3: the snapshot had no guard at all, so it landed unconditionally even
  // when the UPDATE right below it lost its own compare-and-set (the write this hold is riding
  // along with had gone stale in the meantime) -- a phantom hold-version row claiming a hold that
  // never actually reached the entries row's tags. Same fix as D1 (undo.ts's revertGuard): the
  // snapshot must be keyed on the exact same guard as the UPDATE, not a looser one.
  const snapshot = deps.snapshotStatement(env, {
    entryId: input.entryId,
    reason: "status",
    change: input.change,
    content: { kind: "unchanged" },
    nextTags: input.heldTags,
    meta: { hold: { reasons: [...input.reasons], score: input.score, signals: input.signals.map(s => s.id) } },
    now: input.now,
    guard: input.guard,
  });

  const p = new Placeholders();
  const tagsParam = p.add(JSON.stringify(input.heldTags));
  const idParam = p.add(input.entryId);
  const guard = input.guard ? ` AND (${input.guard(p)})` : "";
  const update = env.DB.prepare(
    // versioning: snapshot — the snapshot above rides in the same batch, under the same guard
    // scope-exempt: by-id: appended to the batch of a write that already resolved and authorized this row; the write's own guard is repeated here
    `UPDATE entries SET write_marker = ${p.add(memoryWriteMarker(env))}, tags = ${tagsParam}, vector_ids = '[]' WHERE id = ${idParam}${guard}`,
  ).bind(...p.values());

  const q = new Placeholders();
  const cleanupGuard = input.guard ? ` AND (${input.guard(q)})` : "";
  // scope-exempt: 呼出元が認可済みのentryIdと同じCAS guardでvector削除を記録する。
  // validity: any: holdと同batchで対象行の旧索引を削除台帳へ記録する。
  const cleanup = env.DB.prepare(`INSERT INTO vector_cleanup_ops (op_id, entry_id, vector_ids, created_at, ready, expires_at, write_marker)
    SELECT lower(hex(randomblob(16))), id, vector_ids, ${q.add(input.now)}, 1, ${q.add(input.now)}, ${q.add(memoryWriteMarker(env))}
    FROM entries WHERE id = ${q.add(input.entryId)}${cleanupGuard}`).bind(...q.values());
  return [snapshot, cleanup, update, deps.pruneStatement(env, input.entryId, deps.versionKeep)];
}
