/**
 * GET /export carries the projects table and POST /import restores it, so a
 * backup keeps every project's name, description, aliases and archived status.
 *
 * Scoped and paged like entries and edges: only readable workspaces export, a
 * restore lands in the caller's own workspace, an existing project is kept, and
 * the file pages on its own project_offset cursor.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { createProject, updateProject } from "../../src/projects/registry";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const ALICE = "test-token";

interface Brain { env: Env; sqlite: SqliteD1; aliceWs: string; companyWs: string; bobToken: string; bobWs: string }

async function makeBrain(): Promise<Brain> {
  resetDatabaseInit();
  const sqlite = makeSqliteD1();
  const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  const bob = await createMember(env, { name: "Bob" });
  return { env, sqlite, aliceWs: roots.ownerPersonalWorkspaceId, companyWs: roots.companyWorkspaceId, bobToken: bob.token, bobWs: bob.member.personalWorkspaceId };
}

const call = (brain: Brain, method: string, path: string, token: string, body?: unknown) =>
  worker.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), brain.env, ctx);
const jsonOf = async (res: Response) => res.json() as Promise<any>;

async function importAll(brain: Brain, token: string, payload: any) {
  const total: any = { imported: 0, skipped: 0, failed: 0, projects_imported: 0, projects_skipped: 0, projects_failed: 0 };
  let cursor = { next_offset: 0, next_edge_offset: 0, next_project_offset: 0 };
  for (let i = 0; i < 100; i++) {
    const res = await call(brain, "POST", `/import?offset=${cursor.next_offset}&edge_offset=${cursor.next_edge_offset}&project_offset=${cursor.next_project_offset}`, token, payload);
    expect(res.status).toBe(200);
    const page = await jsonOf(res);
    for (const k of Object.keys(total)) total[k] += page[k];
    cursor = page;
    if (!page.remaining_entries && !page.remaining_edges && !page.remaining_projects) return new Response(JSON.stringify({ ...page, ...total }));
  }
  throw new Error("復元カーソルが完了しない");
}

let source: Brain;
let target: Brain;

beforeEach(async () => {
  source = await makeBrain();
  await createProject(source.env.DB, source.aliceWs, { id: "site", name: "Site relaunch", description: "The marketing site", aliases: ["hosting", "web"] }, source.sqlite.admitEnv(source.env));
  await createProject(source.env.DB, source.aliceWs, { id: "old-app", name: "Old app" }, source.sqlite.admitEnv(source.env));
  await updateProject(source.env.DB, source.aliceWs, "old-app", { status: "archived" }, source.sqlite.admitEnv(source.env));
  source.sqlite.db
    .prepare(`INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES ('e1', 'a note', '["project:site"]', 'api', 1000, 1000, '[]', ?, '')`)
    .bind(source.aliceWs)
    .run();
  target = await makeBrain();
});

afterEach(() => {
  source?.sqlite.close();
  target?.sqlite.close();
});

const projectsOf = async (brain: Brain, token = ALICE) =>
  (await jsonOf(await call(brain, "GET", "/projects?include_archived=1", token))).projects as any[];

describe("GET /export", () => {
  it("is version 3 and carries every project, archived included, with its fields", async () => {
    const data = await jsonOf(await call(source, "GET", "/export", ALICE));

    expect(data.version).toBe(3);
    const byId = Object.fromEntries(data.projects.map((p: any) => [p.id, p]));
    expect(Object.keys(byId).sort()).toEqual(["old-app", "site"]);
    expect(byId.site).toMatchObject({ name: "Site relaunch", description: "The marketing site", aliases: ["hosting", "web"], status: "active" });
    expect(byId["old-app"].status).toBe("archived");
    expect(typeof byId.site.created_at).toBe("number");
    expect(byId.site.workspace_id).toBe(source.aliceWs);
  });

  it("exports only the projects the caller can read", async () => {
    await createProject(source.env.DB, source.companyWs, { id: "shared", name: "Shared" }, source.sqlite.admitEnv(source.env));
    await createProject(source.env.DB, source.bobWs, { id: "bobs", name: "Bob's own" }, source.sqlite.admitEnv(source.env));

    const alice = (await jsonOf(await call(source, "GET", "/export", ALICE))).projects.map((p: any) => p.id).sort();
    const bob = (await jsonOf(await call(source, "GET", "/export", source.bobToken))).projects.map((p: any) => p.id).sort();

    expect(alice).toEqual(["old-app", "shared", "site"]);
    expect(bob).toEqual(["bobs", "shared"]);
  });
});

describe("Projectsの分割exportと完全exportの上限", () => {
  it("3つのcursorで最後のProjectsまで重複なく読み出す", async () => {
    let cursor = { next_offset: 0, next_edge_offset: 0, next_project_offset: 0 };
    const projects: any[] = [];
    let complete = false;
    for (let i = 0; i < 4 && !complete; i++) {
      const res = await call(source, "GET", `/export?limit=1&offset=${cursor.next_offset}&edge_offset=${cursor.next_edge_offset}&project_offset=${cursor.next_project_offset}`, ALICE);
      expect(res.status).toBe(200);
      const page = await jsonOf(res);
      expect(page.entries.length + page.edges.length + page.projects.length).toBeLessThanOrEqual(1);
      projects.push(...page.projects);
      cursor = page.pagination;
      complete = page.pagination.complete;
    }
    expect(complete).toBe(true);
    expect(projects.map(p => p.id).sort()).toEqual(["old-app", "site"]);
    const cursorOnly = await jsonOf(await call(source, "GET", "/export?project_offset=1", ALICE));
    expect(cursorOnly.pagination.next_project_offset).toBe(1);
  });

  it("Projects設定のbyte数も完全exportの上限へ含める", async () => {
    for (let i = 0; i < 90; i++) await createProject(source.env.DB, source.aliceWs,
      { id: `large-${i}`, name: "大きい設定", description: "あ".repeat(1000) }, source.sqlite.admitEnv(source.env));
    expect((await call(source, "GET", "/export", ALICE)).status).toBe(413);
    const paged = await call(source, "GET", "/export?paged=1&limit=1", ALICE);
    expect(paged.status).toBe(200);
  });
});

describe("round trip through POST /import", () => {
  it("restores name, description, aliases, archived status and created_at into a fresh brain", async () => {
    const exported = await jsonOf(await call(source, "GET", "/export", ALICE));

    const res = await importAll(target, ALICE, exported);
    const summary = await jsonOf(res);

    expect(res.status).toBe(200);
    expect(summary).toMatchObject({ imported: 1, projects_imported: 2, projects_skipped: 0, projects_failed: 0, remaining_projects: 0, next_project_offset: 2 });
    const restored = await projectsOf(target);
    const byId = Object.fromEntries(restored.map((p: any) => [p.id, p]));
    expect(byId.site).toMatchObject({ name: "Site relaunch", description: "The marketing site", aliases: ["hosting", "web"], status: "active", layer: "personal" });
    expect(byId["old-app"]).toMatchObject({ name: "Old app", status: "archived" });
    const original = exported.projects.find((p: any) => p.id === "site");
    expect(byId.site.created_at).toBe(original.created_at);
  });

  it("lands in the importer's own workspace, like entries", async () => {
    const exported = await jsonOf(await call(source, "GET", "/export", ALICE));

    await importAll(target, target.bobToken, exported);

    const rows = (await target.sqlite.db.prepare(`SELECT id, workspace_id FROM projects ORDER BY id`).all()).results as { id: string; workspace_id: string }[];
    expect(rows).toEqual([{ id: "old-app", workspace_id: target.bobWs }, { id: "site", workspace_id: target.bobWs }]);
  });

  it("is idempotent and keeps an existing project rather than overwriting it", async () => {
    const exported = await jsonOf(await call(source, "GET", "/export", ALICE));
    await importAll(target, ALICE, exported);
    await updateProject(target.env.DB, target.aliceWs, "site", { name: "Renamed here", aliases: ["mine"] }, target.sqlite.admitEnv(target.env));

    const again = await jsonOf(await importAll(target, ALICE, exported));

    expect(again).toMatchObject({ projects_imported: 0, projects_skipped: 2, projects_failed: 0 });
    const site = (await projectsOf(target)).find((p: any) => p.id === "site");
    expect(site).toMatchObject({ name: "Renamed here", aliases: ["mine"] });
  });

  it("restores the entries tagged with a project alongside it", async () => {
    const exported = await jsonOf(await call(source, "GET", "/export", ALICE));
    await importAll(target, ALICE, exported);

    const listed = await jsonOf(await call(target, "POST", "/list", ALICE, { project: "site" }));

    expect(listed.map((e: any) => e.id)).toEqual(["e1"]);
  });
});

describe("POST /import of files without projects", () => {
  it("version 1の記憶をProjectsなしで復元する", async () => {
    const res = await call(target, "POST", "/import", ALICE, { version: 1, entries: [{ id: "v1", content: "以前の記憶" }] });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ imported: 1, remaining_projects: 0 });
  });

  it("accepts a version 2 file taken before projects existed", async () => {
    const res = await call(target, "POST", "/import", ALICE, {
      version: 2,
      entries: [{ id: "old-1", content: "from an old export", created_at: 5 }],
      edges: [],
    });

    const summary = await jsonOf(res);
    expect(res.status).toBe(200);
    expect(summary).toMatchObject({ imported: 1, projects_imported: 0, projects_skipped: 0, projects_failed: 0, remaining_projects: 0, next_project_offset: 0 });
    expect(await projectsOf(target)).toEqual([]);
  });

  it("accepts a file with no version marker at all", async () => {
    const res = await call(target, "POST", "/import", ALICE, { entries: [] });
    expect(res.status).toBe(200);
  });

  it("still rejects an unknown version and a non-array projects field", async () => {
    const future = await call(target, "POST", "/import", ALICE, { version: 4, entries: [] });
    expect(future.status).toBe(400);
    expect((await jsonOf(future)).error).toMatch(/version must be 1, 2 or 3/);
    const bad = await call(target, "POST", "/import", ALICE, { version: 3, entries: [], projects: {} });
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad)).error).toMatch(/projects must be an array/);
  });
});

describe("POST /import project paging", () => {
  const three = [
    { id: "p1", name: "One" },
    { id: "p2", name: "Two" },
    { id: "p3", name: "Three", aliases: ["x"] },
  ];

  it("pages projects on project_offset once entries are done", async () => {
    const payload = { version: 3, entries: [], edges: [], projects: three };

    const first = await jsonOf(await call(target, "POST", "/import?limit=2", ALICE, payload));
    expect(first).toMatchObject({ projects_imported: 2, remaining_projects: 1, next_project_offset: 2 });

    const second = await jsonOf(await call(target, "POST", "/import?limit=2&project_offset=2", ALICE, payload));
    expect(second).toMatchObject({ projects_imported: 1, remaining_projects: 0, next_project_offset: 3 });
    expect((await projectsOf(target)).map((p: any) => p.id).sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("holds projects back until every entry page has been read", async () => {
    const entries = Array.from({ length: 3 }, (_, i) => ({ id: `n${i}`, content: `note ${i}` }));
    const payload = { version: 3, entries, edges: [], projects: three };

    const first = await jsonOf(await call(target, "POST", "/import?limit=2", ALICE, payload));

    expect(first).toMatchObject({ remaining_entries: 1, projects_imported: 0, remaining_projects: 3 });
    expect(await projectsOf(target)).toEqual([]);
  });

  it("reports an invalid project without stopping the rest", async () => {
    const payload = {
      version: 3,
      entries: [],
      projects: [
        { id: "Bad Slug", name: "Nope" },
        { id: "ok", name: "Fine" },
        { id: "too-many", name: "Aliases", aliases: Array.from({ length: 17 }, (_, i) => `a${i}`) },
        { id: "ok", name: "Duplicate in the same file" },
        "not an object",
      ],
    };

    const summary = await jsonOf(await call(target, "POST", "/import", ALICE, payload));

    expect(summary).toMatchObject({ projects_imported: 1, projects_skipped: 1, projects_failed: 3 });
    expect(summary.results.filter((r: any) => r.status === "failed").every((r: any) => r.reason === "invalid_project")).toBe(true);
    expect((await projectsOf(target)).map((p: any) => p.id)).toEqual(["ok"]);
  });
});
