import { makeSqliteD1, type SqliteD1 } from "./sqlite-d1";
import { makeMemoryKV, makeTestEnv } from "./make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { setDbReady } from "../../src/runtime/state";
import type { Env } from "../../src/env";

/** A real-SQLite env with the shipped schema and the tenant bootstrap, for trash and purge tests. */
export async function makeTrashEnv(overrides: Partial<Env> = {}) {
  resetDatabaseInit();
  setDbReady(false);
  const sqlite: SqliteD1 = makeSqliteD1();
  let env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), ...overrides })) as Env;
  await initializeDatabase(env);
  env = sqlite.admitEnv(env);
  const roots = await ensureTenantBootstrap(env);
  const raw = sqlite.db as any;
  let closed = false;

  /** Insert one entry (owner's personal workspace unless told otherwise). Extra columns pass through. */
  function seed(id: string, extra: Record<string, unknown> = {}) {
    const row: Record<string, unknown> = {
      id, content: `content of ${id}`, tags: "[]", source: "api", created_at: 1000, updated_at: 1000,
      vector_ids: "[]", workspace_id: roots.ownerPersonalWorkspaceId, actor_id: roots.ownerUserId, ...extra,
    };
    const cols = Object.keys(row);
    sqlite.db.prepare(`INSERT INTO entries (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...Object.values(row)).run();
  }
  function edge(id: string, source: string, target: string, workspaceId = roots.ownerPersonalWorkspaceId) {
    sqlite.db.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id) VALUES (?, ?, ?, 'relates_to', 0.5, 'explicit', '{}', 1, 1, ?)`)
      .bind(id, source, target, workspaceId).run();
  }
  /** One version row, for history that must survive a forget or die with a purge. */
  function version(entryId: string, seq: number, extra: Record<string, unknown> = {}) {
    const row: Record<string, unknown> = {
      entry_id: entryId, workspace_id: roots.ownerPersonalWorkspaceId, seq, content: `v${seq}`, prior_length: null, tags: "[]",
      actor_id: roots.ownerUserId, channel: "rest", reason: "update", created_at: 1000 + seq, ...extra,
    };
    const cols = Object.keys(row);
    sqlite.db.prepare(`INSERT INTO entry_versions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...Object.values(row)).run();
  }
  /** Read through the real prepare path, for assertions. */
  async function all<T = Record<string, any>>(sql: string, ...args: unknown[]): Promise<T[]> {
    return ((await env.DB.prepare(sql).bind(...args).all()) as any).results as T[];
  }
  async function one<T = Record<string, any>>(sql: string, ...args: unknown[]): Promise<T | null> {
    return (await env.DB.prepare(sql).bind(...args).first()) as T | null;
  }
  return { env, sqlite, raw, roots, seed, edge, version, all, one, close: () => { if (closed) return; closed = true; sqlite.close(); setDbReady(false); } };
}
export type TrashEnv = Awaited<ReturnType<typeof makeTrashEnv>>;

/** Insert `n` trash rows named `<prefix>0..n-1` directly, expired unless `deletedAt` says otherwise. */
export async function seedTrashRows(t: TrashEnv, n: number, opts: { prefix?: string; deletedAt?: number; workspaceId?: string; reason?: string; vectorIds?: string } = {}) {
  const { prefix = "t", deletedAt = 1, workspaceId = t.roots.ownerPersonalWorkspaceId, reason = "forget", vectorIds = "[]" } = opts;
  await t.sqlite.db.exec(`
    WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${n - 1})
    INSERT INTO entries_trash (id, workspace_id, actor_id, content, row_json, edges_json, vector_ids, deleted_at, deleted_by, channel, reason, write_marker)
    SELECT '${prefix}' || i, '${workspaceId}', '', 'c', '{"created_at":1}', '[]', '${vectorIds}', ${deletedAt}, '', 'rest', '${reason}', '${t.sqlite.fixtureMarker()}' FROM n`);
}

/** Give every trash row with the prefix `k` versions (seq 1..k), inserted in one statement. */
export async function seedVersionsFor(t: TrashEnv, entryIds: string[], k: number) {
  for (const id of entryIds) {
    await t.sqlite.db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${k})
      INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at, write_marker)
      SELECT '${id}', '${t.roots.ownerPersonalWorkspaceId}', i, 'v' || i, NULL, '[]', '', 'rest', 'update', i, '${t.sqlite.fixtureMarker()}' FROM n`);
  }
}

/** The nonce of the trash row currently under `id` ("" when there is none): what the trash view sends to Delete forever. */
export async function trashNonce(env: Pick<Env, "DB">, id: string): Promise<string> {
  return (await env.DB.prepare(`SELECT nonce FROM entries_trash WHERE id = ?`).bind(id).first<{ nonce: string }>())?.nonce ?? "";
}
