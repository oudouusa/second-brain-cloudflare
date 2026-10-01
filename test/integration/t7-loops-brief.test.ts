/**
 * Loops split by direction, decisions in the brief, and standing in the brief
 * (Task 9, T-0089.7.1/.2/.3, Design 5.3, 2.11, C10, C11).
 */
import { encodeVector } from "../../src/standing/codec";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import { computeBrief, computeAgentBrief, computeLeanBrief } from "../../src/brief/compute";
import { createProject } from "../../src/projects/registry";
import { standingKvKey } from "../../src/standing/cache";
import { resolveDecisionOutcome } from "../../src/memory/actions";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
const ctx = { waitUntil: (_: Promise<unknown>) => {} };

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
});
afterEach(() => sqlite.close());

function seedTask(id: string, tags: string[], createdAt = 1000) {
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'api', ?, '[]', ?, ?)`,
  ).bind(id, `content for ${id}`, JSON.stringify(tags), createdAt, owner.personalWorkspaceId, owner.userId).run();
}

describe("GET /loops direction", () => {
  it("defaults to out and excludes inbound rows", async () => {
    seedTask("out1", ["task", "counterparty:sam"]);
    seedTask("in1", ["task", "owed-to-me", "counterparty:priya"]);
    const res = await worker.fetch(req("GET", "/loops"), env, ctx as any);
    const data = await res.json() as any;
    expect(data.entries.map((e: any) => e.id)).toEqual(["out1"]);
    expect(data.entries[0].direction).toBe("out");
    expect(data.entries[0].counterparty).toBe("Sam");
  });

  it("direction=in returns only inbound rows, with their counterparty", async () => {
    seedTask("out1", ["task"]);
    seedTask("in1", ["task", "owed-to-me", "counterparty:priya"]);
    const res = await worker.fetch(req("GET", "/loops?direction=in"), env, ctx as any);
    const data = await res.json() as any;
    expect(data.entries.map((e: any) => e.id)).toEqual(["in1"]);
    expect(data.entries[0].direction).toBe("in");
    expect(data.entries[0].counterparty).toBe("Priya");
  });

  it("direction=all returns both", async () => {
    seedTask("out1", ["task"]);
    seedTask("in1", ["task", "owed-to-me"]);
    const res = await worker.fetch(req("GET", "/loops?direction=all"), env, ctx as any);
    const data = await res.json() as any;
    expect(data.entries.map((e: any) => e.id).sort()).toEqual(["in1", "out1"]);
  });

  it("rejects an unknown direction", async () => {
    const res = await worker.fetch(req("GET", "/loops?direction=sideways"), env, ctx as any);
    expect(res.status).toBe(400);
  });
});

describe("GET /due kind", () => {
  it("carries decision, inbound, outbound and other kinds", async () => {
    const now = Date.now();
    sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, when_at, when_kind, when_source)
       VALUES (?, ?, ?, 'api', ?, '[]', ?, ?, ?, 'due', 'explicit')`,
    ).bind("d1", "a decision", JSON.stringify(["ledger:decision"]), now, owner.personalWorkspaceId, owner.userId, now - 1000).run();
    sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, when_at, when_kind, when_source)
       VALUES (?, ?, ?, 'api', ?, '[]', ?, ?, ?, 'due', 'explicit')`,
    ).bind("in1", "inbound", JSON.stringify(["task", "owed-to-me"]), now, owner.personalWorkspaceId, owner.userId, now - 1000).run();
    sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, when_at, when_kind, when_source)
       VALUES (?, ?, ?, 'api', ?, '[]', ?, ?, ?, 'due', 'explicit')`,
    ).bind("out1", "outbound", JSON.stringify(["task"]), now, owner.personalWorkspaceId, owner.userId, now - 1000).run();
    sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, when_at, when_kind, when_source)
       VALUES (?, ?, ?, 'api', ?, '[]', ?, ?, ?, 'wake', 'explicit')`,
    ).bind("other1", "just a reminder", JSON.stringify(["personal"]), now, owner.personalWorkspaceId, owner.userId, now - 1000).run();

    const res = await worker.fetch(req("GET", "/due"), env, ctx as any);
    const data = await res.json() as any;
    const kindOf = (id: string) => data.overdue.find((r: any) => r.id === id).kind;
    expect(kindOf("d1")).toBe("decision");
    expect(kindOf("in1")).toBe("inbound");
    expect(kindOf("out1")).toBe("outbound");
    expect(kindOf("other1")).toBe("other");
  });
});

describe("dashboard brief aggregate and preview", () => {
  it("open_loops is outbound only; owed_to_me and decisions_resolved are new columns, one statement", async () => {
    seedTask("out1", ["task"]);
    seedTask("in1", ["task", "owed-to-me"]);
    const before = sqlite.issued?.length ?? 0;
    const brief = await computeBrief(env, owner, true);
    expect(brief.loops.open).toBe(1);
    expect(brief.owed_to_me).toBe(1);
    expect(brief.loops.items.map((i: any) => i.id).sort()).toEqual(["in1", "out1"]);
    expect(brief.loops.items.find((i: any) => i.id === "in1")?.direction).toBe("in");
    expect(brief.loops.items.find((i: any) => i.id === "out1")?.direction).toBe("out");
  });

  // Cross-vendor review MAJOR (T-0102), finding 6(b): the loop preview had no held guard at all
  // (unlike GET /loops itself, and every other query in this file).
  it("excludes a held row from the loops preview", async () => {
    seedTask("out1", ["task"]);
    seedTask("held1", ["task", "quarantine:instruction", "status:draft"]);
    const brief = await computeBrief(env, owner, true);
    expect(brief.loops.items.map((i: any) => i.id)).toEqual(["out1"]);
  });

  it("runs the calibration query only once decisions_resolved reaches CALIBRATION_MIN_N (10)", async () => {
    for (let i = 0; i < 9; i++) {
      sqlite.db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'api', ?, '[]', ?, ?)`,
      ).bind(`r${i}`, "x", JSON.stringify(["ledger:decision", "outcome:right", "confidence:0.70", "confidence-source:stated"]), 1000, owner.personalWorkspaceId, owner.userId).run();
    }
    const notReady = await computeBrief(env, owner, true);
    expect(notReady.calibration).toBeUndefined();

    sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'api', ?, '[]', ?, ?)`,
    ).bind("r9", "x", JSON.stringify(["ledger:decision", "outcome:right", "confidence:0.70", "confidence-source:stated"]), 1000, owner.personalWorkspaceId, owner.userId).run();
    const ready = await computeBrief(env, owner, true);
    expect(ready.calibration?.ready).toBe(true);
    expect(ready.calibration?.n).toBe(10);
  });

  it("excludes deprecated rows from decisions_resolved (NIT, review)", async () => {
    for (let i = 0; i < 10; i++) {
      sqlite.db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'api', ?, '[]', ?, ?)`,
      ).bind(`r${i}`, "x", JSON.stringify(["ledger:decision", "outcome:right", "confidence:0.70", "confidence-source:stated"]), 1000, owner.personalWorkspaceId, owner.userId).run();
    }
    sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'api', ?, '[]', ?, ?)`,
    ).bind("dep1", "x", JSON.stringify(["ledger:decision", "outcome:right", "status:deprecated"]), 1000, owner.personalWorkspaceId, owner.userId).run();

    const brief = await computeBrief(env, owner, true);
    expect(brief.calibration?.n).toBe(10);
  });
});

describe("MCP brief: decisions due for review, You owe, Owed to you", () => {
  it("a decision due appears once, under Decisions due for review, never under Due", async () => {
    const now = Date.now();
    sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, when_at, when_kind, when_source)
       VALUES (?, ?, ?, 'api', ?, '[]', ?, ?, ?, 'due', 'explicit')`,
    ).bind("d1", "Decided to hire Dana", JSON.stringify(["ledger:decision"]), now, owner.personalWorkspaceId, owner.userId, now - 1000).run();
    sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, when_at, when_kind, when_source)
       VALUES (?, ?, ?, 'api', ?, '[]', ?, ?, ?, 'due', 'explicit')`,
    ).bind("t1", "Renew the passport", JSON.stringify(["task"]), now, owner.personalWorkspaceId, owner.userId, now - 1000).run();

    const text = await computeAgentBrief(env, ctx, owner);
    expect(text).toContain("Decisions due for review");
    expect(text).toContain("Decided to hire Dana");
    const dueSection = text.split("Decisions due for review")[0];
    expect(dueSection).not.toContain("Decided to hire Dana");
  });

  it("splits loops into You owe and Owed to you", async () => {
    seedTask("out1", ["task"]);
    seedTask("in1", ["task", "owed-to-me", "counterparty:priya"]);
    const text = await computeAgentBrief(env, ctx, owner);
    expect(text).toContain("You owe");
    expect(text).toContain("Owed to you");
    const owedSection = text.split("Owed to you")[1];
    expect(owedSection).toContain("in1");
  });
});

describe("standing in the brief", () => {
  async function seedStandingCache(workspaceId: string, item: { id: string; projects: string[]; createdAt: number }) {
    const cache = {
      v: 1, model: "@cf/google/embeddinggemma-300m", dim: 128, builtAt: Date.now(),
      items: [{ id: item.id, projects: item.projects, createdAt: item.createdAt, vecs: [encodeVector(new Array(128).fill(0.1))] }],
    };
    await env.OAUTH_KV.put(standingKvKey(workspaceId), JSON.stringify(cache));
  }

  it("only appears when a project is given", async () => {
    await createProject(env.DB, owner.personalWorkspaceId, { id: "site", name: "Site", aliases: [] }, env);
    sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'api', ?, '[]', ?, ?)`,
    ).bind("s1", "When X, do Y.", JSON.stringify(["standing:active", "project:site"]), 1000, owner.personalWorkspaceId, owner.userId).run();
    await seedStandingCache(owner.personalWorkspaceId, { id: "s1", projects: ["site"], createdAt: 1000 });

    const withoutProject = await computeAgentBrief(env, ctx, owner);
    expect(withoutProject).not.toContain("Standing instructions for this project");

    const withProject = await computeAgentBrief(env, ctx, owner, [{
      id: "site", workspace_id: owner.personalWorkspaceId, name: "Site", description: "", aliases: [], status: "active", created_at: 1, updated_at: null,
    }]);
    expect(withProject).toContain("Standing instructions for this project");
    expect(withProject).toContain("When X, do Y.");
  });
});

describe("lean brief", () => {
  it("keeps loops outbound and adds owed_to_you and standing", async () => {
    seedTask("out1", ["task"]);
    seedTask("in1", ["task", "owed-to-me"]);
    const lean = await computeLeanBrief(env, ctx, owner);
    expect(lean.loops.items.every((i: any) => !("direction" in i) || i.direction !== "in")).toBe(true);
    expect(lean.owed_to_you.open).toBe(1);
    expect(lean.standing.items).toEqual([]);
  });
});
