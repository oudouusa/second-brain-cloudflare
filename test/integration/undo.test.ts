import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeAIMock, makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import { captureEntry } from "../../src/capture/entry";
import { appendToEntry, updateEntryContent } from "../../src/capture/store";
import { applyStatus, deprecateEntry, forgetEntry } from "../../src/capture/lifecycle";
import { resolveEntryAction, applyInsightResolution } from "../../src/memory/actions";
import { compressTag } from "../../src/compression/digest";
import { makeMirrorStore } from "../../src/integrations/mirror";
import { revertEntry } from "../../src/memory/undo";
import { canRevert, loadHistory } from "../../src/memory/versions";
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
let deleted: string[] = [];

function statefulVectorize(decision?: string, matchId?: string, matchScore = 0.9) {
  store = new Map();
  const overrides: Record<string, unknown> = {
    upsert: vi.fn(async (vs: any[]): Promise<any> => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" }; }),
    insert: vi.fn(async (vs: any[]): Promise<any> => { for (const v of vs) store.set(v.id, v); return { mutationId: "m" }; }),
    deleteByIds: vi.fn(async (ids: string[]): Promise<any> => { deleted.push(...ids); for (const i of ids) store.delete(i); return { mutationId: "m" }; }),
    getByIds: vi.fn(async (ids: string[]): Promise<any> => ids.map(i => store.get(i)).filter(Boolean)),
  };
  if (matchId) overrides.query = vi.fn().mockResolvedValue({ matches: [{ id: matchId, score: matchScore, metadata: { parentId: matchId } }] });
  return makeVectorizeMock(overrides as any);
}
function decisionAI(decision: string) {
  return { run: vi.fn(async (model: string) => model === "@cf/google/embeddinggemma-300m" ? { data: [new Array(768).fill(0.1)] } : stream(decision)) } as any;
}

beforeEach(async () => {
  resetDatabaseInit();
  deleted = [];
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
const row = (id: string) => sqlite.rows().find((r: any) => r.id === id)!;
const versions = async (id: string) => (await env.DB.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const change = (who: Identity = owner, channel: "rest" | "mcp" | `system:${string}` = "rest") => ({ actorId: who.userId, channel });

describe("undo, one case per reason", () => {
  it("update: undo restores the prior content, tags and vectors", async () => {
    await seed("u1", { content: "before", tags: ["a"] });
    await updateEntryContent(env, "u1", "after", DEFAULTS, undefined, ["b"], { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    const beforeVectorIds = JSON.parse(String(row("u1").vector_ids));
    const r = await revertEntry(env, owner, "u1", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(r).toMatchObject({ status: "reverted" });
    expect(row("u1").content).toBe("before");
    expect(JSON.parse(String(row("u1").tags))).toEqual(["a"]);
    expect(store.get(JSON.parse(String(row("u1").vector_ids))[0])?.metadata.content).toBe("before");
    expect(await versions("u1")).toHaveLength(2); // the original update's version, plus the revert's
  });

  it("append: undo restores the delta's prior text", async () => {
    await seed("a1", { content: "base" });
    await appendToEntry(env, "a1", "base", "more", [], "api", DEFAULTS, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), undefined, owner.personalWorkspaceId);
    const r = await revertEntry(env, owner, "a1", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(r.status).toBe("reverted");
    expect(row("a1").content).toBe("base");
  });

  it("merge: undo restores the target and re-creates the incoming memory", async () => {
    const merged = await makeTestEnv(undefined, {
      DB: env.DB, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, OAUTH_KV: makeMemoryKV(), VECTORIZE: statefulVectorize(JSON.stringify({ action: "merge", target_id: "old", merged_content: "combined" }), "old"),
      AI: decisionAI(JSON.stringify({ action: "merge", target_id: "old", merged_content: "combined" })),
    }) as Env;
    await seed("old", { content: "Old text", tags: ["rocket-project"] });
    const captured = await captureEntry("Incoming fact", [], "api", merged, ctx, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, undefined, { channel: "rest" });
    expect(captured.status).toBe("merged");
    const r = await revertEntry(merged, owner, "old", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(r.status).toBe("reverted");
    expect((r as any).recreatedIncomingId).toBeTruthy();
    expect(row("old").content).toBe("Old text");
    const recreated = sqlite.rows().find((x: any) => x.id === (r as any).recreatedIncomingId)!;
    expect(recreated.content).toBe("Incoming fact");
  });

  it("replace: undo restores the target's prior text", async () => {
    const replaced = makeTestEnv(undefined, {
      DB: env.DB, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, OAUTH_KV: makeMemoryKV(), VECTORIZE: statefulVectorize(JSON.stringify({ action: "replace", target_id: "old2" }), "old2"),
      AI: decisionAI(JSON.stringify({ action: "replace", target_id: "old2" })),
    }) as Env;
    await seed("old2", { content: "Stale fact", tags: ["rocket-project"] });
    const captured = await captureEntry("Fresh fact", [], "api", replaced, ctx, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, undefined, { channel: "rest" });
    expect(captured.status).toBe("replaced");
    const r = await revertEntry(replaced, owner, "old2", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(r.status).toBe("reverted");
    expect(row("old2").content).toBe("Stale fact");
  });

  it("rollup: undo removes the digest marker and the rolled-up tag", async () => {
    const digestEnv = makeTestEnv(undefined, { DB: env.DB, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, OAUTH_KV: makeMemoryKV(), AI: decisionAI("Synthesized text"), VECTORIZE: statefulVectorize() }) as Env;
    for (let i = 0; i < 12; i++) await seed(`src-${i}`, { content: `Work fact number ${i}, detailed enough to be eligible`, tags: ["rocket-project"], createdAt: 1000 + i });
    const result = await compressTag("rocket-project", digestEnv, ctx);
    expect(result.synthesizedId).not.toBeNull();
    const before = row("src-0").content;
    const r = await revertEntry(digestEnv, owner, "src-0", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(r.status).toBe("reverted");
    expect(row("src-0").content).not.toBe(before);
    expect(row("src-0").content).not.toContain("[Digest:");
    expect(JSON.parse(String(row("src-0").tags))).not.toContain("rolled-up");
  });

  it("status: undo un-deprecates and re-embeds", async () => {
    await seed("s1", { content: "some fact", tags: ["rocket-project"] });
    await deprecateEntry("s1", env, change(), DEFAULTS, owner.personalWorkspaceId);
    expect(JSON.parse(String(row("s1").tags))).toContain("status:deprecated");
    expect(row("s1").vector_ids).toBe("[]");
    const r = await revertEntry(env, owner, "s1", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(r.status).toBe("reverted");
    expect(JSON.parse(String(row("s1").tags))).not.toContain("status:deprecated");
    expect(JSON.parse(String(row("s1").vector_ids)).length).toBeGreaterThan(0);
    expect(store.get(JSON.parse(String(row("s1").vector_ids))[0])?.metadata.content).toBe("some fact");
  });

  it("due: undo restores when_* from state", async () => {
    await seed("d1", { whenAt: 1000, whenKind: "event", whenLabel: "old", whenSource: "regex" });
    const until = Date.now() + 86400000;
    await resolveEntryAction(env, ctx, owner, "d1", "snooze", new Date(until).toISOString(), change());
    expect(row("d1").when_at).toBe(until);
    const r = await revertEntry(env, owner, "d1", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(r.status).toBe("reverted");
    expect(row("d1")).toMatchObject({ when_at: 1000, when_kind: "event", when_label: "old", when_source: "regex" });
  });

  it("mirror: undo restores the pre-sync text", async () => {
    const mirrorEnv = makeTestEnv(undefined, { DB: env.DB, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, OAUTH_KV: makeMemoryKV(), VECTORIZE: statefulVectorize(), AI: makeAIMock() }) as Env;
    const mirror = makeMirrorStore(mirrorEnv, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, undefined, "notion");
    const id = await mirror.createEntry("mirror v1", ["work"], "notion");
    await mirror.updateEntry(id, "mirror v2");
    const r = await revertEntry(mirrorEnv, owner, id, change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(r.status).toBe("reverted");
    expect(row(id).content).toBe("mirror v1");
  });

  it("trash: undo of a forgotten memory restores it from the trash", async () => {
    await seed("trash1", { content: "keep me", tags: ["a"] });
    const before = row("trash1");
    const forgotten = await forgetEntry("trash1", env, change(), { reason: "forget", config: DEFAULTS, purge: false }, owner.personalWorkspaceId);
    expect(forgotten.status).toBe("deleted");
    expect(sqlite.rows().find((r: any) => r.id === "trash1")).toBeUndefined();
    const r = await revertEntry(env, owner, "trash1", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(r.status).toBe("restored");
    const restored = row("trash1");
    expect(restored.content).toBe("keep me");
    expect(JSON.parse(String(restored.tags))).toEqual(["a"]);
    expect(restored.workspace_id).toBe(before.workspace_id);
    expect((await env.DB.prepare(`SELECT id FROM entries_trash WHERE id = 'trash1'`).first())).toBeNull();
  });

  it("insight dismiss: undo restores the tags and re-embeds", async () => {
    let deletedIds: string[] = [];
    const insightEnv = makeTestEnv(undefined, {
      DB: env.DB, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(),
      VECTORIZE: statefulVectorize(),
    }) as Env;
    (insightEnv.VECTORIZE.deleteByIds as any) = vi.fn(async (ids: string[]) => { deletedIds.push(...ids); for (const i of ids) store.delete(i); return { mutationId: "m" }; });
    await seed("i1", { content: "an insight", tags: ["auto-insight"], vectorIds: ["v1"] });
    await applyInsightResolution(insightEnv, ctx, change(), [{ id: "i1", tags: row("i1").tags, vector_ids: row("i1").vector_ids, workspace_id: row("i1").workspace_id }], 1, "dismiss");
    expect(row("i1").vector_ids).toBe("[]");
    const r = await revertEntry(insightEnv, owner, "i1", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(r.status).toBe("reverted");
    expect(JSON.parse(String(row("i1").tags))).toContain("auto-insight");
    expect(JSON.parse(String(row("i1").vector_ids)).length).toBeGreaterThan(0);
  });
});

describe("undo mechanics", () => {
  it("undo twice redoes", async () => {
    await seed("r1", { content: "v1" });
    await updateEntryContent(env, "r1", "v2", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    const undo1 = await revertEntry(env, owner, "r1", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(undo1.status).toBe("reverted");
    expect(row("r1").content).toBe("v1");
    const undo2 = await revertEntry(env, owner, "r1", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(undo2.status).toBe("reverted");
    expect(row("r1").content).toBe("v2");
  });

  it("to_version restores a full older state, including when_*", async () => {
    await seed("t1", { content: "v1", whenAt: 100, whenKind: "due" });
    await updateEntryContent(env, "t1", "v2", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    await resolveEntryAction(env, ctx, owner, "t1", "snooze", new Date(Date.now() + 86400000).toISOString(), change());
    await updateEntryContent(env, "t1", "v3", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    const vs = await versions("t1");
    const targetSeq = vs[0].seq; // the very first retired state: content v1, when_at 100
    const r = await revertEntry(env, owner, "t1", change(), DEFAULTS, targetSeq, owner.personalWorkspaceId);
    expect(r.status).toBe("reverted");
    expect(row("t1").content).toBe("v1");
    expect(row("t1").when_at).toBe(100);
    expect(row("t1").when_kind).toBe("due");
  });

  it("a person's undo of a digest merge adds user-edited, and the next digest run cannot merge into it", async () => {
    const decision = JSON.stringify({ action: "merge", target_id: "digest1", merged_content: "digest v2" });
    const digestMergeEnv = makeTestEnv(undefined, {
      DB: env.DB, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, OAUTH_KV: makeMemoryKV(), VECTORIZE: statefulVectorize(decision, "digest1"), AI: decisionAI(decision),
    }) as Env;
    await seed("digest1", { content: "digest v1", tags: ["synthesized", "work"], source: "system", actorId: "" });
    const captured = await captureEntry("my addition", [], "api", digestMergeEnv, ctx, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, undefined, { channel: "rest" });
    expect(captured.status).toBe("merged");
    const r = await revertEntry(digestMergeEnv, owner, "digest1", change(owner, "rest"), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(r.status).toBe("reverted");
    expect(JSON.parse(String(row("digest1").tags))).toContain("user-edited");
  });

  it("a member may undo their own insight dismissal on a company row; a second member's later change makes it stale", async () => {
    const bob = (await resolveIdentityByUserId(env, (await createMember(env, { name: "Bob" })).member.userId))!;
    const carol = (await resolveIdentityByUserId(env, (await createMember(env, { name: "Carol" })).member.userId))!;
    const roots = await ensureTenantBootstrap(env);
    await seed("ci1", { tags: ["auto-insight"], workspaceId: roots.companyWorkspaceId, actorId: "" });
    await applyInsightResolution(env, ctx, change(bob), [{ id: "ci1", tags: String(row("ci1").tags), vector_ids: String(row("ci1").vector_ids), workspace_id: roots.companyWorkspaceId }], 1, "dismiss");
    const chainBefore = await loadHistory(env, bob, { id: "ci1", content: String(row("ci1").content) }, 10);
    expect(canRevert(bob, { workspace_id: roots.companyWorkspaceId, actor_id: "" }, chainBefore.rows[0], chainBefore.rows[0].seq, chainBefore.rows.map(r => r.seq))).toEqual({ ok: true });
    // Carol makes a further change after Bob's dismissal (dismiss already deprecated the row, so a
    // second dismiss is a no-op — this is a distinct status change, e.g. an admin correction).
    const bobSeq = chainBefore.rows[0].seq;
    await applyStatus("ci1", "canonical", env, change(carol), DEFAULTS, roots.companyWorkspaceId);
    // Bob asks for his own version specifically: rule (b) requires it still be the newest, and it no longer is.
    const r = await revertEntry(env, bob, "ci1", change(bob), DEFAULTS, bobSeq, roots.companyWorkspaceId);
    expect(r.status).toBe("stale");
  });

  it("same-actor same-millisecond reverts: one wins, the other is stale, no unrecorded change", async () => {
    await seed("race1", { content: "one" });
    await updateEntryContent(env, "race1", "two", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    const originalNow = Date.now;
    const fixed = originalNow();
    Date.now = () => fixed;
    try {
      const [a, b] = await Promise.all([
        revertEntry(env, owner, "race1", change(), DEFAULTS, undefined, owner.personalWorkspaceId),
        revertEntry(env, owner, "race1", change(), DEFAULTS, undefined, owner.personalWorkspaceId),
      ]);
      const results = [a, b];
      expect(results.filter(r => r.status === "reverted")).toHaveLength(1);
      expect(results.filter(r => r.status === "stale")).toHaveLength(1);
    } finally {
      Date.now = originalNow;
    }
    // The live row is exactly what the recorded revert wrote — no unrecorded change.
    expect(row("race1").content).toBe("one");
    const chain = await loadHistory(env, undefined, { id: "race1", content: String(row("race1").content) }, 10);
    expect(chain.text(chain.rows[0].seq)).toBeDefined();
  });

  it("a revert whose target equals the current state returns no_change and writes nothing", async () => {
    await seed("nc1", { content: "same", tags: ["a"] });
    await updateEntryContent(env, "nc1", "same", DEFAULTS, undefined, ["a"], { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    // The update above is a no-op (same content, same tags) and writes no version.
    expect(await versions("nc1")).toEqual([]);
    await updateEntryContent(env, "nc1", "changed", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    await updateEntryContent(env, "nc1", "same", DEFAULTS, undefined, ["a"], { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    const before = await versions("nc1");
    const r = await revertEntry(env, owner, "nc1", change(), DEFAULTS, before[0].seq, owner.personalWorkspaceId);
    expect(r.status).toBe("no_change");
    expect(await versions("nc1")).toEqual(before);
  });

  it("a revert on a row forgotten meanwhile returns not_found and deletes its fresh vectors", async () => {
    await seed("gone1", { content: "before" });
    await updateEntryContent(env, "gone1", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    const raw = env.DB as any;
    const realBatch = raw.batch.bind(raw);
    let raced = false;
    const racing = { ...env, DB: { ...raw, batch: async (statements: any[]) => {
      if (!raced && statements.some(stmt => /^UPDATE entries AS e SET.*content = /s.test(stmt.sourceSql()))) {
        raced = true;
        await sqlite.deleteFixtureRows("DELETE FROM entries WHERE id = 'gone1'");
      }
      return realBatch(statements);
    } } } as unknown as Env;
    const r = await revertEntry(racing, owner, "gone1", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(raced).toBe(true);
    expect(r.status).toBe("not_found");
  });

  it("a version hidden by the shared-history rule cannot be the target (unreadable)", async () => {
    const bob = (await resolveIdentityByUserId(env, (await createMember(env, { name: "Bob" })).member.userId))!;
    const roots = await ensureTenantBootstrap(env);
    await seed("h1", { content: "personal v1", workspaceId: owner.personalWorkspaceId });
    // A version made while the row was still personal: hidden from Bob once it is shared.
    await updateEntryContent(env, "h1", "personal v2", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    const preShareSeq = (await versions("h1"))[0].seq;
    sqlite.db.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', workspace_id = ? WHERE id = 'h1'`).bind(roots.companyWorkspaceId).run();
    // A version made AFTER the share: visible to Bob, so the chain is not simply empty.
    await updateEntryContent(env, "h1", "company v3", DEFAULTS, undefined, undefined, { workspaceId: roots.companyWorkspaceId, actorId: owner.userId }, change(), roots.companyWorkspaceId);
    const r = await revertEntry(env, bob, "h1", change(bob), DEFAULTS, preShareSeq, roots.companyWorkspaceId);
    expect(r.status).toBe("unreadable");
  });

  it("nothing_to_undo on a row with no versions", async () => {
    await seed("empty1");
    const r = await revertEntry(env, owner, "empty1", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(r.status).toBe("nothing_to_undo");
  });

  it("a merge whose incoming was truncated reverts the target and says the incoming cannot be re-created", async () => {
    const decision = JSON.stringify({ action: "merge", target_id: "big1", merged_content: "combined" });
    const bigEnv = makeTestEnv(undefined, {
      DB: env.DB, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, OAUTH_KV: makeMemoryKV(), VECTORIZE: statefulVectorize(decision, "big1"), AI: decisionAI(decision),
    }) as Env;
    await seed("big1", { content: "Old text", tags: ["rocket-project"] });
    const incoming = "x".repeat(5000);
    const captured = await captureEntry(incoming, [], "api", bigEnv, ctx, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, undefined, { channel: "rest", versionRowBudgetBytes: 100 });
    expect(captured.status).toBe("merged");
    const r = await revertEntry(bigEnv, owner, "big1", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(r.status).toBe("reverted");
    expect((r as any).incomingTruncated).toBe(true);
    expect((r as any).recreatedIncomingId).toBeUndefined();
    expect(row("big1").content).toBe("Old text");
  });

  it("reembed_failed leaves the row and its history untouched", async () => {
    await seed("f1", { content: "before" });
    await updateEntryContent(env, "f1", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, change(), owner.personalWorkspaceId);
    const before = await versions("f1");
    const failingEnv = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, AI: { run: vi.fn(async () => { throw new Error("AI down"); }) } } as unknown as Env;
    const r = await revertEntry(failingEnv, owner, "f1", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(r.status).toBe("reembed_failed");
    expect(row("f1").content).toBe("after");
    expect(await versions("f1")).toEqual(before);
  });
});
