/**
 * Track 2 Task A4 (T-0089.2.1, D2.2): agents set valid_from and valid_until from what the user says,
 * on remember / POST /capture and update / POST /update (spec 14 5.4, P5, P6).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { req } from "../helpers/make-request";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityFromToken, resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import { revertEntry } from "../../src/memory/undo";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
let ws: string;
let matches: { id: string; score: number }[] = [];
let decision = `{"contradicts": false}`;

function ai() {
  return {
    run: vi.fn(async (model: string) => model === "@cf/google/embeddinggemma-300m"
      ? { data: [new Array(768).fill(0.1)] }
      : new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(decision)}}\n\n`));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
      } })),
  } as unknown as Ai;
}

beforeEach(async () => {
  resetDatabaseInit();
  matches = [];
  decision = `{"contradicts": false}`;
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), AI: ai(),
    VECTORIZE: makeVectorizeMock({ query: vi.fn(async () => ({ matches: matches.map(m => ({ ...m, metadata: { parentId: m.id } })) })) as any }),
  }));
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);
  owner = (await resolveIdentityFromToken("test-token", env))!;
  ws = owner.personalWorkspaceId;
});
afterEach(() => sqlite.close());

async function mcp(name: string, args: Record<string, unknown>, who: Identity = owner) {
  const server = buildMcpServer(env, ctx, who);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "validity-explicit", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    return String((result.content as { text?: string }[])[0]?.text ?? "");
  } finally { await client.close(); await server.close(); }
}
const rest = async (path: string, body: Record<string, unknown>) => {
  const res = await worker.fetch(req("POST", path, { body }), env, ctx);
  return { status: res.status, body: await res.json() as any };
};
const seed = (id: string, over: { createdAt?: number; validFrom?: number | null; validUntil?: number | null; actor?: string; workspace?: string } = {}) =>
  sqlite.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, valid_from, valid_until) VALUES (?, ?, '[]', 'api', ?, '[]', ?, ?, ?, ?)`)
    .bind(id, `content ${id}`, over.createdAt ?? Date.UTC(2026, 0, 10), over.workspace ?? ws, over.actor ?? owner.userId, over.validFrom ?? null, over.validUntil ?? null).run();
const row = async (id: string) => (await env.DB.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;
const versions = async (id: string) => (await env.DB.prepare(`SELECT reason, meta, channel, state FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const idOf = (text: string) => /ID: ([0-9a-f-]{36})/.exec(text)![1];
const FUTURE = "That date is in the future. Use when for plans and deadlines; valid dates are for what has already happened.";

describe("remember and POST /capture", () => {
  it("remember with valid_from stores it and supersedes by interval", async () => {
    await seed("denver", { createdAt: Date.UTC(2024, 0, 1) });
    matches = [{ id: "denver", score: 0.72 }];
    decision = `{"contradicts": true, "conflicting_id": "denver", "reason": "moved"}`;
    const text = await mcp("remember", { content: "Lives in Austin", valid_from: "2026-06" });
    const id = idOf(text);
    expect(await row(id)).toMatchObject({ valid_from: Date.UTC(2026, 5, 1), valid_until: null });
    expect((await row("denver")).valid_until).toBe(Date.UTC(2026, 5, 1));
    expect(text).toContain("true until Jun 1, 2026");
  });

  it("remember with valid_until stores a closed historical fact that never ends a current one", async () => {
    await seed("denver", { createdAt: Date.UTC(2024, 0, 1) });
    matches = [{ id: "denver", score: 0.72 }];
    decision = `{"contradicts": true, "conflicting_id": "denver", "reason": "moved"}`;
    const text = await mcp("remember", { content: "Lived in Boston", valid_until: "2020" });
    const id = idOf(text);
    expect(text).toBe(`Stored. ID: ${id}`);
    expect(await row(id)).toMatchObject({ valid_from: 0, valid_until: Date.UTC(2020, 0, 1) });
    expect((await row("denver")).valid_until).toBeNull();
  });

  it("POST /capture takes the same fields and refuses bad ones with the field named", async () => {
    const ok = await rest("/capture", { content: "Lives in Austin", valid_from: "2026-06-15" });
    expect(ok.status).toBe(200);
    expect((await row(ok.body.id)).valid_from).toBe(Date.UTC(2026, 5, 15));
    const future = await rest("/capture", { content: "Moving to Paris", valid_from: "2099-01" });
    expect(future).toEqual({ status: 400, body: { ok: false, error: FUTURE, field: "valid_from" } });
    const bad = await rest("/capture", { content: "x", valid_until: "last june" });
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe("valid_until");
    const backwards = await rest("/capture", { content: "x", valid_from: "2020", valid_until: "2019" });
    expect(backwards).toMatchObject({ status: 400, body: { ok: false, field: "valid_until" } });
  });

  it("future dates are refused on remember with the when hint", async () => {
    expect(await mcp("remember", { content: "Lease ends", valid_until: "2099-03" })).toBe(FUTURE);
    expect(sqlite.rows()).toHaveLength(0);
  });
});

describe("update and POST /update", () => {
  it("update valid_until ends a fact; undo restores it", async () => {
    await seed("acme");
    const text = await mcp("update", { id: "acme", valid_until: "2026-05" });
    expect(text).toBe("Memory acme is now recorded as true until May 1, 2026. It stays in history and is left out of current answers. Undo is available.");
    expect((await row("acme")).valid_until).toBe(Date.UTC(2026, 4, 1));
    const [v] = await versions("acme");
    expect(v.reason).toBe("validity");
    expect(JSON.parse(v.meta)).toMatchObject({ cause: "explicit" });
    await revertEntry(env, owner, "acme", { actorId: owner.userId, channel: "mcp" }, DEFAULTS, undefined, ws);
    expect((await row("acme")).valid_until).toBeNull();
  });

  it("update valid_until null reopens it", async () => {
    await seed("acme", { validUntil: Date.UTC(2026, 4, 1) });
    expect(await mcp("update", { id: "acme", valid_until: null })).toBe("Memory acme is current again. Undo is available.");
    expect((await row("acme")).valid_until).toBeNull();
  });

  it("update valid_from with content is refused with the remember hint", async () => {
    await seed("acme");
    expect(await mcp("update", { id: "acme", content: "Works at Beta", valid_from: "2026-02" }))
      .toBe("To record that something changed, remember the new fact; the old one is kept as history.");
    expect((await row("acme")).content).toBe("content acme");
  });

  it("update needs content, tags, volatility, valid_from or valid_until", async () => {
    await seed("acme");
    expect(await mcp("update", { id: "acme" })).toMatch(/content, valid_from or valid_until/);
    expect((await rest("/update", { id: "acme" })).status).toBe(400);
  });

  it("an end before the memory's start is refused, naming the start", async () => {
    await seed("acme", { createdAt: Date.UTC(2026, 5, 1) });
    expect(await mcp("update", { id: "acme", valid_until: "2026-05" }))
      .toBe("That end date is before this memory's start (Jun 1, 2026). Pass valid_from too if it began earlier.");
    expect(await mcp("update", { id: "acme", valid_from: "2026-01", valid_until: "2026-05" })).toMatch(/^Memory acme is now recorded as true from Jan 1, 2026 until May 1, 2026\./);
  });

  it("update valid_from propagates to the row it replaced and refuses a move before that row's start", async () => {
    await seed("denver", { createdAt: Date.UTC(2024, 0, 1), validUntil: Date.UTC(2026, 5, 1) });
    await seed("austin", { createdAt: Date.UTC(2026, 7, 1), validFrom: Date.UTC(2026, 5, 1) });
    await sqlite.db.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id) VALUES ('s', 'austin', 'denver', 'supersedes', 1, 'system', '{}', 1, 1, ?)`).bind(ws).run();
    const text = await mcp("update", { id: "austin", valid_from: "2026-05" });
    expect(text).toBe("Memory austin is now recorded as true from May 1, 2026. Memory denver's end date moved to match.");
    expect((await row("denver")).valid_until).toBe(Date.UTC(2026, 4, 1));
    const [pv] = (await versions("denver")).slice(-1);
    expect(JSON.parse(pv.meta)).toMatchObject({ cause: "propagate", by: "austin" });
    expect(await mcp("update", { id: "austin", valid_from: "2023-06" })).toBe("Memory denver began on Jan 1, 2024, so austin cannot start before that. Nothing changed.");
    expect((await row("austin")).valid_from).toBe(Date.UTC(2026, 4, 1));
  });

  it("future dates are refused on update with the when hint", async () => {
    await seed("acme");
    expect(await mcp("update", { id: "acme", valid_until: "2099" })).toBe(FUTURE);
    expect(await rest("/update", { id: "acme", valid_until: "2099" })).toEqual({ status: 400, body: { ok: false, error: FUTURE, field: "valid_until" } });
  });

  it("REST and MCP leave identical rows and versions except channel", async () => {
    await seed("a");
    await seed("b");
    await mcp("update", { id: "a", valid_until: "2026-05" });
    const r = await rest("/update", { id: "b", valid_until: "2026-05" });
    expect(r.body).toMatchObject({ ok: true, id: "b", validity: { valid_until: Date.UTC(2026, 4, 1), propagated: [] } });
    const strip = (x: any) => { const { write_marker, ...row } = x; expect(write_marker).toEqual(expect.any(String)); return { ...row, id: undefined, content: undefined }; };
    expect(strip(await row("a"))).toEqual(strip(await row("b")));
    const [va] = await versions("a");
    const [vb] = await versions("b");
    expect([va.channel, vb.channel]).toEqual(["mcp", "rest"]);
    expect({ ...va, channel: 0, meta: JSON.parse(va.meta).cause }).toEqual({ ...vb, channel: 0, meta: JSON.parse(vb.meta).cause });
  });

  it("author lock and D-SH apply: a member cannot end a teammate's shared memory", async () => {
    const roots = await ensureTenantBootstrap(env);
    const bea = (await resolveIdentityByUserId(env, (await createMember(env, { name: "Bea" })).member.userId))!;
    await seed("shared", { workspace: roots.companyWorkspaceId });
    const text = await mcp("update", { id: "shared", valid_until: "2026-05" }, bea);
    expect(text).not.toMatch(/now recorded/);
    expect((await row("shared")).valid_until).toBeNull();
  });
});

describe("descriptions", () => {
  it("the tool descriptions contain the approved text", async () => {
    const server = buildMcpServer(env, ctx, owner);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "desc", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const { tools } = await client.listTools();
    await client.close(); await server.close();
    const prop = (tool: string, p: string) => (tools.find(t => t.name === tool)!.inputSchema.properties as any)[p].description as string;
    expect(prop("remember", "valid_from")).toBe("When this became true, if the user said so ('I moved to Austin in June' = 2026-06). A date, month or year. Omit it when the fact is new today. Never a future date: use when for plans and deadlines.");
    expect(prop("remember", "valid_until")).toBe("When this stopped being true, for a fact that is already over ('I lived in Boston until 2020' = 2020). Omit it for anything still true.");
    expect(prop("update", "valid_until")).toBe("When the memory stopped being true ('that ended in May' = 2026-05). Pass null if the user says it is true again. It stays in history and is left out of current answers. valid_until only for a date that has already passed; for future dates use when.");
    expect(prop("update", "valid_from")).toBe("Corrects when this memory's current content became true. Cannot be combined with new content.");
    for (const t of tools) expect(JSON.stringify(t), t.name).not.toMatch(/valid_[a-z]+[^"]*—/);
  });
});

import { updateEntryValidity } from "../../src/memory/validity";
describe("budget", () => {
  it("update with validity is one read and one batch, plus its audit batch; propagating adds nothing", async () => {
    await seed("denver", { createdAt: Date.UTC(2024, 0, 1), validUntil: Date.UTC(2026, 5, 1) });
    await seed("austin", { createdAt: Date.UTC(2026, 7, 1), validFrom: Date.UTC(2026, 5, 1) });
    await sqlite.db.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id) VALUES ('s', 'austin', 'denver', 'supersedes', 1, 'system', '{}', 1, 1, ?)`).bind(ws).run();
    const change = { actorId: owner.userId, channel: "rest" as const };
    sqlite.executions.length = 0;
    const r = await updateEntryValidity(env, "austin", { from: Date.UTC(2026, 4, 1) }, change, DEFAULTS, ws);
    expect(r).toMatchObject({ status: "updated", propagated: ["denver"] });
    expect(sqlite.executions.length, sqlite.executions.join("\n")).toBe(3);
    expect(sqlite.executions.filter(s => s === "BATCH")).toHaveLength(2);
  });
});
