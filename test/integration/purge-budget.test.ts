/**
 * QA measurement: D1 calls issued by one POST /integrations/notion/disconnect that purges 200
 * mirrored rows. A batch is one call (the sqlite double records it as "BATCH").
 * MOVED 807 -> 18 -> 19 (T-0089.4.9): measured 2026-09-26 at 3e978d0, the per-row loop made 807 D1 calls (4 per purged
 * row: read, read vectors, DELETE entry, DELETE edges) plus 4 audit batches. The purge now goes through the trash in
 * chunks of 50: per chunk one scoped read, one trash batch, one landed-ids read (D1's `changes` on a DELETE FROM
 * entries folds in every FTS/entry_counts trigger row it fired, so what actually landed is read back rather than
 * counted) and one audit batch (16), plus identity resolution (2) and one already-trashed pre-filter read per PAGE
 * (18 -> 19, ADV-trash-9: a restart without a cursor must count its own already-purged ids as purged, not skipped).
 * One call, at most 50.
 */
import { describe, it, expect, vi } from "vitest";
import { saveIntegrationFixture } from "../helpers/integration-record";
import worker from "../../src/index";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { loadIntegration } from "../../src/integrations";
import type { Env } from "../../src/env";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const auth = { "Content-Type": "application/json", Authorization: "Bearer test-token" };

describe("disconnect purge D1 calls", () => {
  it("200件をcursorで処理し、全ページが50 D1呼び出し以内でdisconnect履歴を保存する", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/users/me")) return new Response(JSON.stringify({ object: "user", type: "bot", name: "SB", bot: { workspace_name: "Acme" } }), { status: 200 });
      return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: 200 });
    }));
    resetDatabaseInit();
    const sqlite = makeSqliteD1();
    const sizes: number[] = [];
    const db = sqlite.db as any;
    const real = db.batch.bind(db);
    db.batch = (s: unknown[]) => { sizes.push(s.length); return real(s); };
    const env = makeTestEnv(undefined, { DB: db, OAUTH_KV: makeMemoryKV() }) as Env;
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    await worker.fetch(new Request("http://localhost/integrations/notion/connect", { method: "POST", headers: auth, body: JSON.stringify({ token: "t" }) }), env, ctx);
    for (let i = 0; i < 200; i++) {
      sqlite.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, '["notion"]', 'notion', 1000, 1000, '[]', ?, ?)`)
        .bind(`p${i}`, `page ${i}`, roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
    }
    const rec = (await loadIntegration(env, "notion"))!;
    rec.itemMap = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, { entryId: `p${i}`, version: "v1" } as any]));
    await saveIntegrationFixture(sqlite.admitEnv(env), rec);

    let cursor: string | undefined;
    let result: any;
    let pages = 0;
    do {
      sqlite.executions.length = 0; sizes.length = 0;
      const res = await worker.fetch(new Request("http://localhost/integrations/notion/disconnect", {
        method: "POST", headers: auth, body: JSON.stringify({ purge: true, ...(cursor === undefined ? {} : { cursor }) }),
      }), env, ctx);
      result = await res.json();
      expect(result.ok).toBe(true);
      expect(sqlite.executions.length).toBeLessThanOrEqual(50);
      expect(sizes.every(n => n <= 50)).toBe(true);
      cursor = result.next_cursor;
      expect(++pages).toBeLessThanOrEqual(201);
    } while (!result.done);
    expect(result).toMatchObject({ purged: 200, done: true });
    expect(pages).toBe(201);
    const auditInserts = ((await env.DB.prepare(`SELECT COUNT(*) n FROM entry_events WHERE event='deleted'`).first()) as any).n;
    expect(auditInserts).toBe(200);
    const trashed = ((await env.DB.prepare(`SELECT COUNT(*) n FROM entries_trash WHERE reason = 'disconnect'`).first()) as any).n;
    expect(trashed).toBe(200);
    sqlite.close(); vi.unstubAllGlobals();
  });
});
