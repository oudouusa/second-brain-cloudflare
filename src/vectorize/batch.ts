import type { Env } from "../env";
import { VECTORIZE_DELETE_MAX_IDS_PER_CALL, VECTORIZE_GET_BY_IDS_BATCH, VECTORIZE_UPSERT_BATCH } from "../constants";
import { D1BudgetExceededError, reserveD1Sql } from "../runtime/d1-budget";

/** Vector ids an entry claims as its own: what its row lists, an upload it made, or ids derived for it. */
export interface OwnedVectors { entryId: string; vectorIds: readonly string[] }

export interface DeleteEntryVectorsResult {
  /** False only when opts.maxIds cut the call short; `remaining` is everything not yet checked. */
  done: boolean;
  /** Ids this call did not reach, grouped by the entry that claims them, for a caller to persist and resume. */
  remaining: OwnedVectors[];
}

/**
 * The only way this codebase deletes vectors (T-0089.1.1). A vector is deleted only if its own
 * metadata.parentId names an entry that claims it: entry ids are arbitrary, so a 3.7 id like
 * `x-chunk-0` can be another entry's vector id too, and a name alone never proves ownership. A
 * vector with no parentId (written before that field existed) is deleted only under the claiming
 * entry's own id, the one name that could only ever have been that entry's single vector.
 * Reads in batches of VECTORIZE_GET_BY_IDS_BATCH (Vectorize's getByIds limit); ids already gone are skipped.
 *
 * `opts.maxIds` (FX3 finding 2) caps how many ids one call checks and deletes: a removed member's
 * vectors can run into the tens of thousands, and one getByIds per 20 ids without a cap can exceed
 * the platform's 1,000-subrequest ceiling before a single deleteByIds runs, losing those vectors
 * for good (the D1 rows that named them are already gone by the time this runs). Uncapped callers
 * — every ordinary per-entry delete — are unaffected: `done` is always true and `remaining` empty.
 */
export async function deleteEntryVectors(
  env: Env,
  owned: readonly OwnedVectors[],
  opts: { maxIds?: number } = {},
): Promise<DeleteEntryVectorsResult> {
  const claimants = new Map<string, Set<string>>();
  for (const o of owned) for (const v of o.vectorIds) (claimants.get(v) ?? claimants.set(v, new Set()).get(v)!).add(o.entryId);
  const allIds = [...claimants.keys()];
  if (!allIds.length) return { done: true, remaining: [] };

  const cap = opts.maxIds ?? allIds.length;
  const ids = allIds.slice(0, cap);
  const leftoverIds = new Set(allIds.slice(cap));

  const doomed: string[] = [];
  const ownersById = new Map<string, string>();
  for (let i = 0; i < ids.length; i += VECTORIZE_GET_BY_IDS_BATCH) {
    const found = await env.VECTORIZE.getByIds(ids.slice(i, i + VECTORIZE_GET_BY_IDS_BATCH));
    for (const v of found) {
      const parentId = (v.metadata as { parentId?: unknown } | undefined)?.parentId;
      const owners = claimants.get(v.id);
      if (!owners) continue;
      if (typeof parentId === "string" ? owners.has(parentId) : owners.has(v.id)) {
        doomed.push(v.id);
        ownersById.set(v.id, typeof parentId === "string" ? parentId : v.id);
      }
    }
  }
  const { recordVectorCleanup, markVectorCleanupReady, settleVectorCleanupOp,
    recordVectorCleanupBatch, submitVectorCleanupBatch } = await import("./cleanup");
  if (owned.length > 1 && doomed.length) {
    const work = reserveD1Sql(env, 5);
    if (!work) throw new D1BudgetExceededError();
    try {
      const live = await work.env.DB.prepare(
        // scope-exempt: 認可済み削除対象のIDだけを再読し、現行の索引参照を保護する。本文は読まない。
        // validity: any: 期限切れの行も索引を参照しうるため、削除から保護する。
        `SELECT id, vector_ids FROM entries WHERE id IN (SELECT value FROM json_each(?))`,
      ).bind(JSON.stringify(owned.map(o => o.entryId))).all<{ id: string; vector_ids: string }>();
      const referenced = new Set((live.results ?? []).flatMap(r => JSON.parse(r.vector_ids || "[]") as string[]));
      const claims = [...new Set(owned.map(o => o.entryId))].map(entryId => ({ entryId,
        vectorIds: doomed.filter(id => ownersById.get(id) === entryId && !referenced.has(id)) }));
      const operations = await recordVectorCleanupBatch(work.env, claims);
      await submitVectorCleanupBatch(work.env, operations);
    } finally { work.release(); }
  } else for (const o of owned) {
    const ids = doomed.filter(id => o.vectorIds.includes(id));
    if (!ids.length) continue;
    const op = await recordVectorCleanup(env, o.entryId, ids);
    await markVectorCleanupReady(env, op);
    await settleVectorCleanupOp(env, op, o.entryId, ids);
  }

  if (!leftoverIds.size) return { done: true, remaining: [] };
  const remaining: OwnedVectors[] = owned
    .map((o) => ({ entryId: o.entryId, vectorIds: o.vectorIds.filter((v) => leftoverIds.has(v)) }))
    .filter((o) => o.vectorIds.length);
  return { done: false, remaining };
}

/** Where a capped deleteEntryVectors call's leftover ids wait for drainPendingVectorDeletes. */
const PENDING_DELETES_KV_KEY = "vectorize:pending-deletes";

/**
 * Queues ids a capped deleteEntryVectors call did not reach (FX3 finding 2), merged with
 * anything already queued. Entry ids are unique in D1, so two queued batches can never name
 * the same entry — a plain concatenation is the whole merge.
 */
export async function persistPendingVectorDeletes(env: Env, remaining: readonly OwnedVectors[]): Promise<void> {
  if (!remaining.length) return;
  let stored: OwnedVectors[] = [];
  try {
    const raw = await env.OAUTH_KV.get(PENDING_DELETES_KV_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch (e) {
    console.error("Reading queued vector deletes failed (non-fatal):", e);
  }
  await env.OAUTH_KV.put(PENDING_DELETES_KV_KEY, JSON.stringify([...stored, ...remaining]));
}

/** Resumes whatever persistPendingVectorDeletes queued, capped the same way. Call from the nightly loop. */
export async function drainPendingVectorDeletes(env: Env, maxIds: number = VECTORIZE_DELETE_MAX_IDS_PER_CALL): Promise<void> {
  let stored: OwnedVectors[] = [];
  try {
    const raw = await env.OAUTH_KV.get(PENDING_DELETES_KV_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch (e) {
    console.error("Reading queued vector deletes failed (non-fatal):", e);
    return;
  }
  if (!stored.length) return;
  try {
    const result = await deleteEntryVectors(env, stored, { maxIds });
    if (result.done) await env.OAUTH_KV.delete(PENDING_DELETES_KV_KEY);
    else await env.OAUTH_KV.put(PENDING_DELETES_KV_KEY, JSON.stringify(result.remaining));
  } catch (e) {
    console.error("Draining queued vector deletes failed (non-fatal):", e);
  }
}

export async function deleteVectorIds(env: Env, ids: readonly string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += VECTORIZE_UPSERT_BATCH) await env.VECTORIZE.deleteByIds(ids.slice(i, i + VECTORIZE_UPSERT_BATCH) as string[]);
}
