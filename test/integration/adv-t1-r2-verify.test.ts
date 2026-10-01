import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { moveEntry } from "../../src/capture/share";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
let companyWs = "";
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  companyWs = roots.companyWorkspaceId;
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
});
afterEach(() => sqlite.close());

const seed = (id: string, over: Record<string, unknown> = {}) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, when_at, when_kind, when_label, when_source)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(
  id, over.content ?? "Some fact", JSON.stringify(over.tags ?? []), over.source ?? "api", over.createdAt ?? 1000, over.updatedAt ?? null,
  JSON.stringify(over.vectorIds ?? [id]), over.workspaceId ?? owner.personalWorkspaceId, over.actorId ?? owner.userId,
  over.whenAt ?? null, over.whenKind ?? null, over.whenLabel ?? null, over.whenSource ?? null,
).run();
const versions = async (id: string) => (await env.DB.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const live = async (id: string) => (await sqlite.db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;

async function member(name: string, role: "admin" | "member" = "member"): Promise<Identity> {
  const { token } = await createMember(env, { name, role });
  return (await resolveIdentityFromToken(token, env))!;
}

describe("R2-1: short append does not stamp prior_length_utf16 from a stale read", () => {
  it("two concurrent short appends: every version reconstructs to the exact prior text", async () => {
    const { appendToEntry } = await import("../../src/capture/store");
    const { loadHistory } = await import("../../src/memory/versions");
    const { DEFAULTS } = await import("../../src/config");
    await seed("p1", { content: "Base 😀 text", vectorIds: ["p1"] });
    const wctx = { workspaceId: owner.personalWorkspaceId, actorId: owner.userId };
    const change = { actorId: owner.userId, channel: "rest" as const };
    let raced = false;
    const raw = env.DB as any;
    const racing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      const st = raw.prepare(sql);
      if (!sql.startsWith("SELECT content, tags, source, created_at, vector_ids, workspace_id, pending_append_passages FROM entries")) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => {
        const r = await st.bind(...a).first();
        if (!raced) { raced = true; await appendToEntry(env, "p1", "", "B 🎉 addition", [], "api", DEFAULTS, undefined, wctx, change, undefined, owner.personalWorkspaceId); }
        return r;
      } }) };
    } } } as unknown as Env;
    await appendToEntry(racing, "p1", "", "A addition", [], "api", DEFAULTS, undefined, wctx, change, undefined, owner.personalWorkspaceId);
    expect(raced).toBe(true);

    const row = await live("p1");
    const vs = await versions("p1");
    expect(vs).toHaveLength(2);
    const chain = await loadHistory(env, undefined, { id: "p1", content: row.content }, 20);
    const afterB = row.content.slice(0, row.content.indexOf("\n\n[Update", row.content.indexOf("B 🎉 addition")));
    expect(chain.text(1)).toBe("Base 😀 text");
    expect(chain.text(2)).toBe(afterB);
  });

  it("undoing the second append keeps the first append's text", async () => {
    const { appendToEntry } = await import("../../src/capture/store");
    const { revertEntry } = await import("../../src/memory/undo");
    const { DEFAULTS } = await import("../../src/config");
    await seed("p2", { content: "Base 😀 text", vectorIds: ["p2"] });
    const wctx = { workspaceId: owner.personalWorkspaceId, actorId: owner.userId };
    const change = { actorId: owner.userId, channel: "rest" as const };
    let raced = false;
    const raw = env.DB as any;
    const racing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      const st = raw.prepare(sql);
      if (!sql.startsWith("SELECT content, tags, source, created_at, vector_ids, workspace_id, pending_append_passages FROM entries")) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => {
        const r = await st.bind(...a).first();
        if (!raced) { raced = true; await appendToEntry(env, "p2", "", "B 🎉 addition", [], "api", DEFAULTS, undefined, wctx, change, undefined, owner.personalWorkspaceId); }
        return r;
      } }) };
    } } } as unknown as Env;
    await appendToEntry(racing, "p2", "", "A addition", [], "api", DEFAULTS, undefined, wctx, change, undefined, owner.personalWorkspaceId);
    expect(raced).toBe(true);
    const undo = await revertEntry(env, owner, "p2", change, DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(undo.status).toBe("reverted");
    const after = (await live("p2")).content as string;
    expect(after).not.toContain("A addition");
    expect(after).toContain("B 🎉 addition");
  });
});

describe("R2-2: a lost update does not delete the row's own live vector", () => {
  it("after an unshare mid-edit, the author's memory still has the vector its vector_ids names", async () => {
    const { updateEntryContent } = await import("../../src/capture/store");
    const { DEFAULTS } = await import("../../src/config");
    const admin = await member("Ada", "admin");
    const author = await member("Bob");
    const store = new Map<string, any>();
    const vec = makeVectorizeMock({
      upsert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" } as any; }),
      insert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" } as any; }),
      deleteByIds: vi.fn(async (ids: string[]) => { for (const i of ids) store.delete(i); return { mutationId: "m" } as any; }),
    });
    const e = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: vec,
      AI: { run: vi.fn(async () => ({ data: [new Array(768).fill(0.1)] })) } as any })) as Env;
    await seed("v1", { content: "Bob's company note", workspaceId: companyWs, actorId: author.userId, vectorIds: ["v1"] });
    store.set("v1", { id: "v1", values: [0.1], metadata: { content: "Bob's company note", parentId: "v1" } });
    const raw = e.DB as any;
    let moved = false;
    const racing = { ...e, DB: { ...raw, prepare(sql: string) {
      if (!moved && sql.startsWith("INSERT INTO entry_versions")) {
        moved = true;
        raw.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'v1'`).bind(author.personalWorkspaceId).run();
      }
      return raw.prepare(sql);
    } } } as unknown as Env;
    const r = await updateEntryContent(racing, "v1", "admin rewrite", DEFAULTS, undefined, undefined,
      { workspaceId: companyWs, actorId: admin.userId }, { actorId: admin.userId, channel: "rest" }, companyWs);
    expect(r.status).not.toBe("updated");
    const row = await live("v1");
    expect(row.content).toBe("Bob's company note");
    for (const vid of JSON.parse(row.vector_ids) as string[]) {
      expect(store.get(vid)?.metadata?.content, vid).toBe("Bob's company note");
    }
  });
});

describe("R2-3: the writer's guard pins to the caller's authorization, not its own later read", () => {
  async function racingRouteRead(moveTo: string, id: string): Promise<Env> {
    const raw = env.DB as any;
    let moved = false;
    return { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      const st = raw.prepare(sql);
      if (moved || !/^SELECT id, workspace_id, actor_id, (content, tags, )?source FROM entries WHERE id = \? AND/.test(sql)) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => {
        const r = await st.bind(...a).first();
        moved = true;
        await sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(moveTo, id).run();
        return r;
      } }) };
    } } } as unknown as Env;
  }

  it("REST /update by an admin", async () => {
    const worker = (await import("../../src/index")).default;
    const { req } = await import("../helpers/make-request");
    const adminTok = (await createMember(env, { name: "Ada", role: "admin" })).token;
    const author = await member("Bob");
    await seed("w1", { content: "Bob's company note", workspaceId: companyWs, actorId: author.userId });
    const res = await worker.fetch(req("POST", "/update", { body: { id: "w1", content: "admin rewrite" }, token: adminTok }), await racingRouteRead(author.personalWorkspaceId, "w1"), ctx);
    const row = await live("w1");
    expect(row.workspace_id).toBe(author.personalWorkspaceId);
    expect(row.content).toBe("Bob's company note");
    expect(res.status).not.toBe(200);
  });

  it("REST /append by an admin", async () => {
    const worker = (await import("../../src/index")).default;
    const { req } = await import("../helpers/make-request");
    const adminTok = (await createMember(env, { name: "Ada", role: "admin" })).token;
    const author = await member("Bob");
    await seed("w2", { content: "Bob's company note", workspaceId: companyWs, actorId: author.userId });
    await worker.fetch(req("POST", "/append", { body: { id: "w2", addition: "admin addition" }, token: adminTok }), await racingRouteRead(author.personalWorkspaceId, "w2"), ctx);
    expect((await live("w2")).content).toBe("Bob's company note");
  });

  it("REST /forget by an admin does not trash a row that moved out of the caller's scope", async () => {
    const worker = (await import("../../src/index")).default;
    const { req } = await import("../helpers/make-request");
    const adminTok = (await createMember(env, { name: "Ada", role: "admin" })).token;
    const author = await member("Bob");
    await seed("w3", { content: "Bob's company note", workspaceId: companyWs, actorId: author.userId });
    const raw = env.DB as any;
    let moved = false;
    const racing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      const st = raw.prepare(sql);
      if (moved || !/^SELECT id, workspace_id, actor_id FROM entries WHERE id = \? AND/.test(sql)) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => {
        const r = await st.bind(...a).first();
        moved = true;
        await sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'w3'`).bind(author.personalWorkspaceId).run();
        return r;
      } }) };
    } } } as unknown as Env;
    await worker.fetch(req("POST", "/forget", { body: { id: "w3" }, token: adminTok }), racing, ctx);
    const row = await live("w3");
    expect(row).not.toBeNull();
    expect(row.workspace_id).toBe(author.personalWorkspaceId);
  });
});

describe("R2-4: legacy authorship belongs only to the tenant owner", () => {
  it("an admin who unshared the owner's legacy memory does not see its pre-share events", async () => {
    const worker = (await import("../../src/index")).default;
    const { req } = await import("../helpers/make-request");
    const adminTok = (await createMember(env, { name: "Ada", role: "admin" })).token;
    const admin = (await resolveIdentityFromToken(adminTok, env))!;
    await seed("L2", { content: "owner legacy memory", actorId: "", workspaceId: companyWs });
    const ev = (event: string, at: number, payload: Record<string, unknown>) => env.DB.prepare(
      `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, 'L2', ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), owner.userId, event, JSON.stringify(payload), at).run();
    await ev("status_changed", 1000, { status: "canonical", prior: { tags: ["private-owner-tag"] } });
    await ev("shared", 2000, { workspaceId: companyWs, fromWorkspaceId: owner.personalWorkspaceId, channel: "rest" });
    const moved = await moveEntry("L2", "personal", env, admin, { actorId: admin.userId, channel: "rest" });
    expect(moved.status).toBe("unshared");
    expect((await live("L2")).workspace_id).toBe(admin.personalWorkspaceId);
    const res = await worker.fetch(req("POST", "/entry?id=L2", { token: adminTok }), env, ctx);
    const body = await res.json() as any;
    expect((body.entry ?? body).timeline.map((e: any) => e.event)).not.toContain("status_changed");
  });
});

describe("R2-5: a legitimate share mid-edit answers 409, not 404", () => {
  it("REST /update answers 409 (changed while saving), not 404, when the author's own share lands mid-embed", async () => {
    const worker = (await import("../../src/index")).default;
    const { req } = await import("../helpers/make-request");
    await seed("m1", { content: "my note" });
    const raw = env.DB as any;
    let moved = false;
    const racing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      if (!moved && sql.startsWith("INSERT INTO entry_versions")) {
        moved = true;
        raw.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'm1'`).bind(companyWs).run();
      }
      return raw.prepare(sql);
    } } } as unknown as Env;
    const res = await worker.fetch(req("POST", "/update", { body: { id: "m1", content: "my edited note" } }), racing, ctx);
    expect(res.status).toBe(409);
  });
});

describe("R2-6: version created_at is monotonic in seq", () => {
  it("created_at never decreases with seq, and updated_at never regresses", async () => {
    const { appendToEntry } = await import("../../src/capture/store");
    const { DEFAULTS } = await import("../../src/config");
    await seed("n1", { content: "base", vectorIds: ["n1"] });
    const wctx = { workspaceId: owner.personalWorkspaceId, actorId: owner.userId };
    const change = { actorId: owner.userId, channel: "rest" as const };
    const raw = env.DB as any;
    let raced = false;
    const slowBatch = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare: raw.prepare.bind(raw), batch: async (stmts: unknown[]) => {
      if (!raced) { raced = true; await new Promise(r => setTimeout(r, 5)); await appendToEntry(env, "n1", "", "other isolate", [], "api", DEFAULTS, undefined, wctx, change, undefined, owner.personalWorkspaceId); }
      return raw.batch(stmts);
    } } } as unknown as Env;
    await appendToEntry(slowBatch, "n1", "", "this one", [], "api", DEFAULTS, undefined, wctx, change, undefined, owner.personalWorkspaceId);
    const vs = await versions("n1");
    expect(vs).toHaveLength(2);
    expect(vs[1].created_at).toBeGreaterThanOrEqual(vs[0].created_at);
    expect((await live("n1")).updated_at).toBeGreaterThanOrEqual(vs[1].created_at);
  });
});

describe("R2-7: revertEntry writes into the author's personal memory after an unshare", () => {
  it("an admin's undo on Bob's company memory does not land after Bob unshares it", async () => {
    const { revertEntry } = await import("../../src/memory/undo");
    const { DEFAULTS } = await import("../../src/config");
    const { updateEntryContent } = await import("../../src/capture/store");
    const admin = await member("Ada", "admin");
    const author = await member("Bob");
    await seed("u9", { content: "v1 text", workspaceId: companyWs, actorId: author.userId });
    const r = await updateEntryContent(env, "u9", "v2 text", DEFAULTS, undefined, undefined, { workspaceId: companyWs, actorId: author.userId }, { actorId: author.userId, channel: "rest" }, companyWs);
    expect(r.status).toBe("updated");
    const raw = env.DB as any;
    let moved = false;
    const racing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      if (!moved && sql.startsWith("INSERT INTO entry_versions")) {
        moved = true;
        raw.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'u9'`).bind(author.personalWorkspaceId).run();
      }
      return raw.prepare(sql);
    } } } as unknown as Env;
    await revertEntry(racing, admin, "u9", { actorId: admin.userId, channel: "rest" }, DEFAULTS, undefined, companyWs);
    const row = await live("u9");
    expect(row.workspace_id).toBe(author.personalWorkspaceId);
    expect(row.content).toBe("v2 text");
  });
});

describe("R3-2: an admin's unshare can take a member's already-private memory", () => {
  it("REST /share personal by an admin does not move a row Bob already made private", async () => {
    const worker = (await import("../../src/index")).default;
    const { req } = await import("../helpers/make-request");
    const adminTok = (await createMember(env, { name: "Ada", role: "admin" })).token;
    const admin = (await resolveIdentityFromToken(adminTok, env))!;
    const author = await member("Bob");
    await seed("x2", { content: "Bob's note", workspaceId: companyWs, actorId: author.userId });
    const raw = env.DB as any;
    let fired = false;
    const racing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      const st = raw.prepare(sql);
      if (fired || !/^SELECT id, workspace_id, actor_id, vector_ids, tags FROM entries WHERE id = \? AND/.test(sql)) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => {
        const r = await st.bind(...a).first();
        fired = true;
        await sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'x2'`).bind(author.personalWorkspaceId).run();
        return r;
      } }) };
    } } } as unknown as Env;
    const res = await worker.fetch(req("POST", "/share", { body: { id: "x2", workspace: "personal" }, token: adminTok }), racing, ctx);
    const row = await live("x2");
    expect(row.workspace_id).not.toBe(admin.personalWorkspaceId);
    expect(row.workspace_id).toBe(author.personalWorkspaceId);
    expect(res.status).toBe(409);
  });
});

describe("R3-4: the owner does not inherit a member's private history of a system row they unshare", () => {
  it("GET /entry by the owner does not show Bob's private-era events on Bob's digest", async () => {
    const worker = (await import("../../src/index")).default;
    const { req } = await import("../helpers/make-request");
    const bob = await member("Bob");
    await seed("dg1", { content: "Digest of Bob's health notes", tags: ["synthesized", "digest"], source: "system", actorId: "", workspaceId: bob.personalWorkspaceId });
    const ev = (event: string, actor: string, at: number, payload: Record<string, unknown>) => env.DB.prepare(
      `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, 'dg1', ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), actor, event, JSON.stringify(payload), at).run();
    await ev("status_changed", bob.userId, 1000, { status: "draft", prior: { tags: ["private-health-tag"] }, channel: "rest" }); // Bob's private era
    const shared = await moveEntry("dg1", "company", env, bob, { actorId: bob.userId, channel: "rest" });
    expect(shared.status).toBe("shared");
    const back = await moveEntry("dg1", "personal", env, owner, { actorId: owner.userId, channel: "rest" });
    expect(back.status).toBe("unshared");
    expect((await live("dg1")).workspace_id).toBe(owner.personalWorkspaceId);
    const res = await worker.fetch(req("POST", "/entry?id=dg1"), env, ctx); // default token = the owner
    const body = await res.json() as any;
    expect((body.entry ?? body).timeline.map((e: any) => e.event)).not.toContain("status_changed");
  });
});

describe("R3-3: restoreRowVectors does not orphan the chunks of the appends that beat the update", () => {
  it("an update that loses three times to short appends leaves every indexed vector listed in vector_ids", async () => {
    const { appendToEntry, updateEntryContent } = await import("../../src/capture/store");
    const { DEFAULTS } = await import("../../src/config");
    const store = new Map<string, any>();
    const vec = makeVectorizeMock({
      upsert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" } as any; }),
      insert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" } as any; }),
      deleteByIds: vi.fn(async (ids: string[]) => { for (const i of ids) store.delete(i); return { mutationId: "m" } as any; }),
    });
    const e = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: vec,
      AI: { run: vi.fn(async () => ({ data: [new Array(768).fill(0.1)] })) } as any })) as Env;
    const ws = owner.personalWorkspaceId;
    const wctx = { workspaceId: ws, actorId: owner.userId };
    const change = { actorId: owner.userId, channel: "rest" as const };
    await seed("e3", { content: "base", vectorIds: ["e3"] });
    store.set("e3", { id: "e3", values: [0.1], metadata: { content: "base", parentId: "e3" } });
    let n = 0;
    const raw = e.DB as any;
    const racing = { ...e, DB: { ...raw, prepare(sql: string) {
      const st = raw.prepare(sql);
      if (!sql.startsWith("SELECT content, tags, source, vector_ids, workspace_id FROM entries")) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => {
        const r = await st.bind(...a).first();
        if (n++ < 3) { await new Promise(res => setTimeout(res, 2)); await appendToEntry(e, "e3", "", `addition ${n}`, [], "api", DEFAULTS, undefined, wctx, change, undefined, ws); }
        return r;
      } }) };
    } } } as unknown as Env;
    const r = await updateEntryContent(racing, "e3", "rewritten", DEFAULTS, undefined, undefined, wctx, change, ws);
    expect(r.status).toBe("conflict");
    const listed = new Set(JSON.parse((await live("e3")).vector_ids) as string[]);
    const unlisted = [...store.keys()].filter(k => (k === "e3" || k.startsWith("e3-")) && !listed.has(k));
    expect(unlisted).toEqual([]);
  });
});
