import { afterEach, expect, it } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { computeAgentBrief } from "../../src/brief/compute";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { D1_MAX_BOUND_PARAMS } from "../../src/constants";
import type { Identity } from "../../src/lib/identity";
import type { ProjectRow } from "../../src/projects/registry";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
afterEach(() => sqlite?.close());
const ctx = { waitUntil: (_: Promise<unknown>) => {} };

it("keeps a 40-pattern project brief within D1's parameter ceiling for a member in 58 teams", async () => {
  sqlite = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase(sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"] })));
  const counts: number[] = [];
  const db = {
    ...sqlite.db,
    prepare(sql: string) {
      const stmt = sqlite.db.prepare(sql);
      return new Proxy(stmt, { get(target, key) {
        if (key !== "bind") return Reflect.get(target, key);
        return (...args: unknown[]) => { counts.push(args.length); return target.bind(...args); };
      } });
    },
  } as unknown as Env["DB"];
  const auth = {
    userId: "member", role: "member", personalWorkspaceId: "private",
    companyWorkspaceIds: Array.from({ length: 58 }, (_, i) => `team-${i}`),
  } as Identity;
  const projects: ProjectRow[] = Array.from({ length: 3 }, (_, i) => ({
    id: "shared", workspace_id: `team-${i}`, name: "Shared", description: "", status: "active",
    aliases: Array.from({ length: 13 }, (_, j) => `topic-${i}-${j}`), created_at: 1, updated_at: null,
  }));

  await computeAgentBrief(makeTestEnv(undefined, { DB: db }), ctx, auth, projects);
  expect(Math.max(...counts)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
});
