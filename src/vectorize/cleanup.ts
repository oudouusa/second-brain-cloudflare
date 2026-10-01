import { deleteVectorIds } from "./batch";
import { VECTORIZE_UPSERT_BATCH, VECTORIZE_GET_BY_IDS_BATCH } from "../constants";
/**
 * Fork-owned durable vector cleanup. D1 tombstones are the source of truth;
 * remote delete receipts are not completion until provider visibility agrees.
 * Keep this module below capture/store: it must never import capture orchestration.
 */
import type { Env } from "../env";
import { D1BudgetExceededError, hasD1Budget, remainingD1Sql, reserveD1Sql } from "../runtime/d1-budget";
import { memoryWriteMarker, renewMemoryWriteAdmission } from "../migration/write-lock";

interface VectorCleanupRow {
  op_id: string;
  entry_id: string;
  vector_ids: string;
  ready: number;
  expires_at: number;
}

const VECTOR_CLEANUP_ACTIVE_MS = 20 * 60 * 1000;
const VECTOR_CLEANUP_REDELETE_MS = 60 * 1000;
const VECTOR_CLEANUP_PAGE_SIZE = 10;

// A page ceiling is not an SQL bound: ready-state work has different costs.
// The nightly caller also reserves a state-aware SQL envelope below.
export const SCHEDULED_VECTOR_CLEANUP_MAX_PAGES = 3;

export const parseVectorIds = (raw: unknown): string[] => {
  try {
    const value = JSON.parse(typeof raw === "string" ? raw : "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};

interface VectorCleanupPayload {
  ids: string[];
  deleteMutationId?: string;
  deleteSubmittedAt?: number;
}

function parseVectorCleanupPayload(raw: unknown): VectorCleanupPayload {
  try {
    const value = JSON.parse(typeof raw === "string" ? raw : "[]") as unknown;
    if (Array.isArray(value)) {
      return { ids: value.filter((id): id is string => typeof id === "string") };
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return {
        ids: Array.isArray(record.ids)
          ? record.ids.filter((id): id is string => typeof id === "string")
          : [],
        ...(typeof record.deleteMutationId === "string"
          ? { deleteMutationId: record.deleteMutationId }
          : {}),
        ...(typeof record.deleteSubmittedAt === "number" && Number.isFinite(record.deleteSubmittedAt)
          ? { deleteSubmittedAt: record.deleteSubmittedAt }
          : {}),
      };
    }
  } catch {
    // Malformed legacy rows are safe to retain; they contain no deletable IDs.
  }
  return { ids: [] };
}

function cleanupPayload(ids: string[], mutationId: string | null, submittedAt: number): string {
  return JSON.stringify({
    ids,
    ...(mutationId ? { deleteMutationId: mutationId, deleteSubmittedAt: submittedAt } : {}),
  } satisfies VectorCleanupPayload);
}

export async function recordVectorCleanup(
  env: Env,
  entryId: string,
  vectorIds: string[],
  privilegedMarker?: string,
): Promise<string> {
  const opId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO vector_cleanup_ops
       (op_id, entry_id, vector_ids, created_at, ready, expires_at, write_marker)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  ).bind(
    opId,
    entryId,
    JSON.stringify([...new Set(vectorIds)]),
    now,
    now + VECTOR_CLEANUP_ACTIVE_MS,
    privilegedMarker ?? memoryWriteMarker(env),
  ).run();
  return opId;
}

export async function markVectorCleanupReady(env: Env, opId: string, privilegedMarker?: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE vector_cleanup_ops SET ready = 1, write_marker = ? WHERE op_id = ? AND ready = 0`,
  ).bind(privilegedMarker ?? memoryWriteMarker(env), opId).run();
}

/** 所有者確認済みの一括削除を、記憶ごとに復旧できる台帳へ一度で記録する。 */
export async function recordVectorCleanupBatch(
  env: Env, owned: { entryId: string; vectorIds: string[] }[],
): Promise<{ opId: string; vectorIds: string[] }[]> {
  const operations = owned.filter(o => o.vectorIds.length).map(o => ({ ...o, opId: crypto.randomUUID() }));
  if (!operations.length) return [];
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO vector_cleanup_ops
    (op_id, entry_id, vector_ids, created_at, ready, expires_at, write_marker)
    SELECT json_extract(value, '$.opId'), json_extract(value, '$.entryId'),
      json_extract(value, '$.vectorIds'), ?, 1, ?, ? FROM json_each(?)`)
    .bind(now, now + VECTOR_CLEANUP_ACTIVE_MS, memoryWriteMarker(env), JSON.stringify(operations)).run();
  return operations;
}

export async function authorizeVectorMutation(
  env: Env,
  opId: string,
  privilegedMarker?: string,
  capabilityErrorMessage = "Vector mutation capability was lost",
): Promise<void> {
  // Final-delta writes are authorized by the short-lived D1 migration lease.
  // Their request admission is intentionally drained before the exclusive lock,
  // so renewing that ordinary capability here would reject the privileged path.
  if (!privilegedMarker) await renewMemoryWriteAdmission(env);
  const result = await env.DB.prepare(
    `UPDATE vector_cleanup_ops SET write_marker = ? WHERE op_id = ?`,
  ).bind(privilegedMarker ?? memoryWriteMarker(env), opId).run();
  const changed = Number((result.meta as D1Result["meta"] & { rows_written?: number }).changes
    ?? (result.meta as D1Result["meta"] & { rows_written?: number }).rows_written
    ?? 0);
  if (changed !== 1) throw new Error(capabilityErrorMessage);
}

export async function deleteVectorCleanupOp(
  env: Env,
  opId: string,
  privilegedMarker?: string,
): Promise<void> {
  if (privilegedMarker) {
    await env.DB.prepare(`DELETE FROM vector_cleanup_ops WHERE op_id = ?`).bind(opId).run();
    return;
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE vector_cleanup_ops SET write_marker = ? WHERE op_id = ?`)
      .bind(memoryWriteMarker(env, "delete"), opId),
    env.DB.prepare(`DELETE FROM vector_cleanup_ops WHERE op_id = ?`).bind(opId),
  ]);
}

/**
 * forget/deprecateで確定した削除を一度だけ送信する。通常cleanupの3回再試行や
 * receipt形式へ切り替えず、従来どおり台帳を60秒後の再確認に残す。
 */
export async function submitLifecycleVectorCleanup(
  env: Env,
  opId: string,
  entryId: string,
  vectorIds: string[],
  beforeRemote?: () => Promise<void> | void,
): Promise<void> {
  if (!vectorIds.length) {
    await deleteVectorCleanupOp(env, opId);
    return;
  }
  // validity: any: ID再利用後に現行行が参照する索引も、別所有者の索引も削除しない。
  // scope-exempt: 認可済みlifecycle対象のID再利用後の参照を確認する。本文は取得しない。
  const row = await env.DB.prepare(`SELECT vector_ids FROM entries WHERE id = ?`).bind(entryId).first<{ vector_ids: string }>();
  const referenced = new Set(parseVectorIds(row?.vector_ids));
  const unreferenced = await excludeForeignVectors(env, entryId, vectorIds.filter(id => !referenced.has(id)));
  await authorizeVectorMutation(env, opId, undefined, "Vector cleanup capability was lost");
  await beforeRemote?.();
  await deleteVectorIds(env, unreferenced);
  await env.DB.prepare(
    `UPDATE vector_cleanup_ops SET ready = 3, expires_at = ?, write_marker = ? WHERE op_id = ?`,
  ).bind(Date.now() + VECTOR_CLEANUP_REDELETE_MS, memoryWriteMarker(env), opId).run();
}

/** 可視vectorの所有者が別entryなら削除しない。未可視IDは遅延upsertに備え台帳に残す。 */
async function excludeForeignVectors(env: Env, entryId: string, ids: string[]): Promise<string[]> {
  const foreign = new Set<string>();
  for (let i = 0; i < ids.length; i += VECTORIZE_GET_BY_IDS_BATCH) {
    const found = await env.VECTORIZE.getByIds(ids.slice(i, i + VECTORIZE_GET_BY_IDS_BATCH));
    for (const vector of found) {
      const parentId = vector.metadata?.parentId;
      if (typeof parentId === "string" ? parentId !== entryId : vector.id !== entryId) foreign.add(vector.id);
    }
  }
  return ids.filter(id => !foreign.has(id));
}

async function deleteVectorsWithRetry(env: Env, vectorIds: string[]): Promise<string | null> {
  if (!vectorIds.length) return null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (vectorIds.length > VECTORIZE_UPSERT_BATCH) {
        await deleteVectorIds(env, vectorIds);
        // 複数のreceiptを単一receiptと誤認せず、既存の再削除確認へ渡す。
        return null;
      }
      const result = await env.VECTORIZE.deleteByIds(vectorIds);
      // V1-compatible local doubles return void or { ids, count }; production's V2
      // binding returns the receipt. Absence is the explicit legacy fallback below.
      return typeof result?.mutationId === "string" ? result.mutationId : null;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function cleanupDeleteWasProcessed(env: Env, payload: VectorCleanupPayload): Promise<boolean> {
  if (!payload.deleteMutationId || payload.deleteSubmittedAt === undefined) return false;
  let description: VectorizeIndexInfo;
  try {
    description = await env.VECTORIZE.describe();
  } catch {
    return false;
  }
  if (String(description.processedUpToMutation) === payload.deleteMutationId) return true;
  // Workerd's generated type currently says number while its own doc comment says ISO
  // datetime. Accept both provider shapes explicitly at this upgrade boundary.
  const processedRaw: unknown = description.processedUpToDatetime;
  const processedAt = typeof processedRaw === "number"
    ? (processedRaw < 10_000_000_000 ? processedRaw * 1000 : processedRaw)
    : typeof processedRaw === "string"
      ? Date.parse(processedRaw)
      : Number.NaN;
  return Number.isFinite(processedAt) && processedAt >= payload.deleteSubmittedAt;
}

export async function settleVectorCleanupOp(
  env: Env,
  opId: string,
  entryId: string,
  candidates: string[],
  options: { privilegedMarker?: string; beforeRemote?: () => Promise<void> } = {},
): Promise<void> {
  const row = await env.DB.prepare(
    // scope-exempt: entryId is internal cleanup state created for a previously authorized write; this read only prevents deletion of vectors still referenced by that exact row
    // validity: any: 削除台帳の対象IDが現在も参照されていないか確認し、期限で削除権限を増やさない。
    `SELECT vector_ids FROM entries WHERE id = ?`,
  ).bind(entryId).first<{ vector_ids: string }>();
  const referenced = new Set(parseVectorIds(row?.vector_ids));
  const unreferenced = await excludeForeignVectors(env, entryId, candidates.filter(id => !referenced.has(id)));
  if (!unreferenced.length) {
    await deleteVectorCleanupOp(env, opId, options.privilegedMarker);
    return;
  }
  const mutation = reserveD1Sql(env, 3);
  if (!mutation) throw new D1BudgetExceededError();
  try {
    await options.beforeRemote?.();
    await authorizeVectorMutation(mutation.env, opId, options.privilegedMarker);
    const submittedAt = Date.now();
    const mutationId = await deleteVectorsWithRetry(mutation.env, unreferenced);
    // V2 acknowledgements only enqueue mutations. Persist the receipt and do not
    // clear the tombstone until describe() proves this delete (or a later mutation)
    // was processed and getByIds() confirms the private IDs are absent.
    await mutation.env.DB.prepare(
      `UPDATE vector_cleanup_ops SET ready = 3, expires_at = ?, vector_ids = ?, write_marker = ? WHERE op_id = ?`,
    ).bind(
      Date.now() + VECTOR_CLEANUP_REDELETE_MS,
      cleanupPayload(unreferenced, mutationId, submittedAt),
      options.privilegedMarker ?? memoryWriteMarker(mutation.env),
      opId,
    ).run();
  } finally { mutation.release(); }
}

/**
 * Submit one Vectorize delete for a bounded HTTP bulk action while retaining one
 * independently recoverable tombstone per entry. The capability is refreshed after the
 * D1 CAS batch and immediately before the remote mutation, so an invocation stalled
 * across a migration/restore barrier cannot mutate the new Vectorize generation.
 */
export async function submitVectorCleanupBatch(
  env: Env,
  operations: { opId: string; vectorIds: string[] }[],
): Promise<void> {
  const active = operations.filter(op => op.vectorIds.length > 0);
  const emptyIds = operations.filter(op => op.vectorIds.length === 0).map(op => op.opId);

  if (emptyIds.length) {
    const placeholders = "SELECT value FROM json_each(?)";
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE vector_cleanup_ops SET write_marker = ? WHERE op_id IN (${placeholders})`,
      ).bind(memoryWriteMarker(env, "delete"), JSON.stringify(emptyIds)),
      env.DB.prepare(
        `DELETE FROM vector_cleanup_ops WHERE op_id IN (${placeholders})`,
      ).bind(JSON.stringify(emptyIds)),
    ]);
  }
  if (!active.length) return;

  await renewMemoryWriteAdmission(env);
  const opIds = active.map(op => op.opId);
  const placeholders = "SELECT value FROM json_each(?)";
  const marker = memoryWriteMarker(env);
  const authorization = await env.DB.prepare(
    `UPDATE vector_cleanup_ops SET write_marker = ?
      WHERE ready = 1 AND op_id IN (${placeholders})`,
  ).bind(marker, JSON.stringify(opIds)).run();
  const changed = Number((authorization.meta as D1Result["meta"] & { rows_written?: number }).changes
    ?? (authorization.meta as D1Result["meta"] & { rows_written?: number }).rows_written
    ?? 0);
  if (changed !== opIds.length) throw new Error("Vector cleanup capability was lost");

  const vectorIds = [...new Set(active.flatMap(op => op.vectorIds))];
  const submittedAt = Date.now();
  const mutationId = await deleteVectorsWithRetry(env, vectorIds);
  if (mutationId) {
    await env.DB.prepare(
      `UPDATE vector_cleanup_ops
          SET ready = 3,
              expires_at = ?,
              vector_ids = json_object(
                'ids', json(vector_ids),
                'deleteMutationId', ?,
                'deleteSubmittedAt', ?
              ),
              write_marker = ?
        WHERE op_id IN (${placeholders})`,
    ).bind(Date.now() + VECTOR_CLEANUP_REDELETE_MS, mutationId, submittedAt, marker, JSON.stringify(opIds)).run();
  } else {
    // Legacy/local bindings provide no receipt. Keep the original per-entry ID arrays;
    // drainPendingVectorCleanup performs the established second-delete confirmation.
    await env.DB.prepare(
      `UPDATE vector_cleanup_ops SET ready = 3, expires_at = ?, write_marker = ?
        WHERE op_id IN (${placeholders})`,
    ).bind(Date.now() + VECTOR_CLEANUP_REDELETE_MS, marker, JSON.stringify(opIds)).run();
  }
}

/**
 * Finish durable Vectorize tombstones left by a cancelled request or a transient
 * delete failure. Only IDs no longer referenced by the current D1 row are removed,
 * so deterministic IDs reused by a newer concurrent write are preserved.
 */
interface VectorCleanupDrainOptions {
  forceActive?: boolean;
  privilegedMarker?: string;
  beforeRemote?: () => Promise<void>;
  /** Defaults to one so request/migration callers retain the established cost. */
  maxPages?: number;
  /** Nightly-only envelope, counting every SQL including receipt/finalization writes. */
  sqlBudget?: number;
}

async function drainPendingVectorCleanupPage(
  env: Env,
  options: VectorCleanupDrainOptions,
  excludedOpIds: readonly string[],
): Promise<{ completed: number; selectedOpIds: string[] }> {
  const predicates: string[] = [];
  const bindings: unknown[] = [];
  if (!options.forceActive) {
    predicates.push("(ready = 1 OR expires_at <= ?)");
    bindings.push(Date.now());
  }
  if (excludedOpIds.length) {
    predicates.push(`op_id NOT IN (${excludedOpIds.map(() => "?").join(", ")})`);
    bindings.push(...excludedOpIds);
  }
  const cleanupQuery = env.DB.prepare(
    `SELECT op_id, entry_id, vector_ids, ready, expires_at
       FROM vector_cleanup_ops
       ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}
      ORDER BY created_at ASC LIMIT ${VECTOR_CLEANUP_PAGE_SIZE}`,
  );
  const { results } = bindings.length
    ? await cleanupQuery.bind(...bindings).all<VectorCleanupRow>()
    : await cleanupQuery.all<VectorCleanupRow>();
  const now = Date.now();
  const selected = results ?? [];
  if (!selected.length) return { completed: 0, selectedOpIds: [] };
  const retirement = reserveD1Sql(env, 2);
  if (!retirement) throw new D1BudgetExceededError();
  try {
    const claimableIds = selected.filter(op => op.ready === 0 || op.ready === 1).map(op => op.op_id);
    if (claimableIds.length) {
      const placeholders = claimableIds.map(() => "?").join(", ");
      const claim = env.DB.prepare(
        `UPDATE vector_cleanup_ops SET ready = 2, expires_at = ?, write_marker = ?
          WHERE ready IN (0, 1) AND op_id IN (${placeholders})
          ${options.forceActive ? "" : "AND expires_at <= ?"}`,
      );
      if (options.forceActive) await claim.bind(now + VECTOR_CLEANUP_ACTIVE_MS, options.privilegedMarker ?? memoryWriteMarker(env), ...claimableIds).run();
      else {
        // ready=1 is immediately claimable because its upsert acknowledged; only
        // ready=0 must first reach its active-write expiry.
        await env.DB.prepare(
          `UPDATE vector_cleanup_ops SET ready = 2, expires_at = ?, write_marker = ?
            WHERE op_id IN (${placeholders})
              AND (ready = 1 OR (ready = 0 AND expires_at <= ?))`,
        ).bind(now + VECTOR_CLEANUP_ACTIVE_MS, options.privilegedMarker ?? memoryWriteMarker(env), ...claimableIds, now).run();
      }
    }
    // ready=0 is only quarantined on the first pass: its remote upsert may still
    // be in flight and could otherwise land after our delete. ready=1 is an
    // acknowledged upsert; ready=2 is safe only after the quarantine grace.
    const claimed = selected.filter(op => op.ready === 1
      || ((op.ready === 2 || op.ready === 3) && op.expires_at <= now));
    const entryIds = [...new Set(claimed.map(op => op.entry_id))];
    const referencedByEntry = new Map<string, Set<string>>();
    if (entryIds.length) {
      const placeholders = entryIds.map(() => "?").join(", ");
      const { results: rows } = await env.DB.prepare(
        // scope-exempt: entryIds come exclusively from deployment maintenance cleanup records and are used to avoid deleting vectors still referenced by those exact rows
        // validity: any: 削除台帳の対象IDが現在も参照されていないか確認し、期限で削除権限を増やさない。
        `SELECT id, vector_ids FROM entries WHERE id IN (${placeholders})`,
      ).bind(...entryIds).all<{ id: string; vector_ids: string }>();
      for (const row of rows ?? []) referencedByEntry.set(row.id, new Set(parseVectorIds(row.vector_ids)));
    }
    const completed: string[] = [];
    let lastError: unknown;
    for (const op of claimed) {
      try {
        const referenced = referencedByEntry.get(op.entry_id) ?? new Set<string>();
        const payload = parseVectorCleanupPayload(op.vector_ids);
        const unreferenced = await excludeForeignVectors(env, op.entry_id, payload.ids.filter(id => !referenced.has(id)));
        if (!unreferenced.length) {
          completed.push(op.op_id);
        } else if (op.ready === 3 && payload.deleteMutationId) {
          if (!await cleanupDeleteWasProcessed(env, payload)) continue;
          const visible = await env.VECTORIZE.getByIds(unreferenced);
          if (!visible.length) {
            completed.push(op.op_id);
            continue;
          }
          const mutation = reserveD1Sql(env, 3);
          if (!mutation) break; // selected durable rows remain owed; retirement is still reserved
          try {
            const submittedAt = Date.now();
            await options.beforeRemote?.();
            await authorizeVectorMutation(mutation.env, op.op_id, options.privilegedMarker);
            const mutationId = await deleteVectorsWithRetry(mutation.env, unreferenced);
            await mutation.env.DB.prepare(
              `UPDATE vector_cleanup_ops SET ready = 3, expires_at = ?, vector_ids = ?, write_marker = ? WHERE op_id = ?`,
            ).bind(
              Date.now() + VECTOR_CLEANUP_REDELETE_MS,
              cleanupPayload(unreferenced, mutationId, submittedAt),
              options.privilegedMarker ?? memoryWriteMarker(mutation.env),
              op.op_id,
            ).run();
          } finally { mutation.release(); }
        } else {
          const mutation = reserveD1Sql(env, 3);
          if (!mutation) break; // selected durable rows remain owed; retirement is still reserved
          try {
            const submittedAt = Date.now();
            await options.beforeRemote?.();
            await authorizeVectorMutation(mutation.env, op.op_id, options.privilegedMarker);
            const mutationId = await deleteVectorsWithRetry(mutation.env, unreferenced);
            // V1/legacy test doubles do not return mutation receipts. Preserve the old
            // two-delete fallback for those only; production V2 always returns a receipt.
            if (op.ready === 3 && !mutationId) completed.push(op.op_id);
            else {
              await mutation.env.DB.prepare(
                `UPDATE vector_cleanup_ops SET ready = 3, expires_at = ?, vector_ids = ?, write_marker = ? WHERE op_id = ?`,
              ).bind(
                Date.now() + VECTOR_CLEANUP_REDELETE_MS,
                cleanupPayload(unreferenced, mutationId, submittedAt),
                options.privilegedMarker ?? memoryWriteMarker(mutation.env),
                op.op_id,
              ).run();
            }
          } finally { mutation.release(); }
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (completed.length) {
      const placeholders = completed.map(() => "?").join(", ");
      await retirement.env.DB.batch([
        retirement.env.DB.prepare(
          `UPDATE vector_cleanup_ops SET write_marker = ? WHERE op_id IN (${placeholders})`,
        ).bind(options.privilegedMarker ?? memoryWriteMarker(retirement.env, "delete"), ...completed),
        retirement.env.DB.prepare(
          `DELETE FROM vector_cleanup_ops WHERE op_id IN (${placeholders})`,
        ).bind(...completed),
      ]);
    }
    if (lastError) throw lastError;
    return { completed: completed.length, selectedOpIds: selected.map(op => op.op_id) };
  } finally { retirement.release(); }
}

export async function drainPendingVectorCleanup(
  env: Env,
  options: VectorCleanupDrainOptions = {},
): Promise<number> {
  if (options.sqlBudget !== undefined && (!Number.isSafeInteger(options.sqlBudget) || options.sqlBudget < 4)) {
    throw new RangeError("Cleanup SQL envelope must be at least four statements");
  }
  if (options.sqlBudget !== undefined && !hasD1Budget(env)) {
    throw new TypeError("Cleanup SQL envelope requires an invocation budget");
  }
  const allowance = options.sqlBudget === undefined ? null
    : reserveD1Sql(env, Math.min(options.sqlBudget, remainingD1Sql(env)));
  if (options.sqlBudget !== undefined && (!allowance || remainingD1Sql(allowance.env) < 4)) {
    allowance?.release();
    return 0;
  }
  if (allowance) env = allowance.env;
  try {
    const requestedPages = typeof options.maxPages === "number" && Number.isFinite(options.maxPages)
      ? Math.floor(options.maxPages)
      : 1;
    const maxPages = Math.min(
      SCHEDULED_VECTOR_CLEANUP_MAX_PAGES,
      Math.max(1, requestedPages),
    );
    const selectedOpIds = new Set<string>();
    let completed = 0;

    for (let page = 0; page < maxPages; page++) {
      if (remainingD1Sql(env) < 4) break;
      const result = await drainPendingVectorCleanupPage(env, options, [...selectedOpIds]);
      completed += result.completed;
      result.selectedOpIds.forEach(opId => selectedOpIds.add(opId));
      if (result.selectedOpIds.length < VECTOR_CLEANUP_PAGE_SIZE) break;
    }

    return completed;
  } finally { allowance?.release(); }
}
