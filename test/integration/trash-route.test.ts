/**
 * BE-2 (T-0101.2.1): GET /trash, contract 4.3. Against real SQLite (see
 * test/helpers/sqlite-d1.ts) because the tenancy behaviour under test is
 * exactly what trash-list.test.ts already exercises at the module level —
 * this file is the HTTP wrapper around it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { CONFIG_KEY } from "../../src/config";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const BASE = "http://localhost";

let sqlite: SqliteD1;
let env: Env;
let ownerToken: string;
let bobToken: string;
let ownerUserId: string;
let ownerWorkspaceId: string;
let bobUserId: string;
let bobWorkspaceId: string;
let companyWorkspaceId: string;

function call(method: string, path: string, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return worker.fetch(new Request(`${BASE}${path}`, { method, headers }), env, ctx);
}

function seedTrash(id: string, workspaceId: string, actorId: string, deletedAt: number, nonce = `nonce-${id}`) {
  sqlite.db.prepare(
    `INSERT INTO entries_trash (id, workspace_id, actor_id, content, row_json, edges_json, vector_ids, deleted_at, deleted_by, channel, reason, nonce)
     VALUES (?, ?, ?, 'content', '{"source":"api"}', '[]', '[]', ?, ?, 'rest', 'forget', ?)`,
  ).bind(id, workspaceId, actorId, deletedAt, actorId, nonce).run();
}

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);

  const roots = await ensureTenantBootstrap(env);
  ownerToken = env.AUTH_TOKEN;
  ownerUserId = roots.ownerUserId;
  ownerWorkspaceId = roots.ownerPersonalWorkspaceId;
  companyWorkspaceId = roots.companyWorkspaceId;

  const bob = await createMember(env, { name: "Bob" });
  bobToken = bob.token;
  bobUserId = bob.member.userId;
  bobWorkspaceId = bob.member.personalWorkspaceId;
});

afterEach(() => sqlite?.close());

describe("GET /trash", () => {
  it("401 without a token", async () => {
    const res = await call("GET", "/trash", null);
    expect(res.status).toBe(401);
  });

  it("returns the contract shape", async () => {
    seedTrash("e1", ownerWorkspaceId, ownerUserId, 1000);
    const res = await call("GET", "/trash", ownerToken);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.retention_days).toBe(14);
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({
      id: "e1",
      reason: "forget",
      layer: "personal",
      can_restore: true,
      can_delete_forever: true,
      nonce: "nonce-e1",
    });
    expect(data).toHaveProperty("next_cursor");
  });

  it("400 for a bad cursor and a bad layer", async () => {
    const badCursor = await call("GET", "/trash?cursor=not-a-cursor", ownerToken);
    expect(badCursor.status).toBe(400);
    expect((await badCursor.json() as any).error).toBe("cursor is invalid");

    const badLayer = await call("GET", "/trash?layer=nope", ownerToken);
    expect(badLayer.status).toBe(400);
  });

  it("a teammate sees only restorable rows", async () => {
    seedTrash("owner-private", ownerWorkspaceId, ownerUserId, 1000);
    seedTrash("bob-private", bobWorkspaceId, bobUserId, 2000);
    const res = await call("GET", "/trash?limit=50", bobToken);
    const data = await res.json() as any;
    expect(data.items.map((i: any) => i.id)).toEqual(["bob-private"]);
  });

  it("retention_days reflects TRASH_RETENTION_DAYS overrides", async () => {
    await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify({ TRASH_RETENTION_DAYS: 7 }));
    const res = await call("GET", "/trash", ownerToken);
    const data = await res.json() as any;
    expect(data.retention_days).toBe(7);
  });
});
