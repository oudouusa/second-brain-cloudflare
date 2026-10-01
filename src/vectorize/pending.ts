import { assertMemoryWritesAllowed, memoryWriteMarker } from "../migration/write-lock";
import type { Env } from "../env";
import type { Config } from "../config";
import { CHUNK_MAX_CHARS, CHUNK_OVERLAP_CHARS, MIRRORED_SOURCES } from "../constants";
import { graceMs } from "../lib/ai";
import { MAX_CONTENT_BYTES } from "../lib/content-size";
import { storeEntry, upsertEntryVectors, discardUpload } from "../capture/store";
import { changedRows } from "../memory/trash";
import { INDEXABLE_SQL } from "../capture/lifecycle";

/**
 * Deferred rows: vector_ids = '[]' past the grace window, not deprecated. POST /vectorize-pending
 * indexes them on demand; the nightly cron indexes a few per night so none waits on a caller.
 */
export const PENDING_WHERE = `vector_ids = '[]' AND created_at < ? AND ${INDEXABLE_SQL}`;

/**
 * Nightly budget (free plan: 1,000 Cloudflare-service subrequests per invocation, 10,000 neurons a
 * day). Up to 10 rows sharing 250 embedded chunks, 100 chunks per AI call. The oldest row always gets
 * the night, all of it if it needs more than 250 chunks, so no row is ever skipped for its size. D1's
 * 2 MB row cap bounds any row to about 3,400 chunks: 34 AI calls and 4 Vectorize upserts.
 * Neurons (bge-small, about 1,840 per M input tokens): a full 250-chunk night is under 100k tokens,
 * about 185 neurons; a 128 KB note is about 40k tokens, about 75 neurons.
 */
export const VECTORIZE_PENDING_NIGHTLY_ROWS = 10;
/** Notes are capped at 128 KB; a deferred row over it can only be a legacy 3.7 note (no cap then, up to
 * D1's 2 MB, about 1,500 chunks and 1,000+ neurons in one night). The nightly pass never touches one:
 * it takes no slot and blocks nothing, and one log line a night points to the admin routes a person runs
 * on purpose (POST /vectorize-pending, POST /migration/reembed), which still index it (budget auditor R11). */
export const VECTORIZE_PENDING_NIGHTLY_MAX_BYTES = MAX_CONTENT_BYTES; // the note cap itself (src/lib/content-size.ts)
export const VECTORIZE_PENDING_NIGHTLY_EMBEDS = 250;

export interface PendingRow {
  id: string; content: string; tags: string; source: string; created_at: number; workspace_id: string; actor_id: string;
}

/** Index one deferred row under its own workspace and author (never the caller's). False when the
 * row's content or workspace changed during the embed: the upload is settled and the row stays pending. */
export async function indexPendingRow(env: Env, row: PendingRow, cfg: Readonly<Config>): Promise<boolean> {
  const stored = await storeEntry(env, row.id, row.content, JSON.parse(row.tags), row.source, row.created_at, cfg,
    { workspaceId: row.workspace_id, actorId: row.actor_id }, { expectedVectorIds: "[]", expectedTagsJson: row.tags, expectedSource: row.source, expectedCreatedAt: row.created_at, existingContent: true });
  return stored.committed !== false;
}

/** An upper bound on the chunks chunkText makes from `len` characters, worst case (a sentence break
 * just past the half-way mark each time, so each chunk advances only CHUNK_MAX_CHARS / 2 - overlap). */
function chunkBound(len: number, source: string): number {
  if (MIRRORED_SOURCES.has(source) || len <= CHUNK_MAX_CHARS) return 1;
  return 2 + Math.ceil((len - CHUNK_MAX_CHARS) / (CHUNK_MAX_CHARS / 2 - CHUNK_OVERLAP_CHARS));
}

/** Consecutive failed nights after which a row is moved behind the other deferred rows. */
export const VECTORIZE_PENDING_FAILURES_BEFORE_DEMOTION = 3;
/** KV: { [entryId]: { n: consecutive failed nights, at: last failure ms } }. Cleared for a row the night
 * it indexes; an entry whose last failure is over 30 days old is dropped, and the key itself carries
 * a 30-day TTL, so counts for rows that were forgotten or fixed some other way cannot pile up. */
const FAILURES_KV_KEY = "vectorize-pending:failures";
const FAILURES_TTL_SECONDS = 30 * 86_400;
type FailureCounts = Record<string, { n: number; at: number }>;

async function readFailures(env: Env): Promise<FailureCounts> {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse((await env.OAUTH_KV.get(FAILURES_KV_KEY)) ?? "{}") as Record<string, unknown>; } catch { raw = {}; }
  const cutoff = Date.now() - FAILURES_TTL_SECONDS * 1000;
  const out: FailureCounts = {};
  for (const [id, v] of Object.entries(raw)) {
    // A bare number is the pre-TTL shape: treat it as failing now, so it ages out on schedule.
    const entry = typeof v === "number" ? { n: v, at: Date.now() } : (v as { n?: number; at?: number });
    if (typeof entry?.n === "number" && typeof entry.at === "number" && entry.at >= cutoff) out[id] = { n: entry.n, at: entry.at };
  }
  return out;
}

/**
 * The nightly pass. Plans from lengths alone (no content read yet): the row at the head always
 * goes, then more rows in queue order while they fit the chunk budget; the first that does not fit
 * ends the night and heads the next one, so nothing behind it overtakes it. Queue order is oldest
 * first, except that a row which failed VECTORIZE_PENDING_FAILURES_BEFORE_DEMOTION nights running
 * goes behind the rest (still retried, at the back), so one bad row never blocks the others. Only
 * the chosen rows' content is read. Chunks are embedded 100 per AI call, and the vector_ids writes
 * go in ONE batch. Config and the failure counts are read only when there is work.
 */
export async function runNightlyVectorizePending(
  env: Env, cfg: Readonly<Config> | (() => Promise<Readonly<Config>>),
  opts: { maxRows?: number } = {},
): Promise<{ processed: number; failed: number }> {
  // One statement, always one row: how many deferred rows are over the cap, and the queue (rows within
  // it, demoted rows last) as a JSON array, re-sorted below so order never rests on aggregate order.
  const readQueue = async (demoted: string[]) => {
    const cutoff = Date.now() - graceMs(env);
    const row = await env.DB.prepare(
      // scope-exempt: deployment-wide maintenance; each row is indexed under its own workspace
      `SELECT (SELECT COUNT(*) FROM entries WHERE ${PENDING_WHERE} AND length(CAST(content AS BLOB)) > ?) AS oversize,
              (SELECT json_group_array(json_object('id', q.id, 'len', q.len, 'source', q.source, 'created_at', q.created_at, 'demoted', q.demoted))
                 FROM (SELECT id, length(content) AS len, source, created_at, (id IN (SELECT value FROM json_each(?))) AS demoted
                         FROM entries WHERE ${PENDING_WHERE} AND length(CAST(content AS BLOB)) <= ?
                        ORDER BY demoted ASC, created_at ASC, id LIMIT ?) q) AS queue`,
    ).bind(cutoff, VECTORIZE_PENDING_NIGHTLY_MAX_BYTES, JSON.stringify(demoted), cutoff, VECTORIZE_PENDING_NIGHTLY_MAX_BYTES, Math.max(1, Math.min(VECTORIZE_PENDING_NIGHTLY_ROWS, opts.maxRows ?? VECTORIZE_PENDING_NIGHTLY_ROWS)))
      .first<{ oversize: number; queue: string | null }>();
    type Queued = { id: string; len: number; source: string; created_at: number; demoted: number };
    let results: Queued[] = [];
    try { results = JSON.parse(row?.queue ?? "[]") as Queued[]; } catch { results = []; }
    results.sort((x, y) => x.demoted - y.demoted || x.created_at - y.created_at || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    return { oversize: row?.oversize ?? 0, results };
  };
  let { results: queue, oversize } = await readQueue([]);
  if (oversize > 0) console.warn(`vectorize-pending: skipped ${oversize} deferred row(s) over the 128 KB note cap (legacy); index them with POST /vectorize-pending or POST /migration/reembed`);
  if (!queue.length) return { processed: 0, failed: 0 };
  const failures = await readFailures(env);
  const demoted = Object.keys(failures).filter(id => failures[id].n >= VECTORIZE_PENDING_FAILURES_BEFORE_DEMOTION);
  if (demoted.length) queue = (await readQueue(demoted)).results;

  const chosen: string[] = [];
  let planned = 0;
  for (const q of queue) {
    const cost = chunkBound(q.len, q.source);
    if (chosen.length > 0 && planned + cost > VECTORIZE_PENDING_NIGHTLY_EMBEDS) break;
    chosen.push(q.id);
    planned += cost;
  }
  const config = typeof cfg === "function" ? await cfg() : cfg;
  const { results: loaded } = await env.DB.prepare(
    // scope-exempt: by-id: the rows this maintenance pass just chose, each indexed under its own workspace
    `SELECT id, content, tags, source, created_at, workspace_id, actor_id FROM entries WHERE id IN (SELECT value FROM json_each(?)) AND ${PENDING_WHERE}`,
  ).bind(JSON.stringify(chosen), Date.now() - graceMs(env)).all<PendingRow>();
  const rows = chosen.map(id => loaded.find(r => r.id === id)).filter((r): r is PendingRow => !!r);

  const failedIds: string[] = [];
  const indexedIds: string[] = [];
  for (const id of chosen) {
    if (demoted.includes(id)) console.warn(`vectorize-pending: ${id} failed ${failures[id].n} nights running; retrying it behind the other deferred rows`);
  }
  // Consecutive failures per row: +1 for a failed embed, cleared once it indexes. A lost commit (the
  // row changed mid-embed) is neither. Written back only when something changed.
  const finish = async (processed: number, failed: number) => {
    let changed = false;
    for (const id of failedIds) {
      failures[id] = { n: (failures[id]?.n ?? 0) + 1, at: Date.now() };
      changed = true;
      if (failures[id].n === VECTORIZE_PENDING_FAILURES_BEFORE_DEMOTION) console.warn(`vectorize-pending: ${id} failed ${failures[id].n} nights running; moving it behind the other deferred rows`);
    }
    for (const id of indexedIds) if (id in failures) { delete failures[id]; changed = true; }
    if (changed) {
      try { await env.OAUTH_KV.put(FAILURES_KV_KEY, JSON.stringify(failures), { expirationTtl: FAILURES_TTL_SECONDS }); } catch (e) { console.error("Saving vectorize-pending failure counts failed (non-fatal):", e); }
    }
    return { processed, failed };
  };

  let failed = 0;
  let processed = 0;
  for (const row of rows) {
    try {
      if (await indexPendingRow(env, row, config)) { processed++; indexedIds.push(row.id); }
    } catch (e) {
      console.error("Nightly re-embed failed for entry", row.id, e);
      failedIds.push(row.id);
      failed++;
    }
  }
  return finish(processed, failed);
}
