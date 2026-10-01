/**
 * T-0089.5.2 Part B: get, append, update and link mark implicit feedback on a
 * recently-recalled id, on both the MCP and REST surfaces, only when
 * RECALL_LOG is opted on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../../src/mcp/server";
import worker from "../../src/index";
import { CONFIG_KEY, DEFAULTS } from "../../src/config";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityFromToken } from "../../src/lib/identity";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (p: Promise<unknown>) => { void p; } } as ExecutionContext;

async function withClient(env: Env, identity: Awaited<ReturnType<typeof resolveIdentityFromToken>>, run: (c: Client) => Promise<void>) {
  const server = buildMcpServer(env, ctx, identity ?? undefined);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "recall-log-feedback-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

describe("implicit feedback (MCP)", () => {
  let sqlite: SqliteD1;
  let env: Env;
  let identity: NonNullable<Awaited<ReturnType<typeof resolveIdentityFromToken>>>;

  beforeEach(async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    const kv = makeMemoryKV();
    await kv.put(CONFIG_KEY, JSON.stringify({ RECALL_LOG: "on" }));
    env = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: kv,
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
        upsert: vi.fn().mockResolvedValue({ mutationId: "m" }),
        insert: vi.fn().mockResolvedValue({ mutationId: "m" }),
      }),
      AI: {
        run: vi.fn().mockImplementation(async (model: string) => {
          if (model === DEFAULTS.EMBEDDING_MODEL) return { data: [new Array(768).fill(0.1)] };
          return { response: '{"importance":2,"canonical":false,"kind":"semantic"}' };
        }),
      } as unknown as Ai,
    }));
    await initializeDatabase(env);
    await ensureTenantBootstrap(env);
    env = sqlite.admitEnv(env);
    identity = (await resolveIdentityFromToken("test-token", env))!;
  });

  afterEach(() => sqlite.close());

  async function seedRecallLog(id: string, returnedIds: string[]) {
    await env.DB.prepare(
      `INSERT INTO recall_log (id, workspace_id, created_at, channel, query, params, returned_ids) VALUES (?, ?, ?, 'mcp', 'q', '{}', ?)`,
    ).bind(id, identity.personalWorkspaceId, Date.now(), JSON.stringify(returnedIds)).run();
  }

  async function followedIds(logId: string): Promise<string[]> {
    await new Promise(r => setTimeout(r, 10));
    const row = await env.DB.prepare(`SELECT followed_ids FROM recall_log WHERE id = ?`).bind(logId).first() as { followed_ids: string };
    return JSON.parse(row.followed_ids);
  }

  it("marks a get on a returned id as followed", async () => {
    let id = "";
    await withClient(env, identity, async (client) => {
      const stored = await client.callTool({ name: "remember", arguments: { content: "Base memory for get feedback" } });
      id = /ID: ([^\s]+)/.exec((stored.content as { text: string }[])[0].text)?.[1] ?? "";
      await seedRecallLog("log-get", [id]);
      await client.callTool({ name: "get", arguments: { id } });
    });
    expect(await followedIds("log-get")).toEqual([id]);
  });

  it("marks an append on a returned id as followed", async () => {
    let id = "";
    await withClient(env, identity, async (client) => {
      const stored = await client.callTool({ name: "remember", arguments: { content: "Base memory for append feedback" } });
      id = /ID: ([^\s]+)/.exec((stored.content as { text: string }[])[0].text)?.[1] ?? "";
      await seedRecallLog("log-append", [id]);
      await client.callTool({ name: "append", arguments: { id, addition: "more detail" } });
    });
    expect(await followedIds("log-append")).toEqual([id]);
  });

  it("marks an update on a returned id as followed", async () => {
    let id = "";
    await withClient(env, identity, async (client) => {
      const stored = await client.callTool({ name: "remember", arguments: { content: "Base memory for update feedback" } });
      id = /ID: ([^\s]+)/.exec((stored.content as { text: string }[])[0].text)?.[1] ?? "";
      await seedRecallLog("log-update", [id]);
      await client.callTool({ name: "update", arguments: { id, content: "Replaced body" } });
    });
    expect(await followedIds("log-update")).toEqual([id]);
  });

  it("marks a link's source and target as followed", async () => {
    let a = "", b = "";
    await withClient(env, identity, async (client) => {
      const sa = await client.callTool({ name: "remember", arguments: { content: "Decision memory", kind: "episodic" } });
      a = /ID: ([^\s]+)/.exec((sa.content as { text: string }[])[0].text)?.[1] ?? "";
      const sb = await client.callTool({ name: "remember", arguments: { content: "Outcome memory", kind: "episodic" } });
      b = /ID: ([^\s]+)/.exec((sb.content as { text: string }[])[0].text)?.[1] ?? "";
      await seedRecallLog("log-link", [a, b]);
      await client.callTool({ name: "link", arguments: { source_id: a, target_id: b, type: "relates_to" } });
    });
    expect(await followedIds("log-link")).toEqual(expect.arrayContaining([a, b]));
  });

  it("does not mark a get outside the 30-minute window", async () => {
    let id = "";
    await withClient(env, identity, async (client) => {
      const stored = await client.callTool({ name: "remember", arguments: { content: "Stale window memory" } });
      id = /ID: ([^\s]+)/.exec((stored.content as { text: string }[])[0].text)?.[1] ?? "";
      await env.DB.prepare(
        `INSERT INTO recall_log (id, workspace_id, created_at, channel, query, params, returned_ids) VALUES ('log-stale', ?, ?, 'mcp', 'q', '{}', ?)`,
      ).bind(identity.personalWorkspaceId, Date.now() - 31 * 60 * 1000, JSON.stringify([id])).run();
      await client.callTool({ name: "get", arguments: { id } });
    });
    expect(await followedIds("log-stale")).toEqual([]);
  });

  it("does not touch recall_log when RECALL_LOG is off", async () => {
    await kv().put(CONFIG_KEY, JSON.stringify({ RECALL_LOG: "off" }));
    let id = "";
    await withClient(env, identity, async (client) => {
      const stored = await client.callTool({ name: "remember", arguments: { content: "Off by default memory" } });
      id = /ID: ([^\s]+)/.exec((stored.content as { text: string }[])[0].text)?.[1] ?? "";
      await seedRecallLog("log-off", [id]);
      await client.callTool({ name: "get", arguments: { id } });
    });
    expect(await followedIds("log-off")).toEqual([]);
  });

  function kv() { return env.OAUTH_KV; }
});

describe("implicit feedback (REST)", () => {
  let sqlite: SqliteD1 | undefined;
  afterEach(() => sqlite?.close());

  async function setup() {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    const kv = makeMemoryKV();
    await kv.put(CONFIG_KEY, JSON.stringify({ RECALL_LOG: "on" }));
    const bootEnv = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv }));
    await initializeDatabase(bootEnv);
    const roots = await ensureTenantBootstrap(bootEnv);
    sqlite.seed({ id: "m1", content: "REST feedback base", createdAt: 1000 });
    await sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(roots.ownerPersonalWorkspaceId, "m1").run();
    await sqlite.db.prepare(
      `INSERT INTO recall_log (id, workspace_id, created_at, channel, query, params, returned_ids) VALUES ('log-rest', ?, ?, 'rest', 'q', '{}', ?)`,
    ).bind(roots.ownerPersonalWorkspaceId, Date.now(), JSON.stringify(["m1"])).run();
    const env: Env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv }));
    const deferred: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => deferred.push(p) } as unknown as ExecutionContext;
    return { env, ctx, deferred, db: sqlite.db };
  }

  async function followedIds(db: SqliteD1["db"]): Promise<string[]> {
    const row = await db.prepare(`SELECT followed_ids FROM recall_log WHERE id = 'log-rest'`).first() as { followed_ids: string };
    return JSON.parse(row.followed_ids);
  }

  it("POST /append marks the id as followed", async () => {
    const { env, ctx, deferred, db } = await setup();
    const res = await worker.fetch(
      new Request("http://localhost/append", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ id: "m1", addition: "rest addition" }),
      }),
      env, ctx,
    );
    await Promise.all(deferred);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
    expect(await followedIds(db)).toEqual(["m1"]);
  });

  it("POST /update marks the id as followed", async () => {
    const { env, ctx, deferred, db } = await setup();
    const res = await worker.fetch(
      new Request("http://localhost/update", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ id: "m1", content: "rest replacement content" }),
      }),
      env, ctx,
    );
    await Promise.all(deferred);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
    expect(await followedIds(db)).toEqual(["m1"]);
  });

  it("POST /link marks both ends as followed", async () => {
    const { env, ctx, deferred, db } = await setup();
    sqlite!.seed({ id: "m2", content: "REST feedback target", createdAt: 1001 });
    const roots = await ensureTenantBootstrap(env);
    await db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'm2'`).bind(roots.ownerPersonalWorkspaceId).run();
    await db.prepare(`UPDATE recall_log SET returned_ids = '["m1","m2"]' WHERE id = 'log-rest'`).run();
    const res = await worker.fetch(
      new Request("http://localhost/link", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ source_id: "m1", target_id: "m2", type: "relates_to" }),
      }),
      env, ctx,
    );
    await Promise.all(deferred);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
    expect(await followedIds(db)).toEqual(expect.arrayContaining(["m1", "m2"]));
  });

  it("costs nothing when RECALL_LOG is off", async () => {
    const { env, ctx, deferred, db } = await setup();
    await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify({ RECALL_LOG: "off" }));
    const res = await worker.fetch(
      new Request("http://localhost/append", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ id: "m1", addition: "should not be tracked" }),
      }),
      env, ctx,
    );
    await Promise.all(deferred);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
    expect(await followedIds(db)).toEqual([]);
  });
});
