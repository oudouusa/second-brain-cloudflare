import { parentIdOfVectorId } from "../../src/vectorize/ids";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeAIMock, makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityByUserId } from "../../src/lib/identity";
import { appendToEntry, updateEntryContent } from "../../src/capture/store";
import { DEFAULTS } from "../../src/config";
import { loadHistory } from "../../src/memory/versions";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;
const change = { actorId: "u1", channel: "rest" as const };

let d1: SqliteD1;
let env: Env;
let wsId = "";
let ownerId = "";
let vectorize: Vectorize;
let deleted: string[][] = [];

beforeEach(async () => {
  resetDatabaseInit();
  deleted = [];
  d1 = makeSqliteD1();
  vectorize = makeVectorizeMock({ deleteByIds: vi.fn(async (ids: string[]) => { deleted.push(ids); return { mutationId: "m" } as any; }) });
  env = d1.admitEnv(makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), VECTORIZE: vectorize, AI: makeAIMock() }));
  await initializeDatabase(env);
  env = d1.admitEnv(env);
  const roots = await ensureTenantBootstrap(env);
  wsId = roots.ownerPersonalWorkspaceId;
  ownerId = roots.ownerUserId;
});
afterEach(() => d1.close());

async function seed(id: string, content: string, tags: string[] = [], extra: { when_at?: number; when_kind?: string } = {}) {
  await d1.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, when_at, when_kind, when_source)
     VALUES (?, ?, ?, 'claude', 1000, NULL, '["${id}"]', ?, ?, ?, ?, ?)`,
  ).bind(id, content, JSON.stringify(tags), wsId, ownerId, extra.when_at ?? null, extra.when_kind ?? null, extra.when_at ? "regex" : null).run();
}
const versions = async (id: string) =>
  (await d1.db.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const live = async (id: string) => (await d1.db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;
const ownerIdentity = async () => (await resolveIdentityByUserId(env, ownerId))!;
async function mcp<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = buildMcpServer(env, ctx, await ownerIdentity());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try { return await fn(client); } finally { await client.close(); }
}

describe("versioning update", () => {
  it("POST /update writes one update version", async () => {
    await seed("e1", "I live in Berlin", ["home"]);
    const res = await worker.fetch(req("POST", "/update", { body: { id: "e1", content: "I live in Lisbon" } }), env, ctx);
    expect(res.status).toBe(200);
    const vs = await versions("e1");
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ seq: 1, reason: "update", content: "I live in Berlin", channel: "rest", actor_id: ownerId, workspace_id: wsId });
    expect(JSON.parse(vs[0].tags)).toEqual(["home"]);
  });

  it("identical content and a reordered tag set writes no version", async () => {
    await seed("e1", "same text", ["b", "a"]);
    const res = await worker.fetch(req("POST", "/update", { body: { id: "e1", content: "same text", tags: ["a", "b"] } }), env, ctx);
    expect(res.status).toBe(200);
    expect(await versions("e1")).toEqual([]);
  });

  it("a failed re-embed writes no version", async () => {
    await seed("e1", "before", []);
    const failing = d1.admitEnv(makeTestEnv(undefined, {
      DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), VECTORIZE: vectorize,
      AI: { run: vi.fn(async () => { throw new Error("overloaded"); }) } as unknown as Ai,
    }));
    const r = await updateEntryContent(failing, "e1", "after", DEFAULTS, undefined, undefined, { workspaceId: wsId, actorId: ownerId }, change, wsId);
    expect(r.status).toBe("reembed_failed");
    expect(await versions("e1")).toEqual([]);
    expect((await live("e1")).content).toBe("before");
  });

  it("an update of a row forgotten mid-flight returns not_found and deletes its fresh vectors", async () => {
    await seed("e1", "before", []);
    // The row is forgotten while the re-embed's upsert is in flight.
    (vectorize.upsert as any).mockImplementation(async () => {
      await d1.db.prepare(`UPDATE entries SET write_marker = ? WHERE id = 'e1'`).bind(d1.fixtureMarker('delete')).run();
      await d1.db.prepare(`DELETE FROM entries WHERE id = 'e1'`).run();
      return { mutationId: "m" };
    });
    const r = await updateEntryContent(env, "e1", "after", DEFAULTS, undefined, undefined, { workspaceId: wsId, actorId: ownerId }, change, wsId);
    expect(r).toEqual({ status: "not_found" });
    // The update's own upload (fresh ids naming e1) is deleted: nothing owns it now.
    expect(deleted.flat()).toHaveLength(1);
    expect(deleted.flat()[0]).toMatch(/^v-[0-9a-f-]+-0$/);
    expect(await versions("e1")).toEqual([]);
  });

  it("records channel mcp on the MCP surface, with the same actor", async () => {
    await seed("e1", "one", []);
    await mcp(c => c.callTool({ name: "update", arguments: { id: "e1", content: "two" } }));
    const [v] = await versions("e1");
    expect(v).toMatchObject({ channel: "mcp", actor_id: ownerId, reason: "update" });
  });

  it("VERSION_KEEP bounds the chain", async () => {
    await seed("e1", "0", []);
    const cfg = { ...DEFAULTS, VERSION_KEEP: 5 };
    for (let i = 1; i <= 12; i++) await updateEntryContent(env, "e1", `text ${i}`, cfg, undefined, undefined, { workspaceId: wsId, actorId: ownerId }, change, wsId);
    expect((await versions("e1")).map(v => v.seq)).toEqual([8, 9, 10, 11, 12]);
  });
});

describe("versioning append", () => {
  const append = (id: string, existing: string, addition: string, when?: { at: number; kind: string }, ch = change) =>
    appendToEntry(env, id, existing, addition, [], "claude", DEFAULTS, undefined, { workspaceId: wsId, actorId: ownerId }, ch, when, wsId);

  it("append short and long branches store deltas", async () => {
    await seed("short", "base", []);
    await append("short", "base", "more");
    const [sv] = await versions("short");
    expect(sv).toMatchObject({ reason: "append", content: null, prior_length: 4 });

    const long = "a".repeat(1590);
    await seed("long", long, []);
    await append("long", long, "b".repeat(50));
    const [lv] = await versions("long");
    expect(lv).toMatchObject({ reason: "append", content: null, prior_length: 1590 });
    const row = await live("long");
    const chain = await loadHistory(env, undefined, { id: "long", content: row.content }, 10);
    expect(chain.text(1)).toBe(long);
  });

  it("two concurrent appends leave history holding both additions", async () => {
    await seed("e1", "base", []);
    // Both callers read "base" before either commits.
    await Promise.all([append("e1", "base", "first"), append("e1", "base", "second")]);
    const row = await live("e1");
    const all = [row.content, ...(await versions("e1")).map(v => v.content ?? row.content.slice(0, v.prior_length))].join("\n");
    expect(all).toContain("first");
    expect(all).toContain("second");
    expect((await versions("e1")).length).toBeGreaterThanOrEqual(2);
  });

  it("MCP append with when writes content and when_* in one batch and one version whose state holds the prior when_*", async () => {
    await seed("e1", "Renew passport", [], { when_at: 5000, when_kind: "event" });
    d1.batches.length = 0;
    await mcp(c => c.callTool({ name: "append", arguments: { id: "e1", addition: "call the office", when: "2026-06-15", when_kind: "due" } }));
    const row = await live("e1");
    expect(row.content).toContain("call the office");
    expect(row.when_at).toBe(Date.parse("2026-06-15"));
    expect(row).toMatchObject({ when_kind: "due", when_source: "explicit" });
    const vs = await versions("e1");
    expect(vs).toHaveLength(1);
    expect(JSON.parse(vs[0].state)).toMatchObject({ when_at: 5000, when_kind: "event", when_source: "regex" });
    // event_id (round 4 re-review MAJOR) is minted fresh per append.
    expect(JSON.parse(vs[0].meta)).toMatchObject({ when: true, event_id: expect.any(String) });
    expect(vs[0]).toMatchObject({ channel: "mcp", reason: "append" });
    // No separate when UPDATE any more.
    expect(d1.issued.filter(s => /^UPDATE entries SET when_at = \?, when_kind/.test(s))).toEqual([]);
  });

  it("REST append records channel rest", async () => {
    await seed("e1", "base", []);
    const res = await worker.fetch(req("POST", "/append", { body: { id: "e1", addition: "extra" } }), env, ctx);
    expect(res.status).toBe(200);
    expect((await versions("e1"))[0]).toMatchObject({ channel: "rest", reason: "append", actor_id: ownerId });
  });
});
