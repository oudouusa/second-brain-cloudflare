import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  PROJECT_SLUG_RE,
  InvalidProjectInputError,
  ProjectNotFoundError,
  SlugTakenError,
  createProject,
  deleteProject,
  deriveSlug,
  ensureProject,
  getProject,
  knownProjectSlugs,
  listProjects,
  updateProject,
} from "../../src/projects/registry";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

describe("projects registry", () => {
  let d1: SqliteD1;
  let db: D1Database;

  beforeEach(() => {
    d1 = makeSqliteD1();
    db = d1.db as unknown as D1Database;
  });
  afterEach(() => d1.close());

  describe("deriveSlug", () => {
    it("lowercases, joins words with hyphens and strips illegal characters", () => {
      expect(deriveSlug("My App!")).toBe("my-app");
      expect(deriveSlug("  Hello   World  ")).toBe("hello-world");
      expect(deriveSlug("2024 Plan")).toBe("2024-plan");
      expect(deriveSlug("keep_under-scores")).toBe("keep_under-scores");
    });

    it("never starts or ends with a separator and collapses runs of hyphens", () => {
      expect(deriveSlug("---x---")).toBe("x");
      expect(deriveSlug("a - b")).toBe("a-b");
      expect(deriveSlug("_lead")).toBe("lead");
    });

    it("returns null when nothing valid survives", () => {
      expect(deriveSlug("!!!")).toBeNull();
      expect(deriveSlug("   ")).toBeNull();
      expect(deriveSlug("")).toBeNull();
    });

    it("truncates to the 64 character grammar limit and always yields a valid slug", () => {
      const slug = deriveSlug("a".repeat(100));
      expect(slug).toHaveLength(64);
      expect(PROJECT_SLUG_RE.test(slug!)).toBe(true);
      expect(deriveSlug(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
    });
  });

  describe("createProject", () => {
    it("derives the slug from the name and returns the full row", async () => {
      const before = Date.now();
      const row = await createProject(db, "ws1", { name: "  My App  ", description: "The app", aliases: [" Hosting ", "hosting", "Deploy"] }, d1.admitEnv({ DB: db } as import("../../src/env").Env));

      expect(row).toEqual({
        id: "my-app",
        workspace_id: "ws1",
        name: "My App",
        description: "The app",
        aliases: ["hosting", "deploy"],
        status: "active",
        created_at: expect.any(Number),
        updated_at: null,
      });
      expect(row.created_at).toBeGreaterThanOrEqual(before);
      expect((await getProject(db, ["ws1"], "my-app"))[0]).toEqual(row);
    });

    it("uses an explicit id when it matches the grammar", async () => {
      expect((await createProject(db, "ws1", { id: "site_2", name: "Website" }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).id).toBe("site_2");
    });

    it("rejects an explicit id that breaks the grammar", async () => {
      await expect(createProject(db, "ws1", { id: "Bad Id", name: "x" }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow(InvalidProjectInputError);
      await expect(createProject(db, "ws1", { id: "Bad Id", name: "x" }, d1.admitEnv({ DB: db } as import("../../src/env").Env)))
        .rejects.toThrow('invalid project id "Bad Id": must match [a-z0-9][a-z0-9_-]{0,63}');
    });

    it("rejects a name that yields no slug unless an id is given", async () => {
      await expect(createProject(db, "ws1", { name: "!!!" }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow(InvalidProjectInputError);
      expect((await createProject(db, "ws1", { id: "ok", name: "!!!" }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).id).toBe("ok");
    });

    it("throws SlugTakenError for a duplicate in the same workspace only", async () => {
      await createProject(db, "ws1", { name: "Website" }, d1.admitEnv({ DB: db } as import("../../src/env").Env));

      await expect(createProject(db, "ws1", { name: "Website" }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow(SlugTakenError);
      await expect(createProject(db, "ws2", { name: "Website" }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).resolves.toMatchObject({ id: "website", workspace_id: "ws2" });
    });

    it("validates name and description", async () => {
      await expect(createProject(db, "ws1", { name: "" }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow("name is required");
      await expect(createProject(db, "ws1", { name: "   " }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow("name is required");
      await expect(createProject(db, "ws1", { id: "a", name: "x".repeat(121) }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow("name must be at most 120 characters");
      await expect(createProject(db, "ws1", { id: "a", name: "x".repeat(120) }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).resolves.toBeDefined();
      await expect(createProject(db, "ws1", { id: "b", name: "x", description: "d".repeat(1001) }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow("description must be at most 1000 characters");
      await expect(createProject(db, "ws1", { id: "c", name: "x", description: "d".repeat(1000) }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).resolves.toBeDefined();
      await expect(createProject(db, "ws1", { id: "d", name: "bad\0name" }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow("NUL is not allowed");
    });

    it("rejects reserved-namespace aliases, including the project: namespace itself", async () => {
      for (const prefix of ["kind:", "status:", "volatility:", "stale:", "capsule:", "capsule-slot:", "project:", "Project:"]) {
        await expect(createProject(db, "ws1", { id: "p", name: "p", aliases: ["ok", `${prefix}x`] }, d1.admitEnv({ DB: db } as import("../../src/env").Env)), prefix)
          .rejects.toThrow(InvalidProjectInputError);
      }
    });

    it("rejects more than 16 aliases, counted after normalization", async () => {
      const sixteen = Array.from({ length: 16 }, (_, i) => `tag${i}`);
      await expect(createProject(db, "ws1", { id: "a", name: "a", aliases: sixteen }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).resolves.toBeDefined();
      await expect(createProject(db, "ws1", { id: "b", name: "b", aliases: [...sixteen, "tag16"] }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow("at most 16 aliases");
      // Duplicates collapse first, so 17 entries naming 16 tags is fine.
      await expect(createProject(db, "ws1", { id: "c", name: "c", aliases: [...sixteen, "TAG0"] }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).resolves.toBeDefined();
    });

    it("rejects malformed aliases", async () => {
      await expect(createProject(db, "ws1", { id: "a", name: "a", aliases: [""] }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow(InvalidProjectInputError);
      await expect(createProject(db, "ws1", { id: "a", name: "a", aliases: ["x".repeat(129)] }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow(InvalidProjectInputError);
      await expect(createProject(db, "ws1", { id: "a", name: "a", aliases: [5 as unknown as string] }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow(InvalidProjectInputError);
      await expect(createProject(db, "ws1", { id: "a", name: "a", aliases: 'x' as unknown as string[] }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow(InvalidProjectInputError);
      await expect(createProject(db, "ws1", { id: "a", name: "a", aliases: ['has"quote'] }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow(InvalidProjectInputError);
    });
  });

  describe("reads are scoped to the workspaces passed in", () => {
    beforeEach(async () => {
      await createProject(db, "ws1", { name: "Beta" }, d1.admitEnv({ DB: db } as import("../../src/env").Env));
      await createProject(db, "ws1", { name: "alpha" }, d1.admitEnv({ DB: db } as import("../../src/env").Env));
      await createProject(db, "ws2", { name: "Beta", aliases: ["b2"] }, d1.admitEnv({ DB: db } as import("../../src/env").Env));
      await createProject(db, "ws3", { name: "Secret" }, d1.admitEnv({ DB: db } as import("../../src/env").Env));
      await updateProject(db, "ws1", "alpha", { status: "archived" }, d1.admitEnv({ DB: db } as import("../../src/env").Env));
    });

    it("listProjects returns only readable, active projects ordered by name", async () => {
      const rows = await listProjects(db, ["ws1", "ws2"]);
      expect(rows.map(r => `${r.workspace_id}/${r.id}`)).toEqual(["ws1/beta", "ws2/beta"]);
    });

    it("listProjects can include archived rows", async () => {
      const rows = await listProjects(db, ["ws1"], { includeArchived: true });
      expect(rows.map(r => r.id)).toEqual(["alpha", "beta"]);
      expect(rows[0].status).toBe("archived");
    });

    it("never returns a workspace it was not given", async () => {
      expect((await listProjects(db, ["ws1", "ws2"], { includeArchived: true })).some(r => r.id === "secret")).toBe(false);
      expect(await getProject(db, ["ws1"], "secret")).toEqual([]);
      expect(await knownProjectSlugs(db, ["ws1"])).not.toContain("secret");
    });

    it("getProject returns every readable row for the slug, archived or not", async () => {
      const rows = await getProject(db, ["ws1", "ws2"], "beta");
      expect(rows.map(r => r.workspace_id).sort()).toEqual(["ws1", "ws2"]);
      expect(rows.find(r => r.workspace_id === "ws2")!.aliases).toEqual(["b2"]);
      expect((await getProject(db, ["ws1"], "alpha"))[0].status).toBe("archived");
    });

    it("an empty workspace list reads nothing and issues no statement", async () => {
      d1.issued.length = 0;
      expect(await listProjects(db, [])).toEqual([]);
      expect(await getProject(db, [], "beta")).toEqual([]);
      expect(await knownProjectSlugs(db, [])).toEqual([]);
      expect(d1.issued).toEqual([]);
    });

    it("knownProjectSlugs lists distinct active slugs, capped by the limit", async () => {
      expect(await knownProjectSlugs(db, ["ws1", "ws2"])).toEqual(["beta"]);
      for (let i = 0; i < 12; i++) await createProject(db, "ws1", { id: `p${String(i).padStart(2, "0")}`, name: `p${i}` }, d1.admitEnv({ DB: db } as import("../../src/env").Env));
      expect(await knownProjectSlugs(db, ["ws1"])).toHaveLength(10);
      expect(await knownProjectSlugs(db, ["ws1"], 3)).toHaveLength(3);
    });
  });

  describe("updateProject", () => {
    beforeEach(async () => {
      await createProject(db, "ws1", { name: "Website", description: "old", aliases: ["web"] }, d1.admitEnv({ DB: db } as import("../../src/env").Env));
    });

    it("patches only the fields given and stamps updated_at", async () => {
      const row = await updateProject(db, "ws1", "website", { name: "Site" }, d1.admitEnv({ DB: db } as import("../../src/env").Env));

      expect(row).toMatchObject({ id: "website", name: "Site", description: "old", aliases: ["web"], status: "active" });
      expect(row.updated_at).toEqual(expect.any(Number));
      expect((await getProject(db, ["ws1"], "website"))[0]).toEqual(row);
    });

    it("replaces aliases wholesale with validation", async () => {
      expect((await updateProject(db, "ws1", "website", { aliases: ["Hosting", "dns"] }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).aliases).toEqual(["hosting", "dns"]);
      expect((await updateProject(db, "ws1", "website", { aliases: [] }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).aliases).toEqual([]);
      await expect(updateProject(db, "ws1", "website", { aliases: ["kind:x"] }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow(InvalidProjectInputError);
    });

    it("archives and reactivates", async () => {
      expect((await updateProject(db, "ws1", "website", { status: "archived" }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).status).toBe("archived");
      expect((await updateProject(db, "ws1", "website", { status: "active" }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).status).toBe("active");
      await expect(updateProject(db, "ws1", "website", { status: "gone" as "active" }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow('status must be "active" or "archived"');
    });

    it("rejects an empty patch and invalid fields without writing", async () => {
      await expect(updateProject(db, "ws1", "website", {}, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow(InvalidProjectInputError);
      await expect(updateProject(db, "ws1", "website", { name: " " }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow("name is required");
      expect((await getProject(db, ["ws1"], "website"))[0].updated_at).toBeNull();
    });

    it("throws ProjectNotFoundError for an unknown slug or another workspace's row", async () => {
      await expect(updateProject(db, "ws1", "nope", { name: "x" }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow(ProjectNotFoundError);
      await expect(updateProject(db, "ws2", "website", { name: "x" }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow(ProjectNotFoundError);
    });
  });

  describe("deleteProject", () => {
    it("removes only the registry row and leaves member entries untouched", async () => {
      await createProject(db, "ws1", { name: "Website" }, d1.admitEnv({ DB: db } as import("../../src/env").Env));
      d1.seed({ id: "e1", content: "member", createdAt: 1, tags: ["project:website"] });

      expect(await deleteProject(db, "ws1", "website", d1.admitEnv({ DB: db } as import("../../src/env").Env))).toBe(true);

      expect(await getProject(db, ["ws1"], "website")).toEqual([]);
      expect(d1.rows()).toHaveLength(1);
      expect(JSON.parse(d1.rows()[0].tags as string)).toEqual(["project:website"]);
    });

    it("returns false for an unknown slug and never crosses workspaces", async () => {
      await createProject(db, "ws1", { name: "Website" }, d1.admitEnv({ DB: db } as import("../../src/env").Env));

      expect(await deleteProject(db, "ws1", "nope", d1.admitEnv({ DB: db } as import("../../src/env").Env))).toBe(false);
      expect(await deleteProject(db, "ws2", "website", d1.admitEnv({ DB: db } as import("../../src/env").Env))).toBe(false);
      expect(await getProject(db, ["ws1"], "website")).toHaveLength(1);
    });

    it("lets the same slug be re-created afterwards", async () => {
      await createProject(db, "ws1", { name: "Website" }, d1.admitEnv({ DB: db } as import("../../src/env").Env));
      await deleteProject(db, "ws1", "website", d1.admitEnv({ DB: db } as import("../../src/env").Env));
      await expect(createProject(db, "ws1", { name: "Website" }, d1.admitEnv({ DB: db } as import("../../src/env").Env))).resolves.toMatchObject({ id: "website" });
    });
  });

  describe("ensureProject", () => {
    it("creates a bare active row named after the slug and reports it", async () => {
      expect(await ensureProject(db, "ws1", "website", d1.admitEnv({ DB: db } as import("../../src/env").Env))).toBe(true);

      expect((await getProject(db, ["ws1"], "website"))[0]).toMatchObject({
        id: "website", workspace_id: "ws1", name: "website", description: "", aliases: [], status: "active", updated_at: null,
      });
    });

    it("is idempotent and never overwrites an existing row", async () => {
      await createProject(db, "ws1", { name: "Website", description: "keep", aliases: ["web"] }, d1.admitEnv({ DB: db } as import("../../src/env").Env));
      await updateProject(db, "ws1", "website", { status: "archived" }, d1.admitEnv({ DB: db } as import("../../src/env").Env));

      expect(await ensureProject(db, "ws1", "website", d1.admitEnv({ DB: db } as import("../../src/env").Env))).toBe(false);
      expect(await ensureProject(db, "ws1", "website", d1.admitEnv({ DB: db } as import("../../src/env").Env))).toBe(false);

      expect((await getProject(db, ["ws1"], "website"))[0]).toMatchObject({ name: "Website", description: "keep", aliases: ["web"], status: "archived" });
    });

    it("costs one statement and refuses an invalid slug", async () => {
      d1.issued.length = 0;
      await ensureProject(db, "ws1", "website", d1.admitEnv({ DB: db } as import("../../src/env").Env));
      expect(d1.issued).toHaveLength(1);
      await expect(ensureProject(db, "ws1", "Bad Slug", d1.admitEnv({ DB: db } as import("../../src/env").Env))).rejects.toThrow(InvalidProjectInputError);
    });
  });
});
