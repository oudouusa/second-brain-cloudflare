import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index"; import { SB_VERSION } from "../../src/env";
import { makeTestEnv, makeTestDb, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { D1Mock } from "../helpers/d1-mock";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { resetDatabaseInit } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";
import { VERSIONS_SINCE_KV_KEY } from "../../src/constants";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("GET /health", () => {
  let db: D1Mock;
  beforeEach(() => { db = makeTestDb(); });

  it("returns 401 without auth", async () => {
    const env = makeTestEnv(db);
    const res = await worker.fetch(req("GET", "/health", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("reports vectorize ok when the index is reachable", async () => {
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ describe: vi.fn().mockResolvedValue({ dimensions: 384 }) }),
    });
    const res = await worker.fetch(req("GET", "/health"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.vectorize.ok).toBe(true);
    expect(data.vectorize.indexName).toBe("second-brain-cf-eg128-v1");
    expect(data.ai).toEqual({ ok: null, status: "no_recent_quota_error" });
  });

  it("echoes the Worker version (used by the desktop app's update check)", async () => {
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ describe: vi.fn().mockResolvedValue({ dimensions: 384 }) }),
    });
    const res = await worker.fetch(req("GET", "/health"), env, ctx);
    const data = await res.json() as any;
    expect(data.version).toBe(SB_VERSION);
    expect(SB_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("reports vectorize not-ok when the index is missing", async () => {
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ describe: vi.fn().mockRejectedValue(new Error("index not found")) }),
    });
    const res = await worker.fetch(req("GET", "/health"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.vectorize.ok).toBe(false);
    expect(data.vectorize.error).toContain("index not found");
  });

  it("does not report deployment readiness until a completely empty D1 is initialized", async () => {
    const sqlite = makeSqliteD1({ schema: false });
    resetDatabaseInit();
    setDbReady(false);
    try {
      const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database });
      const res = await worker.fetch(req("GET", "/health"), env, ctx);
      expect(res.status).toBe(200);
      const row = await sqlite.db.prepare(
        `SELECT COUNT(*) AS count FROM entries`,
      ).first() as { count: number };
      expect(row.count).toBe(0);
      expect(sqlite.columns()).toContain("migration_lease_owner");
    } finally {
      sqlite.close();
      resetDatabaseInit();
      setDbReady(false);
    }
  });

  it("includes history_since when the marker exists and omits it otherwise", async () => {
    const envNoMarker = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ describe: vi.fn().mockResolvedValue({ dimensions: 384 }) }),
    });
    const resNoMarker = await worker.fetch(req("GET", "/health"), envNoMarker, ctx);
    const dataNoMarker = await resNoMarker.json() as any;
    expect(dataNoMarker.history_since).toBeUndefined();

    const kv = makeMemoryKV();
    await kv.put(VERSIONS_SINCE_KV_KEY, "1789500000000");
    const envWithMarker = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ describe: vi.fn().mockResolvedValue({ dimensions: 384 }) }),
      OAUTH_KV: kv,
    });
    const resWithMarker = await worker.fetch(req("GET", "/health"), envWithMarker, ctx);
    const dataWithMarker = await resWithMarker.json() as any;
    expect(dataWithMarker.history_since).toBe(1789500000000);
  });

  it("adds no D1 statement for history_since", async () => {
    // Each env gets its own db and a warm-up call first, so schema-init
    // statements (paid once per db) never pollute the comparison below.
    const dbWithMarker = makeTestDb();
    const kv = makeMemoryKV();
    await kv.put(VERSIONS_SINCE_KV_KEY, "1789500000000");
    const env = makeTestEnv(dbWithMarker, {
      VECTORIZE: makeVectorizeMock({ describe: vi.fn().mockResolvedValue({ dimensions: 384 }) }),
      OAUTH_KV: kv,
    });
    await worker.fetch(req("GET", "/health"), env, ctx);
    const prepare = vi.spyOn(env.DB, "prepare");
    await worker.fetch(req("GET", "/health"), env, ctx);
    const withMarkerCalls = prepare.mock.calls.length;

    const dbNoMarker = makeTestDb();
    const envNoMarker = makeTestEnv(dbNoMarker, {
      VECTORIZE: makeVectorizeMock({ describe: vi.fn().mockResolvedValue({ dimensions: 384 }) }),
      OAUTH_KV: makeMemoryKV(),
    });
    await worker.fetch(req("GET", "/health"), envNoMarker, ctx);
    const prepare2 = vi.spyOn(envNoMarker.DB, "prepare");
    await worker.fetch(req("GET", "/health"), envNoMarker, ctx);
    expect(withMarkerCalls).toBe(prepare2.mock.calls.length);
  });
});
