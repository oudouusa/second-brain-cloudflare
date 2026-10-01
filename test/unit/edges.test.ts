import { describe, it, expect, beforeEach } from "vitest";
import {
  createEdge,
  decideInferredEdge,
  edgeInsertStatement,
  inferEdgesOnWrite,
  isValidEdgeType,
  isSymmetric,
  edgeLabel,
  replaceInferredEdgesOnWrite,
} from "../../src/graph/edges";
import { expandGraph } from "../../src/graph/traverse";
import { getConnections } from "../../src/graph/traverse";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

/** The endpoints these unit tests link, seeded live in the legacy '' workspace the actor can read. */
const R = [""];
const seedEndpoints = (db: D1Mock) => { for (const id of ["a", "b", "alpha", "zeta", "new", "old"]) db.entries.push({ id, content: id, tags: "[]", workspace_id: "" }); };

function edge(source_id: string, target_id: string, weight = 0.5, type = "relates_to") {
  return { id: `${source_id}-${target_id}`, source_id, target_id, type, weight, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1 };
}

describe("edge-type registry", () => {
  it("validates known edge types and rejects unknown ones", () => {
    expect(isValidEdgeType("relates_to")).toBe(true);
    expect(isValidEdgeType("supersedes")).toBe(true);
    expect(isValidEdgeType("bogus")).toBe(false);
  });

  it("treats relates_to as symmetric and supersedes as directed", () => {
    expect(isSymmetric("relates_to")).toBe(true);
    expect(isSymmetric("supersedes")).toBe(false);
  });

  it("registers drawn_from as a valid, directed type for insight provenance", () => {
    expect(isValidEdgeType("drawn_from")).toBe(true);
    expect(isSymmetric("drawn_from" as any)).toBe(false);
    expect(edgeLabel("drawn_from" as any)).toBe("Drawn from");
  });
});

describe("createEdge", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
    seedEndpoints(db);
  });

  it("rejects a self-link and writes nothing", async () => {
    const result = await createEdge("a", "a", "relates_to", { readableWorkspaceIds: R }, env);
    expect(result).toBeNull();
    expect(db.edges).toHaveLength(0);
  });

  it("rejects an unknown edge type and writes nothing", async () => {
    const result = await createEdge("a", "b", "bogus", { readableWorkspaceIds: R }, env);
    expect(result).toBeNull();
    expect(db.edges).toHaveLength(0);
  });

  it("orders symmetric edges smaller-id-first so A→B and B→A collapse to one row", async () => {
    await createEdge("zeta", "alpha", "relates_to", { readableWorkspaceIds: R }, env);
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0].source_id).toBe("alpha");
    expect(db.edges[0].target_id).toBe("zeta");

    // Reverse direction is the same logical edge — must not create a second row.
    await createEdge("alpha", "zeta", "relates_to", { readableWorkspaceIds: R }, env);
    expect(db.edges).toHaveLength(1);
  });

  it("preserves direction for directed edge types", async () => {
    await createEdge("new", "old", "supersedes", { readableWorkspaceIds: R }, env);
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0].source_id).toBe("new");
    expect(db.edges[0].target_id).toBe("old");
  });

  it("is idempotent and keeps the higher weight on re-link", async () => {
    await createEdge("a", "b", "relates_to", { readableWorkspaceIds: R, weight: 0.4 }, env);
    await createEdge("a", "b", "relates_to", { readableWorkspaceIds: R, weight: 0.9 }, env);
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0].weight).toBe(0.9);

    // A weaker re-link must not lower the stored weight.
    await createEdge("a", "b", "relates_to", { readableWorkspaceIds: R, weight: 0.2 }, env);
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0].weight).toBe(0.9);
  });

  it("stores provenance and metadata", async () => {
    await createEdge("a", "b", "relates_to", { readableWorkspaceIds: R, provenance: "explicit", metadata: { note: "hi" } }, env);
    expect(db.edges[0].provenance).toBe("explicit");
    expect(JSON.parse(db.edges[0].metadata)).toEqual({ note: "hi" });
  });

  it("preserves a custom created_at on insert", async () => {
    await createEdge("a", "b", "relates_to", { readableWorkspaceIds: R, created_at: 42_000 }, env);
    expect(db.edges[0].created_at).toBe(42_000);
  });
});

describe("edgeInsertStatement()", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
    seedEndpoints(db);
  });

  it("returns a statement instead of running it", () => {
    const stmt = edgeInsertStatement("a", "b", "drawn_from", { readableWorkspaceIds: R, provenance: "system" }, env);
    expect(stmt).not.toBeNull();
    // Nothing written until the caller runs or batches it.
    expect(db.edges).toHaveLength(0);
  });

  it("refuses an unknown type and a self-edge, exactly as createEdge does", () => {
    expect(edgeInsertStatement("a", "b", "not_a_type", { readableWorkspaceIds: R }, env)).toBeNull();
    expect(edgeInsertStatement("a", "a", "drawn_from", { readableWorkspaceIds: R }, env)).toBeNull();
  });

  it("reorders a symmetric type smaller-id-first, same as createEdge", async () => {
    const stmt = edgeInsertStatement("zeta", "alpha", "relates_to", { readableWorkspaceIds: R }, env);
    expect(stmt).not.toBeNull();
    await stmt!.run();
    expect(db.edges[0].source_id).toBe("alpha");
    expect(db.edges[0].target_id).toBe("zeta");
  });

  it("clamps the weight to [0, 1], same as createEdge", async () => {
    const stmt = edgeInsertStatement("a", "b", "relates_to", { readableWorkspaceIds: R, weight: 5 }, env);
    await stmt!.run();
    expect(db.edges[0].weight).toBe(1);
  });

  it("when run, writes the same row createEdge would", async () => {
    const stmt = edgeInsertStatement("a", "b", "drawn_from", { readableWorkspaceIds: R, provenance: "system", weight: 0.9 }, env);
    await stmt!.run();
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0]).toMatchObject({ source_id: "a", target_id: "b", type: "drawn_from", weight: 0.9, provenance: "system" });
  });
});

describe("expandGraph", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns nothing at hop 0", async () => {
    db.edges.push(edge("a", "b"));
    expect(await expandGraph(["a"], { hops: 0 }, env)).toEqual([]);
  });

  it("finds 1-hop neighbors regardless of edge direction", async () => {
    db.edges.push(edge("a", "b", 0.6), edge("c", "a", 0.7)); // a as source, then a as target
    const out = await expandGraph(["a"], { hops: 1 }, env);
    expect(out.map(n => n.id).sort()).toEqual(["b", "c"]);
    expect(out.every(n => n.hop === 1)).toBe(true);
  });

  it("keeps stored direction while traversing directed and undirected edges", async () => {
    db.edges.push(
      edge("a", "b", 0.8, "supersedes"),
      edge("c", "a", 0.7, "caused_by"),
      edge("a", "d", 0.6, "relates_to"),
    );

    const out = await expandGraph(["a"], { hops: 1 }, env);
    const byId = new Map(out.map(neighbor => [neighbor.id, neighbor]));

    expect(byId.get("b")).toMatchObject({ viaSourceId: "a", viaTargetId: "b", viaDirection: "outgoing" });
    expect(byId.get("c")).toMatchObject({ viaSourceId: "c", viaTargetId: "a", viaDirection: "incoming" });
    expect(byId.get("d")).toMatchObject({ viaSourceId: "a", viaTargetId: "d", viaDirection: "undirected" });
  });

  it("never returns a seed node", async () => {
    db.edges.push(edge("a", "b"));
    const out = await expandGraph(["a", "b"], { hops: 1 }, env);
    expect(out).toHaveLength(0);
  });

  it("optionally exposes edges among seeds for recall reinforcement", async () => {
    db.edges.push(edge("a", "b", 0.9, "follows"));

    const out = await expandGraph(["a", "b"], { hops: 1, includeSeedNeighbors: true }, env);

    expect(out.map(neighbor => neighbor.id).sort()).toEqual(["a", "b"]);
    expect(out).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "b", viaFrom: "a", viaDirection: "outgoing" }),
      expect.objectContaining({ id: "a", viaFrom: "b", viaDirection: "incoming" }),
    ]));
  });

  it("skips status:deprecated neighbors by default", async () => {
    db.entries.push({ id: "b", content: "x", tags: JSON.stringify(["status:deprecated"]), source: "api", created_at: 1, vector_ids: "[]" });
    db.edges.push(edge("a", "b", 0.9), edge("a", "c", 0.8));
    const out = await expandGraph(["a"], { hops: 1 }, env);
    expect(out.map(n => n.id)).toEqual(["c"]);
  });

  it("reaches 2-hop nodes when hops allows", async () => {
    db.edges.push(edge("a", "b"), edge("b", "c"));
    const out = await expandGraph(["a"], { hops: 2 }, env);
    const byId = Object.fromEntries(out.map(n => [n.id, n.hop]));
    expect(byId).toEqual({ b: 1, c: 2 });
  });

  it("keeps each frontier node's fanout when one hub has far more strong edges", async () => {
    for (let i = 0; i < 8; i++) db.edges.push(edge("root", `frontier-${i}`, 1 - i / 100));
    for (let i = 0; i < 140; i++) db.edges.push(edge("frontier-0", `hub-${i}`, 0.9 - i / 1000));
    for (let i = 1; i < 8; i++) db.edges.push(edge(`frontier-${i}`, `leaf-${i}`, 0.4));

    const out = await expandGraph(["root"], { hops: 2, fanoutCap: 8, maxNodes: 100 }, env);

    for (let i = 1; i < 8; i++) expect(out.map(row => row.id)).toContain(`leaf-${i}`);
    expect(out.filter(row => row.id.startsWith("hub-")).length).toBe(7);
  });

  it("filters the legacy connections API before node dedupe and keeps direction", async () => {
    db.entries.push(
      { id: "a", content: "A", tags: "[]", source: "api", created_at: 1, vector_ids: "[]" },
      { id: "b", content: "B", tags: "[]", source: "api", created_at: 2, vector_ids: "[]" },
    );
    db.edges.push(
      edge("a", "b", 0.95, "relates_to"),
      edge("a", "b", 0.4, "supersedes"),
    );

    const connections = await getConnections("a", "supersedes", env);

    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      id: "b",
      type: "supersedes",
      sourceId: "a",
      targetId: "b",
      direction: "outgoing",
    });
  });
});

describe("inferEdgesOnWrite", () => {
  let env: Env;
  let db: D1Mock;

  /**
   * Inference refuses a neighbour with no `entries` row, so every id a case
   * expects to be linked needs one. Seeded with no workspace and no kind, the
   * pre-tenancy shape, so these cases still say only what they always said.
   */
  function present(...ids: string[]): void {
    for (const id of ids) {
      db.entries.push({
        id, content: `entry ${id}`, tags: "[]", source: "api",
        created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0,
      });
    }
  }

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  function seed(...rows: { id: string; tags?: string[] }[]) {
    for (const row of rows) {
      db.entries.push({
        id: row.id, content: row.id, tags: JSON.stringify(row.tags ?? []), source: "api",
        created_at: 1, vector_ids: "[]",
      });
    }
  }

  it("auto-links only genuinely-related neighbors, not loose keyword-overlap ones", async () => {
    seed({ id: "new" }, { id: "strong" }, { id: "loose" }, { id: "weak" });
    await inferEdgesOnWrite("new", [
      { id: "strong", score: 0.84 }, // clearly related — link
      { id: "loose", score: 0.4 },   // shares a keyword but stays below the calibrated floor
      { id: "weak", score: 0.2 },    // unrelated
    ], env);
    expect(db.edges).toHaveLength(1);
    const linked = db.edges.flatMap((e: any) => [e.source_id, e.target_id]).filter((id: string) => id !== "new");
    expect(linked).toEqual(["strong"]);
    expect(db.edges[0].type).toBe("relates_to");
    expect(db.edges[0].provenance).toBe("inferred");
  });

  /**
   * A neighbour with no `entries` row is a vector that outlived its entry. The
   * edge it produces is unreachable — every graph read hydrates both endpoints
   * and drops what is missing — and the nightly sweep deletes it, which returns
   * the source to the backfill's slate to have it drawn again.
   */
  it("refuses a neighbour that has no entries row", async () => {
    present("new", "real");

    await inferEdgesOnWrite("new", [{ id: "ghost", score: 0.95 }, { id: "real", score: 0.84 }], env);

    const linked = db.edges.flatMap((e: any) => [e.source_id, e.target_id]).filter((id: string) => id !== "new");
    expect(linked).toEqual(["real"]);
  });

  it("never links the new entry to itself", async () => {
    seed({ id: "new" }, { id: "a" });
    await inferEdgesOnWrite("new", [{ id: "new", score: 0.99 }, { id: "a", score: 0.8 }], env);
    expect(db.edges).toHaveLength(1);
    expect([db.edges[0].source_id, db.edges[0].target_id].sort()).toEqual(["a", "new"]);
  });

  it("caps at the top 3 strongest neighbors", async () => {
    seed({ id: "new" }, ...["a", "b", "c", "d", "e"].map(id => ({ id })));
    await inferEdgesOnWrite("new", [
      { id: "a", score: 0.9 }, { id: "b", score: 0.85 }, { id: "c", score: 0.8 },
      { id: "d", score: 0.75 }, { id: "e", score: 0.7 },
    ], env);
    expect(db.edges).toHaveLength(3);
    const linked = db.edges.flatMap((e: any) => [e.source_id, e.target_id]).filter((id: string) => id !== "new");
    expect(linked.sort()).toEqual(["a", "b", "c"]);
  });

  it("uses the similarity score as the edge weight", async () => {
    seed({ id: "new" }, { id: "a" });
    await inferEdgesOnWrite("new", [{ id: "a", score: 0.82 }], env);
    expect(db.edges[0].weight).toBeCloseTo(0.82);
  });

  it("writes nothing when there are no qualifying neighbors", async () => {
    seed({ id: "new" }, { id: "a" });
    await inferEdgesOnWrite("new", [{ id: "a", score: 0.3 }], env);
    expect(db.edges).toHaveLength(0);
  });

  it("admits Gemma's calibrated lower band only for a shared concrete project tag", async () => {
    seed(
      { id: "new", tags: ["work", "second-brain"] },
      { id: "same-project", tags: ["context", "second-brain"] },
      { id: "generic-only", tags: ["work"] },
      { id: "other-project", tags: ["work", "upwork"] },
    );
    await inferEdgesOnWrite("new", [
      { id: "same-project", score: 0.55 },
      { id: "generic-only", score: 0.69 },
      { id: "other-project", score: 0.69 },
    ], env);

    expect(db.edges).toHaveLength(1);
    expect([db.edges[0].source_id, db.edges[0].target_id].sort()).toEqual(["new", "same-project"].sort());
    expect(JSON.parse(db.edges[0].metadata)).toMatchObject({
      inference_policy: "embeddinggemma-mrl128-v2",
      basis: "shared-topic-tag",
      shared_topic_tags: ["second-brain"],
    });
  });

  it("does not treat mandated axis tags as project compatibility", () => {
    expect(decideInferredEdge(0.69, ["work", "task"], ["work", "context"]).eligible).toBe(false);
    expect(decideInferredEdge(0.70, ["work"], ["personal"]).eligible).toBe(true);
  });

  it("replaces stale inferred relates_to edges while preserving explicit and typed edges", async () => {
    seed({ id: "entry", tags: ["second-brain"] }, { id: "old" }, { id: "fresh", tags: ["second-brain"] }, { id: "explicit" });
    db.edges.push(
      { ...edge("entry", "old", 0.8), id: "old-inferred" },
      { ...edge("entry", "explicit", 0.5), id: "explicit", provenance: "explicit" },
      { ...edge("entry", "old", 1, "supersedes"), id: "typed", provenance: "system" },
    );

    await replaceInferredEdgesOnWrite([
      { entryId: "entry", neighbors: [{ id: "fresh", score: 0.55 }] },
    ], env);

    expect(db.edges.map((item: any) => item.id)).not.toContain("old-inferred");
    expect(db.edges.some((item: any) => item.provenance === "explicit")).toBe(true);
    expect(db.edges.some((item: any) => item.type === "supersedes")).toBe(true);
    expect(db.edges.some((item: any) => item.type === "relates_to"
      && [item.source_id, item.target_id].includes("fresh") && item.provenance === "inferred")).toBe(true);
  });
});
