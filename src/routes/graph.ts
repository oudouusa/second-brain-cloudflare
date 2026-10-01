import type { Env } from "../env";
import { intParam, json, readJsonBody, readTeamQueryParam, readWorkspaceParam } from "../lib/http";
import { requireIdentity } from "../lib/identity";
import { getReadableEntry } from "../lib/entry-access";
import { readTeamParam, readableWorkspaces } from "../lib/scope";
import { createEdge, CROSS_WORKSPACE_LINK_MESSAGE, deleteEdge, isValidEdgeType, kindMismatchMessage, kindOfRow, kindsAllowEdge } from "../graph/edges";
import { EDGE_TYPES } from "../graph/types";
import {
  buildGraph,
  CONNECTIONS_DEFAULT_LIMIT,
  CONNECTIONS_MAX_LIMIT,
  getConnectionsPage,
  parseConnectionsCursor,
} from "../graph/traverse";
import { resolveConfig } from "../config";
import { readProjectParam } from "./project-param";
import { maybeMarkFollowedMany } from "../recall/log";

export async function handleGraphRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // POST /link — create an explicit edge between two memories, mirrors the MCP `link` tool
  if (url.pathname === "/link" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { source_id?: string; target_id?: string; type?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const sourceId = body.source_id?.trim();
    const targetId = body.target_id?.trim();
    if (!sourceId || !targetId) return json({ ok: false, error: "source_id and target_id are required" }, 400);
    const type = body.type?.trim() || "relates_to";
    if (!isValidEdgeType(type)) {
      return json({ ok: false, error: `type must be one of: ${Object.keys(EDGE_TYPES).join(", ")}` }, 400);
    }
    if (sourceId === targetId) return json({ ok: false, error: "Cannot link an entry to itself" }, 400);
    const source = await getReadableEntry(env, auth, sourceId, "id, workspace_id, actor_id, tags");
    if (!source) return json({ ok: false, error: `No memory found with ID: ${sourceId}` }, 404);
    const target = await getReadableEntry(env, auth, targetId, "id, workspace_id, actor_id, tags");
    if (!target) return json({ ok: false, error: `No memory found with ID: ${targetId}` }, 404);
    // Same-workspace only. edges.workspace_id is one denormalized column copied
    // from the source entry, and a share re-stamps it to follow the entry that
    // moved — so an edge whose endpoints started in different workspaces has no
    // correct value at all, and is guaranteed to go inconsistent rather than
    // merely unusual. Refusing here
    // gives an instruction the user can act on instead of a link that silently
    // vanishes from their graph. Costs nothing on a solo brain: one workspace.
    if (source.workspace_id !== target.workspace_id) {
      return json({ ok: false, error: CROSS_WORKSPACE_LINK_MESSAGE, code: "cross_workspace_link" }, 400);
    }
    if (!kindsAllowEdge(type, kindOfRow(source), kindOfRow(target))) {
      return json({ ok: false, error: kindMismatchMessage(type), code: "kind_not_allowed" }, 400);
    }

    const edge = await createEdge(sourceId, targetId, type, { provenance: "explicit", weight: 1.0, workspaceId: source.workspace_id, readableWorkspaceIds: readableWorkspaces(auth) }, env);
    if (!edge) return json({ ok: false, error: "Cannot link an entry to itself" }, 400);
    // T-0089.5.2 Part B: a link on a recently-recalled id is implicit feedback that
    // the recall was used. Checked for both ends together (one shared read-then-write,
    // not two racing ones); config is only resolved if a matching row is found, so the
    // common case (RECALL_LOG never turned on) costs no KV read.
    ctx.waitUntil(maybeMarkFollowedMany(env, source.workspace_id, [sourceId, targetId], Date.now()));
    return json({ ok: true, source_id: edge.source_id, target_id: edge.target_id, type: edge.type });
  }

  // POST /unlink — remove a relationship link, mirrors the MCP `unlink` tool.
  // POST rather than DELETE /link: CORS_HEADERS allow only GET/POST/OPTIONS and
  // every sibling mutation route is POST.
  if (url.pathname === "/unlink" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { source_id?: string; target_id?: string; type?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const sourceId = body.source_id?.trim();
    const targetId = body.target_id?.trim();
    if (!sourceId || !targetId) return json({ ok: false, error: "source_id and target_id are required" }, 400);
    const type = body.type?.trim() || undefined;
    if (type && !isValidEdgeType(type)) {
      return json({ ok: false, error: `type must be one of: ${Object.keys(EDGE_TYPES).join(", ")}` }, 400);
    }

    const source = await getReadableEntry(env, auth, sourceId, "id, workspace_id, actor_id, tags");
    if (!source) return json({ ok: false, error: `No entry found with ID: ${sourceId}` }, 404);
    const target = await getReadableEntry(env, auth, targetId);
    if (!target) return json({ ok: false, error: `No memory found with ID: ${targetId}` }, 404);

    const deleted = await deleteEdge(sourceId, targetId, type, env);
    return json({ ok: true, deleted });
  }

  if (url.pathname === "/connections" && request.method === "GET") {
    return new Response(JSON.stringify({ ok: false, error: "Use POST /connections with a JSON body" }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Allow": "POST" },
    });
  }

  // POST /connections — 1-hop neighbors of an entry, mirrors the MCP `connections` tool
  if (url.pathname === "/connections" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const parsed = await readJsonBody<{ id?: unknown; type?: unknown; limit?: unknown; cursor?: unknown }>(request, 8 * 1024);
    if (!parsed.ok) return parsed.response;
    const id = typeof parsed.value.id === "string" ? parsed.value.id.trim() : "";
    if (!id) return json({ ok: false, error: "id is required" }, 400);
    if (!await getReadableEntry(env, auth, id)) {
      return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    }
    const type = typeof parsed.value.type === "string" ? parsed.value.type.trim() || undefined : undefined;
    if (type && !isValidEdgeType(type)) {
      return json({ ok: false, error: `type must be one of: ${Object.keys(EDGE_TYPES).join(", ")}` }, 400);
    }
    const limit = parsed.value.limit === undefined ? CONNECTIONS_DEFAULT_LIMIT : parsed.value.limit;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > CONNECTIONS_MAX_LIMIT) {
      return json({ ok: false, error: `limit must be an integer from 1 to ${CONNECTIONS_MAX_LIMIT}` }, 400);
    }
    const cursor = parsed.value.cursor === undefined
      ? undefined
      : typeof parsed.value.cursor === "string" ? parsed.value.cursor.trim() : null;
    if (cursor === null || parseConnectionsCursor(cursor) === null) {
      return json({ ok: false, error: "cursor is invalid" }, 400);
    }

    const page = await getConnectionsPage(
      id, type, { limit, cursor }, env, await resolveConfig(env), auth,
    );
    return json({ ok: true, id, connections: page.connections, next_cursor: page.nextCursor });
  }

  // GET /graph — node+edge subgraph for the dashboard graph view (dashboard-only;
  // no MCP twin — this is visualization data, not an agent capability)
  if (url.pathname === "/graph" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    if (url.searchParams.has("seed")) {
      return json({ ok: false, error: "Use POST /graph for a private seed" }, 405);
    }
    const seed = undefined;
    // Omitted still means the whole graph, up to buildGraph's own ceiling. The
    // floor of 1 is what stops `?limit=0` and `?limit=-1` from meaning that too.
    const limit = intParam(url, "limit", { min: 1 });
    if (limit instanceof Response) return limit;
    // Same layer filter, same 400, as /list and /recall — it can only ever
    // narrow the caller's readable set, never name a workspace outside it.
    const workspace = readWorkspaceParam(url);
    if (workspace instanceof Response) return workspace;
    const team = readTeamQueryParam(url, auth, workspace);
    if (team instanceof Response) return team;

    const project = await readProjectParam(env, auth, url, { layer: workspace, teamId: team });
    if (project instanceof Response) return project;
    const { nodes, edges } = await buildGraph(
      { seed, limit, only: workspace, teamId: team, project },
      env,
      await resolveConfig(env),
      auth,
    );
    return json({ ok: true, nodes, edges });
  }

  if (url.pathname === "/graph" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const parsed = await readJsonBody<{ seed?: unknown; limit?: unknown; workspace?: unknown; team?: unknown; project?: unknown }>(request, 8 * 1024);
    if (!parsed.ok) return parsed.response;
    const seed = typeof parsed.value.seed === "string" ? parsed.value.seed.trim() || undefined : undefined;
    if (parsed.value.limit !== undefined
      && (typeof parsed.value.limit !== "number" || !Number.isSafeInteger(parsed.value.limit))) {
      return json({ ok: false, error: "limit must be an integer" }, 400);
    }
    const limit = typeof parsed.value.limit === "number" ? Math.max(1, parsed.value.limit) : undefined;
    if (parsed.value.workspace !== undefined
      && parsed.value.workspace !== "personal"
      && parsed.value.workspace !== "company") {
      return json({ ok: false, error: 'workspace must be "personal" or "company"' }, 400);
    }
    if (seed && !await getReadableEntry(env, auth, seed)) {
      return json({ ok: false, error: `No entry found with ID: ${seed}` }, 404);
    }
    const only = parsed.value.workspace as "personal" | "company" | undefined;
    const teamRead = readTeamParam(parsed.value.team, auth, only);
    if (teamRead.error) return json({ ok: false, error: teamRead.error }, 400);
    const project = await readProjectParam(env, auth, url, { layer: only, teamId: teamRead.teamId }, parsed.value.project);
    if (project instanceof Response) return project;
    const { nodes, edges } = await buildGraph(
      { seed, limit, only, teamId: teamRead.teamId, project }, env, await resolveConfig(env), auth,
    );
    return json({ ok: true, nodes, edges });
  }

  return null;
}
