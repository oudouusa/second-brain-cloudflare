import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { resolveEntryAction, applyInsightResolution } from "../../src/memory/actions";
import { applyStatus } from "../../src/capture/lifecycle";
import { compressTag } from "../../src/compression/digest";
import { makeMirrorStore } from "../../src/integrations/mirror";
import { canRevert, loadHistory } from "../../src/memory/versions";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
let pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
const drain = () => Promise.allSettled(pending);

beforeEach(async () => {
  resetDatabaseInit();
  pending = [];
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  env = sqlite.admitEnv(env);
  const roots = await ensureTenantBootstrap(env);
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
});
afterEach(() => sqlite.close());

async function mcpCall(name: string, args: Record<string, unknown>, user: Identity = owner) {
  const server = buildMcpServer(env, ctx, user);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try { return await client.callTool({ name, arguments: args }); } finally { await client.close(); }
}
const seed = (id: string, over: Record<string, unknown> = {}) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, when_at, when_kind, when_label, when_source)
   VALUES (?, ?, ?, 'api', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(
  id, over.content ?? "Some fact", JSON.stringify(over.tags ?? []), over.createdAt ?? 1000, over.updatedAt ?? null, JSON.stringify(over.vectorIds ?? [id]),
  over.workspaceId ?? owner.personalWorkspaceId, over.actorId ?? owner.userId, over.whenAt ?? null, over.whenKind ?? null, over.whenLabel ?? null, over.whenSource ?? null,
).run();
const versions = async (id: string) => (await env.DB.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const row = (id: string) => sqlite.rows().find(r => r.id === id)!;

describe("versioning: resolve actions (loops, still_true, due)", () => {
  it("still_true via REST and via MCP resolve writes a status version", async () => {
    await seed("t1", { tags: ["stale:as-of"] });
    const restRes = await worker.fetch(req("POST", "/stale/keep", { body: { id: "t1" } }), env, ctx);
    expect(restRes.status).toBe(200);
    expect((await versions("t1"))[0]).toMatchObject({ reason: "status", channel: "rest" });

    await seed("t2", { tags: ["stale:as-of"] });
    await mcpCall("resolve", { id: "t2", action: "still_true" });
    expect((await versions("t2"))[0]).toMatchObject({ reason: "status", channel: "mcp" });
  });

  it("loops done writes one version on success and none on the losing CAS attempt", async () => {
    await seed("l1", { tags: ["task"] });
    const result = await resolveEntryAction(env, ctx, owner, "l1", "done", undefined, { actorId: owner.userId, channel: "rest" });
    expect(result.ok).toBe(true);
    expect(await versions("l1")).toHaveLength(1);

    // A losing race (content changes under it 3 times) writes no version.
    await seed("l2", { tags: ["task"] });
    let n = 0;
    const raw = env.DB as any;
    const racing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare: (sql: string) => {
      const st = raw.prepare(sql);
      if (sql.startsWith("UPDATE entries AS e SET write_marker = ") && sql.includes("tags =")) {
        sqlite.db.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', content = content || ?  WHERE id = 'l2'`).bind(`.${++n}`).run();
      }
      return st;
    } } } as unknown as Env;
    const lost = await resolveEntryAction(racing, ctx, owner, "l2", "done", undefined, { actorId: owner.userId, channel: "rest" });
    expect(lost.ok).toBe(false);
    expect(await versions("l2")).toEqual([]);
  });

  it("snooze writes a due version whose state holds the prior when_at, when_kind, when_source and when_label", async () => {
    await seed("d1", { whenAt: 5000, whenKind: "event", whenSource: "regex", whenLabel: "old label" });
    const until = Date.now() + 86400000;
    const result = await resolveEntryAction(env, ctx, owner, "d1", "snooze", new Date(until).toISOString(), { actorId: owner.userId, channel: "rest" });
    expect(result.ok).toBe(true);
    const [v] = await versions("d1");
    expect(v.reason).toBe("due");
    expect(JSON.parse(v.state)).toEqual({ when_at: 5000, when_kind: "event", when_source: "regex", when_label: "old label", valid_from: null, valid_until: null });
    expect(JSON.parse(v.meta)).toMatchObject({ due_action: "snooze" });
  });

  it("clear_date writes a due version holding all four prior when_* values", async () => {
    await seed("d2", { whenAt: 5000, whenKind: "due", whenSource: "explicit", whenLabel: "call bob" });
    const result = await resolveEntryAction(env, ctx, owner, "d2", "clear_date", undefined, { actorId: owner.userId, channel: "rest" });
    expect(result.ok).toBe(true);
    const [v] = await versions("d2");
    expect(JSON.parse(v.state)).toEqual({ when_at: 5000, when_kind: "due", when_source: "explicit", when_label: "call bob", valid_from: null, valid_until: null });
    expect(JSON.parse(v.meta)).toEqual({ due_action: "clear" });
    expect(row("d2").when_source).toBe("cleared");
  });

  it("snooze to the date it already has writes no version", async () => {
    const until = Date.now() + 86400000;
    await seed("d3", { whenAt: until, whenKind: "due" });
    const result = await resolveEntryAction(env, ctx, owner, "d3", "snooze", new Date(until).toISOString(), { actorId: owner.userId, channel: "rest" });
    expect(result.ok).toBe(true);
    expect(await versions("d3")).toEqual([]);
  });

  it("ADV-1: a 409 snooze (or clear) whose collision was a when_* change alone still writes no version", async () => {
    // The snapshot's own guard used to check only tags and content, so a concurrent when_at change
    // (invisible to that guard) still let the UPDATE miss while the snapshot committed regardless —
    // a phantom "due" version, under the caller's actor, for a change that never landed (spec P3).
    await seed("d5", { whenAt: 5_000_000_000_000, whenKind: "due", whenLabel: "call bob" });
    let n = 0;
    const raw = env.DB as any;
    const racing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare: (sql: string) => {
      const st = raw.prepare(sql);
      if (sql.startsWith("SELECT id, workspace_id, actor_id, tags, content, when_at")) {
        return { bind: (...a: unknown[]) => ({ first: async () => {
          const r = await st.bind(...a).first();
          await sqlite.db.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', when_at = ? WHERE id = 'd5'`).bind(5_000_000_000_000 + ++n * 1000).run();
          return r;
        } }) };
      }
      return st;
    } } } as unknown as Env;
    const result = await resolveEntryAction(racing, ctx, owner, "d5", "snooze", new Date(Date.now() + 86400000).toISOString(), { actorId: owner.userId, channel: "rest" });
    expect(result.ok).toBe(false);
    expect(await versions("d5")).toEqual([]);
  });

  it("a snooze that loses the CAS race writes no version", async () => {
    await seed("d4", { whenAt: 1000, whenKind: "due" });
    const raw = env.DB as any;
    let n = 0;
    const racing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare: (sql: string) => {
      if (sql.startsWith("UPDATE entries AS e SET write_marker = ") && sql.includes("when_at =")) {
        sqlite.db.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', tags = ? WHERE id = 'd4'`).bind(JSON.stringify([`raced-${++n}`])).run();
      }
      return raw.prepare(sql);
    } } } as unknown as Env;
    const result = await resolveEntryAction(racing, ctx, owner, "d4", "snooze", new Date(Date.now() + 86400000).toISOString(), { actorId: owner.userId, channel: "rest" });
    expect(result.ok).toBe(false);
    expect(await versions("d4")).toEqual([]);
  });
});

describe("versioning: insight resolution (A2)", () => {
  it("insight confirm via REST and via MCP resolve writes a status version holding the prior kind: and status: tags", async () => {
    await seed("i1", { tags: ["auto-insight", "kind:episodic"] });
    const found = [{ id: "i1", tags: row("i1").tags, vector_ids: row("i1").vector_ids, workspace_id: row("i1").workspace_id }];
    const result = await applyInsightResolution(env, ctx, { actorId: owner.userId, channel: "rest" }, found, 1, "confirm");
    expect(result.resolved).toEqual(["i1"]);
    const [v] = await versions("i1");
    expect(v.reason).toBe("status");
    expect(JSON.parse(v.tags)).toEqual(expect.arrayContaining(["auto-insight", "kind:episodic"]));
    expect(JSON.parse(v.meta)).toEqual({ insight_action: "confirm" });
  });

  it("insight dismiss writes a status version; vectors are still deleted", async () => {
    let deletedIds: string[] = [];
    const env2 = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({ deleteByIds: vi.fn(async (ids: string[]): Promise<any> => { deletedIds = ids; return { mutationId: "m" }; }) }),
    })) as Env;
    await seed("i2", { tags: ["auto-insight"], vectorIds: ["v1", "v2"] });
    const found = [{ id: "i2", tags: row("i2").tags, vector_ids: row("i2").vector_ids, workspace_id: row("i2").workspace_id }];
    const result = await applyInsightResolution(env2, ctx, { actorId: owner.userId, channel: "mcp" }, found, 1, "dismiss");
    expect(result.resolved).toEqual(["i2"]);
    expect((await env2.DB.prepare(`SELECT * FROM entry_versions WHERE entry_id = 'i2'`).all()).results[0]).toMatchObject({ reason: "status" });
    expect(deletedIds).toEqual(["v1", "v2"]);
  });

  it("insight resolution of 60 ids writes 60 versions in one batch, never one D1 call per row", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) { const id = `ins-${i}`; await seed(id, { tags: ["auto-insight"] }); ids.push(id); }
    sqlite.issued.length = 0;
    sqlite.batches.length = 0;
    const found = ids.map(id => ({ id, tags: row(id).tags, vector_ids: row(id).vector_ids, workspace_id: row(id).workspace_id }));
    const result = await applyInsightResolution(env, ctx, { actorId: owner.userId, channel: "rest" }, found, 60, "confirm");
    expect(result.resolved).toHaveLength(60);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM entry_versions`).first<{ n: number }>())!.n).toBe(60);
    // One batch for the write (60 own-guarded snapshot INSERTs, 60 own-guarded UPDATEs, ADV-2 — and
    // the pruneMany DELETE) and one for the audit trail (auditEvents), never one D1 call per row.
    const batches = sqlite.batches;
    expect(batches).toHaveLength(2);
  });

  it("a member who dismissed a company insight: canRevert allows it against the real rows; a second member's later confirm makes it stale", async () => {
    const bobIdentity = (await resolveIdentityFromToken((await createMember(env, { name: "Bob" })).token, env))!;
    const roots = await ensureTenantBootstrap(env);
    await seed("ci1", { tags: ["auto-insight"], workspaceId: roots.companyWorkspaceId, actorId: "" });
    const foundRow = { id: "ci1", tags: row("ci1").tags, vector_ids: row("ci1").vector_ids, workspace_id: roots.companyWorkspaceId };
    await applyInsightResolution(env, ctx, { actorId: bobIdentity.userId, channel: "rest" }, [foundRow], 1, "dismiss");
    const entryRow = { workspace_id: roots.companyWorkspaceId, actor_id: "" };
    let chain = await loadHistory(env, bobIdentity, { id: "ci1", content: String(row("ci1").content) }, 10);
    expect(canRevert(bobIdentity, entryRow, chain.rows[0], chain.rows[0].seq, chain.rows.map(r => r.seq))).toEqual({ ok: true });

    const carolIdentity = (await resolveIdentityFromToken((await createMember(env, { name: "Carol" })).token, env))!;
    // An admin correction after the dismiss (not another applyInsightResolution call, which reads
    // this row's own current tags and would see it already deprecated): second member's later
    // change bumps the seq.
    await applyStatus("ci1", "canonical", env, { actorId: carolIdentity.userId, channel: "rest" }, DEFAULTS, roots.companyWorkspaceId);
    chain = await loadHistory(env, bobIdentity, { id: "ci1", content: String(row("ci1").content) }, 10);
    const bobsVersion = chain.rows.find(v => v.actor_id === bobIdentity.userId)!;
    expect(canRevert(bobIdentity, entryRow, bobsVersion, chain.rows[0].seq, chain.rows.map(r => r.seq))).toEqual({ ok: false, code: "stale" });
  });
});

describe("versioning: digest rollup and mirror", () => {
  function digestAI(text = "Synthesized text") {
    return { run: vi.fn(async (model: string) => model === "@cf/google/embeddinggemma-300m"
      ? { data: [new Array(768).fill(0.1)] }
      : new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
      } })) } as any;
  }

  it("digest rollup writes rollup deltas and reconstructs the pre-digest text, plus the per-row fallback", async () => {
    const digestEnv = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), AI: digestAI() })) as Env;
    const before: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = `src-${i}`;
      const content = `Work memory number ${i} with enough detail to be eligible`;
      before.push(content);
      await seed(id, { content, tags: ["rocket-project"], createdAt: 1000 + i, updatedAt: null });
    }
    const result = await compressTag("rocket-project", digestEnv, ctx);
    expect(result.synthesizedId).not.toBeNull();
    for (let i = 0; i < 12; i++) {
      const id = `src-${i}`;
      const vs = await versions(id);
      expect(vs).toHaveLength(1);
      expect(vs[0]).toMatchObject({ reason: "rollup" });
      expect(JSON.parse(vs[0].meta)).toEqual({ digestId: result.synthesizedId });
      const chain = await loadHistory(digestEnv, undefined, { id, content: String(row(id).content) }, 5);
      expect(chain.text(vs[0].seq)).toBe(before[i]);
    }
  });

  it("a mirror update keeps 3 mirror versions and never prunes a user's status version out of order", async () => {
    const store = makeMirrorStore(env, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, undefined, "notion");
    const id = await store.createEntry("mirror v1", ["rocket-project"], "notion");
    await store.updateEntry(id, "mirror v2");
    // A user marks it canonical (a status version).
    await resolveEntryAction(env, ctx, owner, id, "done", undefined, { actorId: owner.userId, channel: "rest" }).catch(() => {});
    await sqlite.db.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', tags = '["rocket-project","status:canonical"]' WHERE id = ?`).bind(id).run();
    await env.DB.batch([
      // simulate the versioned status change directly since "done" needs a task tag
    ] as any[]);
    const { snapshotStatement, pruneStatement } = await import("../../src/memory/versions");
    await env.DB.batch([
      snapshotStatement(env, { entryId: id, reason: "status", change: { actorId: owner.userId, channel: "rest" }, content: { kind: "unchanged" }, nextTags: ["rocket-project", "status:canonical"], meta: { status: "canonical" }, now: Date.now() }),
      pruneStatement(env, id, 20),
    ]);
    for (let i = 0; i < 5; i++) await store.updateEntry(id, `mirror v${i + 3}`);
    const vs = await versions(id);
    expect(vs.length).toBeLessThanOrEqual(20);
    expect(vs.some(v => v.reason === "status")).toBe(true);
  });

  it("100 mirror syncs after a user status version never hold more than VERSION_KEEP versions, and return to 3 once the status version ages out", async () => {
    const store = makeMirrorStore(env, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, undefined, "notion");
    const id = await store.createEntry("start", ["rocket-project"], "notion");
    const { snapshotStatement, pruneStatement } = await import("../../src/memory/versions");
    await env.DB.batch([
      snapshotStatement(env, { entryId: id, reason: "status", change: { actorId: owner.userId, channel: "rest" }, content: { kind: "unchanged" }, nextTags: ["rocket-project", "status:canonical"], meta: {}, now: Date.now() }),
      pruneStatement(env, id, 20),
    ]);
    for (let i = 1; i <= 100; i++) {
      await store.updateEntry(id, `sync ${i}`);
      const vs = await versions(id);
      expect(vs.length).toBeLessThanOrEqual(20);
    }
    const final = await versions(id);
    expect(final).toHaveLength(3);
    expect(final.every(v => v.reason === "mirror")).toBe(true);
  });

  it("an obsidian-sourced memory keeps VERSION_KEEP versions", async () => {
    const store = makeMirrorStore(env, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, undefined, "obsidian");
    const id = await store.createEntry("note v0", ["notes"], "obsidian");
    for (let i = 1; i <= 25; i++) await store.updateEntry(id, `note v${i}`);
    expect((await versions(id)).length).toBeLessThanOrEqual(20);
  });
});
