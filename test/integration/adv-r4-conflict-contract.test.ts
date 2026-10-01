/**
 * Adversary round 4 against b35f6b0a (moveEntry pins its UPDATEs; new ShareResult "conflict").
 * Real SQLite (node:sqlite) throughout. Every `// FAILS:` line fails on f85e908e for the reason stated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { req } from "../helpers/make-request";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { moveEntry } from "../../src/capture/share";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
let companyWs = "";
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;
const MOVE_SELECT = /^SELECT id, workspace_id, actor_id, vector_ids, tags FROM entries WHERE id = \? AND/;

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  companyWs = roots.companyWorkspaceId;
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
});
afterEach(() => sqlite.close());

const seed = (id: string, over: Record<string, unknown> = {}) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
   VALUES (?, ?, '[]', ?, 1000, NULL, ?, ?, ?)`,
).bind(
  id, over.content ?? "Some fact", over.source ?? "api", JSON.stringify(over.vectorIds ?? [id]),
  over.workspaceId ?? owner.personalWorkspaceId, over.actorId ?? owner.userId,
).run();
const live = async (id: string) => (await sqlite.db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;

/** Runs `race(id)` right after moveEntry's own scoped read of `id` — the gap before its batch. */
function raceAfterMoveRead(base: Env, race: (id: string) => Promise<void>): Env {
  const raw = base.DB as any;
  return { ...base, DB: { ...raw, prepare(sql: string) {
    const st = raw.prepare(sql);
    if (!MOVE_SELECT.test(sql)) return st;
    return { bind: (...a: unknown[]) => ({ first: async () => {
      const r = await st.bind(...a).first();
      await race(a[0] as string);
      return r;
    } }) };
  } } } as unknown as Env;
}

async function connectNotion(e: Env, itemMap: Record<string, { entryId: string; version: string }>) {
  await e.OAUTH_KV.put("integrations:notion", JSON.stringify({
    provider: "notion", authKind: "token", credentials: { token: "t" }, config: { mirrorWorkspace: "company" },
    status: "connected", workspaceName: "Acme", lastSyncedAt: Date.now(), lastSyncError: null,
    itemMap, createdAt: 0, updatedAt: 0,
  }));
}

describe("R4-C1 (MAJOR): a pinned UPDATE that misses still writes a phantom move event", () => {
  // Root cause: src/capture/share.ts:69-73. The event INSERT's guard is `e.workspace_id <> target`, not
  // `e.workspace_id = row.workspace_id` like the UPDATE at :75-76. The comment at :64-65 claims they "fire
  // exactly" together; they don't when the row moved in the gap to a THIRD workspace. R3-2's own scenario:
  // Bob made his company memory private; Ada's racing unshare 409s, yet a permanent "unshared" event by Ada
  // (workspaceId = Ada's personal, fromWorkspaceId = Bob's personal) lands in Bob's history, the admin
  // activity feed's source, for a move that never happened.
  it("Ada's 409 unshare leaves no event behind", async () => {
    const adaTok = (await createMember(env, { name: "Ada", role: "admin" })).token;
    const ada = (await resolveIdentityFromToken(adaTok, env))!;
    const bobTok = (await createMember(env, { name: "Bob", role: "member" })).token;
    const bob = (await resolveIdentityFromToken(bobTok, env))!;
    await seed("x1", { content: "Bob's note", workspaceId: companyWs, actorId: bob.userId });
    let fired = false;
    const racing = raceAfterMoveRead(env, async () => {
      if (fired) return;
      fired = true;
      await sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'x1'`).bind(bob.personalWorkspaceId).run();
    });
    const res = await worker.fetch(req("POST", "/share", { body: { id: "x1", workspace: "personal" }, token: adaTok }), racing, ctx);
    expect(res.status).toBe(409); // the fix itself holds
    expect((await live("x1")).workspace_id).toBe(bob.personalWorkspaceId);

    const events = (await sqlite.db.prepare(`SELECT actor_id, event, payload FROM entry_events WHERE entry_id = 'x1'`).all()).results as any[];
    // FAILS: [{ actor_id: Ada, event: "unshared", payload: {workspaceId: Ada's personal, fromWorkspaceId: Bob's personal} }]
    expect(events.filter(e => e.actor_id === ada.userId)).toEqual([]);
  });
});

describe("R4-C2 (MINOR): a move that raced to the SAME target reports conflict, not success", () => {
  // Root cause: src/capture/share.ts:83-89. On a miss, the liveness re-read only asks "does the row exist",
  // not "is it already where the caller asked". Before b35f6b0a this case returned success; now REST says 409
  // "changed while saving" (the dashboard's bulk share counts it refused, public/js/recent.js:270), the MCP
  // tool says "try again", and the integration move route counts it `missing` (src/routes/integrations.ts:327-333)
  // — which the dashboard renders as "N missing" or, if nothing else moved, the "nothing left to move" state
  // (public/js/integrations.js:634). Fix: re-read workspace_id on a miss; equal to target → no_change (+vectorIds).
  it("REST /share: two tabs sharing the same memory both get ok", async () => {
    await seed("s1");
    let fired = false;
    const racing = raceAfterMoveRead(env, async () => {
      if (fired) return;
      fired = true;
      const other = await moveEntry("s1", "company", env, owner, { actorId: owner.userId, channel: "rest" }); // the other tab
      expect(other.status).toBe("shared");
    });
    const res = await worker.fetch(req("POST", "/share", { body: { id: "s1", workspace: "company" } }), racing, ctx);
    expect((await live("s1")).workspace_id).toBe(companyWs);
    const body = await res.json() as any;
    expect(res.status).toBe(200); // FAILS: 409 "Entry changed while saving, try again" for a row that is where the user asked
    expect(body.ok).toBe(true);
  });

  it("integration move: an entry another tab already moved to the target is alreadyThere, not missing", async () => {
    await seed("m1", { source: "notion" });
    await seed("m2", { source: "notion" });
    await connectNotion(env, { "page-1": { entryId: "m1", version: "v1" }, "page-2": { entryId: "m2", version: "v1" } });
    const racing = raceAfterMoveRead(env, async (id) => {
      if (id === "m2") await sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'm2'`).bind(companyWs).run();
    });
    const res = await worker.fetch(req("POST", "/integrations/notion/move", { body: {} }), racing, ctx);
    const data = await res.json() as any;
    expect((await live("m2")).workspace_id).toBe(companyWs);
    expect(data.moved).toBe(1);
    expect(data.missing).toBe(0); // FAILS: 1 — a live row in the right layer reported as a stale item-map pointer
    expect(data.alreadyThere).toBe(1);
  });
});

describe("R4-C3 (MINOR): the move route's D1 budget undercounts a conflicting item by two executions", () => {
  // Root cause: src/routes/integrations.ts:303 charges every non-moved result 1 execution, but a conflict (and a
  // not_found reached after a missed batch) now costs 3: the scoped SELECT, the batch, and the liveness SELECT at
  // src/capture/share.ts:88. d1Reserved (:355) is then low by 2 per conflict, so the Vectorize re-stamp loop spends
  // subrequests the route does not have. Fix: have moveEntry report its own execution count (or charge
  // conflict/not_found-after-miss 3 in the switch).
  async function run(conflicts: number) {
    const tally = { d1: 0, vectorize: 0 };
    let counting = false;
    const store = new Map<string, any>();
    const vectorize = makeVectorizeMock({
      upsert: vi.fn(async (vs: any[]) => { if (counting) tally.vectorize++; for (const v of vs) store.set(v.id, v); return { mutationId: "m" }; }) as never,
      getByIds: vi.fn(async (ids: string[]) => { if (counting) tally.vectorize++; return ids.map(i => store.get(i)).filter(Boolean); }) as never,
    });
    const raw = sqlite.db as any;
    const wrap = (stmt: any): any => ({
      bind: (...a: any[]) => wrap(stmt.bind(...a)),
      run: () => { if (counting) tally.d1++; return stmt.run(); },
      first: (...a: any[]) => { if (counting) tally.d1++; return stmt.first(...a); },
      all: () => { if (counting) tally.d1++; return stmt.all(); },
      __inner: stmt,
    });
    const DB = {
      prepare(sql: string) {
        if (!MOVE_SELECT.test(sql)) return wrap(raw.prepare(sql));
        counting = true; // everything from the loop's first moveEntry on is what the route's own budget models
        const st = raw.prepare(sql);
        return { bind: (...a: unknown[]) => ({ first: async () => {
          tally.d1++;
          const r = await st.bind(...a).first();
          const n = Number(String(a[0]).slice(1));
          // The owner's other tab shares the first `conflicts` items in the gap.
          if (n < conflicts) await raw.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(companyWs, a[0]).run();
          return r;
        } }) };
      },
      exec: (sql: string) => raw.exec(sql),
      batch: (stmts: any[]) => { if (counting) tally.d1++; return raw.batch(stmts.map((s: any) => s.__inner ?? s)); },
    };
    const e = { ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN, DB, VECTORIZE: vectorize } as unknown as Env;
    const itemMap: Record<string, { entryId: string; version: string }> = {};
    for (let i = 0; i < 10; i++) {
      const vids = Array.from({ length: 100 }, (_, k) => `e${i}-v${k}`); // 5 getByIds chunks each
      for (const v of vids) store.set(v, { id: v, values: [0.1], metadata: { workspace_id: owner.personalWorkspaceId } });
      await seed(`e${i}`, { source: "notion", vectorIds: vids });
      itemMap[`page-${i}`] = { entryId: `e${i}`, version: "v1" };
    }
    await connectNotion(e, itemMap);
    const res = await worker.fetch(req("POST", "/integrations/notion/move", { body: {} }), e, ctx);
    expect(res.status).toBe(200);
    return tally.d1 + tally.vectorize;
  }

  it("control: no conflicts stays inside the ceiling the route reserves for itself", async () => {
    expect(await run(0)).toBeLessThanOrEqual(49); // 50 minus the roots lookup the route pre-charges
  });

  it("five conflicting items still stay inside it", async () => {
    // FAILS: 56 — 5 conflicts cost 15 D1 executions, the budget charged 5, and the re-stamp loop spent the other 10
    expect(await run(5)).toBeLessThanOrEqual(49);
  });
});
