import type { Env } from "../env";
import type { ExportPayload } from "./import";
import type { MemoryTier } from "../memory/tier";
import type { Identity } from "../lib/identity";
import { scopeWhere } from "../lib/scope";

// 完全HTTP exportと旧brain-v2復元の上限。brain-v3の分割backupには適用しない。
export const EXPORT_COMPLETE_MAX_ROWS = 500;
export const EXPORT_COMPLETE_MAX_ESTIMATED_BYTES = 512 * 1024;
export const EXPORT_COMPLETE_MAX_BYTES = 768 * 1024;

/** HTTP exportの拒否。R2固有の復元・接続エラーとは分ける。 */
export class ExportError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ExportError";
  }
}

export const EXPORT_READ_PAGE_ROWS = 2_000;
export const EXPORT_HTTP_PAGE_ROWS = 200;
export const EXPORT_HTTP_MAX_PAGE_ROWS = 500;

export function parseExportPageLimit(raw: string | null): number {
  if (!raw) return EXPORT_HTTP_PAGE_ROWS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return EXPORT_HTTP_PAGE_ROWS;
  return Math.min(parsed, EXPORT_HTTP_MAX_PAGE_ROWS);
}

// scope-checked: this is a projection fragment only; every executable export caller appends either its resolved identity scope or intentionally runs the owner-admin full backup path
// validity: any: 認可済みexportの原本と容量判定は過去・保留行を含める。
const ENTRY_PROJECTION = `SELECT id, content, tags, source, created_at,
            COALESCE(updated_at, created_at) AS last_updated,
            recall_count, importance_score, contradiction_wins, contradiction_losses,
            memory_tier, pinned, last_recalled_at, workspace_id, actor_id, when_at, when_kind, when_source, when_label, valid_from, valid_until
       FROM entries`;
// scope-checked: this is a projection fragment only; every executable export caller appends either its resolved identity scope or intentionally runs the owner-admin full backup path
const EDGE_PROJECTION =
  `SELECT id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id FROM edges`;

export interface ExportBundle extends ExportPayload {
  ok: true;
  exported_at: number;
  version: 3;
}

export interface PagedExportBundle extends ExportBundle {
  pagination: {
    next_offset: number;
    next_edge_offset: number;
    remaining_entries: number;
    remaining_edges: number;
    next_project_offset: number;
    remaining_projects: number;
    complete: boolean;
  };
}

function mapEntryRows(rows: Record<string, unknown>[]) {
  return rows.map(row => ({
    id: row.id as string,
    content: row.content as string,
    tags: JSON.parse((row.tags as string | undefined) ?? "[]") as string[],
    source: row.source as string,
    created_at: row.created_at as number,
    updated_at: (row.last_updated ?? row.created_at) as number,
    recall_count: Number(row.recall_count ?? 0),
    importance_score: Number(row.importance_score ?? 0),
    contradiction_wins: Number(row.contradiction_wins ?? 0),
    contradiction_losses: Number(row.contradiction_losses ?? 0),
    memory_tier: (row.memory_tier === "hot" || row.memory_tier === "cold" ? row.memory_tier : "warm") as MemoryTier,
    pinned: Number(row.pinned ?? 0) === 1,
    valid_from: row.valid_from as number | null ?? null,
    valid_until: row.valid_until as number | null ?? null,
    when_at: row.when_at as number | null ?? null,
    when_kind: row.when_kind as string | null ?? null,
    when_source: row.when_source as string | null ?? null,
    when_label: row.when_label as string | null ?? null,
    last_recalled_at: typeof row.last_recalled_at === "number" ? row.last_recalled_at : null,
    workspace_id: typeof row.workspace_id === "string" ? row.workspace_id : "",
    actor_id: typeof row.actor_id === "string" ? row.actor_id : "",
  }));
}

function mapEdgeRows(rows: Record<string, unknown>[]) {
  return rows.map(row => ({
    id: row.id as string,
    source_id: row.source_id as string,
    target_id: row.target_id as string,
    type: row.type as string,
    weight: Number(row.weight),
    provenance: row.provenance as string,
    metadata: JSON.parse((row.metadata as string | undefined) ?? "{}") as Record<string, unknown>,
    created_at: row.created_at as number,
    updated_at: (row.updated_at ?? row.created_at) as number,
    workspace_id: typeof row.workspace_id === "string" ? row.workspace_id : "",
  }));
}

// scope-checked: 所有者の全体バックアップ、または呼出元のworkspace条件を付けて実行する射影。
const PROJECT_PROJECTION = `SELECT id, workspace_id, name, description, aliases, status, created_at, updated_at AS project_updated_at FROM projects`;
function mapProjectRows(rows: Record<string, unknown>[]) {
  return rows.map(row => ({
    id: String(row.id), workspace_id: String(row.workspace_id ?? ""), name: String(row.name),
    description: String(row.description ?? ""), aliases: JSON.parse(String(row.aliases ?? "[]")) as string[],
    status: String(row.status), created_at: Number(row.created_at),
    updated_at: row.project_updated_at == null ? null : Number(row.project_updated_at),
  }));
}
export async function readExportProjectsPage(env: Env, offset: number, limit = EXPORT_READ_PAGE_ROWS, identity?: Identity) {
  const scope = identity ? scopeWhere(identity) : null;
  const result = await env.DB.prepare(
    `${PROJECT_PROJECTION}${scope ? ` WHERE ${scope.clause}` : ""} ORDER BY workspace_id, id LIMIT ? OFFSET ?`,
  ).bind(...(scope?.bindings ?? []), limit, offset).all();
  return mapProjectRows((result.results ?? []) as Record<string, unknown>[]);
}

export async function readExportCounts(env: Env, identity?: Identity): Promise<{ entryCount: number; edgeCount: number; projectCount: number }> {
  const entryScope = identity ? scopeWhere(identity) : null;
  const edgeScope = identity ? scopeWhere(identity, undefined, "workspace_id") : null;
  const row = await env.DB.prepare(
    // scope-checked: identity-backed exports interpolate both resolved scopes; the identity-less path is reserved for deployment-wide owner backup and restore
    // validity: any: 認可済みexportの原本と容量判定は過去・保留行を含める。
    `SELECT (SELECT COUNT(*) FROM entries${entryScope ? ` WHERE ${entryScope.clause}` : ""}) AS entry_count,
            (SELECT COUNT(*) FROM edges${edgeScope ? ` WHERE ${edgeScope.clause}` : ""}) AS edge_count,
            (SELECT COUNT(*) FROM projects${edgeScope ? ` WHERE ${edgeScope.clause}` : ""}) AS project_count`,
  ).bind(...(entryScope?.bindings ?? []), ...(edgeScope?.bindings ?? []), ...(edgeScope?.bindings ?? []))
    .first<{ entry_count: number; edge_count: number; project_count: number }>();
  return {
    entryCount: Number(row?.entry_count ?? 0),
    edgeCount: Number(row?.edge_count ?? 0),
    projectCount: Number(row?.project_count ?? 0),
  };
}

export async function readExportEntriesPage(
  env: Env,
  offset: number,
  limit = EXPORT_READ_PAGE_ROWS,
  identity?: Identity,
) {
  const scope = identity ? scopeWhere(identity) : null;
  const result = await env.DB.prepare(
    `${ENTRY_PROJECTION}${scope ? ` WHERE ${scope.clause}` : ""} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`,
  ).bind(...(scope?.bindings ?? []), limit, offset).all();
  return mapEntryRows((result.results ?? []) as Record<string, unknown>[]);
}

export async function readExportEdgesPage(
  env: Env,
  offset: number,
  limit = EXPORT_READ_PAGE_ROWS,
  identity?: Identity,
) {
  const scope = identity ? scopeWhere(identity) : null;
  const result = await env.DB.prepare(
    `${EDGE_PROJECTION}${scope ? ` WHERE ${scope.clause}` : ""} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`,
  ).bind(...(scope?.bindings ?? []), limit, offset).all();
  return mapEdgeRows((result.results ?? []) as Record<string, unknown>[]);
}

export async function buildPagedExportBundle(
  env: Env,
  offset = 0,
  edgeOffset = 0,
  limit = EXPORT_HTTP_PAGE_ROWS,
  identity?: Identity,
  projectOffset = 0,
): Promise<PagedExportBundle> {
  const { entryCount, edgeCount, projectCount } = await readExportCounts(env, identity);
  const safeOffset = Math.min(Math.max(offset, 0), entryCount);
  const safeEdgeOffset = Math.min(Math.max(edgeOffset, 0), edgeCount);
  let entries: Awaited<ReturnType<typeof readExportEntriesPage>> = [];
  let edges: Awaited<ReturnType<typeof readExportEdgesPage>> = [];
  let projects: Awaited<ReturnType<typeof readExportProjectsPage>> = [];
  let nextProjectOffset = Math.min(Math.max(projectOffset, 0), projectCount);
  let nextOffset = safeOffset;
  let nextEdgeOffset = safeEdgeOffset;
  if (safeOffset < entryCount) {
    entries = await readExportEntriesPage(env, safeOffset, limit, identity);
    nextOffset += entries.length;
  } else if (safeEdgeOffset < edgeCount) {
    edges = await readExportEdgesPage(env, safeEdgeOffset, limit, identity);
    nextEdgeOffset += edges.length;
  } else if (nextProjectOffset < projectCount) {
    projects = await readExportProjectsPage(env, nextProjectOffset, limit, identity);
    nextProjectOffset += projects.length;
  }
  const remainingEntries = entryCount - nextOffset;
  const remainingEdges = edgeCount - nextEdgeOffset;
  return {
    ok: true,
    exported_at: Date.now(),
    version: 3,
    entries,
    edges,
    projects,
    pagination: {
      next_offset: nextOffset,
      next_edge_offset: nextEdgeOffset,
      remaining_entries: remainingEntries,
      remaining_edges: remainingEdges,
      next_project_offset: nextProjectOffset,
      remaining_projects: projectCount - nextProjectOffset,
      complete: remainingEntries === 0 && remainingEdges === 0 && nextProjectOffset === projectCount,
    },
  };
}

/** R2のページ読取と同じ射影で、完全HTTP exportを一つのD1 batchから生成する。 */
export async function buildExportBundle(env: Env, identity?: Identity): Promise<ExportBundle> {
  const scope = identity ? scopeWhere(identity) : null;
  const entryStatement = env.DB.prepare(
    `${ENTRY_PROJECTION}${scope ? ` WHERE ${scope.clause}` : ""} ORDER BY created_at ASC, id ASC`,
  ).bind(...(scope?.bindings ?? []));
  const edgeStatement = env.DB.prepare(
    `${EDGE_PROJECTION}${scope ? ` WHERE ${scope.clause}` : ""} ORDER BY created_at ASC, id ASC`,
  ).bind(...(scope?.bindings ?? []));
  // D1 batches are transactions. Reading both projections in one batch prevents an
  // ordinary capture/background edge write from landing between the two reads and
  // producing a self-consistent hash over an impossible point-in-time state.
  const projectStatement = env.DB.prepare(
    `${PROJECT_PROJECTION}${scope ? ` WHERE ${scope.clause}` : ""} ORDER BY workspace_id, id`,
  ).bind(...(scope?.bindings ?? []));
  const [entryResult, edgeResult, projectResult] = await env.DB.batch([entryStatement, edgeStatement, projectStatement]);
  const entryRows = (entryResult.results ?? []) as Record<string, unknown>[];
  const edgeRows = (edgeResult.results ?? []) as Record<string, unknown>[];

  const entries = mapEntryRows(entryRows);
  const edges = mapEdgeRows(edgeRows);

  return { ok: true, exported_at: Date.now(), version: 3, entries, edges, projects: mapProjectRows((projectResult.results ?? []) as Record<string, unknown>[]) };
}

export async function assertExportWithinMemoryLimit(env: Env, identity?: Identity): Promise<void> {
  // Estimate before materialising the export. SQLite LENGTH counts code points rather
  // than JSON bytes and stops at U+0000 for TEXT. CAST to BLOB counts every UTF-8 byte;
  // multiplying by six covers JSON's worst-case \uXXXX escaping. Include every exported
  // string, including IDs, and add a fixed JSON/number allowance per row.
  const scope = identity ? scopeWhere(identity) : null;
  const where = scope ? ` WHERE ${scope.clause}` : "";
  const and = scope ? ` AND e.${scope.clause}` : "";
  const estimate = await env.DB.prepare(
    // scope-checked: interactive exports interpolate the resolved identity into every counted corpus slice; identity-less calls are the deployment-wide admin backup, and endpoint aliases only validate IDs reached from the scoped edge rows
    // validity: any: 認可済みexportの原本と容量判定は過去・保留行を含める。
    `SELECT
       (SELECT COUNT(*) FROM entries${where}) AS entry_count,
       (SELECT COALESCE(SUM(6 * (LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(content AS BLOB)) + LENGTH(CAST(tags AS BLOB)) + LENGTH(CAST(source AS BLOB))) + 512), 0) FROM entries${where}) AS entry_bytes,
       (SELECT COUNT(*) FROM edges${where}) AS edge_count,
       (SELECT COALESCE(SUM(6 * (LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(source_id AS BLOB)) + LENGTH(CAST(target_id AS BLOB)) + LENGTH(CAST(type AS BLOB)) + LENGTH(CAST(provenance AS BLOB)) + LENGTH(CAST(metadata AS BLOB))) + 512), 0) FROM edges${where}) AS edge_bytes,
       (SELECT COUNT(*) FROM projects${where}) AS project_count,
       (SELECT COALESCE(SUM(6 * (LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(workspace_id AS BLOB)) + LENGTH(CAST(name AS BLOB)) + LENGTH(CAST(description AS BLOB)) + LENGTH(CAST(aliases AS BLOB)) + LENGTH(CAST(status AS BLOB))) + 512), 0) FROM projects${where}) AS project_bytes,
       (SELECT COUNT(*) FROM edges e
         LEFT JOIN entries s ON s.id = e.source_id
         LEFT JOIN entries t ON t.id = e.target_id
        WHERE (s.id IS NULL OR t.id IS NULL)${and}) AS dangling_edge_count`,
  ).bind(...Array.from({ length: 7 }, () => scope?.bindings ?? []).flat())
    .first<{ entry_count: number; entry_bytes: number; edge_count: number; edge_bytes: number; dangling_edge_count: number; project_count: number; project_bytes: number }>();
  const estimatedRows = Number(estimate?.entry_count ?? 0) + Number(estimate?.edge_count ?? 0) + Number(estimate?.project_count ?? 0);
  const estimatedBytes = Number(estimate?.entry_bytes ?? 0) + Number(estimate?.edge_bytes ?? 0) + Number(estimate?.project_bytes ?? 0);
  if (Number(estimate?.dangling_edge_count ?? 0) > 0) {
    throw new ExportError("Backup contains an edge with a missing endpoint; repair graph integrity first", 409);
  }
  if (estimatedRows > EXPORT_COMPLETE_MAX_ROWS || estimatedBytes > EXPORT_COMPLETE_MAX_ESTIMATED_BYTES) {
    throw new ExportError("Backup exceeds the in-Worker safety limit; use a paged export workflow", 413);
  }
}

/** 完全HTTP exportの生成後検査。生成前の見積りに加えて実byte数も制限する。 */
export function serializeExportWithinMemoryLimit(
  bundle: Awaited<ReturnType<typeof buildExportBundle>>,
): string {
  if (bundle.entries.length + (bundle.edges?.length ?? 0) + (bundle.projects?.length ?? 0) > EXPORT_COMPLETE_MAX_ROWS) {
    throw new ExportError("Backup exceeds the in-Worker row limit; use a paged export workflow", 413);
  }
  const serialized = JSON.stringify(bundle);
  if (new TextEncoder().encode(serialized).byteLength > EXPORT_COMPLETE_MAX_BYTES) {
    throw new ExportError("Backup exceeds the restorable object limit; use a paged export workflow", 413);
  }
  return serialized;
}
