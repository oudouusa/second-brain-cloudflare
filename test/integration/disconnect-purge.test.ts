import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { loadIntegration, saveIntegration } from "../../src/integrations";
import { makeMirrorStore, runScheduledIntegrationSync } from "../../src/integrations/mirror";
import { trashMirroredEntries } from "../../src/memory/trash";
import { createMember } from "../../src/lib/team-admin";
import { INTEGRATION_PURGE_PAGE_SIZE } from "../../src/routes/integrations";
import type { Identity } from "../../src/lib/identity";

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };

let t: TrashEnv;
let fetchSpy: ReturnType<typeof vi.fn>;
afterEach(async () => { await Promise.allSettled(pending.splice(0)); t?.close(); vi.unstubAllGlobals(); });

async function connected(n: number, opts: { workspaceId?: string; actorId?: string } = {}) {
  fetchSpy = vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.endsWith("/users/me")) return new Response(JSON.stringify({ object: "user", type: "bot", name: "SB", bot: { workspace_name: "Acme" } }), { status: 200 });
    return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchSpy);
  t = await makeTrashEnv();
  await worker.fetch(new Request("http://localhost/integrations/notion/connect", { method: "POST", headers, body: JSON.stringify({ token: "t" }) }), t.env, ctx);
  await t.sqlite.db.exec(`
    WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${n - 1})
    INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, write_marker)
    SELECT 'p' || printf('%05d', i), 'page ' || i, '["notion"]', 'notion', 1000, 1000, '[]', '${opts.workspaceId ?? t.roots.ownerPersonalWorkspaceId}', '${opts.actorId ?? t.roots.ownerUserId}', '${t.sqlite.fixtureMarker()}' FROM n`);
  const rec = (await loadIntegration(t.env, "notion"))!;
  rec.itemMap = Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${String(i).padStart(5, "0")}`, { entryId: `p${String(i).padStart(5, "0")}`, version: "v1" } as any]));
  await saveIntegration(t.env, rec);
}
const disconnect = (body: Record<string, unknown> = { purge: true }) =>
  worker.fetch(new Request("http://localhost/integrations/notion/disconnect", { method: "POST", headers, body: JSON.stringify(body) }), t.env, ctx);
const count = async (sql: string) => ((await t.one<any>(sql))!.n as number);

describe("disconnect purge through the trash", () => {
  it("forkの1件ページで5件を削除し、6回目の完了応答で接続を除去する", async () => {
    await connected(5);
    let cursor: string | undefined;
    const calls: any[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await disconnect(cursor ? { purge: true, cursor } : { purge: true });
      calls.push({ status: res.status, body: await res.json() });
      if (calls[i].body.done) break;
      cursor = calls[i].body.next_cursor;
    }
    expect(calls.map((c) => c.status)).toEqual([202, 202, 202, 202, 202, 200]);
    expect(calls.slice(0, 5).every((c) => c.body.done === false && typeof c.body.next_cursor === "string")).toBe(true);
    expect(calls[5].body).toMatchObject({ ok: true, done: true, purged: 5, kept: 0 });
    expect(await count(`SELECT COUNT(*) n FROM entries WHERE source = 'notion'`)).toBe(0);
    expect(await count(`SELECT COUNT(*) n FROM entries_trash WHERE reason = 'disconnect'`)).toBe(5);
    expect(await loadIntegration(t.env, "notion")).toBeNull();
    await Promise.all(pending);
    expect(await count(`SELECT COUNT(*) n FROM admin_events WHERE event = 'integration_disconnected'`)).toBe(1);
    // Nothing is left to sync into or out of the connection, and the call sizes stay bounded.
    expect(INTEGRATION_PURGE_PAGE_SIZE).toBe(1);
  });

  it("1000件の接続でも最初のroute呼出しは1件だけをtrashへ移す", async () => {
    await connected(1000);
    expect(await (await disconnect()).json()).toMatchObject({ done: false, purged: 1, skipped: 0, next_cursor: "k00000" });
    expect(await count(`SELECT COUNT(*) n FROM entries WHERE source = 'notion'`)).toBe(999);
    expect(await count(`SELECT COUNT(*) n FROM entries_trash WHERE reason = 'disconnect'`)).toBe(1);
  });

  it("marks the record disconnecting on the first call and only the last call removes it", async () => {
    await connected(2);
    const first = await disconnect();
    expect(first.status).toBe(202);
    const rec = (await loadIntegration(t.env, "notion"))!;
    // MOVED (round 2 adversary): disconnecting now also remembers nextCursor (and fromCursor, once
    // a page arrives with one), so a repeated call can return the same answer instead of reprocessing.
    expect(rec.disconnecting).toEqual({ purged: 1, skipped: 0, nextCursor: "k00000" });
    expect(await count(`SELECT COUNT(*) n FROM admin_events WHERE event = 'integration_disconnected'`)).toBe(0);
  });

  it("counts rows the caller cannot mutate, or that no longer exist, as skipped and never touches them", async () => {
    await connected(5);
    const { member } = await createMember(t.env, { name: "Ada" });
    // p00001 lives in another member's personal workspace; p00003 is gone already.
    await t.sqlite.db.prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'p00001'`).bind(member.personalWorkspaceId, member.userId).run();
    await t.sqlite.deleteFixtureRows(`DELETE FROM entries WHERE id = 'p00003'`);
    let body = await (await disconnect()).json() as any;
    for (let i = 1; !body.done && i < 6; i++) body = await (await disconnect({ purge: true, cursor: body.next_cursor })).json();
    expect(body).toMatchObject({ done: true, purged: 3, kept: 2 });
    expect(await t.one(`SELECT id FROM entries WHERE id = 'p00001'`)).not.toBeNull();
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'p00001'`)).toBeNull();
  });

  it("a scheduled or manual sync skips a record marked disconnecting", async () => {
    await connected(2);
    expect((await disconnect()).status).toBe(202);
    fetchSpy.mockClear();
    await runScheduledIntegrationSync(t.env);
    expect(fetchSpy).not.toHaveBeenCalled();
    const manual = await worker.fetch(new Request("http://localhost/integrations/notion/sync", { method: "POST", headers }), t.env, ctx);
    expect(manual.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tier-2 and tier-3 memories in a chunk take the no-edges and hard-delete paths in the same batch", async () => {
    await connected(3);
    await t.sqlite.db.prepare(`UPDATE entries SET content = ? WHERE id = 'p00002'`).bind("x".repeat(20_000)).run();
    for (let i = 0; i < 200; i++) { t.seed(`far${i}`); t.edge(`e${i}`, `far${i}`, "p00001"); }
    t.seed("far");
    t.edge("edge0", "p00000", "far");
    t.version("p00002", 1);
    const batches: number[] = [];
    const real = t.sqlite.db.batch.bind(t.sqlite.db);
    (t.sqlite.db as any).batch = (s: unknown[]) => { batches.push(s.length); return real(s as any); };
    const owner = { userId: t.roots.ownerUserId, role: "admin", personalWorkspaceId: t.roots.ownerPersonalWorkspaceId, companyWorkspaceIds: [t.roots.companyWorkspaceId] } as unknown as Identity;
    const res = await trashMirroredEntries(t.env, owner, ["p00000", "p00001", "p00002"], { provider: "notion", budget: 10_000 });
    expect(res).toEqual({ purged: 3, skipped: 0 });
    // trash tier 1 + trash tier 2 + version delete (tier 3) + edges + entries = 5 statements, then one audit batch.
    // MOVED 5 -> 9 (T-0089.2.4): the D-RET restore hook's four statements ride in the same batch (still one execution).
    // forkでは親行・履歴・辺への削除capability 6文も同じbatchに含める。
    expect(batches[0]).toBe(16);
    expect((await t.one<any>(`SELECT edges_json FROM entries_trash WHERE id = 'p00000'`))!.edges_json).not.toBe("[]");
    expect((await t.one<any>(`SELECT edges_json FROM entries_trash WHERE id = 'p00001'`))!.edges_json).toBe("[]");
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'p00002'`)).toBeNull();
    expect(await count(`SELECT COUNT(*) n FROM entry_versions WHERE entry_id = 'p00002'`)).toBe(0);
    await Promise.all(pending);
    const ev = (await t.all<any>(`SELECT entry_id, payload FROM entry_events WHERE event = 'deleted' ORDER BY entry_id`)).map((e) => [e.entry_id, JSON.parse(e.payload)]);
    expect(ev.map((e) => e[0])).toEqual(["p00000", "p00001", "p00002"]);
    expect(ev[1][1]).toMatchObject({ trash: true, edgesDropped: true, reason: "disconnect" });
    // p00002 is tier 3: its own "deleted" event is the minimal life-end marker written in-batch,
    // not the richer fire-and-forget one -- no deletedVectors, no tooLargeForTrash.
    expect(ev[2][1]).toEqual({ reason: "disconnect", trash: false, channel: "rest" });
  });

  it("every trashed memory has a deleted audit row written through the chunked writer", async () => {
    await connected(120);
    const sizes: number[] = [];
    const real = t.sqlite.db.batch.bind(t.sqlite.db);
    (t.sqlite.db as any).batch = (s: unknown[]) => { sizes.push(s.length); return real(s as any); };
    const owner = { userId: t.roots.ownerUserId, role: "admin", personalWorkspaceId: t.roots.ownerPersonalWorkspaceId, companyWorkspaceIds: [t.roots.companyWorkspaceId] } as unknown as Identity;
    await trashMirroredEntries(t.env, owner, Array.from({ length: 120 }, (_, i) => `p${String(i).padStart(5, "0")}`), { provider: "notion", budget: 10_000 }, ctx);
    expect(await count(`SELECT COUNT(*) n FROM entry_events WHERE event = 'deleted'`)).toBe(120);
    expect(sizes.filter((n) => n >= 20)).toEqual([50, 50, 20]);
  });

  it("an interrupted purge resumes from next_cursor with nothing trashed twice", async () => {
    await connected(3);
    const first = await (await disconnect()).json() as any;
    const second = await (await disconnect({ purge: true, cursor: first.next_cursor })).json() as any;
    // 応答が失われた同じcursorの再試行は、件数を増やさず同じcheckpointを返す。
    const repeat = await (await disconnect({ purge: true, cursor: first.next_cursor })).json() as any;
    expect(repeat).toMatchObject({ done: false, next_cursor: second.next_cursor });
    const finalPage = await (await disconnect({ purge: true, cursor: repeat.next_cursor })).json() as any;
    expect(finalPage).toMatchObject({ done: false, purged: 3 });
    const last = await (await disconnect({ purge: true, cursor: finalPage.next_cursor })).json() as any;
    expect(last).toMatchObject({ done: true });
    expect(await count(`SELECT COUNT(*) n FROM entries_trash WHERE reason = 'disconnect'`)).toBe(3);
    expect(await count(`SELECT COUNT(DISTINCT entry_id) n FROM entry_events WHERE event = 'deleted'`)).toBe(3);
    expect(await count(`SELECT COUNT(*) n FROM entry_events WHERE event = 'deleted'`)).toBe(3);
  });

  it("rejects a cursor that is not a string", async () => {
    await connected(2);
    const res = await disconnect({ purge: true, cursor: 5 });
    expect(res.status).toBe(400);
  });

  it("a disconnect without purge keeps every memory and removes the connection in one call", async () => {
    await connected(3);
    const body = await (await disconnect({})).json() as any;
    expect(body).toMatchObject({ ok: true, done: true, purged: 0, kept: 3 });
    expect(await count(`SELECT COUNT(*) n FROM entries WHERE source = 'notion'`)).toBe(3);
  });
});

describe("adversary (MINOR): a restart without a cursor must not misreport kept (ADV-trash-9)", () => {
  it("a repeated page does not report trashed memories as kept", async () => {
    await connected(2);
    const first = await (await disconnect()).json() as any;
    expect(first.done).toBe(false);
    // The dashboard reloads mid-purge and starts over without a cursor.
    const again = await (await disconnect()).json() as any;
    const finalPage = await (await disconnect({ purge: true, cursor: again.next_cursor })).json() as any;
    const last = await (await disconnect({ purge: true, cursor: finalPage.next_cursor })).json() as any;
    expect(last.done).toBe(true);
    expect(await count(`SELECT COUNT(*) n FROM entries WHERE source = 'notion'`)).toBe(0);
    // Every memory went to the trash, so none was kept.
    expect(last).toMatchObject({ purged: 2, kept: 0 });
  });
});

describe("adversary round 2: a repeated page (lost response) must not double-count purged", () => {
  it("a page repeated with the same cursor is not counted purged twice", async () => {
    await connected(3);
    const first = await (await disconnect()).json() as any;
    await disconnect({ purge: true, cursor: first.next_cursor }); // response lost
    const repeat = await (await disconnect({ purge: true, cursor: first.next_cursor })).json() as any;
    const finalPage = await (await disconnect({ purge: true, cursor: repeat.next_cursor })).json() as any;
    const last = await (await disconnect({ purge: true, cursor: finalPage.next_cursor })).json() as any;
    expect(last.done).toBe(true);
    expect(await t.one<any>(`SELECT COUNT(*) n FROM entries_trash WHERE reason = 'disconnect'`)).toMatchObject({ n: 3 });
    expect(last).toMatchObject({ purged: 3, kept: 0 });
  });
});

describe("T-0089.7.5 latent: a sync running when a disconnect purge starts", () => {
  it("a create that begins after the purge has already set disconnecting mid-batch is refused, not orphaned", async () => {
    // A big enough itemMap that `disconnecting` stays true across the sync's own batch, the same
    // way a real one does across a multi-page purge (connected() alone, with its always-empty
    // /search response, would let the purge finish before the sync could ever race it).
    await connected(250);
    fetchSpy.mockImplementation(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/users/me")) return new Response(JSON.stringify({ object: "user", type: "bot", name: "SB", bot: { workspace_name: "Acme" } }), { status: 200 });
      if (url.endsWith("/search")) return new Response(JSON.stringify({
        results: [
          { object: "page", id: "new1", last_edited_time: "v1", url: "https://notion.so/new1", properties: { title: { type: "title", title: [{ plain_text: "New One" }] } } },
          { object: "page", id: "new2", last_edited_time: "v1", url: "https://notion.so/new2", properties: { title: { type: "title", title: [{ plain_text: "New Two" }] } } },
        ], has_more: false, next_cursor: null,
      }), { status: 200 });
      return new Response(JSON.stringify({ results: [], has_more: false }), { status: 200 });
    });

    // The sync's own outer check (routes/integrations.ts) already passed before this runs — this
    // simulates a disconnect purge's FIRST page landing while the sync is already mid-batch, the
    // exact interleaving that outer check cannot see.
    const { updateIntegration } = await import("../../src/integrations");
    const realPrepare = t.env.DB.prepare.bind(t.env.DB);
    let intercepted = false;
    (t.env.DB as any).prepare = (sql: string) => {
      const stmt = realPrepare(sql);
      if (!intercepted && sql.startsWith(
        "INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, importance_score, workspace_id, actor_id, write_marker)",
      )) {
        intercepted = true;
        const bind = stmt.bind.bind(stmt);
        (stmt as any).bind = (...args: unknown[]) => {
          const bound = bind(...args);
          const run = bound.run.bind(bound);
          (bound as any).run = async () => {
            // This first create lands: it began before disconnecting was set, the residual this
            // fix narrows to rather than closes (documented on the board item).
            const result = await run();
            await updateIntegration(t.env, "notion", (r) => { r.disconnecting = { purged: 0, skipped: 0 }; });
            return result;
          };
          return bound;
        };
      }
      return stmt;
    };

    const store = makeMirrorStore(t.env, { workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId }, undefined, "notion");
    await store.createEntry("New One", ["notion"], "notion");
    expect(intercepted).toBe(true);
    await expect(store.createEntry("New Two", ["notion"], "notion")).rejects.toThrow("being disconnected");
    const titles = (await t.all<any>(`SELECT content FROM entries WHERE content LIKE '%New One%' OR content LIKE '%New Two%'`)).map((r) => r.content);
    expect(titles.some((c) => c.includes("New One"))).toBe(true);
    expect(titles.some((c) => c.includes("New Two"))).toBe(false);
  });
});
