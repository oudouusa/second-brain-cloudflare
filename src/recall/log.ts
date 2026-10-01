/**
 * T-0089.5.2: the sampled recall log (Part A, feeding the golden eval set T-0043) and
 * implicit feedback from what agents already do (Part B), without a per-read D1 write and
 * without a per-recall KV write (R12, budget auditor dab677a5).
 *
 * Opt-in via config RECALL_LOG, off by default everywhere (D5.2) — the log holds the
 * user's own query text, in the user's own D1, never exported by default. Both entry
 * points are called at most once per recall/get/append/update/link (search.ts and the
 * MCP/REST handlers each call one of them), and both are safe to await inside
 * `ctx.waitUntil`: neither throws, and neither affects what the caller already returned.
 *
 * Deliberately KV-free. An earlier version enforced the per-day cap with a KV counter
 * (one get, one put per logged recall) — cheap for one member, but Workers Free allows only
 * 1,000 KV writes/day for the WHOLE account, shared with OAuth grants, push leases and the
 * standing cache. Five members logging a busy day would have spent the account's entire KV
 * write budget on this one counter and broken every other KV-writing feature until midnight
 * UTC (test/budget/t5-recall-log-kv.test.ts). D1's free-tier budget (100k rows written,
 * 5M read, per day) is two to three orders of magnitude larger, so the cap lives there.
 */
import { memoryWriteMarker } from "../migration/write-lock";
import type { Env } from "../env";
import type { Config } from "../config";
import { resolveConfig } from "../config";
import { RECALL_LOG_FOLLOW_WINDOW_MS, RECALL_LOG_PER_DAY, RECALL_LOG_PURGE_BATCH, RECALL_LOG_RETENTION_DAYS, RECEIPT_TIME_BUCKET_MS } from "../constants";

export type RecallLogChannel = "mcp" | "rest";

export interface RecallLogInput {
  workspaceId: string;
  channel: RecallLogChannel;
  /** The raw query text — this is what makes the log opt-in (D5.2), not a hash or summary. */
  query: string;
  /** topK, filters (tag/kind/date/project) and hops, serialised as-is. */
  params: unknown;
  returnedIds: readonly string[];
  now: number;
  /** Part C (05-proof.md): the caller's own pre-generated id, so the recall response's
   * `receipt` matches this row without reading it back. Falls back to a generated one. */
  id?: string;
}

function dayNumber(now: number): number {
  return Math.floor(now / 86400000);
}

/**
 * Logs at most RECALL_LOG_PER_DAY recalls per workspace per day (D5.2 gate: only when
 * RECALL_LOG is "on"). The cap and the insert are ONE D1 statement: the INSERT's own SELECT
 * carries a `WHERE (today's count for this workspace) < cap` clause, so a workspace already
 * over budget inserts zero rows without a separate read statement and without touching KV
 * at all. The correlated COUNT is bounded by idx_recall_log_ws (workspace_id, created_at
 * DESC) to at most RECALL_LOG_PER_DAY rows examined, whatever the workspace's true row
 * count. A logged recall also purges up to RECALL_LOG_PURGE_BATCH rows past the retention
 * window, oldest first, so the table never grows past what the day cap plus retention imply.
 */
export async function maybeLogRecall(env: Env, cfg: Config, input: RecallLogInput): Promise<void> {
  if (cfg.RECALL_LOG !== "on") return;
  try {
    const dayStart = dayNumber(input.now) * 86400000;
    const cutoff = input.now - RECALL_LOG_RETENTION_DAYS * 86400000;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO recall_log (id, workspace_id, created_at, channel, query, params, returned_ids, write_marker)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM recall_log WHERE workspace_id = ? AND created_at >= ?) < ?`,
      ).bind(
        input.id ?? crypto.randomUUID(),
        input.workspaceId,
        input.now,
        input.channel,
        input.query,
        JSON.stringify(input.params),
        JSON.stringify(input.returnedIds),
        memoryWriteMarker(env),
        input.workspaceId,
        dayStart,
        RECALL_LOG_PER_DAY,
      ),
      // Standard SQLite (D1 included) has no DELETE ... LIMIT, so the bound is expressed
      // as a subquery: at most RECALL_LOG_PURGE_BATCH of the oldest rows past retention.
      // Runs whether or not the insert above landed a row — harmless either way, and
      // simpler than conditioning it on the insert's own row count.
      //
      // R17 (budget auditor, MAJOR): scoped to THIS workspace, not the whole table. Without
      // workspace_id in the WHERE, created_at alone has no index (idx_recall_log_ws leads
      // with workspace_id), so SQLite scanned every row in recall_log on every logged
      // recall — about 6,000 rows/workspace/day at the 200/day cap and 30-day retention,
      // deployment-wide. Scoping it lets the subquery SEARCH idx_recall_log_ws instead of
      // SCAN the table, and each workspace now purges only its own expired rows — every
      // workspace's retention is still enforced, just on its own logging, not on a global
      // sweep one workspace's traffic happened to trigger.
      env.DB.prepare(
        `UPDATE recall_log SET write_marker = ? WHERE id IN (SELECT id FROM recall_log WHERE workspace_id = ? AND created_at < ? ORDER BY created_at ASC LIMIT ?)`,
      ).bind(memoryWriteMarker(env, "delete"), input.workspaceId, cutoff, RECALL_LOG_PURGE_BATCH),
      env.DB.prepare(
        `DELETE FROM recall_log WHERE id IN (SELECT id FROM recall_log WHERE workspace_id = ? AND created_at < ? ORDER BY created_at ASC LIMIT ?)`,
      ).bind(input.workspaceId, cutoff, RECALL_LOG_PURGE_BATCH),
    ]);
  } catch (e) {
    console.error("recall_log write failed (non-fatal):", e);
  }
}

/**
 * Part B: a get, append, update or link on an id, within RECALL_LOG_FOLLOW_WINDOW_MS of a
 * recall that returned it, is implicit feedback that the recall was used. Looks up only
 * the LATEST recall_log row for the workspace (one indexed read on idx_recall_log_ws)
 * FIRST, before touching config at all: whenever RECALL_LOG has never been turned on the
 * table is empty, so this read finds nothing and returns — the common case costs one cheap
 * D1 read and NO KV read, let alone a write. Config is only resolved (or reused, if the
 * caller already had it in hand for something else) once a matching row is actually found,
 * and only then decides whether to write. Feeds the golden set only (D5.4); ranking never
 * reads followed_ids.
 *
 * Takes every id from one caller (link's source and target) together rather than one call
 * per id: two independent read-then-write calls on the SAME row race — both can read the
 * row before either writes, and the second write then clobbers the first's mark.
 */
export async function maybeMarkFollowedMany(env: Env, workspaceId: string, entryIds: readonly string[], now: number, cfg?: Config): Promise<void> {
  if (entryIds.length === 0) return;
  try {
    const row = await env.DB.prepare(
      `SELECT id, returned_ids, followed_ids FROM recall_log WHERE workspace_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
    ).bind(workspaceId, now - RECALL_LOG_FOLLOW_WINDOW_MS).first() as { id: string; returned_ids: string; followed_ids: string } | null;
    if (!row) return;

    const resolvedCfg = cfg ?? await resolveConfig(env);
    if (resolvedCfg.RECALL_LOG !== "on") return;

    let returned: unknown;
    let followed: unknown;
    try {
      returned = JSON.parse(row.returned_ids);
      followed = JSON.parse(row.followed_ids);
    } catch {
      return;
    }
    if (!Array.isArray(returned)) return;
    const followedList = Array.isArray(followed) ? followed as string[] : [];
    const newlyFollowed = entryIds.filter(id => returned.includes(id) && !followedList.includes(id));
    if (!newlyFollowed.length) return;

    await env.DB.prepare(`UPDATE recall_log SET followed_ids = ?, write_marker = ? WHERE id = ?`)
      .bind(JSON.stringify([...followedList, ...newlyFollowed]), memoryWriteMarker(env), row.id).run();
  } catch (e) {
    console.error("recall_log follow update failed (non-fatal):", e);
  }
}

export async function maybeMarkFollowed(env: Env, workspaceId: string, entryId: string, now: number, cfg?: Config): Promise<void> {
  return maybeMarkFollowedMany(env, workspaceId, [entryId], now, cfg);
}

/** FNV-1a, 32 bits. Not a security hash — a receipt is a citation, not a credential — so a
 * synchronous one is the right choice: it never introduces a new await into recall's own
 * timing, which would otherwise shift when its OTHER fire-and-forget writes (recall_count,
 * the log itself) actually land relative to the response (see recall-variant-arms.test.ts's
 * exact D1-write-count snapshots, which a stray extra microtask broke during development). */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Part C (05-proof.md, T-0089.5.3): the recall response's citable `receipt` when the log did
 * not keep a row for this call, either because RECALL_LOG is off or the daily cap was already
 * spent. Pure and synchronous: no env, no D1, no KV, no await — a caller on a brain that has
 * never turned the log on pays nothing beyond this one hash for every recall. `now` is
 * bucketed so the same query cited a few seconds later still hashes the same way, without
 * holding the query text itself in the receipt the way a real log row does.
 */
export function receiptHash(query: string, now: number): string {
  const bucket = Math.floor(now / RECEIPT_TIME_BUCKET_MS);
  return fnv1a(`${query}\0${bucket}`).toString(16).padStart(8, "0");
}
