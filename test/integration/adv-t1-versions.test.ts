/**
 * Adversary reproductions for Track 1 versioning (T-0089.1.1, T-0089.9, T-0089.10), range bb5377f..5c25183.
 * Every test here FAILS on 5c25183 and names the invariant it breaks. Real SQLite (node:sqlite) throughout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { resolveEntryAction } from "../../src/memory/actions";
import { captureEntry } from "../../src/capture/entry";
import { moveEntry } from "../../src/capture/share";
import { compressTag } from "../../src/compression/digest";
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
  env = sqlite.admitEnv(env);
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

/** Runs `mutate` (awaited) after every read of resolveEntryAction's own guard row. */
function afterGuardRead(base: Env, mutate: () => Promise<void>): Env {
  const raw = base.DB as any;
  const DB = {
    ...raw,
    prepare(sql: string) {
      const st = raw.prepare(sql);
      if (!/when_at, when_kind, when_label, when_source FROM entries/.test(sql)) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => { const r = await st.bind(...a).first(); await mutate(); return r; } }) };
    },
  };
  return { ...base, WRITE_ADMISSION_TOKEN: base.WRITE_ADMISSION_TOKEN, DB } as unknown as Env;
}

describe("ADV-1 (MAJOR): a snooze that loses its CAS on when_* still writes a version", () => {
  // Spec P3: "A snapshot of a CAS-guarded write carries the same guard." The snooze/clear UPDATE is guarded on
  // tags, content AND the four when_* columns; the snapshot's guard (actions.ts:87, :96) carries only tags and
  // content. A concurrent due change makes the UPDATE miss while the snapshot still lands.
  it("a 409 snooze leaves no version behind", async () => {
    await seed("d1", { whenAt: 5_000_000_000_000, whenKind: "due", whenSource: "explicit", whenLabel: "call bob" });
    let n = 0;
    // Another client snoozes the same item (a different date) between this request's read and its batch, every attempt.
    const racing = afterGuardRead(env, async () => {
      await sqlite.db.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', when_at = ? WHERE id = 'd1'`).bind(5_000_000_000_000 + ++n * 1000).run();
    });
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const result = await resolveEntryAction(racing, ctx, owner, "d1", "snooze", until, { actorId: owner.userId, channel: "rest" });
    expect(result.ok).toBe(false); // 409: nothing was snoozed by this request
    expect(await versions("d1")).toEqual([]); // FAILS: three "due" versions by this actor for a change that never happened
  });

  it("clear_date: the same guard hole", async () => {
    await seed("d2", { whenAt: 5_000_000_000_000, whenKind: "due", whenSource: "explicit", whenLabel: "x" });
    let n = 0;
    const racing = afterGuardRead(env, async () => {
      await sqlite.db.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', when_label = ? WHERE id = 'd2'`).bind(`relabelled ${++n}`).run();
    });
    const result = await resolveEntryAction(racing, ctx, owner, "d2", "clear_date", undefined, { actorId: owner.userId, channel: "rest" });
    expect(result.ok).toBe(false);
    expect(await versions("d2")).toEqual([]);
  });
});

describe("ADV-2 (MAJOR): a person's merge lands in another member's personal workspace", () => {
  // entry.ts:250-258: the person-merge snapshot guard and UPDATE compare-and-set on tags and content only. The target
  // was read pinned to the writer's workspace, but an unshare between that read and the batch moves the row into its
  // author's personal workspace without touching tags or content, so the CAS still matches. Prep fixed exactly this
  // for the system merge (workspace_id in the CAS); the person path this range rewrote still lacks it.
  it("member A's capture merge does not write into member B's now-private memory", async () => {
    const a = await member("Alice");
    const b = await member("Bob");
    await seed("t1", { content: "Team fact about the Q3 launch plan", tags: ["rocket-project"], workspaceId: companyWs, actorId: b.userId });

    const decision = JSON.stringify({ action: "merge", target_id: "t1", merged_content: "Team fact about the Q3 launch plan. Alice: my private note" });
    const stream = (text: string) => new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
    } });
    const raceEnv = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as any, OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [{ id: "t1", score: 0.9, metadata: { parentId: "t1", workspace_id: companyWs } }] }),
        upsert: vi.fn(async () => ({ mutationId: "m" }) as any),
        deleteByIds: vi.fn(async () => ({ mutationId: "m" }) as any),
      }),
      AI: { run: vi.fn(async (model: string, opts: any) => model === "@cf/google/embeddinggemma-300m" ? { data: (Array.isArray(opts?.text) ? opts.text : [opts?.text]).map(() => new Array(768).fill(0.1)) } : stream(decision)) } as any,
    })) as Env;
    const db = raceEnv.DB as any;
    const prepare = db.prepare.bind(db);
    let raced = false;
    db.prepare = (sql: string) => {
      // Bob unshares t1 (his own memory) while Alice's merge is re-embedding: the move commits before her batch.
      if (!raced && sql.startsWith("INSERT INTO entry_versions")) {
        raced = true;
        prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', workspace_id = ? WHERE id = 't1'`).bind(b.personalWorkspaceId).run();
      }
      return prepare(sql);
    };
    const captured = await captureEntry("Alice: my private note about the Q3 launch", [], "api", raceEnv, ctx, undefined,
      { workspaceId: companyWs, actorId: a.userId }, undefined, { channel: "rest" });

    const t1 = await live("t1");
    expect(t1.workspace_id).toBe(b.personalWorkspaceId);
    // FAILS: Alice's text is now inside Bob's private memory, and a version stamped Bob's personal workspace names Alice.
    expect(t1.content).toBe("Team fact about the Q3 launch plan");
    expect((await versions("t1")).filter(v => v.actor_id === a.userId)).toEqual([]);
  });
});

describe("ADV-2b (MAJOR): an admin's update or append lands in the author's personal workspace after an unshare", () => {
  // store.ts:314 / :437 / :496: updateEntryContent and both append branches compare-and-set on content (and tags)
  // only. The route authorised the write against the company row; the author's unshare during the embed does not
  // change content or tags, so the CAS matches and the admin's text is written into the author's private memory.
  function unshareAfterFirstOwnRead(base: Env, id: string, to: string): Env {
    let n = 0;
    const raw = base.DB as any;
    return { ...base, WRITE_ADMISSION_TOKEN: base.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      const st = raw.prepare(sql);
      if (!sql.startsWith("SELECT content, tags, source, ")) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => {
        const r = await st.bind(...a).first();
        if (++n === 1) await sqlite.db.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', workspace_id = ? WHERE id = ?`).bind(to, id).run();
        return r;
      } }) };
    } } } as unknown as Env;
  }

  it("update", async () => {
    const { updateEntryContent } = await import("../../src/capture/store");
    const { DEFAULTS } = await import("../../src/config");
    const admin = await member("Ada", "admin");
    const author = await member("Bob");
    await seed("c1", { content: "company text", workspaceId: companyWs, actorId: author.userId });
    const r = await updateEntryContent(unshareAfterFirstOwnRead(env, "c1", author.personalWorkspaceId), "c1", "admin rewrite",
      DEFAULTS, undefined, undefined, { workspaceId: companyWs, actorId: admin.userId }, { actorId: admin.userId, channel: "rest" }, ({ workspaceId: companyWs, actorId: admin.userId }).workspaceId);
    const row = await live("c1");
    expect(row.workspace_id).toBe(author.personalWorkspaceId);
    expect(r.status).not.toBe("updated"); // FAILS: "updated"
    expect(row.content).toBe("company text"); // FAILS: "admin rewrite" inside Bob's private memory
  });

  it("append", async () => {
    const { appendToEntry } = await import("../../src/capture/store");
    const { DEFAULTS } = await import("../../src/config");
    const admin = await member("Ada", "admin");
    const author = await member("Bob");
    await seed("c2", { content: "company text", workspaceId: companyWs, actorId: author.userId });
    await appendToEntry(unshareAfterFirstOwnRead(env, "c2", author.personalWorkspaceId), "c2", "", "admin addition", [], "api",
      DEFAULTS, undefined, { workspaceId: companyWs, actorId: admin.userId }, { actorId: admin.userId, channel: "rest" }, undefined, ({ workspaceId: companyWs, actorId: admin.userId }).workspaceId).catch(() => {});
    const row = await live("c2");
    expect(row.workspace_id).toBe(author.personalWorkspaceId);
    expect(row.content).toBe("company text"); // FAILS
  });
});

describe("ADV-3 (MINOR): digest rollup writes a version for a source it did not change", () => {
  // digest.ts:68: snapshotManyStatement has no workspace predicate; the mark UPDATE has `AND workspace_id = ?`.
  it("a source moved out of the digest's workspace mid-run gets no rollup version", async () => {
    const digestEnv = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(),
      AI: { run: vi.fn(async (model: string, opts: any) => model === "@cf/google/embeddinggemma-300m" ? { data: (Array.isArray(opts?.text) ? opts.text : [opts?.text]).map(() => new Array(768).fill(0.1)) }
        : new ReadableStream({ start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":"Synthesized text"}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
        } })) } as any,
    })) as Env;
    for (let i = 0; i < 12; i++) await seed(`s${i}`, { content: `Work memory number ${i} with enough detail to be eligible`, tags: ["rocket-project"], createdAt: 1000 + i });
    const db = digestEnv.DB as any;
    const prepare = db.prepare.bind(db);
    let moved = false;
    db.prepare = (sql: string) => {
      // The author shares s0 to the company workspace after the digest read its sources.
      if (!moved && sql.startsWith("INSERT INTO entry_versions")) {
        moved = true;
        prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', workspace_id = ? WHERE id = 's0'`).bind(companyWs).run();
      }
      return prepare(sql);
    };
    await compressTag("rocket-project", digestEnv, ctx);
    const s0 = await live("s0");
    expect(s0.content).not.toContain("[Digest:"); // the mark missed, correctly
    expect(await versions("s0")).toEqual([]); // FAILS: a rollup version, stamped the company workspace, for no change
  });
});

describe("ADV-4 (MINOR): vectors that describe uncommitted or replaced text survive a lost attempt (T-0089.10)", () => {
  // W2: "the last vector upsert in any interleaving describes committed text". storeEntry (store.ts:97) writes
  // `vector_ids` unconditionally while a CAS writer is still embedding, before its compare-and-set commit.
  function vectorEnv() {
    const store = new Map<string, any>();
    const vec = makeVectorizeMock({
      upsert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" } as any; }),
      insert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" } as any; }),
      deleteByIds: vi.fn(async (ids: string[]) => { for (const i of ids) store.delete(i); return { mutationId: "m" } as any; }),
    });
    const e = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: vec,
      AI: { run: vi.fn(async (_model: string, opts: any) => ({ data: (Array.isArray(opts?.text) ? opts.text : [opts?.text]).map(() => new Array(768).fill(0.1)) })) } as any,
    })) as Env;
    return { e, store };
  }
  function afterOwnRead(base: Env, mutate: () => Promise<void>): Env {
    let n = 0;
    const raw = base.DB as any;
    return { ...base, WRITE_ADMISSION_TOKEN: base.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      const st = raw.prepare(sql);
      if (!sql.startsWith("SELECT content, tags, source, ")) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => { const r = await st.bind(...a).first(); if (++n === 1) await mutate(); return r; } }) };
    } } } as unknown as Env;
  }
  const change = () => ({ actorId: owner.userId, channel: "rest" as const });
  const wctx = () => ({ workspaceId: owner.personalWorkspaceId, actorId: owner.userId });

  it("a long append that loses to an update and then commits short leaves the replaced text in the row's vectors", async () => {
    const { appendToEntry, updateEntryContent } = await import("../../src/capture/store");
    const { DEFAULTS } = await import("../../src/config");
    const { e, store } = vectorEnv();
    const secret = "SECRET-PLAN ".repeat(140); // ~1,680 chars: any append goes down the long branch
    await seed("e1", { content: secret, vectorIds: [] });
    // The author replaces the text (removing SECRET-PLAN) right after the append read the row.
    const racing = afterOwnRead(e, async () => {
      const r = await updateEntryContent(e, "e1", "short public text", DEFAULTS, undefined, undefined, wctx(), change(), (wctx()).workspaceId);
      expect(r.status).toBe("updated");
    });
    await appendToEntry(racing, "e1", "", "an addition", [], "api", DEFAULTS, undefined, wctx(), change(), undefined, (wctx()).workspaceId);
    const row = await live("e1");
    expect(row.content).toBe("short public text\n\n" + row.content.split("\n\n").slice(1).join("\n\n"));
    // FAILS: the row's vector_ids name chunks embedded from SECRET-PLAN + addition, a text that never committed.
    const described = (JSON.parse(row.vector_ids) as string[]).map(id => String(store.get(id)?.metadata?.content ?? ""));
    expect(described.filter(t => t.includes("SECRET-PLAN"))).toEqual([]);
  });

  it("a short append's chunk is orphaned when an update's embed overwrites vector_ids, and survives forget", async () => {
    const { appendToEntry, updateEntryContent } = await import("../../src/capture/store");
    const { forgetEntry } = await import("../../src/capture/lifecycle");
    const { DEFAULTS } = await import("../../src/config");
    const { e, store } = vectorEnv();
    await seed("e2", { content: "base text", vectorIds: ["e2"] });
    const racing = afterOwnRead(e, async () => {
      await appendToEntry(e, "e2", "", "private addition", [], "api", DEFAULTS, undefined, wctx(), change(), undefined, (wctx()).workspaceId);
    });
    const r = await updateEntryContent(racing, "e2", "replacement", DEFAULTS, undefined, undefined, wctx(), change(), (wctx()).workspaceId);
    expect(r.status).toBe("updated");
    // Nothing indexed under e2 may be missing from its vector_ids (else forget can never find it).
    const listed = new Set(JSON.parse((await live("e2")).vector_ids) as string[]);
    expect([...store.values()].filter(v => v.metadata?.parentId === "e2" || v.id === "e2").map(v => v.id).filter(i => !listed.has(i))).toEqual([]);
    await forgetEntry("e2", e, change(), { reason: "forget", config: DEFAULTS, purge: false }, owner.personalWorkspaceId);
    // FAILS on 5c25183: the append's chunk vector (content "private addition") outlives the memory it belonged to.
    expect([...store.values()].filter(v => v.metadata?.parentId === "e2").map(v => v.metadata.content)).toEqual([]);
  });
});

describe("ADV-6 (MINOR): canRevert approves a version that loadHistory hides from the same reader", () => {
  // Spec rule (1): "V is visible to R (V is in loadHistory(R, E))". canRevert (versions.ts:363) checks only the target
  // row's own workspace, so a company-era version below a personal-era version (unshare, edit, reshare) passes.
  it("an admin non-author cannot be cleared to revert a version cut from their history", async () => {
    const { canRevert, loadHistory } = await import("../../src/memory/versions");
    const admin = await member("Ada", "admin");
    await seed("r1", { content: "now", workspaceId: companyWs, actorId: owner.userId });
    const ins = (seq: number, ws: string) => sqlite.db.prepare(
      `INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, state, actor_id, channel, reason, meta, valid_from, created_at)
       VALUES ('r1', ?, ?, ?, NULL, '[]', '{}', ?, 'rest', 'update', '{}', NULL, ?)`,
    ).bind(ws, seq, `text ${seq}`, owner.userId, 1000 + seq).run();
    await ins(1, companyWs);                  // company era 1
    await ins(2, owner.personalWorkspaceId);  // edited while unshared
    await ins(3, companyWs);                  // reshared, edited again
    const chain = await loadHistory(env, admin, { id: "r1", content: "now" }, 20);
    expect(chain.rows.map(r => r.seq)).toEqual([3]); // v1 is hidden from the admin
    const v1 = (await versions("r1"))[0];
    const visible = chain.rows.map(r => r.seq);
    const entryRow = { workspace_id: companyWs, actor_id: owner.userId };
    // FAILED on 5c25183 ({ ok: true }); the fixed signature takes the reader's own visible chain.
    expect(canRevert(admin, entryRow, v1, 3, visible)).toEqual({ ok: false, code: "unreadable" });
    // Control: the version the admin can see is still revertable by them.
    expect(canRevert(admin, entryRow, (await versions("r1"))[2], 3, visible)).toEqual({ ok: true });
  });
});

describe("ADV-7 (MINOR): a forget during a long append's embed leaves the memory's full text in Vectorize", () => {
  // store.ts long branch: attempt 1 upserts the whole text's chunks, the CAS then misses because the row is gone,
  // and attempt 2 throws EntryGoneError after retiring only the short-branch chunk. updateEntryContent cleans up
  // in the same case (store.ts:260); appendToEntry does not.
  it("no vector of a forgotten memory survives", async () => {
    const { appendToEntry } = await import("../../src/capture/store");
    const { DEFAULTS } = await import("../../src/config");
    const store = new Map<string, any>();
    const vec = makeVectorizeMock({
      upsert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" } as any; }),
      insert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" } as any; }),
      deleteByIds: vi.fn(async (ids: string[]) => { for (const i of ids) store.delete(i); return { mutationId: "m" } as any; }),
    });
    const e = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: vec,
      AI: { run: vi.fn(async (_model: string, opts: any) => ({ data: (Array.isArray(opts?.text) ? opts.text : [opts?.text]).map(() => new Array(768).fill(0.1)) })) } as any })) as Env;
    await seed("g1", { content: "PRIVATE MEDICAL NOTE ".repeat(80), vectorIds: [] });
    // The user forgets the memory while the append is embedding: forget read vector_ids ([]) before the append's
    // storeEntry wrote its chunk ids, and its DELETE commits before the append's batch.
    const raw = e.DB as any;
    let forgot = false;
    const racing = { ...e, DB: { ...raw, prepare(sql: string) {
      if (!forgot && sql.startsWith("INSERT INTO entry_versions")) { forgot = true; void sqlite.deleteFixtureRows(`DELETE FROM entries WHERE id = 'g1'`); }
      return raw.prepare(sql);
    } } } as unknown as Env;
    await expect(appendToEntry(racing, "g1", "", "more", [], "api", DEFAULTS, undefined,
      { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, undefined, ({ workspaceId: owner.personalWorkspaceId, actorId: owner.userId }).workspaceId)).rejects.toThrow();
    expect(await live("g1")).toBeNull();
    // FAILS: the append's chunks (the whole forgotten text) are still indexed.
    expect([...store.values()].filter(v => v.metadata?.parentId === "g1").length).toBe(0);
  });
});

describe("ADV-8 (MINOR): a mirror sync silently reverts a user's concurrent status change", () => {
  // mirror.ts:110: tags come from the JS read; the batch UPDATE has no CAS. Users may set_status on a managed mirror.
  it("the canonical status set during the sync survives it", async () => {
    const { makeMirrorStore } = await import("../../src/integrations/mirror");
    const ms = makeMirrorStore(env, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, undefined, "notion");
    const id = await ms.createEntry("page v1", ["notion"], "notion");
    const raw = env.DB as any;
    let raced = false;
    const racingEnv = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      if (!raced && sql.startsWith("INSERT INTO entry_versions")) {
        raced = true;
        raw.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', tags = '["notion","status:canonical"]' WHERE id = ?`).bind(id).run();
      }
      return raw.prepare(sql);
    } } } as unknown as Env;
    const racingStore = makeMirrorStore(racingEnv, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, undefined, "notion");
    await racingStore.updateEntry(id, "page v2");
    // FAILS: status:canonical is gone from the live row (it survives only inside the mirror's version).
    expect(JSON.parse((await live(id)).tags)).toContain("status:canonical");
  });
});

describe("ADV-9 (MINOR): a digest rollup marks a source the user replaced after the digest read it", () => {
  // digest.ts:62: the mark is `content = content || note, tags += rolled-up` with no compare-and-set on what the
  // digest summarised. A replacement committed during synthesis gets `rolled-up` (0.4x recall, barred from future
  // digests) although the digest never saw its text. store.ts strips rolled-up on a replace for exactly this reason.
  it("the user's new text is not marked rolled-up by a digest that summarised the old text", async () => {
    const digestEnv = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(),
      AI: { run: vi.fn(async (model: string, opts: any) => model === "@cf/google/embeddinggemma-300m" ? { data: (Array.isArray(opts?.text) ? opts.text : [opts?.text]).map(() => new Array(768).fill(0.1)) }
        : new ReadableStream({ start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":"Synthesized text"}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
        } })) } as any,
    })) as Env;
    for (let i = 0; i < 12; i++) await seed(`s${i}`, { content: `Work memory number ${i} with enough detail to be eligible`, tags: ["rocket-project"], createdAt: 1000 + i });
    const db = digestEnv.DB as any;
    const prepare = db.prepare.bind(db);
    let edited = false;
    db.prepare = (sql: string) => {
      if (!edited && sql.startsWith("INSERT INTO entry_versions")) {
        edited = true;
        prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', content = 'Corrected: the launch moved to October', updated_at = 5000 WHERE id = 's0'`).run();
      }
      return prepare(sql);
    };
    await compressTag("rocket-project", digestEnv, ctx);
    const s0 = await live("s0");
    expect(s0.content.startsWith("Corrected: the launch moved to October")).toBe(true);
    expect(JSON.parse(s0.tags)).not.toContain("rolled-up"); // FAILS
  });
});

describe("ADV-11 (MINOR): the owner loses the timeline of their own legacy memory", () => {
  // history.ts: isAuthor requires a non-empty actor_id, and the old seesPrivateHistory (the reader's own personal
  // workspace sees everything) was removed. Legacy rows carry actor_id '' (the owner). A pre-4.0 unshare event has
  // no fromWorkspaceId, so the owner's GET /entry now stops there, although the memory sits in their own workspace.
  it("GET /entry shows the owner every event of a legacy memory in their own personal workspace", async () => {
    const { req } = await import("../helpers/make-request");
    const worker = (await import("../../src/index")).default;
    await seed("L1", { content: "legacy", actorId: "" }); // owner's personal workspace, pre-team author
    const ev = (event: string, at: number, payload: Record<string, unknown>) => env.DB.prepare(
      `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, 'L1', ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), owner.userId, event, JSON.stringify(payload), at).run();
    await ev("updated", 1000, { channel: "rest" });
    await ev("shared", 2000, { workspaceId: companyWs, channel: "rest" });                 // 3.x: no fromWorkspaceId
    await ev("unshared", 3000, { workspaceId: owner.personalWorkspaceId, channel: "rest" }); // 3.x: no fromWorkspaceId
    const res = await worker.fetch(req("POST", "/entry?id=L1"), env, ctx);
    const body = await res.json() as any;
    expect((body.entry ?? body).timeline.map((e: any) => e.event)).toEqual(["updated", "shared", "unshared"]); // FAILS: ["unshared"]
  });
});

describe("ADV-12 (MINOR): a slow append records its version, and updated_at, earlier than the change it follows", () => {
  // store.ts:420: appendToEntry takes `now` BEFORE embedding the addition (it took it after the embed on bb5377f).
  // A write that commits during the embed gets a later timestamp but a lower seq, so seq order and created_at order
  // disagree, valid_from > created_at on the append's version, and entries.updated_at moves backwards.
  it("created_at follows seq, valid_from <= created_at, and updated_at never regresses", async () => {
    const { appendToEntry } = await import("../../src/capture/store");
    const { DEFAULTS } = await import("../../src/config");
    await seed("o1", { content: "base", vectorIds: ["o1"] });
    const wctx = { workspaceId: owner.personalWorkspaceId, actorId: owner.userId };
    const change = { actorId: owner.userId, channel: "mcp" as const };
    const plain = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() })) as Env;
    let raced = false;
    const slow = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({
        // Another client's append commits while this one is inserting its chunk vector.
        insert: vi.fn(async () => {
          if (!raced) { raced = true; await new Promise(r => setTimeout(r, 5)); await appendToEntry(plain, "o1", "", "fast one", [], "api", DEFAULTS, undefined, wctx, change, undefined, (wctx).workspaceId); }
          return { mutationId: "m" } as any;
        }),
      }),
    })) as Env;
    await appendToEntry(slow, "o1", "", "slow one", [], "api", DEFAULTS, undefined, wctx, change, undefined, (wctx).workspaceId);
    const vs = await versions("o1");
    expect(vs.map(v => v.seq)).toEqual([1, 2]);
    const row = await live("o1");
    expect(row.content).toContain("fast one");
    expect(row.content).toContain("slow one");
    expect(vs[1].created_at).toBeGreaterThanOrEqual(vs[0].created_at); // FAILS
    expect(vs[1].valid_from).toBeLessThanOrEqual(vs[1].created_at);     // FAILS
    expect(row.updated_at).toBeGreaterThanOrEqual(vs[0].created_at);    // FAILS
  });
});

// ───────────────────────────── Round 2 (fixes at 7d6f16a7) ─────────────────────────────

describe("R2-1 (MAJOR): the short append stamps prior_length_utf16 from a stale read, and history loses text", () => {
  // store.ts short branch: priorLengthUtf16 = readContent.length, but its guard is tags + workspace only (T-0089.9
  // builds content in SQL precisely because content may have moved on). The delta's prior state is e.content at batch
  // time; buildChain trusts the stamped boundary without checking it against prior_length.
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
      if (!sql.startsWith("SELECT content, tags, source, ")) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => {
        const r = await st.bind(...a).first();
        if (!raced) { raced = true; await appendToEntry(env, "p1", "", "B 🎉 addition", [], "api", DEFAULTS, undefined, wctx, change, undefined, (wctx).workspaceId); }
        return r;
      } }) };
    } } } as unknown as Env;
    await appendToEntry(racing, "p1", "", "A addition", [], "api", DEFAULTS, undefined, wctx, change, undefined, (wctx).workspaceId);

    const row = await live("p1");
    const vs = await versions("p1");
    expect(vs).toHaveLength(2);
    const chain = await loadHistory(env, undefined, { id: "p1", content: row.content }, 20);
    const afterB = row.content.slice(0, row.content.indexOf("\n\n[Update", row.content.indexOf("B 🎉 addition")));
    expect(chain.text(1)).toBe("Base 😀 text");
    // FAILS: the second version reconstructs to "Base 😀 text" (A's stale read) instead of the text with B's addition.
    expect(chain.text(2)).toBe(afterB);
    // Either unstamped (the scan fallback) or exact; never the stale read's length.
    expect([null, afterB.length]).toContain(vs[1].prior_length_utf16);
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
      if (!sql.startsWith("SELECT content, tags, source, ")) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => {
        const r = await st.bind(...a).first();
        if (!raced) { raced = true; await appendToEntry(env, "p2", "", "B 🎉 addition", [], "api", DEFAULTS, undefined, wctx, change, undefined, (wctx).workspaceId); }
        return r;
      } }) };
    } } } as unknown as Env;
    await appendToEntry(racing, "p2", "", "A addition", [], "api", DEFAULTS, undefined, wctx, change, undefined, (wctx).workspaceId);
    const undo = await revertEntry(env, owner, "p2", change, DEFAULTS, undefined, wctx.workspaceId);
    expect(undo.status).toBe("reverted");
    const after = (await live("p2")).content as string;
    expect(after).not.toContain("A addition");
    expect(after).toContain("B 🎉 addition"); // FAILS: the undo of A's append also erased B's
  });
});

describe("R2-2 (MAJOR): a lost update deletes the row's own live vector", () => {
  // store.ts updateEntryContent: on a miss the retry deletes `reembedded.vectorIds` (moved-row exit, superseded
  // embed). Vector ids are deterministic (`id`, `id-chunk-i`), so these are the row's own live ids. The moved-row
  // exit returns not_found without re-embedding; vector_ids still names the deleted vector, so /vectorize-pending
  // never repairs it and the memory is silently semantic-unsearchable.
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
      AI: { run: vi.fn(async (_model: string, opts: any) => ({ data: (Array.isArray(opts?.text) ? opts.text : [opts?.text]).map(() => new Array(768).fill(0.1)) })) } as any })) as Env;
    await seed("v1", { content: "Bob's company note", workspaceId: companyWs, actorId: author.userId, vectorIds: ["v1"] });
    store.set("v1", { id: "v1", values: [0.1], metadata: { content: "Bob's company note", parentId: "v1" } });
    // Bob unshares while the admin's edit is embedding (after its first read, before its batch).
    const raw = e.DB as any;
    let moved = false;
    const racing = { ...e, DB: { ...raw, prepare(sql: string) {
      if (!moved && sql.startsWith("INSERT INTO entry_versions")) {
        moved = true;
        raw.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', workspace_id = ? WHERE id = 'v1'`).bind(author.personalWorkspaceId).run();
      }
      return raw.prepare(sql);
    } } } as unknown as Env;
    const r = await updateEntryContent(racing, "v1", "admin rewrite", DEFAULTS, undefined, undefined,
      { workspaceId: companyWs, actorId: admin.userId }, { actorId: admin.userId, channel: "rest" }, ({ workspaceId: companyWs, actorId: admin.userId }).workspaceId);
    expect(r.status).not.toBe("updated");
    const row = await live("v1");
    expect(row.content).toBe("Bob's company note"); // ADV-2 itself is closed on this path
    for (const vid of JSON.parse(row.vector_ids) as string[]) {
      // FAILS: "v1" was deleted from the index; nothing re-embeds it.
      expect(store.get(vid)?.metadata?.content, vid).toBe("Bob's company note");
    }
  });
});

describe("R2-3 (MAJOR): ADV-2 is still open between the route's authorization and the writer's first read", () => {
  // authorizedWorkspaceId is pinned to updateEntryContent/appendToEntry's OWN first read, not to the row the route
  // authorised (capture.ts: getReadableEntry + assertCanEditContent, then isManagedMirror, writeContextFor and
  // resolveConfig, all awaited I/O). An unshare in that window is pinned as "authorized".
  async function racingRouteRead(moveTo: string, id: string): Promise<Env> {
    const raw = env.DB as any;
    let moved = false;
    return { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      const st = raw.prepare(sql);
      if (moved || !/^SELECT id, workspace_id, actor_id, (content, tags, )?source FROM entries WHERE id = \? AND/.test(sql)) return st;
      return { bind: (...a: unknown[]) => ({ first: async () => {
        const r = await st.bind(...a).first();
        moved = true;
        await sqlite.db.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', workspace_id = ? WHERE id = ?`).bind(moveTo, id).run();
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
    expect(row.content).toBe("Bob's company note"); // FAILS: the admin's text is in Bob's private memory
    expect(res.status).not.toBe(200);
  });

  it("REST /append by an admin", async () => {
    const worker = (await import("../../src/index")).default;
    const { req } = await import("../helpers/make-request");
    const adminTok = (await createMember(env, { name: "Ada", role: "admin" })).token;
    const author = await member("Bob");
    await seed("w2", { content: "Bob's company note", workspaceId: companyWs, actorId: author.userId });
    await worker.fetch(req("POST", "/append", { body: { id: "w2", addition: "admin addition" }, token: adminTok }), await racingRouteRead(author.personalWorkspaceId, "w2"), ctx);
    expect((await live("w2")).content).toBe("Bob's company note"); // FAILS
  });
});

describe("R2-4 (MAJOR): the ADV-11 fix shows the owner's private legacy history to an admin", () => {
  // history.ts isLegacyOwnRow: actor_id '' AND the row sits in the READER's personal workspace. moveEntry lets an
  // admin unshare anyone's company memory into the ADMIN's own personal workspace, so a legacy owner row moved there
  // makes the admin its "author", and visibleTimeline shows every event from the owner's private era.
  it("an admin who unshared the owner's legacy memory does not see its pre-share events", async () => {
    const worker = (await import("../../src/index")).default;
    const { req } = await import("../helpers/make-request");
    const adminTok = (await createMember(env, { name: "Ada", role: "admin" })).token;
    const admin = (await resolveIdentityFromToken(adminTok, env))!;
    await seed("L2", { content: "owner legacy memory", actorId: "", workspaceId: companyWs });
    const ev = (event: string, at: number, payload: Record<string, unknown>) => env.DB.prepare(
      `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, 'L2', ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), owner.userId, event, JSON.stringify(payload), at).run();
    await ev("status_changed", 1000, { status: "canonical", prior: { tags: ["private-owner-tag"] } }); // owner's private era
    await ev("shared", 2000, { workspaceId: companyWs, fromWorkspaceId: owner.personalWorkspaceId, channel: "rest" });
    const moved = await moveEntry("L2", "personal", env, admin, { actorId: admin.userId, channel: "rest" });
    expect(moved.status).toBe("unshared");
    expect((await live("L2")).workspace_id).toBe(admin.personalWorkspaceId);
    const res = await worker.fetch(req("POST", "/entry?id=L2", { token: adminTok }), env, ctx);
    const body = await res.json() as any;
    // FAILS: ["status_changed", "shared", "unshared"]: the owner's private-era event, with its prior tags.
    expect((body.entry ?? body).timeline.map((e: any) => e.event)).not.toContain("status_changed");
  });
});

describe("R2-5 (MINOR): the author sharing their own memory mid-edit turns their edit into a 404", () => {
  // store.ts: a row seen in a different workspace on the retry read returns not_found, which REST reports as
  // 404 "No entry found" for a memory that exists and that the caller may still edit. Nothing is lost (the edit is
  // refused, not dropped silently), but the message is wrong and the edit must be retyped.
  it("REST /update answers 409 (changed while saving), not 404, when the author's own share lands mid-embed", async () => {
    const worker = (await import("../../src/index")).default;
    const { req } = await import("../helpers/make-request");
    await seed("m1", { content: "my note" });
    const raw = env.DB as any;
    let moved = false;
    const racing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      if (!moved && sql.startsWith("INSERT INTO entry_versions")) {
        moved = true;
        raw.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', workspace_id = ? WHERE id = 'm1'`).bind(companyWs).run();
      }
      return raw.prepare(sql);
    } } } as unknown as Env;
    const res = await worker.fetch(req("POST", "/update", { body: { id: "m1", content: "my edited note" } }), racing, ctx);
    expect(res.status).toBe(409); // FAILS: 404 "No memory found with ID: m1"
  });
});

describe("R2-6 (MINOR): version created_at is still not monotonic in seq", () => {
  // 955fc9a moved `now` after the embed, but it is still a Worker clock read before the batch travels to D1. A writer
  // in another isolate whose batch lands first with a later clock inverts the order. Nothing in SQL clamps it.
  it("created_at never decreases with seq, and updated_at never regresses", async () => {
    const { appendToEntry } = await import("../../src/capture/store");
    const { DEFAULTS } = await import("../../src/config");
    await seed("n1", { content: "base", vectorIds: ["n1"] });
    const wctx = { workspaceId: owner.personalWorkspaceId, actorId: owner.userId };
    const change = { actorId: owner.userId, channel: "rest" as const };
    const raw = env.DB as any;
    let raced = false;
    // The other writer's batch reaches D1 while this one's is in flight.
    const slowBatch = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare: raw.prepare.bind(raw), batch: async (stmts: unknown[]) => {
      if (!raced) { raced = true; await new Promise(r => setTimeout(r, 5)); await appendToEntry(env, "n1", "", "other isolate", [], "api", DEFAULTS, undefined, wctx, change, undefined, (wctx).workspaceId); }
      return raw.batch(stmts);
    } } } as unknown as Env;
    await appendToEntry(slowBatch, "n1", "", "this one", [], "api", DEFAULTS, undefined, wctx, change, undefined, (wctx).workspaceId);
    const vs = await versions("n1");
    expect(vs).toHaveLength(2);
    expect(vs[1].created_at).toBeGreaterThanOrEqual(vs[0].created_at); // FAILS
    expect((await live("n1")).updated_at).toBeGreaterThanOrEqual(vs[1].created_at);
  });
});

describe("R2-7 (MAJOR): revertEntry writes into the author's personal memory after an unshare", () => {
  // undo.ts: the UPDATE's only guard is ownSnapshotLandedSql (newest seq + nonce). A move writes no version, so an
  // unshare during the revert's re-embed leaves MAX(seq) unchanged and the admin's revert commits into Bob's
  // private memory, with a revert version stamped Bob's personal workspace naming the admin.
  it("an admin's undo on Bob's company memory does not land after Bob unshares it", async () => {
    const { revertEntry } = await import("../../src/memory/undo");
    const { DEFAULTS } = await import("../../src/config");
    const { updateEntryContent } = await import("../../src/capture/store");
    const admin = await member("Ada", "admin");
    const author = await member("Bob");
    await seed("u9", { content: "v1 text", workspaceId: companyWs, actorId: author.userId });
    const r = await updateEntryContent(env, "u9", "v2 text", DEFAULTS, undefined, undefined, { workspaceId: companyWs, actorId: author.userId }, { actorId: author.userId, channel: "rest" }, ({ workspaceId: companyWs, actorId: author.userId }).workspaceId);
    expect(r.status).toBe("updated");
    const raw = env.DB as any;
    let moved = false;
    const racing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      if (!moved && sql.startsWith("INSERT INTO entry_versions")) {
        moved = true;
        raw.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', workspace_id = ? WHERE id = 'u9'`).bind(author.personalWorkspaceId).run();
      }
      return raw.prepare(sql);
    } } } as unknown as Env;
    await revertEntry(racing, admin, "u9", { actorId: admin.userId, channel: "rest" }, DEFAULTS, undefined, companyWs);
    const row = await live("u9");
    expect(row.workspace_id).toBe(author.personalWorkspaceId);
    expect(row.content).toBe("v2 text"); // FAILS: "v1 text" written into Bob's private memory by the admin
  });
});

// ───────────────────────────── Round 3 (combined branch ced7aac5) ─────────────────────────────

/** Runs `mutate` right after the first read whose SQL matches `pattern` resolves (the route's authorization read). */
function afterFirstRead(base: Env, pattern: RegExp, mutate: () => Promise<void>): Env {
  const raw = base.DB as any;
  let fired = false;
  return { ...base, WRITE_ADMISSION_TOKEN: base.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
    const st = raw.prepare(sql);
    if (fired || !pattern.test(sql)) return st;
    return { bind: (...a: unknown[]) => ({ first: async () => {
      const r = await st.bind(...a).first();
      fired = true;
      await mutate();
      return r;
    } }) };
  } } } as unknown as Env;
}

describe("R3-1 (MAJOR): Delete forever destroys a memory that moved out of the caller's scope after its check", () => {
  // Superseded by nonce-only Delete forever (T-0089.1.1 close-out): a live memory is never deleted
  // forever, so an unshare racing the check has nothing to exploit.
  it("an admin's Delete forever cannot reach Bob's live company memory at all", async () => {
    const worker = (await import("../../src/index")).default;
    const { req } = await import("../helpers/make-request");
    const adminTok = (await createMember(env, { name: "Ada", role: "admin" })).token;
    const author = await member("Bob");
    await seed("x1", { content: "Bob's note", workspaceId: companyWs, actorId: author.userId });
    const res = await worker.fetch(req("POST", "/forget", { body: { id: "x1", permanent: true, confirm: "x1" }, token: adminTok }), env, ctx);
    expect(res.status).toBe(400);
    expect((await live("x1"))?.workspace_id).toBe(companyWs);
  });
});

describe("R3-2 (MAJOR): an admin's unshare can take a member's already-private memory", () => {
  // capture/share.ts moveEntry: a scoped read, then `UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', workspace_id = ? WHERE id = ?` with no pin on
  // the workspace it read. When Bob unshares his company memory in the gap between an admin's read and batch, the
  // admin's batch moves Bob's PRIVATE memory into the admin's own personal workspace: the admin now reads it, Bob
  // no longer can. (The move event is conditional on `e.workspace_id <> target`, the move itself is not.)
  it("REST /share personal by an admin does not move a row Bob already made private", async () => {
    const worker = (await import("../../src/index")).default;
    const { req } = await import("../helpers/make-request");
    const adminTok = (await createMember(env, { name: "Ada", role: "admin" })).token;
    const admin = (await resolveIdentityFromToken(adminTok, env))!;
    const author = await member("Bob");
    await seed("x2", { content: "Bob's note", workspaceId: companyWs, actorId: author.userId });
    const racing = afterFirstRead(env, /^SELECT id, workspace_id, actor_id, vector_ids, tags FROM entries WHERE id = \? AND/, async () => {
      await sqlite.db.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', workspace_id = ? WHERE id = 'x2'`).bind(author.personalWorkspaceId).run();
    });
    await worker.fetch(req("POST", "/share", { body: { id: "x2", workspace: "personal" }, token: adminTok }), racing, ctx);
    const row = await live("x2");
    expect(row.workspace_id).not.toBe(admin.personalWorkspaceId); // FAILS: Bob's private memory now sits in the admin's
    expect(row.workspace_id).toBe(author.personalWorkspaceId);
  });
});

describe("R3-3 (MINOR): restoreRowVectors orphans the chunks of the appends that beat the update", () => {
  // store.ts restoreRowVectors: stale = caller's oldVectorIds ∪ merged, minus the re-embed; the row's CURRENT
  // vector_ids (holding each winning short append's `id-update-<ts>` chunk) is read but never consulted, and the
  // unconditional `vector_ids = ?` overwrite drops those chunk ids. They stay in Vectorize under no row's list, so
  // forget and Delete forever can never find them (the ADV-4/ADV-7 class, now on the conflict path).
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
      AI: { run: vi.fn(async (_model: string, opts: any) => ({ data: (Array.isArray(opts?.text) ? opts.text : [opts?.text]).map(() => new Array(768).fill(0.1)) })) } as any })) as Env;
    const ws = owner.personalWorkspaceId;
    const wctx = { workspaceId: ws, actorId: owner.userId };
    const change = { actorId: owner.userId, channel: "rest" as const };
    await seed("e3", { content: "base", vectorIds: ["e3"] });
    store.set("e3", { id: "e3", values: [0.1], metadata: { content: "base", parentId: "e3" } });
    let n = 0;
    const raw = e.DB as any;
    const racing = { ...e, DB: { ...raw, prepare(sql: string) {
      const st = raw.prepare(sql);
      if (!sql.startsWith("SELECT content, tags, source, ")) return st;
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
    expect(unlisted).toEqual([]); // FAILS: the three e3-update-<ts> chunks
  });
});

describe("R3-4 (MAJOR): the owner inherits a member's private history of a system row they unshare", () => {
  // history.ts isLegacyOwnRow (a6e084e7): actor_id '' + reader is the tenant owner + row in the owner's personal
  // workspace. actor_id '' is not only a pre-team legacy row: every digest and auto-insight is written with actor ''
  // (isSystemRow), in the workspace of the member it summarises. Bob shares his digest; the owner (an admin)
  // unshares it into the OWNER's personal workspace (moveEntry allows it) and now reads Bob's private-era events.
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
    // FAILS: the owner sees "status_changed" (Bob's private-era event, with its prior tags).
    expect((body.entry ?? body).timeline.map((e: any) => e.event)).not.toContain("status_changed");
  });
});

// ───────────────────────────── Round 4 (f85e908e) ─────────────────────────────

describe("R4-1 (MINOR): a move that loses its pinned UPDATE still records a move event", () => {
  // capture/share.ts moveEntry: the entries and edges UPDATEs are pinned to the read workspace (b35f6b0a), but the
  // event INSERT in the same batch is still guarded only by `e.workspace_id <> target`. When the row moved to a third
  // workspace in the gap, the UPDATE misses (409 conflict) while an "unshared" event by the admin is written anyway,
  // claiming a move that never happened (it shows in the admin compliance feed and the entry timeline).
  it("the 409 conflict writes no move event for the caller", async () => {
    const worker = (await import("../../src/index")).default;
    const { req } = await import("../helpers/make-request");
    const adminTok = (await createMember(env, { name: "Ada", role: "admin" })).token;
    const admin = (await resolveIdentityFromToken(adminTok, env))!;
    const author = await member("Bob");
    await seed("x4", { content: "Bob's note", workspaceId: companyWs, actorId: author.userId });
    const racing = afterFirstRead(env, /^SELECT id, workspace_id, actor_id, vector_ids, tags FROM entries WHERE id = \? AND/, async () => {
      await sqlite.db.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', workspace_id = ? WHERE id = 'x4'`).bind(author.personalWorkspaceId).run();
    });
    const res = await worker.fetch(req("POST", "/share", { body: { id: "x4", workspace: "personal" }, token: adminTok }), racing, ctx);
    expect(res.status).toBe(409);
    expect((await live("x4")).workspace_id).toBe(author.personalWorkspaceId);
    const evs = (await env.DB.prepare(`SELECT actor_id, event FROM entry_events WHERE entry_id = 'x4'`).all()).results as any[];
    expect(evs.filter(e => e.actor_id === admin.userId)).toEqual([]); // FAILS: [{ event: "unshared" }] for a move that did not happen
  });
});

describe("R4-2 (MINOR): /vectorize-pending racing an edit lists vectors of text the row no longer holds (found via the code graph)", () => {
  // routes/admin.ts /vectorize-pending -> storeEntry (store.ts): embeds the content it read, upserts under the row's
  // deterministic ids, then `UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', vector_ids = ? WHERE id = ?` with no compare-and-set. An update that
  // commits during that embed is overwritten in the index by the older text, and vector_ids is now non-empty, so
  // /vectorize-pending (vector_ids = '[]') never looks at the row again. /migration/reembed calls storeEntry the same way.
  it("after the repair and a concurrent update, the row's listed vector describes its committed content", async () => {
    const worker = (await import("../../src/index")).default;
    const { req } = await import("../helpers/make-request");
    const { updateEntryContent } = await import("../../src/capture/store");
    const { DEFAULTS } = await import("../../src/config");
    const store = new Map<string, any>();
    const vec = makeVectorizeMock({
      upsert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" } as any; }),
      insert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" } as any; }),
      deleteByIds: vi.fn(async (ids: string[]) => { for (const i of ids) store.delete(i); return { mutationId: "m" } as any; }),
    });
    const plain = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: vec,
      AI: { run: vi.fn(async (_model: string, opts: any) => ({ data: (Array.isArray(opts?.text) ? opts.text : [opts?.text]).map(() => new Array(768).fill(0.1)) })) } as any })) as Env;
    let raced = false;
    const repairEnv = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: vec,
      AI: { run: vi.fn(async () => {
        // The author edits the memory while the repair is embedding its old text.
        if (!raced) { raced = true; await updateEntryContent(plain, "vp1", "the corrected text", DEFAULTS, undefined, undefined,
          { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId); }
        return { data: [new Array(768).fill(0.1)] };
      }) } as any })) as Env;
    await seed("vp1", { content: "the original text", vectorIds: [], createdAt: 1000 });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), repairEnv, ctx);
    expect(res.status).toBe(200);
    const row = await live("vp1");
    expect(row.content).toBe("the corrected text");
    const listed = JSON.parse(row.vector_ids) as string[];
    expect(listed.length).toBeGreaterThan(0); // so /vectorize-pending will never revisit it
    // FAILS: "the original text": the repair's stale upsert and unconditional vector_ids write won.
    for (const id of listed) expect(store.get(id)?.metadata?.content, id).toBe("the corrected text");
  });

  it("after /migration/reembed and a concurrent update, the row's listed vector describes its committed content", async () => {
    const worker = (await import("../../src/index")).default;
    const { req } = await import("../helpers/make-request");
    const { updateEntryContent } = await import("../../src/capture/store");
    const { DEFAULTS } = await import("../../src/config");
    const store = new Map<string, any>();
    const vec = makeVectorizeMock({
      upsert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" } as any; }),
      insert: vi.fn(async (vs: any[]) => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" } as any; }),
      deleteByIds: vi.fn(async (ids: string[]) => { for (const i of ids) store.delete(i); return { mutationId: "m" } as any; }),
    });
    const plain = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: vec,
      AI: { run: vi.fn(async (_model: string, opts: any) => ({ data: (Array.isArray(opts?.text) ? opts.text : [opts?.text]).map(() => new Array(768).fill(0.1)) })) } as any })) as Env;
    let raced = false;
    const repairEnv = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: vec,
      AI: { run: vi.fn(async () => {
        // The author edits the memory while the migration batch is embedding its old text.
        if (!raced) { raced = true; await updateEntryContent(plain, "rb1", "the corrected text", DEFAULTS, undefined, undefined,
          { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId); }
        return { data: [new Array(768).fill(0.1)] };
      }) } as any })) as Env;
    await seed("rb1", { content: "the original text", vectorIds: [], createdAt: 1000 });
    const res = await worker.fetch(req("POST", "/migration/reembed"), repairEnv, ctx);
    expect(res.status).toBe(200);
    const row = await live("rb1");
    expect(row.content).toBe("the corrected text");
    const listed = JSON.parse(row.vector_ids) as string[];
    expect(listed.length).toBeGreaterThan(0); // so the ledger does not stay stuck describing stale text
    // FAILS pre-fix: "the original text": the batch's stale upsert and unconditional vector_ids write won.
    for (const id of listed) expect(store.get(id)?.metadata?.content, id).toBe("the corrected text");
  });
});
