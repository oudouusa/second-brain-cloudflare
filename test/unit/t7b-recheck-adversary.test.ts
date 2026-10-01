import { afterEach, describe, expect, it, vi } from "vitest";
import { pushDueItems, pushDueItemsAllWorkspaces, sendTestNotification } from "../../src/push/send";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { calibrationQuery, decisionsActionable } from "../../src/decisions/queries";
import { scopeWhere } from "../../src/lib/scope";
import { computeReviewAt } from "../../src/decisions/capture";
import { zonedTimeMs } from "../../src/when/timezone";
import type { Identity } from "../../src/lib/identity";
import type { Config } from "../../src/config";
import type { Env } from "../../src/env";

vi.mock("../../src/push/crypto", () => ({ encryptWebPush: vi.fn(async () => ({ body: new Uint8Array([1]) })) }));
vi.mock("../../src/push/vapid", () => ({ vapidAuthHeader: vi.fn(async () => "test") }));

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; resetDatabaseInit(); vi.restoreAllMocks(); });

function dbOf(s: SqliteD1) {
  return { prepare: (sql: string) => s.db.prepare(sql), exec: (sql: string) => s.db.exec(sql), batch: (stmts: any[]) => s.db.batch(stmts) };
}

async function migrated() {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  return s;
}

function seedDue(s: SqliteD1, id: string, workspaceId = "", whenAt = Date.now() - 60_000) {
  s.seed({ id, content: id, createdAt: 1, tags: ["task"] });
  s.db.prepare("UPDATE entries SET workspace_id = ?, when_at = ?, when_kind = 'due', when_source = 'explicit' WHERE id = ?")
    .bind(workspaceId, whenAt, id).run();
}

function seedSub(s: SqliteD1, id: string, workspaceId = "", failCount = 0) {
  s.db.prepare(`INSERT INTO push_subscriptions
    (id, workspace_id, endpoint_hash, subscription_json, content_free, created_at, fail_count)
    VALUES (?, ?, ?, ?, 0, ?, ?)`).bind(
      id, workspaceId, id,
      JSON.stringify({ endpoint: `https://push.example/${id}`, keys: { p256dh: "AA", auth: "AA" } }),
      Date.now(), failCount,
    ).run();
}

const cfg = { TIMEZONE: "UTC" } as Config;

describe("Track 7 lane B budget adversary", () => {
  it("eventually reaches subscription 41 when one due item has 41 subscriptions", async () => {
    sq = await migrated();
    seedDue(sq, "due");
    for (let i = 0; i < 41; i++) seedSub(sq, `sub-${i}`);
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    await pushDueItems(env, "", cfg);
    await pushDueItems(env, "", cfg);

    expect(fetchSpy.mock.calls.map(([url]) => url)).toContain("https://push.example/sub-40");
  });

  it("eventually reaches workspace 41 when 41 workspaces each have two subscriptions", async () => {
    sq = await migrated();
    for (let i = 0; i < 41; i++) {
      const ws = `ws-${String(i).padStart(2, "0")}`;
      seedDue(sq, `due-${ws}`, ws);
      seedSub(sq, `${ws}-sub-0`, ws);
      seedSub(sq, `${ws}-sub-1`, ws);
    }
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    // forkは1回4workspace。11回で41workspaceを一巡し、重複送信もしない。
    for (let i = 0; i < Math.ceil(41 / 4); i++) await pushDueItemsAllWorkspaces(env, cfg);
    expect(fetchSpy).toHaveBeenCalledTimes(82);

    expect(fetchSpy.mock.calls.map(([url]) => url)).toContain("https://push.example/ws-40-sub-0");
  });

  it("deletes a subscription after its fifth consecutive failed send, even within one run", async () => {
    sq = await migrated();
    seedDue(sq, "due-0", "", Date.now() - 180_000);
    seedDue(sq, "due-1", "", Date.now() - 120_000);
    seedDue(sq, "due-2", "", Date.now() - 60_000);
    seedSub(sq, "sub", "", 3);
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));

    await pushDueItems(env, "", cfg);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const row = await sq.db.prepare("SELECT fail_count FROM push_subscriptions WHERE id = 'sub'").first();
    expect(row).toBeNull();
  });

  it("caps the test-notification endpoint under the external-fetch limit", async () => {
    sq = await migrated();
    for (let i = 0; i < 51; i++) seedSub(sq, `sub-${i}`);
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    await sendTestNotification(env, "");

    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(50);
  });

  it("keeps D1 subrequests within 1000 when the cron scans 500 subscribed workspaces", async () => {
    let d1Calls = 0;
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return { all: async () => {
              d1Calls++;
              if (sql.includes("FROM entries")) return { results: [{
                id: `due-${args[1]}`, content: "due", when_at: Date.now() - 60_000,
                when_label: "due", tags: '["task"]',
              }] };
              return { results: [{
                id: `sub-${args[0]}`, endpoint_hash: `hash-${args[0]}`, content_free: 0,
                fail_count: 0, subscription_json: JSON.stringify({
                  endpoint: `https://push.example/${args[0]}`, keys: { p256dh: "AA", auth: "AA" },
                }),
              }] };
            } };
          },
          async all() {
            d1Calls++;
            return { results: Array.from({ length: 500 }, (_, i) => ({ workspace_id: `ws-${i}` })) };
          },
        };
      },
      async batch() { d1Calls++; return []; },
    };
    const env = makeTestEnv(db as any, { OAUTH_KV: makeMemoryKV() });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    await pushDueItemsAllWorkspaces(env, cfg);

    expect(d1Calls).toBeLessThanOrEqual(1000);
  });

  it("keeps a 99-team json_each read scoped to the caller's own decisions", async () => {
    sq = makeSqliteD1();
    const auth: Identity = {
      userId: "u1", role: "member", personalWorkspaceId: "personal", defaultShare: "",
      companyWorkspaceIds: Array.from({ length: 99 }, (_, i) => `team-${i}`),
    };
    for (const [id, workspace, actor] of [
      ["mine", "team-98", "u1"], ["teammate", "team-98", "u2"], ["outsider", "other-team", "u1"],
    ]) {
      sq.seed({ id, content: id, createdAt: 1, tags: ["ledger:decision", "confidence:0.70", "outcome:right"] });
      sq.db.prepare("UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = ?").bind(workspace, actor, id).run();
    }
    const query = calibrationQuery(scopeWhere(auth), decisionsActionable(auth));
    expect(query.bindings).toHaveLength(3);
    const rows = (await sq.db.prepare(query.sql).bind(...query.bindings).all()).results;
    expect(rows).toHaveLength(1);
  });

  it("anchors calendar days across fall DST and leap day at 09:00 local", () => {
    expect(computeReviewAt({
      now: zonedTimeMs(2026, 9, 31, 23, 30, 0, "America/New_York"),
      timezone: "America/New_York", days: 2,
    })).toEqual({ at: zonedTimeMs(2026, 10, 2, 9, 0, 0, "America/New_York") });
    expect(computeReviewAt({
      now: zonedTimeMs(2028, 1, 28, 23, 30, 0, "Europe/Rome"),
      timezone: "Europe/Rome", days: 2,
    })).toEqual({ at: zonedTimeMs(2028, 2, 1, 9, 0, 0, "Europe/Rome") });
  });
});
