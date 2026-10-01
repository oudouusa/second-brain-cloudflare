/**
 * Cross-vendor adversarial review of Track 7 lane D (c870e5ac..9403a2e0, Tasks 11-12).
 * Both tests FAIL against 9403a2e0. Same harness contract as standing-invalidation.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";
import { updateEntryContent } from "../../src/capture/store";
import { updateEntryValidity } from "../../src/memory/validity";
import { resetStandingIsolateState, standingKvKey, standingTouched } from "../../src/standing/cache";
import type { StandingCacheV1 } from "../../src/standing/codec";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";

function insertStanding(sqlite: SqliteD1, id: string, workspaceId = "ws-a"): void {
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
     VALUES (?, ?, '["standing:active"]', 'api', 1000, '["v"]', ?, 'u1')`,
  ).bind(id, "When reviewing code, prefer small diffs", workspaceId).run();
}

const change = { actorId: "u1", channel: "rest" as const };
const writeCtx = { workspaceId: "ws-a", actorId: "u1" };

const open: SqliteD1[] = [];
let deferred: Promise<unknown>[];
let ctx: ExecutionContext;

beforeEach(() => {
  resetDatabaseInit();
  resetStandingIsolateState();
  deferred = [];
  ctx = { waitUntil: (p: Promise<unknown>) => deferred.push(p) } as unknown as ExecutionContext;
});
afterEach(() => open.splice(0).forEach(s => s.close()));

async function setup() {
  const sqlite = makeSqliteD1();
  open.push(sqlite);
  const kv = makeMemoryKV();
  let env: Env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as D1Database,
    OAUTH_KV: kv,
    VECTORIZE: makeVectorizeMock({
      // The rebuilt cache only differs (and so is only written) if the edited row's NEW chunk
      // resolves to a different vector than the primed one: "v" is the old chunk's.
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map(id => ({ id, values: id === "v" ? [1, 0, 0] : [0, 1, 0] })) as any),
    }),
  }));
  await initializeDatabase(env);
    env = sqlite.admitEnv(env);
  return { env, sqlite, kv };
}

const readCache = async (kv: KVNamespace, ws: string) =>
  (await kv.get(standingKvKey(ws), "json")) as StandingCacheV1 | null;

describe("standing cache invalidation gaps (spec 15 2.6)", () => {
  it("updateEntryContent re-embeds a standing row but never rebuilds the cache: it fires on the OLD text's vector for up to 24h", async () => {
    // Spec 15 2.6 lists updateEntryContent as a required toucher ("new vector") — the cache
    // stores the instruction's embedding, so an edit that changes what the instruction is about
    // keeps matching the old topic (showing the NEW text on the OLD topic's recalls) until the
    // 24h revalidation. entry-write-inventory.test.ts marks store.ts "exempt: lane W deferred",
    // but the behavior gap is live: no rebuild is scheduled at all.
    const { env, sqlite, kv } = await setup();
    insertStanding(sqlite, "s1");
    standingTouched(env, ctx, DEFAULTS, ["ws-a"]);
    await Promise.all(deferred);
    expect(readCache(kv, "ws-a").then(c => c?.items.map(i => i.id))).resolves.toContain("s1");

    const putSpy = vi.spyOn(kv, "put");
    deferred = [];
    const r = await updateEntryContent(env, "s1", "When reviewing code, prefer pair review over diffs", DEFAULTS, undefined, undefined, writeCtx, change, "ws-a");
    expect(r).not.toHaveProperty("status", "not_found");
    await Promise.all(deferred);

    expect(putSpy.mock.calls.some(([key]) => String(key).startsWith("standing:v1:"))).toBe(true);
  });

  it("updateEntryValidity closing a standing row's window leaves it in the cache: GET /standing says firing for up to 24h", async () => {
    // The fire path is safe (hydration re-checks currentValidityAt), but the cache build now
    // filters closed rows, so a rebuild would drop it — and none is scheduled. GET /standing
    // (routes/standing.ts, firing = cachedIds.has(id)) reports firing: true for a row whose
    // window already closed, contradicting its own "what a person would still call standing".
    const { env, sqlite, kv } = await setup();
    insertStanding(sqlite, "s2");
    standingTouched(env, ctx, DEFAULTS, ["ws-a"]);
    await Promise.all(deferred);
    expect(await readCache(kv, "ws-a")).toMatchObject({ items: [{ id: "s2" }] });

    deferred = [];
    const r = await updateEntryValidity(env, "s2", { until: 1500 }, change, DEFAULTS, "ws-a");
    expect(r.status).toBe("updated");
    await Promise.all(deferred);

    expect((await readCache(kv, "ws-a"))?.items.map(i => i.id)).not.toContain("s2");
  });
});
