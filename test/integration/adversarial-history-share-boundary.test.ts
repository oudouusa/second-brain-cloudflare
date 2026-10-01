import { afterEach, expect, it } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { readEntryHistory } from "../../src/memory/history";
import { resolveIdentityFromToken } from "../../src/lib/identity";
import type { Env } from "../../src/env";

const sqlite = makeSqliteD1();
afterEach(() => { sqlite.close(); setDbReady(false); });

it("hides a private event recorded in the same millisecond as the share event", async () => {
  resetDatabaseInit();
  const env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  setDbReady(true);
  await ensureTenantBootstrap(env);
  const alice = await createMember(env, { name: "Alice" });
  const bob = await createMember(env, { name: "Bob" });
  const bobIdentity = (await resolveIdentityFromToken(bob.token, env))!;
  sqlite.seed({ id: "shared-entry", content: "Shared now", createdAt: 1000 });
  await env.DB.prepare("UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = ?")
    .bind(alice.member.personalWorkspaceId, alice.member.userId, "shared-entry").run();
  // Two ordered events with one millisecond timestamp can occur in the live write path.
  await env.DB.prepare("INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind("event-before", "shared-entry", alice.member.userId, "updated", '{"secret":"private-era"}', 1001).run();
  await env.DB.prepare("UPDATE entries SET workspace_id = ? WHERE id = ?")
    .bind(bobIdentity.companyWorkspaceIds[0], "shared-entry").run();
  await env.DB.prepare("INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind("event-share", "shared-entry", alice.member.userId, "shared", '{}', 1001).run();

  const history = await readEntryHistory(env, bobIdentity, "shared-entry");
  const events = history?.history.items.filter((i: any) => i.kind === "event") ?? [];
  expect.soft(events.map((e: any) => e.event)).toEqual(["shared"]);
  const response = await worker.fetch(req("POST", "/entry?id=shared-entry", { token: bob.token }), env, { waitUntil() {} } as unknown as ExecutionContext);
  const json = await response.json() as any;
  expect.soft(JSON.stringify(json)).not.toContain("private-era");
});
