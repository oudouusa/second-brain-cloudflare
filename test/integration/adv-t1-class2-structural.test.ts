/**
 * CLASS 2 structural test (T-0089.1.1 T-0089.10, round 2 versions adversary R2-2/ADV-4 residual):
 * vector ids are deterministic (the id, or id-chunk-i), so "the row's live vectors" and "our own
 * embed" can name the exact same id. A lost or failed attempt that deletes its own embed outright
 * can therefore delete a DIFFERENT, winning writer's just-committed vector. Every writer must
 * recover instead: re-embed the row as it now stands, never delete.
 *
 * For every writer this builder owns: force a compare-and-set loss on the first attempt (a
 * concurrent tag write lands between the read and the commit, so the retry has to re-embed), and
 * separately force the commit batch itself to throw (U6) after the embed already landed in
 * Vectorize. Both cases assert the row's live vectors, by its OWN current vector_ids, describe
 * its OWN current content — never a lost attempt's text, and never missing outright.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let owner: Identity;
let ws = "";

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  const bootEnv = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(bootEnv);
  const roots = await ensureTenantBootstrap(bootEnv);
  ws = roots.ownerPersonalWorkspaceId;
  owner = (await resolveIdentityByUserId(bootEnv, roots.ownerUserId))!;
});
afterEach(() => sqlite.close());

const seed = (id: string, content: string) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
   VALUES (?, ?, '[]', 'api', 1000, NULL, ?, ?, ?)`,
).bind(id, content, JSON.stringify([id]), ws, owner.userId).run();
const live = async (id: string) => (await sqlite.db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;

/** A Vectorize double that tracks every upserted/inserted vector's content by id. */
function makeVectorStore() {
  const store = new Map<string, { content: string }>();
  const deleteByIds = vi.fn(async (ids: string[]) => { for (const i of ids) store.delete(i); return { mutationId: "m" } as any; });
  const vec = makeVectorizeMock({
    upsert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, { content: v.metadata?.content }); return { mutationId: "m" } as any; }),
    insert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, { content: v.metadata?.content }); return { mutationId: "m" } as any; }),
    deleteByIds,
    query: vi.fn(async () => ({ matches: [], count: 0 })),
  });
  return { vec, store, deleteByIds };
}

/**
 * Every id the row's OWN vector_ids currently names must be present and describe a SLICE of its
 * OWN current content — a substring check, not exact equality, because a chunked (multi-vector)
 * row's own metadata.content is one chunk's text, not the whole row.
 */
async function assertLiveVectorsMatchContent(id: string, store: Map<string, { content: string }>) {
  const row = await live(id);
  const vectorIds = JSON.parse(row.vector_ids ?? "[]") as string[];
  expect(vectorIds.length, `${id}: vector_ids is empty after a recovery path`).toBeGreaterThan(0);
  for (const vid of vectorIds) {
    const entry = store.get(vid);
    expect(entry, `${id}: vector_ids names ${vid}, but no live vector exists under that id`).toBeDefined();
    expect(row.content.includes(entry!.content), `${id}: vector ${vid} describes stale or lost-attempt text, not part of the row's own current content`).toBe(true);
  }
}

describe("CLASS 2 structural: a compare-and-set loss re-embeds, never deletes, the row's own vectors", () => {
  // The final state alone cannot tell a correct recovery apart from a blind delete followed by
  // some LATER step papering over it (this same function's own exhaustion cleanup, or the next
  // attempt's own fresh embed, both already existed before the R2-2 fix and would restore the id
  // regardless). The id a lost attempt's own embed and the row's real, live content BOTH share is
  // deterministic (the id itself here, single-chunk content); a blind delete of it, even one that
  // gets overwritten again moments later, is exactly the mistake R2-2 found — asserted directly
  // against the Vectorize mock's own call history, not inferred from where things end up.
  it("updateEntryContent: a concurrent content change abandons the first attempt's own re-embed", async () => {
    const { updateEntryContent } = await import("../../src/capture/store");
    const { DEFAULTS } = await import("../../src/config");
    const { store, vec, deleteByIds } = makeVectorStore();
    const env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: vec,
      AI: { run: vi.fn(async (_model: string, opts: any) => ({ data: (Array.isArray(opts?.text) ? opts.text : [opts?.text]).map(() => new Array(768).fill(0.1)) })) } as any })) as Env;
    await seed("u1", "Original content");
    store.set("u1", { content: "Original content" });
    const raw = env.DB as any;
    let raced = false;
    const racing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      const st = raw.prepare(sql);
      if (raced || !sql.startsWith("SELECT content, tags, source, ")) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => {
        const r = await st.bind(...a).first();
        // A tags-only race never abandons this attempt's own re-embed at all: updateEntryContent
        // only re-embeds again when the CONTENT it embedded from has moved (embeddedFrom !==
        // readContent), so the SAME embed just gets reused and committed on the next attempt,
        // never cleaned up either way. Changing content here is what actually exercises the
        // abandoned-embed cleanup path.
        if (!raced) { raced = true; await raw.prepare(`UPDATE entries SET content = 'Concurrent content' WHERE id = 'u1'`).run(); }
        return r;
      } }) };
    } } } as unknown as Env;
    const wctx = { workspaceId: ws, actorId: owner.userId };
    const change = { actorId: owner.userId, channel: "rest" as const };
    const r = await updateEntryContent(racing, "u1", "Updated content", DEFAULTS, undefined, undefined, wctx, change, ws);
    expect(r.status).toBe("updated");
    await assertLiveVectorsMatchContent("u1", store);
    // Per-upload vector ids (T-0089.1.1): nothing this call deleted is an id the row lists now.
    const listedU1 = JSON.parse((await live("u1")).vector_ids) as string[];
    for (const id of listedU1) expect(deleteByIds.mock.calls.flatMap((c: any) => c[0])).not.toContain(id);
  });

  it("appendToEntry, long branch: a concurrent tag write loses the first attempt's oversized re-embed", async () => {
    const { appendToEntry } = await import("../../src/capture/store");
    const { DEFAULTS } = await import("../../src/config");
    const { store, vec, deleteByIds } = makeVectorStore();
    const env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: vec,
      AI: { run: vi.fn(async (_model: string, opts: any) => ({ data: (Array.isArray(opts?.text) ? opts.text : [opts?.text]).map(() => new Array(768).fill(0.1)) })) } as any })) as Env;
    const longBody = "x".repeat(1700);
    await seed("u2", longBody);
    store.set("u2", { content: longBody });
    const raw = env.DB as any;
    let raced = false;
    const racing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      const st = raw.prepare(sql);
      if (raced || !sql.startsWith("SELECT content, tags, source, ")) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => {
        const r = await st.bind(...a).first();
        if (!raced) { raced = true; await raw.prepare(`UPDATE entries SET tags = '["concurrent"]' WHERE id = 'u2'`).run(); }
        return r;
      } }) };
    } } } as unknown as Env;
    const wctx = { workspaceId: ws, actorId: owner.userId };
    const change = { actorId: owner.userId, channel: "rest" as const };
    await appendToEntry(racing, "u2", "", "more text", [], "api", DEFAULTS, undefined, wctx, change, undefined, ws);
    await assertLiveVectorsMatchContent("u2", store);
    // Multi-chunk content (over CHUNK_MAX_CHARS) names its chunks "u2-chunk-0"/"u2-chunk-1", not
    // bare "u2" — the seed row's own "u2" (single, unchunked) legitimately goes stale once this
    // append re-embeds a chunked result, and deleting IT is correct, not the bug. "u2-chunk-0" is
    // the id both the lost first attempt and the eventual winner compute identically (same
    // content, same deterministic scheme) — a blind delete of it on the loss is the R2-2 mistake.
    const listedU2 = JSON.parse((await live("u2")).vector_ids) as string[];
    for (const id of listedU2) expect(deleteByIds.mock.calls.flatMap((c: any) => c[0])).not.toContain(id);
  });
});

describe("CLASS 2 structural: a thrown commit batch re-embeds the row as it stands, never leaves the index ahead of D1 (U6)", () => {
  it("updateEntryContent: the batch throws after the embed already landed in Vectorize", async () => {
    const { updateEntryContent } = await import("../../src/capture/store");
    const { DEFAULTS } = await import("../../src/config");
    const { store, vec } = makeVectorStore();
    const env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: vec,
      AI: { run: vi.fn(async (_model: string, opts: any) => ({ data: (Array.isArray(opts?.text) ? opts.text : [opts?.text]).map(() => new Array(768).fill(0.1)) })) } as any })) as Env;
    await seed("t1", "Original content");
    store.set("t1", { content: "Original content" });
    const raw = env.DB as any;
    const throwing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, batch: async (stmts: unknown[]) => { throw new Error("simulated D1 outage"); } } } as unknown as Env;
    const wctx = { workspaceId: ws, actorId: owner.userId };
    const change = { actorId: owner.userId, channel: "rest" as const };
    await expect(updateEntryContent(throwing, "t1", "Updated content", DEFAULTS, undefined, undefined, wctx, change, ws)).rejects.toThrow();
    // Nothing committed: the row's content is unchanged, and its vectors must describe THAT, not
    // the "Updated content" the embed above already upserted before the batch threw.
    const row = await live("t1");
    expect(row.content).toBe("Original content");
    await assertLiveVectorsMatchContent("t1", store);
  });

  it("appendToEntry, short branch: the batch throws after the chunk embed already landed in Vectorize", async () => {
    const { appendToEntry } = await import("../../src/capture/store");
    const { DEFAULTS } = await import("../../src/config");
    const { store, vec, deleteByIds } = makeVectorStore();
    const env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: vec,
      AI: { run: vi.fn(async (_model: string, opts: any) => ({ data: (Array.isArray(opts?.text) ? opts.text : [opts?.text]).map(() => new Array(768).fill(0.1)) })) } as any })) as Env;
    await seed("t2", "Original content");
    store.set("t2", { content: "Original content" });
    const raw = env.DB as any;
    const throwing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, batch: async (stmts: unknown[]) => { throw new Error("simulated D1 outage"); } } } as unknown as Env;
    const wctx = { workspaceId: ws, actorId: owner.userId };
    const change = { actorId: owner.userId, channel: "rest" as const };
    await expect(appendToEntry(throwing, "t2", "", "an addition", [], "api", DEFAULTS, undefined, wctx, change, undefined, ws)).rejects.toThrow();
    const row = await live("t2");
    expect(row.content).toBe("Original content");
    // The row's own "t2" vector was never touched by this attempt (the batch threw before any of
    // it committed), so checking only what vector_ids already references proves nothing here —
    // that stays correct by construction either way. The chunk this attempt's OWN embed inserted
    // under its own unique `t2-update-<ts>` id, BEFORE the throw, is the one thing this attempt
    // controls and must not leave dangling: never added to any row's vector_ids (the batch never
    // committed), so nothing else will ever ask Vectorize to delete it.
    const chunkId = (vec.insert as any).mock.calls[0][0][0].id as string;
    expect(chunkId).toMatch(/^v-[0-9a-f-]{36}-0$/);
    expect(store.has(chunkId), `${chunkId}: orphaned in Vectorize, retireChunk did not run on the thrown batch`).toBe(false);
    expect(deleteByIds.mock.calls.flatMap((c: any) => c[0])).toContain(chunkId);
    await assertLiveVectorsMatchContent("t2", store);
  });
});
