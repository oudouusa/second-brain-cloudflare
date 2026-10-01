import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { scopeWhereForIdRead, scopeWhereForRead } from "../../src/lib/scope";
import { recallEntries } from "../../src/recall/search";
import { buildGraph, expandGraph, getConnections } from "../../src/graph/traverse";
import { checkDuplicateAndContradiction } from "../../src/capture/duplicate";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import worker from "../../src/index";
import type { Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

type Query = { name: string; sql: string; args: unknown[] };

describe("scoped entry id reads", () => {
  let sqlite: SqliteD1 | undefined;
  afterEach(() => sqlite?.close());

  it("uses the entries primary key for every hydration shape and keeps the workspace filter", async () => {
    sqlite = makeSqliteD1();
    const identity: Identity = { userId: "u1", role: "member", personalWorkspaceId: "mine", companyWorkspaceIds: ["team"], defaultShare: "" };
    const scope = scopeWhereForIdRead(scopeWhereForRead(identity));
    const aliased = scopeWhereForIdRead(scopeWhereForRead(identity, undefined, "e.workspace_id"));
    const ids = ["target", "foreign", ...Array.from({ length: 48 }, (_, i) => `missing-${i}`)];
    const queries: Query[] = [
      { name: "recall signals", sql: `SELECT id, recall_count, tags FROM entries WHERE id IN (?, ?) AND ${scope.clause}`, args: ["target", "foreign", ...scope.bindings] },
      { name: "recall final", sql: `SELECT id, content, tags FROM entries WHERE id IN (?, ?) AND tags NOT LIKE '%"auto-insight"%' AND ${scope.clause}`, args: ["target", "foreign", ...scope.bindings] },
      { name: "graph readability", sql: `SELECT id, tags FROM entries WHERE id IN (?, ?) AND ${scope.clause}`, args: ["target", "foreign", ...scope.bindings] },
      { name: "graph hydration", sql: `SELECT id, content, tags, source, created_at FROM entries WHERE id IN (?, ?) AND ${scope.clause}`, args: ["target", "foreign", ...scope.bindings] },
      { name: "graph view hydration", sql: `SELECT e.id, e.content, u.name FROM entries e LEFT JOIN users u ON u.id = e.actor_id WHERE e.id IN (?, ?) AND ${aliased.clause}`, args: ["target", "foreign", ...aliased.bindings] },
      { name: "admin resolution", sql: `SELECT id, tags, vector_ids FROM entries WHERE id IN (?, ?) AND ${scope.clause}`, args: ["target", "foreign", ...scope.bindings] },
      { name: "capture duplicate", sql: "SELECT id, content FROM entries WHERE id IN (?, ?) AND +workspace_id = ?", args: ["target", "foreign", "mine"] },
    ].map(query => ({ ...query, sql: query.sql.replace("IN (?, ?)", `IN (${ids.map(() => "?").join(", ")})`), args: [...ids, ...query.args.slice(2)] }));

    sqlite.seed({ id: "target", content: "visible", createdAt: 1001 });
    sqlite.seed({ id: "foreign", content: "hidden", createdAt: 1002 });
    await sqlite.db.prepare("UPDATE entries SET workspace_id = 'mine' WHERE id = 'target'").run();
    await sqlite.db.prepare("UPDATE entries SET workspace_id = 'foreign' WHERE id = 'foreign'").run();
    const smallPlans = await Promise.all(queries.map(async query =>
      (await sqlite!.db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.args).all()).results as { detail: string }[]
    ));
    for (let i = 0; i < 1000; i++) sqlite.seed({ id: `background-${i}`, content: "other", createdAt: i });
    await sqlite.db.prepare("UPDATE entries SET workspace_id = 'mine' WHERE id LIKE 'background-%'").run();

    for (const [index, query] of queries.entries()) {
      const plan = (await sqlite.db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.args).all()).results as { detail: string }[];
      expect(plan, `${query.name} plan after the partition grew`).toEqual(smallPlans[index]);
      expect(plan.map(row => row.detail).join(" "), query.name).toMatch(/sqlite_autoindex_entries_1/);
      expect(plan.map(row => row.detail).join(" "), query.name).not.toContain("idx_entries_workspace_created");
      const oldSql = query.sql.replace(/\+\(((?:e\.)?workspace_id IN \(\?, \?\))\)/, "$1")
        .replace("+workspace_id", "workspace_id");
      const oldPlan = (await sqlite.db.prepare(`EXPLAIN QUERY PLAN ${oldSql}`).bind(...query.args).all()).results as { detail: string }[];
      expect(oldPlan.map(row => row.detail).join(" "), `${query.name} previous plan`).toContain("idx_entries_workspace_created");
      const rows = (await sqlite.db.prepare(query.sql).bind(...query.args).all()).results as { id: string }[];
      expect(rows.map(row => row.id), query.name).toEqual(["target"]);
    }

    // A single id equality already resolves through the unique key; these
    // existing reads need no planner hint.
    for (const clause of ["workspace_id IN (?, ?)", "workspace_id = ?"]) {
      const sql = `SELECT id FROM entries WHERE id = ? AND ${clause}`;
      const args = clause.includes("IN") ? ["target", "mine", "team"] : ["target", "mine"];
      const plan = (await sqlite.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all()).results as { detail: string }[];
      expect(plan.map(row => row.detail).join(" ")).toMatch(/sqlite_autoindex_entries_1/);
    }
  });

  it("checks the plans of SQL issued by all seven production reads", async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    const identity: Identity = { userId: "u1", role: "member", personalWorkspaceId: "mine", companyWorkspaceIds: ["team"], defaultShare: "" };
    const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

    for (const [id, workspace] of [["target", "mine"], ["neighbor", "mine"], ["foreign", "elsewhere"]] as const) {
      sqlite.seed({ id, content: `alpha ${id}`, createdAt: 1000 });
      await sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE id = ?").bind(workspace, id).run();
    }
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES ('edge', 'target', 'neighbor', 'relates_to', 0.9, 'inferred', '{}', 1, 1, 'mine')`,
    ).run();
    const match = (id: string) => ({ id, score: 0.9, metadata: { parentId: id } });
    env.VECTORIZE = makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [match("target"), match("foreign")] }) });
    await recallEntries({ query: "alpha", topK: 5, synthesize: false }, env, ctx, undefined, { identity });
    await expandGraph(["target"], { hops: 1 }, env, undefined, identity);
    await getConnections("target", undefined, env, undefined, identity);
    await buildGraph({}, env, undefined, identity);
    await checkDuplicateAndContradiction("alpha target", env, undefined, "mine");

    sqlite.seed({ id: "admin-pattern", content: "insight", createdAt: 1001, tags: ["auto-insight"] });
    await sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE id = 'admin-pattern'")
      .bind(roots.ownerPersonalWorkspaceId).run();
    const response = await worker.fetch(new Request("http://localhost/patterns/resolve", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "admin-pattern", action: "dismiss" }),
    }), env, ctx);
    expect(response.status).toBe(200);

    const shapes = [
      ["recall signals", "SELECT id, created_at, recall_count, importance_score"],
      ["recall final", "SELECT id, content, tags, source, created_at, updated_at"],
      ["graph readability", "SELECT id, tags, valid_from, valid_until, created_at FROM entries WHERE"],
      ["graph hydration", "SELECT id, content, tags, source, created_at, valid_until FROM entries WHERE"],
      ["graph view hydration", "FROM entries e"],
      ["admin resolution", "SELECT id, tags, vector_ids, workspace_id FROM entries WHERE"],
      ["capture duplicate", "SELECT id, content, tags, valid_until FROM entries WHERE"],
    ] as const;
    for (const [name, fragment] of shapes) {
      const sql = sqlite.issued.find(statement => statement.includes(fragment) && /\b(?:e\.)?id IN \(/.test(statement));
      expect(sql, `${name} was issued`).toBeDefined();
      const bindings = Array.from({ length: (sql!.match(/\?/g) ?? []).length }, () => "mine");
      const plan = (await sqlite.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...bindings).all()).results as { detail: string }[];
      expect(plan.map(row => row.detail).join(" "), name).toMatch(/sqlite_autoindex_entries_1/);
    }
  });

  it("keeps an OR-bearing scope inside the id filter", async () => {
    sqlite = makeSqliteD1();
    sqlite.seed({ id: "target", content: "visible", createdAt: 1 });
    sqlite.seed({ id: "unrequested", content: "also readable", createdAt: 2 });
    await sqlite.db.prepare("UPDATE entries SET workspace_id = 'mine' WHERE id = 'target'").run();
    await sqlite.db.prepare("UPDATE entries SET workspace_id = 'team' WHERE id = 'unrequested'").run();
    const scope = scopeWhereForIdRead({ clause: "workspace_id = ? OR workspace_id = ?", bindings: ["mine", "team"] });
    const rows = (await sqlite.db.prepare(`SELECT id FROM entries WHERE id IN (?) AND ${scope.clause}`)
      .bind("target", ...scope.bindings).all()).results as { id: string }[];
    expect(rows.map(row => row.id)).toEqual(["target"]);
  });
});
