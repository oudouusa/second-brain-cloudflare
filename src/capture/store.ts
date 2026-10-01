import { D1BudgetExceededError, reserveD1Sql } from "../runtime/d1-budget";
import { embedDocument, WorkersAiQuotaError } from "../lib/ai";
import { embeddingMetadata } from "../embedding/profile";
import { assertMemoryWritesAllowed, memoryWriteMarker } from "../migration/write-lock";
import { appendPendingPassage, appendRequestHash, parsePendingAppendPassages, readAppendReceipt, replayedAppend } from "./pending";
import { memoryRolloverAdvice, type MemoryRolloverAdvice } from "../memory/rollover-policy";
import { commitSourceWithHistory, type BeforeImagePlan } from "../memory/history";
import { authorizeVectorMutation, deleteVectorCleanupOp, markVectorCleanupReady, parseVectorIds, recordVectorCleanup, settleVectorCleanupOp } from "../vectorize/cleanup";
export { AppendOperationConflictError, parsePendingAppendPassages } from "./pending";
export type { PendingAppendPassage } from "./pending";
import type { Env } from "../env";
import { DEFAULTS, resolveConfig, type Config } from "../config";
import { CHUNK_MAX_CHARS, MIRRORED_SOURCES, VECTORIZE_UPSERT_BATCH, WRITE_CAS_ATTEMPTS } from "../constants";
import { embedMany } from "../lib/ai";
import { inferEdgesOnWrite, replaceInferredEdgesOnWrite } from "../graph/edges";
import { neighborsFromVectorQuery, neighborsFromVectorQueries, representativeVectors } from "../graph/traverse";
import { chunkText } from "../text/chunk";
import { deleteEntryVectors } from "../vectorize/batch";
import { rememberTags } from "../tags/vocabulary";
import { applyTagReplacement, withUserEditMarker } from "../tags/system";
import { extractHashtags } from "../text/hashtags";
import { isVectorizeUnavailable } from "../vectorize/health";
import { tagsAfterWrite, tagsAfterAppend } from "../memory/stale";
import { withVolatility, type Volatility } from "../memory/volatility";
import { OWNER_WRITE_CONTEXT, type WriteContext } from "../lib/scope";
import type { ChangeContext, AuditChannel } from "../lib/audit";
import { buildCasGuard, changesOf, Params, pruneStatement, snapshotStatement, type WhenChange } from "../memory/versions";
import { INDEXABLE_SQL } from "./lifecycle";
import { scoreWrite, type QuarantineChannel } from "../quarantine/score";
import { heldTagsFor, holdDecision, holdStatements, type HeldInfo } from "../quarantine/hold";
import { isHeld, withEditedCanonical } from "../quarantine/tags";
import { countMcpWritesInWindow } from "../quarantine/burst";
import { getStatus } from "../memory/status";
import { isCapsuleTag } from "../tags/system";
import { STANDING_TAG } from "../tags/t7";
import { buildStandingCache, standingTouched, type StandingCacheConfig } from "../standing/cache";

/** 5.7/5.2 C1: the capsule: / capsule-slot: tag set changed between two tag lists. */
function capsuleTagsDiffer(before: readonly string[], after: readonly string[]): boolean {
  const norm = (tags: readonly string[]) => JSON.stringify([...tags].filter(isCapsuleTag).sort());
  return norm(before) !== norm(after);
}

/**
 * Review NIT fix (spec 15 2.6): updateEntryContent and appendToEntry both re-embed the row, so a
 * standing instruction's cached vector goes stale the moment either commits — whether or not the
 * tags themselves changed. Touched whenever either side of the edit carries standing:active,
 * covering an edit that adds it, removes it, or leaves it in place with new content. `ctx` is
 * optional, like updateEntryValidity's own fix: a caller with none still gets a correct rebuild,
 * awaited inline instead of deferred off the response path.
 */
async function touchStandingIfNeeded(
  env: Env, ctx: ExecutionContext | undefined, config: Readonly<Config>, workspaceId: string,
  priorTags: readonly string[], nextTags: readonly string[],
  known?: readonly { id: string; vector: number[] }[],
): Promise<void> {
  if (!priorTags.includes(STANDING_TAG) && !nextTags.includes(STANDING_TAG)) return;
  if (ctx) standingTouched(env, ctx, config as StandingCacheConfig, [workspaceId], known);
  else await buildStandingCache(env, config as StandingCacheConfig, workspaceId, known ?? []);
}

/** Re-embedding must stamp vectors from the row being edited, not the caller's default write target. */
export function embedContextForRow(row: { workspace_id?: unknown }, writeCtx: WriteContext): WriteContext {
  return { workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : "", actorId: writeCtx.actorId };
}

/**
 * What a write left behind: the vector ids now on the row, and the vector of
 * its first chunk — the one a neighbour query should be run with.
 *
 * `values` is null only when there was nothing to embed.
 */
interface StoreWriteOptions {
  expectedContent: string;
  expectedTagsJson: string;
  expectedSource: string;
  expectedCreatedAt: number;
  expectedVectorIdsJson?: string;
  oldVectorIds?: string[];
  sourceMutation?: {
    expectedContent: string;
    expectedTagsJson: string;
    expectedSource: string;
    expectedCreatedAt: number;
    expectedVectorIdsJson: string;
    updatedAt: number;
    /** Optional immutable prior version committed atomically with the replacement. */
    beforeImage?: BeforeImagePlan;
  };
  lease?: {
    ownerId: string;
    deltaToken: string;
    beforeVectorWrite: () => Promise<void>;
  };
  /** Provider-operation fence used by integration mirrors around remote/D1 effects. */
  beforeMutation?: () => Promise<void>;
  /** Best-effort derived graph refresh after the source row and vectors commit. */
  afterCommitVectors?: (vectors: readonly { values: number[] }[]) => Promise<void>;
}

function d1Changed(result: D1Result): boolean {
  const meta = result.meta as D1Result["meta"] & { rows_written?: number };
  // Every caller's source UPDATE is fenced by entries.id, a primary key, so
  // the source can change at most one row. Workerd/Miniflare's changes count
  // also includes FTS and entry_counts trigger writes; zero alone means CAS
  // missed. The node:sqlite facade now also includes trigger writes in changes.
  return Number(meta.changes ?? meta.rows_written ?? 0) > 0;
}

export const MEMORY_CONTENT_MAX_CHARS = 12_000;
export const MEMORY_MAX_CHUNKS = 9;
/**
 * Incremental append keeps the request cost flat, but a long sequence of tiny appends
 * would otherwise leave an unbounded vector_ids list. Compact only after two full-entry
 * budgets have accumulated, and do it in waitUntil so a successful append response does
 * not depend on the heavier full re-embed.
 */
export const APPEND_VECTOR_COMPACTION_THRESHOLD = MEMORY_MAX_CHUNKS * 2;
export const MEMORY_MAX_TAGS = 16;
export const MEMORY_TAG_MAX_BYTES = 64;
export const MEMORY_SOURCE_MAX_BYTES = 128;
export const VECTORIZE_METADATA_MAX_BYTES = 10 * 1024;

export class MemoryInputError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) {
    super(message);
    this.name = "MemoryInputError";
  }
}

function vectorMetadata(
  id: string,
  chunk: string,
  index: number,
  total: number,
  tags: string[],
  source: string,
  now: number,
  profile: ReturnType<typeof embeddingMetadata>,
  workspaceId = "",
): Record<string, VectorizeVectorMetadata> {
  const metadata: Record<string, VectorizeVectorMetadata> = {
    content: chunk,
    parentId: id,
    chunkIndex: index,
    totalChunks: total,
    tags,
    source,
    created_at: now,
    workspace_id: workspaceId,
    ...profile,
  };
  tags.forEach(tag => {
    metadata[`tag_${tag.replace(/[."]/g, "_")}`] = true;
  });
  return metadata;
}

/** Validate every input that is copied into Workers AI or Vectorize metadata. */
export function validateIndexableMemory(
  id: string,
  content: string,
  tags: string[],
  source: string,
  existingContent = false,
): void {
  const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
  if (!existingContent && content.length > MEMORY_CONTENT_MAX_CHARS) {
    throw new MemoryInputError(
      `content is limited to ${MEMORY_CONTENT_MAX_CHARS} characters`,
      413,
    );
  }
  const chunks = chunkText(content);
  // 既存本文の修復だけはGemma25件のbatchで処理する。入力の12k/9chunk制限は維持する。
  const maxChunks = existingContent ? 512 : MEMORY_MAX_CHUNKS;
  if (chunks.length > maxChunks) {
    throw new MemoryInputError(`content is limited to ${maxChunks} embedding chunks`, 413);
  }
  if (tags.length > MEMORY_MAX_TAGS) {
    throw new MemoryInputError(`tags are limited to ${MEMORY_MAX_TAGS} values`);
  }
  if (tags.some(tag => bytes(tag) > MEMORY_TAG_MAX_BYTES)) {
    throw new MemoryInputError(`each tag is limited to ${MEMORY_TAG_MAX_BYTES} UTF-8 bytes`);
  }
  if (bytes(source) > MEMORY_SOURCE_MAX_BYTES) {
    throw new MemoryInputError(`source is limited to ${MEMORY_SOURCE_MAX_BYTES} UTF-8 bytes`);
  }
  const profile = embeddingMetadata();
  for (let i = 0; i < chunks.length; i++) {
    const metadataBytes = bytes(JSON.stringify(
      vectorMetadata(id, chunks[i], i, chunks.length, tags, source, Date.now(), profile),
    ));
    if (metadataBytes >= VECTORIZE_METADATA_MAX_BYTES) {
      throw new MemoryInputError("memory metadata exceeds the Vectorize 10 KiB limit");
    }
  }
}

async function storeMigrationEntry(
  env: Env,
  id: string,
  content: string,
  tags: string[],
  source: string,
  now: number,
  config: Readonly<Config> = DEFAULTS,
  writeCtx: WriteContext = OWNER_WRITE_CONTEXT,
  migrationWrite?: StoreWriteOptions,
  ordinaryCommit?: { expectedVectorIds: string; expectedTagsJson?: string; expectedSource?: string; expectedCreatedAt?: number; existingContent?: boolean },
): Promise<StoredEntry> {
  if (isHeld(tags)) throw new HeldRowEmbedRefusedError(id);
  const existingContent = ordinaryCommit?.existingContent === true || (!!migrationWrite && !migrationWrite.sourceMutation);
  validateIndexableMemory(id, content, tags, source, existingContent);
  // A mirrored record is indexed by its first chunk only. `chunkText` splits at
  // CHUNK_MAX_CHARS and every chunk below gets its own vector, so a long one from
  // an external system produces vectors whose entire content is templated trailer
  // — navigation, legal and social boilerplate that repeats across every sender.
  // Those vectors carry no information but still match any query sharing one
  // ordinary word with them, which is how a payment receipt outranks a memory
  // about the thing you actually asked. The capture paths already lead with the
  // parts that identify the record (`buildEmailContent`, `buildEventContent`), so
  // the first chunk is where the signal is.
  //
  // Only the INDEX is truncated. entries.content keeps the whole record, so
  // nothing is lost to the reader and keyword search still covers all of it.
  const allChunks = chunkText(content);
  const chunks = MIRRORED_SOURCES.has(source) ? allChunks.slice(0, 1) : allChunks;
  const profileMetadata = embeddingMetadata();
  // IDs belong to this write, not merely an entry/chunk position. A stale cleanup can
  // therefore never delete a newer concurrent write that reused the same position or
  // even restored identical content. Identity remains explicit in parentId metadata
  // and D1's vector_ids list.
  const vectorPrefix = `v-${crypto.randomUUID()}`;
  const batched = existingContent ? await embedMany(chunks, env, config, "document") : null;

  const vectors = await Promise.all(
    chunks.map(async (chunk, i) => {
      return {
        id: `${vectorPrefix}-${i}`,
        values: batched ? batched[i] : await embedDocument(chunk, env, config),
        metadata: vectorMetadata(
          id, chunk, i, chunks.length, tags, source, now, profileMetadata, writeCtx.workspaceId,
        ),
      };
    })
  );

  const vectorIds = vectors.map(v => v.id);
  // Full migration writes into a new index and intentionally leaves the old index alone.
  // Every ordinary write reads its current IDs; final delta already selected them in its
  // page query. Journal both old and new IDs before the remote upsert so a concurrent
  // forget or a cancelled waitUntil can always be repaired from D1 later.
  const previousVectorIds = migrationWrite
    ? (migrationWrite.oldVectorIds ?? [])
    : parseVectorIds((await env.DB.prepare(
        // scope-exempt: id is the exact entry currently being written after authorization; the read journals its prior vectors for crash-safe cleanup
        `SELECT vector_ids FROM entries WHERE id = ?`,
      ).bind(id).first<{ vector_ids: string }>())?.vector_ids);
  const cleanupIds = [...new Set([...previousVectorIds, ...vectorIds])];
  const privilegedMarker = migrationWrite?.lease
    ? `${migrationWrite.lease.ownerId}:${migrationWrite.lease.deltaToken}:${crypto.randomUUID()}`
    : undefined;
  const cleanupOptions = {
    privilegedMarker,
    beforeRemote: migrationWrite?.lease?.beforeVectorWrite,
  };
  await migrationWrite?.beforeMutation?.();
  const cleanupOpId = await recordVectorCleanup(env, id, cleanupIds, privilegedMarker);

  // Reserve authorization, upsert acknowledgement, source CAS and journal retirement
  // before Vectorize can change. The original journal is already durable on deferral.
  const mutation = reserveD1Sql(env, (ordinaryCommit ? 7 : 6) + (migrationWrite?.sourceMutation?.beforeImage ? 2 : 0));
  if (!mutation) throw new D1BudgetExceededError();
  env = mutation.env;
  try {
    try {
      await migrationWrite?.lease?.beforeVectorWrite();
      await authorizeVectorMutation(env, cleanupOpId, privilegedMarker);
      await migrationWrite?.beforeMutation?.();
      for (let i = 0; i < vectors.length; i += VECTORIZE_UPSERT_BATCH) {
        await env.VECTORIZE.upsert(vectors.slice(i, i + VECTORIZE_UPSERT_BATCH));
      }
      // A cleaner may act on ready=1 because the remote mutation has now
      // acknowledged. The D1 source commit below is fenced on this state.
      await markVectorCleanupReady(env, cleanupOpId, privilegedMarker);
    } catch (error) {
      // Vectorize may have accepted only part of a request before returning an error.
      // Reconcile against D1 instead of assuming the remote call was atomic.
      try {
        await markVectorCleanupReady(env, cleanupOpId, privilegedMarker);
        await settleVectorCleanupOp(env, cleanupOpId, id, cleanupIds, cleanupOptions);
      } catch { /* durable row remains */ }
      throw error;
    }

    const vectorJson = JSON.stringify(vectorIds);
    let update: D1Result;
    try {
      await migrationWrite?.beforeMutation?.();
      if (migrationWrite?.lease) {
        // A fresh nonce makes every privileged UPDATE visibly owner-scoped. If another
        // operator clears the lock during a batch, the trigger rejects the next marker
        // transition instead of letting an old persisted owner value act as a capability.
        const migrationMarker = `${migrationWrite.lease.ownerId}:${migrationWrite.lease.deltaToken}:${crypto.randomUUID()}`;
        update = await env.DB.prepare(
          // versioning: exempt: embedding migration bookkeeping preserves the source
          `UPDATE entries SET vector_ids = ?, migration_lease_owner = ?, pending_append_passages = '[]'
            WHERE id = ? AND content = ? AND tags = ? AND source = ? AND created_at = ?
              AND vector_ids = ? AND workspace_id = ? AND ${INDEXABLE_SQL}
              AND EXISTS (SELECT 1 FROM vector_cleanup_ops WHERE op_id = ? AND ready = 1)`,
        ).bind(
          vectorJson, migrationMarker, id, migrationWrite.expectedContent,
          migrationWrite.expectedTagsJson, migrationWrite.expectedSource,
          migrationWrite.expectedCreatedAt,
          migrationWrite.expectedVectorIdsJson ?? JSON.stringify(previousVectorIds), writeCtx.workspaceId, cleanupOpId,
        ).run();
      } else if (migrationWrite?.sourceMutation) {
        const mutation = migrationWrite.sourceMutation;
        const sourceUpdate = env.DB.prepare(
          // versioning: snapshot
          `UPDATE entries
              SET content = ?, tags = ?, source = ?, vector_ids = ?, pending_append_passages = '[]', updated_at = ?, write_marker = ?
            WHERE id = ? AND content = ? AND tags = ? AND source = ? AND created_at = ?
              AND vector_ids = ? AND workspace_id = ? AND ${INDEXABLE_SQL}
              AND EXISTS (SELECT 1 FROM vector_cleanup_ops WHERE op_id = ? AND ready = 1)`,
        ).bind(
          content, JSON.stringify(tags), source, vectorJson, mutation.updatedAt, memoryWriteMarker(env),
          id, mutation.expectedContent, mutation.expectedTagsJson,
          mutation.expectedSource, mutation.expectedCreatedAt, mutation.expectedVectorIdsJson, writeCtx.workspaceId,
          cleanupOpId,
        );
        update = await commitSourceWithHistory(env, sourceUpdate, mutation.beforeImage);
      } else if (migrationWrite) {
        update = await env.DB.prepare(
        // versioning: exempt: embedding bookkeeping preserves the source
          `UPDATE entries SET vector_ids = ?, pending_append_passages = '[]', write_marker = ?
          WHERE id = ? AND content = ? AND tags = ? AND source = ? AND created_at = ?
            AND vector_ids = ? AND workspace_id = ? AND ${INDEXABLE_SQL}
            AND EXISTS (SELECT 1 FROM vector_cleanup_ops WHERE op_id = ? AND ready = 1)`,
      ).bind(
        vectorJson, memoryWriteMarker(env), id, migrationWrite.expectedContent, migrationWrite.expectedTagsJson,
        migrationWrite.expectedSource, migrationWrite.expectedCreatedAt,
        migrationWrite.expectedVectorIdsJson ?? JSON.stringify(previousVectorIds), writeCtx.workspaceId, cleanupOpId,
      ).run();
      } else {
        // Automatic classification is scheduled independently from this initial
        // vector write and may legitimately add kind:/status: tags first. Tags do
        // not change the embedded content, so they must not fence the vector_ids
        // commit for an ordinary capture or pending-index repair. Content/source/
        // vector_ids and INDEXABLE_SQL still protect against replacement, append,
        // forget/deprecation, and another embedding writer.
        const sourceMarker = memoryWriteMarker(env);
        const sourceUpdate = env.DB.prepare(
          // versioning: exempt: 本文を保持する派生索引の更新。admissionと元workspaceを固定する。
          `UPDATE entries SET vector_ids = ?, pending_append_passages = '[]', write_marker = ?
            WHERE id = ? AND content = ? AND source = ? AND created_at = ?
              AND vector_ids = ? AND workspace_id = ? ${ordinaryCommit?.expectedTagsJson === undefined ? "" : "AND tags = ?"} AND ${INDEXABLE_SQL}
              AND EXISTS (SELECT 1 FROM vector_cleanup_ops WHERE op_id = ? AND ready = 1)`,
        ).bind(vectorJson, sourceMarker, id, content, ordinaryCommit?.expectedSource ?? source,
          ordinaryCommit?.expectedCreatedAt ?? now, ordinaryCommit?.expectedVectorIds ?? JSON.stringify(previousVectorIds),
          writeCtx.workspaceId, ...(ordinaryCommit?.expectedTagsJson === undefined ? [] : [ordinaryCommit.expectedTagsJson]), cleanupOpId);
        if (ordinaryCommit) {
          [update] = await env.DB.batch([
            sourceUpdate,
            // scope-exempt: source CASが確定した同じ記憶の追記receiptだけを決済する。
            env.DB.prepare(`UPDATE append_receipts SET indexed = 1, completed_at = ? WHERE entry_id = ?
              AND EXISTS (SELECT 1 FROM entries WHERE id = ? AND write_marker IS ? AND vector_ids = ? AND pending_append_passages = '[]')`)
              .bind(Date.now(), id, id, sourceMarker, vectorJson),
          ]);
        } else update = await sourceUpdate.run();
      }
    } catch (error) {
      try {
        await markVectorCleanupReady(env, cleanupOpId, privilegedMarker);
        await settleVectorCleanupOp(env, cleanupOpId, id, cleanupIds, cleanupOptions);
      } catch { /* durable row remains */ }
      throw error;
    }

    if (!d1Changed(update)) {
      // The row was forgotten (ordinary capture) or changed while a migration
      // embedding was in flight. Cleanup is journaled, so even three failed remote
      // deletes cannot let the migration cursor declare completion and lose the IDs.
      await markVectorCleanupReady(env, cleanupOpId, privilegedMarker);
      await settleVectorCleanupOp(env, cleanupOpId, id, cleanupIds, cleanupOptions);
      if (ordinaryCommit) return { vectorIds, values: vectors[0]?.values ?? null, committed: false };
      throw new Error("Migration source changed during vector write");
    }

    // On success D1 references every new ID. The only unreferenced candidates are
    // stale append/update IDs; delete them before clearing the durable outbox row.
    if (previousVectorIds.some(oldId => !vectorIds.includes(oldId))) {
      try {
        await markVectorCleanupReady(env, cleanupOpId, privilegedMarker);
        await settleVectorCleanupOp(env, cleanupOpId, id, cleanupIds, cleanupOptions);
      } catch (error) {
        // Source fields and vector_ids were committed atomically above. The durable
        // ready row makes stale-ID cleanup retryable without turning that successful
        // source mutation into a misleading failure for its caller.
        console.error("Stale vector cleanup deferred (non-fatal):", error);
      }
    } else {
      // A failed clear is safe: the next drain sees that all IDs remain referenced.
      try {
        await deleteVectorCleanupOp(env, cleanupOpId, privilegedMarker);
      } catch (error) {
        console.error("Vector cleanup journal clear failed (non-fatal):", error);
      }
    }

    if (migrationWrite?.sourceMutation) await touchStandingIfNeeded(env, undefined, config, writeCtx.workspaceId, JSON.parse(migrationWrite.sourceMutation.expectedTagsJson), tags, vectors[0] ? [{ id, vector: vectors[0].values }] : undefined);
    if (migrationWrite?.afterCommitVectors) {
      try {
        await migrationWrite.afterCommitVectors(vectors);
      } catch (error) {
        // Content and Vectorize are already authoritative. A later graph pass can
        // repair this derived state, so never turn a committed edit into a false
        // failure response.
        console.error("Inferred-edge refresh failed after vector commit (non-fatal):", error);
      }
    }

    return { vectorIds, values: vectors[0]?.values ?? null, committed: true };
  } finally { mutation.release(); }
}


export interface StoredEntry {
  vectorIds: string[];
  values: number[] | null;
  /** storeEntry only: false when the vector_ids write lost its compare-and-set (content or
   * workspace changed during the embed), so these vectors are not the row's. */
  committed?: boolean;
}

export async function storeEntry(
  env: Env,
  id: string,
  content: string,
  tags: string[],
  source: string,
  now: number,
  config: Readonly<Config> = DEFAULTS,
  writeCtx: WriteContext = OWNER_WRITE_CONTEXT,
  /** The vector_ids the caller read for this row (JSON, e.g. '[]' for a new or pending row). */
  commit: { expectedVectorIds: string; expectedTagsJson?: string; expectedSource?: string; expectedCreatedAt?: number; existingContent?: boolean } | StoreWriteOptions = { expectedVectorIds: "[]" },
): Promise<StoredEntry> {
  // 4.0の返却契約を保ち、既存のoutbox・予約・CAS・receipt処理へ委譲する。
  return storeMigrationEntry(env, id, content, tags, source, now, config, writeCtx,
    "expectedContent" in commit ? commit : undefined, "expectedContent" in commit ? undefined : commit);
}

/**
 * An upload that did not become the row's vector_ids (a lost compare-and-set, a thrown batch, a
 * superseded attempt). Its ids were minted for this upload alone (newVectorIds), so deleting them can
 * never touch another writer's vectors, and the row's own listed vectors were never overwritten.
 */
export async function discardUpload(env: Env, entryId: string, uploadedIds: string[] | null | undefined): Promise<void> {
  if (!uploadedIds?.length) return;
  try { await deleteEntryVectors(env, [{ entryId, vectorIds: uploadedIds }]); } catch (e) { console.error("Deleting a discarded vector upload failed (non-fatal):", e); }
}

/**
 * Chunk, embed and upsert an entry's vectors, without touching D1. `storeEntry` follows it with the
 * `vector_ids` UPDATE; a restore from the trash has no row yet, so it upserts first and puts the ids
 * in the INSERT that brings the row back.
 */
export async function upsertEntryVectors(
  env: Env,
  id: string,
  content: string,
  tags: string[],
  source: string,
  now: number,
  config: Readonly<Config> = DEFAULTS,
  writeCtx: WriteContext = OWNER_WRITE_CONTEXT,
  /** Embed chunks embedBatchSize() per AI call (the nightly backfill), rather than one call each. */
  opts: { batchEmbeds?: boolean; beforeMutation?: () => Promise<void> } = {},
): Promise<StoredEntry> {
  // Codex review class A (T-0089.4.2): the one gate every embed-or-upsert site for a row's real
  // content routes through — this is the single low-level function every one of them (storeEntry,
  // reembedOrThrow, reembedOrDegrade, undo's reembedForRevert, trash restore, mirror sync, the
  // embedding migration, vectorize-pending) already calls to talk to Vectorize. A row whose OWN
  // tags are still held must never be embedded, whichever route reached this call — that is
  // exactly the invariant a hold exists to enforce, and it must hold even when the caller (a
  // restore, a nightly repair) never scored this write itself. `tags` here is always the tags
  // this call is ABOUT to commit, never assumed: a deliberate release passes the row's post-
  // release (unheld) tags, so it passes this gate without needing a bypass flag.
  await assertMemoryWritesAllowed(env);
  if (isHeld(tags)) throw new HeldRowEmbedRefusedError(id);
  validateIndexableMemory(id, content, tags, source, opts.batchEmbeds === true);
  // A mirrored record is indexed by its first chunk only. `chunkText` splits at
  // CHUNK_MAX_CHARS and every chunk below gets its own vector, so a long one from
  // an external system produces vectors whose entire content is templated trailer
  // — navigation, legal and social boilerplate that repeats across every sender.
  // Those vectors carry no information but still match any query sharing one
  // ordinary word with them, which is how a payment receipt outranks a memory
  // about the thing you actually asked. The capture paths already lead with the
  // parts that identify the record (`buildEmailContent`, `buildEventContent`), so
  // the first chunk is where the signal is.
  //
  // Only the INDEX is truncated. entries.content keeps the whole record, so
  // nothing is lost to the reader and keyword search still covers all of it.
  const allChunks = chunkText(content);
  const chunks = MIRRORED_SOURCES.has(source) ? allChunks.slice(0, 1) : allChunks;

  const batched = opts.batchEmbeds ? await embedMany(chunks, env, config, "document") : null;
  // Fresh ids for this upload alone (round 6): never the deterministic ids 3.7 used.
  const prefix = `v-${crypto.randomUUID()}`;
  const ids = chunks.map((_, index) => `${prefix}-${index}`);
  const vectors = await Promise.all(
    chunks.map(async (chunk, i) => {
      const metadata: Record<string, any> = {
        content: chunk,
        parentId: id,
        chunkIndex: i,
        totalChunks: chunks.length,
        tags,
        source,
        created_at: now,
        // Which workspace this vector belongs to. User-facing queries filter on
        // it (with a graceful fallback — see src/vectorize/scope.ts); system
        // passes query unfiltered.
        workspace_id: writeCtx.workspaceId,
        ...embeddingMetadata(),
      };

      tags.forEach(t => {
        metadata[`tag_${t.replace(/[."]/g, "_")}`] = true;
      });

      return {
        id: ids[i],
        values: batched ? batched[i] : await embedDocument(chunk, env, config),
        metadata,
      };
    })
  );

  // D1のoutboxを先に永続化し、リモート書込みの部分成功も回収可能にする。
  const prior = await env.DB.prepare(
    // scope-exempt: 認可済みentryIdの既存vectorを同じcleanup台帳に保全する。
    `SELECT vector_ids FROM entries WHERE id = ?`,
  ).bind(id).first<{ vector_ids: string }>();
  const vectorIdsForCleanup = [...new Set([...parseVectorIds(prior?.vector_ids), ...vectors.map(v => v.id)])];
  await opts.beforeMutation?.();
  const cleanupOpId = await recordVectorCleanup(env, id, vectorIdsForCleanup);
  try {
    await authorizeVectorMutation(env, cleanupOpId);
    await opts.beforeMutation?.();
    for (let i = 0; i < vectors.length; i += VECTORIZE_UPSERT_BATCH) await env.VECTORIZE.upsert(vectors.slice(i, i + VECTORIZE_UPSERT_BATCH));
    await markVectorCleanupReady(env, cleanupOpId);
  } catch (error) {
    try {
      await markVectorCleanupReady(env, cleanupOpId);
      await settleVectorCleanupOp(env, cleanupOpId, id, vectorIdsForCleanup);
    } catch { /* 永続outboxから再試行する。 */ }
    throw error;
  }

  const vectorIds = vectors.map(v => v.id);

  // The first chunk's vector rides back out with the ids. Callers that need to
  // ask "what is this entry near?" straight after writing it — the update path
  // below — would otherwise embed the very same text a second time, and an
  // embed is a neuron against a 10k/day budget.
  return { vectorIds, values: vectors[0]?.values ?? null };
}

export async function deleteStaleVectors(env: Env, entryId: string, oldIds: string[], newIds: string[]): Promise<void> {
  if (!newIds.length) return;
  const keep = new Set(newIds);
  const stale = oldIds.filter(v => !keep.has(v));
  if (stale.length) await deleteEntryVectors(env, [{ entryId, vectorIds: stale }]);
}

/**
 * Embeds and upserts to Vectorize only (upsertEntryVectors, not storeEntry): every caller of
 * reembedOrThrow/reembedOrDegrade commits vector_ids itself, inside its own compare-and-set batch
 * (update, append, merge, undo). storeEntry's own unconditional `vector_ids = ?` write, if it ran
 * here too, would race ahead of that guarded batch and could overwrite a concurrent short append's
 * json_insert with a vector_ids list that never saw it (ADV-4, residual). storeEntry is the one
 * writer without such a batch; it compare-and-sets vector_ids on its own.
 *
 * Budget auditor R20 (T-0089.4.2, T-0089.5.9): always batchEmbeds — every caller here is
 * re-embedding EXISTING or merged content, which can be arbitrarily large (a 128 KB Release, a
 * merge target), unlike storeEntry's own create-time embed, which only ever sees content a hold
 * would have already caught above the scorer's 32 KB budget. embedMany costs the same one AI call
 * as the single-text embed helper does for the common few-chunk case (it batches up to
 * embedBatchSize() texts per call), so there is no downside to always taking this path here.
 */
export async function reembedOrThrow(env: Env, id: string, content: string, tags: string[], source: string, config: Readonly<Config> = DEFAULTS, writeCtx: WriteContext = OWNER_WRITE_CONTEXT): Promise<StoredEntry> {
  const stored = await upsertEntryVectors(env, id, content, tags, source, Date.now(), config, writeCtx, { batchEmbeds: true });
  if (!stored.vectorIds.length) throw new Error("re-embed produced no vectors");
  return stored;
}

/**
 * Re-embed for a content mutation. Returns the new vector ids, or null when
 * Vectorize is unreachable and the caller should commit the content keyword-only
 * (#270). Rethrows every other failure so #212's fail-loud contract survives:
 * a transient embed failure must not commit content against stale vectors.
 *
 * Callers that get null MUST NOT retire the old vectors — they are the entry's
 * only remaining semantic index until Vectorize returns.
 */
export async function reembedOrDegrade(env: Env, id: string, content: string, tags: string[], source: string, config: Readonly<Config> = DEFAULTS, writeCtx: WriteContext = OWNER_WRITE_CONTEXT): Promise<StoredEntry | null> {
  try {
    return await reembedOrThrow(env, id, content, tags, source, config, writeCtx);
  } catch (e) {
    if (!(await isVectorizeUnavailable(env))) throw e;
    console.error("Vectorize unavailable — committing content without re-embedding:", e);
    return null;
  }
}


/**
 * What `updateEntryContent` did, in the terms its callers have to answer in.
 *
 * `vectorIds: null` is the keyword-only degrade (#270) — the content committed but
 * Vectorize was unreachable, so the entry still carries its previous embedding.
 */
export type UpdateEntryResult =
  | { status: "not_found" }
  /** R2-5: the row still exists, but it moved out of the caller's authorized workspace since the
   * caller's own scoped read (an unshare mid-edit) — a conflict to retry, not a memory that vanished. */
  | { status: "moved" }
  | { status: "reembed_failed"; reason?: "workers_ai_quota_exhausted"; retryAt?: number }
  /** The row kept changing under the write: nothing was committed and the vectors were restored to the row as it stands. */
  | { status: "conflict" }
  | {
    status: "updated"; vectorIds: string[] | null;
    /** Track 4 (5.4 W-b): set when this edit scored high enough to be held. */
    held?: HeldInfo;
    /** 5.7: this row's status was canonical before this edit landed (mcp only; REST gets no label). */
    wasCanonical?: boolean;
    /** 5.7: this edit added or redefined a capsule:/capsule-slot: tag. */
    capsuleChanged?: boolean;
    /** Round 4 re-review MAJOR (undo-group "dead for canonical edits and capsule changes"): this
     * write's own version carries this same id at meta.event_id, minted here and not by
     * auditEventStatement's own default, so the caller's "updated" event can pass it straight
     * through -- the exact link classifyFromRows requires to ever group and revert this edit. */
    eventId: string;
  };

/**
 * Replace an entry's content outright, keeping D1, the tags and the vector index in step.
 *
 * `POST /update` and the MCP `update` tool both land here. They used to be two
 * implementations of the same thing, and the copy behind MCP — the one every assistant
 * client actually calls — silently missed every hardening the route gained (#289): it
 * committed content against stale vectors when an embed failed, never moved the entry's
 * updated_at, never reset the staleness tags, and never extracted hashtags. Anything that
 * decides what gets written lives in here now; the callers only shape the reply.
 * (updated_at is named bare above on purpose — test/unit/updated-at-coalesced.test.ts reads
 * every backtick-delimited span in src/ as SQL, comments included.)
 *
 * The one thing they still do for themselves is the managed-mirror guard, because
 * `integrations/mirror.ts` imports this module and the dependency must not run both ways.
 * That guard refuses before anything is written, so a drift there cannot corrupt a row —
 * unlike everything below, which is why everything below moved.
 */
export async function updateEntryContent(
  env: Env,
  id: string,
  newContent: string,
  config: Readonly<Config> = DEFAULTS,
  volatility: Volatility | undefined,
  /**
   * The user's tags for this entry, replacing the ones it has. `undefined` means
   * "leave them alone" and is what every caller but the editor passes; `[]` means
   * the user removed the last one. The two must stay distinguishable — collapsing
   * them would let any caller that omits tags wipe them.
   */
  replaceTags: string[] | undefined,
  writeCtx: WriteContext,
  change: ChangeContext,
  /** The workspace the CALLER's own scoped read authorized (getReadableEntry + assertCanEditContent),
   * required so an unshare in the awaited gap between that read and this call's own first read (R2-3)
   * cannot land as "authorized" here — this call's guard pins to it, not to whatever it reads later. */
  authorizedWorkspaceId: string,
  ctx?: ExecutionContext,
): Promise<UpdateEntryResult> {
  // A route's own scoped read can carry workspace_id as null/undefined for a row from before the
  // workspace column existed; this call's OWN read of the same row (below) always normalizes it to
  // "" (COALESCE-equivalent), so the pin must match that or a legitimate legacy row's every write
  // reports "moved" forever. Normalize once here rather than trust every call site to.
  const pinnedWorkspaceId = authorizedWorkspaceId ?? "";
  // Same treatment captureEntry gives every stored memory, which is the point — but note it
  // flattens all whitespace, so a replacement does not preserve line breaks or code fences.
  // `appendToEntry` deliberately does not flatten; prefer append when the shape matters.
  const { cleanContent, hashtags } = extractHashtags(newContent);
  // Content that is nothing but hashtags cleans down to "", which would blank the entry —
  // keep it as written in that case and let the tags be extracted anyway.
  const finalContent = cleanContent || newContent;

  // The row this write embedded from. The commit compares-and-sets on it (and on the vector_ids read),
  // so a second writer that committed in between is never overwritten in D1.
  let embeddedFrom: string | null = null;
  let reembedded: StoredEntry | null = null;
  let last: { row: Record<string, any>; vectorIds: string[]; embedCtx: WriteContext } | null = null;
  // A lost, failed or superseded attempt's own upload: its ids are this attempt's alone (round 6),
  // so it is deleted outright; the row's own listed vectors were never overwritten by it.
  const recoverFromLostAttempt = async () => {
    await discardUpload(env, id, reembedded?.vectorIds);
    reembedded = null;
  };

  for (let attempt = 1; attempt <= WRITE_CAS_ATTEMPTS; attempt++) {
    // vector_ids has to be read before any mutation: storeEntry overwrites it, and the
    // cleanup below needs to know which vectors the entry had on the way in.
    const row = await env.DB.prepare(
      // scope-exempt: by-id: routes gate with getReadableEntry + assertCanEditContent
      `SELECT content, tags, source, vector_ids, workspace_id FROM entries WHERE id = ?`
    ).bind(id).first() as Record<string, any> | null;

    if (!row) {
      // Forgotten meanwhile: its own vectors went with it, and any this write made are orphans.
      await recoverFromLostAttempt();
      return { status: "not_found" };
    }

    if (row.workspace_id !== pinnedWorkspaceId) {
      // The row moved since the caller's own authorization (R2-3: that may be the route's read, not
      // this call's): write nothing. Retrying would re-authorize against wherever it landed, which is
      // exactly the cross-tenant write this guard refuses. Distinct from not_found (R2-5): the row is
      // still there, just not here for this caller any more — a conflict, not a 404.
      await recoverFromLostAttempt();
      return { status: "moved" };
    }

    const readContent: string = row.content;
    const readTags: string = row.tags ?? "[]";
    const source = row.source as string;
    const embedCtx = embedContextForRow(row, writeCtx);
    const oldVectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");
    const existingTags: string[] = JSON.parse(readTags);
    last = { row, vectorIds: oldVectorIds, embedCtx };

    // A caller-supplied verdict is applied after the strip, not before: tagsAfterWrite
    // removes every volatility tag, so applying it first would throw the value away.
    // A replacement starts from the tags the Worker owns rather than from every tag
    // the entry has, so removing "pricing" in the editor cannot also remove the
    // classifier's `kind:semantic`. Without a replacement this is the union it has
    // always been, which is why nothing could be removed before.
    const baseTags = replaceTags ? applyTagReplacement(existingTags, replaceTags) : existingTags;
    const strippedTags = tagsAfterWrite([...new Set([...baseTags, ...hashtags])]);
    const mergedTags = (volatility ? withVolatility(strippedTags, volatility) : strippedTags)
      // `rolled-up` is a claim about content that no longer exists: the nightly digest wrote
      // it in the same statement that appended a `[Digest: <id>]` marker to the body, and a
      // full replacement destroys that marker. Left in place it costs the corrected memory a
      // 0.4x recall penalty (recall/math.ts) and bars it from every future digest, burying
      // the only copy of the new fact. The same reasoning tagsAfterWrite applies to the
      // volatility/staleness verdicts, and the reason `append` must NOT strip it — an append
      // keeps the digested original inside the entry, so the digest still covers it.
      .filter(t => t !== "rolled-up");
    // A person's edit takes a digest or insight out of the system's hands, in this same UPDATE.
    let committedTags = withUserEditMarker(mergedTags);

    // 5.7: the canonical-edit label. MCP only — a REST edit (the person) gets no label. Added to
    // the tags this edit is writing whether or not it ends up held below: a held row's status
    // moves to draft either way, so the label is moot there, but it costs nothing to include.
    const wasCanonical = getStatus(existingTags) === "canonical";
    if (change.channel === "mcp" && wasCanonical) committedTags = withEditedCanonical(committedTags, Date.now());
    const capsuleChanged = capsuleTagsDiffer(existingTags, committedTags);

    // Track 4 (5.1, 5.4 W-b): scored on the resulting content. D4.1: an already-held row is
    // never rescored — quarantine:* is worker-owned, so applyTagReplacement above already kept
    // it regardless of what the caller asked to replace it with.
    const alreadyHeld = isHeld(existingTags);
    let score: ReturnType<typeof scoreWrite> | null = null;
    if (!alreadyHeld && (change.channel === "mcp" || change.channel === "rest")) {
      const channel: QuarantineChannel = change.channel;
      const mcpWritesInWindow = channel === "mcp"
        ? await countMcpWritesInWindow(env, change.actorId, Date.now(), config.QUARANTINE_WRITE_BURST)
        : undefined;
      score = scoreWrite(
        { content: finalContent, tags: committedTags, source, channel, kind: "update", mcpWritesInWindow, capsuleTagsChanged: capsuleChanged },
        config,
      );
    }
    // Codex review class D (T-0089.4.2): a `partial` score holds too, reason too_long.
    const decision = score ? holdDecision(score) : { hold: false as const };
    const heldTags = decision.hold ? heldTagsFor(committedTags, decision.reasons) : null;

    // Re-embed FIRST (#212): if it fails, leave the entry's content and vectors untouched and
    // surface an error, instead of committing new content and then deleting every vector —
    // which would leave the entry silently unsearchable. null means Vectorize is unreachable
    // (#270), not that this embed failed. A retry re-embeds only if the row's text changed (another
    // writer may have upserted over these ids); a tags-only change keeps the vectors already made.
    // 5.4 W-b: a held write skips this pre-commit re-embed entirely (saves a model call) — the
    // row is never vectorized, so there is nothing to embed for. Codex review class A
    // (T-0089.4.2): an edit that keeps an ALREADY-held row held (D4.1, not rescored) must skip it
    // too — committedTags still carries the quarantine: tag, and upsertEntryVectors' own gate
    // now refuses that content outright rather than silently indexing a row a hold excludes.
    if (!heldTags && !alreadyHeld && (attempt === 1 || embeddedFrom !== readContent)) {
      // A previous attempt's embed is being abandoned for this fresh one (content moved again since
      // it ran): delete its upload now, before embedding again.
      await recoverFromLostAttempt();
      try {
        reembedded = await reembedOrDegrade(env, id, finalContent, mergedTags, source, config, embedCtx);
      } catch (e) {
        console.error("Re-embed failed — entry left unchanged:", e);
        return { status: "reembed_failed", ...(e instanceof WorkersAiQuotaError ? { reason: "workers_ai_quota_exhausted" as const, retryAt: e.retryAt } : {}) };
      }
      embeddedFrom = readContent;
    }
    if (heldTags) await recoverFromLostAttempt();
    const newVectorIds = reembedded?.vectorIds ?? null;

    // Safe to commit: either the embed succeeded, or Vectorize is unavailable and the old
    // vectors are kept below rather than retired.
    // A replacement is a new logical version of the entry, but it stays IN PLACE:
    // workspace_id is never touched here (share/unshare moves rows, nothing else does),
    // and actor_id is left untouched: the original author of a row being edited is not
    // this call's to decide. It IS part of the guard (ADV-2): a row this call is no longer
    // authorized to write into must miss, not commit into wherever it ended up.
    // The prior state is kept in the same batch as the change, and a lost attempt writes neither.
    // vector_ids is set HERE, atomically with content and under the same guard (ADV-4) — not left
    // to storeEntry's own unconditional write, which a losing attempt would otherwise leave behind
    // for the next attempt's statement to build on top of.
    const now = Date.now();
    // Round 4 re-review MAJOR: minted here, not by auditEventStatement's own default, so this
    // version's meta.event_id and the "updated" event it lands with moments later (the caller,
    // after this returns) share the SAME id.
    const eventId = crypto.randomUUID();
    // vector_ids too (round 6): the row decides which upload won, and old ids retired below are
    // exactly the ones this commit replaced.
    const casColumns = { content: readContent, tags: readTags, workspace_id: pinnedWorkspaceId, vector_ids: row.vector_ids ?? null };
    const p = new Params();
    const contentIdx = p.add(finalContent);
    const tagsIdx = p.add(JSON.stringify(committedTags));
    const nowIdx = p.add(now);
    const vectorIdsIdx = p.add(newVectorIds ? JSON.stringify(newVectorIds) : row.vector_ids);
    const idIdx = p.add(id);
    let committed: Awaited<ReturnType<typeof env.DB.batch>>;
    try {
      committed = await env.DB.batch([
        snapshotStatement(env, {
          entryId: id, reason: "update", change, content: { kind: "next", content: finalContent }, nextTags: committedTags,
          meta: { event_id: eventId }, now,
          // ADV-10: readContent is this write's own base, right here in JS — its UTF-16 length is the
          // exact boundary a later reconstruction needs, at zero cost. Stored only when this row
          // actually lands as a delta (buildSnapshot nulls it out on a full copy, same as prior_length).
          priorLengthUtf16: readContent.length,
          guard: p2 => buildCasGuard(p2, casColumns),
        }),
        // updated_at clamped strictly past its own previous value (the digest mark guard,
        // src/compression/digest.ts, trusts COALESCE(updated_at, created_at) plus byte length as
        // its change signal; a same-millisecond, same-length edit with no clamp would leave it unmoved).
        // versioning: snapshot
        env.DB.prepare(`UPDATE entries AS e SET write_marker = ${p.add(memoryWriteMarker(env))}, content = ${contentIdx}, tags = ${tagsIdx}, pending_append_passages = '[]', updated_at = MAX(${nowIdx}, COALESCE(e.updated_at, e.created_at) + 1), vector_ids = ${vectorIdsIdx} WHERE e.id = ${idIdx} AND ${buildCasGuard(p, casColumns)}`)
          .bind(...p.values()),
        pruneStatement(env, id, config.VERSION_KEEP),
        // 5.4 W-b: holdStatements appended to the same batch — the edit above is its own version
        // and the hold is the next. Guarded on the edit's own post-state, so a lost compare-and-set
        // (the UPDATE above changed nothing) cannot land the hold either.
        ...(heldTags && decision.hold ? holdStatements(env, { snapshotStatement, pruneStatement, versionKeep: config.VERSION_KEEP }, {
          entryId: id, reasons: decision.reasons, score: decision.score, signals: decision.signals, change, heldTags, now,
          // holdStatements' own UPDATE targets plain `entries`, unaliased (unlike the snapshot's `entries e` above).
          guard: p2 => `content = ${p2.add(finalContent)} AND tags = ${p2.add(JSON.stringify(committedTags))}`,
        }) : []),
      ]);
    } catch (e) {
      // The batch never landed, but the embed above already committed vector_ids-shaped ids
      // describing text that was never saved (U6): re-embed the row as it now stands before
      // the caller sees the error, so a thrown batch cannot leave the index ahead of D1.
      await recoverFromLostAttempt();
      throw e;
    }
    if (changesOf(committed[1]) === 0) continue;

    // Rewritten content can carry hashtags the brain has never seen, so this is one of the
    // two places an unknown tag enters the corpus (#288). It sits here rather than in the
    // route because #289 made this the single update path — putting it in the caller would
    // have left the MCP tool introducing tags the cache never learned about.
    await rememberTags(env, mergedTags, embedCtx.workspaceId);

    if (heldTags) {
      // No new upload to compare stale ids against (deleteStaleVectors no-ops when newIds is
      // empty, by design — held is the one caller that means it): delete the row's PRIOR
      // vectors directly, after commit, same as deprecateEntry (5.3 point 1).
      if (oldVectorIds.length) {
        try {
          await deleteEntryVectors(env, [{ entryId: id, vectorIds: oldVectorIds }]);
        } catch (e) {
          console.error("Vectorize delete failed after a held update (non-fatal):", e);
        }
      }
      await touchStandingIfNeeded(env, ctx, config, embedCtx.workspaceId, existingTags, committedTags);
      return { status: "updated", vectorIds: null, held: decision.hold ? { reasons: decision.reasons, score: decision.score } : undefined, wasCanonical, capsuleChanged, eventId };
    }

    if (newVectorIds) {
      try {
        await deleteStaleVectors(env, id, oldVectorIds, newVectorIds);
      } catch (e) {
        console.error("Old vector cleanup failed (non-fatal):", e);
      }
    }

    // An edit changes what the entry means, so it changes where the entry belongs
    // in the graph. Run on the vector the re-embed above already produced, so this
    // costs one Vectorize query and no second embed.
    //
    // Skipped on the keyword-only degrade (#270): with no fresh vector there is
    // nothing to ask the index with, and querying on the stale one would place the
    // entry by the text it no longer contains.
    if (reembedded?.values) {
      try {
        await replaceInferredEdgesOnWrite([{ entryId: id, neighbors: await neighborsFromVectorQuery(reembedded.values, env) }], env);
      } catch (e) {
        console.error("Update auto-link failed (non-fatal):", e);
      }
    }

    await touchStandingIfNeeded(env, ctx, config, embedCtx.workspaceId, existingTags, committedTags, reembedded?.values ? [{ id, vector: reembedded.values }] : undefined);
    return { status: "updated", vectorIds: newVectorIds, wasCanonical, capsuleChanged, eventId };
  }

  // Out of attempts: the last upload never became the row's, so it goes.
  await recoverFromLostAttempt();
  return { status: "conflict" };
}

/** The row changed under a compare-and-set writer more often than it may retry: nothing was written. HTTP 409. */
export class WriteConflictError extends Error {
  constructor() { super("changed while saving, try again"); }
}

/** The row was forgotten between the caller's guard read and the write. */
export class EntryGoneError extends Error {
  constructor(id: string) { super(`No memory found with ID: ${id}`); }
}

/** Codex review class A (T-0089.4.2): upsertEntryVectors' own refusal when the tags it was asked
 * to embed are still held. Every caller either already checks `isHeld` before it gets here (the
 * ordinary write paths, which never call this with held tags to begin with) or must now handle
 * this explicitly (trash restore, undo's release paths) — a thrown error, not a silent no-op, so
 * a caller that forgets fails loudly in tests rather than shipping a quiet embed. */
export class HeldRowEmbedRefusedError extends Error {
  constructor(id: string) { super(`refusing to embed held row ${id}`); }
}

/**
 * Append to an entry. The row is read here, not taken from the caller: a caller's `existingContent`
 * can be stale by the time it commits, and building the new text from it drops a concurrent append.
 * `existingContent`, `tags` and `source` are accepted for the callers that hold them and ignored.
 *
 * Short appends build the content in SQL (`content || suffix`) so no addition is lost, and
 * compare-and-set on the tags they read. Long appends re-embed the whole text, so they compare-and-set
 * on content and tags and retry from a fresh read. Either way a lost attempt writes no version.
 */
/** 5.4 W-c: the appended text is scored with this much of the prior content for context, not
 * the whole entry — bounded, regardless of how long the entry already is. */
export const APPEND_SCORE_CONTEXT_CHARS = 2000;

export interface AppendResult {
  indexed: boolean;
  /** Track 4 (5.4 W-c): set when this append scored high enough to be held. */
  held?: HeldInfo;
  /** 5.7: this row's status was canonical before this append landed (mcp only). */
  wasCanonical?: boolean;
  /** Round 4 re-review MAJOR (undo-group "dead for canonical edits and capsule changes"): this
   * write's own version carries this same id at meta.event_id -- see UpdateEntryResult's own note. */
  eventId: string;
}

export async function appendToEntry(
  env: Env, id: string, _existingContent: string, addition: string, _tags: string[], source: string,
  config: Readonly<Config> = DEFAULTS, volatility: Volatility | undefined,
  writeCtx: WriteContext, change: ChangeContext, when: { at: number; kind: string } | undefined,
  authorizedWorkspaceId: string, ctx?: ExecutionContext, forkOptions: Readonly<AppendEntryOptions> = {}, attempt = 1,
): Promise<AppendResult & AppendEntryResult> {
  const options: Readonly<AppendEntryOptions> = { ...forkOptions, volatility, when: when as AppendEntryOptions["when"] };
  const background: Promise<unknown>[] = [];
  const defer = (task: Promise<unknown>) => ctx ? ctx.waitUntil(task) : background.push(task);
  const eventId = crypto.randomUUID();
  await assertMemoryWritesAllowed(env);
  const operationId = options.operationId?.trim();
  const requestHash = operationId
    ? await appendRequestHash(addition, options.volatility, options.when)
    : null;
  const row = await env.DB.prepare(
    // scope-exempt: the route/MCP layer verifies access to this exact id before calling the ID-only append helper
    `SELECT content, tags, source, created_at, vector_ids, workspace_id, pending_append_passages FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;

  if (!row) throw new EntryGoneError(id);
  if ((row.workspace_id ?? "") !== (authorizedWorkspaceId ?? "")) throw new EntryGoneError(id);
  if (row.source !== source) throw new Error("Entry changed during append; retry the request");
  if (operationId && requestHash) {
    const replay = replayedAppend(
      await readAppendReceipt(env, operationId), id, requestHash, String(row.content).length,
    );
    if (replay) return { ...replay, wasCanonical: false, eventId };
  }

  const existingVectorIds: string[] = JSON.parse(row?.vector_ids ?? "[]");
  const currentTags: string[] = JSON.parse(row.tags ?? "[]");
  const currentSource = row.source as string;

  // Spelled month, like every other date this app hands to a reader or a
  // model: "8/2/2026" is two different days depending on where you live.
  const timestamp = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const separator = `\n\n[Update ${timestamp}]: `;
  const newContent = (row.content as string) + separator + addition;

  // Computed once and used by both branches below so they cannot drift. Unlike a
  // replacement this keeps any existing volatility verdict (see tagsAfterAppend); a
  // caller-supplied one still overrides it.
  const appendedTags = tagsAfterAppend(currentTags);
  let refreshedTags = options.volatility
    ? withVolatility(appendedTags, options.volatility)
    : appendedTags;
  refreshedTags = withUserEditMarker(refreshedTags);
  const wasCanonical = getStatus(currentTags) === "canonical";
  if (change.channel === "mcp" && wasCanonical) refreshedTags = withEditedCanonical(refreshedTags, Date.now());
  const decision = !isHeld(currentTags) && (change.channel === "mcp" || change.channel === "rest")
    ? holdDecision(scoreWrite({ content: String(row.content).slice(-APPEND_SCORE_CONTEXT_CHARS) + addition,
      tags: refreshedTags, source: currentSource, channel: change.channel, kind: "append",
      mcpWritesInWindow: change.channel === "mcp" ? await countMcpWritesInWindow(env, change.actorId, Date.now(), config.QUARANTINE_WRITE_BURST) : undefined }, config))
    : { hold: false as const };
  const held = decision.hold ? { reasons: decision.reasons, score: decision.score } : undefined;
  const heldTags = decision.hold ? heldTagsFor(refreshedTags, decision.reasons) : null;
  const heldRow = !!heldTags || isHeld(refreshedTags);
  validateIndexableMemory(id, heldRow ? "" : newContent, refreshedTags, currentSource);

  // An append is an immutable new passage. Re-embedding the entry's entire history
  // whenever the combined body crosses CHUNK_MAX_CHARS makes every later append grow
  // more expensive and can exhaust the Free Worker CPU budget. Index only the addition;
  // update/replace retain the full re-embed path because they invalidate old passages.
  // D1 remains the authoritative full text in both cases.
  const chunks = chunkText(addition);
  const createdAt = Date.now();
  const vectorPrefix = `v-${crypto.randomUUID()}`;
  let vectors: VectorizeVector[] = [];
  let newVectorIds: string[] = [];

  // Committed either way: keyword search reads entries.content, so an unindexed
  // addition is still recallable, whereas rejecting the append loses it outright.
  // A transient failure still throws — nothing is written yet, so the retry is safe.
  let indexed = !heldRow;
  let semanticUnavailableReason: AppendEntryResult["semanticUnavailableReason"];
  let semanticRetryAt: number | undefined;
  let cleanupOpId: string | null = null;
  let cleanupNeedsRetry = false;
  try {
    if (!heldRow) vectors = await Promise.all(chunks.map(async (chunk, index) => ({
      id: `${vectorPrefix}-${index}`,
      values: await embedDocument(chunk, env, config),
      metadata: {
        ...vectorMetadata(
          id,
          chunk,
          index,
          chunks.length,
          refreshedTags,
          currentSource,
          createdAt,
          embeddingMetadata(),
          String(row.workspace_id ?? ""),
        ),
        isUpdate: true,
      },
    })));
    newVectorIds = vectors.map(vector => vector.id);
    cleanupOpId = await recordVectorCleanup(env, id, newVectorIds);
    await authorizeVectorMutation(env, cleanupOpId);
    await env.VECTORIZE.insert(vectors);
  } catch (e) {
    if (cleanupOpId) {
      cleanupNeedsRetry = true;
      try {
        await markVectorCleanupReady(env, cleanupOpId);
        await settleVectorCleanupOp(env, cleanupOpId, id, newVectorIds);
      } catch { /* durable row remains */ }
    }
    if (e instanceof WorkersAiQuotaError) {
      semanticUnavailableReason = "workers_ai_quota_exhausted";
      semanticRetryAt = e.retryAt;
      console.error("Workers AI quota exhausted — queueing appended passage for indexing");
      indexed = false;
    } else {
      if (!(await isVectorizeUnavailable(env))) throw e;
      semanticUnavailableReason = "vectorize_unavailable";
      console.error("Vectorize unavailable — queueing appended passage for indexing:", e);
      indexed = false;
    }
  }

  const now = Date.now();
  const committedVectorIds = heldRow ? [] : indexed
    ? [...existingVectorIds, ...newVectorIds]
    : existingVectorIds;
  const committedVectorIdsJson = JSON.stringify(committedVectorIds);
  const previousPendingJson = typeof row.pending_append_passages === "string"
    ? row.pending_append_passages
    : "[]";
  const committedPendingJson = heldRow ? "[]" : indexed
    ? previousPendingJson
    : JSON.stringify(appendPendingPassage(previousPendingJson, addition, createdAt, operationId));
  // This marker is unique to the current admitted request in production. Besides fencing
  // the source write, it proves that the conditional receipt below belongs to THIS update
  // rather than to a concurrent append that happened to produce the same content/time.
  const appendMarker = memoryWriteMarker(env);
  const holds = heldTags && decision.hold ? holdStatements(env, { snapshotStatement, pruneStatement, versionKeep: config.VERSION_KEEP }, {
    entryId: id, reasons: decision.reasons, score: decision.score, signals: decision.signals, change, heldTags, now,
    guard: p => `content = ${p.add(newContent)} AND tags = ${p.add(JSON.stringify(refreshedTags))} AND workspace_id = ${p.add(authorizedWorkspaceId ?? "")}`,
  }) : [];
  if (heldRow && existingVectorIds.length) {
    const op = await recordVectorCleanup(env, id, existingVectorIds);
    await markVectorCleanupReady(env, op);
  }

  let committed: D1Result;
  try {
    const update = env.DB.prepare(
      // versioning: snapshot
      `UPDATE entries SET content = ?, vector_ids = ?, tags = ?, pending_append_passages = ?, updated_at = ?, write_marker = ?${options.when ? ", when_at = ?, when_kind = ?, when_source = 'explicit', when_label = NULL" : ""}
        WHERE id = ? AND content = ? AND tags = ? AND source = ? AND created_at = ?
          AND vector_ids = ? AND pending_append_passages = ? AND workspace_id = ?`
    ).bind(
      newContent, committedVectorIdsJson,
      JSON.stringify(refreshedTags), committedPendingJson, now, appendMarker,
      ...(options.when ? [options.when.at, options.when.kind] : []), id,
      row.content, row.tags, row.source, row.created_at, row.vector_ids, previousPendingJson, authorizedWorkspaceId ?? "",
    );
    const snapshot = snapshotStatement(env, { entryId: id, reason: "append", change,
      content: { kind: "next", content: newContent }, nextTags: refreshedTags,
      nextWhen: options.when ? { when_at: options.when.at, when_kind: options.when.kind, when_source: "explicit", when_label: null } : undefined,
      meta: { event_id: eventId, ...(options.when ? { when: true } : {}) }, now, priorLengthUtf16: String(row.content).length,
      guard: p => buildCasGuard(p, { content: row.content, tags: row.tags, source: row.source, created_at: row.created_at,
        vector_ids: row.vector_ids, pending_append_passages: previousPendingJson, workspace_id: authorizedWorkspaceId ?? "" }),
    });
    if (operationId && requestHash) {
      const [, updateResult] = await env.DB.batch([
        snapshot, update, pruneStatement(env, id, config.VERSION_KEEP),
        env.DB.prepare(
          // scope-exempt: the nested lookup verifies the same already-authorized entry id and write marker before recording an idempotency receipt
          `INSERT INTO append_receipts
             (entry_id, operation_id, request_hash, indexed, completed_at)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM entries
              WHERE id = ? AND content = ? AND tags = ? AND source = ?
                AND created_at = ? AND vector_ids = ? AND pending_append_passages = ? AND write_marker IS ?
           )
           ON CONFLICT(entry_id) DO UPDATE SET
             operation_id = excluded.operation_id,
             request_hash = excluded.request_hash,
             indexed = excluded.indexed,
             completed_at = excluded.completed_at`,
        ).bind(
          id, operationId, requestHash, indexed ? 1 : 0, now,
          id, newContent, JSON.stringify(refreshedTags), currentSource,
          row.created_at, committedVectorIdsJson, committedPendingJson, appendMarker,
        ),
        ...holds,
      ]);
      committed = updateResult;
    } else {
      const results = await env.DB.batch([snapshot, update, pruneStatement(env, id, config.VERSION_KEEP), ...holds]);
      committed = results[1];
    }
  } catch (error) {
    if (cleanupOpId) {
      try {
        await markVectorCleanupReady(env, cleanupOpId);
        await settleVectorCleanupOp(env, cleanupOpId, id, newVectorIds);
      } catch { /* durable row remains */ }
    }
    if (operationId && requestHash) {
      const replay = replayedAppend(
        await readAppendReceipt(env, operationId), id, requestHash, String(row.content).length,
      );
      if (replay) return { ...replay, wasCanonical: false, eventId };
    }
    throw error;
  }
  if (!d1Changed(committed)) {
    if (cleanupOpId) {
      await markVectorCleanupReady(env, cleanupOpId);
      await settleVectorCleanupOp(env, cleanupOpId, id, newVectorIds);
    }
    if (operationId && requestHash) {
      const replay = replayedAppend(
        await readAppendReceipt(env, operationId), id, requestHash, String(row.content).length,
      );
      if (replay) return { ...replay, wasCanonical: false, eventId };
    }
    if (attempt < WRITE_CAS_ATTEMPTS) return appendToEntry(env, id, _existingContent, addition, _tags, source,
      config, volatility, writeCtx, change, when, authorizedWorkspaceId, ctx, forkOptions, attempt + 1);
    throw new WriteConflictError();
  }
  if (cleanupOpId && !cleanupNeedsRetry) {
    // The entry now references every inserted ID, so this is only journal hygiene.
    // Let the response leave first; a cancelled task is repaired by the scheduled drain.
    defer(
      deleteVectorCleanupOp(env, cleanupOpId)
        .catch(error => console.error("Vector cleanup journal clear failed (non-fatal):", error)),
    );
  }

  if (heldRow && existingVectorIds.length) await discardUpload(env, id, existingVectorIds);
  if (indexed) {
    const values = vectors.map(vector => Array.from(vector.values));
    if (committedVectorIds.length > APPEND_VECTOR_COMPACTION_THRESHOLD) {
      // Compaction is derived maintenance: D1 already holds the authoritative appended
      // content and every current vector remains valid until this guarded replacement
      // commits. A timeout or CAS loss is therefore safe to log and retry on a later
      // append, never a reason to turn the successful source write into a 5xx response.
      defer(
        storeMigrationEntry(env, id, newContent, refreshedTags, currentSource, Date.now(), config, {
          workspaceId: String(row.workspace_id ?? ""),
          actorId: "",
        }, {
          expectedContent: newContent,
          expectedTagsJson: JSON.stringify(refreshedTags),
          expectedSource: currentSource,
          expectedCreatedAt: row.created_at as number,
          expectedVectorIdsJson: committedVectorIdsJson,
          oldVectorIds: committedVectorIds,
          afterCommitVectors: async compactedVectors => {
            const sampled = representativeVectors(compactedVectors).map(vector => vector.values);
            const neighbors = await neighborsFromVectorQueries(sampled, env);
            await replaceInferredEdgesOnWrite([{ entryId: id, neighbors }], env);
          },
        }).catch(error => console.error("Append vector compaction deferred (non-fatal):", error)),
      );
    } else {
      // Graph edges are derived state and the nightly pass can rebuild them. Keeping this
      // tracked by ctx preserves the migration admission without making a committed append
      // look like a 503 when graph work exhausts the remaining CPU budget.
      defer(
        neighborsFromVectorQueries(values, env)
          .then(neighbors => inferEdgesOnWrite(id, neighbors, env))
          .catch(error => console.error("Append auto-link failed (non-fatal):", error)),
      );
    }
  }

  await Promise.allSettled(background);
  await touchStandingIfNeeded(env, ctx, config, String(row.workspace_id ?? ""), currentTags, refreshedTags);
  return {
    wasCanonical, eventId, held, indexed,
    ...(semanticUnavailableReason ? { semanticUnavailableReason } : {}),
    ...(semanticRetryAt ? { semanticRetryAt } : {}),
    replayed: false,
    rollover: memoryRolloverAdvice(newContent.length),
  };
}


export type PendingAppendRecoveryResult = "indexed" | "none" | "stale" | "requires_full_index";

/**
 * Index one durable append passage after Workers AI or Vectorize recovers.
 *
 * The remote mutation is journaled before it is submitted, and the D1 commit is
 * guarded by the exact content/vector/queue snapshot. A concurrent append either
 * lands before this read or makes this CAS lose; it can never be silently removed
 * from the queue. Entries with no vectors are deliberately left to storeEntry's
 * full-content repair so their pre-append text cannot be skipped.
 */
export async function indexPendingAppendPassage(
  env: Env,
  id: string,
  config: Readonly<Config> = DEFAULTS,
): Promise<PendingAppendRecoveryResult> {
  await assertMemoryWritesAllowed(env);
  const row = await env.DB.prepare(
    // scope-exempt: bounded owner/scheduled maintenance reads one exact queued entry
    `SELECT content, tags, source, created_at, vector_ids, workspace_id, pending_append_passages
       FROM entries WHERE id = ? AND ${INDEXABLE_SQL}`,
  ).bind(id).first<Record<string, unknown>>();
  if (!row) return "none";

  const existingVectorIds = parseVectorIds(row.vector_ids);
  if (!existingVectorIds.length) return "requires_full_index";
  const queued = parsePendingAppendPassages(row.pending_append_passages);
  const passage = queued[0];
  if (!passage) return "none";

  const tags = (() => {
    try {
      const value = JSON.parse(typeof row.tags === "string" ? row.tags : "[]");
      return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string") : [];
    } catch {
      return [];
    }
  })();
  const source = String(row.source ?? "api");
  validateIndexableMemory(id, passage.content, tags, source);

  const chunks = chunkText(passage.content);
  const vectorPrefix = `v-${crypto.randomUUID()}`;
  const vectors: VectorizeVector[] = await Promise.all(chunks.map(async (chunk, index) => ({
    id: `${vectorPrefix}-${index}`,
    values: await embedDocument(chunk, env, config),
    metadata: {
      ...vectorMetadata(
        id,
        chunk,
        index,
        chunks.length,
        tags,
        source,
        passage.createdAt,
        embeddingMetadata(),
        String(row.workspace_id ?? ""),
      ),
      isUpdate: true,
      pendingPassageId: passage.id,
    },
  })));
  const newVectorIds = vectors.map(vector => vector.id);
  const cleanupOpId = await recordVectorCleanup(env, id, newVectorIds);

  try {
    await authorizeVectorMutation(env, cleanupOpId);
    // Recovery can be retried after an ambiguous transport failure. Upsert makes
    // re-submitting the same attempt harmless; IDs remain write-unique so an old
    // cleanup tombstone can never delete a later attempt.
    for (let i = 0; i < vectors.length; i += VECTORIZE_UPSERT_BATCH) {
        await env.VECTORIZE.upsert(vectors.slice(i, i + VECTORIZE_UPSERT_BATCH));
      }
    await markVectorCleanupReady(env, cleanupOpId);
  } catch (error) {
    try {
      await markVectorCleanupReady(env, cleanupOpId);
      await settleVectorCleanupOp(env, cleanupOpId, id, newVectorIds);
    } catch { /* durable row remains */ }
    throw error;
  }

  const remaining = queued.slice(1);
  const committedVectorIdsJson = JSON.stringify([...existingVectorIds, ...newVectorIds]);
  const remainingJson = JSON.stringify(remaining);
  const marker = memoryWriteMarker(env);
  const sourceUpdate = env.DB.prepare(
    // versioning: exempt: append recovery only commits derived vectors and its queue
    `UPDATE entries
        SET vector_ids = ?, pending_append_passages = ?, write_marker = ?
      WHERE id = ? AND content = ? AND source = ? AND created_at = ?
        AND vector_ids = ? AND pending_append_passages = ? AND workspace_id = ? AND tags = ? AND ${INDEXABLE_SQL}
        AND EXISTS (SELECT 1 FROM vector_cleanup_ops WHERE op_id = ? AND ready = 1)`,
  ).bind(
    committedVectorIdsJson, remainingJson, marker,
    id, row.content, source, row.created_at,
    row.vector_ids, row.pending_append_passages, String(row.workspace_id ?? ""), row.tags, cleanupOpId,
  );

  let update: D1Result;
  try {
    if (passage.operationId) {
      const [updateResult] = await env.DB.batch([
        sourceUpdate,
        env.DB.prepare(
          // scope-exempt: updates only the idempotency receipt for the exact queued entry and operation already selected by owner/scheduled maintenance
          `UPDATE append_receipts SET indexed = 1, completed_at = ?
            WHERE entry_id = ? AND operation_id = ?
              AND EXISTS (
                SELECT 1 FROM entries WHERE id = ? AND vector_ids = ?
                  AND pending_append_passages = ? AND write_marker IS ?
              )`,
        ).bind(
          Date.now(), id, passage.operationId,
          id, committedVectorIdsJson, remainingJson, marker,
        ),
      ]);
      update = updateResult;
    } else {
      update = await sourceUpdate.run();
    }
  } catch (error) {
    try { await settleVectorCleanupOp(env, cleanupOpId, id, newVectorIds); } catch { /* durable row remains */ }
    throw error;
  }

  if (!d1Changed(update)) {
    await settleVectorCleanupOp(env, cleanupOpId, id, newVectorIds);
    return "stale";
  }
  try {
    await deleteVectorCleanupOp(env, cleanupOpId);
  } catch (error) {
    console.error("Vector cleanup journal clear failed after pending append recovery (non-fatal):", error);
  }
  return "indexed";
}

export type AppendEntryResult = {
  indexed: boolean;
  /** Why the appended passage is waiting for the durable recovery loop. */
  semanticUnavailableReason?: "workers_ai_quota_exhausted" | "vectorize_unavailable";
  /** Provider reset time when Workers AI reported a daily quota exhaustion. */
  semanticRetryAt?: number;
  /** True when operationId identifies an append that was already committed. */
  replayed: boolean;
  /** Additive advisory; append itself remains compatible up to the existing hard cap. */
  rollover: MemoryRolloverAdvice;
};

export interface AppendEntryOptions {
  when?: { at: number; kind: "due" | "event" | "wake"; source: "explicit" };
  volatility?: Volatility;
  /** Caller-generated idempotency key. Reuse the same value only when retrying. */
  operationId?: string;
}
