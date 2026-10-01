// Ported from adv/t1-versions at fc89df2f, test/integration/adv-t1-versions.test.ts (R2-7).
// FAILS on d4c71ddc: revertEntry's UPDATE guard is only newest seq + nonce, with no workspace_id,
// so an admin's undo lands in the author's personal memory after an unshare races the revert batch.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityFromToken, resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
let companyWs = "";

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  env = sqlite.admitEnv(env);
  const roots = await ensureTenantBootstrap(env);
  companyWs = roots.companyWorkspaceId;
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
});
afterEach(() => sqlite.close());

const seed = (id: string, over: Record<string, unknown> = {}) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, when_at, when_kind, when_label, when_source)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(
  id, over.content ?? "Some fact", JSON.stringify(over.tags ?? []), over.source ?? "api", over.createdAt ?? 1000, over.updatedAt ?? null,
  JSON.stringify(over.vectorIds ?? [id]), over.workspaceId ?? owner.personalWorkspaceId, over.actorId ?? owner.userId,
  over.whenAt ?? null, over.whenKind ?? null, over.whenLabel ?? null, over.whenSource ?? null,
).run();
const live = async (id: string) => (await sqlite.db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;

async function member(name: string, role: "admin" | "member" = "member"): Promise<Identity> {
  const { token } = await createMember(env, { name, role });
  return (await resolveIdentityFromToken(token, env))!;
}

describe("R2-7 (MAJOR): revertEntry writes into the author's personal memory after an unshare", () => {
  it("an admin's undo on Bob's company memory does not land after Bob unshares it", async () => {
    const { revertEntry } = await import("../../src/memory/undo");
    const { DEFAULTS } = await import("../../src/config");
    const { updateEntryContent } = await import("../../src/capture/store");
    const admin = await member("Ada", "admin");
    const author = await member("Bob");
    await seed("u9", { content: "v1 text", workspaceId: companyWs, actorId: author.userId });
    const r = await updateEntryContent(env, "u9", "v2 text", DEFAULTS, undefined, undefined, { workspaceId: companyWs, actorId: author.userId }, { actorId: author.userId, channel: "rest" }, companyWs);
    expect(r.status).toBe("updated");
    const raw = env.DB as any;
    let moved = false;
    const racing = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      if (!moved && sql.startsWith("INSERT INTO entry_versions")) {
        moved = true;
        raw.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', workspace_id = ? WHERE id = 'u9'`).bind(author.personalWorkspaceId).run();
      }
      return raw.prepare(sql);
    } } } as unknown as Env;
    await revertEntry(racing, admin, "u9", { actorId: admin.userId, channel: "rest" }, DEFAULTS, undefined, companyWs);
    const row = await live("u9");
    expect(row.workspace_id).toBe(author.personalWorkspaceId);
    expect(row.content).toBe("v2 text"); // FAILS on d4c71ddc: "v1 text" written into Bob's private memory by the admin
  });
});
