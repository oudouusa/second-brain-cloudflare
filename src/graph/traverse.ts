import type { Env } from "../env";
import { DEFAULTS, type Config } from "../config";
import { D1_MAX_BOUND_PARAMS, WRITE_PATH_TOPK } from "../constants";
import { assertVectorProfiles } from "../embedding/profile";
import { getKind } from "../memory/kind";
import { getStatus } from "../memory/status";
import { layerOf, scopeWhere, scopeWhereForIdRead, scopeWhereForRead } from "../lib/scope";
import { nearestParents } from "../vectorize/parents";
import { resolveActorLabel } from "../lib/actors";
import type { Identity } from "../lib/identity";
import { projectFilterSql } from "../projects/filter";
import type { ProjectRow } from "../projects/registry";
import { edgeLabel } from "./edges";
import { EDGE_TYPES, type Connection, type ConnectionPage, type EdgeDirection, type EdgeProvenance, type EdgeType, type GraphNeighbor, type GraphView } from "./types";
import { isHeld, NOT_HELD_SQL, notHeldSqlFor } from "../quarantine/tags";

export const GRAPH_MAX_HOPS = 3;
const GRAPH_FANOUT_CAP = 8;
const GRAPH_MAX_NODES = 50;
// Ceiling on the /graph view's node set, applied even when the caller asks for
// no cap. The binding constraint is the Workers free-plan limit of 50
// subrequests per invocation, not row reads. buildGraph costs
//
//   1 (edge scan) + ceil(N/D1_MAX_BOUND_PARAMS) (node hydration)
//                 + ceil(N/EDGE_QUERY_BATCH)    (edge hydration)
//
// D1 queries for N nodes, plus one KV read for the config. At N=1500 that is
// 1 + 15 + 30 = 46, or 47 with the KV read. N=1600 lands on exactly 50 with
// nothing spare, and anything from 1634 up exceeds it outright — which would be
// a deterministically dead graph tab for every free-plan brain that large, and
// runGraphPass backfills edges nightly, so a brain arrives there on its own.
//
// That formula is the IDENTITY-LESS arithmetic — the cron callers. A scoped
// caller costs more, and it always did: the scope bindings share each
// statement's 100-parameter budget with the ids, so the batches shrink and the
// batch COUNT rises. Measured at N=1500 by counting D1 calls (a batch counts
// once, as the platform charges it):
//
//   identity-less                                    46
//   member, any view — personal, company or both     48
//   admin (reads the legacy '' layer too)            49
//
// Layer and author cost NOTHING on top of that: workspace_id and actor_id ride
// in the hydration's projection and the author's name arrives through a LEFT
// JOIN on it, so there is no per-view statement and no per-author bound
// parameter. A whole served request adds the identity batch and the KV config
// read: 50 for a member at N=1500, the entire free-plan budget with nothing
// spare. THAT TOTAL IS PINNED by "costs exactly this many subrequests at
// GRAPH_VIEW_MAX_NODES" in test/integration/graph-team-aware.test.ts — change it
// deliberately or not at all, and remember a cold isolate still pays
// initializeDatabase's DDL on top (#282).
//
// 47 is the WARM figure for the identity-less path. On a cold isolate the
// budget is shared with initializeDatabase, which fires under waitUntil and spends about 12 more on
// its DDL, so the first request against a fresh isolate costs ~59 and is over
// the limit — 1500 buys margin on the warm path, it does not clear the cold one.
// That is #282 (probe sqlite_master once instead of issuing twelve blind
// statements, taking cold /graph from 59 to 48), not something a lower cap here
// can fix: the tax is fixed, so it eats any N.
//
// Recompute the formula above before raising this, and count the cold case as
// well as the warm one. D1's 5M rows/day cap is the secondary bound and is
// nowhere near binding here; sizing against it is what produced a number that
// broke the free plan.
//
// It is a legibility limit too: the packed-cluster canvas is unreadable well
// before 1500 nodes.
export const GRAPH_VIEW_MAX_NODES = 1500;

/**
 * Entries the pipeline wrote about itself rather than memories a person stored: the
 * insight pass's proposals (and the auto-pattern finds it replaced) and the nightly
 * compression's digests.
 *
 * Recall already excludes both (src/recall/search.ts) and the dashboard reviews
 * them in a queue of their own, so the graph was the last surface drawing them as
 * life events. Filtered here rather than in the client so the places they were
 * occupying inside the node budget go to real memories instead.
 *
 * `rolled-up` and `duplicate-candidate` are deliberately absent: those mark a
 * person's own memory, and it stays in the graph whatever the pipeline has since
 * concluded about it.
 */
const MACHINE_AUTHORED_TAGS = new Set(["auto-pattern", "auto-insight", "synthesized"]);
export const GRAPH_HOP_DECAY = 0.6;
// A filtered traversal binds the type once in each UNION arm in addition to
// the two frontier copies and rank cap.
const EDGE_QUERY_BATCH = Math.floor((D1_MAX_BOUND_PARAMS - 3) / 2);
const GRAPH_EDGE_VIEW_PER_NODE = 8;
export const CONNECTIONS_DEFAULT_LIMIT = 20;
export const CONNECTIONS_MAX_LIMIT = 100;
export const CONNECTIONS_MAX_OFFSET = 10_000;
const CONNECTION_CURSOR_PREFIX = "c1.";

function directionFrom(fromId: string, sourceId: string, type: EdgeType): EdgeDirection {
  if (!EDGE_TYPES[type]?.directed) return "undirected";
  return fromId === sourceId ? "outgoing" : "incoming";
}

export function parseConnectionsCursor(cursor: string | undefined): number | null {
  if (cursor === undefined) return 0;
  if (!cursor.startsWith(CONNECTION_CURSOR_PREFIX)) return null;
  const raw = cursor.slice(CONNECTION_CURSOR_PREFIX.length);
  if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
  const offset = Number(raw);
  return Number.isSafeInteger(offset) && offset <= CONNECTIONS_MAX_OFFSET ? offset : null;
}

function connectionsCursor(offset: number): string {
  return `${CONNECTION_CURSOR_PREFIX}${offset}`;
}
/**
 * Ids one edge-fetch batch can carry. Each binds TWICE (source_id IN (…) OR
 * target_id IN (…)), and a scoped caller's workspace bindings come out of the
 * same D1_MAX_BOUND_PARAMS budget, so scoping shrinks it. Exported because it
 * is also the ceiling on how many seeds recall may hand this function before a
 * hop costs two statements instead of one (src/recall/neighborhood.ts).
 */
export const edgeScanBatchSize = (scopeBindings: number): number =>
  Math.max(1, Math.min(EDGE_QUERY_BATCH, Math.floor((D1_MAX_BOUND_PARAMS - scopeBindings * 2 - 1) / 2)));

/**
 * Two verdicts about a hop's candidate ids, from ONE scoped statement: which of
 * them the caller may actually read, and which are deprecated.
 *
 * They come from the same query because they are the same query. The scope clause
 * already restricts the rows to the caller's readable workspaces, so the ids that
 * come back ARE the readable ones — reading that off costs nothing beyond the
 * statement the deprecation check was issuing anyway, which is what keeps the
 * per-endpoint check inside the subrequest budget GRAPH_VIEW_MAX_NODES is sized
 * against. Absent an Identity there is nothing to be readable *to*, and the
 * `readable` set is not consulted.
 */
async function readableAndDeprecatedAmong(
  ids: string[],
  env: Env,
  identity?: Identity,
  only?: "personal" | "company",
  teamId?: string,
): Promise<{ readable: Set<string>; deprecated: Set<string>; held: Set<string>; validUntil: Map<string, number | null>; effectiveFrom: Map<string, number> }> {
  const scope = identity ? scopeWhereForRead(identity, { layer: only, teamId }) : null;
  const scopeSql = scope ? ` AND ${scopeWhereForIdRead(scope).clause}` : "";
  // Scope bindings share the statement's bound-parameter budget with the ids.
  const take = D1_MAX_BOUND_PARAMS - (scope?.bindings.length ?? 0);
  const readable = new Set<string>();
  const deprecated = new Set<string>();
  const held = new Set<string>();
  const validUntil = new Map<string, number | null>();
  const effectiveFrom = new Map<string, number>();
  for (let i = 0; i < ids.length; i += take) {
    const batch = ids.slice(i, i + take);
    const ph = batch.map(() => "?").join(", ");
    // This verdict feeds both recall's current-only hops and connections/graph's include-everything view; the caller decides which to keep
    // scope-checked: scopeSql applies the caller's clause through scopeWhereForIdRead above; the lexer cannot see the leading AND inside that JS fragment. Empty only for an identity-less caller
    // validity: any: valid_until and valid_from ride along for whichever caller wants them; expandGraph itself decides current, as-of or any
    const { results } = await env.DB.prepare(
      `SELECT id, tags, valid_from, valid_until, created_at FROM entries WHERE id IN (${ph})${scopeSql}`
    ).bind(...batch, ...(scope?.bindings ?? [])).all() as { results: Record<string, any>[] };
    for (const r of results) {
      readable.add(r.id as string);
      const tags = JSON.parse(r.tags ?? "[]");
      if (getStatus(tags) === "deprecated") deprecated.add(r.id as string);
      if (isHeld(tags)) held.add(r.id as string);
      validUntil.set(r.id as string, (r.valid_until as number | null | undefined) ?? null);
      effectiveFrom.set(r.id as string, (r.valid_from as number | null | undefined) ?? (r.created_at as number));
    }
  }
  return { readable, deprecated, held, validUntil, effectiveFrom };
}

/**
 * When `identity` is present, the edge scan, the deprecation check and — since a
 * scoped edge does not imply a readable endpoint — the candidate ids themselves
 * are all restricted to the caller's readable workspaces (personal ∪ company via
 * the IN-form, so a neighbour that legitimately lives in the other readable
 * workspace is kept). Absent — the cron callers — the SQL is exactly what it was
 * before tenancy, and so is the subrequest count.
 *
 * The endpoint check is what stops a walk travelling THROUGH a row the caller
 * cannot read. `edges.workspace_id` is denormalized from the SOURCE entry, and
 * moveEntry re-stamps every edge the moved entry is an endpoint of while the row
 * on the FAR side stays put — so an edge can legitimately be readable while the
 * row it points at is not: sharing one end of an existing link produces exactly
 * that. Every consumer already dropped such a row at
 * hydration, so nothing leaked — but an unread node still entered the frontier,
 * and hop 2 walked out the other side of it, making the caller's reachable set a
 * function of a colleague's private memory.
 */
export async function expandGraph(
  seedIds: string[],
  opts: { hops: number; fanoutCap?: number; maxNodes?: number; includeDeprecated?: boolean; includeSuperseded?: boolean; asOf?: number; includeSeedNeighbors?: boolean; type?: EdgeType; only?: "personal" | "company"; teamId?: string; project?: readonly ProjectRow[] },
  env: Env,
  config: Readonly<Config> = DEFAULTS,
  identity?: Identity,
): Promise<GraphNeighbor[]> {
  const hops = Math.max(0, Math.min(config.GRAPH_MAX_HOPS, opts.hops));
  if (hops === 0 || seedIds.length === 0) return [];
  const includeSuperseded = opts.includeSuperseded ?? opts.includeDeprecated ?? false;
  const now = opts.asOf ?? Date.now();
  const fanoutCap = opts.fanoutCap ?? GRAPH_FANOUT_CAP;
  const maxNodes = opts.maxNodes ?? GRAPH_MAX_NODES;
  const scope = identity
    ? scopeWhereForRead(identity, { layer: opts.only, teamId: opts.teamId })
    : null;

  const seedSet = new Set(seedIds);
  const visited = new Set(seedIds);
  const emittedSeedNeighbors = new Set<string>();
  const out: GraphNeighbor[] = [];
  let frontier = [...seedIds];

  for (let hop = 1; hop <= hops && frontier.length && out.length < maxNodes; hop++) {
    const edgeRows: { from_id: string; source_id: string; target_id: string; type: string; weight: number; provenance: EdgeProvenance; created_at: number }[] = [];
    const scopeBindings = scope?.bindings ?? [];
    const fixedBindings = (opts.type ? 2 : 0) + scopeBindings.length * 2 + 1;
    const edgeTake = Math.max(1, Math.min(
      EDGE_QUERY_BATCH,
      Math.floor((D1_MAX_BOUND_PARAMS - fixedBindings) / 2),
    ));
    for (let i = 0; i < frontier.length; i += edgeTake) {
      const batch = frontier.slice(i, i + edgeTake);
      const ph = batch.map(() => "?").join(", ");
      const typeClause = opts.type ? " AND type = ?" : "";
      const scopeClause = scope ? ` AND ${scope.clause}` : "";
      const bindings: (string | number)[] = [...batch];
      if (opts.type) bindings.push(opts.type);
      bindings.push(...scopeBindings);
      bindings.push(...batch);
      if (opts.type) bindings.push(opts.type);
      bindings.push(...scopeBindings);
      bindings.push(fanoutCap);
      const { results } = await env.DB.prepare(
        // scope-checked: scopeClause is assembled from the resolved identity and appended to both UNION arms; identity-less internal callers preserve the legacy graph helper
        `WITH incident AS (
           SELECT source_id AS from_id, source_id, target_id, type, weight, provenance, created_at
             FROM edges WHERE source_id IN (${ph})${typeClause}${scopeClause}
           UNION ALL
           SELECT target_id AS from_id, source_id, target_id, type, weight, provenance, created_at
             FROM edges WHERE target_id IN (${ph})${typeClause}${scopeClause}
         ), ranked AS (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY from_id
             ORDER BY weight DESC, created_at DESC, source_id ASC, target_id ASC
           ) AS rank
             FROM incident
         )
         SELECT from_id, source_id, target_id, type, weight, provenance, created_at
           FROM ranked WHERE rank <= ?
          ORDER BY weight DESC, created_at DESC`
      ).bind(...bindings).all() as { results: any[] };
      edgeRows.push(...results);
    }

    const frontierSet = new Set(frontier);
    const perNodeCount = new Map<string, number>();
    const candidates: GraphNeighbor[] = [];
    for (const e of edgeRows) {
      let from: string | null = null;
      let to: string | null = null;
      if (frontierSet.has(e.from_id)) {
        from = e.from_id;
        to = from === e.source_id ? e.target_id : from === e.target_id ? e.source_id : null;
      }
      if (!from || !to) continue;
      const seedNeighbor = hop === 1 && opts.includeSeedNeighbors === true && seedSet.has(to);
      if ((!seedNeighbor && visited.has(to)) || (seedNeighbor && emittedSeedNeighbors.has(to))) continue;
      const n = perNodeCount.get(from) ?? 0;
      if (n >= fanoutCap) continue;
      perNodeCount.set(from, n + 1);
      const viaType = e.type as GraphNeighbor["viaType"];
      candidates.push({
        id: to,
        hop,
        viaWeight: e.weight,
        viaType,
        viaProvenance: e.provenance,
        viaLinkedAt: e.created_at,
        viaFrom: from,
        viaSourceId: e.source_id,
        viaTargetId: e.target_id,
        viaDirection: directionFrom(from, e.source_id, viaType),
      });
    }

    let allowed = candidates;
    // Skipped only when none of the three verdicts is wanted — an identity-less
    // caller that also wants deprecated rows (and so, by the default above,
    // superseded ones too) has nothing to filter, so it issues no statement
    // and costs exactly what it did before tenancy (and before T-0089.2.1).
    if (candidates.length && (identity || !opts.includeDeprecated || !includeSuperseded || opts.asOf !== undefined)) {
      // Held is treated exactly like deprecated (5.3): filtered whenever this
      // statement runs, never released by includeDeprecated. The one case it
      // does not cover — an identity-less caller that also wants deprecated
      // and superseded rows, where the statement is skipped entirely to cost
      // nothing beyond what a pre-tenancy caller always paid — is the
      // cron/backfill path (graph-hop-isolation.test.ts).
      const { readable, deprecated, held, validUntil, effectiveFrom } = await readableAndDeprecatedAmong(
        [...new Set(candidates.map(c => c.id))], env, identity, opts.only, opts.teamId,
      );
      allowed = candidates
        .filter(c => {
          const until = validUntil.get(c.id) ?? null;
          if (opts.asOf !== undefined) {
            // Beliefs are not expanded (item 4): a deprecated node never crosses a hop, whatever
            // includeDeprecated/includeSuperseded ask for. Validity is checked against T, not now.
            const from = effectiveFrom.get(c.id) ?? 0;
            return (!identity || readable.has(c.id)) && !deprecated.has(c.id)
              && from <= now && (until === null || until > now) && !held.has(c.id);
          }
          return (!identity || readable.has(c.id))
            && (opts.includeDeprecated || !deprecated.has(c.id))
            && (includeSuperseded || until === null || until > now)
            && !held.has(c.id);
        })
        .map(c => ({ ...c, validUntil: validUntil.get(c.id) ?? null }));
    }

    const nextFrontier: string[] = [];
    for (const c of allowed) {
      const seedNeighbor = seedSet.has(c.id);
      if ((!seedNeighbor && visited.has(c.id)) || (seedNeighbor && emittedSeedNeighbors.has(c.id))) continue;
      if (out.length >= maxNodes) break;
      if (seedNeighbor) {
        emittedSeedNeighbors.add(c.id);
        out.push(c);
        continue;
      }
      visited.add(c.id);
      out.push(c);
      nextFrontier.push(c.id);
    }
    frontier = nextFrontier;
  }

  return out;
}

async function hydrateGraphEntries(
  ids: string[],
  env: Env,
  identity?: Identity,
  only?: "personal" | "company",
  teamId?: string,
): Promise<Map<string, Record<string, any>>> {
  const map = new Map<string, Record<string, any>>();
  const scope = identity ? scopeWhereForRead(identity, { layer: only, teamId }) : null;
  const scopeSql = scope ? ` AND ${scopeWhereForIdRead(scope).clause}` : "";
  // Scope bindings share the statement's bound-parameter budget with the ids.
  const take = D1_MAX_BOUND_PARAMS - (scope?.bindings.length ?? 0);
  for (let i = 0; i < ids.length; i += take) {
    const batch = ids.slice(i, i + take);
    const ph = batch.map(() => "?").join(", ");
    // scope-checked: scopeSql applies the caller's clause through scopeWhereForIdRead above; the lexer cannot see the leading AND inside that JS fragment. Empty only for an identity-less caller
    // validity: any: a graph-relationship view, not a current-facts answer (5.5)
    const { results } = await env.DB.prepare(
      `SELECT id, content, tags, source, created_at, valid_until FROM entries WHERE id IN (${ph})${scopeSql} AND ${NOT_HELD_SQL}`
    ).bind(...batch, ...(scope?.bindings ?? [])).all() as { results: Record<string, any>[] };
    for (const r of results) map.set(r.id as string, r);
  }
  return map;
}

/** Legacy array API retained for internal callers; public REST/MCP use the page API below. */
export async function getConnections(
  id: string,
  type: string | undefined,
  env: Env,
  config: Readonly<Config> = DEFAULTS,
  identity?: Identity,
): Promise<Connection[]> {
  const edgeType = type && type in EDGE_TYPES ? type as EdgeType : undefined;
  if (type && !edgeType) return [];
  let neighbors = await expandGraph([id], { hops: 1, type: edgeType, includeDeprecated: true, includeSuperseded: true }, env, config, identity);
  if (type) neighbors = neighbors.filter(n => n.viaType === type);
  if (!neighbors.length) return [];

  const rows = await hydrateGraphEntries(neighbors.map(n => n.id), env, identity);
  const out: Connection[] = [];
  for (const n of neighbors) {
    const row = rows.get(n.id);
    if (!row) continue;
    out.push({
      id: n.id,
      content: row.content as string,
      tags: JSON.parse(row.tags ?? "[]"),
      source: row.source as string,
      created_at: row.created_at as number,
      type: n.viaType,
      label: edgeLabel(n.viaType),
      weight: n.viaWeight,
      provenance: n.viaProvenance,
      linkedAt: n.viaLinkedAt,
      sourceId: n.viaSourceId,
      targetId: n.viaTargetId,
      direction: n.viaDirection,
      validUntil: (row.valid_until as number | null | undefined) ?? null,
    });
  }
  return out;
}

/**
 * Page incident edges directly instead of filtering expandGraph's node-deduped
 * output. A pair may carry more than one relationship type; applying `type`
 * inside this SQL keeps a stronger relationship of another type from hiding
 * the requested one.
 */
export async function getConnectionsPage(
  id: string,
  type: string | undefined,
  opts: { limit?: number; cursor?: string },
  env: Env,
  _config: Readonly<Config>,
  identity?: Identity,
): Promise<ConnectionPage> {
  const parsedOffset = parseConnectionsCursor(opts.cursor);
  if (parsedOffset === null) throw new RangeError("Invalid connections cursor");
  const limit = Math.max(1, Math.min(CONNECTIONS_MAX_LIMIT, Math.floor(opts.limit ?? CONNECTIONS_DEFAULT_LIMIT)));
  const typeClause = type ? " AND type = ?" : "";
  const edgeScope = identity ? scopeWhere(identity) : null;
  const edgeScopeClause = edgeScope ? ` AND ${edgeScope.clause}` : "";
  const nodeScope = identity ? scopeWhere(identity, undefined, "n.workspace_id") : null;
  const nodeScopeClause = nodeScope ? ` AND ${nodeScope.clause}` : "";
  const bindings: (string | number)[] = [id];
  if (type) bindings.push(type);
  bindings.push(...(edgeScope?.bindings ?? []));
  bindings.push(id);
  if (type) bindings.push(type);
  bindings.push(...(edgeScope?.bindings ?? []));
  bindings.push(...(nodeScope?.bindings ?? []));
  bindings.push(limit + 1, parsedOffset);

  const { results } = await env.DB.prepare(
    // scope-checked: edgeScopeClause is appended to both edge arms and nodeScopeClause filters the joined memory rows, all from the resolved identity
    `WITH incident_connections AS (
       SELECT source_id, target_id, type, weight, provenance, created_at, target_id AS neighbor_id
         FROM edges WHERE source_id = ?${typeClause}${edgeScopeClause}
       UNION ALL
       SELECT source_id, target_id, type, weight, provenance, created_at, source_id AS neighbor_id
         FROM edges WHERE target_id = ?${typeClause}${edgeScopeClause}
     )
     SELECT e.source_id, e.target_id, e.type, e.weight, e.provenance, e.created_at,
            n.id, n.content, n.tags, n.source, n.created_at AS entry_created_at, n.valid_until
       FROM incident_connections e
       JOIN entries n ON n.id = e.neighbor_id
      WHERE ${notHeldSqlFor("n")}${nodeScopeClause}
      ORDER BY e.weight DESC, e.created_at DESC, e.source_id ASC, e.target_id ASC, e.type ASC
      LIMIT ? OFFSET ?`
  ).bind(...bindings).all() as { results: Record<string, any>[] };

  const hasMore = results.length > limit;
  const connections = results.slice(0, limit).map((row): Connection => {
    const edgeType = row.type as EdgeType;
    return {
      id: row.id as string,
      content: row.content as string,
      tags: JSON.parse(row.tags ?? "[]"),
      source: row.source as string,
      created_at: row.entry_created_at as number,
      type: edgeType,
      label: edgeLabel(edgeType),
      weight: row.weight as number,
      provenance: row.provenance as EdgeProvenance,
      linkedAt: row.created_at as number,
      sourceId: row.source_id as string,
      targetId: row.target_id as string,
      direction: directionFrom(id, row.source_id as string, edgeType),
      validUntil: (row.valid_until as number | null | undefined) ?? null,
    };
  });
  return {
    connections,
    nextCursor: hasMore ? connectionsCursor(parsedOffset + limit) : null,
  };
}

export async function buildGraph(
  opts: { seed?: string; limit?: number; only?: "personal" | "company"; teamId?: string; project?: readonly ProjectRow[] },
  env: Env,
  config: Readonly<Config> = DEFAULTS,
  identity?: Identity,
): Promise<GraphView> {
  // "No cap" resolves to GRAPH_VIEW_MAX_NODES, never to Infinity. Anything that
  // is not a positive finite number — absent, 0, negative, NaN — takes that
  // branch, so a caller who reaches here past the route's own validation still
  // cannot ask for an unbounded result set. Keeping `limit` a finite integer is
  // also what makes it safe to interpolate into the SQL below.
  //
  // The LIMIT bounds rows *returned*, not rows read: `weight` has no index, so
  // SQLite full-scans and sorts `edges` either way and rows_read is unchanged.
  // Bounding the result is still the point — it is what caps the node set, and
  // the node set is what drives the query count above.
  const asked = Number.isFinite(opts.limit) && (opts.limit as number) > 0
    ? Math.floor(opts.limit as number)
    : GRAPH_VIEW_MAX_NODES;
  const limit = Math.min(asked, GRAPH_VIEW_MAX_NODES);

  let nodeIds: string[];
  let strongestEdges: { source_id: string; target_id: string; type: string; weight: number; provenance: EdgeProvenance; created_at: number }[] | null = null;
  const scope = identity
    ? scopeWhereForRead(identity, { layer: opts.only, teamId: opts.teamId })
    : null;
  if (opts.seed) {
    const neighbors = await expandGraph([opts.seed], {
      hops: 2,
      maxNodes: limit,
      includeDeprecated: true, includeSuperseded: true,
      only: opts.only,
      teamId: opts.teamId,
    }, env, config, identity);
    nodeIds = [opts.seed, ...neighbors.map(n => n.id)].slice(0, limit);
  } else {
    // A project view seeds only from edges with at least one member endpoint (its tag or an
    // alias); the other endpoint rides along as a neighbour. The member set is one CTE, so
    // the patterns bind once, and both its read and the edge scan carry the caller's scope.
    // Needs an identity: the route always has one, the identity-less cron callers never pass a project.
    const project = scope && opts.project ? projectFilterSql(opts.project) : null;
    // validity: any: member ids only, feeding the same node hydration below that carries valid_until (5.5)
    const { results } = await env.DB.prepare(
      // scope-checked: when an identity is present the selected ternary arm applies its resolved scope; the identity-less arm is retained only for internal/legacy whole-graph calls
      project && scope
        ? `WITH member AS (SELECT id FROM entries WHERE ${project.clause} AND ${scope.clause})
           SELECT source_id, target_id, type, weight, provenance, created_at FROM edges WHERE ${scope.clause} AND (source_id IN (SELECT id FROM member) OR target_id IN (SELECT id FROM member)) ORDER BY weight DESC LIMIT ${limit * 4}`
        : scope
        ? `SELECT source_id, target_id, type, weight, provenance, created_at FROM edges WHERE ${scope.clause} ORDER BY weight DESC LIMIT ${limit * 4}`
        // scope-exempt: identityなしの内部グラフ処理だけが全体を読む。公開routeはidentityを渡す。
        : `SELECT source_id, target_id, type, weight, provenance, created_at FROM edges ORDER BY weight DESC LIMIT ${limit * 4}`
    ).bind(...(project && scope ? [...project.bindings, ...scope.bindings] : []), ...(scope?.bindings ?? [])).all() as { results: { source_id: string; target_id: string; type: string; weight: number; provenance: EdgeProvenance; created_at: number }[] };
    strongestEdges = results;
    const ids: string[] = [];
    const seenIds = new Set<string>();
    for (const r of results) {
      for (const id of [r.source_id, r.target_id]) {
        if (ids.length >= limit) break;
        if (!seenIds.has(id)) { seenIds.add(id); ids.push(id); }
      }
      if (ids.length >= limit) break;
    }
    nodeIds = ids;
  }
  if (!nodeIds.length) return { nodes: [], edges: [] };

  const nodeRows = new Map<string, Record<string, any>>();
  /**
   * actor_id → display name, read off the join below rather than looked up.
   *
   * The author names cost NO statement and NO bound parameter: a second query
   * would have to bind one parameter per distinct author against D1's hard
   * ceiling of 100 (D1_MAX_BOUND_PARAMS), and this is the one caller that cannot
   * promise to stay under it — GET /list is bounded by its page size and GET
   * /entry by one row, but a GRAPH_VIEW_MAX_NODES view can span every author on
   * the deployment. At 101 distinct authors that statement is rejected outright
   * and the whole graph request 500s. node:sqlite has no such limit, so no test
   * against it can show this; the join is what removes the possibility.
   */
  const actorNames = new Map<string, string>();
  // Aliased, and the scope clause names the alias: once a second table is in the
  // statement, an unqualified `workspace_id` is a clause a reader (and the scope
  // checker) has to resolve by knowing which table has the column.
  const nodeScope = identity ? scopeWhereForRead(identity, { layer: opts.only, teamId: opts.teamId }, "e.workspace_id") : null;
  const nodeScopeSql = nodeScope ? ` AND ${scopeWhereForIdRead(nodeScope).clause}` : "";
  // Scope bindings share the statement's bound-parameter budget with the ids.
  const nodeTake = D1_MAX_BOUND_PARAMS - (nodeScope?.bindings.length ?? 0);
  for (let i = 0; i < nodeIds.length; i += nodeTake) {
    const batch = nodeIds.slice(i, i + nodeTake);
    const ph = batch.map(() => "?").join(", ");
    // workspace_id, actor_id and source ride along in the projection the
    // hydration was already issuing, and the author's name arrives with them
    // through a join on the users primary key: same rows, same statement, no
    // extra read. The join is soft-delete aware exactly as lookupActorLabels is,
    // so a removed member still resolves to "Former member" rather than to a
    // stale name.
    //
    // Keep the annotation below immediately above the statement: it is spent by
    // the first query within five lines of it, and prose in between silently
    // pushes the statement out of that window.
    // scope-checked: nodeScopeSql applies the caller's clause to e through scopeWhereForIdRead above; the lexer cannot see the leading AND inside that JS fragment. The users join supplies labels only
    // validity: any: a graph-relationship view, not a current-facts answer (5.5)
    const { results } = await env.DB.prepare(
      `SELECT e.id, e.content, e.tags, e.importance_score, e.created_at,
              e.workspace_id, e.actor_id, e.source, e.valid_until, u.name AS actor_display_name
       FROM entries e
       LEFT JOIN users u ON u.id = e.actor_id AND (u.removed_at IS NULL OR u.removed_at = 0)
       WHERE e.id IN (${ph})${nodeScopeSql} AND ${NOT_HELD_SQL}`
    ).bind(...batch, ...(nodeScope?.bindings ?? [])).all() as { results: Record<string, any>[] };
    for (const r of results) {
      nodeRows.set(r.id as string, r);
      if (r.actor_id && r.actor_display_name) {
        actorNames.set(String(r.actor_id), String(r.actor_display_name));
      }
    }
  }

  const nodes: GraphView["nodes"] = [];
  for (const id of nodeIds) {
    const r = nodeRows.get(id);
    if (!r) continue;
    const tags: string[] = JSON.parse(r.tags ?? "[]");
    if (tags.some(t => MACHINE_AUTHORED_TAGS.has(t)) || isHeld(tags)) continue;
    // Exactly GET /list's layer rule, because it is that function: the canvas
    // and the list badge the same row the same way. Without an Identity there
    // is no personal or company layer to be in — the cron and unit callers get
    // "system" on every node and no author lookup at all.
    const workspace = layerOf(identity, r.workspace_id);
    nodes.push({
      id,
      label: (r.content as string).slice(0, 80),
      tags,
      kind: getKind(tags),
      status: getStatus(tags),
      importance: (r.importance_score as number) ?? 0,
      created_at: r.created_at as number,
      workspace,
      // Named by the same resolver /list and /entry use, given the same inputs —
      // including `source`, so a row the pipeline wrote reads SYSTEM_ACTOR_LABEL
      // on the canvas exactly as it does in the list. Only company-layer nodes have an
      // author to name; `viewerId` is what turns the caller's own into "You".
      actor_name: workspace === "company"
        ? resolveActorLabel(String(r.actor_id ?? ""), actorNames, {
            viewerId: identity?.userId,
            source: String(r.source ?? ""),
          })
        : null,
      validUntil: (r.valid_until as number | null | undefined) ?? null,
    });
  }

  const nodeIdSet = new Set(nodes.map(n => n.id));
  if (!nodeIdSet.size) return { nodes: [], edges: [] };

  const presentIds = [...nodeIdSet];
  const edgeSeen = new Set<string>();
  const edges: GraphView["edges"] = [];
  const collect = (results: any[]) => {
    for (const e of results) {
      if (!nodeIdSet.has(e.source_id) || !nodeIdSet.has(e.target_id)) continue;
      const key = `${e.source_id}|${e.target_id}|${e.type}`;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      edges.push({ source: e.source_id, target: e.target_id, type: e.type, weight: e.weight, provenance: e.provenance });
    }
  };
  if (strongestEdges) {
    // The full-graph node selection already materialized a globally bounded strongest
    // edge set. Reuse it instead of issuing incident-edge queries whose dense-graph
    // result can grow quadratically and duplicate rows across batches.
    collect(strongestEdges);
  } else {
    for (let i = 0; i < presentIds.length; i += EDGE_QUERY_BATCH) {
      const batch = presentIds.slice(i, i + EDGE_QUERY_BATCH);
      const ph = batch.map(() => "?").join(", ");
      const { results } = await env.DB.prepare(
        // scope-exempt: presentIds were already selected through the scoped seeded graph walk and scoped node hydration, so this query only returns edges incident to that closed set
        `SELECT source_id, target_id, type, weight, provenance, created_at FROM edges WHERE source_id IN (${ph}) OR target_id IN (${ph}) ORDER BY weight DESC LIMIT ${batch.length * GRAPH_EDGE_VIEW_PER_NODE}`
      ).bind(...batch, ...batch).all() as { results: any[] };
      collect(results);
    }
  }

  return { nodes, edges };
}

export async function neighborsFromVectorQuery(values: number[], env: Env): Promise<{ id: string; score: number }[]> {
  return neighborsFromVectorQueries([values], env);
}

/** Keep graph refresh bounded while still sampling the beginning, middle and end. */
export function representativeVectors<T>(items: readonly T[], limit = 3): T[] {
  if (limit <= 0) return [];
  if (items.length <= limit) return [...items];
  if (limit === 1) return items.length ? [items[0]] : [];
  const indexes = new Set<number>();
  for (let i = 0; i < limit; i++) {
    indexes.add(Math.round(i * (items.length - 1) / (limit - 1)));
  }
  return [...indexes].map(index => items[index]);
}

/** Merge the strongest parent-level score across representative entry chunks. */
export async function neighborsFromVectorQueries(
  vectors: number[][],
  env: Env,
): Promise<{ id: string; score: number }[]> {
  const scores = new Map<string, number>();
  const results = await Promise.all(
    vectors.map(values => env.VECTORIZE.query(values, { topK: WRITE_PATH_TOPK, returnMetadata: "all" })),
  );
  for (const { matches } of results) {
    assertVectorProfiles(matches);
    for (const m of nearestParents(matches)) {
      const pid = (m.metadata as any)?.parentId ?? m.id;
      scores.set(pid, Math.max(scores.get(pid) ?? 0, m.score));
    }
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score }));
}
