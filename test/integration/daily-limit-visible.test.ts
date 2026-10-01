/**
 * R3 (MAJOR, budget audit): a spent D1 daily cap must be a clear, visible limit — never Cloudflare's
 * opaque error 1101 (test/budget/visible-limit.test.ts @ v4/budget-audit 0bf42b1c documents the raw
 * D1 error text this simulates). Director's fixed contract, 2026-09-27: REST answers 429 with
 * Retry-After and the daily_limit JSON body (src/lib/daily-limit.ts); MCP answers a plain sentence.
 * Caught once at the top-level fetch handler (src/index.ts) — identity resolution is itself a D1
 * read, so REST and the MCP pre-dispatch path share this one catch.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { req } from "../helpers/make-request";

const READ_CAP = "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
const WRITE_CAP = "D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";

/** Every execution fails the way D1 fails once the account's daily cap is spent. */
function capped(db: D1Database, message: string): D1Database {
  const fail = async () => { throw new Error(message); };
  const stmt = (s: D1PreparedStatement): D1PreparedStatement => new Proxy(s, {
    get(t, p) {
      if (p === "bind") return (...a: unknown[]) => stmt(t.bind(...a));
      if (p === "all" || p === "first" || p === "run" || p === "raw") return fail;
      const v = (t as any)[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const prepare = db.prepare.bind(db);
  return { prepare: (sql: string) => stmt(prepare(sql)), batch: fail, exec: fail, dump: fail } as unknown as D1Database;
}

/** Fails only from the Nth D1 call onward — simulates the cap tripping partway through a request
 * that itself issues several statements, rather than one already spent before the request began. */
function cappedAfter(db: D1Database, n: number, message: string): D1Database {
  let calls = 0;
  const fail = async () => { throw new Error(message); };
  const guarded = (fn: (...args: any[]) => Promise<unknown>) => async (...args: any[]) => { calls++; return calls > n ? fail() : fn(...args); };
  const stmt = (s: D1PreparedStatement): D1PreparedStatement => new Proxy(s, {
    get(t, p) {
      if (p === "bind") return (...a: unknown[]) => stmt(t.bind(...a));
      if (p === "all" || p === "first" || p === "run" || p === "raw") return guarded(() => (t as any)[p]());
      const v = (t as any)[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const prepare = db.prepare.bind(db);
  return { prepare: (sql: string) => stmt(prepare(sql)), batch: guarded((statements: D1PreparedStatement[]) => db.batch(statements)), exec: db.exec.bind(db), dump: db.dump?.bind(db) } as unknown as D1Database;
}

describe("a spent D1 daily cap is a clear, visible limit", () => {
  const open: SqliteD1[] = [];
  afterEach(() => open.splice(0).forEach(s => s.close()));

  async function brain(wrap: (db: D1Database) => D1Database): Promise<{ env: Env; sqlite: SqliteD1 }> {
    resetDatabaseInit();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    open.push(sqlite);
    const kv = makeMemoryKV();
    const boot = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv }));
    await initializeDatabase(boot);
    await ensureTenantBootstrap(boot);
    const env = makeTestEnv(undefined, { DB: wrap(sqlite.db as unknown as D1Database), OAUTH_KV: kv });
    return { env, sqlite };
  }

  const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

  it("GET /recall answers 429 daily_limit (read) instead of throwing", async () => {
    const { env } = await brain(db => capped(db, READ_CAP));
    let thrown: unknown;
    let res: Response | undefined;
    try { res = await worker.fetch(req("POST", "/recall?query=atlas&topK=5"), env, ctx); } catch (e) { thrown = e; }
    expect(thrown, "an uncaught throw reaches the caller as Cloudflare error 1101").toBeUndefined();
    expect(res!.status).toBe(429);
    expect(res!.headers.get("Retry-After")).toMatch(/^\d+$/);
    const body = await res!.json() as any;
    expect(body).toMatchObject({ ok: false, error: "daily_limit", limit: "d1_rows_read" });
    expect(body.resets_at).toMatch(/T00:00:00\.000Z$/);
    expect(body.message).toMatch(/could not load/i);
  });

  it("POST /capture answers 429 daily_limit (write) and leaves nothing half-saved", async () => {
    const { env, sqlite } = await brain(db => capped(db, WRITE_CAP));
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "a note written after the cap" } }), env, ctx);
    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body).toMatchObject({ ok: false, error: "daily_limit", limit: "d1_rows_written" });
    expect(body.message).toMatch(/nothing was saved/i);
    const rows = sqlite.rows();
    expect(rows).toEqual([]);
  });

  it("truth check: a write that trips the cap partway through leaves nothing half-saved", async () => {
    // The account's cumulative write count crosses the cap on THIS request's own second
    // statement, not before the request began — the scenario "Not saved" must hold for even
    // when part of the write path already ran.
    const { env, sqlite } = await brain(db => cappedAfter(db, 1, WRITE_CAP));
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "partway-through capture" } }), env, ctx);
    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error).toBe("daily_limit");
    expect(sqlite.rows().some(r => String(r.content).includes("partway-through"))).toBe(false);
  });

  it("GET /health still answers with the visible daily limit instead of crashing", async () => {
    const { env } = await brain(db => capped(db, READ_CAP));
    let thrown: unknown;
    let res: Response | undefined;
    try { res = await worker.fetch(req("GET", "/health"), env, ctx); } catch (e) { thrown = e; }
    expect(thrown).toBeUndefined();
    expect(res!.status).toBe(429);
    const body = await res!.json() as any;
    expect(body.error).toBe("daily_limit");
  });

  it("the MCP surface (identity resolution capped) answers the MCP sentence, not the REST message", async () => {
    const { env } = await brain(db => capped(db, READ_CAP));
    const res = await worker.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recall", arguments: { query: "x" } } }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error).toBe("daily_limit");
    expect(body.message.startsWith("Could not load memories.")).toBe(true);
  });
});
