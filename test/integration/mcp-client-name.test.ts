/**
 * BE-5 (T-0101.5.1): the client that made a write is recorded on the audit
 * trail. End to end through the real MCP server (buildMcpServer + the SDK's
 * own Client/InMemoryTransport, as mcp-agent-tools.test.ts does), because the
 * subject is whether `extra` and the OAuth grant props actually reach the
 * write tools, not just resolveClientLabel's own fallback logic (covered in
 * test/unit/client-label.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import type { McpClientProps } from "../../src/mcp/client-label";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let identity: Identity;
let pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;

async function call(
  name: string,
  args: Record<string, unknown> = {},
  props?: McpClientProps,
  meta?: Record<string, unknown>,
  bearer: string | null = null,
) {
  const server = buildMcpServer(env, ctx, identity, props, bearer);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "client-name-test", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const result = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) } as never);
    return String((result.content as { text?: string }[])[0]?.text ?? "");
  } finally {
    await client.close();
    await server.close();
  }
}

async function latestEventPayload(event: string): Promise<Record<string, unknown> | null> {
  await Promise.all(pending);
  const row = await sqlite.db.prepare(
    `SELECT payload FROM entry_events WHERE event = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).bind(event).first() as { payload: string } | null;
  if (!row) return null;
  return JSON.parse(row.payload);
}

async function latestVersionMeta(entryId: string): Promise<Record<string, unknown> | null> {
  await Promise.all(pending);
  const row = await sqlite.db.prepare(
    `SELECT meta FROM entry_versions WHERE entry_id = ? ORDER BY seq DESC LIMIT 1`,
  ).bind(entryId).first() as { meta: string } | null;
  if (!row) return null;
  return JSON.parse(row.meta);
}

beforeEach(async () => {
  resetDatabaseInit();
  pending = [];
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);
  env = sqlite.admitEnv(env);
  identity = (await resolveIdentityFromToken("test-token", env))!;
});
afterEach(async () => { await Promise.all(pending); sqlite?.close(); });

describe("MCP write tools record the calling client", () => {
  it("remember records client from a DCR client's registered name", async () => {
    await call("remember", { content: "a fact about the client-name test" }, { clientName: "Test Client" });
    const payload = await latestEventPayload("created");
    expect(payload).toMatchObject({ client: "Test Client", channel: "mcp" });
  });

  it("append records the calling client", async () => {
    const id = "e-append";
    sqlite.seed({ id, content: "original text", createdAt: Date.now() });
    await call("append", { id, addition: "more text" }, { clientName: "Test Client" });
    const payload = await latestEventPayload("appended");
    expect(payload).toMatchObject({ client: "Test Client" });
  });

  it("update records the calling client", async () => {
    const id = "e-update";
    sqlite.seed({ id, content: "original text", createdAt: Date.now() });
    await call("update", { id, content: "replaced text" }, { clientName: "Test Client" });
    const payload = await latestEventPayload("updated");
    expect(payload).toMatchObject({ client: "Test Client" });
  });

  // W22/W25 (director, round 2 of the walkthrough follow-ups): the trash row and entry_events
  // both get the calling client from capture/store.ts's audit event, but its own snapshotStatement
  // call for the update path never copied change.client into entry_versions.meta -- the history
  // tool's "changes" list (mcp/server.ts's historyActorVia) and the dashboard timeline
  // (history-view.js's item.client) both read that field and promise it, so it must be there too.
  it("update records the calling client on the version it snapshots, not just the audit event", async () => {
    const id = "e-update-version-client";
    sqlite.seed({ id, content: "original text", createdAt: Date.now() });
    await call("update", { id, content: "replaced text" }, { clientName: "Test Client" });
    const meta = await latestVersionMeta(id);
    expect(meta).toMatchObject({ client: "Test Client" });
  });

  it("a REST update records no client on the version it snapshots", async () => {
    const id = "e-rest-update-version-client";
    sqlite.seed({ id, content: "original text", createdAt: Date.now() });
    const res = await worker.fetch(
      new Request("http://localhost/update", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: JSON.stringify({ id, content: "replaced text" }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const meta = await latestVersionMeta(id);
    expect(meta).not.toHaveProperty("client");
  });

  // Director, round 3: the fix moved from store.ts's one-off into selectList (versions.ts), shared
  // by every snapshotStatement/guardedSnapshotManyStatement caller -- this drives three of them
  // through real MCP tools (update: capture/store.ts, set_status: capture/lifecycle.ts, resolve
  // action=done: memory/actions.ts) rather than hand-seeding a version row, so a regression in any
  // one writer, not just store.ts's, fails here.
  it("every MCP-reachable version write carries meta.client: update, set_status, and an action", async () => {
    const id = "e-structural-client";
    sqlite.seed({ id, content: "a task to resolve", createdAt: Date.now(), tags: ["task"] });

    await call("update", { id, content: "a task to resolve, edited" }, { clientName: "Test Client" });
    expect(await latestVersionMeta(id)).toMatchObject({ client: "Test Client" });

    await call("set_status", { id, status: "canonical" }, { clientName: "Test Client" });
    expect(await latestVersionMeta(id)).toMatchObject({ client: "Test Client" });

    await call("resolve", { id, action: "done" }, { clientName: "Test Client" });
    expect(await latestVersionMeta(id)).toMatchObject({ client: "Test Client" });
  });

  it("set_status records the calling client", async () => {
    const id = "e-status";
    sqlite.seed({ id, content: "original text", createdAt: Date.now() });
    await call("set_status", { id, status: "canonical" }, { clientName: "Test Client" });
    const payload = await latestEventPayload("status_changed");
    expect(payload).toMatchObject({ client: "Test Client" });
  });

  it("forget records the calling client", async () => {
    const id = "e-forget";
    sqlite.seed({ id, content: "original text", createdAt: Date.now() });
    await call("forget", { id }, { clientName: "Test Client" });
    const payload = await latestEventPayload("deleted");
    expect(payload).toMatchObject({ client: "Test Client" });
  });

  it("channel stays exactly 'mcp'", async () => {
    await call("remember", { content: "channel check content" }, { clientName: "Test Client" });
    const payload = await latestEventPayload("created");
    expect(payload!.channel).toBe("mcp");
  });

  it("a static-token call records no client unless ?client= is set", async () => {
    await call("remember", { content: "static token content" }, { via: "token" });
    const payload = await latestEventPayload("created");
    expect(payload).not.toHaveProperty("client");
  });

  it("falls back to _meta clientInfo when no grant name exists", async () => {
    await call(
      "remember",
      { content: "meta fallback content" },
      { via: "token" },
      { "io.modelcontextprotocol/clientInfo": { name: "Meta Client" } },
    );
    const payload = await latestEventPayload("created");
    expect(payload).toMatchObject({ client: "Meta Client" });
  });

  it("REST writes record no client", async () => {
    const id = "e-rest-forget";
    sqlite.seed({ id, content: "rest content", createdAt: Date.now() });
    const res = await worker.fetch(
      new Request("http://localhost/forget", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: JSON.stringify({ id }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const payload = await latestEventPayload("deleted");
    expect(payload).not.toHaveProperty("client");
  });
});
