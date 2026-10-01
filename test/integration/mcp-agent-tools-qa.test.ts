/**
 * QA additions for Track 6: REST and MCP resolve parity on real SQLite, statement pins
 * for every resolve action, and history edge scoping.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { createMember } from "../../src/lib/team-admin";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let identity: Identity;
let pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;

async function mcp(name: string, args: Record<string, unknown> = {}, user: Identity = identity) {
  const server = buildMcpServer(env, ctx, user);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "qa-t6", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    return String((result.content as { text?: string }[])[0]?.text ?? "");
  } finally { await client.close(); await server.close(); }
}

const rest = async (method: string, path: string, body?: unknown) => {
  const res = await worker.fetch(req(method, path, { body }), env, ctx);
  return { status: res.status, json: await res.json() as any };
};

beforeEach(async () => {
  resetDatabaseInit();
  pending = [];
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  env = sqlite.admitEnv(env);
  setDbReady(true);
  await ensureTenantBootstrap(env);
  identity = (await resolveIdentityFromToken("test-token", env))!;
});
afterEach(async () => { await Promise.all(pending); sqlite?.close(); setDbReady(false); });

const state = (id: string) => {
  const r = sqlite.rows().find(x => x.id === id)!;
  return { tags: JSON.parse(String(r.tags)), when_at: r.when_at, when_kind: r.when_kind, when_label: r.when_label, when_source: r.when_source, vector_ids: r.vector_ids, content: r.content };
};
const events = async (id: string) => (await env.DB.prepare(`SELECT event, payload FROM entry_events WHERE entry_id = ? ORDER BY created_at, id`).bind(id).all<{ event: string; payload: string }>())
  .results.map(r => { const { channel, ...payload } = JSON.parse(r.payload); return { event: r.event, payload, channel }; });

describe("resolve: REST and MCP produce the same state and audit on real SQLite", () => {
  const until = new Date(Date.now() + 5 * 86400000).toISOString();
  const seededDue = Date.now() + 86400000; // one value for both rows, so the recorded prior matches
  const cases: { name: string; tags: string[]; vec?: string[]; mcpArgs: Record<string, unknown>; restCall: (id: string) => [string, string, unknown] }[] = [
    { name: "done", tags: ["task"], mcpArgs: { action: "done" }, restCall: id => ["POST", "/loops/resolve", { id, action: "done" }] },
    { name: "not_a_task", tags: ["task"], mcpArgs: { action: "not_a_task" }, restCall: id => ["POST", "/loops/resolve", { id, action: "not-task" }] },
    { name: "snooze", tags: ["task"], mcpArgs: { action: "snooze", until }, restCall: id => ["POST", "/due/snooze", { id, until }] },
    { name: "clear_date", tags: ["task"], mcpArgs: { action: "clear_date" }, restCall: id => ["POST", "/due/clear", { id }] },
    { name: "still_true", tags: ["stale:as-of"], mcpArgs: { action: "still_true" }, restCall: id => ["POST", "/stale/keep", { id }] },
    { name: "confirm_insight", tags: ["auto-insight"], vec: ["v1"], mcpArgs: { action: "confirm_insight" }, restCall: id => ["POST", "/patterns/resolve", { id, action: "confirm" }] },
    { name: "dismiss_insight", tags: ["auto-insight"], vec: ["v1"], mcpArgs: { action: "dismiss_insight" }, restCall: id => ["POST", "/patterns/resolve", { id, action: "dismiss" }] },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      for (const id of ["rest-row", "mcp-row"]) {
        sqlite.seed({ id, content: "Identical content", createdAt: 1000, tags: c.tags, vectorIds: c.vec ?? [] });
        if (c.name === "clear_date" || c.name === "snooze") {
          await env.DB.prepare(`UPDATE entries SET when_at = ?, when_kind = 'due', when_label = 'x', when_source = 'explicit' WHERE id = ?`).bind(seededDue, id).run();
        }
      }
      const [m, p, b] = c.restCall("rest-row");
      const r = await rest(m, p, b);
      expect(r.status).toBe(200);
      expect(await mcp("resolve", { id: "mcp-row", ...c.mcpArgs })).toMatch(/^Resolved mcp-row/);
      await Promise.all(pending);
      const restState = state("rest-row"), mcpState = state("mcp-row");
      if (c.name === "snooze") { expect(mcpState.when_at).toBeGreaterThan(Date.now()); delete (restState as any).when_at; delete (mcpState as any).when_at; }
      if (c.name === "still_true") { /* updated_at is time-dependent and not compared */ }
      expect(mcpState).toEqual(restState);
      const re = await events("rest-row"), me = await events("mcp-row");
      expect(me.map(e => ({ event: e.event, keys: Object.keys(e.payload).sort() }))).toEqual(re.map(e => ({ event: e.event, keys: Object.keys(e.payload).sort() })));
      if (c.name !== "snooze") expect(me.map(e => e.payload)).toEqual(re.map(e => e.payload));
      expect(re.length).toBeGreaterThan(0);
      expect(re.every(e => e.channel === "rest")).toBe(true);
      expect(me.length).toBeGreaterThan(0);
      expect(me.every(e => e.channel === "mcp")).toBe(true);
    });
  }

  it("returns the same refusals for missing ids, past dates and non-eligible rows", async () => {
    sqlite.seed({ id: "plain", content: "Ordinary", createdAt: 1, tags: ["work"] });
    const missing = await rest("POST", "/loops/resolve", { id: "nope", action: "done" });
    expect(missing.status).toBe(404);
    expect(await mcp("resolve", { id: "nope", action: "done" })).toBe(missing.json.error);
    const past = await rest("POST", "/due/snooze", { id: "plain", until: "2020-01-01" });
    expect(past.status).toBe(400);
    expect(await mcp("resolve", { id: "plain", action: "snooze", until: "2020-01-01" })).toBe(past.json.error);
    const notStale = await rest("POST", "/stale/keep", { id: "plain" });
    expect(notStale.status).toBe(400);
    expect(await mcp("resolve", { id: "plain", action: "still_true" })).toBe(notStale.json.error);
  });
});

describe("resolve: one item per call, statement pins", () => {
  it("rejects list-shaped ids and never touches a second row", async () => {
    sqlite.seed({ id: "a", content: "A", createdAt: 1, tags: ["task"] });
    sqlite.seed({ id: "b", content: "B", createdAt: 1, tags: ["task"] });
    expect(await mcp("resolve", { id: "a,b", action: "done" })).toMatch(/No memory found/);
    expect(await mcp("resolve", { id: ["a", "b"], action: "done" })).toMatch(/invalid|expected string/i);
    expect(state("a").tags).not.toContain("task:done");
    expect(state("b").tags).not.toContain("task:done");
  });

  const future = new Date(Date.now() + 3 * 86400000).toISOString();
  for (const [action, tags, extra] of [
    ["done", ["task"], {}], ["not_a_task", ["task"], {}], ["snooze", ["task"], { until: future }],
    ["clear_date", ["task"], {}], ["still_true", ["stale:as-of"], {}], ["confirm_insight", ["auto-insight"], {}], ["dismiss_insight", ["auto-insight"], {}],
  ] as [string, string[], Record<string, unknown>][]) {
    it(`${action} keeps a fixed D1 statement budget with history`, async () => {
      sqlite.seed({ id: "x", content: "X", createdAt: 1, tags });
      sqlite.issued.length = 0;
      expect(await mcp("resolve", { id: "x", action, ...extra })).toMatch(/^Resolved x/);
      await Promise.all(pending);
      // 履歴snapshot/pruneと、dismiss時はvalidity復帰・vector後処理も計上。
      expect(sqlite.issued.length).toBe(action === "dismiss_insight" ? 13 : 6);
    });
  }
});

describe("history: edge scope", () => {
  it("does not show supersedes edges owned by another workspace", async () => {
    const other = await createMember(env, { name: "Other" });
    sqlite.seed({ id: "secret-target", content: "private", createdAt: 1, workspaceId: other.member.personalWorkspaceId });
    sqlite.seed({ id: "mine", content: "Mine", createdAt: 1, tags: ["work"] });
    await env.DB.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
      VALUES ('foreign', 'mine', 'secret-target', 'supersedes', 1, 'explicit', '{}', 1, 1, ?)`).bind(other.member.personalWorkspaceId).run();
    const text = await mcp("history", { id: "mine" });
    expect(text).not.toContain("secret-target");
    expect(text).not.toContain("Supersedes");
  });
});

describe("digest: scope", () => {
  it("never returns another member's personal digest", async () => {
    const other = await createMember(env, { name: "Other" });
    sqlite.seed({ id: "theirs", content: "Their private digest", createdAt: 5, tags: ["synthesized", "work"] });
    await env.DB.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'theirs'`).bind(other.member.personalWorkspaceId).run();
    const reader = (await resolveIdentityFromToken((await createMember(env, { name: "Reader" })).token, env))!;
    expect(await mcp("digest", { tag: "work" }, reader)).toContain("No digest yet");
  });
});

describe("resolve audit: channel and prior values on both surfaces", () => {
  const until = new Date(Date.now() + 4 * 86400000).toISOString();
  const cases: { name: string; tags: string[]; dated?: boolean; mcp: Record<string, unknown>; rest: (id: string) => [string, unknown]; prior: (p: any) => void }[] = [
    { name: "done", tags: ["task", "work"], mcp: { action: "done" }, rest: id => ["/loops/resolve", { id, action: "done" }], prior: p => expect(p.tags).toEqual(["task", "work"]) },
    { name: "not_a_task", tags: ["task", "work"], mcp: { action: "not_a_task" }, rest: id => ["/loops/resolve", { id, action: "not-task" }], prior: p => expect(p.tags).toEqual(["task", "work"]) },
    { name: "snooze", tags: ["task"], dated: true, mcp: { action: "snooze", until }, rest: id => ["/due/snooze", { id, until }], prior: p => expect(p).toMatchObject({ when_kind: "due", when_label: "x", when_source: "explicit", when_at: expect.any(Number) }) },
    { name: "clear_date", tags: ["task"], dated: true, mcp: { action: "clear_date" }, rest: id => ["/due/clear", { id }], prior: p => expect(p).toMatchObject({ when_kind: "due", when_label: "x", when_source: "explicit", when_at: expect.any(Number) }) },
    { name: "still_true", tags: ["stale:as-of", "work"], mcp: { action: "still_true" }, rest: id => ["/stale/keep", { id }], prior: p => { expect(p.tags).toEqual(["stale:as-of", "work"]); expect(p).toHaveProperty("updated_at"); expect(p).toHaveProperty("staleness_checked_at"); } },
    { name: "confirm_insight", tags: ["auto-insight"], mcp: { action: "confirm_insight" }, rest: id => ["/patterns/resolve", { id, action: "confirm" }], prior: p => expect(p.tags).toEqual(["auto-insight"]) },
    { name: "dismiss_insight", tags: ["auto-insight"], mcp: { action: "dismiss_insight" }, rest: id => ["/patterns/resolve", { id, action: "dismiss" }], prior: p => expect(p.tags).toEqual(["auto-insight"]) },
  ];
  for (const c of cases) {
    it(`${c.name}: REST records channel rest, MCP records channel mcp, both with prior values`, async () => {
      for (const id of ["r", "m"]) {
        sqlite.seed({ id, content: "Same content", createdAt: 1000, tags: c.tags });
        if (c.dated) await env.DB.prepare(`UPDATE entries SET when_at = ?, when_kind = 'due', when_label = 'x', when_source = 'explicit' WHERE id = ?`).bind(Date.now() + 86400000, id).run();
      }
      const [path, body] = c.rest("r");
      expect((await rest("POST", path, body)).status).toBe(200);
      expect(await mcp("resolve", { id: "m", ...c.mcp })).toMatch(/^Resolved m/);
      await Promise.all(pending);
      for (const [id, channel] of [["r", "rest"], ["m", "mcp"]] as const) {
        const rows = (await env.DB.prepare(`SELECT payload FROM entry_events WHERE entry_id = ?`).bind(id).all<{ payload: string }>()).results;
        expect(rows).toHaveLength(1);
        const payload = JSON.parse(rows[0].payload);
        expect(payload.channel).toBe(channel);
        expect(payload.prior, `${id} prior`).toBeTruthy();
        c.prior(payload.prior);
      }
    });
  }
});
