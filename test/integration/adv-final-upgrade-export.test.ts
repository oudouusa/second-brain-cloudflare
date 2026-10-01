import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import worker from "../../src/index";
import { makeSqliteD1, splitSchemaStatements, stripSqlComments, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { hashToken, resolveIdentityFromToken } from "../../src/lib/identity";
import { readEntryTimeline } from "../../src/memory/history";
import { VERSIONS_SINCE_KV_KEY } from "../../src/constants";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;
let sqlite: SqliteD1;
let env: Env;
afterEach(() => sqlite?.close());

async function legacyBrain() {
  resetDatabaseInit();
  sqlite = makeSqliteD1({ schema: false });
  const fixture = readFileSync(resolve(import.meta.dirname, "../fixtures/schema-3.7.0.sql"), "utf8");
  for (const statement of splitSchemaStatements(stripSqlComments(fixture))) {
    if (statement.trim()) await sqlite.db.exec(statement);
  }
  // A deployed 3.7 brain has the runtime ALTER column, including old NULLs.
  await sqlite.db.exec("ALTER TABLE entries ADD COLUMN updated_at INTEGER");
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
  const ws = [
    ["company", "company", "Company"], ["owner-ws", "personal", "Owner"],
    ["bob-ws", "personal", "Bob"], ["carol-ws", "personal", "Carol"],
  ];
  for (const [id, kind, name] of ws) await sqlite.db.prepare(
    "INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, ?, ?, 1)",
  ).bind(id, kind, name).run();
  for (const [id, name, role, token] of [
    ["owner", "Owner", "admin", "test-token"], ["bob", "Bob", "member", "bob-token"],
    ["carol", "Carol", "member", "carol-token"],
  ]) {
    await sqlite.db.prepare("INSERT INTO users (id, name, role, token_hash, created_at) VALUES (?, ?, ?, ?, 1)")
      .bind(id, name, role, await hashToken(token)).run();
    await sqlite.db.prepare("INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, 1)")
      .bind(id, `${id}-ws`).run();
    await sqlite.db.prepare("INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, 'company', 1)")
      .bind(id).run();
  }
  for (let i = 0; i < 50; i++) {
    const id = `legacy-${i}`;
    const workspace = i % 3 === 0 ? "company" : i % 3 === 1 ? "owner-ws" : "bob-ws";
    const actor = i === 0 ? "" : workspace === "bob-ws" ? "bob" : "owner";
    const tags = i === 1 ? '["capsule:core"]' : i === 2 ? '["status:deprecated"]' : "[]";
    await sqlite.db.prepare(
      "INSERT INTO entries (id, content, tags, created_at, updated_at, workspace_id, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, `original ${i}`, tags, 1000 + i, i % 2 ? null : 2000 + i, workspace, actor).run();
  }
  for (let i = 0; i < 20; i++) await sqlite.db.prepare(
    "INSERT INTO edges (id, source_id, target_id, created_at, updated_at, workspace_id) VALUES (?, ?, ?, 1, 1, 'company')",
  ).bind(`edge-${i}`, `legacy-${i * 2}`, `legacy-${i * 2 + 1}`).run();
  await sqlite.db.prepare("INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES ('private-event', 'legacy-0', '', 'updated', '{}', 10)").run();
  await sqlite.db.prepare("INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES ('old-share', 'legacy-0', '', 'shared', '{\"workspaceId\":\"company\"}', 20)").run();
  return sqlite;
}

const all = (sql: string) => sqlite.db.prepare(sql).all().then(r => r.results as Record<string, unknown>[]);
const one = (sql: string) => sqlite.db.prepare(sql).first() as Promise<Record<string, unknown> | null>;

describe("final adversary: populated 3.7 upgrade and backup", () => {
  it("first request upgrades multi-user data without rewriting live rows or edges", async () => {
    await legacyBrain();
    const beforeEntries = await all("SELECT * FROM entries ORDER BY id");
    const beforeEdges = await all("SELECT * FROM edges ORDER BY id");
    const beforeEvents = await all("SELECT * FROM entry_events ORDER BY id");
    const beforeChanges = Number((await one("SELECT total_changes() AS n"))!.n);
    await initializeDatabase(env);
    expect(Number((await one("SELECT total_changes() AS n"))!.n) - beforeChanges).toBe(3);
    const oldColumns = Object.keys(beforeEntries[0]);
    expect((await all("SELECT * FROM entries ORDER BY id")).map(r =>
      Object.fromEntries(oldColumns.map(key => [key, r[key]])))).toEqual(beforeEntries);
    const oldEdgeColumns = Object.keys(beforeEdges[0]);
    expect((await all("SELECT * FROM edges ORDER BY id")).map(r =>
      Object.fromEntries(oldEdgeColumns.map(key => [key, r[key]])))).toEqual(beforeEdges);
    expect(await all("SELECT * FROM entry_events ORDER BY id")).toEqual(beforeEvents);
    expect(await all("SELECT name FROM sqlite_master WHERE name IN ('entry_versions', 'entries_trash') ORDER BY name"))
      .toEqual([{ name: "entries_trash" }, { name: "entry_versions" }]);
    expect(Number(await env.OAUTH_KV.get(VERSIONS_SINCE_KV_KEY))).toBeGreaterThan(0);

    resetDatabaseInit();
    const issuedAt = sqlite.issued.length;
    await initializeDatabase(env);
    expect(sqlite.issued.slice(issuedAt)).toHaveLength(1);
  });

  it("first REST edit versions a legacy NULL-updated row and old move events stay private", async () => {
    await legacyBrain();
    // Authentication is a core first-request path, not a direct init call.
    const update = await worker.fetch(req("POST", "/update", {
      token: "test-token", body: { id: "legacy-1", content: "revised owner text" },
    }), env, ctx);
    expect(update.status).toBe(200);
    expect(await all("SELECT seq, content, valid_from FROM entry_versions WHERE entry_id = 'legacy-1'"))
      .toEqual([{ seq: 1, content: "original 1", valid_from: 1001 }]);
    expect((await one("SELECT content FROM entries WHERE id = 'legacy-1'"))!.content).toBe("revised owner text");

    const roots = await ensureTenantBootstrap(env);
    expect(roots).toMatchObject({ ownerUserId: "owner", companyWorkspaceId: "company", ownerPersonalWorkspaceId: "owner-ws" });
    const carol = (await resolveIdentityFromToken("carol-token", env))!;
    const owner = (await resolveIdentityFromToken("test-token", env))!;
    const teammateTimeline = await readEntryTimeline(env, "legacy-0", carol, "", 10, false, "company", [], "api");
    const ownerTimeline = await readEntryTimeline(env, "legacy-0", owner, "", 10, false, "company", [], "api");
    expect(teammateTimeline.timeline.map(e => e.event)).toEqual(["shared"]);
    expect(ownerTimeline.timeline.map(e => e.event)).toEqual(["updated", "shared"]);
  });

  it("export excludes versions and trash, while live legacy entries still round-trip", async () => {
    await legacyBrain();
    await initializeDatabase(env);
    const edited = await worker.fetch(req("POST", "/update", {
      token: "test-token", body: { id: "legacy-1", content: "edited for backup" },
    }), env, ctx);
    expect(edited.status).toBe(200);
    const forgotten = await worker.fetch(req("POST", "/forget", {
      token: "test-token", body: { id: "legacy-4" },
    }), env, ctx);
    expect(forgotten.status).toBe(200);
    const exported = await worker.fetch(req("GET", "/export", { token: "test-token" }), env, ctx);
    expect(exported.status).toBe(200);
    const backup = await exported.json() as Record<string, any>;
    expect(backup.version).toBe(3);
    expect(backup).not.toHaveProperty("versions");
    expect(backup).not.toHaveProperty("trash");
    expect(backup.entries.some((e: any) => e.id === "legacy-1" && e.content === "edited for backup")).toBe(true);
    expect(backup.entries.some((e: any) => e.id === "legacy-4")).toBe(false);
    expect(backup.entries.some((e: any) => e.id === "legacy-2")).toBe(false);

    sqlite.close();
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    let offset = 0;
    let importedCount = 0;
    do {
      const imported = await worker.fetch(req("POST", `/import?offset=${offset}`, {
        token: "test-token", body: backup,
      }), env, ctx);
      expect(imported.status).toBe(200);
      const summary = await imported.json() as any;
      importedCount += summary.imported;
      offset = summary.next_offset;
    } while (offset < backup.entries.length);
    expect(importedCount).toBe(backup.entries.length);
    expect((await one("SELECT content FROM entries WHERE id = 'legacy-1'"))!.content).toBe("edited for backup");
    expect(await all("SELECT * FROM entry_versions")).toEqual([]);
    expect(await all("SELECT * FROM entries_trash")).toEqual([]);
  });
});
