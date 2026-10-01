import type { Env } from "../env";
import { json, readTeamQueryParam, readWorkspaceParam } from "../lib/http";
import { requireIdentity, type Identity } from "../lib/identity";
import { adminAuditEvent } from "../lib/admin-audit";
import { layerOf, readScopeWorkspaces, scopeWhereForRead } from "../lib/scope";
import {
  InvalidProjectInputError,
  ProjectNotFoundError,
  SlugTakenError,
  PROJECT_SLUG_RE,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
  type ProjectPatch,
  type ProjectRow,
} from "../projects/registry";
import { PROJECT_TAG_PREFIX } from "../tags/system";
import { writeContextFor } from "./capture";

const PROJECT_PATH = /^\/projects\/([^/]+)$/;
/** Rows the counts scan may read; past it the tally is flagged approximate. */
const COUNTS_SCAN_LIMIT = 5000;

const truthy = (raw: string | null) => raw === "1" || raw === "true";
// Workspace ids never contain "/" and slugs cannot, so this key is unambiguous.
const countKey = (workspaceId: string, slug: string) => `${workspaceId}/${slug}`;

function view(identity: Identity, row: ProjectRow, count?: number) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    aliases: row.aliases,
    status: row.status,
    workspace_id: row.workspace_id,
    layer: layerOf(identity, row.workspace_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(count === undefined ? {} : { count }),
  };
}

/** Domain validation failures map to the status the contract names; anything else is a real fault. */
function failure(e: unknown): Response {
  if (e instanceof InvalidProjectInputError) return json({ ok: false, error: e.message }, 400);
  if (e instanceof SlugTakenError) return json({ ok: false, error: e.message }, 409);
  if (e instanceof ProjectNotFoundError) return json({ ok: false, error: e.message }, 404);
  throw e;
}

/**
 * Memberships per (workspace, slug) in ONE statement: the partial index holds only
 * entries that carry a project: tag, so this reads members, never the whole corpus.
 * Alias-matched entries are deliberately not counted.
 */
async function tallyMembers(env: Env, identity: Identity, opts: { layer?: "personal" | "company"; teamId?: string }) {
  const scope = scopeWhereForRead(identity, opts);
  const scan = (hint: string) => env.DB.prepare(
    `SELECT workspace_id, tags FROM entries${hint}
      WHERE ${scope.clause} AND instr(lower(tags), '"project:') > 0
      LIMIT ${COUNTS_SCAN_LIMIT}`,
  ).bind(...scope.bindings).all<{ workspace_id: string; tags: string }>();
  let results: { workspace_id: string; tags: string }[];
  try {
    ({ results } = await scan(" INDEXED BY idx_entries_project"));
  } catch (e) {
    // Just upgraded: the index is created after the projects table. Same scan, no hint.
    if (!/no such index: idx_entries_project/i.test(String((e as Error)?.message ?? e))) throw e;
    ({ results } = await scan(""));
  }

  const counts = new Map<string, number>();
  for (const row of results) {
    let tags: unknown;
    try { tags = JSON.parse(row.tags); } catch { continue; }
    if (!Array.isArray(tags)) continue;
    const slugs = new Set<string>();
    for (const tag of tags) {
      if (typeof tag !== "string") continue;
      const t = tag.trim().toLowerCase();
      if (t.startsWith(PROJECT_TAG_PREFIX)) slugs.add(t.slice(PROJECT_TAG_PREFIX.length));
    }
    for (const slug of slugs) {
      const key = countKey(row.workspace_id, slug);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return { counts, approximate: results.length >= COUNTS_SCAN_LIMIT };
}

/**
 * The workspace a PATCH/DELETE addresses. Explicit workspace/team params resolve exactly
 * as a capture's would. Without them the slug must be unambiguous among the caller's
 * readable rows, so a company project is editable without restating its layer.
 */
async function targetWorkspace(env: Env, identity: Identity, url: URL, slug: string): Promise<string | Response> {
  const workspace = url.searchParams.get("workspace") ?? undefined;
  const team = url.searchParams.get("team") ?? undefined;
  if (workspace !== undefined && workspace !== "personal" && workspace !== "company") {
    return json({ ok: false, error: 'workspace must be "personal" or "company"' }, 400);
  }
  if (workspace !== undefined || team !== undefined) {
    // A bare team implies the company layer.
    const writeCtx = await writeContextFor(env, identity, workspace ?? "company", team);
    return writeCtx instanceof Response ? writeCtx : writeCtx.workspaceId;
  }
  const rows = await getProject(env.DB, readScopeWorkspaces(identity), slug);
  if (rows.length === 0) return json({ ok: false, error: `unknown project "${slug}"` }, 404);
  if (rows.length > 1) {
    return json({ ok: false, error: `project "${slug}" exists in more than one workspace; pass workspace (and team)` }, 400);
  }
  return rows[0].workspace_id;
}

function decodeSlug(raw: string): string | Response {
  let slug: string;
  try { slug = decodeURIComponent(raw); } catch { slug = raw; }
  if (!PROJECT_SLUG_RE.test(slug)) {
    return json({ ok: false, error: `invalid project id "${slug}": must match [a-z0-9][a-z0-9_-]{0,63}` }, 400);
  }
  return slug;
}

export async function handleProjectsRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const isCollection = url.pathname === "/projects";
  const item = PROJECT_PATH.exec(url.pathname);
  if (!isCollection && !item) return null;

  // GET /projects
  if (isCollection && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const layer = readWorkspaceParam(url);
    if (layer instanceof Response) return layer;
    const teamId = readTeamQueryParam(url, auth, layer);
    if (teamId instanceof Response) return teamId;
    const readOpts = { layer, teamId };

    const rows = await listProjects(env.DB, readScopeWorkspaces(auth, readOpts), {
      includeArchived: truthy(url.searchParams.get("include_archived")),
    });
    if (!truthy(url.searchParams.get("counts"))) {
      return json({ projects: rows.map(r => view(auth, r)) });
    }
    const { counts, approximate } = await tallyMembers(env, auth, readOpts);
    return json({
      projects: rows.map(r => view(auth, r, counts.get(countKey(r.workspace_id, r.id)) ?? 0)),
      ...(approximate ? { counts_approximate: true } : {}),
    });
  }

  // POST /projects
  if (isCollection && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: unknown; name?: unknown; description?: unknown; aliases?: unknown; workspace?: unknown; team?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "Invalid JSON" }, 400);
    if (body.workspace !== undefined && body.workspace !== "personal" && body.workspace !== "company") {
      return json({ ok: false, error: 'workspace must be "personal" or "company"' }, 400);
    }
    const writeCtx = await writeContextFor(env, auth, body.workspace, body.team);
    if (writeCtx instanceof Response) return writeCtx;

    try {
      const row = await createProject(env.DB, writeCtx.workspaceId, {
        id: body.id as string | undefined,
        name: body.name as string,
        description: body.description as string | undefined,
        aliases: body.aliases as string[] | undefined,
      }, env);
      adminAuditEvent(env, ctx, { actorId: auth.userId, workspaceId: row.workspace_id, event: "project_created", payload: { slug: row.id } });
      return json({ ok: true, project: view(auth, row) }, 201);
    } catch (e) {
      return failure(e);
    }
  }

  // PATCH /projects/:slug
  if (item && request.method === "PATCH") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const slug = decodeSlug(item[1]);
    if (slug instanceof Response) return slug;
    let body: ProjectPatch;
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "Invalid JSON" }, 400);
    const target = await targetWorkspace(env, auth, url, slug);
    if (target instanceof Response) return target;

    // Only the four editable fields count; anything else in the body is ignored.
    const patch: ProjectPatch = {};
    for (const key of ["name", "description", "aliases", "status"] as const) {
      if (body[key] !== undefined) (patch as Record<string, unknown>)[key] = body[key];
    }
    try {
      const row = await updateProject(env.DB, target, slug, patch, env);
      adminAuditEvent(env, ctx, { actorId: auth.userId, workspaceId: row.workspace_id, event: "project_updated", payload: { slug, fields: Object.keys(patch) } });
      return json({ ok: true, project: view(auth, row) });
    } catch (e) {
      return failure(e);
    }
  }

  // DELETE /projects/:slug
  if (item && request.method === "DELETE") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const slug = decodeSlug(item[1]);
    if (slug instanceof Response) return slug;
    const target = await targetWorkspace(env, auth, url, slug);
    if (target instanceof Response) return target;

    if (!(await deleteProject(env.DB, target, slug, env))) return json({ ok: false, error: `unknown project "${slug}"` }, 404);
    adminAuditEvent(env, ctx, { actorId: auth.userId, workspaceId: target, event: "project_deleted", payload: { slug } });
    return json({ ok: true, deleted: true });
  }

  // Anonymous callers are refused first, so they learn nothing about the methods.
  const auth = await requireIdentity(request, env);
  if (auth instanceof Response) return auth;
  const allow = isCollection ? "GET, POST" : "PATCH, DELETE";
  const response = json({ ok: false, error: `Use ${allow.replace(", ", " or ")} here` }, 405);
  response.headers.set("Allow", allow);
  return response;
}
