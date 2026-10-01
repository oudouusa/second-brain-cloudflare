import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../../src/index";
import { runGraphPass } from "../../src/graph/pass";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";
import { EDGE_INFERENCE_POLICY } from "../../src/graph/edges";

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

    expect(db.edges).toHaveLength(1); // unchanged, "linked" already had an edge
  });

  it("prunes inference-policy mismatches regardless of age and preserves compatible or authoritative edges", async () => {
    const now = Date.now();
    const policy = JSON.stringify({ inference_policy: EDGE_INFERENCE_POLICY });
    for (const [id, tags] of Object.entries({
      a: ["project-a"], b: ["project-b"], c: ["project-c"], d: ["project-a"], e: ["project-e"], f: ["project-f"],
    })) {
      db.entries.push({ id, content: id, tags: JSON.stringify(tags), source: "api", created_at: 1, vector_ids: "[]" });
    }
    db.edges.push(
      { id: "below-floor", source_id: "a", target_id: "b", type: "relates_to", weight: 0.2, provenance: "inferred", metadata: policy, created_at: now, updated_at: now },
      { id: "weak-explicit", source_id: "a", target_id: "c", type: "relates_to", weight: 0.2, provenance: "explicit", metadata: "{}", created_at: now, updated_at: now },
      { id: "shared-mid", source_id: "a", target_id: "d", type: "relates_to", weight: 0.55, provenance: "inferred", metadata: policy, created_at: now, updated_at: now },
      { id: "mismatched-mid", source_id: "a", target_id: "f", type: "relates_to", weight: 0.69, provenance: "inferred", metadata: policy, created_at: now, updated_at: now },
      { id: "strong", source_id: "a", target_id: "e", type: "relates_to", weight: 0.9, provenance: "inferred", metadata: policy, created_at: now, updated_at: now },
    );
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock() });
    const { ctx } = makeCtx();

    await runGraphPass(env, ctx);

    expect(db.edges.map((x: any) => x.id).sort()).toEqual(["shared-mid", "strong", "weak-explicit"]);
  });

  it("recomputes legacy-policy inferred edges and stamps the new policy", async () => {
    db.entries.push(
      { id: "legacy-a", content: "Second brain graph", tags: JSON.stringify(["second-brain"]), source: "api", created_at: 2, vector_ids: "[]" },
      { id: "legacy-b", content: "Old unrelated candidate", tags: JSON.stringify(["upwork"]), source: "api", created_at: 1, vector_ids: "[]" },
      { id: "fresh", content: "Current graph implementation", tags: JSON.stringify(["second-brain"]), source: "api", created_at: 0, vector_ids: "[]" },
    );
    db.edges.push({
      id: "legacy-edge", source_id: "legacy-a", target_id: "legacy-b", type: "relates_to",
      weight: 0.68, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1,
    });
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [
          { id: "fresh", score: 0.58, metadata: { parentId: "fresh" } },
        ] }),
      }),
    });
    const { ctx } = makeCtx();

    await runGraphPass(env, ctx);

    expect(db.edges.map((edge: any) => edge.id)).not.toContain("legacy-edge");
    expect(db.edges.length).toBeGreaterThan(0);
    expect(db.edges.every((edge: any) => JSON.parse(edge.metadata).inference_policy === EDGE_INFERENCE_POLICY)).toBe(true);
  });

  it("is a safe no-op on an empty database", async () => {
    const env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock() });
    const { ctx } = makeCtx();
    await expect(runGraphPass(env, ctx)).resolves.toEqual({ inserted: 0 });
    expect(db.edges).toHaveLength(0);
  });

  it("reports committed inference changes after deduplicating symmetric pairs", async () => {
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

    // Both candidates describe the same symmetric pair. The existing batched
    // inference policy deduplicates it before SQL, so one change is committed.
    await expect(runGraphPass(env, ctx)).resolves.toEqual({ inserted: 1 });
  });
});

describe("scheduled handler", () => {
  it("runs the graph pass on the shared nightly maintenance cron", async () => {
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

    await (worker as any).scheduled({ cron: "0 1 * * *" } as any, env, ctx);
    await Promise.allSettled(pending);

    expect(db.edges.some((e: any) => e.type === "relates_to")).toBe(true);
  });
});
