/**
 * GET /decisions and GET /decisions/calibration (Task 10, T-0089.7.2, Design 4.4).
 * Real SQLite: tenancy and rows_read are under test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import { updateEntryContent } from "../../src/capture/store";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
let companyWorkspaceId = "";
let ownerToken = "";
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
  companyWorkspaceId = roots.companyWorkspaceId;
  ownerToken = "test-token"; // makeTestEnv's default AUTH_TOKEN, hashed onto the owner by ensureTenantBootstrap
});
afterEach(() => sqlite.close());

function seedDecision(id: string, opts: { tags?: string[]; createdAt?: number; actorId?: string; workspaceId?: string; content?: string } = {}) {
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'api', ?, '[]', ?, ?)`,
  ).bind(
    id, opts.content ?? "a decision", JSON.stringify(["ledger:decision", ...(opts.tags ?? [])]),
    opts.createdAt ?? 1000, opts.workspaceId ?? owner.personalWorkspaceId, opts.actorId ?? owner.userId,
  ).run();
}

describe("GET /decisions", () => {
  it("state=open lists unresolved decisions; state=resolved lists resolved ones; state=all both", async () => {
    seedDecision("open1", { createdAt: 1000 });
    seedDecision("resolved1", { tags: ["outcome:right"], createdAt: 2000 });

    const open = await (await worker.fetch(req("GET", "/decisions?state=open", { token: ownerToken }), env, ctx)).json() as any;
    expect(open.decisions.map((d: any) => d.id)).toEqual(["open1"]);

    const resolved = await (await worker.fetch(req("GET", "/decisions?state=resolved", { token: ownerToken }), env, ctx)).json() as any;
    expect(resolved.decisions.map((d: any) => d.id)).toEqual(["resolved1"]);
    expect(resolved.decisions[0].outcome).toBe("right");

    const all = await (await worker.fetch(req("GET", "/decisions?state=all", { token: ownerToken }), env, ctx)).json() as any;
    expect(all.decisions.map((d: any) => d.id).sort()).toEqual(["open1", "resolved1"]);
    expect(all.total).toBe(2);
  });

  it("pages with limit and offset", async () => {
    for (let i = 0; i < 5; i++) seedDecision(`d${i}`, { createdAt: 1000 + i });
    const page1 = await (await worker.fetch(req("GET", "/decisions?state=all&limit=2&offset=0", { token: ownerToken }), env, ctx)).json() as any;
    expect(page1.decisions).toHaveLength(2);
    expect(page1.total).toBe(5);
    const page2 = await (await worker.fetch(req("GET", "/decisions?state=all&limit=2&offset=2", { token: ownerToken }), env, ctx)).json() as any;
    expect(page2.decisions).toHaveLength(2);
    expect(page2.decisions[0].id).not.toBe(page1.decisions[0].id);
  });

  it("edited_since_recorded is true after the decision has been updated", async () => {
    seedDecision("e1");
    const before = await (await worker.fetch(req("GET", "/decisions?state=all", { token: ownerToken }), env, ctx)).json() as any;
    expect(before.decisions[0].edited_since_recorded).toBe(false);

    await updateEntryContent(env, "e1", "an edited decision", DEFAULTS, undefined, undefined, { workspaceId: owner.personalWorkspaceId, actorId: owner.userId }, { actorId: owner.userId, channel: "rest" }, owner.personalWorkspaceId);

    const after = await (await worker.fetch(req("GET", "/decisions?state=all", { token: ownerToken }), env, ctx)).json() as any;
    expect(after.decisions[0].edited_since_recorded).toBe(true);
  });

  it("a teammate's company decision is never counted or listed for me", async () => {
    const { member } = await createMember(env, { name: "Bob" });
    const bob = (await resolveIdentityByUserId(env, member.userId))!;
    seedDecision("company1", { workspaceId: companyWorkspaceId, actorId: bob.userId });

    const asOwner = await (await worker.fetch(req("GET", "/decisions?state=all", { token: ownerToken }), env, ctx)).json() as any;
    expect(asOwner.decisions.map((d: any) => d.id)).not.toContain("company1");
    expect(asOwner.total).toBe(0);
  });

  it("rejects an unknown state", async () => {
    const res = await worker.fetch(req("GET", "/decisions?state=sideways", { token: ownerToken }), env, ctx);
    expect(res.status).toBe(400);
  });
});

describe("GET /decisions/calibration", () => {
  it("reports not ready below CALIBRATION_MIN_N", async () => {
    seedDecision("c1", { tags: ["confidence:0.70", "confidence-source:stated", "outcome:right"] });
    const data = await (await worker.fetch(req("GET", "/decisions/calibration", { token: ownerToken }), env, ctx)).json() as any;
    expect(data.ready).toBe(false);
    expect(data.n).toBe(1);
  });

  it("reports ready at CALIBRATION_MIN_N, with a per-source breakdown", async () => {
    for (let i = 0; i < 10; i++) {
      seedDecision(`r${i}`, { tags: ["confidence:0.70", "confidence-source:stated", "outcome:right"], createdAt: 1000 + i });
    }
    const all = await (await worker.fetch(req("GET", "/decisions/calibration", { token: ownerToken }), env, ctx)).json() as any;
    expect(all.ready).toBe(true);
    expect(all.n).toBe(10);

    const stated = await (await worker.fetch(req("GET", "/decisions/calibration?source=stated", { token: ownerToken }), env, ctx)).json() as any;
    expect(stated.n).toBe(10);

    const inferred = await (await worker.fetch(req("GET", "/decisions/calibration?source=inferred", { token: ownerToken }), env, ctx)).json() as any;
    expect(inferred.ready).toBe(false);
    expect(inferred.n).toBe(0);
  });

  it("rejects an unknown source", async () => {
    const res = await worker.fetch(req("GET", "/decisions/calibration?source=sideways", { token: ownerToken }), env, ctx);
    expect(res.status).toBe(400);
  });
});

describe("budgets", () => {
  it("GET /decisions costs two statements plus identity; GET /decisions/calibration costs one plus identity", async () => {
    seedDecision("b1");
    const issued = (fn: () => Promise<unknown>) => {
      const before = sqlite.executions.length;
      return fn().then(() => sqlite.executions.length - before);
    };
    const decisionsCost = await issued(() => worker.fetch(req("GET", "/decisions?state=all", { token: ownerToken }), env, ctx));
    const calibrationCost = await issued(() => worker.fetch(req("GET", "/decisions/calibration", { token: ownerToken }), env, ctx));
    // Identity resolution itself is one statement. GET /decisions costs two more: the page
    // itself, and its own count (a review found COUNT(*) OVER() reports 0 total on an
    // out-of-range page, MINOR 3), computed as a second, independently-scoped statement.
    expect(decisionsCost).toBe(3);
    expect(calibrationCost).toBe(2);
  });
});
