/**
 * /projects CRUD end to end through the Worker, against real SQLite.
 *
 * Two members of one brain (Alice the owner, Bob) plus the shared company layer.
 * The questions: does each verb land in the right workspace, can Bob ever reach
 * Alice's personal rows, does every mutation leave an admin_events row, and does
 * counts=1 stay one scan that only tallies explicit `project:` tags.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import type { Env } from "../../src/env";

const BASE = "http://localhost";
const ALICE = "test-token";
let bobToken = "";

let sqlite: SqliteD1;
let env: Env;
let pending: Promise<unknown>[] = [];
let aliceWs = "";
let bobWs = "";
let companyWs = "";
let aliceId = "";
let bobId = "";

const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;

function call(method: string, path: string, token: string | null, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
}
const jsonOf = async (res: Response) => res.json() as Promise<any>;

async function settle(): Promise<void> {
  while (pending.length) {
    const batch = pending;
    pending = [];
    await Promise.all(batch);
  }
}

async function auditRows() {
  await settle();
  const { results } = await env.DB.prepare(
    `SELECT actor_id, workspace_id, event, payload FROM admin_events WHERE event LIKE 'project_%' ORDER BY created_at ASC, rowid ASC`,
  ).all<{ actor_id: string; workspace_id: string; event: string; payload: string }>();
  return results.map(r => ({ ...r, payload: JSON.parse(r.payload) }));
}

function seed(id: string, workspaceId: string, tags: string[], actorId = aliceId) {
  sqlite.db
    .prepare(`INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'test', 1000, 1000, '[]', ?, ?)`)
    .bind(id, `content ${id}`, JSON.stringify(tags), workspaceId, actorId)
    .run();
}

beforeEach(async () => {
  resetDatabaseInit();
  pending = [];
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  const bob = await createMember(env, { name: "Bob" });
  bobToken = bob.token;
  aliceId = roots.ownerUserId;
  aliceWs = roots.ownerPersonalWorkspaceId;
  companyWs = roots.companyWorkspaceId;
  bobId = bob.member.userId;
  bobWs = bob.member.personalWorkspaceId;
  await settle();
  await env.DB.prepare(`DELETE FROM admin_events`).run();
});

afterEach(() => sqlite?.close());

describe("auth", () => {
  it("401s every verb without a token", async () => {
    expect((await call("GET", "/projects", null)).status).toBe(401);
    expect((await call("POST", "/projects", null, { name: "x" })).status).toBe(401);
    expect((await call("PATCH", "/projects/x", null, { name: "y" })).status).toBe(401);
    expect((await call("DELETE", "/projects/x", null)).status).toBe(401);
  });
});

describe("POST /projects", () => {
  it("creates in the caller's personal workspace, deriving the slug from the name", async () => {
    const res = await call("POST", "/projects", ALICE, { name: "My Website", description: "The site", aliases: ["Hosting"] });

    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.project).toEqual({
      id: "my-website", name: "My Website", description: "The site", aliases: ["hosting"], status: "active",
      workspace_id: aliceWs, layer: "personal", created_at: expect.any(Number), updated_at: null,
    });
    expect((await jsonOf(await call("GET", "/projects", ALICE))).projects.map((p: any) => p.id)).toEqual(["my-website"]);
  });

  it("audits project_created with the slug and workspace", async () => {
    await call("POST", "/projects", ALICE, { id: "site", name: "Site" });

    expect(await auditRows()).toEqual([
      { actor_id: aliceId, workspace_id: aliceWs, event: "project_created", payload: { slug: "site" } },
    ]);
  });

  it("returns 409 for a duplicate slug in the same workspace but allows the other layer", async () => {
    await call("POST", "/projects", ALICE, { id: "site", name: "Site" });

    const dup = await call("POST", "/projects", ALICE, { id: "site", name: "Site again" });
    expect(dup.status).toBe(409);
    expect((await jsonOf(dup)).ok).toBe(false);

    const company = await call("POST", "/projects", ALICE, { id: "site", name: "Site", workspace: "company" });
    expect(company.status).toBe(201);
    expect((await jsonOf(company)).project).toMatchObject({ workspace_id: companyWs, layer: "company" });
    expect((await auditRows()).map(r => r.event)).toEqual(["project_created", "project_created"]);
  });

  it("lets two members hold the same slug in their own workspaces", async () => {
    expect((await call("POST", "/projects", ALICE, { id: "site", name: "Site" })).status).toBe(201);
    const bobs = await call("POST", "/projects", bobToken, { id: "site", name: "Site" });
    expect(bobs.status).toBe(201);
    expect((await jsonOf(bobs)).project.workspace_id).toBe(bobWs);
  });

  it.each([
    ["an invalid id", { id: "Bad Id", name: "x" }, /invalid project id "Bad Id": must match/],
    ["a missing name", { id: "x" }, /name/],
    ["a name that yields no slug", { name: "!!!" }, /id/],
    ["a reserved alias", { name: "x", aliases: ["kind:x"] }, /reserved/],
    ["too many aliases", { name: "x", aliases: Array.from({ length: 17 }, (_, i) => `t${i}`) }, /at most 16/],
    ["a bad workspace", { name: "x", workspace: "everyone" }, /workspace must be/],
    ["team without company", { name: "x", team: companyWsPlaceholder() }, /team/],
  ])("400s %s", async (_label, body, message) => {
    const res = await call("POST", "/projects", ALICE, body);
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toMatch(message);
    expect(await auditRows()).toEqual([]);
  });

  it("400s a non-JSON body", async () => {
    const res = await worker.fetch(new Request(`${BASE}/projects`, { method: "POST", headers: { Authorization: `Bearer ${ALICE}` }, body: "{nope" }), env, ctx);
    expect(res.status).toBe(400);
  });
});

// A team id the caller does not belong to; resolved lazily so the table above can be static.
function companyWsPlaceholder() { return "ws-not-mine"; }

describe("GET /projects", () => {
  beforeEach(async () => {
    await call("POST", "/projects", ALICE, { name: "Zebra" });
    await call("POST", "/projects", ALICE, { name: "alpha", workspace: "company" });
    await call("POST", "/projects", bobToken, { name: "Bobs Own" });
    await call("POST", "/projects", ALICE, { name: "Old", aliases: ["legacy"] });
    await call("PATCH", "/projects/old", ALICE, { status: "archived" });
  });

  it("returns the readable set ordered by name, without archived, with the layer", async () => {
    const alice = await jsonOf(await call("GET", "/projects", ALICE));
    expect(alice.projects.map((p: any) => [p.id, p.layer])).toEqual([["alpha", "company"], ["zebra", "personal"]]);
    expect(alice.projects[0]).toMatchObject({ workspace_id: companyWs, name: "alpha", aliases: [], status: "active" });
    expect(alice.projects[0]).not.toHaveProperty("count");
  });

  it("never shows a colleague's personal projects", async () => {
    const bob = await jsonOf(await call("GET", "/projects", bobToken));
    expect(bob.projects.map((p: any) => p.id)).toEqual(["alpha", "bobs-own"]);
    expect(JSON.stringify(bob)).not.toContain("zebra");
  });

  it("include_archived=1 adds archived rows", async () => {
    const all = await jsonOf(await call("GET", "/projects?include_archived=1", ALICE));
    expect(all.projects.map((p: any) => [p.id, p.status])).toEqual([["alpha", "active"], ["old", "archived"], ["zebra", "active"]]);
  });

  it("narrows by workspace and team", async () => {
    expect((await jsonOf(await call("GET", "/projects?workspace=personal", ALICE))).projects.map((p: any) => p.id)).toEqual(["zebra"]);
    expect((await jsonOf(await call("GET", "/projects?workspace=company", ALICE))).projects.map((p: any) => p.id)).toEqual(["alpha"]);
    expect((await jsonOf(await call("GET", `/projects?team=${companyWs}`, ALICE))).projects.map((p: any) => p.id)).toEqual(["alpha"]);
    expect((await call("GET", "/projects?workspace=nope", ALICE)).status).toBe(400);
    expect((await call("GET", "/projects?team=ws-not-mine", ALICE)).status).toBe(400);
  });
});

describe("unsupported methods on /projects", () => {
  beforeEach(async () => {
    await call("POST", "/projects", ALICE, { id: "site", name: "Site" });
  });

  it("answer 405 with an Allow header on the collection", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await call(method, "/projects", ALICE, method === "DELETE" ? undefined : {});
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, POST");
    }
  });

  it("answer 405 with an Allow header on an item, GET included", async () => {
    for (const method of ["GET", "POST", "PUT"]) {
      const res = await call(method, "/projects/site", ALICE, method === "GET" ? undefined : {});
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("PATCH, DELETE");
    }
  });

  it("refuse an anonymous caller before judging the method", async () => {
    expect((await call("PUT", "/projects", null, {})).status).toBe(401);
  });

  it("leave the supported methods alone", async () => {
    expect((await call("GET", "/projects", ALICE)).status).toBe(200);
    expect((await call("PATCH", "/projects/site", ALICE, { name: "Site 2" })).status).toBe(200);
  });
});

describe("GET /projects?counts=1", () => {
  beforeEach(async () => {
    await call("POST", "/projects", ALICE, { id: "site", name: "Site", aliases: ["hosting"] });
    await call("POST", "/projects", ALICE, { id: "app", name: "App" });
    await call("POST", "/projects", ALICE, { id: "site", name: "Site", workspace: "company" });
    seed("m1", aliceWs, ["project:site", "x"]);
    seed("m2", aliceWs, ["Project:site"]);
    seed("m3", aliceWs, ["project:site", "project:app"]);
    seed("dup", aliceWs, ["project:app", "project:app"]);
    seed("aliased", aliceWs, ["hosting"]); // alias match is NOT counted
    seed("plain", aliceWs, ["site"]);
    seed("co", companyWs, ["project:site"]);
    seed("bobs", bobWs, ["project:site", "project:app"], bobId);
  });

  it("tallies explicit project: tags per workspace row, once per entry", async () => {
    const { projects } = await jsonOf(await call("GET", "/projects?counts=1", ALICE));

    const byKey = Object.fromEntries(projects.map((p: any) => [`${p.layer}/${p.id}`, p.count]));
    expect(byKey).toEqual({ "personal/site": 3, "personal/app": 2, "company/site": 1 });
  });

  it("does not count a colleague's private entries", async () => {
    const { projects } = await jsonOf(await call("GET", "/projects?counts=1", bobToken));
    expect(Object.fromEntries(projects.map((p: any) => [`${p.layer}/${p.id}`, p.count]))).toEqual({ "company/site": 1 });
  });

  it("gives an empty project a count of 0 and omits counts_approximate", async () => {
    await call("POST", "/projects", ALICE, { id: "empty", name: "Empty" });
    const body = await jsonOf(await call("GET", "/projects?counts=1", ALICE));
    expect(body.projects.find((p: any) => p.id === "empty").count).toBe(0);
    expect(body).not.toHaveProperty("counts_approximate");
  });

  it("issues exactly one entries statement, riding the partial index", async () => {
    await call("GET", "/projects", ALICE); // settle any lazy identity work
    sqlite.issued.length = 0;

    await call("GET", "/projects?counts=1", ALICE);

    const entries = sqlite.issued.filter(s => /\bFROM entries\b/i.test(s));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("idx_entries_project");
    expect(entries[0]).toMatch(/LIMIT 5000/);
  });

  it("still answers when idx_entries_project does not exist yet, by retrying without the hint", async () => {
    // A just-upgraded brain: the table is there, the index is created a beat later.
    sqlite.db.prepare(`DROP INDEX idx_entries_project`).run();
    await call("GET", "/projects", ALICE);
    sqlite.issued.length = 0;

    const res = await call("GET", "/projects?counts=1", ALICE);

    expect(res.status).toBe(200);
    const { projects } = await jsonOf(res);
    expect(Object.fromEntries(projects.map((p: any) => [`${p.layer}/${p.id}`, p.count]))).toEqual({ "personal/site": 3, "personal/app": 2, "company/site": 1 });
    const entries = sqlite.issued.filter(s => /\bFROM entries\b/i.test(s));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain("INDEXED BY idx_entries_project");
    expect(entries[1]).not.toContain("INDEXED BY");
  });

  it("does not swallow an unrelated failure of the counts scan", async () => {
    const prepare = env.DB.prepare.bind(env.DB);
    (env.DB as { prepare: unknown }).prepare = (sql: string) => {
      if (/INDEXED BY idx_entries_project/.test(sql)) throw new Error("D1_ERROR: database is locked");
      return prepare(sql);
    };
    expect((await call("GET", "/projects?counts=1", ALICE)).status).toBe(500);
  });

  it("flags counts_approximate when the 5000 row scan is exhausted", async () => {
    const insert = sqlite.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES (?, 'c', ?, 'test', 1, '[]', ?, ?)`);
    for (let i = 0; i < 5001; i++) await insert.bind(`big-${i}`, '["project:app"]', aliceWs, aliceId).run();

    const body = await jsonOf(await call("GET", "/projects?counts=1", ALICE));

    expect(body.counts_approximate).toBe(true);
    expect(body.projects.find((p: any) => p.id === "app" && p.layer === "personal").count).toBeLessThanOrEqual(5000);
  });
});

describe("PATCH /projects/:slug", () => {
  beforeEach(async () => {
    await call("POST", "/projects", ALICE, { id: "site", name: "Site", description: "old", aliases: ["web"] });
    await env.DB.prepare(`DELETE FROM admin_events`).run();
  });

  it("applies a partial update, stamps updated_at and audits the changed fields", async () => {
    const res = await call("PATCH", "/projects/site", ALICE, { name: "Website", aliases: ["Hosting", "dns"] });

    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.project).toMatchObject({ id: "site", name: "Website", description: "old", aliases: ["hosting", "dns"], status: "active", layer: "personal" });
    expect(body.project.updated_at).toEqual(expect.any(Number));
    expect(await auditRows()).toEqual([
      { actor_id: aliceId, workspace_id: aliceWs, event: "project_updated", payload: { slug: "site", fields: ["name", "aliases"] } },
    ]);
  });

  it("archives and reactivates", async () => {
    expect((await jsonOf(await call("PATCH", "/projects/site", ALICE, { status: "archived" }))).project.status).toBe("archived");
    expect((await jsonOf(await call("PATCH", "/projects/site", ALICE, { status: "active" }))).project.status).toBe("active");
  });

  it("400s an invalid alias, an empty patch and a bad status without auditing", async () => {
    expect((await call("PATCH", "/projects/site", ALICE, { aliases: ["status:x"] })).status).toBe(400);
    expect((await call("PATCH", "/projects/site", ALICE, {})).status).toBe(400);
    expect((await call("PATCH", "/projects/site", ALICE, { status: "gone" })).status).toBe(400);
    expect((await call("PATCH", "/projects/Bad!", ALICE, { name: "x" })).status).toBe(400);
    expect(await auditRows()).toEqual([]);
  });

  it("404s an unknown slug", async () => {
    const res = await call("PATCH", "/projects/nope", ALICE, { name: "x" });
    expect(res.status).toBe(404);
    expect((await jsonOf(res)).error).toBe('unknown project "nope"');
  });

  it("404s a colleague's personal project and leaves it untouched", async () => {
    expect((await call("PATCH", "/projects/site", bobToken, { name: "Hijacked" })).status).toBe(404);
    expect((await jsonOf(await call("GET", "/projects", ALICE))).projects[0].name).toBe("Site");
  });

  it("needs a workspace when the slug exists in two readable workspaces", async () => {
    await call("POST", "/projects", ALICE, { id: "site", name: "Company Site", workspace: "company" });

    const ambiguous = await call("PATCH", "/projects/site", ALICE, { name: "x" });
    expect(ambiguous.status).toBe(400);
    expect((await jsonOf(ambiguous)).error).toMatch(/more than one workspace/);

    const company = await call("PATCH", "/projects/site?workspace=company", ALICE, { description: "shared" });
    expect(company.status).toBe(200);
    expect((await jsonOf(company)).project).toMatchObject({ workspace_id: companyWs, description: "shared" });
    const viaTeam = await call("PATCH", `/projects/site?team=${companyWs}`, ALICE, { description: "shared2" });
    expect((await jsonOf(viaTeam)).project.description).toBe("shared2");
    const personal = await call("PATCH", "/projects/site?workspace=personal", ALICE, { description: "mine" });
    expect((await jsonOf(personal)).project).toMatchObject({ workspace_id: aliceWs, description: "mine" });
  });

  it("lets a member edit a company project", async () => {
    await call("POST", "/projects", ALICE, { id: "shared", name: "Shared", workspace: "company" });
    const res = await call("PATCH", "/projects/shared", bobToken, { name: "Shared v2" });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /projects/:slug", () => {
  beforeEach(async () => {
    await call("POST", "/projects", ALICE, { id: "site", name: "Site" });
    seed("m1", aliceWs, ["project:site"]);
    await env.DB.prepare(`DELETE FROM admin_events`).run();
  });

  it("removes only the registry row, keeps member tags, and audits", async () => {
    const res = await call("DELETE", "/projects/site", ALICE);

    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true, deleted: true });
    expect((await jsonOf(await call("GET", "/projects", ALICE))).projects).toEqual([]);
    const tags = await sqlite.db.prepare(`SELECT tags FROM entries WHERE id = 'm1'`).first() as { tags: string };
    expect(JSON.parse(tags.tags)).toEqual(["project:site"]);
    expect(await auditRows()).toEqual([
      { actor_id: aliceId, workspace_id: aliceWs, event: "project_deleted", payload: { slug: "site" } },
    ]);
  });

  it("404s an unknown slug and never touches a colleague's project", async () => {
    expect((await call("DELETE", "/projects/nope", ALICE)).status).toBe(404);
    expect((await call("DELETE", "/projects/site", bobToken)).status).toBe(404);
    expect((await jsonOf(await call("GET", "/projects", ALICE))).projects).toHaveLength(1);
    expect(await auditRows()).toEqual([]);
  });

  it("requires a workspace when the slug is ambiguous", async () => {
    await call("POST", "/projects", ALICE, { id: "site", name: "Site", workspace: "company" });
    expect((await call("DELETE", "/projects/site", ALICE)).status).toBe(400);
    expect((await call("DELETE", "/projects/site?workspace=company", ALICE)).status).toBe(200);
    expect((await jsonOf(await call("GET", "/projects", ALICE))).projects.map((p: any) => p.layer)).toEqual(["personal"]);
  });
});

describe("the compliance feed", () => {
  it("never surfaces project events, so a member's personal project names stay private", async () => {
    await call("POST", "/projects", bobToken, { id: "job-hunt", name: "Job Hunt" });
    await call("PATCH", "/projects/job-hunt", bobToken, { name: "Career" });
    await call("DELETE", "/projects/job-hunt", bobToken);
    await settle();
    expect((await auditRows()).map(r => r.event)).toEqual(["project_created", "project_updated", "project_deleted"]);

    const feed = await jsonOf(await call("GET", "/team/activity", ALICE));

    expect(feed.events.some((e: any) => String(e.event).startsWith("project_"))).toBe(false);
    expect(JSON.stringify(feed)).not.toContain("job-hunt");
  });
});
