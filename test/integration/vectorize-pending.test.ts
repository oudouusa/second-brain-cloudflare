import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, { runVectorizePendingRepair } from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function makeScheduledCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any,
    drain: () => Promise.allSettled(pending),
  };
}

function pastGraceEntry(id: string) {
  return {
    id,
    content: `Content for ${id}`,
    tags: '["work"]',
    source: "api",
    created_at: Date.now() - 600000, // 10 minutes ago — past default 5-min grace
    vector_ids: "[]",
    recall_count: 0,
    importance_score: 0,
  };
}

describe("runVectorizePendingRepair", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("processes only vector_ids=[] entries older than the grace cutoff", async () => {
    db.entries.push(
      pastGraceEntry("old-pending"),
      {
        ...pastGraceEntry("recent-pending"),
        created_at: Date.now(),
      },
      {
        ...pastGraceEntry("already-embedded"),
        vector_ids: '["already-embedded"]',
      },
    );

    const result = await runVectorizePendingRepair(env);

    expect(result).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(JSON.parse(db.entries.find((e: any) => e.id === "old-pending").vector_ids)).toHaveLength(1);
    expect(db.entries.find((e: any) => e.id === "recent-pending").vector_ids).toBe("[]");
    expect(db.entries.find((e: any) => e.id === "already-embedded").vector_ids).toBe('["already-embedded"]');
  });

  it("processes at most 25 pending entries and returns the remaining count", async () => {
    for (let i = 0; i < 30; i++) {
      db.entries.push(pastGraceEntry(`pending-${i}`));
    }

    const result = await runVectorizePendingRepair(env);

    expect(result).toEqual({ processed: 25, failed: 0, remaining: 5 });
    expect(db.entries.filter((e: any) => e.vector_ids === "[]")).toHaveLength(5);
  });
});

describe("POST /vectorize-pending", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 401 without auth", async () => {
    const res = await worker.fetch(req("POST", "/vectorize-pending", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns { processed: 0, failed: 0, remaining: 0 } when no past-grace entries", async () => {
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(Object.keys(data).sort()).toEqual(["failed", "processed", "remaining"]);
    expect(data.processed).toBe(0);
    expect(data.failed).toBe(0);
    expect(data.remaining).toBe(0);
  });

  it("processes past-grace entries and returns correct counts", async () => {
    db.entries.push(pastGraceEntry("e1"), pastGraceEntry("e2"));
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(2);
    expect(data.failed).toBe(0);
    expect(data.remaining).toBe(0);
  });

  it("updates vector_ids in D1 after successful re-embed", async () => {
    db.entries.push(pastGraceEntry("fix-me"));
    await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const updated = db.entries.find((e: any) => e.id === "fix-me");
    const ids = JSON.parse(updated.vector_ids);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("skips entries within the grace window (vector_ids=[] but recent)", async () => {
    db.entries.push({
      id: "pending",
      content: "Just captured",
      tags: "[]",
      source: "api",
      created_at: Date.now(), // within grace window
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
    expect(data.remaining).toBe(0);
  });

  it("skips entries that already have vector_ids populated", async () => {
    db.entries.push({
      id: "already-done",
      content: "Already vectorized",
      tags: "[]",
      source: "api",
      created_at: Date.now() - 600000,
      vector_ids: '["already-done"]',
      recall_count: 0,
      importance_score: 0,
    });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
  });

  it("counts failed and continues when storeEntry throws for one entry", async () => {
    db.entries.push(pastGraceEntry("bad"), pastGraceEntry("good"));
    let callCount = 0;
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) throw new Error("Vectorize error");
          return Promise.resolve({ mutationId: "m" });
        }),
      }),
    });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(1);
    expect(data.failed).toBe(1);
    expect(data.remaining).toBe(1);
  });

  it("respects VECTORIZE_GRACE_MS env var", async () => {
    // entry 90s old — past 60s grace but within default 300s
    db.entries.push({
      id: "e90",
      content: "90-second-old memory",
      tags: "[]",
      source: "api",
      created_at: Date.now() - 90000,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    env = makeTestEnv(db, { VECTORIZE_GRACE_MS: "60000" });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(1);
  });

  it("records one cron summary row when scheduled repair runs", async () => {
    db.entries.push(pastGraceEntry("cron-fix"));
    const scheduled = makeScheduledCtx();

    await (worker as any).scheduled({} as any, env, scheduled.ctx);
    const settled = await scheduled.drain();

    expect(settled.every(r => r.status === "fulfilled")).toBe(true);
    const summaries = db.usageEvents.filter((e: any) => e.operation === "cron_vectorize_pending");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].model).toBe("none");
    expect(summaries[0].status).toBe("success");
    expect(summaries[0].input_chars).toBe(0);
    expect(summaries[0].max_output_tokens).toBe(0);
    expect(JSON.parse(summaries[0].metadata)).toEqual({
      processed: 1,
      failed: 0,
      remaining: 0,
      trigger: "cron",
    });
  });
});
