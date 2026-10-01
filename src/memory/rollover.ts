import type { Config } from "../config";
import { DEFAULTS } from "../config";
import type { Env } from "../env";
import { edgeInsertStatement, sameWorkspaceEdge } from "../graph/edges";
import { auditEvents } from "../lib/audit";
import type { WriteContext } from "../lib/scope";
import { memoryWriteMarker, assertMemoryWritesAllowed } from "../migration/write-lock";
import { standingTouched } from "../standing/cache";
import { tagsAfterAppend } from "./stale";
import { isMemoryTier, type MemoryTier } from "./tier";
import { withVolatility, type Volatility } from "./volatility";
import { MemoryInputError, storeEntry, validateIndexableMemory } from "../capture/store";
import {
  MEMORY_ROLLOVER_SNAPSHOT_MAX_CHARS,
  MEMORY_ROLLOVER_WARN_CHARS,
} from "./rollover-policy";

interface SourceEntryRow {
  content: string;
  tags: string;
  source: string;
  created_at: number;
  vector_ids: string;
  workspace_id: string;
  actor_id: string;
  memory_tier: string | null;
  pinned: number | null;
  importance_score: number | null;
  write_marker: string | null;
}

interface RolloverReceiptMetadata {
  rollover?: {
    version?: number;
    requestHash?: string;
  };
}

export interface RolloverEntryOptions {
  operationId: string;
  volatility?: Volatility;
  writeContext: WriteContext;
}

export interface RolloverEntryResult {
  id: string;
  sourceId: string;
  sourceChars: number;
  snapshotChars: number;
  replayed: boolean;
  indexingScheduled: boolean;
}

export class RolloverOperationConflictError extends Error {
  constructor() {
    super("operation_id was already used for a different rollover");
    this.name = "RolloverOperationConflictError";
  }
}

export class RolloverNotNeededError extends Error {
  constructor(readonly contentChars: number) {
    super(`rollover is available once an entry reaches ${MEMORY_ROLLOVER_WARN_CHARS} characters (current: ${contentChars})`);
    this.name = "RolloverNotNeededError";
  }
}

export class RolloverSourceChangedError extends Error {
  constructor() {
    super("entry changed during rollover; retry with a fresh operation_id and snapshot");
    this.name = "RolloverSourceChangedError";
  }
}

export class RolloverAlreadyExistsError extends Error {
  constructor(readonly continuationId: string) {
    super(`entry already rolled over; continue with entry ${continuationId}`);
    this.name = "RolloverAlreadyExistsError";
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

async function rolloverEntryId(operationId: string): Promise<string> {
  return `rollover-${(await sha256(`second-brain-rollover-v1\0${operationId}`)).slice(0, 32)}`;
}

async function rolloverRequestHash(sourceId: string, snapshot: string, volatility?: Volatility): Promise<string> {
  return sha256(JSON.stringify({ sourceId, snapshot, volatility: volatility ?? null }));
}

function parseTags(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function continuationTier(raw: string | null): MemoryTier {
  return isMemoryTier(raw) && raw === "hot" ? "hot" : "warm";
}

async function readRolloverReceipt(
  env: Env,
  continuationId: string,
  sourceId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    // scope-exempt: both IDs are deterministic from the already-authorized source entry and caller operation_id; the join verifies the continuation still exists
    `SELECT e.metadata
       FROM edges e
       JOIN entries continuation ON continuation.id = e.source_id
      WHERE e.source_id = ? AND e.target_id = ? AND e.type = 'drawn_from'`,
  ).bind(continuationId, sourceId).first<{ metadata: string }>();
  if (!row) return null;
  try {
    const metadata = JSON.parse(row.metadata) as RolloverReceiptMetadata;
    return metadata.rollover?.version === 1 && typeof metadata.rollover.requestHash === "string"
      ? metadata.rollover.requestHash
      : null;
  } catch {
    return null;
  }
}

async function readExistingContinuation(env: Env, sourceId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    // scope-exempt: the source ID was access-checked; this only locates its system rollover successor and returns no memory content
    `SELECT e.source_id, e.metadata
       FROM edges e
       JOIN entries continuation ON continuation.id = e.source_id
      WHERE e.target_id = ? AND e.type = 'drawn_from'
        AND CASE WHEN json_valid(e.metadata)
              THEN json_extract(e.metadata, '$.rollover.version')
              ELSE NULL
            END = 1
      ORDER BY e.created_at DESC
      LIMIT 1`,
  ).bind(sourceId).first<{ source_id: string; metadata: string }>();
  if (row) {
    const metadata = JSON.parse(row.metadata) as RolloverReceiptMetadata;
    if (metadata.rollover?.version === 1) return row.source_id;
  }
  return null;
}

async function replayedRollover(
  env: Env,
  continuationId: string,
  sourceId: string,
  requestHash: string,
  sourceChars: number,
  snapshotChars: number,
): Promise<RolloverEntryResult | null> {
  const storedHash = await readRolloverReceipt(env, continuationId, sourceId);
  if (!storedHash) return null;
  if (storedHash !== requestHash) throw new RolloverOperationConflictError();
  return {
    id: continuationId,
    sourceId,
    sourceChars,
    snapshotChars,
    replayed: true,
    indexingScheduled: false,
  };
}

/**
 * Start a bounded current-state continuation without rewriting the source journal.
 *
 * D1 commits the continuation, provenance edges and tier hand-off together. Semantic
 * indexing happens afterwards through waitUntil; its failure leaves a keyword-searchable
 * source-of-truth row that the existing pending-index repair can recover.
 */
export async function rolloverEntry(
  env: Env,
  sourceId: string,
  rawSnapshot: string,
  ctx: ExecutionContext,
  config: Readonly<Config> = DEFAULTS,
  options: Readonly<RolloverEntryOptions>,
): Promise<RolloverEntryResult> {
  await assertMemoryWritesAllowed(env);
  const operationId = options.operationId.trim();
  if (!operationId || operationId.length > 128) {
    throw new MemoryInputError("operation_id must be a non-empty string of at most 128 characters");
  }

  const snapshot = rawSnapshot.trim();
  if (!snapshot) throw new MemoryInputError("snapshot cannot be empty");
  if (snapshot.length > MEMORY_ROLLOVER_SNAPSHOT_MAX_CHARS) {
    throw new MemoryInputError(
      `snapshot is limited to ${MEMORY_ROLLOVER_SNAPSHOT_MAX_CHARS} characters`,
      413,
    );
  }

  const continuationId = await rolloverEntryId(operationId);
  const requestHash = await rolloverRequestHash(sourceId, snapshot, options.volatility);
  const row = await env.DB.prepare(
    // scope-exempt: the route/MCP layer access-checks this exact source ID before calling the rollover helper
    // validity: any: 認可済み単一行の状態・衝突・原本CASを検証する。通常recall候補ではない。
    `SELECT content, tags, source, created_at, vector_ids, workspace_id, actor_id,
            memory_tier, pinned, importance_score, write_marker
       FROM entries WHERE id = ?`,
  ).bind(sourceId).first<SourceEntryRow>();
  if (!row) throw new Error(`No entry found with ID: ${sourceId}`);

  const replay = await replayedRollover(
    env,
    continuationId,
    sourceId,
    requestHash,
    row.content.length,
    snapshot.length,
  );
  if (replay) return replay;
  const existingContinuation = await readExistingContinuation(env, sourceId);
  if (existingContinuation) throw new RolloverAlreadyExistsError(existingContinuation);

  const occupied = await env.DB.prepare(
    // scope-exempt: deterministic rollover ID collision check after source authorization; no row content is returned
    // validity: any: 認可済み単一行の状態・衝突・原本CASを検証する。通常recall候補ではない。
    `SELECT id FROM entries WHERE id = ?`,
  ).bind(continuationId).first<{ id: string }>();
  if (occupied) throw new RolloverOperationConflictError();
  if (row.content.length < MEMORY_ROLLOVER_WARN_CHARS) {
    throw new RolloverNotNeededError(row.content.length);
  }
  if (row.workspace_id !== options.writeContext.workspaceId) {
    throw new RolloverSourceChangedError();
  }

  const sourceTags = parseTags(row.tags);
  const carriedTags = tagsAfterAppend(sourceTags).filter(tag => tag !== "rolled-up");
  const continuationTags = options.volatility
    ? withVolatility(carriedTags, options.volatility)
    : carriedTags;
  validateIndexableMemory(continuationId, snapshot, continuationTags, row.source);

  const now = Date.now();
  const targetTier = continuationTier(row.memory_tier);
  const targetPinned = Number(row.pinned) === 1 ? 1 : 0;
  const follows = edgeInsertStatement(continuationId, sourceId, "follows", {
    provenance: "system",
    weight: 1,
    ...sameWorkspaceEdge(row.workspace_id),
    metadata: { rollover: { version: 1 } },
  }, env);
  const drawnFrom = edgeInsertStatement(continuationId, sourceId, "drawn_from", {
    provenance: "system",
    weight: 1,
    ...sameWorkspaceEdge(row.workspace_id),
    metadata: {
      rollover: {
        version: 1,
        requestHash,
        sourceChars: row.content.length,
      },
    },
  }, env);
  if (!follows || !drawnFrom) throw new Error("could not create rollover provenance links");

  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        // scope-exempt: source ID was authorized and every copied field is CAS-checked in the EXISTS clause; a lost CAS makes the following edge insert abort the batch on its missing endpoint
        // versioning: exempt: new continuation, original retained unchanged
        // validity: any: 認可済み単一行の状態・衝突・原本CASを検証する。通常recall候補ではない。
        `INSERT INTO entries
           (id, content, tags, source, created_at, updated_at, vector_ids, recall_count,
            importance_score, contradiction_wins, contradiction_losses, memory_tier, pinned,
            write_marker, workspace_id, actor_id)
         SELECT ?, ?, ?, ?, ?, ?, '[]', 0, ?, 0, 0, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM entries
             WHERE id = ? AND content = ? AND tags = ? AND source = ? AND created_at = ?
               AND vector_ids = ? AND workspace_id = ? AND actor_id = ? AND write_marker IS ?
          ) AND NOT EXISTS (SELECT 1 FROM entries_trash WHERE id = ?)`,
      ).bind(
        continuationId,
        snapshot,
        JSON.stringify(continuationTags),
        row.source,
        now,
        now,
        Number(row.importance_score ?? 0),
        targetTier,
        targetPinned,
        memoryWriteMarker(env),
        row.workspace_id,
        options.writeContext.actorId,
        sourceId,
        row.content,
        row.tags,
        row.source,
        row.created_at,
        row.vector_ids,
        row.workspace_id,
        row.actor_id,
        row.write_marker,
        continuationId,
      ),
      follows,
      drawnFrom,
      env.DB.prepare(
        // versioning: exempt: storage tier bookkeeping preserves the source
        // validity: any: 継続行の作成CASが成功した場合だけ原本の保存tierを変える。
        `UPDATE entries SET memory_tier = 'cold', pinned = 0, write_marker = ? WHERE id = ?
          AND EXISTS (SELECT 1 FROM entries WHERE id = ? AND workspace_id = ?)`,
      ).bind(memoryWriteMarker(env), sourceId, continuationId, row.workspace_id),
    ]);
    // edge helperは端点のないINSERTをskipする。原本CASの不成立は成功として返さない。
    if (Number(results[0]?.meta?.changes ?? results[0]?.meta?.rows_written ?? 0) === 0) {
      throw new RolloverSourceChangedError();
    }
  } catch (error) {
    const concurrentReplay = await replayedRollover(
      env,
      continuationId,
      sourceId,
      requestHash,
      row.content.length,
      snapshot.length,
    );
    if (concurrentReplay) return concurrentReplay;
    const concurrentContinuation = await readExistingContinuation(env, sourceId);
    if (concurrentContinuation) throw new RolloverAlreadyExistsError(concurrentContinuation);
    const targetNowExists = await env.DB.prepare(
      // scope-exempt: deterministic collision check after an atomic rollover batch failed
      // validity: any: 認可済み単一行の状態・衝突・原本CASを検証する。通常recall候補ではない。
      `SELECT id FROM entries WHERE id = ?`,
    ).bind(continuationId).first<{ id: string }>();
    if (targetNowExists) throw new RolloverOperationConflictError();
    if ((error as Error).message.includes("missing-edge-endpoint")) {
      throw new RolloverSourceChangedError();
    }
    throw error;
  }

  // 継続行もstandingを引き継ぐため、作成直後から再検証の対象にする。
  if (continuationTags.includes("standing:active")) standingTouched(env, ctx, config, [row.workspace_id]);

  ctx.waitUntil(
    storeEntry(
      env,
      continuationId,
      snapshot,
      continuationTags,
      row.source,
      now,
      config,
      options.writeContext,
    ).catch(error => console.error("Rollover semantic indexing deferred (non-fatal):", error)),
  );
  auditEvents(env, ctx, [
    {
      entryId: continuationId,
      actorId: options.writeContext.actorId,
      event: "created",
      payload: { rolloverFrom: sourceId },
    },
    {
      entryId: sourceId,
      actorId: options.writeContext.actorId,
      event: "updated",
      payload: { rolloverTo: continuationId, memoryTier: "cold" },
    },
  ]);

  return {
    id: continuationId,
    sourceId,
    sourceChars: row.content.length,
    snapshotChars: snapshot.length,
    replayed: false,
    indexingScheduled: true,
  };
}
