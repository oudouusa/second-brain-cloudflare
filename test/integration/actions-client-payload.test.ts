/**
 * Director follow-up: BE-5 (v4/ux-be) threads a `client` field into ChangeContext for every MCP
 * write tool, but channelPayload() here dropped it, so resolve/set_status/insight-resolution
 * audit events written through actions.ts lost the client name. Real SQLite, since the audit
 * event's own payload column is what's under test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveEntryAction, applyInsightResolution } from "../../src/memory/actions";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
let pending: Promise<unknown>[] = [];

beforeEach(async () => {
  resetDatabaseInit();
  pending = [];
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
});
afterEach(async () => { await Promise.all(pending); sqlite.close(); });

const seedRow = (id: string, over: Record<string, unknown> = {}) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'api', ?, '[]', ?, ?)`,
).bind(
  id, over.content ?? "x", JSON.stringify(over.tags ?? []), over.createdAt ?? 1000,
  over.workspaceId ?? owner.personalWorkspaceId, over.actorId ?? owner.userId,
).run();

const latestPayload = async (entryId: string) => {
  const row = await sqlite.db.prepare(`SELECT payload FROM entry_events WHERE entry_id = ? ORDER BY rowid DESC LIMIT 1`).bind(entryId).first() as { payload: string };
  return JSON.parse(row.payload);
};

describe("actions.ts audit events carry the MCP client", () => {
  it("resolveEntryAction('done') carries client in the status_changed payload", async () => {
    await seedRow("t1", { tags: ["task"] });
    await resolveEntryAction(env, ctx, owner, "t1", "done", undefined, { actorId: owner.userId, channel: "mcp", client: "Claude" });
    await Promise.all(pending);
    expect((await latestPayload("t1")).client).toBe("Claude");
  });

  it("resolveEntryAction('still_true') carries client in the updated payload", async () => {
    await seedRow("t2", { tags: ["stale:as-of"] });
    await resolveEntryAction(env, ctx, owner, "t2", "still_true", undefined, { actorId: owner.userId, channel: "mcp", client: "Cursor" });
    await Promise.all(pending);
    expect((await latestPayload("t2")).client).toBe("Cursor");
  });

  it("applyInsightResolution carries client in the insight_confirmed payload", async () => {
    await seedRow("t3", { tags: ["auto-insight"] });
    const found = [{ id: "t3", tags: JSON.stringify(["auto-insight"]), workspace_id: owner.personalWorkspaceId, vector_ids: "[]" }];
    await applyInsightResolution(env, ctx, { actorId: owner.userId, channel: "mcp", client: "Codex" }, found, 1, "confirm");
    await Promise.all(pending);
    expect((await latestPayload("t3")).client).toBe("Codex");
  });

  it("REST and system writes still record no client", async () => {
    await seedRow("t4", { tags: ["task"] });
    await resolveEntryAction(env, ctx, owner, "t4", "done", undefined, { actorId: owner.userId, channel: "rest" });
    await Promise.all(pending);
    expect((await latestPayload("t4")).client).toBeUndefined();
  });
});
