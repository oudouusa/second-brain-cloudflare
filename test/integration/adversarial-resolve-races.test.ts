import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityFromToken } from "../../src/lib/identity";
import { createMember } from "../../src/lib/team-admin";
import { resolveEntryAction, applyInsightResolution } from "../../src/memory/actions";
import { getReadableEntry } from "../../src/lib/entry-access";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); } };

// Make a real SQLite change exactly after the authorized read and before the action's write.
function afterAccessRead(id: string, change: () => Promise<unknown>) {
  const db = env.DB;
  let changed = false;
  env.DB = {
    ...db,
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      if (!sql.includes("FROM entries WHERE id = ? AND")) return stmt;
      return new Proxy(stmt, {
        get(target, key) {
          if (key !== "bind") return Reflect.get(target, key);
          return (...args: unknown[]) => {
            const bound = target.bind(...args);
            if (args[0] !== id) return bound;
            return new Proxy(bound, {
              get(inner, method) {
                if (method !== "first") return Reflect.get(inner, method);
                return async () => {
                  const row = await inner.first();
                  if (row && !changed) { changed = true; await change(); }
                  return row;
                };
              },
            });
          };
        },
      });
    },
  } as Env["DB"];
}

beforeEach(async () => {
  pending.length = 0;
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);
});
afterEach(async () => { await Promise.all(pending); sqlite.close(); });

describe("adversarial resolve interleavings", () => {
  it("does not mark done after the row moves to another member's private workspace", async () => {
    const owner = (await resolveIdentityFromToken("test-token", env))!;
    const other = await createMember(env, { name: "Other" });
    sqlite.seed({ id: "moving", content: "Private task", createdAt: 1, tags: ["task"] });
    await env.DB.prepare("UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = ?")
      .bind(owner.personalWorkspaceId, owner.userId, "moving").run();
    const db = env.DB;
    afterAccessRead("moving", () => db.prepare("UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = ?")
      .bind(other.member.personalWorkspaceId, other.member.userId, "moving").run());

    const result = await resolveEntryAction(env, ctx, owner, "moving", "done", undefined, { actorId: owner.userId, channel: "mcp" });
    const row = sqlite.rows().find(r => r.id === "moving")!;
    expect(row.workspace_id).toBe(other.member.personalWorkspaceId);
    expect(JSON.parse(String(row.tags))).toEqual(["task"]);
    expect(result.ok).toBe(false);
  });

  it("does not erase a concurrent edit while confirming a stale memory", async () => {
    const owner = (await resolveIdentityFromToken("test-token", env))!;
    sqlite.seed({ id: "edited", content: "Fact", createdAt: 1, tags: ["stale:as-of", "work"] });
    await env.DB.prepare("UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = ?")
      .bind(owner.personalWorkspaceId, owner.userId, "edited").run();
    const db = env.DB;
    afterAccessRead("edited", () => db.prepare("UPDATE entries SET tags = ? WHERE id = ?")
      .bind(JSON.stringify(["stale:as-of", "work", "user-edited"]), "edited").run());

    await resolveEntryAction(env, ctx, owner, "edited", "still_true", undefined, { actorId: owner.userId, channel: "mcp" });
    const row = sqlite.rows().find(r => r.id === "edited")!;
    expect(JSON.parse(String(row.tags))).toContain("user-edited");
  });

  it("does not dismiss an insight moved out of scope after its scoped read", async () => {
    const owner = (await resolveIdentityFromToken("test-token", env))!;
    const other = await createMember(env, { name: "Insight owner" });
    sqlite.seed({ id: "insight", content: "Suggested relationship", createdAt: 1, tags: ["auto-insight", "status:draft"] });
    await env.DB.prepare("UPDATE entries SET workspace_id = ? WHERE id = ?")
      .bind(owner.personalWorkspaceId, "insight").run();
    const scoped = await getReadableEntry(env, owner, "insight", "id, workspace_id, actor_id, tags, vector_ids") as Record<string, any>;
    expect(scoped).toBeTruthy();
    await env.DB.prepare("UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = ?")
      .bind(other.member.personalWorkspaceId, other.member.userId, "insight").run();

    await applyInsightResolution(env, ctx, { actorId: owner.userId, channel: "mcp" }, [scoped], 1, "dismiss");
    const row = sqlite.rows().find(r => r.id === "insight")!;
    expect(row.workspace_id).toBe(other.member.personalWorkspaceId);
    expect(JSON.parse(String(row.tags))).toContain("auto-insight");
    expect(JSON.parse(String(row.tags))).not.toContain("status:deprecated");
  });

  // T-0089.7.4's other half: a concurrent forget (which deletes the row from entries outright, the
  // same as it moved to the trash) between the caller's scoped read and this batch used to still
  // report the row resolved, because the old bulk UPDATE carried no guard at all. 01e8118e's
  // buildCasGuard on tags and workspace_id closes it: a row entries no longer has cannot satisfy
  // any guard, so its UPDATE misses and it is excluded from `resolved`.
  it("does not report an insight resolved after a concurrent forget trashes the row", async () => {
    const owner = (await resolveIdentityFromToken("test-token", env))!;
    sqlite.seed({ id: "gone", content: "Suggested relationship", createdAt: 1, tags: ["auto-insight", "status:draft"] });
    await env.DB.prepare("UPDATE entries SET workspace_id = ? WHERE id = ?")
      .bind(owner.personalWorkspaceId, "gone").run();
    const scoped = await getReadableEntry(env, owner, "gone", "id, workspace_id, actor_id, tags, vector_ids") as Record<string, any>;
    expect(scoped).toBeTruthy();
    // The row's own forget path moves it to entries_trash and deletes it from entries; what
    // applyInsightResolution's guard sees is that entries no longer has it under any guard.
    await sqlite.deleteFixtureRows("DELETE FROM entries WHERE id = ?", "gone");

    const result = await applyInsightResolution(env, ctx, { actorId: owner.userId, channel: "mcp" }, [scoped], 1, "confirm");
    expect(result.resolved).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(sqlite.rows().find(r => r.id === "gone")).toBeUndefined();
  });
});
