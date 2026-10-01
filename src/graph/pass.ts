import type { Env } from "../env";
import { memoryWriteMarker } from "../migration/write-lock";
import { resolveConfig } from "../config";
import { initializeDatabase } from "../db/init";
import { embedDocument } from "../lib/ai";
import { chunkText } from "../text/chunk";
import {
  decideInferredEdge,
  EDGE_INFERENCE_POLICY,
  EDGE_INFER_UNTAGGED_THRESHOLD,
  replaceInferredEdgesOnWrite,
  type InferenceRecalculation,
} from "./edges";
import { neighborsFromVectorQueries, representativeVectors } from "./traverse";
import { NOT_HELD_SQL, notHeldSqlFor } from "../quarantine/tags";

const GRAPH_PASS_RECOMPUTE_LIMIT = 8;
const EDGE_PRUNE_SCAN_LIMIT = 90;
/** Upstream weekly maintenance shares the existing nightly trigger. */
export const GRAPH_SWEEP_WEEKDAY_UTC = 0;

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

async function pruneIncompatibleInferredEdges(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    // scope-exempt: this bounded scheduled graph-maintenance pass prunes incompatible inferred edges across the deployment and returns no corpus rows to a caller
    `SELECT x.id, x.weight, source.tags AS source_tags, target.tags AS target_tags
       FROM edges x
       JOIN entries source ON source.id = x.source_id
       JOIN entries target ON target.id = x.target_id
      WHERE x.provenance = 'inferred' AND x.type = 'relates_to' AND x.weight < ?
      ORDER BY COALESCE(x.updated_at, x.created_at) ASC
      LIMIT ${EDGE_PRUNE_SCAN_LIMIT}`,
  ).bind(EDGE_INFER_UNTAGGED_THRESHOLD).all() as {
    results: { id: string; weight: number; source_tags: string; target_tags: string }[];
  };
  const ids = results
    .filter(row => !decideInferredEdge(row.weight, parseTags(row.source_tags), parseTags(row.target_tags)).eligible)
    .map(row => row.id);
  if (!ids.length) return;

  const placeholders = ids.map(() => "?").join(", ");
  await env.DB.batch([
    env.DB.prepare(`UPDATE edges SET write_marker = ? WHERE id IN (${placeholders})`)
      .bind(memoryWriteMarker(env, "delete"), ...ids),
    // scope-exempt: ids came from the bounded deployment-wide maintenance scan immediately above and are not request-controlled
    env.DB.prepare(`DELETE FROM edges WHERE id IN (${placeholders})`).bind(...ids),
  ]);
}

interface GraphRefreshEntry {
  id: string;
  content: string;
  created_at?: number;
}

type RefreshCursor = { createdAt: number; id: string };

function refreshCursorKey(workspaceId: string): string {
  return `graph:refresh-cursor:${JSON.stringify([EDGE_INFERENCE_POLICY, workspaceId])}`;
}

/** One keyset window per workspace; zero neighbors still advances the scan.
 * Old-policy and unlinked entries share the window so neither class can starve
 * the other. A wrap revisits failed/no-neighbor entries and edited content.
 * KV is a best-effort operational cursor, never evidence that an edge was written.
 */
async function rotatingRefreshEntries(env: Env, workspaceId: string, limit: number): Promise<GraphRefreshEntry[]> {
  let cursor: RefreshCursor | null = null;
  try {
    const raw = await env.OAUTH_KV.get(refreshCursorKey(workspaceId));
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (value && typeof value === "object") {
      const c = value as Partial<RefreshCursor>;
      if (Number.isSafeInteger(c.createdAt) && typeof c.id === "string" && c.id.length > 0 && c.id.length <= 512) {
        cursor = c as RefreshCursor;
      }
    }
  } catch { console.error("Graph refresh cursor unavailable (non-fatal)"); }
  const query = async (after: RefreshCursor | null) => {
    const afterSql = after ? " AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))" : "";
    const { results } = await env.DB.prepare(
      // scope-checked: scheduled/manual workspace slice is bound before the keyset and LIMIT; no caller-visible cross-workspace rows
      `SELECT e.id, e.content, e.created_at FROM entries e
       WHERE ${notHeldSqlFor("e")} AND e.tags NOT LIKE '%"status:deprecated"%'
         AND e.tags NOT LIKE '%"duplicate-candidate"%'
         AND (EXISTS (
           SELECT 1 FROM edges x WHERE x.provenance = 'inferred' AND x.type = 'relates_to'
             AND (x.source_id = e.id OR x.target_id = e.id)
             AND COALESCE(x.metadata, '') NOT LIKE ?
         ) OR (NOT EXISTS (SELECT 1 FROM edges g WHERE g.source_id = e.id)
           AND NOT EXISTS (SELECT 1 FROM edges h WHERE h.target_id = e.id)))
         AND e.workspace_id = ?${afterSql}
       ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    ).bind(`%"inference_policy":"${EDGE_INFERENCE_POLICY}"%`, workspaceId,
      ...(after ? [after.createdAt, after.createdAt, after.id] : []), limit).all<GraphRefreshEntry>();
    return results;
  };
  const entries = await query(cursor);
  return entries.length || !cursor ? entries : query(null);
}

async function entriesNeedingRefresh(env: Env, workspaceId: string | null | undefined, limit: number): Promise<GraphRefreshEntry[]> {
  if (workspaceId != null) return rotatingRefreshEntries(env, workspaceId, limit);
  const policyMarker = `%\"inference_policy\":\"${EDGE_INFERENCE_POLICY}\"%`;
  const legacySlice = workspaceId != null ? ` AND e.workspace_id = ?` : "";
  const { results: legacy } = await env.DB.prepare(
    // scope-checked: scheduled rotation supplies workspaceId and appends legacySlice; identity-less manual/legacy callers intentionally retain the pre-v3 bounded whole-corpus maintenance pass
    `SELECT e.id, e.content FROM entries e
      WHERE ${notHeldSqlFor("e")} AND e.tags NOT LIKE '%"status:deprecated"%'
        AND e.tags NOT LIKE '%"duplicate-candidate"%'
        AND EXISTS (
          SELECT 1 FROM edges x
           WHERE x.provenance = 'inferred' AND x.type = 'relates_to'
             AND (x.source_id = e.id OR x.target_id = e.id)
             AND COALESCE(x.metadata, '') NOT LIKE ?
        )${legacySlice}
      ORDER BY e.created_at DESC LIMIT ${limit}`,
  ).bind(policyMarker, ...(workspaceId != null ? [workspaceId] : [])).all() as { results: GraphRefreshEntry[] };
  if (legacy.length >= limit) return legacy;

  const remaining = limit - legacy.length;
  const unlinkedSlice = workspaceId != null ? `\n        AND workspace_id = ?` : "";
  const { results: unlinked } = await env.DB.prepare(
    // scope-checked: scheduled rotation supplies workspaceId and appends unlinkedSlice; identity-less manual/legacy callers intentionally retain the pre-v3 bounded whole-corpus maintenance pass
    `SELECT id, content FROM entries
      WHERE id NOT IN (SELECT source_id FROM edges) AND id NOT IN (SELECT target_id FROM edges)
        AND ${NOT_HELD_SQL} AND tags NOT LIKE '%"status:deprecated"%'
        AND ${NOT_HELD_SQL} AND tags NOT LIKE '%"duplicate-candidate"%'${unlinkedSlice}
      ORDER BY created_at DESC LIMIT ${remaining}`,
  ).bind(...(workspaceId != null ? [workspaceId] : [])).all() as { results: GraphRefreshEntry[] };
  const seen = new Set(legacy.map(entry => entry.id));
  return [...legacy, ...unlinked.filter(entry => !seen.has(entry.id))];
}

/**
 * `workspaceId` narrows the backfill candidates to one workspace's slice of the ring
 * (v3 Team Edition, see src/runtime/rotation.ts). Undefined/null — every direct and
 * manual caller — keeps the pre-v3 whole-corpus scan, whose SQL must stay byte-for-byte
 * identical. The prune DELETE below stays whole-deployment on purpose: it is a single
 * unindexed-scan statement either way and inferred-edge weights are not workspace state.
 */
export async function runGraphPass(
  env: Env,
  ctx: ExecutionContext,
  workspaceId?: string | null,
  limit = GRAPH_PASS_RECOMPUTE_LIMIT,
): Promise<{ inserted: number; complete?: false }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > GRAPH_PASS_RECOMPUTE_LIMIT) {
    throw new RangeError("Invalid graph refresh limit");
  }
  let complete = true;
  // One resolve for the whole pass: every embed below must use the same model
  // the capture and recall paths use.
  const cfg = await resolveConfig(env);
  await initializeDatabase(env);

  try {
    await pruneIncompatibleInferredEdges(env);
  } catch (e) {
    complete = false;
    console.error("Graph prune failed (non-fatal):", e);
  }

  if (new Date(Date.now()).getUTCDay() === GRAPH_SWEEP_WEEKDAY_UTC) {
    try {
      // scope-exempt: cron: predicate for the weekly deployment-wide inferred dangling-edge sweep
      const dangling = `provenance = 'inferred'
        AND (NOT EXISTS (SELECT 1 FROM entries WHERE entries.id = edges.source_id)
          OR NOT EXISTS (SELECT 1 FROM entries WHERE entries.id = edges.target_id))`;
      await env.DB.batch([
        // scope-exempt: cron: deployment-wide weekly cleanup of inferred dangling edges, with the normal delete capability
        env.DB.prepare(`UPDATE edges SET write_marker = ? WHERE ${dangling}`)
          .bind(memoryWriteMarker(env, "delete")),
        // scope-exempt: cron: same exact inferred dangling rows as the fenced update in this transaction
        env.DB.prepare(`DELETE FROM edges WHERE ${dangling}`),
      ]);
    } catch (e) {
      complete = false;
      console.error("Graph dangling sweep failed (non-fatal):", e);
    }
  }

  let entries: GraphRefreshEntry[] = [];
  try {
    entries = await entriesNeedingRefresh(env, workspaceId, limit);
  } catch (e) {
    complete = false;
    console.error("Graph refresh query failed (non-fatal):", e);
  }

  let inserted = 0;
  const refreshed = await Promise.all(entries.map(async (entry): Promise<InferenceRecalculation | null> => {
    try {
      const chunks = representativeVectors(chunkText(entry.content));
      const vectors = await Promise.all(chunks.map(chunk => embedDocument(chunk, env, cfg)));
      return { entryId: entry.id, neighbors: await neighborsFromVectorQueries(vectors, env) };
    } catch (e) {
      complete = false;
      console.error(`Graph refresh failed for ${entry.id} (non-fatal):`, e);
      return null;
    }
  }));
  const recalculations = refreshed.filter((item): item is InferenceRecalculation => item !== null);
  if (recalculations.length) {
    try {
      inserted = await replaceInferredEdgesOnWrite(recalculations, env);
    } catch (e) {
      complete = false;
      console.error("Graph refresh write failed (non-fatal):", e);
    }
  }

  const last = entries.at(-1);
  if (workspaceId != null && last && Number.isSafeInteger(last.created_at)) {
    try {
      await env.OAUTH_KV.put(refreshCursorKey(workspaceId), JSON.stringify({ createdAt: last.created_at, id: last.id }));
    } catch { console.error("Graph refresh cursor write failed (non-fatal)"); }
  }
  return complete ? { inserted } : { inserted, complete: false };
}
