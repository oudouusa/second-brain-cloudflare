/**
 * pushDueItems (src/push/send.ts): the sender the hourly cron and POST
 * /push/run both drive. Real SQLite because DUE_SQL is a real WHERE clause,
 * and a fetch mock in place of the actual push service so the encryption
 * path runs for real (RFC 8291 correctness is test/unit/push-crypto.test.ts's
 * job; this file is about which rows get sent, to whom, and how failure is
 * handled).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { pushDueItems, pushDueItemsAllWorkspaces, sendTestNotification } from "../../src/push/send";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";

const DAY = 24 * 60 * 60 * 1000;

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

function seedDue(s: SqliteD1, id: string, content: string, whenAt: number, label: string | null = null) {
  s.seed({ id, content, createdAt: 1000, tags: [] });
  s.db.prepare(`UPDATE entries SET when_at = ?, when_kind = 'due', when_source = 'model', when_label = ? WHERE id = ?`)
    .bind(whenAt, label, id).run();
}

function seedSubscription(s: SqliteD1, id: string, workspaceId: string, endpoint: string, contentFree = false) {
  s.db.prepare(
    `INSERT INTO push_subscriptions (id, workspace_id, endpoint_hash, subscription_json, content_free, created_at, fail_count)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  ).bind(
    id, workspaceId, `hash-${id}`,
    JSON.stringify({ endpoint, keys: { p256dh: VALID_P256DH, auth: VALID_AUTH } }),
    contentFree ? 1 : 0, Date.now(),
  ).run();
}

// A real 65-byte uncompressed P-256 point and a real 16-byte auth secret
// (RFC 8291 Appendix A's user-agent key), so encryptWebPush has valid input
// to work with — this file is not re-testing the crypto, just that it runs.
const VALID_P256DH = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const VALID_AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

function mockFetchAlways(status: number) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
}

describe("pushDueItems", () => {
  it("does nothing when there are no subscriptions", async () => {
    sq = await migrated();
    seedDue(sq, "e1", "File the report", Date.now() - DAY);
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = mockFetchAlways(201);

    const result = await pushDueItems(env, "");

    expect(result.sent).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends an encrypted push to each subscription for a due item", async () => {
    sq = await migrated();
    seedDue(sq, "e1", "File the report", Date.now() - DAY, "File the report");
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = mockFetchAlways(201);

    const result = await pushDueItems(env, "");

    expect(result.sent).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://push.example.com/s1");
    expect((init as RequestInit).headers).toMatchObject({ "Content-Encoding": "aes128gcm" });
  });

  it("does not push a task that is already done", async () => {
    sq = await migrated();
    seedDue(sq, "done-1", "Send the invoice", Date.now() - DAY, "Send the invoice");
    sq.db.prepare(`UPDATE entries SET tags = '["task","task:done"]' WHERE id = 'done-1'`).run();
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = mockFetchAlways(201);

    const result = await pushDueItems(env, "");

    expect(result.sent).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends TTL and Urgency headers on every push POST — Apple's push service requires TTL", async () => {
    sq = await migrated();
    seedDue(sq, "e1", "File the report", Date.now() - DAY, "File the report");
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = mockFetchAlways(201);

    await pushDueItems(env, "");

    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ TTL: "3600", Urgency: "normal" });
  });

  it("gives a content_free subscription a fixed title and no entry content", async () => {
    sq = await migrated();
    seedDue(sq, "e1", "Secret project details", Date.now() - DAY, "Secret project details");
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1", true);
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });

    let capturedBody: ArrayBuffer | undefined;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));
    // Payload is encrypted, so assert via the plaintext seam instead of decrypting.
    const cryptoModule = await import("../../src/push/crypto");
    const encryptSpy = vi.spyOn(cryptoModule, "encryptWebPush");

    await pushDueItems(env, "");

    expect(encryptSpy).toHaveBeenCalledTimes(1);
    const plaintext = new TextDecoder().decode(encryptSpy.mock.calls[0][0].plaintext);
    const payload = JSON.parse(plaintext);
    expect(payload.title).toBe("Something is due. Tap to see it.");
    expect(payload.body).toBeUndefined();
    expect(payload.entry_id).toBeUndefined();
  });

  it("puts the configured-timezone calendar date in the notification body (UTC default), not the server's local date", async () => {
    // The Worker has no browser locale and no per-request local time worth
    // trusting — it formats in config.TIMEZONE ("UTC" for a brain that never
    // sets it) via Intl, never the server runtime's own local time. The due
    // sheet (public/js/due.js) reads the same when_at with ordinary local
    // formatting, which agrees once when_at is anchored in that same zone
    // (src/when/timezone.ts) — this test's job is only the sender's half.
    const originalTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      sq = await migrated();
      // Safely in the past regardless of when this test runs.
      const midnightUtc = Date.UTC(2020, 8, 22); // 2020-09-22T00:00:00.000Z
      seedDue(sq, "e1", "File the report", midnightUtc, "File the report");
      seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
      const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));
      const cryptoModule = await import("../../src/push/crypto");
      const encryptSpy = vi.spyOn(cryptoModule, "encryptWebPush");

      await pushDueItems(env, "");

      const plaintext = new TextDecoder().decode(encryptSpy.mock.calls[0][0].plaintext);
      const payload = JSON.parse(plaintext);
      expect(payload.body).toContain("Sep 22, 2020");
      expect(payload.body).not.toContain("Sep 21");
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it("formats the notification body's date in a configured non-UTC TIMEZONE", async () => {
    sq = await migrated();
    // Midnight Eastern (EDT, UTC-4) on 2020-09-23 is 2020-09-23T04:00:00Z —
    // a UTC read of that instant would (wrongly) say "2020-09-23" too, so
    // this uses a time where UTC and Eastern disagree on the calendar day.
    const midnightEastern = Date.UTC(2020, 8, 23, 4);
    seedDue(sq, "e1", "File the report", midnightEastern, "File the report");
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
    const kv = makeMemoryKV();
    await kv.put("config:overrides", JSON.stringify({ TIMEZONE: "America/New_York" }));
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));
    const cryptoModule = await import("../../src/push/crypto");
    const encryptSpy = vi.spyOn(cryptoModule, "encryptWebPush");

    await pushDueItems(env, "");

    const plaintext = new TextDecoder().decode(encryptSpy.mock.calls[0][0].plaintext);
    const payload = JSON.parse(plaintext);
    expect(payload.body).toContain("Sep 23, 2020");
  });

  it("does not re-notify for the same when_at once pushed", async () => {
    sq = await migrated();
    seedDue(sq, "e1", "File the report", Date.now() - DAY);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    mockFetchAlways(201);

    const first = await pushDueItems(env, "");
    expect(first.sent).toBe(1);

    const second = await pushDueItems(env, "");
    expect(second.sent).toBe(0);
  });

  it("re-notifies once when_at changes (a snooze to a new date)", async () => {
    sq = await migrated();
    seedDue(sq, "e1", "File the report", Date.now() - DAY);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    mockFetchAlways(201);

    await pushDueItems(env, "");
    await sq.db.prepare(`UPDATE entries SET when_at = ? WHERE id = 'e1'`).bind(Date.now() - 1000).run();

    const result = await pushDueItems(env, "");
    expect(result.sent).toBe(1);
  });

  it("caps at 3 notifications per run", async () => {
    sq = await migrated();
    for (let i = 0; i < 5; i++) seedDue(sq, `e${i}`, `Item ${i}`, Date.now() - (i + 1) * 1000);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    mockFetchAlways(201);

    const result = await pushDueItems(env, "");
    expect(result.sent).toBe(3);
  });

  it("deletes the subscription on a 410 Gone response", async () => {
    sq = await migrated();
    seedDue(sq, "e1", "File the report", Date.now() - DAY);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    mockFetchAlways(410);

    await pushDueItems(env, "");

    const row = await sq.db.prepare(`SELECT id FROM push_subscriptions WHERE id = 'sub-1'`).first();
    expect(row).toBeNull();
  });

  it("deletes the subscription on a 404 response", async () => {
    sq = await migrated();
    seedDue(sq, "e1", "File the report", Date.now() - DAY);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    mockFetchAlways(404);

    await pushDueItems(env, "");

    const row = await sq.db.prepare(`SELECT id FROM push_subscriptions WHERE id = 'sub-1'`).first();
    expect(row).toBeNull();
  });

  it("increments fail_count on an ordinary failure, without deleting", async () => {
    sq = await migrated();
    seedDue(sq, "e1", "File the report", Date.now() - DAY);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    mockFetchAlways(500);

    await pushDueItems(env, "");

    const row = (await sq.db.prepare(`SELECT fail_count FROM push_subscriptions WHERE id = 'sub-1'`).first()) as any;
    expect(row.fail_count).toBe(1);
  });

  it("deletes the subscription once fail_count would reach 5", async () => {
    sq = await migrated();
    seedDue(sq, "e1", "File the report", Date.now() - DAY);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
    await sq.db.prepare(`UPDATE push_subscriptions SET fail_count = 4 WHERE id = 'sub-1'`).run();
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    mockFetchAlways(500);

    await pushDueItems(env, "");

    const row = await sq.db.prepare(`SELECT id FROM push_subscriptions WHERE id = 'sub-1'`).first();
    expect(row).toBeNull();
  });

  it("only sends to subscriptions in the given workspace", async () => {
    sq = await migrated();
    seedDue(sq, "e1", "File the report", Date.now() - DAY);
    await sq.db.prepare(`UPDATE entries SET workspace_id = 'ws-a' WHERE id = 'e1'`).run();
    seedSubscription(sq, "sub-a", "ws-a", "https://push.example.com/a");
    seedSubscription(sq, "sub-b", "ws-b", "https://push.example.com/b");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = mockFetchAlways(201);

    await pushDueItems(env, "ws-a");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://push.example.com/a");
  });

  it("D1で消滅した配達記録を削除し、古くても有効な期限の記録を保持する", async () => {
    sq = await migrated();
    seedDue(sq, "e1", "File the report", Date.now() - DAY);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
    const kv = makeMemoryKV();
    const OLD = 31 * DAY;
    const oldAt = Date.now() - OLD;
    seedDue(sq, "recent-id", "送信済みの古い期限", oldAt);
    await kv.put("pushed:", JSON.stringify({ "forgotten-test-id": Date.now() - OLD, "recent-id": oldAt }));
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv });
    mockFetchAlways(201);

    expect((await pushDueItems(env, "")).sent).toBe(1);

    const stored = JSON.parse((await kv.get("pushed:")) as string);
    expect(stored).not.toHaveProperty("forgotten-test-id");
    expect(stored).toHaveProperty("recent-id");
    expect(stored).toHaveProperty("e1");
    expect((await pushDueItems(env, "")).sent).toBe(0);
  });

  describe("per-subscription outcomes (results)", () => {
    it("reports ok for a successful send", async () => {
      sq = await migrated();
      seedDue(sq, "e1", "File the report", Date.now() - DAY);
      seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
      const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
      mockFetchAlways(201);

      const result = await pushDueItems(env, "");

      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe("ok");
      expect(result.results[0].endpoint_hash_prefix).toBe("hash-sub-1".slice(0, 12));
    });

    it("reports http_<code> for a non-ok response", async () => {
      sq = await migrated();
      seedDue(sq, "e1", "File the report", Date.now() - DAY);
      seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
      const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
      mockFetchAlways(500);

      const result = await pushDueItems(env, "");

      expect(result.results[0].status).toBe("http_500");
    });

    it("reports http_410 for a gone subscription rather than a bare error", async () => {
      sq = await migrated();
      seedDue(sq, "e1", "File the report", Date.now() - DAY);
      seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
      const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
      mockFetchAlways(410);

      const result = await pushDueItems(env, "");

      expect(result.results[0].status).toBe("http_410");
    });

    it("reports error when the request itself throws (network failure)", async () => {
      sq = await migrated();
      seedDue(sq, "e1", "File the report", Date.now() - DAY);
      seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
      const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

      const result = await pushDueItems(env, "");

      expect(result.results[0].status).toBe("error");
    });

    it("caps the results array at 10", async () => {
      sq = await migrated();
      for (let i = 0; i < 5; i++) seedDue(sq, `e${i}`, `Item ${i}`, Date.now() - (i + 1) * 1000);
      for (let i = 0; i < 4; i++) seedSubscription(sq, `sub-${i}`, "", `https://push.example.com/s${i}`);
      const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
      mockFetchAlways(201);

      const result = await pushDueItems(env, "");

      // Capped per-run at 3 candidates x 4 subs = 12 sends, results capped at 10.
      expect(result.results.length).toBeLessThanOrEqual(10);
    });
  });
});

describe("pushDueItemsAllWorkspaces — D1 budget", () => {
  // What the hourly integration-sync cron pays for push on top of the sync
  // itself (src/index.ts). "aim <=4" is the round's own target for the
  // common case: one deployment, one subscribed workspace.
  it("costs one statement (the DISTINCT scan) when nothing is subscribed", async () => {
    sq = await migrated();
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const before = sq.issued.length;

    await pushDueItemsAllWorkspaces(env);

    expect(sq.issued.length - before).toBe(1);
  });

  it("costs at most 4 statements for one subscribed workspace with a due item", async () => {
    sq = await migrated();
    seedDue(sq, "e1", "File the report", Date.now() - DAY);
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    mockFetchAlways(201);
    const before = sq.issued.length;

    const result = await pushDueItemsAllWorkspaces(env);

    // 1 (DISTINCT workspace scan) + pushDueItems' own 3 (due SELECT,
    // subscriptions SELECT, one batch for the resulting writes).
    expect(sq.issued.length - before).toBe(4);
    expect(result.sent).toBe(1);
  });
});

describe("sendTestNotification", () => {
  it("sends a fixed notification to every subscription in the workspace, bypassing the due query", async () => {
    sq = await migrated();
    seedSubscription(sq, "sub-1", "", "https://push.example.com/s1");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = mockFetchAlways(201);

    const result = await sendTestNotification(env, "");

    expect(result.sent).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Pushの呼出上限と繰越", () => {
  it("40端末で区切り、次回は残りだけを送る", async () => {
    sq = await migrated();
    seedDue(sq, "bounded", "期限", Date.now() - DAY);
    for (let i = 0; i < 45; i++) seedSubscription(sq, `sub-${i}`, "", `https://push.example.com/${i}`);
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = mockFetchAlways(201);
    expect((await pushDueItems(env, "")).sent).toBe(40);
    expect((await pushDueItems(env, "")).sent).toBe(5);
    expect((await pushDueItems(env, "")).sent).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(45);
    expect(new Set(fetchSpy.mock.calls.map(([url]) => url)).size).toBe(45);
  });

  it("4 workspaceずつ進み、末尾後は先頭へ戻る", async () => {
    sq = await migrated();
    for (let i = 0; i < 6; i++) {
      seedDue(sq, `due-${i}`, "期限", Date.now() - DAY);
      await sq.db.prepare("UPDATE entries SET workspace_id = ? WHERE id = ?").bind(`ws-${i}`, `due-${i}`).run();
      seedSubscription(sq, `sub-${i}`, `ws-${i}`, `https://push.example.com/${i}`);
    }
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = mockFetchAlways(201);
    expect((await pushDueItemsAllWorkspaces(env)).sent).toBe(4);
    expect((await pushDueItemsAllWorkspaces(env)).sent).toBe(2);
    expect((await pushDueItemsAllWorkspaces(env)).sent).toBe(0);
    expect((await pushDueItemsAllWorkspaces(env)).sent).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });
});

describe("境界調査の再現", () => {
  it("先頭15件を越えて16件目にも配達し、巡回後も重複しない", async () => {
    sq = await migrated();
    for (let i=0;i<16;i++) seedDue(sq, `e${i}`, `期限${i}`, Date.now()-DAY+i*1000);
    seedSubscription(sq,"s","","https://push.example.com/s");
    const env=makeTestEnv(dbOf(sq) as any,{OAUTH_KV:makeMemoryKV()});
    const spy=mockFetchAlways(201);
    const counts=[];
    for(let i=0;i<7;i++) counts.push((await pushDueItems(env, "")).sent);
    expect(counts).toEqual([3,3,3,3,3,1,0]);
    expect(spy).toHaveBeenCalledTimes(16);
  });
  it("31日前の期限も40端末から残り5端末へ繰り越す", async () => {
    sq=await migrated();
    seedDue(sq,"e","期限",Date.now()-31*DAY);
    for(let i=0;i<45;i++) seedSubscription(sq,`s${i}`,"",`https://push.example.com/s${i}`);
    const env=makeTestEnv(dbOf(sq) as any,{OAUTH_KV:makeMemoryKV()});
    const spy=mockFetchAlways(201);
    expect((await pushDueItems(env,"")).sent).toBe(40);
    expect((await pushDueItems(env,"")).sent).toBe(5);
    expect((await pushDueItems(env,"")).sent).toBe(0);
    expect(new Set(spy.mock.calls.map(x=>x[0])).size).toBe(45);
  });
  it("503失敗は復旧後に再試行する",async()=>{
    sq=await migrated();
    seedDue(sq,"e","期限",Date.now()-DAY);
    seedSubscription(sq,"s","","https://push.example.com/s");
    const env=makeTestEnv(dbOf(sq) as any,{OAUTH_KV:makeMemoryKV()});
    const spy=mockFetchAlways(503);
    expect((await pushDueItems(env,"")).sent).toBe(0);
    spy.mockResolvedValue(new Response(null,{status:201}));
    expect((await pushDueItems(env,"")).sent).toBe(1);
    expect((await pushDueItems(env,"")).sent).toBe(0);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

it("成功端末は再送せず、失敗端末だけ再試行する", async () => {
  sq=await migrated();
  seedDue(sq,"e","期限",Date.now()-DAY);
  seedSubscription(sq,"a","","https://push.example.com/a");
  seedSubscription(sq,"b","","https://push.example.com/b");
  const env=makeTestEnv(dbOf(sq) as any,{OAUTH_KV:makeMemoryKV()});
  const spy=vi.spyOn(globalThis,"fetch").mockImplementation(async url=>new Response(null,{status:String(url).endsWith("/a")?201:503}));
  expect((await pushDueItems(env,"")).sent).toBe(1);
  spy.mockResolvedValue(new Response(null,{status:201}));
  expect((await pushDueItems(env,"")).sent).toBe(1);
  expect(spy.mock.calls.map(x=>x[0])).toEqual(["https://push.example.com/a","https://push.example.com/b","https://push.example.com/b"]);
});
it("40送信を使い切ったworkspaceの後にも配達し、次の巡回で残りを再開する",async()=>{
  sq=await migrated();
  seedDue(sq,"a","古い期限",Date.now()-31*DAY);
  seedDue(sq,"b","期限",Date.now()-DAY);
  for (const id of ["a", "b"]) await sq.db.prepare("UPDATE entries SET workspace_id=? WHERE id=?").bind(id,id).run();
  for(let i=0;i<45;i++) seedSubscription(sq,`a${i}`,"a",`https://push.example.com/a${i}`);
  seedSubscription(sq,"b","b","https://push.example.com/b");
  const env=makeTestEnv(dbOf(sq) as any,{OAUTH_KV:makeMemoryKV()});
  const spy=mockFetchAlways(201);
  expect((await pushDueItemsAllWorkspaces(env)).sent).toBe(40);
  expect((await pushDueItemsAllWorkspaces(env)).sent).toBe(6);
  expect((await pushDueItemsAllWorkspaces(env)).sent).toBe(0);
  expect((await pushDueItemsAllWorkspaces(env)).sent).toBe(0);
  expect(new Set(spy.mock.calls.map(x=>x[0])).size).toBe(46);
});
it("範囲外の既存期限と不正な購読でも正常な配達を止めない",async()=>{
  sq=await migrated();
  seedDue(sq,"bad","不正な期限",-9000000000000000);
  seedDue(sq,"good","期限",Date.now()-DAY);
  seedSubscription(sq,"bad","","https://push.example.com/bad");
  await sq.db.prepare("UPDATE push_subscriptions SET subscription_json='{}' WHERE id='bad'").run();
  seedSubscription(sq,"good","","https://push.example.com/good");
  const env=makeTestEnv(dbOf(sq) as any,{OAUTH_KV:makeMemoryKV()});
  const spy=mockFetchAlways(201);
  expect((await pushDueItems(env,"")).sent).toBe(1);
  expect(spy).toHaveBeenCalledTimes(1);
});

it("配達記録整理と3種類の結果更新を6 SQL以内で処理する",async()=>{
  sq=await migrated();
  const whenAt=Date.now()-DAY;
  seedDue(sq,"e","期限",whenAt);
  for(const id of ["ok","gone","failed"]) seedSubscription(sq,id,"",`https://push.example.com/${id}`);
  const kv=makeMemoryKV();
  await kv.put("pushed:",JSON.stringify({obsolete:whenAt}));
  const env=makeTestEnv(dbOf(sq) as any,{OAUTH_KV:kv});
  const {createNightlyD1Budget}=await import("../../src/runtime/d1-budget");
  const budget=createNightlyD1Budget(env,6);
  vi.spyOn(globalThis,"fetch").mockImplementation(async url=>new Response(null,{status:String(url).endsWith("/ok")?201:String(url).endsWith("/gone")?410:503}));
  expect((await pushDueItems(budget.env,"")).sent).toBe(1);
  expect(budget.stats()).toMatchObject({used:5,deferred:0});
  expect(budget.stats().used).toBeLessThanOrEqual(6);
});
