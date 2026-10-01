/**
 * Re-embedding every entry after an embedding-model change.
 *
 * Switching models changes the vector dimensions, and a Vectorize index fixes
 * its dimensions at creation. So a model change means a new index, a redeploy
 * pointing the binding at it, and every entry re-embedded into it. The desktop
 * app drives that; this module is the part that runs inside the Worker.
 *
 * # D1 is never written destructively
 *
 * `entries.content` is the source of truth and migration only reads it. Vectors
 * are derived data. The worst outcome here is a rebuild that has to be re-run,
 * never a lost memory.
 *
 * # Why this keeps its own ledger
 *
 * The obvious progress marker is `entries.vector_ids`, the way
 * `POST /vectorize-pending` uses it — select the rows that still read `'[]'`.
 * That does not work here, and the reason is worth stating because it is not
 * obvious: an old non-empty vector-id list says only that *some* index was written.
 * Per-write IDs deliberately change to make concurrent cleanup safe, but that still
 * cannot prove the live binding holds the current profile or that this migration
 * reached the entry. A separate cursor remains the only trustworthy rebuild ledger.
 *
 * An entry the migration never reached therefore reads as "vectorized" in D1
 * while the live index holds nothing for it. `/vectorize-pending` cannot see it,
 * `/stats.unvectorized` reports zero, and the dashboard's repair prompt stays
 * hidden. So this ledger in KV is not merely a convenience for resuming — it is
 * the only record of what has actually been rebuilt.
 *
 * # Why it stops rather than pushing on
 *
 * Embedding is the one operation with a daily budget. If that budget runs out
 * part-way, every remaining entry fails for the same reason, and a loop that
 * kept going would burn the rest of the run producing identical errors while
 * reporting hundreds of distinct "failures". So a batch that achieves nothing
 * stops the run and keeps its cursor. The user is told to resume later, and
 * resuming costs nothing already paid for.
 */
import type { Env } from "../env";
import { DEFAULTS, type Config } from "../config";
import { storeEntry } from "../capture/store";
import { drainPendingVectorCleanup } from "../vectorize/cleanup";
import { INDEXABLE_SQL } from "../capture/lifecycle";
import { chunkText } from "../text/chunk";
import {
  MIGRATION_CHUNK_BUDGET,
  MIGRATION_MAX_ENTRIES_PER_BATCH,
} from "../constants";
import { assertEmbeddingConfig } from "../embedding/profile";
import {
  DERIVED_STATE_GENERATION_ID as MIGRATION_GENERATION_ID,
  markMemoryWriteLockComplete,
  readDerivedStateGeneration,
  renewFinalDeltaLease,
} from "./write-lock";

/**
 * Prefixed to coexist with workers-oauth-provider's `token:`/`grant:`/`client:`
 * keys, matching `config:overrides` and `integrations:<provider>`. Singular
 * because only one migration is ever in flight.
 */
export const MIGRATION_KEY = "migration:embedding";

/**
 * Where the rebuild has got to.
 *
 * The cursor is `(created_at, id)` rather than an offset. Capture stays live
 * during a migration — the nightly cron writes — so an offset would skip or
 * repeat rows as the table grows underneath it. A keyset cursor cannot.
 */
export interface MigrationState {
  /** Strong D1 reset generation; stale cross-colo KV cursors cannot cross it. */
  generation: string;
  /** The model being migrated *to*, recorded so a resumed run can detect that
   *  the target changed underneath it. */
  model: string;
  dimensions: number;
  promptVersion: number;
  profileId: string;
  startedAt: number;
  /** Last entry successfully processed; null before the first batch. */
  cursorCreatedAt: number | null;
  cursorId: string | null;
  processed: number;
  failed: number;
  /** Entry count when the run started, for progress display only. `remaining`
   *  is always recomputed, because the table changes under us. */
  totalAtStart: number;
  finishedAt?: number;
  /** Cursor for rows changed after the full scan began. This is a separate
   *  keyset because an update moves by updated_at, not by created_at. */
  deltaCursorUpdatedAt: number | null;
  deltaCursorId: string | null;
  deltaProcessed: number;
  deltaFailed: number;
  deltaStartedAt?: number;
  deltaFinishedAt?: number;
  /** D1 lock generation that owns a final delta cursor; stale pre-lock KV lacks it. */
  deltaLockOwner?: string;
}

export interface BatchResult {
  processed: number;
  failed: number;
  /** Recomputed every batch — callers loop until it reaches 0, the convention
   *  `/vectorize-pending` and the integration syncs already use. */
  remaining: number;
  total: number;
  done: boolean;
  /**
   * The batch achieved nothing and the run has stopped with its cursor kept.
   * Almost always the daily embedding budget; possibly a model name the account
   * cannot serve. Either way, pushing on would only repeat the failure.
   */
  stalled: boolean;
  /** Set when `stalled`, for the message the user sees. Never a raw error. */
  stalledReason?: string;
}

export class MigrationPhaseError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "MigrationPhaseError";
  }
}

/**
 * Deprecated entries are excluded. Their vectors are deliberately deleted by
 * `deprecateEntry` and recall filters them out at hydration, so re-embedding
 * them would spend the scarce resource of the whole operation on rebuilding
 * something nothing reads.
 *
 * This was the only path that knew it. `/vectorize-pending` and the two
 * "not searchable" counts did not, so a dismissed pattern was reported as
 * broken and repaired back into the index.
 */
const NOT_DEPRECATED = INDEXABLE_SQL;

export async function readMigration(env: Env): Promise<MigrationState | null> {
  try {
    const generation = await readDerivedStateGeneration(env);
    const raw = await env.OAUTH_KV.get(MIGRATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MigrationState;
    // A blob written by an older shape, or hand-edited: treat as absent rather
    // than trusting a cursor we cannot read. Restarting costs neurons; resuming
    // from a bad cursor could skip entries silently, which is worse.
    if (typeof parsed?.model !== "string"
      || typeof parsed?.dimensions !== "number"
      || typeof parsed?.promptVersion !== "number"
      || typeof parsed?.profileId !== "string"
      || parsed.generation !== generation) return null;
    return {
      ...parsed,
      // Ledgers written before the differential pass existed remain resumable.
      deltaCursorUpdatedAt:
        typeof parsed.deltaCursorUpdatedAt === "number" ? parsed.deltaCursorUpdatedAt : null,
      deltaCursorId: typeof parsed.deltaCursorId === "string" ? parsed.deltaCursorId : null,
      deltaProcessed: typeof parsed.deltaProcessed === "number" ? parsed.deltaProcessed : 0,
      deltaFailed: typeof parsed.deltaFailed === "number" ? parsed.deltaFailed : 0,
    };
  } catch {
    return null;
  }
}
async function writeMigration(env: Env, state: MigrationState): Promise<void> {
  await env.OAUTH_KV.put(MIGRATION_KEY, JSON.stringify(state));
}

export async function clearMigration(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO embedding_migration_generation (id, generation) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET generation = excluded.generation`,
  ).bind(MIGRATION_GENERATION_ID, crypto.randomUUID()).run();
  await env.OAUTH_KV.delete(MIGRATION_KEY);
}

/** Entries that would be re-embedded, and the vectors they would produce. */
export async function estimate(
  env: Env,
): Promise<{ entries: number; chunks: number }> {
  const row = (await env.DB.prepare(
    // scope-exempt: one-time re-embed migration: admin-triggered, deployment-wide, returns counts only
    `SELECT COUNT(*) AS entries,
            COALESCE(SUM(MAX(1, (LENGTH(content) + ${
              CHUNK_STRIDE - 1
            }) / ${CHUNK_STRIDE})), 0) AS chunks
       FROM entries
      WHERE ${NOT_DEPRECATED}`,
  ).first()) as Record<string, number> | null;

  return {
    entries: Number(row?.entries ?? 0),
    chunks: Number(row?.chunks ?? 0),
  };
}

/**
 * How far `chunkText` advances per chunk: `CHUNK_MAX_CHARS - CHUNK_OVERLAP_CHARS`.
 *
 * Kept here as the one place the estimate's arithmetic is tied to the chunker,
 * and asserted against the real `chunkText` in the tests so the two cannot
 * drift. The projection is a lower bound: sentence-boundary snapping can only
 * shorten a chunk, never lengthen it, so the real count is sometimes higher.
 */
const CHUNK_STRIDE = 1400;

/** Rows after the cursor, oldest first. */
function pageSql(hasCursor: boolean): string {
  // Plain `?` placeholders, bound positionally, matching every other query in
  // this codebase — the created_at value is bound twice rather than reused as
  // ?1, because that is the style D1 is driven with here and the style the
  // SQLite-backed tests can exercise.
  const after = hasCursor
    ? `AND (created_at > ? OR (created_at = ? AND id > ?))`
    : "";
  // scope-exempt: embedding migration is an owner-admin deployment-wide repair and each selected row carries its stored workspace/actor write context
  return `SELECT id, content, tags, source, created_at, vector_ids, workspace_id, actor_id
            FROM entries
           WHERE ${NOT_DEPRECATED} ${after}
           ORDER BY created_at ASC, id ASC
           LIMIT ${MIGRATION_MAX_ENTRIES_PER_BATCH}`;
}

async function countRemaining(
  env: Env,
  cursorCreatedAt: number | null,
  cursorId: string | null,
): Promise<number> {
  const sql =
    cursorCreatedAt === null
      // scope-exempt: one-time re-embed migration: count only
      ? `SELECT COUNT(*) AS count FROM entries WHERE ${NOT_DEPRECATED}`
      // scope-exempt: one-time re-embed migration: count only
      : `SELECT COUNT(*) AS count FROM entries WHERE ${NOT_DEPRECATED}
           AND (created_at > ? OR (created_at = ? AND id > ?))`;
  const stmt =
    cursorCreatedAt === null
      ? env.DB.prepare(sql)
      : env.DB.prepare(sql).bind(cursorCreatedAt, cursorCreatedAt, cursorId);
  const row = (await stmt.first()) as Record<string, number> | null;
  return Number(row?.count ?? 0);
}

/**
 * Best-effort recognition of "the budget ran out" versus "this one entry went
 * wrong".
 *
 * Deliberately not load-bearing. Cloudflare's error text is not a contract, so
 * the guarantee that actually protects the run is the no-progress stop in
 * [`runBatch`] — a batch that processed nothing halts whatever the message said.
 * This only sharpens what the user is told.
 */
export function looksLikeBudgetError(e: unknown): boolean {
  const text = String((e as Error)?.message ?? e).toLowerCase();
  return (
    text.includes("4006") ||
    text.includes("quota") ||
    text.includes("capacity") ||
    text.includes("rate limit") ||
    text.includes("too many requests")
  );
}

/**
 * Re-embeds one batch and advances the cursor.
 *
 * Calls `storeEntry` directly rather than going through `captureEntry`, which
 * would run dedupe (every entry matches itself at ~1.0 and would be blocked or
 * merged), classification, contradiction handling and edge inference — all of
 * which cost more model calls and have side effects that are wrong to re-run
 * over an entire brain.
 *
 * It passes each row's real `created_at` rather than now. `reembedOrThrow` looks
 * like the natural helper but hardcodes `Date.now()`, which would rewrite every
 * vector's `created_at` metadata to migration time — and recall's keyword fusion
 * reads that metadata.
 *
 * The row's previous IDs are retired through the durable cleanup outbox. On the
 * first pass they usually belong only to the abandoned index (and deletion is a
 * harmless no-op); on a retry they can belong to this live target, so omitting
 * cleanup would leak every interrupted random-ID attempt permanently.
 */
export async function runBatch(
  env: Env,
  config: Readonly<Config> = DEFAULTS,
): Promise<BatchResult> {
  const profile = assertEmbeddingConfig(config);
  const existing = await readMigration(env);

  // A target change mid-run invalidates the cursor: entries before it hold
  // vectors from the previous target. Start again rather than finish a rebuild
  // that would be half one model and half another.
  const state: MigrationState =
    existing
      && existing.model === profile.model
      && existing.dimensions === profile.dimensions
      && existing.promptVersion === profile.promptVersion
      && existing.profileId === profile.profileId
      ? existing
      : {
          generation: await readDerivedStateGeneration(env),
          model: profile.model,
          dimensions: profile.dimensions,
          promptVersion: profile.promptVersion,
          profileId: profile.profileId,
          startedAt: Date.now(),
          cursorCreatedAt: null,
          cursorId: null,
          processed: 0,
          failed: 0,
          totalAtStart: await countRemaining(env, null, null),
          deltaCursorUpdatedAt: null,
          deltaCursorId: null,
          deltaProcessed: 0,
          deltaFailed: 0,
        };

  // A previous request may have written private metadata and then lost its D1
  // source row. Do not advance — especially to done — until the durable outbox
  // confirms every such Vectorize deletion.
  await drainPendingVectorCleanup(env);

  const page = state.cursorCreatedAt === null
    ? await env.DB.prepare(pageSql(false)).all()
    : await env.DB.prepare(pageSql(true))
        .bind(state.cursorCreatedAt, state.cursorCreatedAt, state.cursorId)
        .all();

  const rows = (page.results ?? []) as Record<string, unknown>[];
  if (rows.length === 0) {
    const finished: MigrationState = { ...state, finishedAt: Date.now() };
    await writeMigration(env, finished);
    return {
      processed: 0,
      failed: 0,
      remaining: 0,
      total: state.totalAtStart,
      done: true,
      stalled: false,
    };
  }

  let processed = 0;
  let failed = 0;
  let chunkBudget = MIGRATION_CHUNK_BUDGET;
  let lastReached: { created_at: number; id: string } | null = null;
  let stalledReason: string | undefined;

  for (const row of rows) {
    const content = row.content as string;
    const cost = chunkText(content).length;
    // Always take the first entry even if it alone exceeds the budget, or a
    // single very long memory would stall the run forever.
    if (chunkBudget !== MIGRATION_CHUNK_BUDGET && cost > chunkBudget) break;
    chunkBudget -= cost;

    try {
      // Cron path, no request identity: the context comes from the row being
      // repaired, not the caller, so a re-embed can never relocate an entry
      // between workspaces.
      const stored = await storeEntry(
        env,
        row.id as string,
        content,
        JSON.parse((row.tags as string) ?? "[]"),
        row.source as string,
        row.created_at as number,
        config,
        {
          workspaceId: String(row.workspace_id ?? ""),
          actorId: String(row.actor_id ?? ""),
        },
        {
          expectedContent: content,
          expectedTagsJson: (row.tags as string) ?? "[]",
          expectedSource: row.source as string,
          expectedCreatedAt: row.created_at as number,
          expectedVectorIdsJson: (row.vector_ids as string) ?? "[]",
          oldVectorIds: JSON.parse((row.vector_ids as string) ?? "[]") as string[],
        },
      );
      // Lost the compare-and-set (content edited, or the row shared or moved during the embed): the
      // upload is settled, and the cursor stays in front of this row so the next batch retries it.
      if (stored.committed === false) { failed++; break; }
      processed++;
      // Only advance past entries that actually succeeded. A failed entry stays
      // in front of the cursor so a later run retries it.
      lastReached = { created_at: row.created_at as number, id: row.id as string };
    } catch (e) {
      failed++;
      console.error("Migration re-embed failed for entry", row.id, e);
      if (looksLikeBudgetError(e)) {
        stalledReason = "budget";
        break;
      }
      // A single bad entry must not advance the cursor past itself, but it also
      // must not block the rest of the batch — so stop advancing and keep going
      // only while something is still succeeding.
      break;
    }

    if (chunkBudget <= 0) break;
  }

  const next: MigrationState = {
    ...state,
    cursorCreatedAt: lastReached?.created_at ?? state.cursorCreatedAt,
    cursorId: lastReached?.id ?? state.cursorId,
    processed: state.processed + processed,
    failed: state.failed + failed,
  };

  const remaining = await countRemaining(
    env,
    next.cursorCreatedAt,
    next.cursorId,
  );

  // Nothing moved. Keep the cursor, stop the run, and let the caller say so —
  // continuing would repeat one failure for every entry left.
  const stalled = processed === 0 && failed > 0;
  const done = remaining === 0 && !stalled;

  await writeMigration(
    env,
    done ? { ...next, finishedAt: Date.now() } : next,
  );

  return {
    processed,
    failed,
    remaining,
    total: Math.max(next.totalAtStart, next.processed + remaining),
    done,
    stalled,
    ...(stalled ? { stalledReason: stalledReason ?? "failing" } : {}),
  };
}

const EFFECTIVE_UPDATED_AT = `COALESCE(updated_at, created_at)`;

function deltaPageSql(hasCursor: boolean): string {
  const after = hasCursor
    ? `AND (${EFFECTIVE_UPDATED_AT} > ? OR (${EFFECTIVE_UPDATED_AT} = ? AND id > ?))`
    : "";
  // scope-exempt: the locked final-delta migration is deployment-wide and each selected row carries its stored workspace/actor write context
  return `SELECT id, content, tags, source, created_at, vector_ids, workspace_id, actor_id,
                 ${EFFECTIVE_UPDATED_AT} AS migration_updated_at
            FROM entries
           WHERE ${NOT_DEPRECATED}
             AND (${EFFECTIVE_UPDATED_AT} >= ? OR vector_ids = '[]')
             ${after}
           ORDER BY ${EFFECTIVE_UPDATED_AT} ASC, id ASC
           LIMIT ${MIGRATION_MAX_ENTRIES_PER_BATCH}`;
}

async function countDeltaRemaining(
  env: Env,
  startedAt: number,
  cursorUpdatedAt: number | null,
  cursorId: string | null,
): Promise<number> {
  const after = cursorUpdatedAt === null
    ? ""
    : `AND (${EFFECTIVE_UPDATED_AT} > ? OR (${EFFECTIVE_UPDATED_AT} = ? AND id > ?))`;
  const stmt = env.DB.prepare(
    // scope-exempt: this is an owner-admin deployment-wide migration progress count under the migration write lock
    `SELECT COUNT(*) AS count FROM entries
      WHERE ${NOT_DEPRECATED}
        AND (${EFFECTIVE_UPDATED_AT} >= ? OR vector_ids = '[]') ${after}`,
  );
  const bound = cursorUpdatedAt === null
    ? stmt.bind(startedAt)
    : stmt.bind(startedAt, cursorUpdatedAt, cursorUpdatedAt, cursorId);
  const row = await bound.first() as Record<string, number> | null;
  return Number(row?.count ?? 0);
}

/**
 * Re-embed rows captured or edited since the full scan began.
 *
 * `restart` deliberately discards only the delta cursor. The cutover sequence
 * runs an unlocked pass, enables the D1-backed write lock, then restarts this
 * pass once more. Repeating it is safe because Vectorize upsert ids are stable.
 */
export async function runDeltaBatch(
  env: Env,
  config: Readonly<Config> = DEFAULTS,
  options: { restart?: boolean; lockOwner?: string; deltaToken?: string } = {},
): Promise<BatchResult> {
  const profile = assertEmbeddingConfig(config);
  const existing = await readMigration(env);
  if (!existing?.finishedAt) {
    throw new MigrationPhaseError("Complete the full re-embedding pass before the differential pass");
  }
  if (
    existing.model !== profile.model
    || existing.dimensions !== profile.dimensions
    || existing.promptVersion !== profile.promptVersion
    || existing.profileId !== profile.profileId
  ) {
    throw new MigrationPhaseError("Embedding profile changed; restart the full migration");
  }

  const lockGenerationChanged = Boolean(
    options.lockOwner && existing.deltaLockOwner !== options.lockOwner,
  );
  const state: MigrationState = options.restart || lockGenerationChanged
    ? {
        ...existing,
        deltaCursorUpdatedAt: null,
        deltaCursorId: null,
        deltaProcessed: 0,
        deltaFailed: 0,
        deltaStartedAt: Date.now(),
        deltaFinishedAt: undefined,
        ...(options.lockOwner ? { deltaLockOwner: options.lockOwner } : {}),
      }
    : {
        ...existing,
        deltaStartedAt: existing.deltaStartedAt ?? Date.now(),
        ...(options.lockOwner ? { deltaLockOwner: options.lockOwner } : {}),
      };

  // Acquiring the strong final-delta lock waited for every admitted ordinary write.
  // Any still-active journal now belongs to an interrupted request and can be forced
  // through before this pass is allowed to declare cutover complete.
  const cleanupMarker = options.lockOwner && options.deltaToken
    ? `${options.lockOwner}:${options.deltaToken}:${crypto.randomUUID()}`
    : undefined;
  await drainPendingVectorCleanup(env, {
    forceActive: Boolean(options.lockOwner),
    privilegedMarker: cleanupMarker,
    beforeRemote: options.lockOwner && options.deltaToken
      ? () => renewFinalDeltaLease(env, options.lockOwner!, options.deltaToken!)
      : undefined,
  });
  // Claim races and the ten-row drain page both make a count-derived answer
  // ambiguous. Under the final lock, prove the durable outbox is actually empty.
  const cleanupRemaining = options.lockOwner
    ? await env.DB.prepare(`SELECT 1 AS pending FROM vector_cleanup_ops LIMIT 1`).first<{ pending: number }>()
    : null;
  if (cleanupRemaining) {
    throw new MigrationPhaseError("Vector cleanup is still draining; retry the final delta");
  }

  const page = state.deltaCursorUpdatedAt === null
    ? await env.DB.prepare(deltaPageSql(false)).bind(state.startedAt).all()
    : await env.DB.prepare(deltaPageSql(true))
        .bind(
          state.startedAt,
          state.deltaCursorUpdatedAt,
          state.deltaCursorUpdatedAt,
          state.deltaCursorId,
        )
        .all();
  const rows = (page.results ?? []) as Record<string, unknown>[];

  if (rows.length === 0) {
    if (options.lockOwner && options.deltaToken) {
      await markMemoryWriteLockComplete(env, options.lockOwner, options.deltaToken);
    }
    await writeMigration(env, { ...state, deltaFinishedAt: Date.now() });
    return {
      processed: 0,
      failed: 0,
      remaining: 0,
      total: state.deltaProcessed,
      done: true,
      stalled: false,
    };
  }

  let processed = 0;
  let failed = 0;
  let chunkBudget = MIGRATION_CHUNK_BUDGET;
  let lastReached: { effectiveUpdatedAt: number; id: string } | null = null;
  let stalledReason: string | undefined;

  for (const row of rows) {
    const content = row.content as string;
    const cost = chunkText(content).length;
    if (chunkBudget !== MIGRATION_CHUNK_BUDGET && cost > chunkBudget) break;
    chunkBudget -= cost;

    try {
      await storeEntry(
        env,
        row.id as string,
        content,
        JSON.parse((row.tags as string) ?? "[]"),
        row.source as string,
        row.created_at as number,
        config,
        {
          workspaceId: String(row.workspace_id ?? ""),
          actorId: String(row.actor_id ?? ""),
        },
        options.lockOwner && options.deltaToken
          ? {
              expectedContent: content,
              expectedTagsJson: (row.tags as string) ?? "[]",
              expectedSource: row.source as string,
              expectedCreatedAt: row.created_at as number,
              expectedVectorIdsJson: (row.vector_ids as string) ?? "[]",
              oldVectorIds: JSON.parse((row.vector_ids as string) ?? "[]") as string[],
              lease: {
                ownerId: options.lockOwner,
                deltaToken: options.deltaToken,
                beforeVectorWrite: () => renewFinalDeltaLease(env, options.lockOwner!, options.deltaToken!),
              },
            }
          : {
              expectedContent: content,
              expectedTagsJson: (row.tags as string) ?? "[]",
              expectedSource: row.source as string,
              expectedCreatedAt: row.created_at as number,
              expectedVectorIdsJson: (row.vector_ids as string) ?? "[]",
              oldVectorIds: JSON.parse((row.vector_ids as string) ?? "[]") as string[],
            },
      );
      processed++;
      lastReached = {
        effectiveUpdatedAt: Number(row.migration_updated_at),
        id: row.id as string,
      };
    } catch (e) {
      failed++;
      console.error("Migration delta re-embed failed for entry", row.id, e);
      if (looksLikeBudgetError(e)) stalledReason = "budget";
      break;
    }
    if (chunkBudget <= 0) break;
  }

  const next: MigrationState = {
    ...state,
    deltaCursorUpdatedAt: lastReached?.effectiveUpdatedAt ?? state.deltaCursorUpdatedAt,
    deltaCursorId: lastReached?.id ?? state.deltaCursorId,
    deltaProcessed: state.deltaProcessed + processed,
    deltaFailed: state.deltaFailed + failed,
  };
  const remaining = await countDeltaRemaining(
    env,
    next.startedAt,
    next.deltaCursorUpdatedAt,
    next.deltaCursorId,
  );
  const stalled = processed === 0 && failed > 0;
  const done = remaining === 0 && !stalled;
  if (done && options.lockOwner && options.deltaToken) {
    await markMemoryWriteLockComplete(env, options.lockOwner, options.deltaToken);
  }
  await writeMigration(env, done ? { ...next, deltaFinishedAt: Date.now() } : next);

  return {
    processed,
    failed,
    remaining,
    total: next.deltaProcessed + remaining,
    done,
    stalled,
    ...(stalled ? { stalledReason: stalledReason ?? "failing" } : {}),
  };
}
