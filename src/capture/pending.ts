import { hasCapsuleTag } from "../tags/system";
import type { Env } from "../env";
import { chatGptEnvForWorkspaces } from "../lib/chatgpt";
import { resolveConfig, type Config } from "../config";
import { INDEXABLE_SQL } from "./lifecycle";
import { indexPendingAppendPassage, storeEntry } from "./store";
import { classifyEntry } from "./classify";
import { graceMs, observeWorkersAiSuccess, WorkersAiQuotaError } from "../lib/ai";
import { getStatus, withStatus } from "../memory/status";
import { withKind } from "../memory/kind";
import { memoryWriteMarker } from "../migration/write-lock";
import { memoryRolloverAdvice } from "../memory/rollover-policy";
import type { Volatility } from "../memory/volatility";
import type { AppendEntryOptions, AppendEntryResult } from "./store";

export interface PendingAppendPassage {
  id: string;
  content: string;
  createdAt: number;
  operationId?: string;
}

/** Malformed derived state must never make the authoritative entry unreadable. */
export function parsePendingAppendPassages(raw: unknown): PendingAppendPassage[] {
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is PendingAppendPassage =>
      value !== null
      && typeof value === "object"
      && typeof value.id === "string"
      && typeof value.content === "string"
      && typeof value.createdAt === "number"
      && (value.operationId === undefined || typeof value.operationId === "string"));
  } catch {
    return [];
  }
}

export function appendPendingPassage(
  raw: unknown,
  addition: string,
  createdAt: number,
  operationId?: string,
): PendingAppendPassage[] {
  const queued = parsePendingAppendPassages(raw);
  if (!queued.length) {
    return [{ id: crypto.randomUUID(), content: addition, createdAt, ...(operationId ? { operationId } : {}) }];
  }
  // One coalesced item bounds both D1 JSON growth and the number of Vectorize
  // records after a long quota window. The full entry's existing 12k limit also
  // bounds this passage, which is only a subset of that authoritative content.
  return [{
    id: queued[0].id,
    content: [...queued.map(item => item.content), addition].join("\n\n"),
    createdAt: queued[0].createdAt,
    ...(operationId ? { operationId } : {}),
  }];
}

interface AppendReceipt {
  entry_id: string;
  request_hash: string;
  indexed: number;
}

export class AppendOperationConflictError extends Error {
  constructor() {
    super("operation_id was already used for a different append");
    this.name = "AppendOperationConflictError";
  }
}

export async function appendRequestHash(addition: string, volatility?: Volatility, when?: AppendEntryOptions["when"]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ addition, volatility: volatility ?? null, ...(when ? { when } : {}) }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
}

export async function readAppendReceipt(env: Env, operationId: string): Promise<AppendReceipt | null> {
  return env.DB.prepare(
    `SELECT entry_id, request_hash, indexed FROM append_receipts WHERE operation_id = ?`,
  ).bind(operationId).first<AppendReceipt>();
}

export function replayedAppend(
  receipt: AppendReceipt | null,
  entryId: string,
  requestHash: string,
  contentChars: number,
): AppendEntryResult | null {
  if (!receipt) return null;
  if (receipt.entry_id !== entryId || receipt.request_hash !== requestHash) {
    throw new AppendOperationConflictError();
  }
  return {
    indexed: receipt.indexed === 1,
    replayed: true,
    rollover: memoryRolloverAdvice(contentChars),
  };
}

const UNCLASSIFIED_WHERE = `tags NOT LIKE '%"status:%' AND tags NOT LIKE '%"kind:%'`;

export const HTTP_VECTORIZE_PENDING_BATCH = 8;
export const HTTP_CLASSIFY_PENDING_BATCH = 25;

// Scheduled recovery intentionally spends less than the manual buttons. Three
// entries leave room for storeEntry's cleanup journal, D1 admission fence,
// Workers AI, and Vectorize calls inside the Free-plan invocation budget.
export const SCHEDULED_VECTORIZE_PENDING_BATCH = 3;
// Classification is allowed only once per day (see the slot policy below), so
// twelve calls is both useful and bounded instead of consuming the fresh daily
// allocation on an unbounded legacy backlog.
export const SCHEDULED_CLASSIFY_PENDING_BATCH = 12;

export type PendingWorkKind = "vectorize" | "classify";

export interface PendingBatchResult {
  processed: number;
  failed: number;
  remaining: number;
  quotaRetryAt?: number;
  retryAfterMs?: number;
}

interface PendingBatchOptions {
  limit?: number;
  now?: number;
  config?: Readonly<Config>;
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

async function remainingVectorCount(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    // scope-exempt: this is a deployment-wide maintenance count used only by the owner-admin/manual and scheduled repair loop
    // validity: any: 期限に関係なく派生索引・初期分類を修復する。INDEXABLE_SQLの保留除外を保持する。
    `SELECT COUNT(*) as count FROM entries
      WHERE (
        vector_ids = '[]'
        OR (vector_ids <> '[]' AND json_valid(pending_append_passages)
          AND json_array_length(pending_append_passages) > 0)
      ) AND ${INDEXABLE_SQL}`,
  ).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function remainingClassificationCount(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    // scope-exempt: this is a deployment-wide maintenance count used only by the owner-admin/manual and scheduled repair loop
    // validity: any: 期限に関係なく派生索引・初期分類を修復する。INDEXABLE_SQLの保留除外を保持する。
    `SELECT COUNT(*) as count FROM entries WHERE ${UNCLASSIFIED_WHERE}`,
  ).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function processPendingVectorization(
  env: Env,
  options: PendingBatchOptions = {},
): Promise<PendingBatchResult> {
  const now = options.now ?? Date.now();
  const graceCutoff = now - graceMs(env);
  const limit = boundedLimit(options.limit, HTTP_VECTORIZE_PENDING_BATCH, HTTP_VECTORIZE_PENDING_BATCH);
  const { results } = await env.DB.prepare(
    // scope-exempt: bounded pending-vector repair is deployment maintenance and carries each row's stored workspace/actor context into storeEntry
    // validity: any: 期限に関係なく派生索引・初期分類を修復する。INDEXABLE_SQLの保留除外を保持する。
    `SELECT id, content, tags, source, created_at, vector_ids,
            workspace_id, actor_id, pending_append_passages
       FROM entries
      WHERE (
        (vector_ids = '[]' AND created_at < ?)
        OR (vector_ids <> '[]' AND json_valid(pending_append_passages)
          AND json_array_length(pending_append_passages) > 0)
      ) AND ${INDEXABLE_SQL}
      ORDER BY CASE WHEN vector_ids = '[]' THEN 0 ELSE 1 END, created_at ASC
      LIMIT ${limit}`,
  ).bind(graceCutoff).all<{
    id: string;
    content: string;
    tags: string;
    source: string;
    created_at: number;
    vector_ids: string;
    workspace_id: string;
    actor_id: string;
    pending_append_passages: string;
  }>();

  if (!results.length) {
    const remaining = await remainingVectorCount(env);
    return { processed: 0, failed: 0, remaining,
      ...(remaining ? { retryAfterMs: Math.max(1, graceMs(env)) } : {}) };
  }

  // Do not gate recovery on the passive KV marker. It can lag the provider or
  // survive a successful request, so each bounded repair batch performs a real
  // probe. A genuine quota error still stops the loop after its first failure.
  const cfg = options.config ?? await resolveConfig(env);
  let processed = 0;
  let failed = 0;
  let quotaRetryAt: number | undefined;
  let latestSuccessfulAttemptStartedAt: number | undefined;

  for (const row of results) {
    const attemptStartedAt = Date.now();
    try {
      if (row.vector_ids === "[]") {
        const stored = await storeEntry(
          env,
          row.id,
          row.content,
          JSON.parse(row.tags) as string[],
          row.source,
          row.created_at,
          cfg,
          { workspaceId: row.workspace_id, actorId: row.actor_id },
          { expectedVectorIds: "[]", expectedTagsJson: row.tags, expectedSource: row.source, expectedCreatedAt: row.created_at, existingContent: true },
        );
        if (stored.committed === false) { failed++; continue; }
        processed++;
        latestSuccessfulAttemptStartedAt = attemptStartedAt;
      } else {
        const result = await indexPendingAppendPassage(env, row.id, cfg);
        if (result === "indexed") {
          processed++;
          latestSuccessfulAttemptStartedAt = attemptStartedAt;
        } else {
          failed++;
        }
      }
    } catch (error) {
      if (error instanceof WorkersAiQuotaError) {
        failed++;
        quotaRetryAt = error.retryAt;
        break;
      }
      console.error("Re-embed failed for pending entry", error);
      failed++;
    }
  }

  if (latestSuccessfulAttemptStartedAt !== undefined) {
    await observeWorkersAiSuccess(env, latestSuccessfulAttemptStartedAt);
  }

  return {
    processed,
    failed,
    remaining: await remainingVectorCount(env),
    ...(quotaRetryAt ? { quotaRetryAt } : {}),
  };
}

export async function processPendingClassification(
  env: Env,
  options: PendingBatchOptions = {},
): Promise<PendingBatchResult> {
  const now = options.now ?? Date.now();
  const limit = boundedLimit(options.limit, HTTP_CLASSIFY_PENDING_BATCH, HTTP_CLASSIFY_PENDING_BATCH);
  const { results } = await env.DB.prepare(
    // scope-exempt: bounded classification repair is a scheduled/owner-admin deployment maintenance pass, not a caller-visible read
    // validity: any: 期限に関係なく派生索引・初期分類を修復する。INDEXABLE_SQLの保留除外を保持する。
    `SELECT id, content, tags, workspace_id FROM entries
     WHERE ${UNCLASSIFIED_WHERE}
     ORDER BY created_at ASC LIMIT ${limit}`,
  ).all<{ id: string; content: string; tags: string; workspace_id: string }>();

  if (!results.length) return { processed: 0, failed: 0, remaining: 0 };

  // See vector recovery above: the bounded provider call is the source of
  // truth, while the passive marker remains useful to ordinary recall paths.
  const cfg = options.config ?? await resolveConfig(env);
  let processed = 0;
  let failed = 0;
  let quotaRetryAt: number | undefined;
  let latestSuccessfulAttemptStartedAt: number | undefined;

  for (const row of results) {
    const attemptStartedAt = Date.now();
    try {
      const classification = await classifyEntry(row.content, chatGptEnvForWorkspaces(env, [row.workspace_id]), cfg, () => {
        latestSuccessfulAttemptStartedAt = attemptStartedAt;
      });
      if (classification.quotaRetryAt) {
        failed++;
        quotaRetryAt = classification.quotaRetryAt;
        break;
      }
      if (classification.deferred) {
        failed++;
        break;
      }
      let tags = JSON.parse(row.tags) as string[];
      if (classification.kind) tags = withKind(tags, classification.kind);
      if (classification.canonical && getStatus(tags) === null && !hasCapsuleTag(tags)) tags = withStatus(tags, "canonical");
      const result = await env.DB.prepare(
        // versioning: exempt: 再試行する初期分類のhygiene
        `UPDATE entries SET tags = ?, updated_at = ?, write_marker = ? WHERE id = ? AND tags = ?`,
      ).bind(JSON.stringify(tags), now, memoryWriteMarker(env), row.id, row.tags).run();
      const meta = result.meta as D1Result["meta"] & { rows_written?: number };
      if (Number(meta.changes ?? meta.rows_written ?? 0) > 0) processed++;
      else failed++;
    } catch (error) {
      console.error("Classification backfill failed for pending entry", error);
      failed++;
    }
  }

  if (latestSuccessfulAttemptStartedAt !== undefined) {
    await observeWorkersAiSuccess(env, latestSuccessfulAttemptStartedAt);
  }

  return {
    processed,
    failed,
    remaining: await remainingClassificationCount(env),
    ...(quotaRetryAt ? { quotaRetryAt } : {}),
  };
}

/** One cheap D1 probe used only in scheduled recovery slots. */
export async function pendingAiWorkKind(env: Env, now = Date.now()): Promise<PendingWorkKind | null> {
  const row = await env.DB.prepare(
    // scope-exempt: the shared cron scheduler needs one deployment-wide probe to choose which bounded maintenance queue runs in this slot
    // validity: any: 期限に関係なく派生索引・初期分類を修復する。INDEXABLE_SQLの保留除外を保持する。
    `SELECT CASE
       WHEN EXISTS (
         SELECT 1 FROM entries
          WHERE (
            (vector_ids = '[]' AND created_at < ?)
            OR (vector_ids <> '[]' AND json_valid(pending_append_passages)
              AND json_array_length(pending_append_passages) > 0)
          ) AND ${INDEXABLE_SQL}
       ) THEN 'vectorize'
       WHEN EXISTS (
         SELECT 1 FROM entries WHERE ${UNCLASSIFIED_WHERE}
       ) THEN 'classify'
       ELSE NULL
     END AS kind`,
  ).bind(now - graceMs(env)).first<{ kind: PendingWorkKind | null }>();
  return row?.kind ?? null;
}

// The existing integration trigger fires at :30 every hour. Reuse four
// alternating invocations after the 00:00 UTC allocation reset instead of
// adding a sixth trigger (the Free plan permits five per account). Integration
// sync still runs in the intervening hours, so recovery cannot starve mirrors.
export const SCHEDULED_AI_RECOVERY_VECTOR_HOURS_UTC = [0, 2, 4] as const;
export const SCHEDULED_AI_RECOVERY_CLASSIFY_HOUR_UTC = 6;

export function scheduledAiRecoverySlot(scheduledTime: number | undefined): "vector" | "final" | null {
  if (typeof scheduledTime !== "number" || !Number.isFinite(scheduledTime)) return null;
  const date = new Date(scheduledTime);
  if (date.getUTCMinutes() !== 30) return null;
  const hour = date.getUTCHours();
  if ((SCHEDULED_AI_RECOVERY_VECTOR_HOURS_UTC as readonly number[]).includes(hour)) return "vector";
  return hour === SCHEDULED_AI_RECOVERY_CLASSIFY_HOUR_UTC ? "final" : null;
}

export interface ScheduledAiRecoveryResult extends PendingBatchResult {
  handled: boolean;
  action: PendingWorkKind | "idle" | "outside_window";
}

export async function runScheduledAiRecovery(
  env: Env,
  scheduledTime: number | undefined,
  now = Date.now(),
): Promise<ScheduledAiRecoveryResult> {
  const slot = scheduledAiRecoverySlot(scheduledTime);
  if (!slot) {
    return { handled: false, action: "outside_window", processed: 0, failed: 0, remaining: 0 };
  }

  const kind = await pendingAiWorkKind(env, now);
  // Classification is deliberately one bounded pass per day. Earlier slots
  // remain available to integration sync when vector repair is already done.
  if (!kind || (kind === "classify" && slot !== "final")) {
    return { handled: false, action: "idle", processed: 0, failed: 0, remaining: 0 };
  }

  const result = kind === "vectorize"
    ? await processPendingVectorization(env, { limit: SCHEDULED_VECTORIZE_PENDING_BATCH, now })
    : await processPendingClassification(env, { limit: SCHEDULED_CLASSIFY_PENDING_BATCH, now });
  const handled = result.processed > 0
    || result.failed > 0
    || result.remaining > 0
    || result.quotaRetryAt !== undefined;
  return { handled, action: kind, ...result };
}
