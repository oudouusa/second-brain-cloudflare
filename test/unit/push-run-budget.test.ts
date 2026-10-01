/**
 * Push run budget and fairness (src/push/send.ts, src/routes/push.ts): one
 * 40-fetch budget per invocation on every entry point, a persistent ring
 * cursor so every workspace and subscription is reached within a bounded
 * number of runs, exact failure accounting, and pinned worst-case costs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import {
  newPushBudget, pushDueItems, pushDueItemsAllWorkspaces, sendTestNotification, PUSH_CURSOR_KV_KEY, MAX_PUSH_WORKSPACES_PER_RUN,
} from "../../src/push/send";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";
import { QUARANTINE_TAG_PREFIX } from "../../src/quarantine/tags";
import type { Config } from "../../src/config";
import type { Env } from "../../src/env";

vi.mock("../../src/push/crypto", () => ({ encryptWebPush: vi.fn(async () => ({ body: new Uint8Array([1]) })) }));
vi.mock("../../src/push/vapid", async (orig) => ({
  ...(await orig<typeof import("../../src/push/vapid")>()),
  vapidAuthHeader: vi.fn(async () => "test"),
}));

const DAY = 24 * 60 * 60 * 1000;
const cfg = { TIMEZONE: "UTC" } as Config;
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; resetDatabaseInit(); setDbReady(false); vi.restoreAllMocks(); });

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

/**
 * Marks a due row held (quarantine:<reason>), as Q3's contradiction/quarantine path does. The
 * default is a real recognized reason -- isHeld matches only the app's five own reason values,
 * see src/quarantine/tags.ts's HoldReason.
 */
function holdEntry(s: SqliteD1, id: string, reason = "instruction") {
  s.db.prepare(`UPDATE entries SET tags = json_insert(tags, '$[#]', ?) WHERE id = ?`)
    .bind(`${QUARANTINE_TAG_PREFIX}${reason}`, id).run();
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

const endpoints = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([url]) => url as string);

describe("starvation freedom across runs", () => {
  it("45 workspaceを4件ずつ巡回し、全135端末へ重複なく配達する", async () => {
    sq = await migrated();
    const all: string[] = [];
    for (let w = 0; w < 45; w++) {
      const ws = `ws-${String(w).padStart(2, "0")}`;
      seedDue(sq, `due-${ws}`, ws);
      for (let n = 0; n < 3; n++) { seedSub(sq, `${ws}-sub-${n}`, ws); all.push(`https://push.example/${ws}-sub-${n}`); }
    }
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    for (let run = 0; run < Math.ceil(45 / MAX_PUSH_WORKSPACES_PER_RUN); run++) {
      const before = fetchSpy.mock.calls.length;
      await pushDueItemsAllWorkspaces(env, cfg);
      expect(fetchSpy.mock.calls.length - before).toBeLessThanOrEqual(40);
    }

    const sent = endpoints(fetchSpy);
    expect(new Set(sent)).toEqual(new Set(all));
    expect(sent).toHaveLength(all.length);

    await pushDueItemsAllWorkspaces(env, cfg);
    expect(fetchSpy.mock.calls.length).toBe(all.length);
  });

  it("resumes one workspace's 90 subscriptions over three runs without resending any", async () => {
    sq = await migrated();
    seedDue(sq, "due");
    for (let i = 0; i < 90; i++) seedSub(sq, `sub-${String(i).padStart(2, "0")}`);
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    for (let run = 0; run < 3; run++) await pushDueItems(env, "", cfg);

    expect(fetchSpy.mock.calls.length).toBe(90);
    expect(new Set(endpoints(fetchSpy)).size).toBe(90);
  });

  it("keeps the ring position in one KV key, written only when it moves", async () => {
    sq = await migrated();
    seedDue(sq, "due");
    seedSub(sq, "sub-a");
    const kv = makeMemoryKV();
    const put = vi.spyOn(kv, "put");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    for (let run = 0; run < 3; run++) await pushDueItemsAllWorkspaces(env, cfg);

    const cursorPuts = put.mock.calls.filter(([key]) => key === PUSH_CURSOR_KV_KEY);
    expect(cursorPuts.length).toBeLessThanOrEqual(1);
  });

  it("sends a newer due item in the first run whatever the backlog of delivered items (100 here)", async () => {
    sq = await migrated();
    seedSub(sq, "sub");
    const kv = makeMemoryKV();
    const delivered: Record<string, { w: number; s: string[] }> = {};
    const old = Date.now() - 40 * DAY;
    for (let i = 0; i < 100; i++) {
      seedDue(sq, `old-${String(i).padStart(3, "0")}`, "", old + i);
      delivered[`old-${String(i).padStart(3, "0")}`] = { w: old + i, s: ["sub"] };
    }
    seedDue(sq, "new");
    await kv.put("pushed:", JSON.stringify(delivered));
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    await pushDueItems(env, "", cfg);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const stored = JSON.parse((await kv.get("pushed:")) as string);
    expect(Object.keys(stored)).toHaveLength(101);
  });

  it("does not re-push an item overdue by more than 30 days on every run", async () => {
    sq = await migrated();
    seedDue(sq, "old", "", Date.now() - 40 * DAY);
    seedSub(sq, "sub");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    await pushDueItems(env, "", cfg);
    await pushDueItems(env, "", cfg);
    await pushDueItems(env, "", cfg);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("failure accounting", () => {
  it("adds one to fail_count per failed send", async () => {
    sq = await migrated();
    seedDue(sq, "due-0", "", Date.now() - 120_000);
    seedDue(sq, "due-1", "", Date.now() - 60_000);
    seedSub(sq, "sub", "", 0);
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));

    await pushDueItems(env, "", cfg);

    const row = await sq.db.prepare("SELECT fail_count FROM push_subscriptions WHERE id = 'sub'").first() as any;
    expect(row.fail_count).toBe(2);
  });

  it("a success resets the count to the failures that followed it in the same run", async () => {
    sq = await migrated();
    seedDue(sq, "due-0", "", Date.now() - 120_000);
    seedDue(sq, "due-1", "", Date.now() - 60_000);
    seedSub(sq, "sub", "", 3);
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));

    await pushDueItems(env, "", cfg);

    const row = await sq.db.prepare("SELECT fail_count FROM push_subscriptions WHERE id = 'sub'").first() as any;
    expect(row.fail_count).toBe(1);
  });
});

describe("one budget per invocation on every entry point", () => {
  it("parallel pushDueItems calls sharing a budget make at most 40 fetches", async () => {
    sq = await migrated();
    for (const ws of ["a", "b", "c"]) {
      seedDue(sq, `due-${ws}`, ws);
      for (let i = 0; i < 20; i++) seedSub(sq, `${ws}-${i}`, ws);
    }
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    const budget = newPushBudget();
    await Promise.all(["a", "b", "c"].map(ws => pushDueItems(env, ws, cfg, budget)));

    expect(fetchSpy.mock.calls.length).toBe(40);
  });

  it("parallel sendTestNotification calls sharing a budget make at most 40 fetches", async () => {
    sq = await migrated();
    for (const ws of ["a", "b", "c"]) for (let i = 0; i < 20; i++) seedSub(sq, `${ws}-${i}`, ws);
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    const budget = newPushBudget();
    await Promise.all(["a", "b", "c"].map(ws => sendTestNotification(env, ws, budget)));

    expect(fetchSpy.mock.calls.length).toBe(40);
  });

  async function adminWithTwoWorkspaces() {
    const s = await migrated();
    setDbReady(true);
    const env = makeTestEnv(dbOf(s) as any, { OAUTH_KV: makeMemoryKV() });
    await worker.fetch(req("GET", "/push/vapid-public-key"), env, ctx);
    const personal = (await s.db.prepare("SELECT id FROM workspaces WHERE kind = 'personal' LIMIT 1").first() as any).id as string;
    for (const ws of ["", personal]) {
      seedDue(s, `due-${ws || "legacy"}`, ws);
      for (let i = 0; i < 25; i++) seedSub(s, `${ws || "legacy"}-${i}`, ws);
    }
    return { s, env };
  }

  it("POST /push/run across an admin's workspaces makes at most 40 fetches", async () => {
    const { s, env } = await adminWithTwoWorkspaces();
    sq = s;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    const data = await (await worker.fetch(req("POST", "/push/run"), env, ctx)).json() as any;

    expect(data.ok).toBe(true);
    expect(fetchSpy.mock.calls.length).toBe(40);
  });

  it("POST /push/test across an admin's workspaces makes at most 40 fetches", async () => {
    const { s, env } = await adminWithTwoWorkspaces();
    sq = s;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    const data = await (await worker.fetch(req("POST", "/push/test"), env, ctx)).json() as any;

    expect(data.ok).toBe(true);
    expect(fetchSpy.mock.calls.length).toBe(40);
  });
});

describe("pinned worst case for one cron invocation", () => {
  // MOVED 104 -> 105 reads, 42 -> 43 writes (FX3 finding 4): pushDueItemsAllWorkspaces now
  // reads and writes a self-imposed daily KV-write counter (MAX_PUSH_KV_WRITES_PER_DAY), once per
  // invocation that has something due, not once per workspace — so the worst case gains exactly
  // one read and, on a run that actually writes anything, exactly one write.
  it("500 subscribed workspaces: at most 102 D1 calls, 40 external fetches, 105 KV reads, 43 KV writes and 1 delete", async () => {
    let d1 = 0;
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return { all: async () => {
              d1++;
              if (sql.includes("FROM entries")) return { results: [{ id: `due-${args[1]}`, content: "due", when_at: Date.now() - 60_000, when_label: "due", tags: '["task"]' }] };
              return { results: [{
                id: `sub-${args[0]}`, endpoint_hash: `hash-${args[0]}`, content_free: 0, fail_count: 0,
                subscription_json: JSON.stringify({ endpoint: `https://push.example/${args[0]}`, keys: { p256dh: "AA", auth: "AA" } }),
              }] };
            } };
          },
          async all() { d1++; return { results: Array.from({ length: 500 }, (_, i) => ({ workspace_id: `ws-${String(i).padStart(3, "0")}` })) }; },
        };
      },
      async batch() { d1++; return []; },
    };
    const kv = makeMemoryKV();
    const get = vi.spyOn(kv, "get");
    const put = vi.spyOn(kv, "put");
    const del = vi.spyOn(kv, "delete");
    const env = makeTestEnv(db as any, { OAUTH_KV: kv });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    await pushDueItemsAllWorkspaces(env, cfg);

    expect(d1).toBeLessThanOrEqual(102);
    expect(fetchSpy.mock.calls.length).toBe(MAX_PUSH_WORKSPACES_PER_RUN);
    expect(get.mock.calls.length).toBeLessThanOrEqual(105);
    expect(put.mock.calls.length).toBeLessThanOrEqual(43);
    expect(del.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("KV writes: only on change, and fail safe when they fail", () => {
  it("a run with nothing new writes no KV at all", async () => {
    sq = await migrated();
    seedDue(sq, "due");
    seedSub(sq, "sub");
    const kv = makeMemoryKV();
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));
    await pushDueItemsAllWorkspaces(env, cfg);
    await pushDueItems(env, "", cfg);

    const put = vi.spyOn(kv, "put");
    const del = vi.spyOn(kv, "delete");
    await pushDueItemsAllWorkspaces(env, cfg);
    await pushDueItems(env, "", cfg);

    expect(put).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("with KV writes failing, sends nothing, changes no subscription, logs one line per run, and then sends once", async () => {
    sq = await migrated();
    for (let i = 0; i < 3; i++) seedDue(sq, `due-${i}`, "", Date.now() - (i + 1) * 60_000);
    seedSub(sq, "sub", "", 4);
    const kv = makeMemoryKV();
    const realPut = kv.put.bind(kv);
    const put = vi.spyOn(kv, "put").mockRejectedValue(new Error("KV put() limit exceeded for the day."));
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    for (let run = 0; run < 3; run++) {
      const before = log.mock.calls.length;
      await pushDueItemsAllWorkspaces(env, cfg);
      expect(log.mock.calls.length - before).toBe(1);
    }
    await pushDueItems(env, "", cfg);

    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await sq.db.prepare("SELECT fail_count FROM push_subscriptions WHERE id = 'sub'").first() as any;
    expect(row.fail_count).toBe(4);
    expect(String(log.mock.calls[0][0])).toContain("KV write failed");

    put.mockImplementation(realPut);
    fetchSpy.mockResolvedValue(new Response(null, { status: 201 }));
    await pushDueItemsAllWorkspaces(env, cfg);
    await pushDueItemsAllWorkspaces(env, cfg);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("a delivery-record write failing after the lease sends nothing for that run", async () => {
    sq = await migrated();
    seedDue(sq, "due");
    seedSub(sq, "sub");
    const kv = makeMemoryKV();
    const realPut = kv.put.bind(kv);
    vi.spyOn(kv, "put").mockImplementation(async (key: string, value: any, opts?: any) => {
      if (key.startsWith("pushed:")) throw new Error("KV put() limit exceeded for the day.");
      return realPut(key, value, opts);
    });
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pushDueItemsAllWorkspaces(env, cfg);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.skipped).toBe("kv_write_failed");
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("held (quarantined) rows are never pushed (Q3)", () => {
  it("never sends a held due item, but does send an ordinary one alongside it", async () => {
    sq = await migrated();
    seedDue(sq, "held-item", "", Date.now() - 120_000);
    holdEntry(sq, "held-item");
    seedDue(sq, "ok-item", "", Date.now() - 60_000);
    seedSub(sq, "sub");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    await pushDueItems(env, "", cfg);
    await pushDueItems(env, "", cfg);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const stored = JSON.parse((await env.OAUTH_KV.get("pushed:")) as string);
    expect(stored).toHaveProperty("ok-item");
    expect(stored).not.toHaveProperty("held-item");
  });

  it("never sends a held item even via the all-workspaces cron path", async () => {
    sq = await migrated();
    seedDue(sq, "held-item", "");
    holdEntry(sq, "held-item");
    seedSub(sq, "sub");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    await pushDueItemsAllWorkspaces(env, cfg);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("overlapping runs", () => {
  it("a manual run during the cron run is refused rather than sending the same item twice", async () => {
    sq = await migrated();
    seedDue(sq, "due");
    seedSub(sq, "sub");
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: makeMemoryKV() });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { await gate; return new Response(null, { status: 201 }); });

    const cron = pushDueItemsAllWorkspaces(env, cfg);
    for (let i = 0; i < 100 && fetchSpy.mock.calls.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 0));
    const manual = await pushDueItems(env, "", cfg);
    release();
    await cron;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(manual.sent).toBe(0);
  });
});
