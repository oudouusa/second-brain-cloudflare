/**
 * GET /standing reports the workspace's configured standing limit
 * (18-copy-deck.md section 10, T7-E Task 14): "Not in use: only {max} can be
 * active" needs it so the dashboard never types a number in (a brain can
 * configure a different STANDING_MAX). src/routes/standing.ts's GET /standing
 * returns it as a top-level `max` field, the same cfg.STANDING_MAX the route
 * already reads to decide over_limit - no new config read, no new query.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";
import { resetStandingIsolateState } from "../../src/standing/cache";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import worker from "../../src/index";

function insertStanding(sqlite: SqliteD1, id: string, createdAt: number): void {
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
     VALUES (?, ?, '["standing:active"]', 'api', ?, '["v"]', '', '')`,
  ).bind(id, `standing row ${id}`, createdAt).run();
}

describe("GET /standing reports the configured limit", () => {
  const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;
  let sqlite: SqliteD1;
  let env: Env;
  const token = "owner-token";

  beforeEach(async () => {
    resetDatabaseInit();
    resetStandingIsolateState();
    sqlite = makeSqliteD1();
    env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AUTH_TOKEN: token }));
    await initializeDatabase(env);
    await ensureTenantBootstrap(env);
  });
  afterEach(() => sqlite.close());

  it("carries the workspace's configured STANDING_MAX as a top-level field, so the dashboard never types a number in", async () => {
    const res = await worker.fetch(new Request("http://localhost/standing", { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
    const body = (await res.json()) as { ok: boolean; max: number };

    expect(body.ok).toBe(true);
    expect(body.max).toBe(DEFAULTS.STANDING_MAX);
  });

  it("still marks a row past the same limit as over_limit", async () => {
    // DEFAULTS.STANDING_MAX + 1 rows in one workspace: the oldest-ranked extra one is over_limit.
    for (let i = 0; i <= DEFAULTS.STANDING_MAX; i++) insertStanding(sqlite, `s${i}`, 1000 + i);

    const res = await worker.fetch(new Request("http://localhost/standing", { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
    const body = (await res.json()) as { max: number; standing: { id: string; reason?: string }[] };
    const overLimit = body.standing.find((s) => s.reason === "over_limit");

    expect(overLimit).toBeDefined();
    expect(body.max).toBe(DEFAULTS.STANDING_MAX);
  });
});
