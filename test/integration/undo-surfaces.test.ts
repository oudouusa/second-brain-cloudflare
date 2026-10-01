/**
 * Task 15 (T-0089.6.6): POST /undo and the MCP undo tool over revertEntry. Both surfaces share
 * one domain call, so these exercise every revertEntry result through each surface and assert the
 * status/body (REST) or sentence (MCP) the spec's table gives, plus the parity and audit rules.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeAIMock, makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { updateEntryContent } from "../../src/capture/store";
import { forgetEntry } from "../../src/capture/lifecycle";
import { buildMcpServer } from "../../src/mcp/server";
import worker from "../../src/index";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;
const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(), AI: makeAIMock() }));
  await initializeDatabase(env);
  env = sqlite.admitEnv(env);
  const roots = await ensureTenantBootstrap(env);
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); });

const seed = (id: string, over: Record<string, unknown> = {}) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(
  id, over.content ?? "text", JSON.stringify(over.tags ?? []), over.source ?? "api", over.createdAt ?? 1000, over.updatedAt ?? null,
  JSON.stringify(over.vectorIds ?? [id]), over.workspaceId ?? owner.personalWorkspaceId, over.actorId ?? owner.userId,
).run();
const row = (id: string) => sqlite.rows().find((r: any) => r.id === id) as any;
const versions = async (id: string) => (await env.DB.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const events = async (id: string) => (await env.DB.prepare(`SELECT event, payload FROM entry_events WHERE entry_id = ? ORDER BY rowid`).bind(id).all()).results as any[];

const restUndo = (id: string, toVersion?: number, token = "test-token") =>
  worker.fetch(new Request("http://localhost/undo", {
    method: "POST", headers: { ...headers, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id, ...(toVersion !== undefined ? { to_version: toVersion } : {}) }),
  }), env, ctx);

async function mcpUndo(identity: Identity, id: string, toVersion?: number) {
  const server = buildMcpServer(env, ctx, identity);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name: "undo", arguments: { id, ...(toVersion !== undefined ? { to_version: toVersion } : {}) } });
    return (result.content as { type: string; text: string }[])[0]?.text ?? "";
  } finally {
    await client.close();
  }
}

describe("POST /undo maps every revertEntry result to its status and body", () => {
  it("reverted: 200, with targetSeq", async () => {
    seed("u1", { content: "before" });
    await updateEntryContent(env, "u1", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId);
    const res = await restUndo("u1");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ ok: true, id: "u1", status: "reverted", targetSeq: 1 });
    expect(row("u1").content).toBe("before");
  });

  it("restored: 200", async () => {
    seed("t1", { content: "keep me" });
    await forgetEntry("t1", env, { actorId: owner.userId, channel: "rest" }, { reason: "forget", config: DEFAULTS, purge: false }, owner.personalWorkspaceId);
    const res = await restUndo("t1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "t1", status: "restored" });
    expect(row("t1").content).toBe("keep me");
  });

  it("no_change: 200 with changed:false, and nothing is written", async () => {
    seed("nc1", { content: "same", tags: ["a"] });
    await updateEntryContent(env, "nc1", "changed", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId);
    await updateEntryContent(env, "nc1", "same", DEFAULTS, undefined, ["a"], { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId);
    const before = await versions("nc1");
    const res = await restUndo("nc1", before[0].seq);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "nc1", status: "no_change", changed: false });
    expect(await versions("nc1")).toEqual(before);
  });

  it("nothing_to_undo: 409, and nothing is written", async () => {
    seed("empty1");
    const res = await restUndo("empty1");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(await versions("empty1")).toEqual([]);
  });

  it("not_found: 404, the same text GET /entry would give for a missing id", async () => {
    const res = await restUndo("nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: "No memory found with ID: nope" });
  });

  it("forbidden: 403, the author-lock message, and nothing is written", async () => {
    const roots = await ensureTenantBootstrap(env);
    const { token: bobToken, member: bob } = await createMember(env, { name: "Bob" });
    seed("cf1", { content: "before", workspaceId: roots.companyWorkspaceId, actorId: owner.userId });
    await updateEntryContent(env, "cf1", "after", DEFAULTS, undefined, undefined, { workspaceId: roots.companyWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, roots.companyWorkspaceId);
    const res = await restUndo("cf1", undefined, bobToken);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "Only the entry's author or an admin can modify a shared company memory" });
    expect(row("cf1").content).toBe("after");
    void bob;
  });

  it("unreadable: 404, one neutral wording that never reveals the pre-share history exists (T-0089.6.6)", async () => {
    const roots = await ensureTenantBootstrap(env);
    const { token: bobToken } = await createMember(env, { name: "Bob" });
    seed("h1", { content: "personal v1", workspaceId: owner.personalWorkspaceId });
    await updateEntryContent(env, "h1", "personal v2", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId);
    const preShareSeq = (await versions("h1"))[0].seq;
    sqlite.db.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', workspace_id = ? WHERE id = 'h1'`).bind(roots.companyWorkspaceId).run();
    await updateEntryContent(env, "h1", "company v3", DEFAULTS, undefined, undefined, { workspaceId: roots.companyWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, roots.companyWorkspaceId);
    const res = await restUndo("h1", preShareSeq, bobToken);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: "No earlier version of entry h1 is visible to you. Its author can undo older changes." });
  });

  it("stale: 409, and nothing is written", async () => {
    const roots = await ensureTenantBootstrap(env);
    const { token: bobToken, member: bobMember } = await createMember(env, { name: "Bob" });
    const bob = (await resolveIdentityByUserId(env, bobMember.userId))!;
    seed("ci1", { tags: ["auto-insight"], workspaceId: roots.companyWorkspaceId, actorId: "" });
    const { applyInsightResolution } = await import("../../src/memory/actions");
    await applyInsightResolution(env, ctx, { actorId: bob.userId, channel: "rest" }, [{ id: "ci1", tags: row("ci1").tags, vector_ids: row("ci1").vector_ids, workspace_id: roots.companyWorkspaceId }], 1, "dismiss");
    const bobSeq = (await versions("ci1"))[0].seq;
    // A further change by someone else: Bob's own newest right (rule b) turns off.
    await updateEntryContent(env, "ci1", "canonical text", DEFAULTS, undefined, undefined, { workspaceId: roots.companyWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, roots.companyWorkspaceId);
    const before = await versions("ci1");
    const res = await restUndo("ci1", bobSeq, bobToken);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: "Entry changed after you looked at it; check history and try again." });
    expect(await versions("ci1")).toEqual(before);
  });

  it("reembed_failed: 500, and nothing is written", async () => {
    seed("f1", { content: "before" });
    await updateEntryContent(env, "f1", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId);
    const before = await versions("f1");
    (env.AI as any).run = vi.fn(async () => { throw new Error("AI down"); });
    const res = await restUndo("f1");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(row("f1").content).toBe("after");
    expect(await versions("f1")).toEqual(before);
  });
});

describe("MCP undo returns the specified sentence for every result", () => {
  it("reverted", async () => {
    seed("u2", { content: "before" });
    await updateEntryContent(env, "u2", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "mcp" }, owner.personalWorkspaceId);
    const text = await mcpUndo(owner, "u2");
    expect(text).toBe("Reverted entry u2 to how it was before its last change (version 1). Undo again to put it back.");
  });

  it("restored", async () => {
    seed("t2", { content: "keep me" });
    await forgetEntry("t2", env, { actorId: owner.userId, channel: "mcp" }, { reason: "forget", config: DEFAULTS, purge: false }, owner.personalWorkspaceId);
    expect(await mcpUndo(owner, "t2")).toBe("Restored entry t2 from the trash.");
  });

  it("no_change", async () => {
    seed("nc2", { content: "same", tags: ["a"] });
    await updateEntryContent(env, "nc2", "changed", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "mcp" }, owner.personalWorkspaceId);
    await updateEntryContent(env, "nc2", "same", DEFAULTS, undefined, ["a"], { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "mcp" }, owner.personalWorkspaceId);
    const before = (await versions("nc2"))[0].seq;
    expect(await mcpUndo(owner, "nc2", before)).toBe("Entry nc2 already matches that version; nothing changed.");
  });

  it("nothing_to_undo", async () => {
    seed("empty2");
    expect(await mcpUndo(owner, "empty2")).toBe("Entry empty2 has no recorded changes to undo.");
  });

  it("not_found", async () => {
    expect(await mcpUndo(owner, "nope2")).toBe("No memory found with ID: nope2");
  });

  it("forbidden", async () => {
    const roots = await ensureTenantBootstrap(env);
    const { member: bobMember } = await createMember(env, { name: "Bob" });
    const bob = (await resolveIdentityByUserId(env, bobMember.userId))!;
    seed("cf2", { content: "before", workspaceId: roots.companyWorkspaceId, actorId: owner.userId });
    await updateEntryContent(env, "cf2", "after", DEFAULTS, undefined, undefined, { workspaceId: roots.companyWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "mcp" }, roots.companyWorkspaceId);
    expect(await mcpUndo(bob, "cf2")).toBe("Only the entry's author or an admin can modify a shared company memory");
  });

  it("stale", async () => {
    const roots = await ensureTenantBootstrap(env);
    const { member: bobMember } = await createMember(env, { name: "Bob" });
    const bob = (await resolveIdentityByUserId(env, bobMember.userId))!;
    seed("ci2", { tags: ["auto-insight"], workspaceId: roots.companyWorkspaceId, actorId: "" });
    const { applyInsightResolution } = await import("../../src/memory/actions");
    await applyInsightResolution(env, ctx, { actorId: bob.userId, channel: "mcp" }, [{ id: "ci2", tags: row("ci2").tags, vector_ids: row("ci2").vector_ids, workspace_id: roots.companyWorkspaceId }], 1, "dismiss");
    const bobSeq = (await versions("ci2"))[0].seq;
    await updateEntryContent(env, "ci2", "canonical text", DEFAULTS, undefined, undefined, { workspaceId: roots.companyWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "mcp" }, roots.companyWorkspaceId);
    expect(await mcpUndo(bob, "ci2", bobSeq)).toBe("Entry ci2 changed after you looked at it; check history and try again.");
  });

  it("reembed_failed", async () => {
    seed("f2", { content: "before" });
    await updateEntryContent(env, "f2", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "mcp" }, owner.personalWorkspaceId);
    (env.AI as any).run = vi.fn(async () => { throw new Error("AI down"); });
    expect(await mcpUndo(owner, "f2")).toBe("Couldn't update memory f2: search did not update. The memory is unchanged. Try again.");
  });
});

describe("REST and MCP undo leave identical rows and versions except channel", () => {
  it("update, undo through each surface", async () => {
    seed("pr1", { content: "before" });
    seed("pr2", { content: "before" });
    await updateEntryContent(env, "pr1", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId);
    await updateEntryContent(env, "pr2", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId);

    expect((await restUndo("pr1")).status).toBe(200);
    expect(await mcpUndo(owner, "pr2")).toContain("Reverted");

    const [r1, r2] = [row("pr1"), row("pr2")];
    expect(r1.content).toBe(r2.content);
    expect(r1.tags).toBe(r2.tags);

    const [v1, v2] = [await versions("pr1"), await versions("pr2")];
    expect(v1).toHaveLength(v2.length);
    // Everything but the row's own identity (id, entry_id), timing (created_at, valid_from — the
    // two sequential real calls a moment apart) and each request's own random nonce (meta) — and
    // channel, which is the one thing REST and MCP are allowed, and expected, to differ on.
    const strip = (v: any) => {
      const { id, entry_id, created_at, valid_from, channel, meta, write_marker, ...rest } = v;
      // event_id (round 3 re-review MAJOR) is minted fresh per call, same reasoning as nonce.
      const { nonce, event_id, ...metaRest } = meta ? JSON.parse(meta) : {};
      return { ...rest, meta: metaRest };
    };
    for (let i = 0; i < v1.length; i++) expect(strip(v1[i])).toEqual(strip(v2[i]));
    expect(v1.at(-1).channel).toBe("rest");
    expect(v2.at(-1).channel).toBe("mcp");
  });
});

describe("undo is audited reverted with channel rest or mcp", () => {
  it("REST", async () => {
    seed("au1", { content: "before" });
    await updateEntryContent(env, "au1", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId);
    await restUndo("au1");
    const ev = (await events("au1")).find((e) => e.event === "reverted");
    expect(ev).toBeDefined();
    expect(JSON.parse(ev.payload)).toMatchObject({ channel: "rest" });
  });

  it("MCP", async () => {
    seed("au2", { content: "before" });
    await updateEntryContent(env, "au2", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "mcp" }, owner.personalWorkspaceId);
    await mcpUndo(owner, "au2");
    const ev = (await events("au2")).find((e) => e.event === "reverted");
    expect(ev).toBeDefined();
    expect(JSON.parse(ev.payload)).toMatchObject({ channel: "mcp" });
  });
});

describe("MCP undo has no parameter that can delete permanently", () => {
  it("the input schema has no permanent or confirm parameter", async () => {
    const server = buildMcpServer(env, ctx, owner);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const { tools } = await client.listTools();
      const schema = tools.find((t) => t.name === "undo")?.inputSchema as any;
      expect(schema.properties).not.toHaveProperty("permanent");
      expect(schema.properties).not.toHaveProperty("confirm");
    } finally {
      await client.close();
    }
  });
});

// ── T-0089.6.6: reply text, the pruned/unreadable split, a truthful not_found, mirror rows and
// MCP annotations, per the UX planner's interaction map (12-user-interaction-map.md section 3.1). ──

const seedVersion = (entryId: string, over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    entry_id: entryId, workspace_id: over.workspaceId ?? owner.personalWorkspaceId, seq: over.seq ?? 1,
    content: over.content ?? "v", prior_length: over.priorLength ?? null, tags: over.tags ?? "[]", state: over.state ?? "{}",
    actor_id: over.actorId ?? owner.userId, channel: over.channel ?? "rest", reason: over.reason ?? "update",
    meta: over.meta ?? "{}", valid_from: over.validFrom ?? 500, created_at: over.createdAt ?? 900,
  };
  const cols = Object.keys(row);
  return sqlite.db.prepare(`INSERT INTO entry_versions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...Object.values(row)).run();
};

describe("reply text for a merge/redo, plus the redo hint on every reverted result", () => {
  it("reverted past a merge: names the re-created memory, and offers the redo hint", async () => {
    seed("merge-a", { content: "merged text" });
    seedVersion("merge-a", { seq: 1, content: "before the merge", reason: "merge", meta: JSON.stringify({ incoming: "the incoming fact", incomingTags: [], incomingSource: "api" }) });
    const res = await restUndo("merge-a");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.recreatedIncomingId).toBeDefined();
    expect(body.message).toBe(`Reverted entry merge-a to how it was before its last change (version 1). Undo again to put it back. The text that was merged in is now its own memory, ${body.recreatedIncomingId}.`);
  });

  it("reverted past a merge whose incoming text was too large to keep: says so plainly", async () => {
    seed("merge-b", { content: "merged text" });
    seedVersion("merge-b", { seq: 1, content: "before the merge", reason: "merge", meta: JSON.stringify({ incomingTruncated: true }) });
    const res = await restUndo("merge-b");
    const body = await res.json() as any;
    expect(body.incomingTruncated).toBe(true);
    expect(body.message).toContain("The text that was merged in was too large to keep, so it could not be re-created.");
  });

  it("redo of a merge undo: says the re-created memory was kept, and nothing is removed silently", async () => {
    seed("merge-c", { content: "before the merge" });
    seedVersion("merge-c", { seq: 1, content: "before the merge", reason: "merge", meta: JSON.stringify({ incoming: "fact" }) });
    seedVersion("merge-c", { seq: 2, content: "merged text", reason: "revert", meta: JSON.stringify({ target_seq: 1, reverted_reason: "merge", recreated_incoming: [{ id: "recreated-1", merge_seq: 1 }] }) });
    const res = await restUndo("merge-c");
    const body = await res.json() as any;
    expect(body.keptIncoming).toEqual([{ id: "recreated-1", reason: "re-created earlier" }]);
    expect(body.message).toContain("Memory recreated-1, which an earlier undo re-created, was kept.");
  });

  it("MCP mirrors the same wording as REST for a plain revert's redo hint", async () => {
    seed("redo-mcp", { content: "before" });
    await updateEntryContent(env, "redo-mcp", "after", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "mcp" }, owner.personalWorkspaceId);
    expect(await mcpUndo(owner, "redo-mcp")).toBe("Reverted entry redo-mcp to how it was before its last change (version 1). Undo again to put it back.");
  });
});

describe("pruned vs unreadable: only the entry's own author is told a version was pruned", () => {
  const seed21 = (id: string, workspaceId: string) => sqlite.db.exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 21)
    INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, state, actor_id, channel, reason, meta, valid_from, created_at, write_marker)
    SELECT '${id}', '${workspaceId}', i, 'v' || i, NULL, '[]', '{}', '${owner.userId}', 'rest', 'update', '{}', i * 100, i * 100, '${sqlite.fixtureMarker()}' FROM n`);

  it("the author asking for a version older than VERSION_KEEP is offered the oldest one still kept", async () => {
    seed("pruned-a", { content: "v22" });
    await seed21("pruned-a", owner.personalWorkspaceId);
    const res = await restUndo("pruned-a", 1);
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.oldestKept).toBe(2);
    expect(body.error).toBe("Only the last 20 changes to entry pruned-a are kept, and version 1 is older than that. The oldest kept is version 2.");
  });

  it("a non-author teammate gets one neutral wording instead, whether the reason is pruning or the shared-history cut", async () => {
    const roots = await ensureTenantBootstrap(env);
    const { token: bobToken } = await createMember(env, { name: "Bob" });
    seed("pruned-b", { content: "v22", workspaceId: roots.companyWorkspaceId });
    await seed21("pruned-b", roots.companyWorkspaceId);
    const res = await restUndo("pruned-b", 1, bobToken);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: "No earlier version of entry pruned-b is visible to you. Its author can undo older changes." });
  });
});

describe("not_found tells a caller who could read a row why it is gone, and only that caller", () => {
  const goneEvent = (entryId: string, actorId: string, event: string, payload: Record<string, unknown>, createdAt: number) =>
    env.DB.prepare(`INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), entryId, actorId, event, JSON.stringify(payload), createdAt).run();

  it("too large for the trash (tier 3), with the date, for whoever forgot it", async () => {
    seed("gone-tier3");
    await goneEvent("gone-tier3", owner.userId, "deleted", { trash: false, reason: "too_large_for_trash", channel: "rest" }, 1_700_000_000_000);
    sqlite.deleteFixtureRows(`DELETE FROM entries WHERE id = 'gone-tier3'`);
    const res = await restUndo("gone-tier3");
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.gone).toEqual({ reason: "tier3", at: 1_700_000_000_000 });
    expect(body.error).toBe(`Entry gone-tier3 was too large for the trash and was deleted for good on ${new Date(1_700_000_000_000).toDateString()}.`);
  });

  it("deleted forever, with the date, for whoever deleted it", async () => {
    seed("gone-forever");
    await goneEvent("gone-forever", owner.userId, "purged", { reason: "permanent", channel: "rest", from: "live" }, 1_700_000_000_000);
    sqlite.deleteFixtureRows(`DELETE FROM entries WHERE id = 'gone-forever'`);
    const res = await restUndo("gone-forever");
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.gone).toEqual({ reason: "deleted_forever", at: 1_700_000_000_000 });
    expect(body.error).toBe(`Entry gone-forever was deleted forever on ${new Date(1_700_000_000_000).toDateString()}.`);
  });

  it("purged after the trash retention window, with the date, for whoever forgot it", async () => {
    seed("gone-purged");
    await goneEvent("gone-purged", owner.userId, "deleted", { trash: true, reason: "forget", channel: "rest" }, 1_699_000_000_000);
    await goneEvent("gone-purged", "", "purged", { channel: "system:purge", reason: "forget", deleted_at: 1_699_000_000_000 }, 1_700_000_000_000);
    sqlite.deleteFixtureRows(`DELETE FROM entries WHERE id = 'gone-purged'`);
    const res = await restUndo("gone-purged");
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.gone).toEqual({ reason: "purged", at: 1_700_000_000_000 });
    expect(body.error).toBe(`Entry gone-purged was in the trash for ${DEFAULTS.TRASH_RETENTION_DAYS} days and was removed for good on ${new Date(1_700_000_000_000).toDateString()}. It cannot be restored.`);
  });

  it("never names a cause to a caller who never appears on the id's own events", async () => {
    const { token: bobToken } = await createMember(env, { name: "Bob" });
    seed("gone-stranger");
    await goneEvent("gone-stranger", owner.userId, "purged", { reason: "permanent", channel: "rest", from: "live" }, 1_700_000_000_000);
    sqlite.deleteFixtureRows(`DELETE FROM entries WHERE id = 'gone-stranger'`);
    const res = await restUndo("gone-stranger", undefined, bobToken);
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.gone).toBeUndefined();
    expect(body.error).toBe("No memory found with ID: gone-stranger");
  });

  it("MCP gives the same cause in its sentence", async () => {
    seed("gone-mcp");
    await goneEvent("gone-mcp", owner.userId, "purged", { reason: "permanent", channel: "rest", from: "live" }, 1_700_000_000_000);
    sqlite.deleteFixtureRows(`DELETE FROM entries WHERE id = 'gone-mcp'`);
    expect(await mcpUndo(owner, "gone-mcp")).toBe(`Entry gone-mcp was deleted forever on ${new Date(1_700_000_000_000).toDateString()}.`);
  });
});

describe("mirror rows refuse a revert, but a trashed one still restores, with a warning", () => {
  const connectMirror = (source = "notion") => env.OAUTH_KV.put(`integrations:${source}`, JSON.stringify({ itemMap: {} }));

  it("refuses to undo a live, still-connected mirror row", async () => {
    await connectMirror();
    seed("mirror-live", { content: "from notion", source: "notion" });
    const res = await restUndo("mirror-live");
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe("This memory is synced from Notion. Change it in Notion; the change syncs back.");
    expect(row("mirror-live").content).toBe("from notion");
  });

  it("still restores a trashed mirror row, but warns the next sync will remove it again", async () => {
    await connectMirror();
    seed("mirror-trashed", { content: "from notion", source: "notion" });
    await forgetEntry("mirror-trashed", env, { actorId: owner.userId, channel: "rest" }, { reason: "mirror", config: DEFAULTS, purge: false }, owner.personalWorkspaceId);
    const res = await restUndo("mirror-trashed");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.mirrorWarning).toBe(true);
    expect(body.message).toBe("Restored entry mirror-trashed. Notion still has it archived, so the next sync will remove it again. Restore the page in Notion to keep it.");
    expect(row("mirror-trashed").content).toBe("from notion");
  });

  it("a plain forget's restore never carries the mirror warning", async () => {
    seed("not-mirror");
    await forgetEntry("not-mirror", env, { actorId: owner.userId, channel: "rest" }, { reason: "forget", config: DEFAULTS, purge: false }, owner.personalWorkspaceId);
    const res = await restUndo("not-mirror");
    const body = await res.json() as any;
    expect(body.mirrorWarning).toBeUndefined();
    expect(body.message).toBe("Restored entry not-mirror from the trash.");
  });
});

describe("MCP annotations (T-0089.6.6)", () => {
  it("forget is marked destructiveHint, and undo is marked not idempotent", async () => {
    const server = buildMcpServer(env, ctx, owner);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.find((t) => t.name === "forget")?.annotations).toMatchObject({ destructiveHint: true });
      expect(tools.find((t) => t.name === "undo")?.annotations).toMatchObject({ idempotentHint: false });
    } finally {
      await client.close();
    }
  });
});
