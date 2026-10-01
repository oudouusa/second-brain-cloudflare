import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";
import { createEdge } from "../../src/graph/edges";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function seedEntry(db: D1Mock, id: string, content: string, tags: string[] = [], importance = 0) {
  db.entries.push({ id, content, tags: JSON.stringify(tags), source: "api", created_at: 1000, vector_ids: "[]", importance_score: importance });
}

function pushEdge(db: D1Mock, source_id: string, target_id: string, type = "relates_to", weight = 0.7) {
  db.edges.push({ id: `${source_id}-${target_id}-${type}`, source_id, target_id, type, weight, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1 });
}

describe("GET /graph", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("GET", "/graph", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns nodes and the edges among them, with kind and status annotations", async () => {
    seedEntry(db, "a", "Memory A", ["kind:semantic"]);
    seedEntry(db, "b", "Memory B", ["kind:episodic", "status:deprecated"]);
    pushEdge(db, "a", "b");

    const res = await worker.fetch(req("GET", "/graph"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.nodes.map((n: any) => n.id).sort()).toEqual(["a", "b"]);
    const a = data.nodes.find((n: any) => n.id === "a");
    expect(a).toMatchObject({ kind: "semantic", status: null, label: "Memory A" });
    const b = data.nodes.find((n: any) => n.id === "b");
    expect(b).toMatchObject({ kind: "episodic", status: "deprecated" });
    expect(data.edges).toEqual([{ source: "a", target: "b", type: "relates_to", weight: 0.7, provenance: "inferred" }]);
  });

  it("leaves machine-authored entries out of the graph", async () => {
    // auto-pattern, auto-insight and synthesized entries are written by the pattern-mining
    // (now insight) and compression passes — the brain's notes about itself. Recall
    // already excludes them and the dashboard reviews them in their own queue.
    seedEntry(db, "e1", "A memory", ["cycling"]);
    seedEntry(db, "e2", "A mined pattern", ["auto-pattern"]);
    seedEntry(db, "e3", "A nightly digest", ["synthesized"]);
    // rolled-up marks the person's own memory as folded into a digest; it stays.
    seedEntry(db, "e4", "A folded memory", ["cycling", "rolled-up"]);
    seedEntry(db, "e5", "A proposed insight", ["auto-insight"]);
    // all five are edged, so exclusion has to come from the tag rather than from
    // having nothing to attach to
    pushEdge(db, "e1", "e2");
    pushEdge(db, "e2", "e3");
    pushEdge(db, "e1", "e4");
    pushEdge(db, "e1", "e5");

    const res = await worker.fetch(req("GET", "/graph"), env, ctx);
    const data = await res.json() as any;
    expect(data.nodes.map((n: any) => n.id).sort()).toEqual(["e1", "e4"]);
  });

  it("never returns dangling edges (an endpoint missing from the node set)", async () => {
    seedEntry(db, "a", "Memory A");
    seedEntry(db, "b", "Memory B");
    pushEdge(db, "a", "b");
    pushEdge(db, "a", "ghost"); // ghost has no entry row

    const res = await worker.fetch(req("GET", "/graph"), env, ctx);
    const data = await res.json() as any;
    expect(data.nodes.map((n: any) => n.id).sort()).toEqual(["a", "b"]);
    expect(data.edges).toHaveLength(1);
    expect(data.edges[0]).toMatchObject({ source: "a", target: "b" });
  });

  it("returns the neighborhood of a seed when ?seed= is given", async () => {
    seedEntry(db, "seed", "Seed");
    seedEntry(db, "n1", "One hop");
    seedEntry(db, "n2", "Two hops");
    seedEntry(db, "far", "Unconnected");
    pushEdge(db, "seed", "n1");
    pushEdge(db, "n1", "n2");

    const res = await worker.fetch(req("POST", "/graph?seed=seed"), env, ctx);
    const data = await res.json() as any;
    expect(data.nodes.map((n: any) => n.id).sort()).toEqual(["n1", "n2", "seed"]);
    expect(data.nodes.map((n: any) => n.id)).not.toContain("far");
  });

  it("returns the whole graph by default — no node cap", async () => {
    for (let i = 0; i < 250; i++) seedEntry(db, `n${i}`, `Memory ${i}`);
    for (let i = 0; i < 249; i++) pushEdge(db, `n${i}`, `n${i + 1}`);

    const res = await worker.fetch(req("GET", "/graph"), env, ctx);
    const data = await res.json() as any;
    expect(data.nodes).toHaveLength(250);
    expect(data.edges).toHaveLength(249);
  });

  it("returns a drawn_from edge from the graph read", async () => {
    // Inserted through createEdge — the validated path a writer actually uses —
    // rather than the raw pushEdge fixture: pushEdge writes straight into
    // db.edges with no type check, so it would show the edge in the read
    // whether or not drawn_from is registered and prove nothing about the
    // registry entry this type depends on.
    seedEntry(db, "i1", "An insight", ["work"]);
    seedEntry(db, "m1", "A source memory", ["work"]);
    const created = await createEdge("i1", "m1", "drawn_from", { provenance: "system", readableWorkspaceIds: db.entries.map((e: any) => e.workspace_id ?? "") }, env);
    expect(created).not.toBeNull();

    const res = await worker.fetch(req("GET", "/graph"), env, ctx);
    const data = await res.json() as any;
    expect(data.edges.some((e: any) => e.type === "drawn_from")).toBe(true);
  });

  it("still honors an explicit ?limit=", async () => {
    for (let i = 0; i < 10; i++) seedEntry(db, `n${i}`, `Memory ${i}`);
    for (let i = 0; i < 9; i++) pushEdge(db, `n${i}`, `n${i + 1}`);

    const res = await worker.fetch(req("GET", "/graph?limit=4"), env, ctx);
    const data = await res.json() as any;
    expect(data.nodes).toHaveLength(4);
  });
});
