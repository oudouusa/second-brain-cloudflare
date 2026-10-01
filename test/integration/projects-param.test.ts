/**
 * The `project` param on capture, list, digest, graph and recall, end to end
 * through the Worker against real SQLite.
 *
 * A project is `project:<slug>` plus its aliases, so every read asks the same
 * two questions: does an entry tagged only with an ALIAS (a legacy plain tag)
 * come back, and does nothing outside the project or the caller's scope.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { compressTag } from "../../src/compression/digest";
import { createProject as createProjectRow, getProject } from "../../src/projects/registry";
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
const BAD_SLUG = 'invalid project tag "Bad Slug!": must match [a-z0-9][a-z0-9_-]{0,63}';
const OLD = Date.now() - 200 * 24 * 3600 * 1000;

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

// forkの検索条件はURLへ載せずJSON本文で渡す。
async function read(path: string, token = ALICE) {
  const url = new URL(path, BASE);
  const body: Record<string, unknown> = Object.fromEntries(url.searchParams);
  for (const k of ["n", "topK", "top_k", "hops", "after", "before"]) if (body[k] !== undefined) body[k] = Number(body[k]);
  return call("POST", url.pathname, token, body);
}

async function projectAudit() {
  await settle();
  const { results } = await env.DB.prepare(
    `SELECT actor_id, workspace_id, event, payload FROM admin_events WHERE event LIKE 'project_%' ORDER BY created_at ASC, rowid ASC`,
  ).all<{ actor_id: string; workspace_id: string; event: string; payload: string }>();
  return results.map(r => ({ ...r, payload: JSON.parse(r.payload) }));
}

function seed(id: string, workspaceId: string, tags: string[], opts: { createdAt?: number; actorId?: string; content?: string } = {}) {
  sqlite.db
    .prepare(`INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'test', ?, ?, ?, ?, ?)`)
    .bind(id, opts.content ?? `site note ${id}`, JSON.stringify(tags), opts.createdAt ?? 1000, opts.createdAt ?? 1000, JSON.stringify([`v-${id}`]), workspaceId, opts.actorId ?? aliceId)
    .run();
}

function seedEdge(id: string, a: string, b: string, weight: number, workspaceId = aliceWs) {
  sqlite.db
    .prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id) VALUES (?, ?, ?, 'relates_to', ?, 'explicit', '{}', 1, 1, ?)`)
    .bind(id, a, b, weight, workspaceId)
    .run();
}

const registry = async () =>
  (await sqlite.db.prepare(`SELECT id, workspace_id, name, status FROM projects ORDER BY workspace_id, id`).all()).results as { id: string; workspace_id: string; name: string; status: string }[];

async function createProject(token: string, body: Record<string, unknown>) {
  const res = await call("POST", "/projects", token, body);
  expect(res.status).toBe(201);
}

describe("GET /brief with project", () => {
  it("counts project tags and aliases across the readable scope", async () => {
    await createProject(ALICE, { id: "site", name: "Site", aliases: ["hosting"] });
    seed("direct", aliceWs, ["project:site", "task"], { createdAt: Date.now() });
    seed("alias", aliceWs, ["hosting", "task"], { createdAt: Date.now() });
    seed("other", aliceWs, ["task"], { createdAt: Date.now() });
    seed("private", bobWs, ["project:site", "task"], { createdAt: Date.now(), actorId: bobId });
    const res = await call("GET", "/brief?project=site&preview=1", ALICE);
    expect(res.status).toBe(200);
    const data = await jsonOf(res);
    expect(data.captured).toBe(2);
    expect(data.loops.open).toBe(2);
    expect(data.loops.items.map((item: any) => item.id).sort()).toEqual(["alias", "direct"]);
  });

  it("rejects unknown projects with the known slugs", async () => {
    await createProject(ALICE, { id: "site", name: "Site" });
    const res = await call("GET", "/brief?project=nope", ALICE);
    expect(res.status).toBe(404);
    expect(await jsonOf(res)).toEqual({ ok: false, error: 'unknown project "nope"', known_projects: ["site"] });
  });
});

beforeEach(async () => {
  resetDatabaseInit();
  pending = [];
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    // The tag-first recall branch fetches stored vectors by id and scores them locally.
    VECTORIZE: makeVectorizeMock({
      getByIds: (async (ids: string[]) =>
        ids.map(id => ({ id, values: new Array(384).fill(0.1), metadata: { parentId: id.replace(/^v-/, "") } }))) as unknown as Vectorize["getByIds"],
    }),
  });
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

describe("POST /capture with project", () => {
  it("unions project:<slug> into the tags, auto-creates the project and audits it", async () => {
    const res = await call("POST", "/capture", ALICE, { content: "Decided to move hosting to Fly", tags: ["infra"], project: "website" });

    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.tags).toEqual(expect.arrayContaining(["infra", "project:website"]));
    expect(await registry()).toEqual([{ id: "website", workspace_id: aliceWs, name: "website", status: "active" }]);
    expect(await projectAudit()).toEqual([
      { actor_id: aliceId, workspace_id: aliceWs, event: "project_autocreated", payload: { slug: "website" } },
    ]);
    const row = await sqlite.db.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(body.id).first() as { tags: string };
    expect(JSON.parse(row.tags)).toEqual(expect.arrayContaining(["project:website"]));
  });

  it("caps the caller's tags only: 自動付与を含めて16タグまで保存する", async () => {
    const sixtyFour = Array.from({ length: 14 }, (_, i) => `t${i}`);

    const res = await call("POST", "/capture", ALICE, { content: "full tag list, worker adds two more", tags: sixtyFour, project: "website", volatility: "durable" });

    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.tags).toHaveLength(16);
    const row = await sqlite.db.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(body.id).first() as { tags: string };
    const stored = JSON.parse(row.tags) as string[];
    expect(stored).toHaveLength(16);
    expect(stored).toEqual(expect.arrayContaining(["project:website", "volatility:durable", "t0", "t13"]));
    expect(await registry()).toEqual([{ id: "website", workspace_id: aliceWs, name: "website", status: "active" }]);
  });

  it("still 400s 65 caller tags, with a project and volatility or without", async () => {
    const sixtyFive = Array.from({ length: 65 }, (_, i) => `t${i}`);
    const message = "tags must contain at most 64 NUL-free strings of at most 128 characters";

    for (const extra of [{ project: "website", volatility: "durable" }, {}]) {
      const res = await call("POST", "/capture", ALICE, { content: "one tag too many", tags: sixtyFive, ...extra });
      expect(res.status).toBe(400);
      expect((await jsonOf(res)).error).toBe(message);
    }
    expect(await registry()).toEqual([]);
  });

  it("does not re-create, re-audit or overwrite an existing project", async () => {
    await createProject(ALICE, { id: "website", name: "The Website", description: "keep me" });
    await env.DB.prepare(`DELETE FROM admin_events`).run();

    await call("POST", "/capture", ALICE, { content: "First note about the site", project: "website" });
    await call("POST", "/capture", ALICE, { content: "A completely different second note", project: "website" });

    expect(await registry()).toEqual([{ id: "website", workspace_id: aliceWs, name: "The Website", status: "active" }]);
    expect(await projectAudit()).toEqual([]);
  });

  it("creates the project in the workspace the entry landed in", async () => {
    await call("POST", "/capture", ALICE, { content: "Shared launch checklist", project: "launch", workspace: "company" });

    expect(await registry()).toEqual([{ id: "launch", workspace_id: companyWs, name: "launch", status: "active" }]);
    expect((await projectAudit())[0]).toMatchObject({ workspace_id: companyWs, event: "project_autocreated" });
  });

  it("400s an invalid slug with the grammar error and stores nothing", async () => {
    const res = await call("POST", "/capture", ALICE, { content: "note", project: "Bad Slug!" });

    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ ok: false, error: BAD_SLUG });
    expect((await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM entries`).first() as { n: number }).n).toBe(0);
    expect(await registry()).toEqual([]);
  });

  it("400s a non-string project", async () => {
    expect((await call("POST", "/capture", ALICE, { content: "note", project: 5 })).status).toBe(400);
  });

  it("ignores an empty project, like every other optional param", async () => {
    const res = await call("POST", "/capture", ALICE, { content: "note without a project", project: "" });
    expect(res.status).toBe(200);
    expect(await registry()).toEqual([]);
  });

  it("does not create a project when the capture is blocked as a duplicate", async () => {
    env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({
        query: (async () => ({ matches: [{ id: "existing", score: 0.99, metadata: { parentId: "existing" } }] })) as unknown as Vectorize["query"],
      }),
    });
    seed("existing", aliceWs, []);

    const res = await call("POST", "/capture", ALICE, { content: "Duplicate note", project: "ghost" });

    expect((await jsonOf(res)).duplicate).toBe(true);
    expect(await registry()).toEqual([]);
  });

  it("a literal project: tag alone never creates a registry row", async () => {
    await call("POST", "/capture", ALICE, { content: "Tagged directly", tags: ["project:direct"] });
    expect(await registry()).toEqual([]);
  });
});

describe("POST /list with project", () => {
  beforeEach(async () => {
    await createProject(ALICE, { id: "site", name: "Site", aliases: ["hosting"] });
    seed("member", aliceWs, ["project:site", "infra"]);
    seed("aliased", aliceWs, ["hosting"]);
    seed("other", aliceWs, ["infra"]);
    seed("other-project", aliceWs, ["project:app"]);
    seed("bobs", bobWs, ["project:site"], { actorId: bobId });
    seed("shared", companyWs, ["project:site"]);
  });

  const ids = async (path: string, token = ALICE) => (await jsonOf(await read(path, token))).map((e: any) => e.id).sort();

  it("returns members and alias-matched entries across the readable layers, nothing else", async () => {
    // "shared" is a company-layer member: membership is the tag, wherever Alice can read it.
    expect(await ids("/list?project=site&n=50")).toEqual(["aliased", "member", "shared"]);
  });

  it("ANDs with the tag filter", async () => {
    expect(await ids("/list?project=site&tag=infra&n=50")).toEqual(["member"]);
    expect(await ids("/list?project=site&tag=hosting&n=50")).toEqual(["aliased"]);
  });

  it("stays inside the caller's scope and follows the layer filter", async () => {
    await createProject(ALICE, { id: "site", name: "Company Site", workspace: "company" });

    expect(await ids("/list?project=site&n=50&workspace=company")).toEqual(["shared"]);
    expect(await ids("/list?project=site&n=50&workspace=personal")).toEqual(["aliased", "member"]);
    // Bob sees the company row and his own, never Alice's personal ones.
    await createProject(bobToken, { id: "site", name: "Bob Site" });
    expect(await ids("/list?project=site&n=50", bobToken)).toEqual(["bobs", "shared"]);
  });

  it("still filters an archived project", async () => {
    await call("PATCH", "/projects/site", ALICE, { status: "archived" });
    expect(await ids("/list?project=site&n=50")).toEqual(["aliased", "member", "shared"]);
  });

  it("404s an unknown project and names the known ones", async () => {
    const res = await read("/list?project=nope", ALICE);

    expect(res.status).toBe(404);
    expect(await jsonOf(res)).toEqual({ ok: false, error: 'unknown project "nope"', known_projects: ["site"] });
  });

  it("does not resolve a colleague's personal project", async () => {
    const res = await read("/list?project=site", bobToken);
    expect(res.status).toBe(404);
    expect((await jsonOf(res)).known_projects).toEqual([]);
  });

  it("400s an invalid slug and ignores an empty one", async () => {
    const bad = await read("/list?project=Bad%20Slug!", ALICE);
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad)).error).toBe(BAD_SLUG);
    expect((await ids("/list?project=&n=50")).length).toBe(5);
  });
});

describe("POST /digest with project", () => {
  beforeEach(async () => {
    await createProject(ALICE, { id: "site", name: "Site", aliases: ["hosting"] });
  });

  const seedMembers = (n: number, aliased = 0) => {
    for (let i = 0; i < n; i++) seed(`m${i}`, aliceWs, ["project:site"], { createdAt: OLD + i });
    for (let i = 0; i < aliased; i++) seed(`a${i}`, aliceWs, ["hosting"], { createdAt: OLD + 100 + i });
  };

  it("400s when both tag and project are given", async () => {
    const res = await read("/digest?tag=x&project=site", ALICE);
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toMatch(/tag or project/);
  });

  it("400s when neither is given", async () => {
    const res = await read("/digest", ALICE);
    expect(res.status).toBe(400);
  });

  it("digests members and alias-matched entries into a synthesized, project-tagged entry", async () => {
    seedMembers(8, 4);
    seed("outsider", aliceWs, ["infra"], { createdAt: OLD });

    const res = await read("/digest?project=site", ALICE);

    const body = await jsonOf(res);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ project: "site", source_count: 12, entry_id: expect.any(String), synthesis: expect.any(String) });
    const digest = await sqlite.db.prepare(`SELECT tags, workspace_id FROM entries WHERE id = ?`).bind(body.entry_id).first() as { tags: string; workspace_id: string };
    expect(JSON.parse(digest.tags)).toEqual(expect.arrayContaining(["synthesized", "project:site"]));
    expect(digest.workspace_id).toBe(aliceWs);
    const rolled = (await sqlite.db.prepare(`SELECT id FROM entries WHERE tags LIKE '%"rolled-up"%' ORDER BY id`).all()).results as { id: string }[];
    expect(rolled).toHaveLength(12);
    expect(rolled.map(r => r.id)).not.toContain("outsider");
  });

  it("uses the existing 10-entry threshold and says so", async () => {
    seedMembers(9);

    const res = await read("/digest?project=site", ALICE);

    const body = await jsonOf(res);
    expect(body.project).toBe("site");
    expect(body.entry_id).toBeUndefined();
    expect(body.error).toBe("Could not create digest: the project may have fewer than 10 eligible entries or was recently compressed");
    expect(body.source_count).toBe(0);
  });

  it("works for an archived project and does not repeat inside the 24h cooldown", async () => {
    seedMembers(12);
    await call("PATCH", "/projects/site", ALICE, { status: "archived" });

    expect((await jsonOf(await read("/digest?project=site", ALICE))).entry_id).toBeTruthy();
    seedMembers(0);
    for (let i = 20; i < 40; i++) seed(`n${i}`, aliceWs, ["project:site"], { createdAt: OLD + i });
    const again = await jsonOf(await read("/digest?project=site", ALICE));
    expect(again.entry_id).toBeUndefined();
  });

  it("404s an unknown project and never digests a colleague's", async () => {
    expect((await read("/digest?project=nope", ALICE)).status).toBe(404);
    seedMembers(12);
    expect((await read("/digest?project=site", bobToken)).status).toBe(404);
    expect((await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"rolled-up"%'`).first() as { n: number }).n).toBe(0);
  });

  it("compressTag only opens the project door for that project's own key", async () => {
    seedMembers(12);
    const rows = await getProject(env.DB, [aliceWs], "site");

    const wrongKey = await compressTag("project:other", env, ctx, { workspaceIds: [aliceWs], project: rows });
    const noRows = await compressTag("project:site", env, ctx, { workspaceIds: [aliceWs] });

    expect(wrongKey.synthesizedId).toBeNull();
    expect(noRows.synthesizedId).toBeNull();
    expect((await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"rolled-up"%'`).first() as { n: number }).n).toBe(0);
  });

  it("refuses a bare project: tag through ?tag=, since only the registry drives project digests", async () => {
    seedMembers(12);
    const body = await jsonOf(await read("/digest?tag=project:site", ALICE));
    expect(body.entry_id).toBeUndefined();
    expect((await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"rolled-up"%'`).first() as { n: number }).n).toBe(0);
  });
});

describe("POST /digest with the same slug in two workspaces", () => {
  const rolledUpIds = async () =>
    ((await sqlite.db.prepare(`SELECT id FROM entries WHERE tags LIKE '%"rolled-up"%' ORDER BY id`).all()).results as { id: string }[]).map(r => r.id);

  it("never rolls up entries matched only by the other workspace's alias", async () => {
    await createProjectRow(env.DB, aliceWs, { id: "roadmap", name: "Roadmap", aliases: ["q3"] }, sqlite.admitEnv(env));
    await createProjectRow(env.DB, companyWs, { id: "roadmap", name: "Roadmap", aliases: ["pricing"] }, sqlite.admitEnv(env));
    for (let i = 0; i < 12; i++) seed(`p${i}`, aliceWs, ["project:roadmap"], { createdAt: OLD + i });
    for (let i = 0; i < 12; i++) seed(`c${i}`, companyWs, ["project:roadmap"], { createdAt: OLD + i });
    // Each is claimed only by the alias of the workspace it does NOT live in.
    for (let i = 0; i < 12; i++) seed(`ap${i}`, aliceWs, ["pricing"], { createdAt: OLD + i });
    for (let i = 0; i < 12; i++) seed(`cq${i}`, companyWs, ["q3"], { createdAt: OLD + i });

    const res = await read("/digest?project=roadmap", ALICE);

    expect(res.status).toBe(200);
    const rolled = await rolledUpIds();
    expect(rolled.filter(id => id.startsWith("ap") || id.startsWith("cq"))).toEqual([]);
    expect(rolled.filter(id => id.startsWith("p"))).toHaveLength(12);
    expect(rolled.filter(id => id.startsWith("c") && !id.startsWith("cq"))).toHaveLength(12);
  });

  it("uses each workspace's own aliases for that workspace's rollup", async () => {
    await createProjectRow(env.DB, aliceWs, { id: "roadmap", name: "Roadmap", aliases: ["q3"] }, sqlite.admitEnv(env));
    await createProjectRow(env.DB, companyWs, { id: "roadmap", name: "Roadmap", aliases: ["pricing"] }, sqlite.admitEnv(env));
    for (let i = 0; i < 6; i++) seed(`p${i}`, aliceWs, ["project:roadmap"], { createdAt: OLD + i });
    for (let i = 0; i < 6; i++) seed(`aq${i}`, aliceWs, ["q3"], { createdAt: OLD + i });
    for (let i = 0; i < 12; i++) seed(`cp${i}`, companyWs, ["pricing"], { createdAt: OLD + i });

    expect((await read("/digest?project=roadmap", ALICE)).status).toBe(200);

    const rolled = await rolledUpIds();
    expect(rolled.filter(id => id.startsWith("aq") || id.startsWith("p"))).toHaveLength(12);
    expect(rolled.filter(id => id.startsWith("cp"))).toHaveLength(12);
  });

  it("400s and asks for narrowing when the merged aliases exceed the pattern cap", async () => {
    const aliases = Array.from({ length: 45 }, (_, i) => `tag-${i}`);
    sqlite.db
      .prepare(`INSERT INTO projects (id, workspace_id, name, description, aliases, status, created_at) VALUES ('big', ?, 'Big', '', ?, 'active', 1)`)
      .bind(aliceWs, JSON.stringify(aliases))
      .run();
    for (let i = 0; i < 12; i++) seed(`b${i}`, aliceWs, ["project:big"], { createdAt: OLD + i });

    const res = await read("/digest?project=big", ALICE);

    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toMatch(/narrow/);
    expect(await rolledUpIds()).toEqual([]);
  });
});

describe("GET /graph with project", () => {
  beforeEach(async () => {
    await createProject(ALICE, { id: "site", name: "Site", aliases: ["hosting"] });
    seed("m1", aliceWs, ["project:site"]);
    seed("m2", aliceWs, ["project:site"]);
    seed("a1", aliceWs, ["hosting"]);
    seed("o1", aliceWs, ["infra"]);
    seed("o2", aliceWs, ["infra"]);
    seed("o3", aliceWs, ["infra"]);
    seedEdge("e1", "m1", "o1", 0.9);
    seedEdge("e2", "o2", "o3", 0.95); // strongest edge, but no member endpoint
    seedEdge("e3", "a1", "o2", 0.5);
    seedEdge("e4", "m2", "m1", 0.4);
  });

  const pairs = (g: any) => g.edges.map((e: any) => [e.source, e.target].sort().join("-")).sort();

  it("without project the strongest edge leads, as before", async () => {
    const g = await jsonOf(await call("GET", "/graph", ALICE));
    expect(pairs(g)).toContain("o2-o3");
  });

  it("seeds only from edges that touch a member or an alias-matched entry", async () => {
    const g = await jsonOf(await call("GET", "/graph?project=site", ALICE));

    expect(pairs(g)).toEqual(["a1-o2", "m1-m2", "m1-o1"]);
    expect(g.nodes.map((n: any) => n.id).sort()).toEqual(["a1", "m1", "m2", "o1", "o2"]);
  });

  it("404s an unknown project and hides a colleague's", async () => {
    expect((await call("GET", "/graph?project=nope", ALICE)).status).toBe(404);
    expect((await call("GET", "/graph?project=site", bobToken)).status).toBe(404);
  });

  it("does not leak another workspace's members through an alias", async () => {
    seed("bobs", bobWs, ["hosting"], { actorId: bobId });
    seed("bobs-peer", bobWs, ["infra"], { actorId: bobId });
    seedEdge("eb", "bobs", "bobs-peer", 0.99, bobWs);

    const g = await jsonOf(await call("GET", "/graph?project=site", ALICE));
    expect(g.nodes.map((n: any) => n.id)).not.toContain("bobs");
  });
});

describe("POST /recall with project", () => {
  beforeEach(async () => {
    await createProject(ALICE, { id: "site", name: "Site", aliases: ["hosting"] });
    seed("member", aliceWs, ["project:site"], { content: "site hosting notes about the deploy" });
    seed("aliased", aliceWs, ["hosting"], { content: "legacy site hosting notes from before projects" });
    seed("other", aliceWs, ["infra"], { content: "site hosting notes about something else" });
    seed("other-project", aliceWs, ["project:app"], { content: "site hosting notes for the app" });
    seed("bobs", bobWs, ["project:site"], { content: "bobs private site hosting notes", actorId: bobId });
  });

  const recallIds = async (path: string, token = ALICE) => {
    const res = await read(path, token);
    expect(res.status).toBe(200);
    return (await jsonOf(res)).results.map((r: any) => r.id).sort();
  };

  it("returns members and alias-matched entries only", async () => {
    expect(await recallIds("/recall?query=site%20hosting%20notes&project=site&topK=10")).toEqual(["aliased", "member"]);
  });

  it("without project the same query sees the whole readable set", async () => {
    expect(await recallIds("/recall?query=site%20hosting%20notes&topK=10")).toEqual(["aliased", "member", "other", "other-project"]);
  });

  it("ANDs with the tag filter", async () => {
    expect(await recallIds("/recall?query=site%20hosting%20notes&project=site&tag=hosting&topK=10")).toEqual(["aliased"]);
  });

  it("never reaches a colleague's private entries", async () => {
    await createProject(bobToken, { id: "site", name: "Bob Site" });
    expect(await recallIds("/recall?query=site%20hosting%20notes&project=site&topK=10", bobToken)).toEqual(["bobs"]);
  });

  it("returns an empty result set for a known project with no members", async () => {
    await createProject(ALICE, { id: "empty", name: "Empty" });
    const res = await read("/recall?query=site%20hosting&project=empty", ALICE);
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).results).toEqual([]);
  });

  it("404s an unknown project with the known slugs, and 400s a bad one", async () => {
    const res = await read("/recall?query=x&project=nope", ALICE);
    expect(res.status).toBe(404);
    expect(await jsonOf(res)).toEqual({ ok: false, error: 'unknown project "nope"', known_projects: ["site"] });
    expect((await read("/recall?query=x&project=Bad%20Slug!", ALICE)).status).toBe(400);
  });

  it("drops a graph-expanded neighbour that is not a member (hydration filter)", async () => {
    // Candidates are members only, but hops=1 walks edges to non-members; only the
    // hydration filter stands between them and the response.
    seedEdge("r1", "member", "other", 0.9);

    const ids = await recallIds("/recall?query=site%20hosting%20notes&project=site&topK=10&hops=1");

    expect(ids).toEqual(["aliased", "member"]);
    sqlite.issued.length = 0;
    await read("/recall?query=site%20hosting%20notes&project=site&topK=10&hops=1", ALICE);
    const hydration = sqlite.issued.filter(s => s.includes("superseded_by_json") && /FROM entries WHERE id IN/.test(s));
    expect(hydration.length).toBeGreaterThan(0);
    for (const sql of hydration) expect(sql).toMatch(/tags LIKE \? ESCAPE/);
  });
});
