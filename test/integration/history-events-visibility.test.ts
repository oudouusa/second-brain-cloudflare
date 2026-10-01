import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { moveEntry } from "../../src/capture/share";
import { VERSIONS_SINCE_KV_KEY } from "../../src/constants";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
});
afterEach(() => sqlite.close());

async function mcpCall(name: string, args: Record<string, unknown>, user: Identity) {
  const server = buildMcpServer(env, ctx, user);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const r = await client.callTool({ name, arguments: args });
    return String((r.content as { text?: string }[])[0]?.text ?? "");
  } finally { await client.close(); }
}

// Codex review, T-0102, director follow-up MAJOR: readEntryTimeline now filters events to
// entries.created_at forward (round 2 re-review), so a row's own created_at must be at or before
// its earliest seeded event, the way a real row's always is. Defaults to 0, well before every
// bare bump() timestamp (100, 200, 300...) this file's own tests already use.
const seed = (id: string, over: Record<string, unknown> = {}) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, '[]', 'api', ?, NULL, '[]', ?, ?)`,
).bind(id, over.content ?? "text", over.createdAt ?? 0, over.workspaceId ?? owner.personalWorkspaceId, over.actorId ?? owner.userId).run();
const events = async (id: string) => (await env.DB.prepare(`SELECT event, payload, created_at FROM entry_events WHERE entry_id = ? ORDER BY created_at, id`).bind(id)
  .all<{ event: string; payload: string; created_at: number }>()).results.map(r => ({ event: r.event, created_at: r.created_at, payload: JSON.parse(r.payload) as Record<string, any> }));
const bump = (id: string, event: string, actorId: string, now: number, payload: Record<string, unknown> = {}) =>
  env.DB.prepare(`INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), id, actorId, event, JSON.stringify(payload), now).run();

describe("shared and unshared events record fromWorkspaceId and are written in moveEntry's batch", () => {
  it("REST", async () => {
    await seed("e1");
    const res = await worker.fetch(req("POST", "/share", { body: { id: "e1", workspace: "company" } }), env, ctx);
    expect(res.status).toBe(200);
    const [ev] = await events("e1");
    expect(ev).toMatchObject({ event: "shared", payload: { channel: "rest" } });
    expect(ev.payload.fromWorkspaceId).toBe(owner.personalWorkspaceId);
  });

  it("MCP", async () => {
    await seed("e2");
    await mcpCall("share", { id: "e2", workspace: "company" }, owner);
    const [ev] = await events("e2");
    expect(ev).toMatchObject({ event: "shared", payload: { channel: "mcp" } });
    expect(ev.payload.fromWorkspaceId).toBe(owner.personalWorkspaceId);
  });

  it("the integration move route", async () => {
    const roots = await ensureTenantBootstrap(env);
    await env.OAUTH_KV.put("integrations:notion", JSON.stringify({
      provider: "notion", status: "connected", config: { mirrorWorkspace: "company" }, itemMap: { k1: { entryId: "e3" } },
    }));
    await seed("e3", { workspaceId: owner.personalWorkspaceId, actorId: "" });
    const res = await worker.fetch(req("POST", "/integrations/notion/move", { body: {} }), env, ctx);
    expect(res.status).toBe(200);
    const [ev] = await events("e3");
    expect(ev.event).toBe("shared");
    expect(ev.payload.fromWorkspaceId).toBe(owner.personalWorkspaceId);
    expect(ev.payload.channel).toBe("rest");
  });

  it("a move whose batch fails writes no event, and an event never exists without its move", async () => {
    await seed("e4");
    const raw = env.DB as any;
    const failing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, batch: () => { throw new Error("D1 down"); } } } as unknown as Env;
    await expect(moveEntry("e4", "company", failing, owner, { actorId: owner.userId, channel: "rest" })).rejects.toThrow();
    expect(await events("e4")).toEqual([]);
    expect((await env.DB.prepare(`SELECT workspace_id FROM entries WHERE id = 'e4'`).first<{ workspace_id: string }>())!.workspace_id).toBe(owner.personalWorkspaceId);
  });

  it("fromWorkspaceId is the row's workspace inside the batch: two concurrent moves record the true source of each, and a move to the current workspace writes no event", async () => {
    await seed("e5");
    const first = await moveEntry("e5", "company", env, owner, { actorId: owner.userId, channel: "rest" });
    expect(first.status).toBe("shared");
    expect((first as any).fromWorkspaceId).toBe(owner.personalWorkspaceId);
    const [ev1] = await events("e5");
    expect(ev1.payload.fromWorkspaceId).toBe(owner.personalWorkspaceId);

    // Already there: no_change, no event.
    const again = await moveEntry("e5", "company", env, owner, { actorId: owner.userId, channel: "rest" });
    expect(again.status).toBe("no_change");
    expect(await events("e5")).toHaveLength(1);

    const back = await moveEntry("e5", "personal", env, owner, { actorId: owner.userId, channel: "rest" });
    expect(back.status).toBe("unshared");
    expect((back as any).fromWorkspaceId).toBe((first as any).workspaceId);
  });

  it("REST /share and MCP share write exactly one move event, not two", async () => {
    await seed("e6");
    await worker.fetch(req("POST", "/share", { body: { id: "e6", workspace: "company" } }), env, ctx);
    expect(await events("e6")).toHaveLength(1);
    await seed("e7");
    await mcpCall("share", { id: "e7", workspace: "company" }, owner);
    expect(await events("e7")).toHaveLength(1);
  });

  it("the integration move route now writes one move event per moved entry, inside the same batch, with no extra execution", async () => {
    await ensureTenantBootstrap(env);
    await env.OAUTH_KV.put("integrations:notion", JSON.stringify({
      provider: "notion", status: "connected", config: { mirrorWorkspace: "company" }, itemMap: { k1: { entryId: "e8" }, k2: { entryId: "e9" } },
    }));
    await seed("e8", { workspaceId: owner.personalWorkspaceId, actorId: "" });
    await seed("e9", { workspaceId: owner.personalWorkspaceId, actorId: "" });
    sqlite.executions.length = 0;
    const res = await worker.fetch(req("POST", "/integrations/notion/move", { body: {} }), env, ctx);
    const body = await res.json() as any;
    expect(body.moved).toBe(2);
    expect(await events("e8")).toHaveLength(1);
    expect(await events("e9")).toHaveLength(1);
    // One D1 call per moved entry for the whole [event, UPDATE, UPDATE] batch (plus the route's own
    // one admin-event audit for the whole move action) — no extra execution per entry from the event.
    const batches = sqlite.executions.filter(s => s === "BATCH").length;
    // standingのcache無効化を同batchに含めるが、forkの書込フェンス用batchが1回増える。
    expect(batches).toBe(4);
  });
});

describe("history visibility follows moves", () => {
  it("MCP history for a teammate shows events from the share onward and versions from the share onward", async () => {
    const bob = (await resolveIdentityFromToken((await createMember(env, { name: "Bob" })).token, env))!;
    await seed("s1", { content: "v1" });
    await bump("s1", "created", owner.userId, 100);
    await bump("s1", "updated", owner.userId, 200);
    await moveEntry("s1", "company", env, owner, { actorId: owner.userId, channel: "rest" });
    await sqlite.db.prepare(`UPDATE entry_events SET created_at = 300 WHERE entry_id = 's1' AND event = 'shared'`).run();
    await bump("s1", "updated", owner.userId, 400);

    const text = await mcpCall("history", { id: "s1" }, bob);
    expect(text).not.toContain("created");
    console.log(JSON.stringify(text)); expect(text.match(/updated/g)?.length).toBe(1);
    expect(text).toContain("shared");

    const ownerText = await mcpCall("history", { id: "s1" }, owner);
    expect(ownerText.match(/updated/g)?.length).toBe(2);
  });

  it("GET /entry timeline for a teammate hides pre-share events; the author sees all", async () => {
    const bobToken = (await createMember(env, { name: "Bob" })).token;
    const bob = (await resolveIdentityFromToken(bobToken, env))!;
    await seed("g1");
    await bump("g1", "created", owner.userId, 100);
    await moveEntry("g1", "company", env, owner, { actorId: owner.userId, channel: "rest" });

    const asBob = await worker.fetch(req("POST", "/entry?id=g1", { token: bobToken }), env, ctx);
    const bobBody = await asBob.json() as any;
    expect(bobBody.entry.timeline.some((e: any) => e.event === "created")).toBe(false);
    expect(bobBody.entry.timeline.some((e: any) => e.event === "shared")).toBe(true);

    const asOwner = await worker.fetch(req("POST", "/entry?id=g1"), env, ctx);
    const ownerBody = await asOwner.json() as any;
    expect(ownerBody.entry.timeline.some((e: any) => e.event === "created")).toBe(true);
  });

  it("an integration-moved mirror row with owner updated and status_changed events hides them from a teammate", async () => {
    const bob = (await resolveIdentityFromToken((await createMember(env, { name: "Bob" })).token, env))!;
    await ensureTenantBootstrap(env);
    await env.OAUTH_KV.put("integrations:notion", JSON.stringify({
      provider: "notion", status: "connected", config: { mirrorWorkspace: "company" }, itemMap: { k1: { entryId: "m1" } },
    }));
    const now = Date.now();
    // No real version exists for this mirror-moved row (the merge rule only ever hides an
    // updated/status_changed event that a real version now covers); pre-warm the marker to
    // after every bump below, so every one of them reads as older than it and this test's own
    // D-SH assertion is not entangled with that rule.
    await env.OAUTH_KV.put(VERSIONS_SINCE_KV_KEY, String(now + 100000));
    await seed("m1", { workspaceId: owner.personalWorkspaceId, actorId: owner.userId });
    await bump("m1", "updated", owner.userId, now - 2000, { channel: "rest" });
    await bump("m1", "status_changed", owner.userId, now - 1000, { channel: "rest" });
    // moveEntry stamps the shared event with its own Date.now(), between the two bumps above and below.
    await worker.fetch(req("POST", "/integrations/notion/move", { body: {} }), env, ctx);
    await bump("m1", "updated", owner.userId, now + 2000, { channel: "rest" });

    const text = await mcpCall("history", { id: "m1" }, bob);
    expect(text).toContain("shared");
    expect(text.match(/status_changed/g)).toBeNull();
    expect(text.match(/updated/g)?.length).toBe(1);
  });

  it("a pre-4.0 shared event without fromWorkspaceId hides everything older from a non-author", async () => {
    const bob = (await resolveIdentityFromToken((await createMember(env, { name: "Bob" })).token, env))!;
    const roots = await ensureTenantBootstrap(env);
    await seed("p1", { workspaceId: roots.companyWorkspaceId });
    await bump("p1", "created", owner.userId, 100);
    await bump("p1", "shared", owner.userId, 200, { workspaceId: roots.companyWorkspaceId }); // no fromWorkspaceId
    await bump("p1", "updated", owner.userId, 300);

    const text = await mcpCall("history", { id: "p1" }, bob);
    expect(text).not.toContain("created");
    expect(text).toContain("shared");
    expect(text).toContain("updated");
  });

  it("ADV-11: GET /entry shows the owner every event of a legacy memory in their own personal workspace", async () => {
    // Legacy row: actor_id "" (pre-team author), sitting in the owner's own personal workspace.
    await seed("l1", { actorId: "" });
    await bump("l1", "updated", owner.userId, 1000);
    const roots = await ensureTenantBootstrap(env);
    await bump("l1", "shared", owner.userId, 2000, { workspaceId: roots.companyWorkspaceId }); // pre-4.0: no fromWorkspaceId
    await bump("l1", "unshared", owner.userId, 3000, { workspaceId: owner.personalWorkspaceId }); // pre-4.0: no fromWorkspaceId

    const res = await worker.fetch(req("POST", "/entry?id=l1"), env, ctx);
    const body = await res.json() as any;
    expect((body.entry ?? body).timeline.map((e: any) => e.event)).toEqual(["updated", "shared", "unshared"]);
  });
});
