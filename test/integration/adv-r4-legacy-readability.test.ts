/**
 * Round 4 sub-adversary: legacy readability after dcc4568f (treatAbsentFromAsReadable). Real SQLite throughout.
 *
 * dcc4568f's premise: a move event with no fromWorkspaceId is "truly pre-4.0, when there was only one user to
 * have written anything before it". 3.7 (main) was already multi-user: per-member personal workspaces, a company
 * workspace, members sharing their own memories, and digests written with actorId "" into EACH member's
 * workspace (main:src/compression/digest.ts:195). 3.7's move event payload was { workspaceId } only
 * (main:src/mcp/server.ts:630, main:src/routes/entries.ts:313). So a migrated deployment holds absent-from
 * move events on member-owned system rows, and the owner's exception walks straight past them.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { moveEntry } from "../../src/capture/share";
import { readEntryHistory } from "../../src/memory/history";
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
  const roots = await ensureTenantBootstrap(env);
  companyWs = roots.companyWorkspaceId;
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
});
afterEach(() => sqlite.close());

const seed = (id: string, over: Record<string, unknown> = {}) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(
  id, over.content ?? "Some fact", JSON.stringify(over.tags ?? []), over.source ?? "api", over.createdAt ?? 1000, null,
  JSON.stringify([id]), over.workspaceId ?? owner.personalWorkspaceId, over.actorId ?? owner.userId,
).run();
const ev = (entryId: string, event: string, actor: string, at: number, payload: Record<string, unknown>) => env.DB.prepare(
  `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
).bind(crypto.randomUUID(), entryId, actor, event, JSON.stringify(payload), at).run();

async function member(name: string, role: "admin" | "member" = "member"): Promise<Identity & { token: string }> {
  const { token } = await createMember(env, { name, role });
  return { ...(await resolveIdentityFromToken(token, env))!, token };
}

/** Bob's 3.7 digest: written by the digest job (actor "") in Bob's personal workspace, a private era, then
 * Bob shared it on 3.7 — the move event carries only { workspaceId }, exactly as 3.7 wrote it. */
async function bobs37Digest(id: string, bob: Identity) {
  await seed(id, { content: "Digest of Bob's health notes", tags: ["synthesized", "digest"], source: "system", actorId: "", workspaceId: companyWs });
  await ev(id, "updated", bob.userId, 1000, {});                                     // Bob's private era (3.7)
  await ev(id, "status_changed", bob.userId, 2000, { status: "draft" });             // Bob's private era (3.7)
  await ev(id, "shared", bob.userId, 3000, { workspaceId: companyWs });               // 3.7 share: no fromWorkspaceId
  await ev(id, "appended", bob.userId, 4000, { channel: "rest" });                    // company era: everyone may see
}

const timelineOf = async (id: string, token?: string) => {
  const worker = (await import("../../src/index")).default;
  const { req } = await import("../helpers/make-request");
  const res = await worker.fetch(req("POST", `/entry?id=${id}`, token ? { token } : {}), env, ctx);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  return ((body.entry ?? body).timeline as any[]).map(e => e.event);
};

describe("R4-L1 (MAJOR): the owner reads a member's private-era history of a 3.7 system row", () => {
  // Root cause: src/memory/history.ts:65 sets treatAbsentFromAsReadable for ANY actor-"" row the owner reads, and
  // src/memory/history-visibility.ts:31 then `continue`s past every move event lacking fromWorkspaceId. actor ""
  // is also every digest/auto-insight (isSystemRow, src/capture/entry.ts:136), written into the MEMBER's
  // workspace, and 3.7 move events never carried fromWorkspaceId — so "absent" does not mean "only the owner
  // existed". Bob's pre-share (private) events on his own digest leak to the owner, a company teammate.

  it("control: a non-owner teammate is cut at Bob's 3.7 share (this holds)", async () => {
    const bob = await member("Bob");
    const carol = await member("Carol");
    await bobs37Digest("dg37", bob);
    expect(await timelineOf("dg37", carol.token)).toEqual(["shared", "appended"]);
  });

  it("GET /entry by the owner stops at Bob's 3.7 share of his digest", async () => {
    const bob = await member("Bob");
    await bobs37Digest("dg37", bob);
    const events = await timelineOf("dg37"); // default token = the tenant owner, a company teammate here
    // FAILS: ["updated", "status_changed", "shared", "appended"] — Bob's private-era events are shown to the owner.
    expect(events).toEqual(["shared", "appended"]);
  });

  it("MCP history (readEntryHistory) by the owner stops at Bob's 3.7 share of his digest", async () => {
    const bob = await member("Bob");
    await bobs37Digest("dg37", bob);
    const result = await readEntryHistory(env, owner, "dg37");
    const events = result!.history.items.filter((i: any) => i.kind === "event").map((e: any) => e.event);
    // FAILS: the MCP history tool shows the owner Bob's private-era "updated"/"status_changed".
    // Newest first (contract 4.1), unlike GET /entry's chronological `timeline`.
    expect(events).toEqual(["appended", "shared"]);
  });

  it("the owner unsharing it into their own personal workspace (4.0) still does not expose Bob's private era", async () => {
    // R3-4's own scenario, with the only change that Bob shared before the upgrade rather than after.
    const bob = await member("Bob");
    await bobs37Digest("dg37", bob);
    const back = await moveEntry("dg37", "personal", env, owner, { actorId: owner.userId, channel: "rest" });
    expect(back.status).toBe("unshared");
    const events = await timelineOf("dg37");
    // FAILS: the owner sees "status_changed" (Bob's private-era event) — R3-4 reopened via a 3.7-era share.
    expect(events).not.toContain("status_changed");
    expect(events).toEqual(["shared", "appended", "unshared"]);
  });
});

describe("R4-L1 boundaries that hold", () => {
  it("an admin who is not the owner gets no absent-from exception on a legacy row", async () => {
    const ada = await member("Ada", "admin");
    await seed("L2", { actorId: "", workspaceId: companyWs });
    await ev("L2", "updated", owner.userId, 1000, {});
    await ev("L2", "shared", owner.userId, 2000, { workspaceId: companyWs });
    expect(await timelineOf("L2", ada.token)).toEqual(["shared"]);
  });

  it("the owner gets no absent-from exception on a member-authored (non-legacy) row", async () => {
    const bob = await member("Bob");
    await seed("B1", { actorId: bob.userId, workspaceId: companyWs });
    await ev("B1", "updated", bob.userId, 1000, {});
    await ev("B1", "shared", bob.userId, 2000, { workspaceId: companyWs });
    expect(await timelineOf("B1")).toEqual(["shared"]);
  });

  it("a 4.0 share of a pre-backfill row records fromWorkspaceId \"\" and a teammate is cut there", async () => {
    const carol = await member("Carol");
    await seed("L3", { actorId: "", workspaceId: "" });
    await ev("L3", "updated", owner.userId, 1000, {});
    const moved = await moveEntry("L3", "company", env, owner, { actorId: owner.userId, channel: "rest" });
    expect(moved.status).toBe("shared");
    const row = (await env.DB.prepare(`SELECT payload FROM entry_events WHERE entry_id = 'L3' AND event = 'shared'`).first()) as any;
    expect(JSON.parse(row.payload).fromWorkspaceId).toBe("");
    expect(await timelineOf("L3", carol.token)).toEqual(["shared"]);
  });
});
