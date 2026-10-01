/**
 * Track 2 Task A3 (T-0089.2.1): a contradiction supersedes instead of deprecating (spec 14 5.3).
 * The older fact keeps its row, status and vectors and gets a validity window; history is kept.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { captureEntry, type CaptureResult } from "../../src/capture/entry";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import { revertEntry } from "../../src/memory/undo";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;

/** Embeds and answers the one LLM decision; every later AI call (indexing, classify) never settles,
 * so the D1 statements counted below are the capture path's own and nothing deferred. */
function makeAI(decision: string, settleCalls = Infinity) {
  let calls = 0;
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      calls++;
      if (calls > settleCalls) return new Promise(() => {});
      if (model === "@cf/google/embeddinggemma-300m") return { data: [new Array(768).fill(0.1)] };
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(decision)}}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as unknown as Ai;
}

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
let ws: string;
let deleteByIds: any;
let prompts: string[];

async function setup(matches: { id: string; score: number }[], decision: string, settleCalls = Infinity) {
  resetDatabaseInit();
  pending.length = 0;
  sqlite = makeSqliteD1();
  deleteByIds = vi.fn().mockResolvedValue({ mutationId: "m" });
  const ai = makeAI(decision, settleCalls);
  prompts = [];
  const run = (ai as any).run;
  (ai as any).run = (model: string, input: any) => {
    if (input?.messages) prompts.push(String(input.messages[0].content));
    return run(model, input);
  };
  env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockResolvedValue({ matches: matches.map(m => ({ ...m, metadata: { parentId: m.id } })) }),
      deleteByIds,
    }),
    AI: ai,
  }));
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
  ws = owner.personalWorkspaceId;
}
afterEach(() => sqlite?.close());

const contradicts = (id: string) => `{"contradicts": true, "conflicting_id": "${id}", "reason": "different city"}`;
const seed = (id: string, content: string, over: { createdAt?: number; validFrom?: number | null; validUntil?: number | null; tags?: string[]; source?: string; actor?: string } = {}) =>
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, valid_from, valid_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, content, JSON.stringify(over.tags ?? []), over.source ?? "api", over.createdAt ?? 1000, JSON.stringify([id]), ws,
    over.actor ?? owner.userId, over.validFrom ?? null, over.validUntil ?? null).run();
const row = async (id: string) => (await env.DB.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;
const versions = async (id: string) => (await env.DB.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const edges = async () => (await env.DB.prepare(`SELECT source_id, target_id, type FROM edges WHERE type = 'supersedes'`).all()).results as any[];
const events = async () => {
  await Promise.race([Promise.allSettled(pending), new Promise(r => setTimeout(r, 20))]);
  return (await env.DB.prepare(`SELECT entry_id, event, payload FROM entry_events`).all()).results as any[];
};
const user = () => ({ workspaceId: ws, actorId: owner.userId });
const capture = (content: string, opts: Parameters<typeof captureEntry>[8] = {}, tags: string[] = [], source = "api", writeCtx = user()) =>
  captureEntry(content, tags, source, env, ctx, DEFAULTS, writeCtx, undefined, { channel: "rest", ...opts });

/** Runs `sql` once, just before the first batch: another writer landing between capture's read and its write. */
function raceBeforeBatch(sql: string) {
  const db = sqlite.db as any;
  const realBatch = db.batch.bind(db);
  const race = db.prepare(sql);
  let fired = false;
  db.batch = async (stmts: any[]) => {
    if (!fired) { fired = true; await race.run(); }
    return realBatch(stmts);
  };
}

describe("a contradiction supersedes", () => {
  it("closes the older row at the newer start, keeps its status and vectors, adds the edge, and writes one validity version", async () => {
    await setup([{ id: "old", score: 0.72 }], contradicts("old"));
    await seed("old", "I live in NYC", { tags: ["status:draft"] });
    const r = await capture("I moved to LA");
    expect(r).toMatchObject({ status: "contradiction", resolvedConflict: "old", supersede: { closedId: "old", direction: "older" } });
    const created = (await row((r as any).id)).created_at;
    expect((r as any).supersede.at).toBe(created);
    expect(await row("old")).toMatchObject({ valid_until: created, tags: `["status:draft"]`, vector_ids: `["old"]` });
    expect(deleteByIds).not.toHaveBeenCalled();
    const vs = await versions("old");
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ reason: "validity" });
    expect(JSON.parse(vs[0].meta)).toEqual({ cause: "supersede", by: (r as any).id });
    expect(await edges()).toEqual([{ source_id: (r as any).id, target_id: "old", type: "supersedes" }]);
    expect(await row((r as any).id)).toMatchObject({ valid_until: null, contradiction_wins: 1 });
    expect((await row("old")).contradiction_losses).toBe(1);
    expect(JSON.parse((await row((r as any).id)).tags)).toContain("contradiction-resolved");
  });

  it("a newcomer with no stated start that ties the older start (same millisecond, clock skew) still replaces it", async () => {
    await setup([{ id: "old", score: 0.72 }], contradicts("old"));
    const t0 = Date.now() + 5_000; // the older row's start is at or after this capture's own clock
    await seed("old", "I live in NYC", { createdAt: t0 });
    const spy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      const r = await capture("I moved to LA");
      expect(r).toMatchObject({ status: "contradiction", supersede: { closedId: "old", direction: "older", at: t0 + 1 } });
      expect(await row((r as any).id)).toMatchObject({ valid_from: t0 + 1, valid_until: null });
      expect((await row("old")).valid_until).toBe(t0 + 1);
    } finally { spy.mockRestore(); }
  });

  it("audits superseded on the closed row, not status_changed", async () => {
    await setup([{ id: "old", score: 0.72 }], contradicts("old"));
    await seed("old", "I live in NYC");
    const r = await capture("I moved to LA");
    const trail = (await events()).filter(e => e.entry_id === "old");
    expect(trail).toHaveLength(1);
    expect(trail[0].event).toBe("superseded");
    expect(JSON.parse(trail[0].payload)).toEqual({ by: (r as any).id, until: (r as any).supersede.at, channel: "rest" });
  });

  it("a late-told older fact closes the newcomer and points the edge the other way", async () => {
    await setup([{ id: "denver", score: 0.72 }], contradicts("denver"));
    await seed("denver", "I live in Denver", { createdAt: Date.UTC(2024, 0, 1) });
    const r = await capture("I lived in Boston", { validity: { from: Date.UTC(2018, 0, 1) } });
    expect(r).toMatchObject({ status: "contradiction", resolvedConflict: "denver", supersede: { closedId: (r as any).id, at: Date.UTC(2024, 0, 1), direction: "newer" } });
    expect(await row((r as any).id)).toMatchObject({ valid_from: Date.UTC(2018, 0, 1), valid_until: Date.UTC(2024, 0, 1) });
    expect(await row("denver")).toMatchObject({ valid_until: null });
    expect(await versions("denver")).toHaveLength(0);
    expect(await edges()).toEqual([{ source_id: "denver", target_id: (r as any).id, type: "supersedes" }]);
  });

  it("disjoint stated windows change nothing and store the newcomer normally", async () => {
    await setup([{ id: "denver", score: 0.72 }], contradicts("denver"));
    await seed("denver", "I live in Denver", { createdAt: Date.UTC(2024, 0, 1) });
    const r = await capture("I lived in Boston", { validity: { from: Date.UTC(2018, 0, 1), until: Date.UTC(2020, 0, 1) } });
    expect(r.status).toBe("stored");
    const fresh = await row((r as any).id);
    expect(fresh).toMatchObject({ valid_from: Date.UTC(2018, 0, 1), valid_until: Date.UTC(2020, 0, 1) });
    expect(JSON.parse(fresh.tags)).not.toContain("contradiction-resolved");
    expect(await row("denver")).toMatchObject({ valid_until: null, contradiction_losses: 0 });
    expect(await edges()).toEqual([]);
  });

  it("a fact told as already over never ends a current one", async () => {
    await setup([{ id: "denver", score: 0.72 }], contradicts("denver"));
    await seed("denver", "I live in Denver", { createdAt: Date.UTC(2024, 0, 1) });
    const r = await capture("I lived in Austin for the summer", { validity: { from: Date.UTC(2025, 5, 1), until: Date.UTC(2025, 8, 1) } });
    expect(r.status).toBe("stored");
    expect(await row("denver")).toMatchObject({ valid_until: null });
  });

  it("a canonical conflict still stores the newcomer as a draft and closes nothing", async () => {
    await setup([{ id: "old", score: 0.72 }], contradicts("old"));
    await seed("old", "I live in NYC", { tags: ["status:canonical"] });
    const r = await capture("I moved to LA");
    expect(r).toMatchObject({ status: "contradiction_protected", canonicalId: "old", entryStatus: "draft" });
    expect(await row("old")).toMatchObject({ valid_until: null });
    expect(await versions("old")).toHaveLength(0);
    expect(await edges()).toEqual([]);
  });

  it("a canonical conflict with a disjoint or late-told newcomer stores it normally", async () => {
    await setup([{ id: "old", score: 0.72 }], contradicts("old"));
    await seed("old", "I live in Denver", { tags: ["status:canonical"], createdAt: Date.UTC(2024, 0, 1) });
    const disjoint = await capture("I lived in Boston", { validity: { from: Date.UTC(2018, 0, 1), until: Date.UTC(2020, 0, 1) } });
    expect(disjoint.status).toBe("stored");
    expect(JSON.parse((await row((disjoint as any).id)).tags)).not.toContain("status:draft");
    const late = await capture("I lived in Chicago", { validity: { from: Date.UTC(2021, 0, 1) } });
    expect(late).toMatchObject({ status: "contradiction", supersede: { direction: "newer" } });
    expect(JSON.parse((await row((late as any).id)).tags)).not.toContain("status:draft");
    expect(await row("old")).toMatchObject({ valid_until: null, tags: `["status:canonical"]` });
  });

  it("a system job's supersede is compare-and-set: a row that changed since the read makes the newcomer a held draft", async () => {
    await setup([{ id: "old", score: 0.72 }], contradicts("old"));
    await seed("old", "Digest: NYC", { source: "system", tags: ["synthesized"], actor: "" });
    raceBeforeBatch(`UPDATE entries SET content = 'Digest: NYC, edited' WHERE id = 'old'`);
    const r = await capture("Digest: LA", { systemWrite: "digest", channel: "system:digest" }, [], "system", { workspaceId: ws, actorId: "" });
    expect(r.status).toBe("contradiction_protected");
    expect(await row("old")).toMatchObject({ valid_until: null });
    expect(await versions("old")).toHaveLength(0);
    expect(await edges()).toEqual([]);
  });

  it("a system job's supersede cannot reach a user row", async () => {
    await setup([{ id: "old", score: 0.72 }], contradicts("old"));
    await seed("old", "I live in NYC");
    const r = await capture("Digest: LA", { systemWrite: "digest", channel: "system:digest" }, [], "system", { workspaceId: ws, actorId: "" });
    expect(r.status).toBe("contradiction_protected");
    expect(await row("old")).toMatchObject({ valid_until: null });
  });

  it("a system job may supersede a row a system job wrote", async () => {
    await setup([{ id: "old", score: 0.72 }], contradicts("old"));
    await seed("old", "Digest: NYC", { source: "system", tags: ["synthesized"], actor: "" });
    const r = await capture("Digest: LA", { systemWrite: "digest", channel: "system:digest" }, [], "system", { workspaceId: ws, actorId: "" });
    expect(r).toMatchObject({ status: "contradiction", supersede: { closedId: "old" } });
    expect((await row("old")).valid_until).not.toBeNull();
  });

  it("a supersede that loses its CAS writes no version and no edge, and stores the newcomer as an ordinary memory", async () => {
    await setup([{ id: "old", score: 0.72 }], contradicts("old"));
    await seed("old", "I live in NYC");
    raceBeforeBatch(`UPDATE entries SET tags = '["status:canonical"]' WHERE id = 'old'`);
    const r = await capture("I moved to LA");
    expect(r.status).toBe("stored");
    expect(await row("old")).toMatchObject({ valid_until: null, contradiction_losses: 0 });
    expect(await versions("old")).toHaveLength(0);
    expect(await edges()).toEqual([]);
    expect(JSON.parse((await row((r as any).id)).tags)).not.toContain("contradiction-resolved");
  });

  it("a row edited since the read is not closed on the old reading", async () => {
    await setup([{ id: "old", score: 0.72 }], contradicts("old"));
    await seed("old", "I live in NYC");
    raceBeforeBatch(`UPDATE entries SET content = 'I live in NYC and LA', updated_at = 99999 WHERE id = 'old'`);
    const r = await capture("I moved to LA");
    expect(r.status).toBe("stored");
    expect(await row("old")).toMatchObject({ valid_until: null });
  });
});

describe("candidates exclude superseded rows", () => {
  it("'moved back to Denver' supersedes Austin, not merges into or blocks on the old Denver row", async () => {
    // The old Denver row is history (closed); it is the nearest neighbour, above the block threshold.
    await setup([{ id: "old-denver", score: 0.97 }, { id: "austin", score: 0.7 }], contradicts("austin"));
    await seed("old-denver", "I live in Denver", { createdAt: 1000, validUntil: 2000 });
    await seed("austin", "I live in Austin", { createdAt: 2000 });
    const r = await capture("I live in Denver");
    expect(r).toMatchObject({ status: "contradiction", resolvedConflict: "austin", supersede: { closedId: "austin" } });
    expect(prompts.join("\n")).not.toContain("old-denver");
    expect(await row("old-denver")).toMatchObject({ valid_until: 2000 });
  });

  it("a superseded row is never a merge target", async () => {
    await setup([{ id: "old", score: 0.9 }], `{"action":"merge","target_id":"old","merged_content":"x"}`);
    await seed("old", "I live in Denver", { validUntil: 2000 });
    const r = await capture("I live in Denver now");
    expect(r.status).toBe("stored");
    expect(await row("old")).toMatchObject({ content: "I live in Denver" });
  });
});

describe("undo and budget", () => {
  it("undo(older) after a supersede makes it current again; the newcomer stays", async () => {
    await setup([{ id: "old", score: 0.72 }], contradicts("old"));
    await seed("old", "I live in NYC");
    const r = await capture("I moved to LA");
    const u = await revertEntry(env, owner, "old", { actorId: owner.userId, channel: "rest" }, DEFAULTS, undefined, ws);
    expect(u).toMatchObject({ status: "reverted" });
    expect(await row("old")).toMatchObject({ valid_until: null });
    expect(await row((r as any).id)).toMatchObject({ valid_until: null });
  });

  it("supersede is one batch: the capture costs the duplicate read, the conflict read, the insert, one batch and its audit", async () => {
    await setup([{ id: "old", score: 0.72 }], contradicts("old"), 2);
    await seed("old", "I live in NYC");
    sqlite.executions.length = 0;
    const r: CaptureResult = await capture("I moved to LA");
    expect(r.status).toBe("contradiction");
    // migration/restoreの読取フェンスとembedding世代の確認・初期化を含む8 D1呼び出し。
    expect(sqlite.executions, sqlite.executions.join("\n")).toHaveLength(8);
    expect(sqlite.executions[5]).toBe("BATCH");
    expect(sqlite.executions[7]).toMatch(/^INSERT INTO entry_events/);
    expect(deleteByIds).not.toHaveBeenCalled();
  });
});

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { req } from "../helpers/make-request";
import { resolveIdentityFromToken } from "../../src/lib/identity";

async function mcpCall(name: string, args: Record<string, unknown>) {
  const identity = (await resolveIdentityFromToken("test-token", env))!;
  const server = buildMcpServer(env, ctx, identity);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "supersede-test", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    return String((result.content as { text?: string }[])[0]?.text ?? "");
  } finally {
    await client.close();
    await server.close();
  }
}

describe("surfaces", () => {
  it("the remember reply names the replaced entry and its end date, with no em dash", async () => {
    await setup([{ id: "old", score: 0.72 }], contradicts("old"));
    await seed("old", "Lives in Denver, in the house on Elm Street near the park and the old library");
    const text = await mcpCall("remember", { content: "Lives in Austin" });
    const id = /ID: ([0-9a-f-]{36})/.exec(text)![1];
    const until = (await row("old")).valid_until;
    const date = new Date(until).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
    const preview = "Lives in Denver, in the house on Elm Street near the park and the old library".slice(0, 60);
    expect(text).toBe(`Stored. ID: ${id}. It replaces memory old ("${preview}"), which is kept as history: true until ${date}. If that was wrong, undo(old) makes old current again.`);
    expect(text).not.toMatch(/—/);
  });

  it("a late-told remember says it was stored as history", async () => {
    await setup([{ id: "denver", score: 0.72 }], contradicts("denver"));
    await seed("denver", "Lives in Denver", { createdAt: Date.UTC(2024, 0, 1) });
    const r = await capture("Lived in Boston", { validity: { from: Date.UTC(2018, 0, 1) } });
    const { supersedeReply } = await import("../../src/memory/validity");
    expect(supersedeReply((r as any).id, (r as any).resolvedConflict, (r as any).supersede, "UTC")).toBe(
      `Stored. ID: ${(r as any).id} as history: it was true until Jan 1, 2024, when memory denver began.`);
  });

  it("POST /capture returns the supersede fields", async () => {
    await setup([{ id: "old", score: 0.72 }], contradicts("old"));
    await seed("old", "Lives in Denver");
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "Lives in Austin" } }), env, ctx);
    const data = await res.json() as any;
    expect(data).toMatchObject({ ok: true, resolved_conflict: "old", supersede: { closed_id: "old", at: (await row("old")).valid_until, direction: "older" } });
  });
});

describe("moved from the D1-mock unit tests (capture-entry, auto-link)", () => {
  it("a hand-written (claude) contradiction still supersedes: the transcript rule does not apply", async () => {
    await setup([{ id: "existing", score: 0.7 }], contradicts("existing"));
    await seed("existing", "We decided to use Vectorize for semantic search.", { source: "claude" });
    const r = await capture("We moved off Vectorize to a KV index.", {}, [], "claude");
    expect(r).toMatchObject({ status: "contradiction", supersede: { closedId: "existing" } });
  });

  it("projects a supersedes edge and no redundant relates_to when a new entry wins a contradiction", async () => {
    await setup([{ id: "existing", score: 0.9 }], `{"action":"contradiction","conflicting_id":"existing","reason":"conflict"}`);
    await seed("existing", "The old fact");
    const r = await capture("The corrected fact");
    await Promise.race([Promise.allSettled(pending), new Promise(res => setTimeout(res, 50))]);
    expect(r.status).toBe("contradiction");
    const all = (await env.DB.prepare(`SELECT source_id, target_id, type, provenance FROM edges`).all()).results as any[];
    expect(all).toEqual([{ source_id: (r as any).id, target_id: "existing", type: "supersedes", provenance: "system" }]);
  });
});
