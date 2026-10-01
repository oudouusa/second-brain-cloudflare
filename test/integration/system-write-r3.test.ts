import { describe, it, expect, vi } from "vitest";
import { captureEntry } from "../../src/capture/entry";
import { compressTag } from "../../src/compression/digest";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const stream = (text: string) => new ReadableStream({ start(c) {
  c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
  c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
}});

async function setup(score: number, decision: string) {
  resetDatabaseInit();
  const sqlite = makeSqliteD1();
  const vectors = new Map<string, any>();
  const env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as any,
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockResolvedValue({ matches: [{ id: "old", score, metadata: { parentId: "old" } }] }),
      upsert: vi.fn(async (rows: any[]): Promise<any> => { for (const row of rows) vectors.set(row.id, row.metadata); return { mutationId: "m" }; }),
    }),
    AI: { run: vi.fn(async (model: string) => model === "@cf/google/embeddinggemma-300m"
      ? { data: [new Array(768).fill(0.1)] } : stream(decision)) } as any,
  })) as Env;
  await initializeDatabase(env);
  sqlite.seed({ id: "old", content: "Old digest", tags: ["synthesized"], source: "system", createdAt: 1000 });
  return { sqlite, env, vectors };
}

// Reproductions from the cross-vendor review, now pinned as regression tests.
describe("system-write races", () => {
  it("a protected contradiction must not roll user sources into a draft digest", async () => {
    const { sqlite, env } = await setup(0.72, '{"contradicts":true,"conflicting_id":"old","reason":"different"}');
    sqlite.db.prepare(`UPDATE entries SET tags = '["rocket-project"]', source = 'api', actor_id = 'u1' WHERE id = 'old'`).run();
    for (let i = 0; i < 12; i++) sqlite.seed({ id: `work-${i}`, content: `User work fact ${i}`, tags: ["rocket-project"], source: "api", createdAt: 1000 + i });
    await compressTag("rocket-project", env, ctx);
    const digests = (await env.DB.prepare(`SELECT id, tags FROM entries WHERE source = 'system'`).all()).results as any[];
    const sources = (await env.DB.prepare(`SELECT id, tags, content FROM entries WHERE id LIKE 'work-%'`).all()).results as any[];
    expect(digests).toHaveLength(1);
    expect(JSON.parse(digests[0].tags)).toContain("status:draft");
    console.log("draft rollup:", digests[0], sources.filter(row => JSON.parse(row.tags).includes("rolled-up")).length);
    expect(sources.some(row => JSON.parse(row.tags).includes("rolled-up"))).toBe(false);
    sqlite.close();
  });

  it("user edit between conflict guard and deprecate must protect the row", async () => {
    const { sqlite, env } = await setup(0.72, '{"contradicts":true,"conflicting_id":"old","reason":"different"}');
    const db = env.DB as any; const prepare = db.prepare.bind(db); let raced = false;
    db.prepare = (sql: string) => {
      if (!raced && sql.startsWith("INSERT INTO entries (id, content")) {
        raced = true;
        sqlite.db.prepare(`UPDATE entries SET content = 'MY CORRECTION', tags = '["synthesized","user-edited"]' WHERE id = 'old'`).run();
      }
      return prepare(sql);
    };
    const result = await captureEntry("New conflicting digest", ["synthesized"], "system", env, ctx, undefined,
      { workspaceId: "", actorId: "" }, undefined, { systemWrite: "digest", channel: "system:digest" });
    const old = await env.DB.prepare("SELECT tags, content FROM entries WHERE id = 'old'").first() as any;
    expect(raced).toBe(true);
    console.log("contradiction race:", result.status, old);
    expect(result.status).toBe("contradiction_protected");
    expect(JSON.parse(old.tags)).not.toContain("status:deprecated");
    sqlite.close();
  });

  it("workspace move between read and CAS must prevent cross-workspace system merge", async () => {
    const { sqlite, env, vectors } = await setup(0.9, '{"action":"merge","target_id":"old","merged_content":"new system text"}');
    const db = env.DB as any; const prepare = db.prepare.bind(db); let raced = false;
    db.prepare = (sql: string) => {
      if (!raced && sql.startsWith("UPDATE entries AS e SET write_marker = ") && sql.includes(", content = ")) {
        raced = true;
        sqlite.db.prepare("UPDATE entries SET workspace_id = 'other-workspace' WHERE id = 'old'").run();
      }
      return prepare(sql);
    };
    const result = await captureEntry("New digest", ["synthesized"], "system", env, ctx, undefined,
      { workspaceId: "", actorId: "" }, undefined, { systemWrite: "digest", channel: "system:digest" });
    const old = await env.DB.prepare("SELECT workspace_id, content FROM entries WHERE id = 'old'").first() as any;
    expect(raced).toBe(true);
    expect(old.workspace_id).toBe("other-workspace");
    console.log("workspace race:", result.status, old, vectors.get("old"));
    expect(result.status).not.toBe("merged");
    expect(old.content).toBe("Old digest");
    // Per-upload vector ids (T-0089.1.1): the lost merge's own upload (stamped for the old workspace) is
    // deleted, and the row lists none of it.
    const oldRow = await env.DB.prepare("SELECT vector_ids FROM entries WHERE id = 'old'").first() as any;
    const mergeUpload = [...vectors.entries()].filter(([, m]) => m.parentId === "old" && String(m.content).includes("new system text")).map(([k]) => k);
    const deletedIds = (env.VECTORIZE.deleteByIds as any).mock.calls.flatMap((c: any) => c[0]);
    for (const id of mergeUpload) expect(deletedIds).toContain(id);
    expect((JSON.parse(oldRow.vector_ids) as string[]).some(id => mergeUpload.includes(id))).toBe(false);
    sqlite.close();
  });
  it("moving after scoped hydration but before merge snapshot must not cross workspaces", async () => {
    const { sqlite, env, vectors } = await setup(0.9, '{"action":"merge","target_id":"old","merged_content":"new system text"}');
    const db = env.DB as any; const prepare = db.prepare.bind(db); let raced = false;
    db.prepare = (sql: string) => {
      if (!raced && sql.startsWith("SELECT content, tags, source, vector_ids, importance_score, actor_id, workspace_id, ")) {
        raced = true;
        sqlite.db.prepare("UPDATE entries SET workspace_id = 'other-workspace' WHERE id = 'old'").run();
      }
      return prepare(sql);
    };
    const result = await captureEntry("New digest", ["synthesized"], "system", env, ctx, undefined,
      { workspaceId: "", actorId: "" }, undefined, { systemWrite: "digest", channel: "system:digest" });
    const old = await env.DB.prepare("SELECT workspace_id, content FROM entries WHERE id = 'old'").first() as any;
    console.log("early merge move", result.status, old, vectors.get("old"));
    expect(raced).toBe(true);
    expect(result.status).not.toBe("merged");
    expect(old.content).toBe("Old digest");
    sqlite.close();
  });

  it("moving after scoped hydration but before contradiction snapshot must not supersede across workspaces", async () => {
    const { sqlite, env } = await setup(0.72, '{"contradicts":true,"conflicting_id":"old","reason":"different"}');
    const db = env.DB as any; const prepare = db.prepare.bind(db); let raced = false;
    db.prepare = (sql: string) => {
      if (!raced && sql.startsWith("SELECT content, tags, source, actor_id, workspace_id, vector_ids, created_at")) {
        raced = true;
        sqlite.db.prepare("UPDATE entries SET workspace_id = 'other-workspace' WHERE id = 'old'").run();
      }
      return prepare(sql);
    };
    const result = await captureEntry("New conflicting digest", ["synthesized"], "system", env, ctx, undefined,
      { workspaceId: "", actorId: "" }, undefined, { systemWrite: "digest", channel: "system:digest" });
    const old = await env.DB.prepare("SELECT workspace_id, tags, valid_until FROM entries WHERE id = 'old'").first() as any;
    console.log("early contradiction move", result.status, old);
    expect(raced).toBe(true);
    expect(result.status).toBe("contradiction_protected");
    expect(JSON.parse(old.tags)).not.toContain("status:deprecated");
    expect(old.valid_until).toBeNull();
    sqlite.close();
  });

  it("lost conditional deprecation must index the fallback draft with its committed tags", async () => {
    const { sqlite, env, vectors } = await setup(0.72, '{"contradicts":true,"conflicting_id":"old","reason":"different"}');
    const pending: Promise<unknown>[] = [];
    const awaitCtx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
    const db = env.DB as any; const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (sql.startsWith("INSERT INTO entries (id, content")) {
        sqlite.db.prepare(`UPDATE entries SET content = 'MY CORRECTION', tags = '["synthesized","user-edited"]' WHERE id = 'old'`).run();
      }
      return prepare(sql);
    };
    sqlite.issued.length = 0;
    const result = await captureEntry("New conflicting digest", ["synthesized"], "system", env, awaitCtx, undefined,
      { workspaceId: "", actorId: "" }, undefined, { systemWrite: "digest", channel: "system:digest" });
    await Promise.allSettled(pending);
    console.log("conditional capture D1 calls", sqlite.issued.length);
    expect(result.status).toBe("contradiction_protected");
    if (result.status !== "contradiction_protected") return;
    const row = await env.DB.prepare("SELECT tags FROM entries WHERE id = ?").bind(result.id).first() as any;
    const old = await env.DB.prepare("SELECT contradiction_wins, contradiction_losses FROM entries WHERE id = 'old'").first() as any;
    const newcomer = await env.DB.prepare("SELECT contradiction_wins, contradiction_losses FROM entries WHERE id = ?").bind(result.id).first() as any;
    const events = (await env.DB.prepare("SELECT event FROM entry_events WHERE entry_id = 'old'").all()).results as any[];
    console.log("fallback counters/events/tags", old, newcomer, events, row.tags, vectors.get(result.id)?.tags);
    expect(old.contradiction_losses).toBe(0);
    expect(newcomer.contradiction_wins).toBe(0);
    expect(events).toHaveLength(0);
    // Vector ids are per upload (T-0089.1.1): read the fallback draft's vector through its parentId.
    expect([...vectors.values()].filter(m => m.parentId === result.id).pop()?.tags).toEqual(JSON.parse(row.tags));
    sqlite.close();
  });

  it("successful conditional supersede keeps counters and audit aligned", async () => {
    const { sqlite, env } = await setup(0.72, '{"contradicts":true,"conflicting_id":"old","reason":"different"}');
    const pending: Promise<unknown>[] = [];
    const awaitCtx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
    sqlite.issued.length = 0;
    const result = await captureEntry("New conflicting digest", ["synthesized"], "system", env, awaitCtx, undefined,
      { workspaceId: "", actorId: "" }, undefined, { systemWrite: "digest", channel: "system:digest" });
    await Promise.allSettled(pending);
    console.log("conditional capture D1 calls", sqlite.issued.length);
    expect(result.status).toBe("contradiction");
    if (result.status !== "contradiction") return;
    const old = await env.DB.prepare("SELECT tags, vector_ids, valid_until, contradiction_losses FROM entries WHERE id = 'old'").first() as any;
    const newcomer = await env.DB.prepare("SELECT created_at, contradiction_wins FROM entries WHERE id = ?").bind(result.id).first() as any;
    const events = (await env.DB.prepare("SELECT event, payload FROM entry_events WHERE entry_id = 'old'").all()).results as any[];
    // T-0089.2.1: superseded, not deprecated: the digest keeps its status and vectors, and its window closes.
    expect(JSON.parse(old.tags)).not.toContain("status:deprecated");
    expect(old.valid_until).toBe(newcomer.created_at);
    expect(old.contradiction_losses).toBe(1);
    expect(newcomer.contradiction_wins).toBe(1);
    expect(events.map(x => x.event)).toEqual(["superseded"]);
    expect(JSON.parse(events[0].payload).channel).toBe("system:digest");
    sqlite.close();
  });

  it("a draft from a protected conflict must not permit user source rollup on the next cycle", async () => {
    const day = 86400000;
    let now = 400 * day;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { sqlite, env } = await setup(0.72, '{"contradicts":true,"conflicting_id":"old","reason":"different"}');
    sqlite.db.prepare(`UPDATE entries SET tags = '["rocket-project"]', source = 'api', actor_id = 'u1' WHERE id = 'old'`).run();
    for (let i = 0; i < 12; i++) sqlite.seed({ id: `work-${i}`, content: `User work fact ${i}`, tags: ["rocket-project"], source: "api", createdAt: 1000 + i });
    await compressTag("rocket-project", env, ctx);
    const first = (await env.DB.prepare("SELECT id, tags FROM entries WHERE source = 'system'").all()).results as any[];
    expect(first).toHaveLength(1);
    expect(JSON.parse(first[0].tags)).toContain("status:draft");
    expect(JSON.parse(first[0].tags)).toContain("conflict-held");
    now += 25 * 3600000;
    (env.VECTORIZE as any).query = vi.fn().mockResolvedValue({ matches: [{ id: first[0].id, score: 0.72, metadata: { parentId: first[0].id } }] });
    (env.AI as any).run = vi.fn(async (model: string) => model === "@cf/google/embeddinggemma-300m"
      ? { data: [new Array(768).fill(0.1)] }
      : stream(JSON.stringify({ contradicts: true, conflicting_id: first[0].id, reason: "different" })));
    await compressTag("rocket-project", env, ctx);
    const sources = (await env.DB.prepare("SELECT tags FROM entries WHERE id LIKE 'work-%'").all()).results as any[];
    const digests = (await env.DB.prepare("SELECT id, tags FROM entries WHERE source = 'system'").all()).results as any[];
    console.log("second cycle", sources.filter(row => JSON.parse(row.tags).includes("rolled-up")).length, digests);
    expect(sources.some(row => JSON.parse(row.tags).includes("rolled-up"))).toBe(false);
    // The held draft was neither superseded nor replaced.
    expect(JSON.parse(digests.find(d => d.id === first[0].id).tags)).not.toContain("status:deprecated");
    sqlite.close(); vi.restoreAllMocks();
  });

});
