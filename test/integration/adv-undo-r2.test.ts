// Round-2 adversary reproductions for revertEntry (T-0089.1.3), against the fixes at 9b9514b5.
// Each test asserts the CORRECT behaviour, so each one fails until its finding is fixed.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeAIMock, makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import { captureEntry } from "../../src/capture/entry";
import { appendToEntry, updateEntryContent } from "../../src/capture/store";
import { applyStatus, forgetEntry } from "../../src/capture/lifecycle";
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


const decision = (target: string) => JSON.stringify({ action: "merge", target_id: target, merged_content: "Old text. Incoming fact." });
const mergeEnv = (target: string) => sqlite.admitEnv(makeTestEnv(undefined, {
  DB: sqlite.db as any, OAUTH_KV: makeMemoryKV(), VECTORIZE: statefulVectorize(target), AI: decisionAI(decision(target)),
})) as Env;
const trashed = async (id: string) => env.DB.prepare(`SELECT id FROM entries_trash WHERE id = ?`).bind(id).first();

// T-0089.1.3 round 3 (Director decision): redo of a merge undo no longer removes the row that undo
// created. It restores the merged text and leaves that row exactly alone, always reporting it as
// keptIncoming, so the U8/U9 scenarios below assert the new semantics rather than the old removal
// guard (which produced its own regression, ADV-U13).
describe("ADV-U8 (MAJOR, superseded by the round-3 simplification): redo never touches the re-created row, whatever has happened to it since", () => {
  it("redo keeps (and reports) a re-created memory its author moved into their own personal workspace", async () => {
    const roots = await ensureTenantBootstrap(env);
    const alice = await member("Alice");
    const bob = await member("Bob");
    const e = mergeEnv("old");
    await seed("old", { content: "Old text", tags: ["work"], workspaceId: roots.companyWorkspaceId, actorId: alice.userId });
    // Bob's company capture merges into Alice's company memory.
    expect((await captureEntry("Incoming fact", [], "api", e, ctx, undefined, { workspaceId: roots.companyWorkspaceId, actorId: bob.userId }, undefined, { channel: "rest" })).status).toBe("merged");
    // Alice undoes: Bob's fact comes back as its own company row, authored by Bob.
    const undo = await revertEntry(e, alice, "old", change(alice), DEFAULTS, undefined, roots.companyWorkspaceId);
    const x = (undo as any).recreatedIncomingId as string;
    expect(row(x)).toMatchObject({ actor_id: bob.userId, workspace_id: roots.companyWorkspaceId });
    // Bob takes his memory private.
    expect((await moveEntry(x, "personal", env, bob, change(bob))).status).toBe("unshared");

    // Alice redoes. Redo never touches x at all, so it does not matter that she cannot even read it.
    const redo = await revertEntry(e, alice, "old", change(alice), DEFAULTS, undefined, roots.companyWorkspaceId);
    expect(redo.status).toBe("reverted");
    expect(row(x)).toBeDefined();
    expect(row(x).workspace_id).toBe(bob.personalWorkspaceId);
    expect(await trashed(x)).toBeNull();
    expect((redo as any).keptIncoming).toEqual([{ id: x, reason: "re-created earlier" }]);
  });

  it("redo keeps (and reports) a re-created memory someone else has since edited", async () => {
    const roots = await ensureTenantBootstrap(env);
    const alice = await member("Alice");
    const bob = await member("Bob");
    const e = mergeEnv("old");
    await seed("old", { content: "Old text", tags: ["work"], workspaceId: roots.companyWorkspaceId, actorId: alice.userId });
    await captureEntry("Incoming fact", [], "api", e, ctx, undefined, { workspaceId: roots.companyWorkspaceId, actorId: bob.userId }, undefined, { channel: "rest" });
    const x = ((await revertEntry(e, alice, "old", change(alice), DEFAULTS, undefined, roots.companyWorkspaceId)) as any).recreatedIncomingId as string;
    // Bob builds on his re-created memory. Alice could not forget it herself (author lock).
    await updateEntryContent(e, x, "Incoming fact, with Bob's follow-up notes", DEFAULTS, undefined, undefined, { workspaceId: roots.companyWorkspaceId, actorId: bob.userId }, change(bob), roots.companyWorkspaceId);
    expect(row(x).content).toContain("follow-up");

    const redo = await revertEntry(e, alice, "old", change(alice), DEFAULTS, undefined, roots.companyWorkspaceId);
    expect(redo.status).toBe("reverted");
    expect(row(x)?.content).toContain("follow-up");
    expect((redo as any).keptIncoming).toEqual([{ id: x, reason: "re-created earlier" }]);
  });
});

describe("ADV-U9 (MINOR, superseded by the round-3 simplification): a merge's incoming is re-created at most once", () => {
  it("undo, redo, undo keeps exactly one live copy of the re-created fact", async () => {
    const e = mergeEnv("old");
    await seed("old", { content: "Old text", tags: ["work"] });
    await captureEntry("Incoming fact", [], "api", e, ctx, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, undefined, { channel: "rest" });
    const undo1 = await revertEntry(e, owner, "old", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    const x = (undo1 as any).recreatedIncomingId as string;
    expect(row(x).content).toBe("Incoming fact");

    const redo = await revertEntry(e, owner, "old", change(), DEFAULTS, undefined, owner.personalWorkspaceId); // redo: merged text restored, x kept
    expect(redo.status).toBe("reverted");
    expect(row(x)).toBeDefined();
    expect((redo as any).keptIncoming).toEqual([{ id: x, reason: "re-created earlier" }]);

    const undo2 = await revertEntry(e, owner, "old", change(), DEFAULTS, undefined, owner.personalWorkspaceId); // undo again
    expect(undo2.status).toBe("reverted");
    expect(row("old").content).toBe("Old text");
    // Exactly one live copy of the fact throughout: no re-creation happens twice.
    expect(sqlite.rows().filter((r: any) => r.content === "Incoming fact")).toHaveLength(1);
    expect((undo2 as any).recreatedIncomingId).toBeUndefined();
    expect((undo2 as any).keptIncoming).toEqual([{ id: x, reason: "re-created earlier" }]);
  });
});

describe("ADV-U10 (MINOR): to_version re-creation covers only a target that IS the merge", () => {
  it("a rollback to a version older than the merge still re-creates the incoming row", async () => {
    const e = mergeEnv("old");
    await seed("old", { content: "Old", tags: ["work"] });
    await updateEntryContent(e, "old", "Old text", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    const beforeMerge = (await versions("old"))[0].seq; // the state "Old"
    await captureEntry("Incoming fact", [], "api", e, ctx, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, undefined, { channel: "rest" });
    expect(row("old").content).toBe("Old text. Incoming fact.");
    expect((await revertEntry(e, owner, "old", change(), DEFAULTS, beforeMerge, owner.personalWorkspaceId)).status).toBe("reverted");
    expect(row("old").content).toBe("Old");
    expect(sqlite.rows().some((r: any) => r.content === "Incoming fact")).toBe(true); // actual: false
  });

  it("rolling back to the merge twice does not re-create the incoming row twice", async () => {
    const e = mergeEnv("old");
    await seed("old", { content: "Old text", tags: ["work"] });
    await captureEntry("Incoming fact", [], "api", e, ctx, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, undefined, { channel: "rest" });
    const mergeSeq = (await versions("old"))[0].seq;
    await updateEntryContent(e, "old", "Old text. Incoming fact. Edited.", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    expect((await revertEntry(e, owner, "old", change(), DEFAULTS, mergeSeq, owner.personalWorkspaceId)).status).toBe("reverted");
    await updateEntryContent(e, "old", "Old text, edited again", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    expect((await revertEntry(e, owner, "old", change(), DEFAULTS, mergeSeq, owner.personalWorkspaceId)).status).toBe("reverted");
    expect(sqlite.rows().filter((r: any) => r.content === "Incoming fact")).toHaveLength(1); // actual: 2
  });
});

describe("ADV-U11 (MINOR): vector_ids is still rebound from the undo's stale read", () => {
  it("a re-index that lands mid-undo is not erased by an undo that did not re-embed", async () => {
    await seed("vi1", { content: "fact", tags: ["work"], vectorIds: [] }); // keyword-only: waiting for /vectorize-pending
    await applyStatus("vi1", "canonical", env, change(), DEFAULTS, owner.personalWorkspaceId);
    const racing = beforeRevertBatch(env, async () => {
      // the pending re-index (storeEntry's unversioned vector_ids write) lands while the undo is in flight
      await env.DB.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', vector_ids = ? WHERE id = ?`).bind(JSON.stringify(["vi1"]), "vi1").run();
    });
    expect((await revertEntry(racing, owner, "vi1", change(), DEFAULTS, undefined, owner.personalWorkspaceId)).status).toBe("reverted");
    expect(JSON.parse(row("vi1").tags)).not.toContain("status:canonical");
    expect(row("vi1").vector_ids).toBe(JSON.stringify(["vi1"])); // actual: "[]"
  });
});

describe("ADV-U12 (MINOR): a lost revert deletes the row's live vectors before it knows the row is still there", () => {
  it("a stale undo whose follow-up read fails leaves the winner's vectors in the index", async () => {
    await seed("lv1", { content: "one" });
    await updateEntryContent(env, "lv1", "two", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    // A concurrent edit wins the race; its vectors live under the same deterministic id, "lv1".
    const racing = beforeRevertBatch(env, async () => {
      expect((await updateEntryContent(env, "lv1", "three", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId)).status).toBe("updated");
    });
    const raw = racing.DB as any;
    const flaky = { ...racing, DB: { ...raw, prepare: (sql: string) => {
      if (sql.startsWith("SELECT 1 AS ok FROM entries")) throw new Error("D1_ERROR: Network connection lost.");
      return raw.prepare(sql);
    } } } as unknown as Env;
    await expect(revertEntry(flaky, owner, "lv1", change(), DEFAULTS, undefined, owner.personalWorkspaceId)).rejects.toThrow();
    expect(row("lv1")).toMatchObject({ content: "three" });
    // Per-upload vector ids (T-0089.1.1): whatever the lost undo deleted, the winner's listed vector is intact.
    const listed = JSON.parse(row("lv1").vector_ids) as string[];
    expect(listed).toHaveLength(1);
    expect(store.get(listed[0])?.metadata.content).toBe("three");
  });
});
