/**
 * Proofs for the v4/t1-foundations merge (T-0089.1.1 x T-0089.1.2): every point the director
 * asked to see proven with a test, not by reading the diff.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTrashEnv, seedVersionsFor, type TrashEnv } from "../helpers/trash-env";
import { makeVectorizeMock } from "../helpers/make-env";
import { forgetEntry } from "../../src/capture/lifecycle";
import { updateEntryContent, appendToEntry, EntryGoneError } from "../../src/capture/store";
import { resolveEntryAction, applyInsightResolution } from "../../src/memory/actions";
import { moveEntry } from "../../src/capture/share";
import { loadHistory, getVersionsSince } from "../../src/memory/versions";
import { readEntryHistory } from "../../src/memory/history";
import { restoreEntry, getTrashedEntry, purgeTrash } from "../../src/memory/trash";
import { importExportPayload } from "../../src/entries/import";
import { resolveConfig, DEFAULTS } from "../../src/config";
import { createMember } from "../../src/lib/team-admin";
import type { Identity } from "../../src/lib/identity";

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };

let t: TrashEnv;
afterEach(() => t?.close());

const forget = async (id: string) => forgetEntry(id, t.env, { actorId: "u", channel: "rest" }, { reason: "forget", config: await resolveConfig(t.env), purge: false }, t.roots.ownerPersonalWorkspaceId);
const post = (path: string, body: unknown) =>
  worker.fetch(new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) }), t.env, ctx);
const ownerIdentity = (): Identity => ({
  userId: t.roots.ownerUserId, role: "admin", personalWorkspaceId: t.roots.ownerPersonalWorkspaceId,
  companyWorkspaceIds: [t.roots.companyWorkspaceId], defaultShare: "",
});
const change = { actorId: "u", channel: "rest" as const };

describe("1. forgetEntry goes through the trash tiers, on both REST and MCP", () => {
  it("REST /forget: real SQLite, not a hard delete", async () => {
    t = await makeTrashEnv();
    t.seed("r1");
    const res = await post("/forget", { id: "r1" });
    const data = await res.json() as any;
    expect(data.trash).toBe(true);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'r1'`)).toBeNull();
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'r1'`)).not.toBeNull();
  });

  it("MCP forget: same real SQLite env, same trash row", async () => {
    t = await makeTrashEnv();
    t.seed("m1");
    const { buildMcpServer } = await import("../../src/mcp/server");
    const { Client } = await import("@modelcontextprotocol/client");
    const { InMemoryTransport } = await import("@modelcontextprotocol/client");
    const identity = ownerIdentity();
    const server = buildMcpServer(t.env, ctx, identity);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      const r = await client.callTool({ name: "forget", arguments: { id: "m1" } });
      const text = String((r.content as any)[0]?.text ?? "");
      expect(text).toMatch(/trash/i);
    } finally {
      await client.close(); await server.close();
    }
    expect(await t.one(`SELECT id FROM entries WHERE id = 'm1'`)).toBeNull();
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'm1'`)).not.toBeNull();
  });
});

describe("3. Versions against trash", () => {
  it("restore writes no version", async () => {
    t = await makeTrashEnv();
    t.seed("a");
    // A real content write through the production CAS path, so this is a genuine A-created version.
    await updateEntryContent(t.env, "a", "v2", DEFAULTS, undefined, undefined, { workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId }, change, t.roots.ownerPersonalWorkspaceId);
    const before = await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'a'`);
    await forget("a");
    const trashed = await getTrashedEntry(t.env, undefined, "a");
    const restored = await restoreEntry(t.env, trashed!, change, DEFAULTS);
    expect(restored.status).toBe("restored");
    const after = await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'a'`);
    expect(after).toEqual(before);
  });

  it("tier-3 hard-delete removes versions the CAS writers created, not just my own seeded ones", async () => {
    t = await makeTrashEnv();
    t.seed("big", { content: "x".repeat(20_000) });
    const ctx2 = { workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId };
    await updateEntryContent(t.env, "big", "x".repeat(20_000) + " v2", DEFAULTS, undefined, undefined, ctx2, change, ctx2.workspaceId);
    await updateEntryContent(t.env, "big", "x".repeat(20_000) + " v3", DEFAULTS, undefined, undefined, ctx2, change, ctx2.workspaceId);
    expect((await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'big'`)).length).toBeGreaterThan(0);
    const res = await forgetEntry("big", t.env, change, { reason: "forget", config: await resolveConfig(t.env), purge: false, budget: 10_000 }, t.roots.ownerPersonalWorkspaceId);
    expect(res).toMatchObject({ status: "deleted", trashed: false }); // too large for the 10 KB test budget: tier 3
    expect(await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'big'`)).toHaveLength(0);
  });

  it("purge removes versions the CAS writers created, once the row is trashed and expired", async () => {
    t = await makeTrashEnv();
    t.seed("p1");
    const ctx2 = { workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId };
    await updateEntryContent(t.env, "p1", "v2", DEFAULTS, undefined, undefined, ctx2, change, ctx2.workspaceId);
    await appendToEntry(t.env, "p1", "v2", "more text", [], "api", DEFAULTS, undefined, ctx2, change, undefined, ctx2.workspaceId);
    const versionCount = (await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'p1'`)).length;
    expect(versionCount).toBeGreaterThan(0);
    await forget("p1");
    await t.sqlite.db.prepare(`UPDATE entries_trash SET deleted_at = 1 WHERE id = 'p1'`).run();
    const purged = await purgeTrash(t.env, DEFAULTS, { ceiling: 10, rowTarget: 5000, now: 100 * 86_400_000 });
    expect(purged.purged).toBe(1);
    expect(await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'p1'`)).toHaveLength(0);
  });

  it("import's orphan-version delete is scoped to the ids it inserts, never a live chain", async () => {
    t = await makeTrashEnv();
    t.seed("live");
    const ctx2 = { workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId };
    await updateEntryContent(t.env, "live", "v2", DEFAULTS, undefined, undefined, ctx2, change, ctx2.workspaceId);
    const before = await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'live'`);
    expect(before.length).toBeGreaterThan(0);
    // Import a DIFFERENT, brand-new id in the same batch: its own orphan-delete must not touch "live"'s chain.
    await importExportPayload(t.env, { entries: [{ id: "fresh", content: "c", tags: [], source: "api", created_at: 1 }] }, {});
    const after = await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'live'`);
    expect(after).toEqual(before);
  });

  it("a trashed-then-restored memory's history stays consistent with the shared-history rule", async () => {
    t = await makeTrashEnv();
    const { member } = await createMember(t.env, { name: "Ada" });
    const P = t.roots.ownerPersonalWorkspaceId, C = t.roots.companyWorkspaceId;
    const ownerCtx = { workspaceId: P, actorId: t.roots.ownerUserId };
    // Personal edit, then shared, then another edit — the standard D-SH shape.
    t.seed("shared-mem", { workspace_id: P, actor_id: t.roots.ownerUserId });
    await updateEntryContent(t.env, "shared-mem", "personal-era text", DEFAULTS, undefined, undefined, ownerCtx, change, ownerCtx.workspaceId);
    const moved = await moveEntry("shared-mem", "company", t.env, ownerIdentity(), change);
    expect(moved.status).toBe("shared");
    await updateEntryContent(t.env, "shared-mem", "company-era text", DEFAULTS, undefined, undefined, { workspaceId: C, actorId: t.roots.ownerUserId }, change, C);

    const adaIdentity: Identity = { userId: member.userId, role: "member", personalWorkspaceId: member.personalWorkspaceId, companyWorkspaceIds: [C], defaultShare: "" };
    const beforeTrash = await readEntryHistory(t.env, adaIdentity, "shared-mem");
    const eventsOf = (h: typeof beforeTrash) => h!.history.items.filter((i: any) => i.kind === "event");
    expect(eventsOf(beforeTrash).some((e: any) => e.event === "shared")).toBe(true);

    // Trash it, restore it: the non-author teammate must still see exactly the post-share slice, no more.
    await forgetEntry("shared-mem", t.env, { actorId: t.roots.ownerUserId, channel: "rest" }, { reason: "forget", config: DEFAULTS, purge: false }, C);
    const trashed = await getTrashedEntry(t.env, undefined, "shared-mem");
    const restored = await restoreEntry(t.env, trashed!, change, DEFAULTS);
    expect(restored.status).toBe("restored");

    const afterRestore = await readEntryHistory(t.env, adaIdentity, "shared-mem");
    expect(eventsOf(afterRestore).map((e: any) => e.event)).toEqual(eventsOf(beforeTrash).map((e: any) => e.event));

    // The version chain itself: Ada must not see the personal-era text, before or after the round trip.
    const row = await t.one<any>(`SELECT id, content FROM entries WHERE id = 'shared-mem'`);
    const chain = await loadHistory(t.env, adaIdentity, row, DEFAULTS.VERSION_KEEP);
    expect(chain.truncatedAt).not.toBe("none"); // it stops before the personal-era version
    for (const v of chain.rows) expect(v.workspace_id).not.toBe(P);
  });
});

describe("4. A's writers against a row trashed mid-flight", () => {
  it("updateEntryContent's CAS retry sees the row gone and returns not_found; nothing is resurrected", async () => {
    t = await makeTrashEnv({ VECTORIZE: makeVectorizeMock({ upsert: vi.fn().mockResolvedValue({}) }) });
    t.seed("race1");
    const writeCtx = { workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId };
    // Trash the row the instant the writer's own SELECT has landed but before its batch commits.
    const realBatch = t.sqlite.db.batch.bind(t.sqlite.db);
    let armed = true;
    (t.sqlite.db as any).batch = async (stmts: unknown[]) => {
      if (armed && stmts.length === 3) { armed = false; await forget("race1"); }
      return realBatch(stmts as any);
    };
    const result = await updateEntryContent(t.env, "race1", "new content", DEFAULTS, undefined, undefined, writeCtx, change, writeCtx.workspaceId);
    expect(result.status).toBe("not_found");
    expect(await t.one(`SELECT id FROM entries WHERE id = 'race1'`)).toBeNull();
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'race1'`)).not.toBeNull();
    // The row's own trashed content is untouched by the loser's write.
    expect((await t.one<any>(`SELECT content FROM entries_trash WHERE id = 'race1'`))!.content).toBe("content of race1");
  });

  it("appendToEntry throws EntryGoneError rather than resurrecting a trashed row", async () => {
    t = await makeTrashEnv();
    t.seed("race2");
    await forget("race2");
    const writeCtx = { workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId };
    await expect(appendToEntry(t.env, "race2", "content of race2", "more", [], "api", DEFAULTS, undefined, writeCtx, change, undefined, writeCtx.workspaceId))
      .rejects.toBeInstanceOf(EntryGoneError);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'race2'`)).toBeNull();
  });

  it("resolveEntryAction (Track 6) 404s cleanly against a trashed target, on every retry path", async () => {
    t = await makeTrashEnv();
    t.seed("race3", { tags: '["task"]' });
    await forget("race3");
    const result = await resolveEntryAction(t.env, ctx, ownerIdentity(), "race3", "done", undefined, change);
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("resolveEntryAction's due/snooze CAS also 404s when the target is trashed mid-loop", async () => {
    t = await makeTrashEnv();
    t.seed("race4");
    const realBatch = t.sqlite.db.batch.bind(t.sqlite.db);
    let armed = true;
    (t.sqlite.db as any).batch = async (stmts: unknown[]) => {
      if (armed && stmts.length === 3) { armed = false; await forget("race4"); }
      return realBatch(stmts as any);
    };
    const result = await resolveEntryAction(t.env, ctx, ownerIdentity(), "race4", "snooze", "2027-01-01", change);
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(await t.one(`SELECT id FROM entries WHERE id = 'race4'`)).toBeNull();
  });

  it("applyInsightResolution against a row trashed after the caller's own read: no version, no resurrection", async () => {
    t = await makeTrashEnv();
    t.seed("insight1", { tags: '["auto-insight"]' });
    const rows = await t.all<any>(`SELECT id, tags, vector_ids, workspace_id FROM entries WHERE id = 'insight1'`);
    await forget("insight1");
    const res = await applyInsightResolution(t.env, ctx, change, rows, 1, "confirm");
    // The row's own compare-and-set (workspace_id and tags, ADV-2) misses because it no longer
    // exists: nothing was written back, and it is not reported as resolved.
    expect(res.resolved).toEqual([]);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'insight1'`)).toBeNull();
    expect(await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'insight1'`)).toHaveLength(0);
  });

  it("moveEntry against a row trashed between its own read and its batch writes no shared/unshared event", async () => {
    t = await makeTrashEnv();
    t.seed("race5", { workspace_id: t.roots.ownerPersonalWorkspaceId });
    const realBatch = t.sqlite.db.batch.bind(t.sqlite.db);
    let armed = true;
    (t.sqlite.db as any).batch = async (stmts: unknown[]) => {
      if (armed && stmts.length === 3) { armed = false; await forget("race5"); }
      return realBatch(stmts as any);
    };
    await moveEntry("race5", "company", t.env, ownerIdentity(), change);
    expect(await t.all(`SELECT id FROM entry_events WHERE entry_id = 'race5' AND event IN ('shared','unshared')`)).toHaveLength(0);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'race5'`)).toBeNull();
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'race5'`)).not.toBeNull();
  });

  it("moveEntry against an already-trashed row is not_found, not a phantom move", async () => {
    t = await makeTrashEnv();
    t.seed("race6");
    await forget("race6");
    const result = await moveEntry("race6", "company", t.env, ownerIdentity(), change);
    expect(result).toEqual({ status: "not_found" });
  });
});

describe("versions:since survives a purge that only lowers it, never a forget", () => {
  it("stays a conservative lower bound after a version-holding row is trashed and purged", async () => {
    t = await makeTrashEnv();
    t.seed("v1");
    await seedVersionsFor(t, ["v1"], 3);
    const since1 = await getVersionsSince(t.env);
    await forget("v1");
    await t.sqlite.db.prepare(`UPDATE entries_trash SET deleted_at = 1 WHERE id = 'v1'`).run();
    await purgeTrash(t.env, DEFAULTS, { ceiling: 10, rowTarget: 5000, now: 100 * 86_400_000 });
    const since2 = await getVersionsSince(t.env);
    expect(since2).toBeGreaterThanOrEqual(since1);
  });
});
