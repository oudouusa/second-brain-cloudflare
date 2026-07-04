import { describe, it, expect, vi, beforeEach } from "vitest";
import worker, { runGraphPass } from "../../src/index";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

describe("runGraphPass", () => {
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
  });

  it("backfills a relates_to edge for an unlinked entry to its nearest neighbor", async () => {
    db.entries.push(
      { id: "lonely", content: "Unlinked memory", tags: "[]", source: "api", created_at: 2, vector_ids: "[]" },
      { id: "neighbor", content: "Similar memory", tags: "[]", source: "api", created_at: 1, vector_ids: "[]" },
    );
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [
          { id: "lonely", score: 1.0, metadata: { parentId: "lonely" } },
          { id: "neighbor", score: 0.8, metadata: { parentId: "neighbor" } },
        ] }),
      }),
    });
    const { ctx } = makeCtx();

    await runGraphPass(env, ctx);

    const e = db.edges.find((x: any) => x.type === "relates_to");
    expect(e).toBeTruthy();
    expect([e.source_id, e.target_id].sort()).toEqual(["lonely", "neighbor"]);
    expect(e.provenance).toBe("inferred");
  });

  it("does not re-link entries that already have an edge", async () => {
    db.entries.push({ id: "linked", content: "x", tags: "[]", source: "api", created_at: 1, vector_ids: "[]" });
    db.edges.push({ id: "e", source_id: "linked", target_id: "other", type: "relates_to", weight: 0.9, provenance: "explicit", metadata: "{}", created_at: 1, updated_at: 1 });
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [{ id: "z", score: 0.9, metadata: { parentId: "z" } }] }) }),
    });
    const { ctx } = makeCtx();

    await runGraphPass(env, ctx);

    expect(db.edges).toHaveLength(1); // unchanged — "linked" already had an edge
  });

  it("prunes weak old inferred edges but keeps explicit and recent ones", async () => {
    const old = 1;
    const recent = Date.now();
    db.edges.push(
      { id: "weak-old", source_id: "a", target_id: "b", type: "relates_to", weight: 0.2, provenance: "inferred", metadata: "{}", created_at: old, updated_at: old },
      { id: "weak-explicit", source_id: "a", target_id: "c", type: "relates_to", weight: 0.2, provenance: "explicit", metadata: "{}", created_at: old, updated_at: old },
      { id: "weak-recent", source_id: "a", target_id: "d", type: "relates_to", weight: 0.2, provenance: "inferred", metadata: "{}", created_at: recent, updated_at: recent },
      { id: "strong-old", source_id: "a", target_id: "e", type: "relates_to", weight: 0.9, provenance: "inferred", metadata: "{}", created_at: old, updated_at: old },
    );
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock() });
    const { ctx } = makeCtx();

    await runGraphPass(env, ctx);

    expect(db.edges.map((x: any) => x.id).sort()).toEqual(["strong-old", "weak-explicit", "weak-recent"]);
  });

  it("is a safe no-op on an empty database", async () => {
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock() });
    const { ctx } = makeCtx();
    await expect(runGraphPass(env, ctx)).resolves.toBeUndefined();
    expect(db.edges).toHaveLength(0);
  });
});

describe("scheduled handler", () => {
  it("runs the graph pass alongside nightly compression (wired, same cron)", async () => {
    const db = makeTestDb();
    db.entries.push(
      { id: "lonely", content: "x", tags: "[]", source: "api", created_at: 2, vector_ids: "[]" },
      { id: "neighbor", content: "y", tags: "[]", source: "api", created_at: 1, vector_ids: "[]" },
    );
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [
          { id: "lonely", score: 1.0, metadata: { parentId: "lonely" } },
          { id: "neighbor", score: 0.8, metadata: { parentId: "neighbor" } },
        ] }),
      }),
    });
    const pending: Promise<any>[] = [];
    const ctx = { waitUntil: (p: Promise<any>) => pending.push(p) } as any;

    await (worker as any).scheduled({} as any, env, ctx);
    await Promise.allSettled(pending);

    expect(db.edges.some((e: any) => e.type === "relates_to")).toBe(true);
  });

  it("keeps other cron tasks running when vectorize-pending repair throws", async () => {
    class RepairThrowingDb extends D1Mock {
      prepare(sql: string) {
        const s = sql.replace(/\s+/g, " ").trim();
        if (s.includes("SELECT id, content, tags, source, created_at FROM entries") && s.includes("vector_ids = '[]'")) {
          throw new Error("repair query failed");
        }
        return super.prepare(sql);
      }
    }

    const db = new RepairThrowingDb();
    db.entries.push(
      { id: "lonely", content: "x", tags: "[]", source: "api", created_at: 2, vector_ids: "[]" },
      { id: "neighbor", content: "y", tags: "[]", source: "api", created_at: 1, vector_ids: "[]" },
    );
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [
          { id: "lonely", score: 1.0, metadata: { parentId: "lonely" } },
          { id: "neighbor", score: 0.8, metadata: { parentId: "neighbor" } },
        ] }),
      }),
    });
    const pending: Promise<any>[] = [];
    const ctx = { waitUntil: (p: Promise<any>) => pending.push(p) } as any;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await (worker as any).scheduled({} as any, env, ctx);
      const settled = await Promise.allSettled(pending);

      expect(settled.every(r => r.status === "fulfilled")).toBe(true);
      expect(db.edges.some((e: any) => e.type === "relates_to")).toBe(true);
      const summaries = db.usageEvents.filter((e: any) => e.operation === "cron_vectorize_pending");
      expect(summaries).toHaveLength(1);
      expect(summaries[0].status).toBe("error");
      expect(summaries[0].error).toBe("repair query failed");
      expect(JSON.parse(summaries[0].metadata)).toEqual({
        processed: 0,
        failed: 0,
        remaining: 0,
        trigger: "cron",
      });
    } finally {
      errorSpy.mockRestore();
    }
  });
});
