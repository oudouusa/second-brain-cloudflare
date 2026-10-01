import type { Env } from "../env";
import { memoryWriteMarker } from "../migration/write-lock";
// Project registry: a thin, workspace-bound row per project. Membership is NOT stored
// here; it lives on entries as the reserved `project:<slug>` tag (see src/tags/system.ts).
// Every read takes the caller's readable workspace ids, every write one exact workspace.
import { CAPSULE_SLOT_TAG_PREFIX, CAPSULE_TAG_PREFIX, PROJECT_SLUG_RE, PROJECT_TAG_PREFIX } from "../tags/system";
import { T7_TAG_PREFIXES } from "../tags/t7";

export { PROJECT_SLUG_RE };

export const MAX_PROJECT_NAME_CHARS = 120;
export const MAX_PROJECT_DESCRIPTION_CHARS = 1000;
export const MAX_PROJECT_ALIASES = 16;
export const MAX_ALIAS_CHARS = 128;

export type ProjectStatus = "active" | "archived";

export interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  aliases: string[];
  status: ProjectStatus;
  created_at: number;
  updated_at: number | null;
}

export interface ProjectPatch {
  name?: string;
  description?: string;
  aliases?: string[];
  status?: ProjectStatus;
}

export class InvalidProjectInputError extends Error {}
export class SlugTakenError extends Error {}
export class ProjectNotFoundError extends Error {}

/** Aliases claim plain topic tags, so the Worker-owned and project namespaces are off limits. */
const RESERVED_ALIAS_PREFIXES = ["kind:", "status:", "volatility:", "stale:", CAPSULE_TAG_PREFIX, CAPSULE_SLOT_TAG_PREFIX, PROJECT_TAG_PREFIX, ...T7_TAG_PREFIXES];

const COLUMNS = "id, workspace_id, name, description, aliases, status, created_at, updated_at";
const SLUG_ERROR = "must match [a-z0-9][a-z0-9_-]{0,63}";

type RawRow = Omit<ProjectRow, "aliases"> & { aliases: string };

function toRow(raw: RawRow): ProjectRow {
  let aliases: string[] = [];
  try {
    const parsed = JSON.parse(raw.aliases);
    if (Array.isArray(parsed)) aliases = parsed.filter((a): a is string => typeof a === "string");
  } catch { /* a corrupt aliases cell reads as none */ }
  return { ...raw, aliases };
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** "My App!" -> "my-app". Null when nothing valid survives. */
export function deriveSlug(name: string): string | null {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64)
    .replace(/[-_]+$/, "");
  return PROJECT_SLUG_RE.test(slug) ? slug : null;
}

function assertSlug(slug: unknown, what: "id" | "slug" = "id"): string {
  if (typeof slug !== "string" || !PROJECT_SLUG_RE.test(slug)) {
    throw new InvalidProjectInputError(`invalid project ${what} "${String(slug)}": ${SLUG_ERROR}`);
  }
  return slug;
}

function cleanText(value: unknown, field: "name" | "description", max: number, required: boolean): string {
  if (typeof value !== "string") throw new InvalidProjectInputError(`${field} must be a string`);
  if (value.includes("\0")) throw new InvalidProjectInputError("NUL is not allowed");
  const text = value.trim();
  if (required && !text) throw new InvalidProjectInputError(`${field} is required`);
  if (text.length > max) throw new InvalidProjectInputError(`${field} must be at most ${max} characters`);
  return text;
}

function cleanAliases(value: unknown): string[] {
  if (!Array.isArray(value)) throw new InvalidProjectInputError("aliases must be an array of tags");
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw new InvalidProjectInputError("aliases must be an array of tags");
    const alias = raw.trim().toLowerCase();
    if (!alias) throw new InvalidProjectInputError("aliases must not be empty");
    if (alias.length > MAX_ALIAS_CHARS) throw new InvalidProjectInputError(`alias "${alias.slice(0, 20)}..." is longer than ${MAX_ALIAS_CHARS} characters`);
    // A quote or backslash is stored JSON-escaped, so the tag LIKE pattern could never match it.
    if (alias.includes("\0") || alias.includes('"') || alias.includes("\\")) throw new InvalidProjectInputError(`alias "${alias}" contains a character tags cannot match`);
    if (RESERVED_ALIAS_PREFIXES.some(p => alias.startsWith(p))) {
      throw new InvalidProjectInputError(`alias "${alias}" uses a reserved prefix; aliases must be plain topic tags`);
    }
    if (!out.includes(alias)) out.push(alias);
  }
  if (out.length > MAX_PROJECT_ALIASES) throw new InvalidProjectInputError(`a project can have at most ${MAX_PROJECT_ALIASES} aliases`);
  return out;
}

export interface ImportedProject {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  status: ProjectStatus;
  created_at: number;
  /** camelCase: this is projects.updated_at, not the entries column the coalescing guard watches. */
  updatedAt: number | null;
}

/** One project of a backup file, held to the same rules as a create; the failure names why. */
export function parseImportedProject(raw: unknown): { ok: true; project: ImportedProject } | { ok: false; id: string; detail: string } {
  const o = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!o) return { ok: false, id: "", detail: "project must be an object" };
  const id = typeof o.id === "string" ? o.id : "";
  try {
    const status = o.status ?? "active";
    if (status !== "active" && status !== "archived") throw new InvalidProjectInputError('status must be "active" or "archived"');
    const created_at = o.created_at ?? Date.now();
    if (typeof created_at !== "number" || !Number.isFinite(created_at)) throw new InvalidProjectInputError("created_at must be a number");
    const updated_at = o.updated_at ?? null;
    if (updated_at !== null && (typeof updated_at !== "number" || !Number.isFinite(updated_at))) throw new InvalidProjectInputError("updated_at must be a number");
    return {
      ok: true,
      project: {
        id: assertSlug(o.id),
        name: cleanText(o.name, "name", MAX_PROJECT_NAME_CHARS, true),
        description: cleanText(o.description ?? "", "description", MAX_PROJECT_DESCRIPTION_CHARS, false),
        aliases: cleanAliases(o.aliases ?? []),
        status,
        created_at,
        updatedAt: updated_at,
      },
    };
  } catch (e) {
    if (e instanceof InvalidProjectInputError) return { ok: false, id, detail: e.message };
    throw e;
  }
}

export async function listProjects(
  db: D1Database,
  workspaceIds: string[],
  opts: { includeArchived?: boolean } = {},
): Promise<ProjectRow[]> {
  if (!workspaceIds.length) return [];
  const { results } = await db.prepare(
    `SELECT ${COLUMNS} FROM projects WHERE workspace_id IN (${placeholders(workspaceIds.length)})${opts.includeArchived ? "" : " AND status = 'active'"} ORDER BY lower(name), id, workspace_id`,
  ).bind(...workspaceIds).all<RawRow>();
  return results.map(toRow);
}

/**
 * The nightly rotation's read as a prepared statement, so the cron can batch it with its
 * candidate query and pay one subrequest for both: the night's workspace's active rows, or,
 * on the null-slice fallback (empty corpus or a failed rotation read), every workspace's.
 */
export function prepareActiveProjects(db: D1Database, workspaceId: string | null): D1PreparedStatement {
  if (workspaceId !== null) {
    return db.prepare(`SELECT ${COLUMNS} FROM projects WHERE workspace_id IN (?) AND status = 'active' ORDER BY lower(name), id, workspace_id`).bind(workspaceId);
  }
  return db.prepare(
    // scope-exempt: cron: null-slice fallback reads every workspace's registry; a row only names a project to digest, and compressTag rolls each workspace up with that workspace's own row alone
    `SELECT ${COLUMNS} FROM projects WHERE status = 'active' ORDER BY lower(name), id, workspace_id`,
  );
}

/** Decode the rows of prepareActiveProjects (or any projects SELECT of COLUMNS). */
export function projectRowsOf(results: readonly unknown[] | undefined): ProjectRow[] {
  return (results ?? []).map(r => toRow(r as RawRow));
}

/** Every readable row for one slug (the same slug can exist in several workspaces). */
export async function getProject(db: D1Database, workspaceIds: string[], slug: string): Promise<ProjectRow[]> {
  if (!workspaceIds.length) return [];
  const { results } = await db.prepare(
    `SELECT ${COLUMNS} FROM projects WHERE workspace_id IN (${placeholders(workspaceIds.length)}) AND id = ? ORDER BY workspace_id`,
  ).bind(...workspaceIds, slug).all<RawRow>();
  return results.map(toRow);
}

/** Active slugs, for "did you mean" text on unknown-project reads. */
export async function knownProjectSlugs(db: D1Database, workspaceIds: string[], limit = 10): Promise<string[]> {
  if (!workspaceIds.length) return [];
  const { results } = await db.prepare(
    `SELECT DISTINCT id FROM projects WHERE workspace_id IN (${placeholders(workspaceIds.length)}) AND status = 'active' ORDER BY id LIMIT ?`,
  ).bind(...workspaceIds, limit).all<{ id: string }>();
  return results.map(r => r.id);
}

export async function createProject(
  db: D1Database,
  ws: string,
  input: { id?: string; name: string; description?: string; aliases?: string[] },
  env?: Env,
): Promise<ProjectRow> {
  const name = cleanText(input.name, "name", MAX_PROJECT_NAME_CHARS, true);
  const description = input.description === undefined ? "" : cleanText(input.description, "description", MAX_PROJECT_DESCRIPTION_CHARS, false);
  const aliases = input.aliases === undefined ? [] : cleanAliases(input.aliases);
  let slug: string;
  if (input.id !== undefined) {
    slug = assertSlug(input.id);
  } else {
    const derived = deriveSlug(name);
    if (!derived) throw new InvalidProjectInputError("could not derive a valid id from the name; pass an id");
    slug = derived;
  }

  const created_at = Date.now();
  const inserted = await db.prepare(
    `INSERT INTO projects (id, workspace_id, name, description, aliases, status, created_at, write_marker) VALUES (?, ?, ?, ?, ?, 'active', ?, ?) ON CONFLICT(workspace_id, id) DO NOTHING RETURNING id`,
  ).bind(slug, ws, name, description, JSON.stringify(aliases), created_at, memoryWriteMarker(env ?? { DB: db } as Env)).first();
  if (!inserted) throw new SlugTakenError(`project "${slug}" already exists`);
  return { id: slug, workspace_id: ws, name, description, aliases, status: "active", created_at, updated_at: null };
}

export async function updateProject(db: D1Database, ws: string, slug: string, patch: ProjectPatch, env?: Env): Promise<ProjectRow> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  const next: Partial<ProjectRow> = {};
  if (patch.name !== undefined) { next.name = cleanText(patch.name, "name", MAX_PROJECT_NAME_CHARS, true); sets.push("name = ?"); binds.push(next.name); }
  if (patch.description !== undefined) { next.description = cleanText(patch.description, "description", MAX_PROJECT_DESCRIPTION_CHARS, false); sets.push("description = ?"); binds.push(next.description); }
  if (patch.aliases !== undefined) { next.aliases = cleanAliases(patch.aliases); sets.push("aliases = ?"); binds.push(JSON.stringify(next.aliases)); }
  if (patch.status !== undefined) {
    if (patch.status !== "active" && patch.status !== "archived") throw new InvalidProjectInputError('status must be "active" or "archived"');
    next.status = patch.status; sets.push("status = ?"); binds.push(patch.status);
  }
  if (!sets.length) throw new InvalidProjectInputError("nothing to update: pass name, description, aliases, or status");

  const current = (await getProject(db, [ws], slug))[0];
  if (!current) throw new ProjectNotFoundError(`unknown project "${slug}"`);

  const updated_at = Date.now();
  await db.prepare(`UPDATE projects SET ${sets.join(", ")}, updated_at = ?, write_marker = ? WHERE workspace_id = ? AND id = ?`)
    .bind(...binds, updated_at, memoryWriteMarker(env ?? { DB: db } as Env), ws, slug).run();
  return { ...current, ...next, updated_at };
}

/** Removes the registry row only; member entries keep their project: tag. */
export async function deleteProject(db: D1Database, ws: string, slug: string, env?: Env): Promise<boolean> {
  const [, deleted] = await db.batch([
    db.prepare(`UPDATE projects SET write_marker = ? WHERE workspace_id = ? AND id = ?`).bind(memoryWriteMarker(env ?? { DB: db } as Env, "delete"), ws, slug),
    db.prepare(`DELETE FROM projects WHERE workspace_id = ? AND id = ?`).bind(ws, slug),
  ]);
  return Number(deleted.meta.changes ?? 0) > 0;
}

/**
 * Auto-create for capture with an unknown project. One statement, never overwrites an
 * existing (possibly archived or renamed) row. True only when this call created it.
 */
export async function ensureProject(db: D1Database, ws: string, slug: string, env?: Env): Promise<boolean> {
  assertSlug(slug, "slug");
  const inserted = await db.prepare(
    `INSERT INTO projects (id, workspace_id, name, description, aliases, status, created_at, write_marker) VALUES (?, ?, ?, '', '[]', 'active', ?, ?) ON CONFLICT(workspace_id, id) DO NOTHING RETURNING id`,
  ).bind(slug, ws, slug, Date.now(), memoryWriteMarker(env ?? { DB: db } as Env)).first();
  return inserted !== null;
}
