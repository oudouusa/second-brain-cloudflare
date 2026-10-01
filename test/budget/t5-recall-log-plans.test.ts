/**
 * Budget auditor (brief 19), Track 5 recall log. With RECALL_LOG on, every logged recall runs the day-cap INSERT and
 * a retention purge in one batch. The purge `DELETE ... WHERE id IN (SELECT id FROM recall_log WHERE created_at < ?
 * ORDER BY created_at ASC LIMIT ?)` has no index on created_at alone (idx_recall_log_ws leads with workspace_id), so
 * SQLite scans the whole table on every logged recall: at 30-day retention and 200 a day that is about 6,000 rows per
 * workspace, deployment-wide, read up to 200 times a day per workspace. Captures the real statements from
 * maybeLogRecall and requires that none scans recall_log. Requires src/recall/log.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULTS } from "../../src/config";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";

const HAS_LOG = existsSync(resolve(__dirname, "../../src/recall/log.ts"));
let s: SqliteD1 | undefined;
afterEach(() => s?.close());

describe.runIf(HAS_LOG)("recall log statements use indexes", () => {
  it("the cap INSERT, the retention purge and the follow read scan no table", async () => {
    const { maybeLogRecall, maybeMarkFollowed } = await import("../../src/recall/log") as any;
    resetDatabaseInit();
    s = makeSqliteD1();
    await initializeDatabase(s.admitEnv(makeTestEnv(undefined, { DB: s.db as any, OAUTH_KV: makeMemoryKV() })));
    const captured: { sql: string; args: unknown[] }[] = [];
    const db = s.db as any;
    const prepare = db.prepare.bind(db);
    const wrap = (st: any, sql: string): any => new Proxy(st, { get(t, p) {
      if (p === "bind") return (...a: unknown[]) => { captured.push({ sql, args: a }); return wrap(t.bind(...a), sql); };
      if (p === "__inner") return t;
      const v = t[p]; return typeof v === "function" ? v.bind(t) : v;
    } });
    const env = { OAUTH_KV: makeMemoryKV(), DB: { prepare: (sql: string) => wrap(prepare(sql), sql), batch: (x: any[]) => db.batch(x.map((y: any) => y.__inner ?? y)) } } as any;
    const cfg = { ...DEFAULTS, RECALL_LOG: "on" } as any;
    const now = Date.now();
    await maybeLogRecall(env, cfg, { workspaceId: "w1", channel: "mcp", query: "q", params: {} as any, returnedIds: ["a"], now } as any);
    if (maybeMarkFollowed) await maybeMarkFollowed(env, "w1", "a", now + 1000, cfg).catch(() => undefined);
    const logged = captured.filter(c => /recall_log/.test(c.sql));
    expect(logged.length).toBeGreaterThanOrEqual(2);
    const scans: string[] = [];
    for (const { sql, args } of logged) {
      const plan = ((await prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args.map(a => (a === undefined ? null : a))).all()).results as { detail: string }[]).map(r => r.detail);
      for (const d of plan) if (/^SCAN recall_log\b/.test(d)) scans.push(`${d}  <=  ${sql.replace(/\s+/g, " ").slice(0, 90)}`);
    }
    expect(scans, "full scans of recall_log per logged recall").toEqual([]);
  });
});
