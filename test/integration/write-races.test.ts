import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeAIMock, makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityFromToken } from "../../src/lib/identity";
import { appendToEntry, updateEntryContent } from "../../src/capture/store";
import { captureEntry } from "../../src/capture/entry";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const change = { actorId: "u1", channel: "rest" as const };

let d1: SqliteD1;
let env: Env;
let wsId = "";
let ownerId = "";
let store: Map<string, any>;
let upsertOrder: string[] = [];
let deleted: string[] = [];

function statefulVectorize() {
  store = new Map();
  upsertOrder = [];
  return makeVectorizeMock({
    upsert: vi.fn(async (vs: any[]) => { for (const v of vs) { store.set(v.id, v); upsertOrder.push(`${v.id}:${v.metadata.content}`); } return { mutationId: "m" } as any; }),
    insert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" } as any; }),
    deleteByIds: vi.fn(async (ids: string[]) => { deleted.push(...ids); for (const i of ids) store.delete(i); return { mutationId: "m" } as any; }),
  });
}

beforeEach(async () => {
  resetDatabaseInit();
  deleted = [];
  d1 = makeSqliteD1();
  env = d1.admitEnv(makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), VECTORIZE: statefulVectorize(), AI: makeAIMock() }));
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  wsId = roots.ownerPersonalWorkspaceId;
  ownerId = roots.ownerUserId;
});
afterEach(() => d1.close());

const seed = (id: string, content: string, tags: string[] = []) => d1.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'claude', 1000, NULL, '[]', ?, ?)`,
).bind(id, content, JSON.stringify(tags), wsId, ownerId).run();
const live = async (id: string) => (await d1.db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;
const versions = async (id: string) => (await d1.db.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];

/** Runs `mutate` right after the Nth read of the update's own row (SELECT content, tags, source...). */
function racingEnv(mutate: () => Promise<void>, atRead: number | "every" = 1): Env {
  let n = 0;
  const raw = env.DB as any;
  const DB = {
    ...raw,
    prepare(sql: string) {
      const st = raw.prepare(sql);
      if (!sql.startsWith("SELECT content, tags, source, ")) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => { n++; const r = await st.bind(...a).first(); if (atRead === "every" || n === atRead) await mutate(); return r; } }) };
    },
  };
  return { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB } as unknown as Env;
}

describe("write races: re-embed ordering (T-0089.10)", () => {
  it("an update whose read is overtaken by a system merge retries and ends with the update's content and vectors from that content", async () => {
    await seed("e1", "one", []);
    // Writer B (a system merge) commits its own content and vectors right after writer A's read.
    const racing = racingEnv(async () => {
      await d1.db.prepare(`UPDATE entries SET content = 'system merged text' WHERE id = 'e1'`).run();
      await env.VECTORIZE.upsert([{ id: "e1", values: [0.2], metadata: { content: "system merged text" } }]);
    });
    const r = await updateEntryContent(racing, "e1", "my edit", DEFAULTS, undefined, undefined, { workspaceId: wsId, actorId: ownerId }, change, wsId);
    expect(r.status).toBe("updated");
    expect((await live("e1")).content).toBe("my edit");
    // The last vector upsert describes the committed content: "my edit" wins in the index too.
    const last = upsertOrder[upsertOrder.length - 1];
    expect(last).toContain("my edit");
    expect(await versions("e1")).toHaveLength(1);
  });

  it("an update that loses 3 compare-and-set attempts returns conflict and leaves none of its own uploads behind", async () => {
    await seed("e1", "base", []);
    let n = 0;
    const racing = racingEnv(async () => {
      await d1.db.prepare(`UPDATE entries SET content = ? WHERE id = 'e1'`).bind(`racing ${++n}`).run();
    }, "every");
    const r = await updateEntryContent(racing, "e1", "my edit", DEFAULTS, undefined, undefined, { workspaceId: wsId, actorId: ownerId }, change, wsId);
    expect(r).toEqual({ status: "conflict" });
    expect(await versions("e1")).toEqual([]);
    const row = await live("e1");
    expect(row.content).not.toBe("my edit");
    // Per-upload vector ids (T-0089.1.1): each lost attempt deletes only its own upload, never a vector
    // the row lists, so none of "my edit" survives and the row still lists what it did.
    expect([...store.values()].map(v => v.metadata.content)).not.toContain("my edit");
    expect(row.vector_ids).toBe("[]");
  });

  it("a tags-only concurrent change makes the update retry without re-embedding", async () => {
    await seed("e1", "same text", ["a"]);
    let embeds = 0;
    const countingAI = { run: vi.fn(async (model: string, opts: any) => {
      if (model === "@cf/google/embeddinggemma-300m") { embeds++; return { data: [new Array(768).fill(0.1)] }; }
      return new ReadableStream({ start(c) { c.close(); } });
    }) } as unknown as Ai;
    const countingEnv = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, AI: countingAI } as unknown as Env;
    const racing = { ...racingEnv(async () => {
      await d1.db.prepare(`UPDATE entries SET tags = '["a","b"]' WHERE id = 'e1'`).run();
    }), AI: countingAI } as unknown as Env;
    const r = await updateEntryContent(racing, "e1", "same text", DEFAULTS, undefined, undefined, { workspaceId: wsId, actorId: ownerId }, change, wsId);
    expect(r.status).toBe("updated");
    expect(embeds).toBe(1); // one embed total, not one per attempt
    expect(JSON.parse((await live("e1")).tags)).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("a person's merge that loses to a concurrent edit keeps both rows, leaves the target's vectors alone, and deletes its own upload", async () => {
    // captureEntry's own duplicate-and-merge path already tests this fully (versioning-capture-status.test.ts);
    // this asserts the vector restoration specifically.
    const decision = JSON.stringify({ action: "merge", target_id: "old", merged_content: "combined" });
    const stream = (text: string) => new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
    } });
    const raceEnv = d1.admitEnv(makeTestEnv(undefined, {
      DB: d1.db as any, OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [{ id: "old", score: 0.9, metadata: { parentId: "old" } }] }),
        upsert: vi.fn(async (vs: any[]): Promise<any> => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" }; }),
        deleteByIds: vi.fn(async (ids: string[]): Promise<any> => { deleted.push(...ids); return { mutationId: "m" }; }),
      }),
      AI: { run: vi.fn(async (model: string) => model === "@cf/google/embeddinggemma-300m" ? { data: [new Array(768).fill(0.1)] } : stream(decision)) } as any,
    })) as Env;
    await d1.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES ('old', 'original', '["rocket-project"]', 'api', 1000, NULL, '["old"]', '', 'u1')`,
    ).run();
    const db = raceEnv.DB as any;
    const prepare = db.prepare.bind(db);
    let raced = false;
    db.prepare = (sql: string) => {
      if (!raced && sql.startsWith("INSERT INTO entry_versions")) {
        raced = true;
        prepare(`UPDATE entries SET content = 'concurrent edit', tags = '["rocket-project","user-edited"]' WHERE id = 'old'`).run();
      }
      return prepare(sql);
    };
    const r = await captureEntry("my incoming fact", [], "api", raceEnv, ctx, undefined, { workspaceId: "", actorId: "u2" }, undefined, { channel: "rest" });
    expect(r.status).not.toBe("merged");
    const row = await live("old");
    expect(row.content).toBe("concurrent edit");
    // The target still lists what it listed (the concurrent edit's own writer owns its re-index), and
    // the merge's upload (per-upload ids, T-0089.1.1) was deleted rather than left under the target.
    expect(row.vector_ids).toBe('["old"]');
    const mergeUpload = [...store.values()].filter(v => v.metadata.parentId === "old" && v.metadata.content === "combined").map(v => v.id);
    expect(mergeUpload.length).toBeGreaterThan(0);
    for (const id of mergeUpload) expect(deleted).toContain(id);
    expect(deleted).not.toContain("old");
  });

  it("ADV-2: a person's merge does not land in a member's now-private workspace after an unshare", async () => {
    const decision = JSON.stringify({ action: "merge", target_id: "t1", merged_content: "combined text" });
    const stream = (text: string) => new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
    } });
    const roots = await ensureTenantBootstrap(env);
    const bob = (await resolveIdentityFromToken((await createMember(env, { name: "Bob" })).token, env))!;
    await seed("t1", "Team fact about the launch plan", ["rocket-project"]);
    await d1.db.prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 't1'`).bind(roots.companyWorkspaceId, bob.userId).run();
    const raceEnv = d1.admitEnv(makeTestEnv(undefined, {
      DB: d1.db as any, OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [{ id: "t1", score: 0.9, metadata: { parentId: "t1" } }] }),
        upsert: vi.fn(async (): Promise<any> => ({ mutationId: "m" })),
        deleteByIds: vi.fn(async (): Promise<any> => ({ mutationId: "m" })),
      }),
      AI: { run: vi.fn(async (model: string) => model === "@cf/google/embeddinggemma-300m" ? { data: [new Array(768).fill(0.1)] } : stream(decision)) } as any,
    })) as Env;
    const db = raceEnv.DB as any;
    const prepare = db.prepare.bind(db);
    let raced = false;
    db.prepare = (sql: string) => {
      // Bob unshares his own memory while the merge's re-embed is still in flight.
      if (!raced && sql.startsWith("INSERT INTO entry_versions")) {
        raced = true;
        prepare(`UPDATE entries SET workspace_id = ? WHERE id = 't1'`).bind(bob.personalWorkspaceId).run();
      }
      return prepare(sql);
    };
    await captureEntry("Alice's private note about the launch", [], "api", raceEnv, ctx, undefined,
      { workspaceId: roots.companyWorkspaceId, actorId: "alice" }, undefined, { channel: "rest" });
    const t1 = await live("t1");
    expect(t1.workspace_id).toBe(bob.personalWorkspaceId);
    // The merge missed its CAS (workspace changed) and kept both: Alice's text never landed in Bob's private row.
    expect(t1.content).toBe("Team fact about the launch plan");
    expect((await versions("t1")).filter((v: any) => v.actor_id === "alice")).toEqual([]);
  });

  it("ADV-4: a long append that loses to an update and then commits short leaves no replaced text in the row's vectors", async () => {
    const secret = "SECRET-PLAN ".repeat(140); // ~1,680 chars: any append goes down the long branch
    await seed("e3", secret);
    let n = 0;
    const raw = env.DB as any;
    const racing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      const st = raw.prepare(sql);
      if (!sql.startsWith("SELECT content, tags, source, ")) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => {
        const r = await st.bind(...a).first();
        // The author replaces the text (removing SECRET-PLAN) right after the append read the row.
        if (++n === 1) {
          const r2 = await updateEntryContent(env, "e3", "short public text", DEFAULTS, undefined, undefined,
            { workspaceId: wsId, actorId: ownerId }, { actorId: ownerId, channel: "rest" }, wsId);
          expect(r2.status).toBe("updated");
        }
        return r;
      } }) };
    } } } as unknown as Env;
    await appendToEntry(racing, "e3", "", "an addition", [], "claude", DEFAULTS, undefined,
      { workspaceId: wsId, actorId: ownerId }, { actorId: ownerId, channel: "rest" }, undefined, wsId);
    const finalRow = await live("e3");
    expect(finalRow.content).toContain("short public text");
    expect(finalRow.content).toContain("an addition");
    const described = (JSON.parse(finalRow.vector_ids) as string[]).map(vid => String(store.get(vid)?.metadata?.content ?? ""));
    expect(described.some(t => t.includes("SECRET-PLAN"))).toBe(false);
  });

  it("ADV-7: a forget during a long append's embed leaves no vector of the forgotten text behind", async () => {
    await seed("g1", "PRIVATE MEDICAL NOTE ".repeat(80));
    const raw = env.DB as any;
    let forgot = false;
    // The user forgets the memory while the append is embedding: its DELETE lands inside the append's
    // own batch, right before the guarded UPDATE, so the CAS misses because the row is gone.
    const racing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      if (!forgot && sql.startsWith("INSERT INTO entry_versions")) { forgot = true; void d1.deleteFixtureRows(`DELETE FROM entries WHERE id = 'g1'`); }
      return raw.prepare(sql);
    } } } as unknown as Env;
    await expect(appendToEntry(racing, "g1", "", "more", [], "claude", DEFAULTS, undefined,
      { workspaceId: wsId, actorId: ownerId }, { actorId: ownerId, channel: "rest" }, undefined, wsId)).rejects.toThrow();
    expect(await live("g1")).toBeNull();
    expect([...store.values()].filter(v => v.metadata?.parentId === "g1")).toEqual([]);
  });

  it("ADV-12: a slow append's version and updated_at never land earlier than the commit it followed", async () => {
    await seed("o1", "base");
    const wctx = { workspaceId: wsId, actorId: ownerId };
    const appendChange = { actorId: ownerId, channel: "rest" as const };
    const plain = d1.admitEnv(makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), VECTORIZE: statefulVectorize(), AI: makeAIMock() }));
    let raced = false;
    // Another client's append commits fully while this one is still embedding its own chunk.
    const slowVectorize = makeVectorizeMock({
      insert: vi.fn(async (vs: any[]) => {
        if (!raced) { raced = true; await new Promise(r => setTimeout(r, 5)); await appendToEntry(plain, "o1", "", "fast one", [], "claude", DEFAULTS, undefined, wctx, appendChange, undefined, wsId); }
        for (const v of vs) store.set(v.id, v);
        return { mutationId: "m" } as any;
      }),
    });
    const slow = d1.admitEnv(makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), VECTORIZE: slowVectorize, AI: makeAIMock() }));
    await appendToEntry(slow, "o1", "", "slow one", [], "claude", DEFAULTS, undefined, wctx, appendChange, undefined, wsId);
    const vs = await versions("o1");
    expect(vs.map((v: any) => v.seq)).toEqual([1, 2]);
    const row = await live("o1");
    expect(row.content).toContain("fast one");
    expect(row.content).toContain("slow one");
    expect(vs[1].created_at).toBeGreaterThanOrEqual(vs[0].created_at);
    expect(vs[1].valid_from).toBeLessThanOrEqual(vs[1].created_at);
    expect(row.updated_at).toBeGreaterThanOrEqual(vs[0].created_at);
  });

  it("a lost attempt writes no version", async () => {
    await seed("e1", "base", []);
    let n = 0;
    const racing = racingEnv(async () => { await d1.db.prepare(`UPDATE entries SET content = ? WHERE id = 'e1'`).bind(`race${++n}`).run(); });
    await updateEntryContent(racing, "e1", "final edit", DEFAULTS, undefined, undefined, { workspaceId: wsId, actorId: ownerId }, change, wsId);
    // Only the successful commit (if any) writes a version.
    const vs = await versions("e1");
    expect(vs.length).toBeLessThanOrEqual(1);
  });

  it("an update whose re-embed fails after losing a race reports reembed_failed and writes nothing", async () => {
    await seed("e1", "base", []);
    let n = 0;
    const racing = racingEnv(async () => { await d1.db.prepare(`UPDATE entries SET content = ? WHERE id = 'e1'`).bind(`race${++n}`).run(); });
    const failingAI = { run: vi.fn(async () => { throw new Error("AI down"); }) } as unknown as Ai;
    const r = await updateEntryContent({ ...racing, AI: failingAI } as unknown as Env, "e1", "final edit", DEFAULTS, undefined, undefined, { workspaceId: wsId, actorId: ownerId }, change, wsId);
    expect(r.status).toBe("reembed_failed");
  });
});

describe("write races: stale classify tags (T-0089.10)", () => {
  it("/classify-pending skips a row whose tags changed after its read, and counts it skipped", async () => {
    await seed("e1", "unclassified content", []);
    const stream = (text: string) => new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
    } });
    const classifyingEnv = d1.admitEnv(makeTestEnv(undefined, {
      DB: d1.db as any, OAUTH_KV: makeMemoryKV(), VECTORIZE: statefulVectorize(),
      AI: { run: vi.fn(async (model: string) => model === "@cf/google/embeddinggemma-300m"
        ? { data: [new Array(768).fill(0.1)] }
        : stream(JSON.stringify({ importance: 3, canonical: true, kind: "semantic" }))) } as any,
    })) as Env;
    const db = classifyingEnv.DB as any;
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (sql.startsWith("SELECT id, content, tags, workspace_id FROM entries")) {
        // A status change lands between the SELECT list and the classifier's UPDATE.
        const st = prepare(sql);
        return { all: async () => { const r = await st.all(); d1.db.prepare(`UPDATE entries SET tags = '["status:draft"]' WHERE id = 'e1'`).run(); return r; } };
      }
      return prepare(sql);
    };
    const res = await worker.fetch(req("POST", "/classify-pending"), classifyingEnv, ctx);
    const body = await res.json() as any;
    expect(body.failed).toBe(1);
    expect(body.processed).toBe(0);
    // The concurrent status change survived; classification did not overwrite it.
    expect(JSON.parse((await live("e1")).tags)).toEqual(["status:draft"]);
    // Unclassified, so still owed a retry.
    expect(body.remaining).toBe(0); // remaining also matches status:draft's tags NOT LIKE filter... see below
  });

  it("applyClassification never overwrites a status set after capture", async () => {
    const { classifyEntry } = await import("../../src/capture/classify");
    await seed("e1", "content", []);
    // Simulate: read tags, a concurrent write sets status:canonical, then classification commits kind: only.
    const readTags = (await live("e1")).tags;
    await d1.db.prepare(`UPDATE entries SET tags = '["status:canonical"]' WHERE id = 'e1'`).run();
    await d1.db.prepare(`UPDATE entries SET tags = ? WHERE id = ? AND tags = ?`).bind(JSON.stringify(["kind:semantic"]), "e1", readTags).run();
    // The CAS missed: status:canonical is untouched.
    expect(JSON.parse((await live("e1")).tags)).toEqual(["status:canonical"]);
  });
});
