/**
 * Registry-driven project digests inside the nightly compression run.
 *
 * Active projects of the night's workspace join the digest candidates, keyed
 * `project:<slug>`, alongside the frequency-driven topic tags. The eligibility
 * threshold (10, from digest.ts) and the per-run bound are the ones topic tags
 * already use; these run against real SQLite so eligibility, tagging and the
 * rotation cursor are the shipped ones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runNightlyCompression, COMPRESSION_MAX_TAGS_PER_RUN } from "../../src/compression/nightly";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { createProject, updateProject } from "../../src/projects/registry";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

const WS = "ws-a";
const OTHER_WS = "ws-b";
const OLD = Date.now() - 200 * 24 * 3600 * 1000;

function digestAI() {
  const sse = (text: string) => new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return {
    run: vi.fn().mockImplementation(async (model: string, opts: any) => {
      if (model.includes("embeddinggemma")) return { data: [new Array(768).fill(0.1)] };
      if (opts?.stream) return sse("A digest of the memories.");
      return { response: "3" };
    }),
  } as unknown as Ai;
}

describe("nightly per-project digests", () => {
  let sqlite: SqliteD1;
  let env: Env;
  let db: D1Database;
  let n = 0;

  const seed = (workspaceId: string, tags: string[], count: number) => {
    for (let i = 0; i < count; i++, n++) {
      sqlite.db
        .prepare(`INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'api', ?, ?, '[]', ?, '')`)
        .bind(`e-${n}`, `Memory ${n} for ${tags.join(",")}`, JSON.stringify(tags), OLD + n, OLD + n, workspaceId)
        .run();
    }
  };

  async function run(workspaceId?: string | null) {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
    const result = await runNightlyCompression(sqlite.admitEnv(env), ctx, workspaceId);
    await Promise.allSettled(pending);
    return result;
  }

  /** Digest entries (synthesized) with their non-marker tags and workspace. */
  async function digests() {
    const { results } = await sqlite.db.prepare(`SELECT tags, workspace_id FROM entries WHERE tags LIKE '%"synthesized"%'`).all();
    return (results as { tags: string; workspace_id: string }[]).map(r => ({
      tags: (JSON.parse(r.tags) as string[]).filter(t => t !== "synthesized").sort(),
      workspace_id: r.workspace_id,
    }));
  }
  const rolledUp = async () =>
    ((await sqlite.db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE tags LIKE '%"rolled-up"%'`).first()) as { c: number }).c;

  beforeEach(async () => {
    resetDatabaseInit();
    n = 0;
    sqlite = makeSqliteD1();
    env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], AI: digestAI(), OAUTH_KV: makeMemoryKV() });
    db = env.DB;
    await initializeDatabase(env);
  });
  afterEach(() => sqlite.close());

  it("digests a project with 25 eligible entries into a synthesized, project-tagged entry", async () => {
    await createProject(db, WS, { id: "site", name: "Site" }, sqlite.admitEnv(env));
    seed(WS, ["project:site"], 25);

    const { digestsWritten } = await run(WS);

    expect(digestsWritten).toBe(1);
    expect(await digests()).toEqual([{ tags: ["project:site"], workspace_id: WS }]);
    expect(await rolledUp()).toBe(25);
  });

  it("汎用タグを共有しても登録Projectの外の記憶を要約へ混ぜない", async () => {
    await createProject(db, WS, { id: "site", name: "Site" }, sqlite.admitEnv(env));
    seed(WS, ["project:site", "work"], 12);
    seed(WS, ["work"], 12);

    const { digestsWritten } = await run(WS);

    expect(digestsWritten).toBe(1);
    expect(await digests()).toEqual([{ tags: ["project:site"], workspace_id: WS }]);
    expect(await rolledUp()).toBe(12);
    const row = await sqlite.db.prepare(
      `SELECT COUNT(*) AS c FROM entries WHERE tags = '["work"]' AND workspace_id = ?`
    ).bind(WS).first() as { c: number };
    expect(row.c).toBe(12);
  });

  it("labels the digest with the project's name, not its raw key or 'tagged'", async () => {
    await createProject(db, WS, { id: "signpath", name: "SignPath", aliases: ["hosting"] }, sqlite.admitEnv(env));
    seed(WS, ["project:signpath"], 6);
    seed(WS, ["hosting"], 6);

    await run(WS);

    const stored = await sqlite.db.prepare(`SELECT content FROM entries WHERE tags LIKE '%"synthesized"%'`).first() as { content: string };
    expect(stored.content.startsWith('[Synthesized from 12 entries in project "SignPath"]')).toBe(true);
    expect(stored.content).not.toContain("tagged");
    const prompt = (env.AI.run as any).mock.calls.map((c: any[]) => c[1]?.messages?.[0]?.content).find((c: unknown) => typeof c === "string" && c.includes("Memories:"));
    // The seeded memories quote the raw key, so only the instruction part is checked.
    const instruction = (prompt as string).split("Memories:")[0] + (prompt as string).split("State of")[1];
    expect(instruction).toContain('project "SignPath"');
    expect(instruction).not.toContain("project:signpath");
  });

  it("uses the existing 10-entry threshold: 9 is skipped, 10 is digested", async () => {
    await createProject(db, WS, { id: "thin", name: "Thin" }, sqlite.admitEnv(env));
    await createProject(db, WS, { id: "enough", name: "Enough" }, sqlite.admitEnv(env));
    seed(WS, ["project:thin"], 9);
    seed(WS, ["project:enough"], 10);

    expect((await run(WS)).digestsWritten).toBe(1);
    expect(await digests()).toEqual([{ tags: ["project:enough"], workspace_id: WS }]);
  });

  it("counts entries carrying an alias as members", async () => {
    // 10 stays under the frequency-driven topic threshold (more than 10), so only the
    // project digest can claim these.
    await createProject(db, WS, { id: "site", name: "Site", aliases: ["hosting"] }, sqlite.admitEnv(env));
    seed(WS, ["hosting"], 10);

    expect((await run(WS)).digestsWritten).toBe(1);
    expect(await digests()).toEqual([{ tags: ["project:site"], workspace_id: WS }]);
  });

  it("skips archived projects", async () => {
    await createProject(db, WS, { id: "old", name: "Old" }, sqlite.admitEnv(env));
    await updateProject(db, WS, "old", { status: "archived" }, sqlite.admitEnv(env));
    seed(WS, ["project:old"], 25);

    expect((await run(WS)).digestsWritten).toBe(0);
    expect(await digests()).toEqual([]);
    expect(await rolledUp()).toBe(0);
  });

  it("keeps the frequency-driven topic digests alongside the project ones", async () => {
    await createProject(db, WS, { id: "site", name: "Site" }, sqlite.admitEnv(env));
    seed(WS, ["project:site"], 12);
    seed(WS, ["gardening"], 15);

    expect((await run(WS)).digestsWritten).toBe(2);
    expect((await digests()).map(d => d.tags.join()).sort()).toEqual(["gardening", "project:site"]);
  });

  it("never treats a project: tag as a topic, so an unregistered one is not digested", async () => {
    seed(WS, ["project:ghost"], 25);

    expect((await run(WS)).digestsWritten).toBe(0);
    expect(await digests()).toEqual([]);
  });

  it("only digests the night's workspace and never pools another workspace's members", async () => {
    await createProject(db, WS, { id: "site", name: "Site" }, sqlite.admitEnv(env));
    await createProject(db, OTHER_WS, { id: "site", name: "Site B" }, sqlite.admitEnv(env));
    seed(WS, ["project:site"], 11);
    seed(OTHER_WS, ["project:site"], 11);

    await run(WS);

    expect(await digests()).toEqual([{ tags: ["project:site"], workspace_id: WS }]);
    const rolled = (await sqlite.db.prepare(`SELECT workspace_id FROM entries WHERE tags LIKE '%"rolled-up"%'`).all()).results as { workspace_id: string }[];
    expect(rolled.every(r => r.workspace_id === WS)).toBe(true);
    expect(rolled).toHaveLength(11);
  });

  describe("the same slug with different aliases in two workspaces", () => {
    const rolledIds = async () =>
      ((await sqlite.db.prepare(`SELECT id FROM entries WHERE tags LIKE '%"rolled-up"%'`).all()).results as { id: string }[]).map(r => r.id);
    const seedTwoWorkspaces = async () => {
      await createProject(db, WS, { id: "roadmap", name: "Roadmap", aliases: ["q3"] }, sqlite.admitEnv(env));
      await createProject(db, OTHER_WS, { id: "roadmap", name: "Roadmap", aliases: ["pricing"] }, sqlite.admitEnv(env));
      seed(WS, ["project:roadmap"], 12);
      seed(OTHER_WS, ["project:roadmap"], 12);
      // Only 10 each, so the topic pass (more than 10) cannot claim them either.
      seed(WS, ["pricing"], 10);
      seed(OTHER_WS, ["q3"], 10);
    };
    const wsOf = async (ids: string[]) =>
      (await sqlite.db.prepare(`SELECT id, tags, workspace_id FROM entries WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all()).results as { tags: string; workspace_id: string }[];

    it("the null-slice pass never rolls up entries matched only by the other workspace's alias", async () => {
      await seedTwoWorkspaces();

      // One project key, digested in each workspace holding a row.
      expect((await run(undefined)).digestsWritten).toBe(1);

      const rolled = await wsOf(await rolledIds());
      expect(rolled).toHaveLength(24);
      expect(rolled.filter(r => JSON.parse(r.tags).includes("pricing"))).toEqual([]);
      expect(rolled.filter(r => JSON.parse(r.tags).includes("q3"))).toEqual([]);
    });

    it("the sliced pass only touches its own workspace's aliases", async () => {
      await seedTwoWorkspaces();

      await run(WS);

      const rolled = await wsOf(await rolledIds());
      expect(rolled).toHaveLength(12);
      expect(rolled.every(r => r.workspace_id === WS && JSON.parse(r.tags).includes("project:roadmap"))).toBe(true);
    });

    it("does roll up a workspace's own alias entries", async () => {
      await createProject(db, WS, { id: "roadmap", name: "Roadmap", aliases: ["q3"] }, sqlite.admitEnv(env));
      await createProject(db, OTHER_WS, { id: "roadmap", name: "Roadmap", aliases: ["pricing"] }, sqlite.admitEnv(env));
      seed(WS, ["project:roadmap"], 4);
      seed(WS, ["q3"], 8);
      seed(OTHER_WS, ["pricing"], 10);

      expect((await run(undefined)).digestsWritten).toBe(1);
      expect(await rolledIds()).toHaveLength(22);
    });
  });

  it("skips a project whose filter exceeds the pattern cap and logs it", async () => {
    const aliases = Array.from({ length: 45 }, (_, i) => `tag-${i}`);
    sqlite.db
      .prepare(`INSERT INTO projects (id, workspace_id, name, description, aliases, status, created_at) VALUES ('big', ?, 'Big', '', ?, 'active', 1)`)
      .bind(WS, JSON.stringify(aliases))
      .run();
    await createProject(db, WS, { id: "small", name: "Small" }, sqlite.admitEnv(env));
    seed(WS, ["project:big"], 12);
    seed(WS, ["project:small"], 12);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect((await run(WS)).digestsWritten).toBe(1);

    expect(await digests()).toEqual([{ tags: ["project:small"], workspace_id: WS }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("project:big"));
    warn.mockRestore();
  });

  it("does not digest entries of a workspace that has no registry row for the slug", async () => {
    await createProject(db, WS, { id: "site", name: "Site" }, sqlite.admitEnv(env));
    seed(OTHER_WS, ["project:site"], 25);

    expect((await run(WS)).digestsWritten).toBe(0);
  });

  it("with no workspace slice (pre-v3 fallback) digests every active project inside its own workspace", async () => {
    await createProject(db, WS, { id: "site", name: "Site" }, sqlite.admitEnv(env));
    await createProject(db, OTHER_WS, { id: "app", name: "App" }, sqlite.admitEnv(env));
    seed(WS, ["project:site"], 12);
    seed(OTHER_WS, ["project:app"], 12);

    expect((await run(undefined)).digestsWritten).toBe(2);
    expect((await digests()).sort((a, b) => a.workspace_id.localeCompare(b.workspace_id))).toEqual([
      { tags: ["project:site"], workspace_id: WS },
      { tags: ["project:app"], workspace_id: OTHER_WS },
    ]);
  });

  it(`stays inside the ${COMPRESSION_MAX_TAGS_PER_RUN}-per-run bound and the rotation reaches every project`, async () => {
    const slugs = ["p1", "p2", "p3", "p4", "p5", "p6"];
    for (const slug of slugs) {
      await createProject(db, WS, { id: slug, name: slug }, sqlite.admitEnv(env));
      seed(WS, [`project:${slug}`], 12);
    }

    const first = await run(WS);
    expect(first.digestsWritten).toBe(COMPRESSION_MAX_TAGS_PER_RUN);
    expect(await digests()).toHaveLength(COMPRESSION_MAX_TAGS_PER_RUN);

    for (let i = COMPRESSION_MAX_TAGS_PER_RUN; i < slugs.length; i += COMPRESSION_MAX_TAGS_PER_RUN) await run(WS);
    expect((await digests()).map(d => d.tags[0]).sort()).toEqual(slugs.map(s => `project:${s}`));
  });

  it("names project members in the shared rotation cursor", async () => {
    for (const slug of ["p1", "p2", "p3", "p4", "p5"]) {
      await createProject(db, WS, { id: slug, name: slug }, sqlite.admitEnv(env));
      seed(WS, [`project:${slug}`], 12);
    }

    await run(WS);

    expect(await env.OAUTH_KV.get("compression:tag-cursor")).toBe(`project:p${COMPRESSION_MAX_TAGS_PER_RUN}`);
  });

  it("a project with too few entries does not stop topic digests", async () => {
    await createProject(db, WS, { id: "thin", name: "Thin" }, sqlite.admitEnv(env));
    seed(WS, ["project:thin"], 3);
    seed(WS, ["gardening"], 15);

    expect((await run(WS)).digestsWritten).toBe(1);
    expect(await digests()).toEqual([{ tags: ["gardening"], workspace_id: WS }]);
  });

  it("reads the registry in the same batch as the candidate query, at no extra subrequest", async () => {
    await createProject(db, WS, { id: "site", name: "Site" }, sqlite.admitEnv(env));
    seed(WS, ["gardening"], 15);
    sqlite.batches.length = 0;
    sqlite.issued.length = 0;

    await run(WS);

    const first = sqlite.batches[0];
    // The third statement is the held-draft digest read (T-0089.4.4): it rides in this batch too.
    expect(first).toHaveLength(3);
    expect(first[0]).toMatch(/json_each\(entries\.tags\)/);
    expect(first[1]).toMatch(/FROM projects WHERE workspace_id IN \(\?\) AND status = 'active'/);
    expect(first[2]).toMatch(/idx_entries_conflict_held/);
    // Nothing else read the registry: one candidate read, whatever the number of projects.
    expect(sqlite.issued.filter(s => /FROM projects/.test(s))).toHaveLength(1);
  });

  it("falls back to topic digests alone when the registry read cannot be batched", async () => {
    seed(WS, ["gardening"], 15);
    const batch = env.DB.batch.bind(env.DB);
    let failed = false;
    (env.DB as { batch: unknown }).batch = async (statements: unknown[]) => {
      if (!failed) { failed = true; throw new Error("no such table: projects"); }
      return batch(statements as never);
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const { digestsWritten } = await run(WS);

    expect(digestsWritten).toBe(1);
    expect(await digests()).toEqual([{ tags: ["gardening"], workspace_id: WS }]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("Nightly candidate batch failed"), expect.any(Error));
    errors.mockRestore();
  });
});
