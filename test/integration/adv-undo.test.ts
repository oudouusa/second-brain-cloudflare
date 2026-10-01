// Adversary reproductions for revertEntry (T-0089.1.3). Each test asserts the CORRECT behaviour,
// so each one fails on 7d6f16a7 until its finding is fixed.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeAIMock, makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import { captureEntry } from "../../src/capture/entry";
import { appendToEntry, updateEntryContent } from "../../src/capture/store";
import { forgetEntry } from "../../src/capture/lifecycle";
import { moveEntry } from "../../src/capture/share";
import { resolveEntryAction } from "../../src/memory/actions";
import { revertEntry } from "../../src/memory/undo";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const stream = (text: string) => new ReadableStream({ start(c) {
  c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
  c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
} });

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
let store: Map<string, { id: string; values: number[]; metadata: Record<string, unknown> }>;

function statefulVectorize(matchId?: string) {
  store = new Map();
  const overrides: Record<string, unknown> = {
    upsert: vi.fn(async (vs: any[]): Promise<any> => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" }; }),
    insert: vi.fn(async (vs: any[]): Promise<any> => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" }; }),
    deleteByIds: vi.fn(async (ids: string[]): Promise<any> => { for (const i of ids) store.delete(i); return { mutationId: "m" }; }),
    getByIds: vi.fn(async (ids: string[]): Promise<any> => ids.map(i => store.get(i)).filter(Boolean)),
  };
  if (matchId) overrides.query = vi.fn().mockResolvedValue({ matches: [{ id: matchId, score: 0.9, metadata: { parentId: matchId } }] });
  return makeVectorizeMock(overrides as any);
}
const decisionAI = (decision: string) =>
  ({ run: vi.fn(async (model: string) => model === "@cf/google/embeddinggemma-300m" ? { data: [new Array(768).fill(0.1)] } : stream(decision)) }) as any;

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: statefulVectorize(), AI: makeAIMock() }));
  await initializeDatabase(env);
  env = sqlite.admitEnv(env);
  const roots = await ensureTenantBootstrap(env);
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
});
afterEach(() => sqlite.close());

const seed = (id: string, over: Record<string, unknown> = {}) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, when_at, when_kind, when_label, when_source)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(
  id, over.content ?? "text", JSON.stringify(over.tags ?? []), over.source ?? "api", over.createdAt ?? 1000, over.updatedAt ?? null,
  JSON.stringify(over.vectorIds ?? [id]), over.workspaceId ?? owner.personalWorkspaceId, over.actorId ?? owner.userId,
  over.whenAt ?? null, over.whenKind ?? null, over.whenLabel ?? null, over.whenSource ?? null,
).run();
const row = (id: string) => sqlite.rows().find((r: any) => r.id === id) as any;
const versions = async (id: string) => (await env.DB.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const change = (who: Identity = owner, channel: "rest" | "mcp" = "rest") => ({ actorId: who.userId, channel });
const member = async (name: string) => (await resolveIdentityByUserId(env, (await createMember(env, { name })).member.userId))!;

/** Runs `race` once, just before the revert's own [snapshot, UPDATE, prune] batch reaches the database. */
function beforeRevertBatch(base: Env, race: () => Promise<void>): Env {
  const raw = base.DB as any;
  let fired = false;
  const db = {
    ...raw,
    prepare: (sql: string) => raw.prepare(sql),
    batch: async (stmts: any[]) => {
      const isRevert = stmts.some(s => typeof s.sourceSql === "function" && s.sourceSql().includes("json_extract(ov.meta, '$.nonce')"));
      if (isRevert && !fired) { fired = true; await race(); }
      return raw.batch(stmts);
    },
  };
  return { ...base, WRITE_ADMISSION_TOKEN: base.WRITE_ADMISSION_TOKEN, DB: db } as unknown as Env;
}

describe("ADV-U1 (MAJOR): undo of a forget skips the author lock that POST /restore enforces", () => {
  it("a member cannot bring back a company memory another member deleted", async () => {
    const roots = await ensureTenantBootstrap(env);
    const alice = await member("Alice");
    const bob = await member("Bob");
    await seed("cf1", { content: "Alice's company note", workspaceId: roots.companyWorkspaceId, actorId: alice.userId });
    expect((await forgetEntry("cf1", env, change(alice), { reason: "forget", config: DEFAULTS, purge: false }, roots.companyWorkspaceId)).status).toBe("deleted");

    // POST /restore answers Bob 403 (assertCanMutateEntry, routes/entries.ts:233-234). Undo must too.
    const r = await revertEntry(env, bob, "cf1", change(bob), DEFAULTS, undefined, roots.companyWorkspaceId);
    expect(r.status).toBe("forbidden");
    expect(row("cf1")).toBeUndefined();
  });
});

describe("ADV-U2 (MAJOR): a revert that restored when_* does not say so, so undoing it leaves when_* behind", () => {
  it("undo twice redoes a snooze", async () => {
    await seed("d1", { content: "dentist", whenAt: 1000, whenKind: "event", whenLabel: "old", whenSource: "regex" });
    const until = Date.now() + 86_400_000;
    await resolveEntryAction(env, ctx, owner, "d1", "snooze", new Date(until).toISOString(), change());
    expect((await revertEntry(env, owner, "d1", change(), DEFAULTS, undefined, owner.personalWorkspaceId)).status).toBe("reverted");
    expect(row("d1").when_at).toBe(1000);

    const redo = await revertEntry(env, owner, "d1", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(redo.status).toBe("reverted"); // actual: no_change
    expect(row("d1").when_at).toBe(until);
  });

  it("undo twice redoes an append that carried a when", async () => {
    await seed("aw1", { content: "call Sam" });
    await appendToEntry(env, "aw1", "call Sam", "on Friday", [], "api", DEFAULTS, undefined,
      { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), { at: 5_000_000, kind: "due" }, owner.personalWorkspaceId);
    expect(row("aw1").when_at).toBe(5_000_000);
    await revertEntry(env, owner, "aw1", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(row("aw1")).toMatchObject({ content: "call Sam", when_at: null });

    await revertEntry(env, owner, "aw1", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(row("aw1").content).toContain("on Friday");
    expect(row("aw1").when_at).toBe(5_000_000); // actual: null — the text came back, its date did not
  });

  it("undoing a to_version rollback puts when_* back too", async () => {
    await seed("t1", { content: "v1", whenAt: 100, whenKind: "due" });
    await updateEntryContent(env, "t1", "v2", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    const until = Date.now() + 86_400_000;
    await resolveEntryAction(env, ctx, owner, "t1", "snooze", new Date(until).toISOString(), change());
    const first = (await versions("t1"))[0].seq;
    expect((await revertEntry(env, owner, "t1", change(), DEFAULTS, first, owner.personalWorkspaceId)).status).toBe("reverted");
    expect(row("t1")).toMatchObject({ content: "v1", when_at: 100 });

    // "That rollback was a mistake": a plain undo.
    expect((await revertEntry(env, owner, "t1", change(), DEFAULTS, undefined, owner.personalWorkspaceId)).status).toBe("reverted");
    expect(row("t1").content).toBe("v2");
    expect(row("t1").when_at).toBe(until); // actual: 100
  });
});

describe("ADV-U3 (MAJOR): the revert's guard ignores workspace, so it commits into a row that moved out of reach", () => {
  it("an admin's undo does not land in a row its author just took back into their personal workspace", async () => {
    const roots = await ensureTenantBootstrap(env);
    const alice = await member("Alice");
    await seed("mv1", { content: "shared draft", workspaceId: roots.companyWorkspaceId, actorId: alice.userId });
    await updateEntryContent(env, "mv1", "shared draft, revised", DEFAULTS, undefined, undefined, { workspaceId: roots.companyWorkspaceId, actorId: alice.userId }, change(alice), roots.companyWorkspaceId);

    // The owner (admin) undoes Alice's revision; Alice unshares the memory while the undo re-embeds.
    const racing = beforeRevertBatch(env, async () => {
      expect((await moveEntry("mv1", "personal", env, alice, change(alice))).status).toBe("unshared");
    });
    const r = await revertEntry(racing, owner, "mv1", change(), DEFAULTS, undefined, roots.companyWorkspaceId);

    expect(row("mv1").workspace_id).toBe(alice.personalWorkspaceId);
    // updateEntryContent guards on workspace_id for exactly this (ADV-2). The revert must miss too.
    expect(r.status).not.toBe("reverted");
    expect(row("mv1").content).toBe("shared draft, revised");
    const vs = await versions("mv1");
    expect(vs.filter(v => v.actor_id === owner.userId)).toEqual([]); // actual: an admin-authored version in Alice's personal workspace
  });
});

describe("ADV-U4 (MINOR): merge undo is not symmetric", () => {
  const decision = JSON.stringify({ action: "merge", target_id: "old", merged_content: "Old text. Incoming fact." });
  const mergeEnv = () => sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as any, OAUTH_KV: makeMemoryKV(), VECTORIZE: statefulVectorize("old"), AI: decisionAI(decision),
  })) as Env;

  it("undo twice (redo) of a merge keeps the re-created row and reports it (T-0089.1.3 round 3: redo never removes it)", async () => {
    const e = mergeEnv();
    await seed("old", { content: "Old text", tags: ["work"] });
    expect((await captureEntry("Incoming fact", [], "api", e, ctx, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, undefined, { channel: "rest" })).status).toBe("merged");
    const undo = await revertEntry(e, owner, "old", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    const recreated = (undo as any).recreatedIncomingId as string;
    expect(row(recreated).content).toBe("Incoming fact");

    const redo = await revertEntry(e, owner, "old", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(redo.status).toBe("reverted");
    expect(row("old").content).toBe("Old text. Incoming fact.");
    // Redo restores the merged text but leaves the re-created row exactly alone: the fact now
    // legitimately lives in both places, and the result says so instead of silently removing one.
    expect(row(recreated).content).toBe("Incoming fact");
    expect((redo as any).keptIncoming).toEqual([{ id: recreated, reason: "re-created earlier" }]);
  });

  it("to_version past a merge keeps the incoming fact somewhere live", async () => {
    const e = mergeEnv();
    await seed("old", { content: "Old text", tags: ["work"] });
    await captureEntry("Incoming fact", [], "api", e, ctx, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, undefined, { channel: "rest" });
    const mergeSeq = (await versions("old"))[0].seq;
    await updateEntryContent(e, "old", "Old text. Incoming fact. Edited.", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    const r = await revertEntry(e, owner, "old", change(), DEFAULTS, mergeSeq, owner.personalWorkspaceId);
    expect(r.status).toBe("reverted");
    expect(row("old").content).toBe("Old text");
    // The captured fact is now in no live row; only the revert's version still holds it.
    expect(sqlite.rows().some((x: any) => x.content === "Incoming fact")).toBe(true);
  });
});

describe("ADV-U5 (MINOR): statement budget", () => {
  it("a content-changing undo costs read + history read + 1 batch + audit", async () => {
    await seed("b1", { content: "before" });
    await updateEntryContent(env, "b1", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    await ensureTenantBootstrap(env);
    const raw = env.DB as any;
    const executed: string[] = [];
    const counting = {
      ...raw,
      prepare: (sql: string) => {
        const st = raw.prepare(sql);
        const wrap = (s: any): any => ({
          ...s, sourceSql: () => sql,
          bind: (...a: unknown[]) => wrap(s.bind(...a)),
          run: () => { executed.push(sql); return s.run(); },
          first: (c?: string) => { executed.push(sql); return s.first(c); },
          all: () => { executed.push(sql); return s.all(); },
          raw: () => s,
        });
        return wrap(st);
      },
      batch: (stmts: any[]) => { executed.push(`BATCH(${stmts.length})`); return raw.batch(stmts.map((s: any) => s.raw())); },
    };
    const r = await revertEntry({ ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: counting } as unknown as Env, owner, "b1", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(r.status).toBe("reverted");
    // 認可済みupload journalと所有確認の費用を含む。
    expect(executed).toHaveLength(16);
    expect(executed.length).toBeLessThanOrEqual(50);
  });
});

describe("ADV-U6 (MINOR): a failed revert batch leaves the index describing text that never committed", () => {
  it("vectors match the live row after the batch throws", async () => {
    await seed("vf1", { content: "before" });
    await updateEntryContent(env, "vf1", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    // Per-upload vector ids (T-0089.1.1): read the vector the row lists, not one named after the entry.
    const listedVf1 = () => (JSON.parse(row("vf1").vector_ids) as string[])[0];
    expect(store.get(listedVf1())?.metadata.content).toBe("after");
    const raw = env.DB as any;
    const failing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare: (s: string) => raw.prepare(s), batch: async (stmts: any[]) => {
      if (stmts.some(s => s.sourceSql?.().includes("json_extract(ov.meta, '$.nonce')"))) throw new Error("D1_ERROR: storage operation exceeded timeout");
      return raw.batch(stmts);
    } } } as unknown as Env;
    await expect(revertEntry(failing, owner, "vf1", change(), DEFAULTS, undefined, owner.personalWorkspaceId)).rejects.toThrow();
    expect(row("vf1").content).toBe("after");
    expect(store.get(listedVf1())?.metadata.content).toBe("after");
  });
});

describe("ADV-U7 (MINOR): undo silently erases a when_* the when pass wrote while it was re-embedding", () => {
  it("a date extracted between the undo's read and its batch survives an undo of an unrelated text edit", async () => {
    await seed("w1", { content: "lunch" });
    await updateEntryContent(env, "w1", "lunch with Ana", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    const racing = beforeRevertBatch(env, async () => {
      // src/when/pass.ts:367 — unversioned
      await env.DB.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', when_at = ?, when_kind = ?, when_source = 'model', when_label = ? WHERE id = ?`).bind(7_000_000, "event", "lunch", "w1").run();
    });
    expect((await revertEntry(racing, owner, "w1", change(), DEFAULTS, undefined, owner.personalWorkspaceId)).status).toBe("reverted");
    expect(row("w1").content).toBe("lunch");
    // The undo target (an update) never touched when_*; the undo rebinds its stale JS read instead.
    expect(row("w1").when_at).toBe(7_000_000); // actual: null
  });
});
