import { parentIdOfVectorId } from "../../src/vectorize/ids";
/**
 * Round 4 adversary against 3318ca20 ("restoreRowVectors takes its stale set from the row's own current
 * vector_ids"). Invariant: after any interleaving settles, (a) every vector id in Vectorize for a row is in that
 * row's vector_ids, (b) the listed vectors describe the committed content, (c) else vector_ids is '[]' so
 * /vectorize-pending re-indexes. Real SQLite (node:sqlite), Map-backed Vectorize.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { appendToEntry, storeEntry, updateEntryContent } from "../../src/capture/store";
import { deprecateEntry, forgetEntry } from "../../src/capture/lifecycle";
import { deleteForever } from "../../src/memory/trash";
import { trashNonce } from "../helpers/trash-env";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
let companyWs = "";

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

const seed = (id: string, content: string, workspaceId = owner.personalWorkspaceId, actorId = owner.userId) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, '[]', 'api', 1000, ?, ?, ?)`,
).bind(id, content, JSON.stringify([id]), workspaceId, actorId).run();
const live = async (id: string) => (await sqlite.db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;

/** Map-backed Vectorize; `failEmbed.on` makes every later embed throw (a transient Workers AI failure). */
function vectorEnv() {
  const store = new Map<string, any>();
  const failEmbed = { on: false };
  const vec = makeVectorizeMock({
    upsert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" } as any; }),
    insert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" } as any; }),
    deleteByIds: vi.fn(async (ids: string[]) => { for (const i of ids) store.delete(i); return { mutationId: "m" } as any; }),
    // deleteEntryVectors reads metadata.parentId first (T-0089.1.1): answer from this store.
    getByIds: vi.fn(async (ids: string[]) => ids.filter(i => store.has(i)).map(i => store.get(i))) as any,
  });
  const e = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: vec,
    // R20's batchEmbeds sends every chunk in one call: answer with one vector per requested text.
    AI: { run: vi.fn(async (_model: string, opts: any) => {
      if (failEmbed.on) throw new Error("AI transient");
      const texts = Array.isArray(opts?.text) ? opts.text : [opts?.text];
      return { data: texts.map(() => new Array(768).fill(0.1)) };
    }) } as any,
  })) as Env;
  const put = (id: string, content: string) => store.set(id, { id, values: [0.1], metadata: { content, parentId: id } });
  // Every vector of the entry, either id form (3.7's deterministic ids, or per-upload ids since T-0089.1.1).
  const under = (id: string) => [...store.keys()].filter(k => parentIdOfVectorId(k) === id);
  return { e, store, failEmbed, put, under };
}

/**
 * The losing writer's env: its first batch runs `beforeThrow` then throws (a transient D1 error, the U6 path into
 * restoreRowVectors); `afterRestoreRead` runs right after restoreRowVectors' own row read resolves, i.e. while it
 * is about to re-embed.
 */
function losingEnv(base: Env, hooks: { beforeThrow?: () => Promise<void>; afterRestoreRead?: () => Promise<void> }): Env {
  const raw = base.DB as any;
  let threw = false;
  return { ...base, DB: { ...raw,
    prepare(sql: string) {
      const st = raw.prepare(sql);
      if (!hooks.afterRestoreRead || !sql.startsWith("SELECT content, tags, workspace_id, vector_ids FROM entries")) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => { const r = await st.bind(...a).first(); await hooks.afterRestoreRead!(); return r; } }) };
    },
    async batch(stmts: unknown[]) {
      if (threw) return raw.batch(stmts);
      threw = true;
      await hooks.beforeThrow?.();
      throw new Error("D1_ERROR: transient");
    },
  } } as unknown as Env;
}

const wctx = () => ({ workspaceId: owner.personalWorkspaceId, actorId: owner.userId });
const change = () => ({ actorId: owner.userId, channel: "rest" as const });
const update = (e: Env, id: string, text: string) => updateEntryContent(e, id, text, DEFAULTS, undefined, undefined, wctx(), change(), wctx().workspaceId);

describe("R4-V1 (MAJOR): a restore whose content CAS misses never retires the loser's own chunks, and Delete forever cannot reach them", () => {
  // store.ts:211 (3318ca20): `if (changesOf(written) > 0) await deleteStaleVectors(...)`. On a miss nothing is
  // deleted, including `mergedVectorIds` — the loser's OWN never-committed chunks (`id-chunk-i`), which no row lists.
  // Before 3318ca20 the unconditional write+delete retired them. Forget deletes the row's vector_ids; Delete forever
  // deletes stored ids ∪ deterministicVectorIds(final content) (trash.ts:579) — neither names the loser's chunks.
  const DRAFT = "LOSER-DRAFT private wording ".repeat(130); // ~3,600 chars: three chunks, a1-chunk-0..2

  it("a concurrent update commits during the restore's re-embed", async () => {
    const { e, put, under } = vectorEnv();
    await seed("a1", "short base");
    put("a1", "short base");
    // Round 6: restoreRowVectors is gone; the race lands inside the loser's own attempt instead.
    const losing = losingEnv(e, { beforeThrow: async () => { expect((await update(e, "a1", "winner text")).status).toBe("updated"); } });
    await expect(update(losing, "a1", DRAFT)).rejects.toThrow(/transient/);
    expect((await live("a1")).content).toBe("winner text");
    expect((await forgetEntry("a1", e, change(), { reason: "forget", config: DEFAULTS, purge: false }, wctx().workspaceId)).status).toBe("deleted");
    expect((await deleteForever(e, "a1", change(), wctx().workspaceId, await trashNonce(e, "a1"))).status).toBe("deleted");
    // FAILS: ["a1-chunk-0","a1-chunk-1","a1-chunk-2"] (LOSER-DRAFT text) outlive Delete forever.
    expect(under("a1")).toEqual([]);
  });

  it("the row is forgotten during the restore's re-embed (attack 4)", async () => {
    const { e, put, under } = vectorEnv();
    await seed("a2", "short base");
    put("a2", "short base");
    const losing = losingEnv(e, { beforeThrow: async () => {
      expect((await forgetEntry("a2", e, change(), { reason: "forget", config: DEFAULTS, purge: false }, wctx().workspaceId)).status).toBe("deleted");
    } });
    await expect(update(losing, "a2", DRAFT)).rejects.toThrow(/transient/);
    expect(await live("a2")).toBeNull();
    expect((await deleteForever(e, "a2", change(), wctx().workspaceId, await trashNonce(e, "a2"))).status).toBe("deleted");
    // FAILS: the loser's three chunks survive (the CAS misses on the gone row, so nothing is deleted).
    expect(under("a2")).toEqual([]);
  });
});

describe("R4-V2 (MINOR): a restore whose content CAS misses leaves the row's listed vector describing text it no longer holds", () => {
  // store.ts:190 upserts the row's content as read at :183; a writer that committed (and upserted the same
  // deterministic id) in between is overwritten in the index, then the CAS at :205 misses and nothing corrects it.
  // vector_ids stays non-empty, so /vectorize-pending (admin.ts:1463, `vector_ids = '[]'`) never re-indexes it.
  it("the last upsert describes committed text", async () => {
    const { e, store, put } = vectorEnv();
    await seed("b1", "short base");
    put("b1", "short base");
    const losing = losingEnv(e, { beforeThrow: async () => { expect((await update(e, "b1", "winner text")).status).toBe("updated"); } });
    await expect(update(losing, "b1", "loser text")).rejects.toThrow(/transient/);
    const row = await live("b1");
    expect(row.content).toBe("winner text");
    // The row lists the winner's own upload, which the loser (per-upload ids) could not overwrite.
    const listed = JSON.parse(row.vector_ids) as string[];
    expect(listed).toHaveLength(1);
    expect(store.get(listed[0])?.metadata?.content).toBe("winner text");
    expect([...store.values()].map((v: any) => v.metadata?.content)).not.toContain("loser text");
  });
});

describe("R4-V3 (MAJOR): the failure branch deletes a moved row's live vectors while its vector_ids still names them", () => {
  // store.ts:216-222: on a re-embed failure the clear is pinned to `writeCtx.workspaceId` — the caller's PREVIOUS
  // attempt's row (store.ts:307, last.embedCtx), not the workspace just read at :183. After an unshare the clear
  // misses, yet deleteVectorIds(old ∪ merged) at :222 runs anyway: `v1` (the row's own id) is deleted, vector_ids
  // still says ["v1"], and /vectorize-pending skips it. Silently semantic-unsearchable, no self-repair (#212, R2-2).
  it("R2-2's unshare-mid-edit, with a transient embed failure in the recovery", async () => {
    const { e, store, failEmbed, put } = vectorEnv();
    const { token: adminTok } = await createMember(env, { name: "Ada", role: "admin" });
    const admin = (await resolveIdentityFromToken(adminTok, env))!;
    const { token: bobTok } = await createMember(env, { name: "Bob", role: "member" });
    const bob = (await resolveIdentityFromToken(bobTok, env))!;
    await seed("v1", "Bob's company note", companyWs, bob.userId);
    put("v1", "Bob's company note");
    const raw = e.DB as any;
    let moved = false;
    const racing = { ...e, DB: { ...raw, prepare(sql: string) {
      if (!moved && sql.startsWith("INSERT INTO entry_versions")) {
        moved = true;
        raw.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'v1'`).bind(bob.personalWorkspaceId).run();
        failEmbed.on = true; // the recovery's re-embed hits a transient Workers AI failure
      }
      return raw.prepare(sql);
    } } } as unknown as Env;
    const adminCtx = { workspaceId: companyWs, actorId: admin.userId };
    const r = await updateEntryContent(racing, "v1", "admin rewrite", DEFAULTS, undefined, undefined, adminCtx, { actorId: admin.userId, channel: "rest" }, companyWs);
    expect(r.status).toBe("moved");
    const row = await live("v1");
    expect(row.content).toBe("Bob's company note");
    // Either the listed vectors exist (and describe the row), or vector_ids is '[]' so /vectorize-pending repairs it.
    const dangling = (JSON.parse(row.vector_ids) as string[]).filter(id => !store.has(id));
    expect(dangling).toEqual([]); // FAILS: ["v1"]
  });
});

describe("R4-V4 (MAJOR): the failure branch drops a short append's chunk from vector_ids without deleting it", () => {
  // store.ts:216-222: the R3-3 fix folded the row's current vector_ids into the SUCCESS path's stale set only. The
  // catch clears vector_ids to '[]' (dropping `id-update-<ts>` from the list) but deletes only old ∪ merged, which do
  // not name it. /vectorize-pending then lists only the re-embedded ids; forget and Delete forever (stored ∪
  // deterministic ids) never find the chunk. Same class as R3-3, now through Delete forever.
  it("an append lands between the update's read and its thrown batch; the recovery's embed fails", async () => {
    const { e, failEmbed, put, under } = vectorEnv();
    await seed("c1", "base");
    put("c1", "base");
    const losing = losingEnv(e, { beforeThrow: async () => {
      await appendToEntry(e, "c1", "", "PRIVATE ADDITION", [], "api", DEFAULTS, undefined, wctx(), change(), undefined, wctx().workspaceId);
      failEmbed.on = true;
    } });
    await expect(update(losing, "c1", "rewrite")).rejects.toThrow(/transient/);
    // Round 6: no failure branch clears the row any more; it lists its base vector and the append's chunk.
    expect(JSON.parse((await live("c1")).vector_ids)).toHaveLength(2);
    failEmbed.on = false;
    expect((await forgetEntry("c1", e, change(), { reason: "forget", config: DEFAULTS, purge: false }, wctx().workspaceId)).status).toBe("deleted");
    expect((await deleteForever(e, "c1", change(), wctx().workspaceId, await trashNonce(e, "c1"))).status).toBe("deleted");
    // FAILS: ["c1-update-<ts>"] ("PRIVATE ADDITION") outlives Delete forever.
    expect(under("c1")).toEqual([]);
  });
});

describe("R4-V5 (MINOR): a restore re-indexes a memory deprecated during its re-embed", () => {
  // store.ts:205: the CAS is on content alone. deprecateEntry (lifecycle.ts:125) changes tags and sets
  // vector_ids = '[]' but not content, so the restore's write still lands: the dismissed memory's vector is back,
  // listed, with metadata tags that predate the deprecation — exactly what INDEXABLE_SQL (lifecycle.ts:84) excludes.
  it("a deprecated row stays out of the index", async () => {
    const { e, put, under } = vectorEnv();
    await seed("d1", "dismissed pattern");
    put("d1", "dismissed pattern");
    const losing = losingEnv(e, { beforeThrow: async () => {
      expect(await deprecateEntry("d1", e, change(), DEFAULTS, wctx().workspaceId)).toBe(true);
    } });
    await expect(update(losing, "d1", "rewrite")).rejects.toThrow(/transient/);
    const row = await live("d1");
    expect(JSON.parse(row.tags)).toContain("status:deprecated");
    expect(JSON.parse(row.vector_ids)).toEqual([]);
    expect(under("d1")).toEqual([]); // neither the old vector nor the loser's upload is left in the index
  });
});
