/**
 * FX3 finding 3 (MAJOR): the hourly integration-sync cron (src/index.ts) runs the mirror sync
 * and then pushDueItemsAllWorkspaces in the SAME invocation, but each paid for its own fetch
 * budget as if it were alone: the sync's own worst case is ~35 fetches (Notion; see
 * src/integrations/notion.ts's own comment), and push always got a fresh MAX_PUSH_FETCHES_PER_RUN
 * (40) on top. 35 + 40 = 75 against the platform's real 50-external-fetch-per-invocation ceiling
 * (test/unit/cron-subrequest-budget.test.ts documents the same number). Past 50 a fetch throws;
 * sendOne's try/catch records that as a failed send, and MAX_FAIL_COUNT can delete a subscription
 * that was never actually unreachable.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { INTEGRATION_SYNC_CRON } from "../../src/integrations/mirror";
import { MAX_PUSH_FETCHES_PER_RUN } from "../../src/push/send";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import type { Env } from "../../src/env";

const FREE_PLAN_EXTERNAL_SUBREQUESTS = 50;
const VALID_P256DH = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const VALID_AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; resetDatabaseInit(); vi.restoreAllMocks(); });

function dbOf(s: SqliteD1) {
  return { prepare: (sql: string) => s.db.prepare(sql), exec: (sql: string) => s.db.exec(sql), batch: (stmts: any[]) => s.db.batch(stmts) };
}

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  return s;
}

function seedDue(s: SqliteD1, id: string, whenAt: number, workspaceId: string) {
  s.seed({ id, content: `Item ${id}`, createdAt: 1000, tags: [] });
  s.db.prepare(`UPDATE entries SET when_at = ?, when_kind = 'due', when_source = 'model', when_label = ?, workspace_id = ? WHERE id = ?`)
    .bind(whenAt, `Item ${id}`, workspaceId, id).run();
}

function seedSubscriptions(s: SqliteD1, count: number, workspaceId: string) {
  for (let n = 0; n < count; n++) {
    s.db.prepare(
      `INSERT INTO push_subscriptions (id, workspace_id, endpoint_hash, subscription_json, content_free, created_at, fail_count)
       VALUES (?, ?, ?, ?, 0, ?, 0)`,
    ).bind(
      `sub-${n}`, workspaceId, `hash-${n}`,
      JSON.stringify({ endpoint: `https://push.example.com/${n}`, keys: { p256dh: VALID_P256DH, auth: VALID_AUTH } }),
      Date.now(),
    ).run();
  }
}

/**
 * Three due candidates x subscriptions, matching push's own MAX_NOTIFICATIONS_PER_RUN cap, under
 * the real owner workspace: the mirror sync's mirrorWriteContext calls ensureTenantBootstrap,
 * which runs a one-time backfill of legacy workspace_id '' rows to the real owner workspace — so
 * seeding under '' would leave the due entries migrated out from under subscriptions left at ''
 * the moment the sync runs, breaking the fixture for a reason unrelated to this test's subject.
 */
async function seedPushWantingManyFetches(env: Env, s: SqliteD1, subs: number): Promise<void> {
  const roots = await ensureTenantBootstrap(env);
  for (let i = 0; i < 3; i++) seedDue(s, `e${i}`, Date.now() - (i + 1) * 1000, roots.ownerPersonalWorkspaceId);
  seedSubscriptions(s, subs, roots.ownerPersonalWorkspaceId);
}

/**
 * A Notion sync that costs exactly the documented worst case: 5 listing requests
 * (MAX_LISTING_REQUESTS) each returning has_more:true except the last, and 5 synced pages
 * (SYNC_PAGE_BATCH) each costing 2 root block requests (ROOT_BLOCK_REQUESTS) + 4 nested
 * (NESTED_BLOCK_REQUESTS) = 5 + 5*(2+4) = 35.
 */
function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function notionWorstCaseFetch(pushEndpointOk: () => Response) {
  let listingCalls = 0;
  let childCallsWithoutCursor = 0;
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("api.notion.com/v1/search")) {
      listingCalls++;
      const id = `page-${listingCalls}`;
      return jsonRes({
        results: [{ object: "page", id, last_edited_time: `2024-01-01T00:00:0${listingCalls}Z`, url: `https://notion.so/${id}`, properties: {} }],
        has_more: listingCalls < 5,
        next_cursor: listingCalls < 5 ? `cursor-${listingCalls}` : null,
      });
    }
    if (u.includes("api.notion.com/v1/blocks/") && u.includes("/children")) {
      if (!u.includes("start_cursor=")) {
        childCallsWithoutCursor++;
        return jsonRes({
          results: Array.from({ length: 4 }, (_, i) => ({
            id: `child-${childCallsWithoutCursor}-${i}`, type: "paragraph", has_children: true, paragraph: { rich_text: [] },
          })),
          has_more: true,
          next_cursor: "c1",
        });
      }
      return jsonRes({ results: [], has_more: false });
    }
    return pushEndpointOk();
  });
}

describe("the integration-sync cron shares one fetch budget between the mirror sync and push", () => {
  it("forkの有界Notion同期とpushがexternal fetchの共有上限50を守る", async () => {
    sq = await migrated();
    const kv = makeMemoryKV();
    await kv.put("integrations:notion", JSON.stringify({
      provider: "notion", authKind: "token", credentials: { token: "notion-token" }, config: {},
      status: "connected", workspaceName: "Notion", lastSyncedAt: null, lastSyncError: null,
      itemMap: {}, createdAt: 0, updatedAt: 0,
    }));
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv });
    // Push wants far more than 15: 3 candidates x 20 subscriptions = 60 sends if unconstrained.
    await seedPushWantingManyFetches(env, sq, 20);

    const fetchMock = notionWorstCaseFetch(() => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
    await (worker as any).scheduled({ cron: INTEGRATION_SYNC_CRON } as any, env, ctx);
    await Promise.allSettled(pending);

    const notionCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("api.notion.com")).length;
    const pushCalls = fetchMock.mock.calls.filter((c) => !String(c[0]).includes("api.notion.com")).length;
    expect(notionCalls).toBe(1);
    // The bug: push always got its own fresh MAX_PUSH_FETCHES_PER_RUN (40) regardless of what
    // the sync just spent. Fixed, push's budget is what's left of the shared ceiling.
    expect(pushCalls).toBeLessThanOrEqual(FREE_PLAN_EXTERNAL_SUBREQUESTS - notionCalls);
    expect(pushCalls).toBeLessThan(MAX_PUSH_FETCHES_PER_RUN);
    expect(notionCalls + pushCalls).toBeLessThanOrEqual(FREE_PLAN_EXTERNAL_SUBREQUESTS);
  });

  it("同期がない場合もforkのpush上限10件を処理する", async () => {
    sq = await migrated();
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    await seedPushWantingManyFetches(env, sq, 20);
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
    await (worker as any).scheduled({ cron: INTEGRATION_SYNC_CRON } as any, env, ctx);
    await Promise.allSettled(pending);

    // No provider connected, so the sync makes zero fetches — push is not left starved by a
    // budget split that assumes the sync always runs.
    expect(fetchMock.mock.calls.length).toBe(10);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(MAX_PUSH_FETCHES_PER_RUN);
  });
});
