/**
 * Adversary reproduction ADV-8 (range bb5377f..5c25183, ported from adv/t1-versions@258a932
 * test/integration/adv-t1-versions.test.ts). makeMirrorStore().updateEntry computed its tags from
 * an earlier read with no compare-and-set, so a user's set_status committed mid-sync was silently
 * overwritten by the sync's own stale-tags write.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { saveIntegrationFixture } from "../helpers/integration-record";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { makeMirrorStore } from "../../src/integrations/mirror";
import { loadIntegration } from "../../src/integrations";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
afterEach(() => { sqlite?.close(); vi.unstubAllGlobals(); });

const live = async (env: Env, id: string) => (await env.DB.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;
const versions = async (env: Env, id: string) => (await env.DB.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];

describe("ADV-8: a mirror sync does not revert a concurrent set_status", () => {
  it("the canonical status set during the sync survives it", async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    let env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() })) as Env;
    await initializeDatabase(env);
  env = sqlite.admitEnv(env);
    const roots = await ensureTenantBootstrap(env);
    const writeCtx = { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId };

    const ms = makeMirrorStore(env, writeCtx, undefined, "notion");
    const id = await ms.createEntry("page v1", ["notion"], "notion");

    const raw = env.DB as any;
    let raced = false;
    const racingEnv = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
      if (!raced && sql.startsWith("INSERT INTO entry_versions")) {
        raced = true;
        raw.prepare(`UPDATE entries SET tags = '["notion","status:canonical"]' WHERE id = ?`).bind(id).run();
      }
      return raw.prepare(sql);
    } } } as unknown as Env;
    const racingStore = makeMirrorStore(racingEnv, writeCtx, undefined, "notion");
    const ok = await racingStore.updateEntry(id, "page v2");
    expect(ok).toBe("updated");

    const row = await live(env, id);
    expect(JSON.parse(row.tags)).toContain("status:canonical");
    expect(row.content).toBe("page v2");
    // The retry's snapshot recorded the race's tags as the prior state, not the stale first read.
    const vs = await versions(env, id);
    expect(JSON.parse(vs.at(-1)!.tags)).toContain("status:canonical");
  });

  it("an ordinary sync (no race) still costs one batch", async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    let env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() })) as Env;
    await initializeDatabase(env);
  env = sqlite.admitEnv(env);
    const roots = await ensureTenantBootstrap(env);
    const writeCtx = { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId };
    const ms = makeMirrorStore(env, writeCtx, undefined, "notion");
    const id = await ms.createEntry("page v1", ["notion"], "notion");

    let batches = 0;
    const raw = env.DB as any;
    const countingEnv = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB: { ...raw, batch: (s: unknown[]) => { batches++; return raw.batch(s); } } } as unknown as Env;
    const store = makeMirrorStore(countingEnv, writeCtx, undefined, "notion");
    const ok = await store.updateEntry(id, "page v2");
    expect(ok).toBe("updated");
    expect(batches).toBe(1);
  });
});

describe("round 2 adversary: mirror update compare-and-set exhaustion (ADV-8 fix, 18c6f7e)", () => {
  it("a mirror update that loses its compare-and-set 3 times does not duplicate the memory or orphan the live row", async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    const kv = makeMemoryKV();
    let env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: kv })) as Env;
    await initializeDatabase(env);
  env = sqlite.admitEnv(env);
    const roots = await ensureTenantBootstrap(env);
    const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
    const ctx = { waitUntil: (p: Promise<unknown>) => { p.catch(() => {}); } } as ExecutionContext;
    const post = (path: string, body: unknown) =>
      worker.fetch(new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) }), env, ctx);

    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.endsWith("/users/me")) return ok({ object: "user", type: "bot", name: "SB", bot: { workspace_name: "Acme" } });
      if (url.endsWith("/search")) return ok({ results: [{ object: "page", id: "pg1", last_edited_time: "v2", url: "https://notion.so/pg1", properties: { title: { type: "title", title: [{ plain_text: "Plan" }] } } }], has_more: false, next_cursor: null });
      if (url.includes("/blocks/")) return ok({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "edited in notion" }] } }], has_more: false, next_cursor: null });
      return ok({});
    }));
    await post("/integrations/notion/connect", { token: "t" });
    // versioning: exempt: test fixture seeding a mirrored row directly
    await env.DB.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES ('m1', 'Plan\nold body', '["notion"]', 'notion', 1, 1, '[]', ?, ?)`,
    ).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
    const rec = (await loadIntegration(env, "notion"))!;
    rec.itemMap = { pg1: { entryId: "m1", version: "v1" } };
    await saveIntegrationFixture(env, rec);

    // Someone keeps changing the row's status while the sync writes (each attempt re-reads, then loses).
    const realBatch = env.DB.batch.bind(env.DB);
    let n = 0;
    (env.DB as any).batch = async (stmts: any[]) => {
      // The mirror update batch: snapshot, the guarded UPDATE, prune, mirror prune (the UPDATE itself is wrapped by the FTS guard).
      const sqls = stmts.map((s: any) => String((s?.__inner ?? s)?.sourceSql?.() ?? ""));
      if (sqls.some(q => q.startsWith("UPDATE entries SET content = ?")) && sqls.some(q => q.includes("INSERT INTO entry_versions"))) {
        n++;
        await sqlite.db.prepare(`UPDATE entries SET tags = ? WHERE id = 'm1'`).bind(JSON.stringify(["notion", `status:${n % 2 ? "canonical" : "draft"}`])).run();
      }
      return realBatch(stmts);
    };
    const res = await post("/integrations/notion/sync", {});
    expect(res.status).toBeLessThan(500);
    expect(n).toBe(3);
    // The page must still map to the live row m1, with no second copy of the same page.
    expect((await env.DB.prepare(`SELECT id FROM entries WHERE source = 'notion'`).all()).results!.map((r: any) => r.id)).toEqual(["m1"]);
    expect((await loadIntegration(env, "notion"))!.itemMap.pg1.entryId).toBe("m1");
  });
});
