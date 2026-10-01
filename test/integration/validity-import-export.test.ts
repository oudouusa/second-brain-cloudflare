/** Track 2 Task A7 (T-0089.2.1): GET /export and POST /import carry valid_from and valid_until. */
import { describe, it, expect, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const open: SqliteD1[] = [];
afterEach(() => { for (const s of open.splice(0)) s.close(); });

async function brain() {
  resetDatabaseInit();
  const sqlite = makeSqliteD1();
  open.push(sqlite);
  const env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() })) as Env;
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  const seed = (id: string, validFrom: number | null, validUntil: number | null) =>
    sqlite.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, valid_from, valid_until) VALUES (?, ?, '[]', 'api', ?, '[]', ?, ?, ?, ?)`)
      .bind(id, `content ${id}`, 5000, roots.ownerPersonalWorkspaceId, roots.ownerUserId, validFrom, validUntil).run();
  const call = async (method: string, path: string, body?: unknown) => (await worker.fetch(req(method, path, body === undefined ? {} : { body }), env, ctx)).json() as Promise<any>;
  const row = async (id: string) => (await env.DB.prepare(`SELECT valid_from, valid_until FROM entries WHERE id = ?`).bind(id).first()) as any;
  return { env, sqlite, seed, call, row };
}

describe("export and import keep validity", () => {
  it("export then import round-trips valid_from and valid_until, including NULLs and an unknown start", async () => {
    const a = await brain();
    await a.seed("open", null, null);
    await a.seed("stated", 1000, null);
    await a.seed("closed", null, 9000);
    await a.seed("told-ended", 0, 3000);
    const exported = await a.call("GET", "/export");
    expect(exported.entries.find((e: any) => e.id === "closed")).toMatchObject({ valid_from: null, valid_until: 9000 });

    const b = await brain();
    const r = await b.call("POST", "/import", exported);
    expect(r).toMatchObject({ ok: true, imported: 4, failed: 0 });
    expect(await b.row("open")).toEqual({ valid_from: null, valid_until: null });
    expect(await b.row("stated")).toEqual({ valid_from: 1000, valid_until: null });
    expect(await b.row("closed")).toEqual({ valid_from: null, valid_until: 9000 });
    expect(await b.row("told-ended")).toEqual({ valid_from: 0, valid_until: 3000 });
  });

  it("a 3.7 export imports with NULL validity", async () => {
    const b = await brain();
    const r = await b.call("POST", "/import", { version: 3, entries: [{ id: "old", content: "An old memory", created_at: 1000 }] });
    expect(r).toMatchObject({ imported: 1 });
    expect(await b.row("old")).toEqual({ valid_from: null, valid_until: null });
  });

  it("an import never supersedes: it only inserts, and writes no version", async () => {
    const b = await brain();
    await b.seed("current", null, null);
    const r = await b.call("POST", "/import", { entries: [{ id: "imported", content: "I live somewhere else now", created_at: 9000, valid_from: 8000 }] });
    expect(r).toMatchObject({ imported: 1 });
    expect(await b.row("current")).toEqual({ valid_from: null, valid_until: null });
    expect((await b.env.DB.prepare(`SELECT COUNT(*) AS n FROM entry_versions`).first() as any).n).toBe(0);
  });

  it("malformed or inverted validity is dropped, and the memory still imports", async () => {
    const b = await brain();
    const r = await b.call("POST", "/import", { entries: [
      { id: "bad-type", content: "x", created_at: 1000, valid_from: "2020", valid_until: 5 },
      { id: "inverted", content: "y", created_at: 1000, valid_from: 3000, valid_until: 2000 },
      { id: "before-created", content: "z", created_at: 5000, valid_until: 2000 },
      { id: "future-start", content: "f", created_at: 1000, valid_from: Date.now() + 86_400_000 },
      { id: "future-end", content: "g", created_at: 1000, valid_until: Date.now() + 86_400_000 },
    ] });
    expect(r).toMatchObject({ imported: 5, failed: 0 });
    for (const id of ["bad-type", "inverted", "before-created", "future-start", "future-end"]) expect(await b.row(id), id).toEqual({ valid_from: null, valid_until: null });
  });
});
