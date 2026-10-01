/**
 * Cross-vendor adversarial review of Track 7 lane C (bd69cc15..2fdb2ef4).
 * Each test reproduces one defect found in that diff; every test here FAILS
 * against 2fdb2ef4.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import { resolveDecisionOutcome } from "../../src/memory/actions";
import { revertEntry } from "../../src/memory/undo";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

describe("POST /capture validation gaps (d1-mock env)", () => {
  let env: Env;
  beforeEach(() => { env = makeTestEnv(makeTestDb()); });

  it("decision: true with a non-string `when` is a 400, not an unhandled 500", async () => {
    // routes/capture.ts skips the `typeof body.when !== "string"` guard whenever
    // decision is set, then computeReviewAt calls parseExplicitWhen(123), whose
    // rawWhen.trim() throws a TypeError out of the route.
    const res = await worker.fetch(req("POST", "/capture", {
      body: { content: "chose postgres over mysql", decision: true, when: 123 },
    }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("owed_by over 64 characters is a 400 (spec 5.1), matching the MCP zod cap", async () => {
    const res = await worker.fetch(req("POST", "/capture", {
      body: { content: "Priya owes me the revised figures", owed_by: "a".repeat(100) },
    }), env, ctx);
    expect(res.status).toBe(400);
  });
});

describe("real-SQLite defects", () => {
  let sqlite: SqliteD1;
  let env: Env;
  let owner: Identity;
  const change = () => ({ actorId: owner.userId, channel: "rest" as const });

  beforeEach(async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
  });
  afterEach(() => sqlite.close());

  const seedDecision = (id: string) => sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, when_at, when_kind, when_source)
     VALUES (?, ?, ?, 'api', 1000, '[]', ?, ?, 5000, 'due', 'explicit')`,
  ).bind(id, `decision ${id}`, JSON.stringify(["ledger:decision"]), owner.personalWorkspaceId, owner.userId).run();

  it("GET /decisions on an out-of-range page still reports the true total", async () => {
    seedDecision("d1");
    seedDecision("d2");
    const res = await worker.fetch(req("GET", "/decisions?state=all&limit=2&offset=10"), env, ctx);
    const data = await res.json() as any;
    expect(data.decisions).toHaveLength(0);
    // COUNT(*) OVER() only exists on returned rows, so an empty page reports 0
    // even though two decisions match — pagination clients read total: 0 as "no data".
    expect(data.total).toBe(2);
  });

  it("one undo after resolve(outcome, note) undoes the outcome, not only the note", async () => {
    seedDecision("d3");
    const r = await resolveDecisionOutcome(env, ctx, owner, "d3", "right", "Shipped early.", change());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reply).toContain("Undo is available.");

    const undo = await revertEntry(env, owner, "d3", change(), DEFAULTS, undefined, owner.personalWorkspaceId);
    expect(undo.status).toBe("reverted");

    // The resolve call was ONE user action whose reply promises undo; the note
    // append's own version sits on top, so the first undo only strips the note
    // and leaves outcome:right — the outcome the user asked to undo survives.
    const row = await sqlite.db.prepare(`SELECT tags, content, when_at FROM entries WHERE id = 'd3'`).first() as any;
    expect(JSON.parse(row.tags)).not.toContain("outcome:right");
    expect(row.content).not.toContain("Shipped early.");
    expect(row.when_at).toBe(5000);
  });
});
