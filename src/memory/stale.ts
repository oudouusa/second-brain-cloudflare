import { withoutVolatility } from "./volatility";
import { currentValidityAt } from "./validity";
import { SQL_NOW_MS } from "../constants";
import { RETRACTED_SOURCE_TAG } from "../tags/system";

export const STALE_AS_OF = "stale:as-of";

/**
 * The out-of-date review queue, as a WHERE clause.
 *
 * One definition, used by both the count on home and the queue behind it, so the
 * chip cannot promise a number the list then fails to produce. Matches the quoted
 * JSON member rather than a bare substring, the same way PENDING_INSIGHT_SQL does.
 *
 * Deprecated entries are excluded: deprecation retires a memory from recall, and
 * asking someone to re-verify something already out of circulation is make-work. So are
 * replaced and ended ones (T-0089.2.1): a closed window is history, not a claim to re-check.
 * The fragment has no binding of its own, so "current" is read against the database clock.
 *
 * A `retracted-source` row (T-0089.2.4/spec 14 5.8) also belongs in this queue: the memory
 * itself was never marked wrong, but something it was built on later was, so it is worth a
 * second look the same as an aged fact is.
 */
export const STALE_REVIEW_SQL =
  `(tags LIKE '%"${STALE_AS_OF}"%' OR tags LIKE '%"${RETRACTED_SOURCE_TAG}"%') AND tags NOT LIKE '%"status:deprecated"%' AND ${currentValidityAt("", SQL_NOW_MS)}`;

export type StaleReason = "not_confirmed" | "date_passed" | "retracted_source";

/**
 * Why a row sits in the review queue (spec 14 5.9's `GET /stale` contract; director, 2026-09-28,
 * on the dashboard lane's contract: `not_confirmed`/`date_passed`/`retracted_source`), derived
 * from its current tags and `when_at` rather than stored, so it always reflects the row as it
 * reads now. `retracted-source` wins over a volatile row's own passed date: being built on a
 * retracted source is a different claim than "this is old", and the more specific one is worth
 * naming.
 */
export function staleReasonFor(tags: readonly string[], whenAt: number | null, now: number): StaleReason {
  if (tags.includes(RETRACTED_SOURCE_TAG)) return "retracted_source";
  if (whenAt !== null && whenAt < now) return "date_passed";
  return "not_confirmed";
}

export function hasStaleAsOf(tags: string[]): boolean {
  return tags.includes(STALE_AS_OF);
}

export function withStaleAsOf(tags: string[]): string[] {
  if (tags.includes(STALE_AS_OF)) return tags;
  return [...tags, STALE_AS_OF];
}

export function withoutStaleAsOf(tags: string[]): string[] {
  return tags.filter(t => t !== STALE_AS_OF);
}

/** Strip staleness/volatility system tags after a content-changing write. */
export function tagsAfterWrite(tags: string[]): string[] {
  return withoutVolatility(withoutStaleAsOf(tags));
}

/**
 * Tag treatment for an append, which keeps the original content and adds to it.
 *
 * The as-of qualifier clears because updated_at moves and it would otherwise report a
 * date this entry no longer has. The volatility verdict is kept, because it describes a
 * fact that is still present in the body — the same reasoning that keeps `rolled-up` on
 * an append and drops it on a replacement (see capture/store.ts).
 *
 * Stripping it here would also make the verdict depend on how a memory was edited rather
 * than on what it says: the same fact would be classified or not according to whether the
 * user appended to it, a distinction the user never made. Recovery is not prompt either,
 * because the pass reconsiders a row only once it has gone untouched past the age gate,
 * and an append resets that clock.
 */
export function tagsAfterAppend(tags: string[]): string[] {
  return withoutStaleAsOf(tags);
}

export function formatAsOfQualifier(updatedAt: number): string {
  // Spelled month: assistants read this qualifier and act on the date.
  const date = new Date(updatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  return `true as of ${date}, verify before asserting`;
}
