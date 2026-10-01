import { getKind, type MemoryKind } from "../memory/kind";
import type { Env } from "../env";
import { D1_MAX_BOUND_PARAMS, MIRRORED_SOURCES } from "../constants";
import { topicTagsOf } from "../insight/eligibility";
import { EDGE_TYPES, type EdgeProvenance, type EdgeType } from "./types";
import { assertMemoryWritesAllowed, memoryWriteMarker } from "../migration/write-lock";

const DEFAULT_EDGE_WEIGHT = 0.5;
const EDGE_INSERT_BINDINGS = 11;
const EDGE_INSERT_ROWS_PER_STATEMENT = Math.floor(D1_MAX_BOUND_PARAMS / EDGE_INSERT_BINDINGS);

export interface EdgeInsertRow {
  id: string;
  sourceId: string;
  targetId: string;
  type: EdgeType;
  weight: number;
  provenance: EdgeProvenance;
  metadata: string;
  createdAt: number;
  updatedAt: number;
  workspaceId: string;
}

export function edgeInsertRow(
  sourceId: string,
  targetId: string,
  type: string,
  opts: { weight?: number; provenance?: EdgeProvenance; metadata?: Record<string, unknown>; created_at?: number; workspaceId?: string } = {},
): EdgeInsertRow | null {
  if (!isValidEdgeType(type) || sourceId === targetId) return null;
  if (isSymmetric(type) && sourceId > targetId) [sourceId, targetId] = [targetId, sourceId];
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    sourceId,
    targetId,
    type,
    weight: Math.max(0, Math.min(1, opts.weight ?? DEFAULT_EDGE_WEIGHT)),
    provenance: opts.provenance ?? "inferred",
    metadata: JSON.stringify(opts.metadata ?? {}),
    createdAt: opts.created_at ?? now,
    updatedAt: now,
    workspaceId: opts.workspaceId ?? "",
  };
}

/**
 * What POST /link and the MCP `link` tool both say when a caller asks to join two
 * entries that live in different workspaces.
 *
 * One constant rather than two string literals: the two surfaces are one
 * operation, and the repo's parity convention (test/integration/update-parity.test.ts)
 * is that they must not be able to drift. It names a fix, because the alternative
 * the user is offered is otherwise invisible.
 *
 * It says "workspace" and not "layer", and it does not name WHICH side to move,
 * because the check is `source.workspace_id !== target.workspace_id` and three
 * shapes reach it, only one of which has a personal side:
 *
 *   - personal <-> company, the ordinary case;
 *   - company A <-> company B, for a member of two teams: both are the company
 *     layer, so "layer" is the wrong word and neither is personal;
 *   - "" <-> anything, for an admin: "" is the legacy/system space, and no share
 *     moves an entry INTO it.
 *
 * Naming the personal one was a single-team assumption, which spec item 4.1
 * forbids introducing.
 */
export const CROSS_WORKSPACE_LINK_MESSAGE =
  "Both memories must be in the same workspace — move one into the other's workspace first";

export function isValidEdgeType(type: string): type is EdgeType {
  return Object.prototype.hasOwnProperty.call(EDGE_TYPES, type);
}

export function isSymmetric(type: EdgeType): boolean {
  return !EDGE_TYPES[type].directed;
}

export function edgeLabel(type: EdgeType): string {
  return EDGE_TYPES[type].label;
}

export function allowedKindsFor(type: EdgeType): readonly MemoryKind[] | null {
  return EDGE_TYPES[type].allowedKinds;
}

/**
 * Does a pair of memory kinds satisfy an edge type's `allowedKinds`?
 *
 * One gate for every writer, POST /link, the MCP link tool, capture-time
 * `follows` and the insight pass, because a type whose meaning depends on the
 * kinds it joins is only as good as the least careful writer.
 *
 * An unknown kind is refused rather than waved through: `null` means the
 * classifier has not spoken yet, which is not evidence the pair qualifies.
 * Types with no constraint (`allowedKinds: null`) accept anything, unknown
 * included.
 */
export function kindsAllowEdge(
  type: EdgeType,
  sourceKind: MemoryKind | null,
  targetKind: MemoryKind | null,
): boolean {
  const allowed = allowedKindsFor(type);
  if (!allowed) return true;
  if (sourceKind === null || targetKind === null) return false;
  return allowed.includes(sourceKind) && allowed.includes(targetKind);
}

/**
 * How close two episodic captures must sit to read as one train of thought.
 *
 * A module constant and deliberately NOT config: it is a claim about how people
 * write, not a deployment knob, and every brain that tuned it separately would
 * make `follows` mean something different per brain, which is exactly what the
 * type exists to stop. Start at 30 minutes; GET /stats/graph?deep=1 reports the
 * real gap distribution, which is what should move it.
 */
export const GRAPH_FOLLOWS_WINDOW_MS = 30 * 60_000;

/**
 * What POST /link and the MCP `link` tool both say when the two memories' kinds
 * do not permit the requested type. One sentence in one place, for the same
 * parity reason as CROSS_WORKSPACE_LINK_MESSAGE: the two surfaces are one
 * operation and must not drift.
 *
 * It names the fix, because "not allowed" alone leaves the caller guessing,
 * an unclassified memory looks identical to a wrongly-classified one from
 * outside.
 */
export function kindMismatchMessage(type: EdgeType): string {
  const allowed = allowedKindsFor(type)?.join(" or ") ?? "";
  return `${edgeLabel(type)} links only ${allowed} memories — both entries must be classified ${allowed} first`;
}

/** The kind on an entry row whose `tags` column was projected, or null. */
export function kindOfRow(row: { tags?: string | null }): MemoryKind | null {
  try {
    return getKind(JSON.parse(row.tags ?? "[]"));
  } catch {
    return null;
  }
}

/**
 * The guard every edge insert carries (T-0089.1.1): both endpoints are live entries in a workspace
 * the actor can read. `readable` is a SQL expression for a JSON array of workspace ids, normally
 * readableWorkspaces(identity) bound as one parameter; a system job passes the workspace it acts in.
 * Checked in the statement that writes the edge, so an endpoint moved out of reach after the caller's
 * own check gets no edge, and a private id never lands in an edge its readers could export.
 */
export function edgeEndpointsReadableSql(source: string, target: string, readable: string): string {
  const inReadable = (alias: string, id: string) =>
    // scope-checked: workspace_id IN the actor's readable workspaces, passed in as a JSON array
    `EXISTS (SELECT 1 FROM entries ${alias} WHERE ${alias}.id = ${id} AND ${alias}.workspace_id IN (SELECT value FROM json_each(${readable})))`;
  return `${inReadable("es", source)} AND ${inReadable("et", target)}`;
}

/**
 * Options for an automatic edge (capture, inference, the insight pass, import): stamped with ONE
 * workspace and both endpoints required to live in it. Only an explicit link, from a person, passes
 * their readable workspaces instead, and the link surfaces already refuse a cross-workspace pair.
 * An automatic edge between two workspaces a person can read would show a personal id to everyone
 * else who reads the company one.
 */
export function sameWorkspaceEdge(workspaceId: string): { workspaceId: string; readableWorkspaceIds: string[] } {
  return { workspaceId, readableWorkspaceIds: [workspaceId] };
}

/**
 * The INSERT createEdge issues, prepared and bound but not run, so a caller
 * with several edges to write can hand them all to env.DB.batch(...) as one
 * subrequest instead of paying one subrequest per createEdge call.
 *
 * Symmetric-type reordering and the weight clamp live here, not in createEdge,
 * so a batched caller gets them too rather than just the direct one.
 *
 * `workspaceId` is the SOURCE entry's workspace, copied rather than left to the
 * column default: edges.workspace_id is denormalized from the source entry so a
 * scoped graph walk needs no join (see schema.sql). Callers that know it pass it;
 * "" keeps the legacy-owner value and changes nothing for pre-tenancy rows.
 */
export function edgeInsertStatement(
  sourceId: string,
  targetId: string,
  type: string,
  opts: {
    weight?: number; provenance?: EdgeProvenance; metadata?: Record<string, unknown>;
    created_at?: number; workspaceId?: string;
    /** Workspaces the actor can read (readableWorkspaces); an endpoint outside them gets no edge. */
    readableWorkspaceIds: string[];
    /**
     * Write nothing if the pair already carries an edge of any type other than
     * relates_to. For the GENERIC edge only: a typed edge is the more specific
     * statement, and laying an undirected relates_to beside it says less about
     * the same pair while competing with it for the fanout cap.
     *
     * Expressed in the statement rather than as a lookup, so it costs no
     * additional D1 call, the whole reason edge writes are batched.
     */
    onlyIfNoTypedEdge?: boolean;
  },
  env: Env,
): D1PreparedStatement | null {
  const row = edgeInsertRow(sourceId, targetId, type, opts);
  if (!row) return null;
  const values = edgeInsertBindings(row, env);
  // Upstream's generic-edge guard stays in SQL, so a concurrent typed writer
  // cannot be followed by a stale lookup inserting a less-specific edge.
  const readable = JSON.stringify(opts.readableWorkspaceIds);
  if (opts.onlyIfNoTypedEdge) {
    return env.DB.prepare(
      // scope-exempt: by-id: both endpoints of this guarded inference were hydrated and workspace-checked by the caller
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, write_marker, workspace_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${edgeEndpointsReadableSql("?", "?", "?")} AND NOT EXISTS (
         SELECT 1 FROM edges g
         WHERE ((g.source_id = ? AND g.target_id = ?) OR (g.source_id = ? AND g.target_id = ?))
           AND g.type <> 'relates_to')
       ON CONFLICT(source_id, target_id, type) DO UPDATE SET
         weight = max(edges.weight, excluded.weight), metadata = excluded.metadata,
         updated_at = excluded.updated_at, write_marker = excluded.write_marker,
         workspace_id = excluded.workspace_id
       WHERE edges.provenance = 'inferred'`,
    ).bind(...values, row.sourceId, readable, row.targetId, readable, row.sourceId, row.targetId, row.targetId, row.sourceId);
  }
  return env.DB.prepare(
    `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, write_marker, workspace_id)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE ${edgeEndpointsReadableSql("?", "?", "?")}
     ON CONFLICT(source_id, target_id, type) DO UPDATE SET
       weight = max(weight, excluded.weight), updated_at = excluded.updated_at,
       write_marker = excluded.write_marker, workspace_id = excluded.workspace_id
     WHERE edges.provenance <> 'explicit' OR excluded.provenance = 'explicit'`,
  ).bind(...values, row.sourceId, readable, row.targetId, readable);
}

export async function createEdge(
  sourceId: string,
  targetId: string,
  type: string,
  opts: { weight?: number; provenance?: EdgeProvenance; metadata?: Record<string, unknown>; created_at?: number; workspaceId?: string; readableWorkspaceIds: string[] },
  env: Env,
): Promise<{ source_id: string; target_id: string; type: EdgeType } | null> {
  await assertMemoryWritesAllowed(env);
  const stmt = edgeInsertStatement(sourceId, targetId, type, opts, env);
  if (!stmt) return null;
  await stmt.run();

  let source = sourceId;
  let target = targetId;
  if (isValidEdgeType(type) && isSymmetric(type) && source > target) [source, target] = [target, source];

  return { source_id: source, target_id: target, type: type as EdgeType };
}

export async function deleteEdge(
  sourceId: string,
  targetId: string,
  type: string | undefined,
  env: Env,
): Promise<number> {
  await assertMemoryWritesAllowed(env);
  // scope-exempt: both endpoint ids are authorized before the ID-only edge deletion helper is called
  let sql = `DELETE FROM edges WHERE ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))`;
  const bindings: string[] = [sourceId, targetId, targetId, sourceId];
  if (type) {
    sql += ` AND type = ?`;
    bindings.push(type);
  }
  const [_, result] = await env.DB.batch([
    // scope-exempt: this dynamically reuses the same authorized endpoint predicate as the deletion immediately below
    env.DB.prepare(`UPDATE edges SET write_marker = ? WHERE ${sql.slice("DELETE FROM edges WHERE ".length)}`)
      .bind(memoryWriteMarker(env, "delete"), ...bindings),
    env.DB.prepare(sql).bind(...bindings),
  ]);
  return result.meta.changes ?? 0;
}

// Gemma MRL128 calibration: 8/10 curated related pairs clear 0.42 while all
// 10 unrelated pairs stay below it (observed max 0.3785). Production data is
// broader than that calibration corpus, however: 0.42 alone admitted semantic
// lookalikes from different projects. Keep the recall-friendly floor only when
// a concrete topic/project tag agrees; otherwise require the empirically clean
// high-confidence band.
export const EDGE_INFER_THRESHOLD = 0.42;
export const EDGE_INFER_UNTAGGED_THRESHOLD = 0.70;
export const EDGE_INFERENCE_POLICY = "embeddinggemma-mrl128-v2";
const EDGE_INFER_MAX = 3;

export interface InferenceNeighbor {
  id: string;
  score: number;
}

export interface InferenceRecalculation {
  entryId: string;
  neighbors: InferenceNeighbor[];
  options?: { suppressId?: string; newKind?: MemoryKind | null };
}

export interface InferenceDecision {
  eligible: boolean;
  basis: "shared-topic-tag" | "high-similarity" | "rejected";
  sharedTags: string[];
}

function sharedTopicTags(a: string[], b: string[]): string[] {
  const right = new Set([...topicTagsOf(b)].map(tag => tag.trim().toLowerCase()));
  return [...topicTagsOf(a)]
    .map(tag => tag.trim().toLowerCase())
    .filter(tag => tag.length > 0 && right.has(tag))
    .sort();
}

export function decideInferredEdge(
  score: number,
  sourceTags: string[] = [],
  targetTags: string[] = [],
): InferenceDecision {
  if (!Number.isFinite(score) || score < EDGE_INFER_THRESHOLD) {
    return { eligible: false, basis: "rejected", sharedTags: [] };
  }
  const sharedTags = sharedTopicTags(sourceTags, targetTags);
  if (sharedTags.length) return { eligible: true, basis: "shared-topic-tag", sharedTags };
  if (score >= EDGE_INFER_UNTAGGED_THRESHOLD) {
    return { eligible: true, basis: "high-similarity", sharedTags: [] };
  }
  return { eligible: false, basis: "rejected", sharedTags: [] };
}

function parseTags(raw: unknown): string[] {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

async function loadEntryFacts(
  ids: string[],
  env: Env,
): Promise<Map<string, { tags: string[]; workspaceId: string; createdAt: number | null; source: string }>> {
  const unique = [...new Set(ids)];
  const facts = new Map<string, { tags: string[]; workspaceId: string; createdAt: number | null; source: string }>();
  for (let offset = 0; offset < unique.length; offset += D1_MAX_BOUND_PARAMS) {
    const page = unique.slice(offset, offset + D1_MAX_BOUND_PARAMS);
    const { results } = await env.DB.prepare(
      // scope-exempt: IDs are produced by already workspace-scoped Vectorize neighbors/recalculations and this internal hydration cannot widen that set
      `SELECT id, workspace_id, tags, created_at, source FROM entries WHERE id IN (${page.map(() => "?").join(", ")})`,
    ).bind(...page).all() as { results: { id: string; tags: string; workspace_id: string | null; created_at: number | null; source: string | null }[] };
    for (const row of results) {
      facts.set(row.id, { tags: parseTags(row.tags), workspaceId: row.workspace_id ?? "", createdAt: row.created_at, source: row.source ?? "" });
    }
  }
  return facts;
}

function inferenceMetadata(decision: InferenceDecision): Record<string, unknown> {
  return {
    inference_policy: EDGE_INFERENCE_POLICY,
    basis: decision.basis,
    ...(decision.sharedTags.length ? { shared_topic_tags: decision.sharedTags.slice(0, 8) } : {}),
  };
}

export function inferredEdgeStatements(
  newId: string,
  neighbors: InferenceNeighbor[],
  env: Env,
  sourceTags: string[] = [],
  tagsById: ReadonlyMap<string, string[]> = new Map(),
): D1PreparedStatement[] {
  return inferredEdgeInsertManyStatements(
    inferredEdgeRows(newId, neighbors, sourceTags, tagsById),
    env,
  );
}

export function inferredEdgeRows(
  newId: string,
  neighbors: InferenceNeighbor[],
  sourceTags: string[] = [],
  tagsById: ReadonlyMap<string, string[]> = new Map(),
  workspaceId = "",
): EdgeInsertRow[] {
  return neighbors
    .map(n => ({ neighbor: n, decision: decideInferredEdge(n.score, sourceTags, tagsById.get(n.id) ?? []) }))
    .filter(({ neighbor, decision }) => neighbor.id !== newId && decision.eligible)
    .sort((a, b) => b.neighbor.score - a.neighbor.score)
    .slice(0, EDGE_INFER_MAX)
    .map(({ neighbor, decision }) => {
      let sourceId = newId;
      let targetId = neighbor.id;
      if (sourceId > targetId) [sourceId, targetId] = [targetId, sourceId];
      const now = Date.now();
      return {
        id: crypto.randomUUID(),
        sourceId,
        targetId,
        type: "relates_to",
        weight: Math.max(0, Math.min(1, neighbor.score)),
        provenance: "inferred",
        metadata: JSON.stringify(inferenceMetadata(decision)),
        createdAt: now,
        updatedAt: now,
        workspaceId,
      };
    });
}

/** 単行・一括・推論で、列順と書込権限の付与を揃える。 */
function edgeInsertBindings(row: EdgeInsertRow, env: Env): (string | number | null)[] {
  return [
    row.id, row.sourceId, row.targetId, row.type, row.weight, row.provenance,
    row.metadata, row.createdAt, row.updatedAt, memoryWriteMarker(env), row.workspaceId,
  ];
}

/** Pack rows below D1's 100-bound-parameter ceiling. */
export function edgeInsertManyStatements(rows: EdgeInsertRow[], env: Env): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < rows.length; offset += EDGE_INSERT_ROWS_PER_STATEMENT) {
    const page = rows.slice(offset, offset + EDGE_INSERT_ROWS_PER_STATEMENT);
    const values = page.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const bindings = page.flatMap(row => edgeInsertBindings(row, env));
    statements.push(env.DB.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, write_marker, workspace_id)
       SELECT column1, column2, column3, column4, column5, column6,
              column7, column8, column9, column10, column11
       FROM (VALUES ${values})
       WHERE ${edgeEndpointsReadableSql("column2", "column3", "json_array(column11)")}
       ON CONFLICT(source_id, target_id, type) DO UPDATE SET
         weight = max(weight, excluded.weight),
         updated_at = excluded.updated_at,
         write_marker = excluded.write_marker,
         workspace_id = excluded.workspace_id`,
    ).bind(...bindings));
  }
  return statements;
}

/** Inference upserts may refresh inference, but can never rewrite an explicit edge. */
function inferredEdgeInsertManyStatements(rows: EdgeInsertRow[], env: Env): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < rows.length; offset += EDGE_INSERT_ROWS_PER_STATEMENT) {
    const page = rows.slice(offset, offset + EDGE_INSERT_ROWS_PER_STATEMENT);
    const values = page.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const bindings = page.flatMap(row => edgeInsertBindings(row, env));
    statements.push(env.DB.prepare(
      // scope-exempt: candidates contain only endpoint IDs hydrated and workspace-checked by inference; this guard returns no corpus data
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, write_marker, workspace_id)
       SELECT column1, column2, column3, column4, column5, column6,
              column7, column8, column9, column10, column11
       FROM (VALUES ${values})
       WHERE ${edgeEndpointsReadableSql("column2", "column3", "json_array(column11)")}
         AND (column4 <> 'relates_to' OR NOT EXISTS (
         SELECT 1 FROM edges g
         WHERE ((g.source_id = column2 AND g.target_id = column3)
             OR (g.source_id = column3 AND g.target_id = column2))
           AND g.type <> 'relates_to'))
       ON CONFLICT(source_id, target_id, type) DO UPDATE SET
         weight = max(edges.weight, excluded.weight),
         metadata = excluded.metadata,
         updated_at = excluded.updated_at,
         write_marker = excluded.write_marker,
         workspace_id = excluded.workspace_id
       WHERE edges.provenance = 'inferred'`,
    ).bind(...bindings));
  }
  return statements;
}

async function inferenceRowsFor(
  recalculations: InferenceRecalculation[],
  env: Env,
): Promise<EdgeInsertRow[]> {
  const ids = recalculations.flatMap(item => [item.entryId, ...item.neighbors.map(n => n.id)]);
  const factsById = await loadEntryFacts(ids, env);
  const tagsById = new Map([...factsById].map(([id, fact]) => [id, fact.tags]));
  const deduplicated = new Map<string, EdgeInsertRow>();

  for (const item of recalculations) {
    const sourceTags = tagsById.get(item.entryId);
    if (!sourceTags || sourceTags.includes("status:deprecated")) continue;
    const sourceWorkspace = factsById.get(item.entryId)?.workspaceId ?? "";
    const existingNeighbors = item.neighbors.filter(neighbor => {
      const tags = tagsById.get(neighbor.id);
      return neighbor.id !== item.options?.suppressId
        && tags !== undefined
        && !tags.includes("status:deprecated")
        && factsById.get(neighbor.id)?.workspaceId === sourceWorkspace;
    });
    const rows = inferredEdgeRows(
      item.entryId, existingNeighbors, sourceTags, tagsById, sourceWorkspace,
    );
    const sourceFact = factsById.get(item.entryId)!;
    const newKind = item.options?.newKind !== undefined
      ? item.options.newKind : getKind(sourceTags);
    // Upstream #335: only one eligible, non-mirrored episodic predecessor in
    // the 30-minute window can be a follows edge. Multiple predecessors are a
    // burst, not evidence of a train of thought. Keep the calibrated Gemma
    // candidate gate above; no additional model or D1 call is needed.
    const qualifying = MIRRORED_SOURCES.has(sourceFact.source) ? [] : rows.filter(row => {
      const neighborId = row.sourceId === item.entryId ? row.targetId : row.sourceId;
      const fact = factsById.get(neighborId)!;
      if (MIRRORED_SOURCES.has(fact.source)
        || !kindsAllowEdge("follows", newKind, getKind(fact.tags))
        || sourceFact.createdAt == null || fact.createdAt == null) return false;
      const gap = sourceFact.createdAt - fact.createdAt;
      return gap > 0 && gap <= GRAPH_FOLLOWS_WINDOW_MS;
    });
    const followsRow = qualifying.length === 1 ? qualifying[0] : null;
    for (let row of rows) {
      if (row === followsRow) {
        const targetId = row.sourceId === item.entryId ? row.targetId : row.sourceId;
        row = { ...row, sourceId: item.entryId, targetId, type: "follows" };
      }
      const key = `${row.sourceId}|${row.targetId}|${row.type}`;
      const current = deduplicated.get(key);
      if (!current || row.weight > current.weight) deduplicated.set(key, row);
    }
  }
  return [...deduplicated.values()];
}

/** Retire only the inferred generic edges replaced by upstream typed evidence. */
export function retireInferredRelatesToStatements(
  pairs: { sourceId: string; targetId: string }[],
  env: Env,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  // Four endpoint bindings per pair plus the delete capability marker.
  for (let offset = 0; offset < pairs.length; offset += 24) {
    const page = pairs.slice(offset, offset + 24);
    const predicate = `type = 'relates_to' AND provenance = 'inferred' AND (${page.map(
      () => "((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))",
    ).join(" OR ")})`;
    const bindings = page.flatMap(pair => [pair.sourceId, pair.targetId, pair.targetId, pair.sourceId]);
    statements.push(
      env.DB.prepare(`UPDATE edges SET write_marker = ? WHERE ${predicate}`)
        .bind(memoryWriteMarker(env, "delete"), ...bindings),
      // scope-exempt: predicate contains only exact endpoint pairs already workspace-checked by inference or the weekly pass
      env.DB.prepare(`DELETE FROM edges WHERE ${predicate}`).bind(...bindings),
    );
  }
  return statements;
}

function inferenceWriteStatements(rows: EdgeInsertRow[], env: Env): D1PreparedStatement[] {
  // Preserve the fork's 9 rows / 99 bindings batching, including the upstream
  // pair-level generic-edge guard. A 24-edge refresh still uses three INSERTs.
  return inferredEdgeInsertManyStatements(rows, env);
}

export async function inferEdgesOnWrite(
  newId: string,
  neighbors: InferenceNeighbor[],
  env: Env,
  options: { suppressId?: string; newKind?: MemoryKind | null } = {},
): Promise<number> {
  if (!neighbors.some(neighbor => neighbor.id !== newId && neighbor.id !== options.suppressId
    && Number.isFinite(neighbor.score) && neighbor.score >= EDGE_INFER_THRESHOLD)) return 0;
  const rows = await inferenceRowsFor([{ entryId: newId, neighbors, options }], env);
  if (!rows.length) return 0;
  await assertMemoryWritesAllowed(env);
  const retire = retireInferredRelatesToStatements(rows.filter(row => row.type !== "relates_to"), env);
  const results = await env.DB.batch([...retire, ...inferenceWriteStatements(rows, env)]);
  // Upstream's count is committed inference INSERT/UPSERT changes, not new distinct
  // relationships. Capability staging and retirement must never inflate it.
  return results.slice(retire.length).reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
}

/**
 * Replace only inferred relates_to edges incident to the recalculated entries.
 * Explicit, system and typed relationship edges survive unchanged.
 */
export async function replaceInferredEdgesOnWrite(
  recalculations: InferenceRecalculation[],
  env: Env,
): Promise<number> {
  const entryIds = [...new Set(recalculations.map(item => item.entryId))];
  if (!entryIds.length) return 0;
  const rows = await inferenceRowsFor(recalculations, env);
  await assertMemoryWritesAllowed(env);

  const placeholders = entryIds.map(() => "?").join(", ");
  const incident = `provenance = 'inferred' AND type = 'relates_to'
    AND (source_id IN (${placeholders}) OR target_id IN (${placeholders}))`;
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE edges SET write_marker = ? WHERE ${incident}`)
      .bind(memoryWriteMarker(env, "delete"), ...entryIds, ...entryIds),
    // scope-exempt: incident is built only from authorized/recalculated entry IDs and deletes inferred edges touching exactly that set
    env.DB.prepare(`DELETE FROM edges WHERE ${incident}`).bind(...entryIds, ...entryIds),
    ...inferenceWriteStatements(rows, env),
  ]);
  // The first two statements stage/delete retired generic edges; only the
  // inference writes have the upstream inserted/updated-edge count semantics.
  return results.slice(2).reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
}
