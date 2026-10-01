/**
 * The MCP projects surface: list_projects, the `project` param on remember, recall and
 * list_recent, project-tag validation on remember and update, and the tool descriptions
 * that teach an agent to use them. Real SQLite, real registry, MCP over InMemoryTransport.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../../src/mcp/server";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { createProject, updateProject } from "../../src/projects/registry";
import type { Env } from "../../src/env";

let pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;

let sqlite: SqliteD1;
let env: Env;
let dana: { userId: string; personalWorkspaceId: string; token: string };
let identity: Identity;
let companyWs = "";

const textOf = (res: any) => String(res.content[0].text);

async function withClient<T>(id: Identity | undefined, run: (c: Client) => Promise<T>): Promise<T> {
  const server = buildMcpServer(sqlite.admitEnv(env), ctx, id);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try { return await run(client); } finally { await client.close(); }
}

const call = (name: string, args: Record<string, unknown>) =>
  withClient(identity, async c => textOf(await c.callTool({ name, arguments: args })));

async function settle() {
  while (pending.length) {
    const batch = pending;
    pending = [];
    await Promise.all(batch);
  }
}

const registry = async () =>
  (await sqlite.db.prepare(`SELECT id, workspace_id, name, status FROM projects ORDER BY workspace_id, id`).all()).results as
    { id: string; workspace_id: string; name: string; status: string }[];

const entryTags = async (id: string): Promise<string[]> =>
  JSON.parse(((await sqlite.db.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(id).first()) as { tags: string }).tags);

const idOf = (text: string) => /ID: (\S+?)\.?(?:\s|$)/.exec(text)![1];

function seed(id: string, workspaceId: string, tags: string[], content = `site note ${id}`) {
  sqlite.db
    .prepare(`INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'test', 1000, 1000, ?, ?, ?)`)
    .bind(id, content, JSON.stringify(tags), JSON.stringify([`v-${id}`]), workspaceId, dana.userId)
    .run();
}

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
  companyWs = roots.companyWorkspaceId;
  const created = await createMember(env, { name: "Dana" });
  dana = { userId: created.member.userId, personalWorkspaceId: created.member.personalWorkspaceId, token: created.token };
  identity = (await resolveIdentityFromToken(dana.token, env))!;
  await settle();
});

afterEach(() => sqlite?.close());

describe("list_projects", () => {
  it("lists slug, name, layer and the first description line", async () => {
    await createProject(env.DB, dana.personalWorkspaceId, { id: "website", name: "Website", description: "Marketing site rebuild\nsecond line stays out" }, sqlite.admitEnv(env));
    await createProject(env.DB, companyWs, { id: "platform", name: "Platform" }, sqlite.admitEnv(env));

    const text = await call("list_projects", {});

    expect(text).toContain("website — Website (personal) — Marketing site rebuild");
    expect(text).not.toContain("second line");
    expect(text).toContain("platform — Platform (company)");
  });

  it("hides archived projects unless asked, and marks them when shown", async () => {
    await createProject(env.DB, dana.personalWorkspaceId, { id: "live", name: "Live" }, sqlite.admitEnv(env));
    await createProject(env.DB, dana.personalWorkspaceId, { id: "old", name: "Old" }, sqlite.admitEnv(env));
    await updateProject(env.DB, dana.personalWorkspaceId, "old", { status: "archived" }, sqlite.admitEnv(env));

    expect(await call("list_projects", {})).not.toContain("old — Old");
    const all = await call("list_projects", { include_archived: true });
    expect(all).toContain("live — Live (personal)");
    expect(all).toMatch(/old — Old \(personal\).*\[archived\]/);
  });

  it("narrows by workspace layer", async () => {
    await createProject(env.DB, dana.personalWorkspaceId, { id: "mine", name: "Mine" }, sqlite.admitEnv(env));
    await createProject(env.DB, companyWs, { id: "ours", name: "Ours" }, sqlite.admitEnv(env));

    const personal = await call("list_projects", { workspace: "personal" });
    expect(personal).toContain("mine");
    expect(personal).not.toContain("ours");
    const company = await call("list_projects", { workspace: "company" });
    expect(company).toContain("ours");
    expect(company).not.toContain("mine");
  });

  it("never shows another member's private projects", async () => {
    const bob = await createMember(env, { name: "Bob" });
    await createProject(env.DB, bob.member.personalWorkspaceId, { id: "bobs-secret", name: "Bobs secret" }, sqlite.admitEnv(env));

    expect(await call("list_projects", {})).not.toContain("bobs-secret");
  });

  it("says so when there are none, and points at how one gets created", async () => {
    const text = await call("list_projects", {});
    expect(text).toContain("No projects");
    expect(text).toContain("remember");
  });

  it("rejects a team the caller is not on", async () => {
    const text = await call("list_projects", { workspace: "company", team: "ws-not-mine" });
    expect(text).toContain("team must be one of your teams");
  });

  it("needs an authenticated identity", async () => {
    const text = await withClient(undefined, async c => textOf(await c.callTool({ name: "list_projects", arguments: {} })));
    expect(text).toContain("authenticated identity");
  });
});

describe("remember with project", () => {
  it("auto-creates an unknown slug in the entry's workspace and tags the entry", async () => {
    const text = await call("remember", { content: "Decided to move hosting to Fly", tags: ["infra"], project: "website" });
    await settle();

    expect(text).toContain("Stored");
    expect(await registry()).toEqual([{ id: "website", workspace_id: dana.personalWorkspaceId, name: "website", status: "active" }]);
    const tags = await entryTags(idOf(text));
    expect(tags).toContain("project:website");
    expect(tags).toContain("infra");
  });

  it("creates the project in the shared workspace when the memory goes there", async () => {
    await call("remember", { content: "Team roadmap for the platform", project: "platform", workspace: "company" });
    await settle();

    expect((await registry()).map(r => [r.id, r.workspace_id])).toEqual([["platform", companyWs]]);
  });

  it("leaves an existing project alone and does not audit a second creation", async () => {
    await createProject(env.DB, dana.personalWorkspaceId, { id: "website", name: "Website", description: "keep me" }, sqlite.admitEnv(env));

    await call("remember", { content: "Another fact about the website", project: "website" });
    await settle();

    expect(await registry()).toEqual([{ id: "website", workspace_id: dana.personalWorkspaceId, name: "Website", status: "active" }]);
    const { results } = await sqlite.db.prepare(`SELECT event FROM admin_events WHERE event = 'project_autocreated'`).all();
    expect(results).toHaveLength(0);
  });

  it("audits the silent auto-create", async () => {
    await call("remember", { content: "Fresh project fact", project: "fresh" });
    await settle();

    const row = await sqlite.db.prepare(`SELECT actor_id, workspace_id, payload FROM admin_events WHERE event = 'project_autocreated'`).first() as any;
    expect(row.actor_id).toBe(dana.userId);
    expect(row.workspace_id).toBe(dana.personalWorkspaceId);
    expect(JSON.parse(row.payload)).toEqual({ slug: "fresh" });
  });

  it("caps the caller's tags only: 自動付与を含め16タグまで、HTTPと同じ上限で保存する", async () => {
    const sixtyFour = Array.from({ length: 14 }, (_, i) => `t${i}`);

    const text = await call("remember", { content: "full tag list, worker adds two more", tags: sixtyFour, project: "website", volatility: "durable" });
    await settle();

    expect(text).toContain("Stored");
    const tags = await entryTags(idOf(text));
    expect(tags).toHaveLength(16);
    expect(tags).toEqual(expect.arrayContaining(["project:website", "volatility:durable", "t0", "t13"]));
  });

  it("自動付与後の17タグを拒否し、書込みを残さない", async () => {
    const sixtyFive = Array.from({ length: 15 }, (_, i) => `t${i}`);

    const res = await withClient(identity, c => c.callTool({ name: "remember", arguments: { content: "one tag too many", tags: sixtyFive, project: "website", volatility: "durable" } }));

    expect((res as any).isError).toBe(true);
    expect(textOf(res)).toMatch(/16/);
    expect((await sqlite.db.prepare(`SELECT id FROM entries`).all()).results).toHaveLength(0);
    expect(await registry()).toEqual([]);
  });

  it("fails a bad slug with the grammar error and writes nothing", async () => {
    const text = await call("remember", { content: "Should not be stored", project: "Bad Slug!" });

    expect(text).toContain('invalid project tag "Bad Slug!": must match [a-z0-9][a-z0-9_-]{0,63}');
    expect((await sqlite.db.prepare(`SELECT id FROM entries`).all()).results).toHaveLength(0);
    expect(await registry()).toEqual([]);
  });

  it("rejects a literal project: tag that breaks the grammar, same message as HTTP", async () => {
    const text = await call("remember", { content: "Should not be stored", tags: ["project:Bad Slug!"] });

    expect(text).toContain('invalid project tag "Bad Slug!": must match [a-z0-9][a-z0-9_-]{0,63}');
    expect((await sqlite.db.prepare(`SELECT id FROM entries`).all()).results).toHaveLength(0);
  });

  it("does not auto-create from a valid literal project: tag (only the param does)", async () => {
    const text = await call("remember", { content: "Literal tag only", tags: ["project:direct"] });
    await settle();

    expect(text).toContain("Stored");
    expect(await registry()).toEqual([]);
  });
});

describe("update project-tag validation", () => {
  it("rejects a bad project: tag and leaves the entry untouched", async () => {
    seed("e1", dana.personalWorkspaceId, ["keep"], "original body");

    const text = await call("update", { id: "e1", content: "new body", tags: ["project:Bad Slug!"] });

    expect(text).toContain('invalid project tag "Bad Slug!": must match [a-z0-9][a-z0-9_-]{0,63}');
    const row = await sqlite.db.prepare(`SELECT content FROM entries WHERE id = 'e1'`).first() as { content: string };
    expect(row.content).toBe("original body");
    expect(await entryTags("e1")).toEqual(["keep"]);
  });

  it("accepts a valid project: tag through replacement", async () => {
    seed("e2", dana.personalWorkspaceId, ["keep"], "original body");

    const text = await call("update", { id: "e2", content: "new body", tags: ["keep", "project:my-app"] });

    expect(text).toContain("Updated entry e2");
    expect(await entryTags("e2")).toContain("project:my-app");
  });
});

describe("recall and list_recent with project", () => {
  it("recall with an unknown slug is an error naming the slug, never an empty result", async () => {
    await createProject(env.DB, dana.personalWorkspaceId, { id: "website", name: "Website" }, sqlite.admitEnv(env));

    const text = await call("recall", { query: "hosting", project: "webiste" });

    expect(text).toContain('unknown project "webiste"');
    expect(text).toContain("website");
    expect(text).not.toContain("Nothing found");
  });

  it("caps the known slugs it suggests at 10", async () => {
    for (let i = 1; i <= 12; i++) await createProject(env.DB, dana.personalWorkspaceId, { id: `proj-${String(i).padStart(2, "0")}`, name: `Proj ${i}` }, sqlite.admitEnv(env));

    for (const tool of ["recall", "list_recent"] as const) {
      const args = tool === "recall" ? { query: "x", project: "nope" } : { project: "nope" };
      const text = await call(tool, args);
      expect(text).toContain('unknown project "nope"');
      expect(text.match(/proj-\d\d/g)).toHaveLength(10);
    }
  });

  it("an unknown slug with no projects at all says so plainly", async () => {
    const text = await call("list_recent", { project: "nope" });

    expect(text).toContain('unknown project "nope"');
    expect(text).not.toContain("No entries found");
  });

  it("rejects a malformed slug with the grammar error", async () => {
    for (const tool of ["recall", "list_recent"] as const) {
      const args = tool === "recall" ? { query: "x", project: "Bad Slug!" } : { project: "Bad Slug!" };
      expect(await call(tool, args)).toContain('invalid project tag "Bad Slug!"');
    }
  });

  it("list_recent returns tagged members and alias-claimed legacy entries only", async () => {
    await createProject(env.DB, dana.personalWorkspaceId, { id: "website", name: "Website", aliases: ["legacy-site"] }, sqlite.admitEnv(env));
    seed("tagged", dana.personalWorkspaceId, ["project:website"], "tagged member");
    seed("aliased", dana.personalWorkspaceId, ["legacy-site"], "alias member");
    seed("other", dana.personalWorkspaceId, ["infra"], "not a member");

    const text = await call("list_recent", { project: "website" });

    expect(text).toContain("ID: tagged");
    expect(text).toContain("ID: aliased");
    expect(text).not.toContain("ID: other");
  });

  it("recall restricts results to the project", async () => {
    await createProject(env.DB, dana.personalWorkspaceId, { id: "website", name: "Website", aliases: ["legacy-site"] }, sqlite.admitEnv(env));
    seed("tagged", dana.personalWorkspaceId, ["project:website"], "hosting decision tagged");
    seed("aliased", dana.personalWorkspaceId, ["legacy-site"], "hosting decision aliased");
    seed("other", dana.personalWorkspaceId, ["infra"], "hosting decision elsewhere");

    const text = await call("recall", { query: "hosting decision", project: "website" });

    expect(text).toContain("ID: tagged");
    expect(text).toContain("ID: aliased");
    expect(text).not.toContain("ID: other");
  });

  it("does not see a project that lives only in a workspace the caller cannot read", async () => {
    const bob = await createMember(env, { name: "Bob" });
    await createProject(env.DB, bob.member.personalWorkspaceId, { id: "bobs-secret", name: "Bobs secret" }, sqlite.admitEnv(env));

    const text = await call("list_recent", { project: "bobs-secret" });

    expect(text).toContain('unknown project "bobs-secret"');
    expect(text).not.toMatch(/known projects:.*bobs-secret/i);
  });
});

describe("tool descriptions", () => {
  const FOUR_AXES = [
    "workspace = who can see it",
    "project = what it's about",
    "tags = free-form facets",
    "source = where it came from",
  ];

  async function descriptions(): Promise<Record<string, string>> {
    return withClient(identity, async c => {
      const { tools } = await c.listTools();
      return Object.fromEntries(tools.map(t => [t.name, t.description ?? ""]));
    });
  }

  it("remember, recall and list_projects teach the four axes and list_projects discovery", async () => {
    const d = await descriptions();
    for (const name of ["remember", "recall", "list_projects"]) {
      for (const axis of FOUR_AXES) expect(d[name], `${name}: ${axis}`).toContain(axis);
      expect(d[name], name).toContain("list_projects");
    }
  });

  it("remember tells the agent to pass project, prefer it over a topic tag, and that unknown slugs are created", async () => {
    const d = (await descriptions()).remember;
    expect(d).toContain("pass project on remember");
    expect(d).toContain("prefer project over a bare topic tag");
    expect(d).toMatch(/created automatically/i);
  });

  it("recall says an unknown project is an error, not an empty result", async () => {
    expect((await descriptions()).recall).toMatch(/unknown project/i);
  });

  it("the project param is documented on remember, recall and list_recent", async () => {
    await withClient(identity, async c => {
      const { tools } = await c.listTools();
      for (const name of ["remember", "recall", "list_recent"]) {
        const props = (tools.find(t => t.name === name)!.inputSchema as any).properties;
        expect(props.project, name).toBeDefined();
        expect(props.project.description, name).toMatch(/list_projects/);
      }
      const listProps = (tools.find(t => t.name === "list_projects")!.inputSchema as any).properties;
      expect(Object.keys(listProps).sort()).toEqual(["include_archived", "team", "workspace"]);
    });
  });
});
