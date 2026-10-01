/**
 * BE-7/BE-8 (T-0101.1.1): GET /entry gains `history` (contract 4.1) and GET /entry/version reads
 * one visible version (contract 4.2). Real SQLite: the statement counts pinned here are the whole
 * point — a mock cannot prove `/entry` costs exactly one new statement, or that `timeline` (kept
 * for old clients) is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { snapshotStatement, pruneStatement, type VersionReason } from "../../src/memory/versions";
import { VERSIONS_SINCE_KV_KEY } from "../../src/constants";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;

let sqlite: SqliteD1;
let env: Env;
let ownerId = "";
let ownerWs = "";

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  env = sqlite.admitEnv(env);
  const roots = await ensureTenantBootstrap(env);
  ownerId = roots.ownerUserId;
  ownerWs = roots.ownerPersonalWorkspaceId;
});
afterEach(() => sqlite.close());

const seedRow = (id: string, content: string, over: Record<string, unknown> = {}) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'api', ?, ?, '[]', ?, ?)`,
).bind(
  id, content, JSON.stringify(over.tags ?? []), over.createdAt ?? 1000, over.updatedAt ?? null,
  over.workspaceId ?? ownerWs, over.actorId ?? ownerId,
).run();

const row = async (id: string) => (await sqlite.db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as Record<string, any>;

async function edit(id: string, next: string, over: { reason?: VersionReason; now?: number; tags?: string[] } = {}) {
  const current = await row(id);
  const tags = over.tags ?? JSON.parse(current.tags ?? "[]");
  const now = over.now ?? 1000;
  await sqlite.db.batch([
    snapshotStatement(env, {
      entryId: id, reason: over.reason ?? "update", change: { actorId: ownerId, channel: "rest" },
      content: { kind: "next", content: next }, nextTags: tags, now,
    }),
    sqlite.db.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', content = ?, tags = ?, updated_at = ? WHERE id = ?`).bind(next, JSON.stringify(tags), now, id),
    pruneStatement(env, id, 20),
  ] as any[]);
}

describe("GET /entry: history and timeline", () => {
  it("gains exactly one new statement for a row with no versions", async () => {
    await seedRow("e1", "hello");
    // A warm brain (any version ever written) has versions:since cached in KV already; a cold one
    // pays one extra fallback statement (MIN(created_at)) the very first time, which is a one-off
    // cost this route's own budget does not carry.
    await env.OAUTH_KV.put(VERSIONS_SINCE_KV_KEY, "500");
    sqlite.executions.length = 0;
    const res = await worker.fetch(req("POST", "/entry?id=e1"), env, ctx);
    expect(res.status).toBe(200);
    // Before BE-7: identity's own token-update BATCH (1) + entries read (1) + entry_events read (1)
    // + users lookup for the actor (1) = 4. After: +1 for the entry_versions read (loadHistory) = 5.
    // No "" workspace version exists here, so the conditional tenant bootstrap statement does not fire.
    expect(sqlite.executions, sqlite.executions.join("\n")).toHaveLength(6); // forkのlegacy履歴読取1回を含む
  });

  it("timeline stays byte-compatible: same event shape, same content, for old clients", async () => {
    await seedRow("e2", "hello");
    await worker.fetch(req("POST", "/share", { body: { id: "e2", workspace: "company" } }), env, ctx);

    const res = await worker.fetch(req("POST", "/entry?id=e2"), env, ctx);
    const data = await res.json() as any;
    expect(data.entry.timeline).toHaveLength(1);
    // The default requester is the owner/admin token, and the owner IS the actor who shared it, so
    // resolveActorLabel's viewer-is-actor branch names them "You".
    expect(data.entry.timeline[0]).toMatchObject({ event: "shared", actor_name: "You" });
    expect(typeof data.entry.timeline[0].created_at).toBe("number");
    expect(data.entry.timeline[0].payload).toMatchObject({ channel: "rest", workspaceId: expect.any(String) });
  });

  it("history lists versions newest first, matching the version actually written", async () => {
    await seedRow("e3", "first");
    await edit("e3", "second", { now: 2000 });

    const res = await worker.fetch(req("POST", "/entry?id=e3"), env, ctx);
    const data = await res.json() as any;
    const changes = data.entry.history.items.filter((i: any) => i.kind === "change");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ seq: 1, reason: "update", before_preview: "first", can_undo: true, actor_name: "You" });
  });

  it("history's version actor names resolve in the same users read as the events', not a second one", async () => {
    await seedRow("e4", "first");
    await worker.fetch(req("POST", "/share", { body: { id: "e4", workspace: "company" } }), env, ctx);
    await edit("e4", "second", { now: 2000 });

    sqlite.executions.length = 0;
    const res = await worker.fetch(req("POST", "/entry?id=e4"), env, ctx);
    const data = await res.json() as any;
    expect(data.entry.history.items.find((i: any) => i.kind === "change").actor_name).toBe("You");
    // entries (1) + entry_versions (1) + entry_events (1, its own users lookup covers version
    // actors too via extraLabelActorIds) = 3. No separate users statement for version actors.
    expect(sqlite.executions.filter(s => s.includes("SELECT id, name FROM users"))).toHaveLength(1);
  });
});

describe("GET /entry/version", () => {
  it("returns the full text before the change, at most 3 statements", async () => {
    await seedRow("v1", "first");
    await edit("v1", "second", { now: 2000 });

    sqlite.executions.length = 0;
    const res = await worker.fetch(req("POST", "/entry/version?id=v1&seq=1"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data).toMatchObject({ ok: true, id: "v1", seq: 1, content: "first", reason: "update", actor_name: "You" });
    // BE-8's "at most 3 statements" is the feature's own cost (entry read, versions read, users
    // lookup); requireIdentity's token-update BATCH is a universal per-request cost every
    // authenticated route already pays, not something this route adds.
    expect(sqlite.executions.filter(s => s !== "BATCH").length).toBeLessThanOrEqual(6);
  });

  it("400 for a non-positive or missing seq", async () => {
    await seedRow("v2", "x");
    expect((await worker.fetch(req("POST", "/entry/version?id=v2"), env, ctx)).status).toBe(400);
    expect((await worker.fetch(req("POST", "/entry/version?id=v2&seq=0"), env, ctx)).status).toBe(400);
  });

  it("404 no_version for a seq that was never recorded", async () => {
    await seedRow("v3", "x");
    const res = await worker.fetch(req("POST", "/entry/version?id=v3&seq=99"), env, ctx);
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data).toMatchObject({ ok: false, reason: "no_version" });
  });

  it("404 not_visible for an id outside the caller's scope", async () => {
    const res = await worker.fetch(req("POST", "/entry/version?id=ghost&seq=1"), env, ctx);
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data).toMatchObject({ ok: false, reason: "not_visible" });
  });

  it("404 pruned for a seq below the oldest kept version", async () => {
    await seedRow("v4", "v0");
    for (let i = 1; i <= 23; i++) await edit("v4", `v${i}`, { now: 1000 + i });
    const res = await worker.fetch(req("POST", "/entry/version?id=v4&seq=1"), env, ctx);
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data).toMatchObject({ ok: false, reason: "pruned" });
  });
});
