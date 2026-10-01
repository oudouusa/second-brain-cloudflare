import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function seedEntry(db: D1Mock, id: string, content: string, tags: string[] = []) {
  db.entries.push({ id, content, tags: JSON.stringify(tags), source: "api", created_at: 1000, vector_ids: "[]" });
}

function pushEdge(db: D1Mock, source_id: string, target_id: string, type: string, weight = 0.5) {
  db.edges.push({ id: `${source_id}-${target_id}-${type}`, source_id, target_id, type, weight, provenance: "explicit", metadata: "{}", created_at: 1, updated_at: 1 });
}

describe("POST /connections", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("POST", "/connections?id=a", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 when id is missing", async () => {
    const res = await worker.fetch(req("POST", "/connections"), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });

  it("returns the 1-hop neighbors of an entry with their edge type", async () => {
    seedEntry(db, "a", "Decision A");
    seedEntry(db, "b", "Outcome B");
    pushEdge(db, "a", "b", "relates_to", 0.7);

    const res = await worker.fetch(req("POST", "/connections?id=a"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.connections).toHaveLength(1);
    expect(data.connections[0]).toMatchObject({
      id: "b",
      content: "Outcome B",
      type: "relates_to",
      label: "Related to",
      sourceId: "a",
      targetId: "b",
      direction: "undirected",
    });
    expect(data.next_cursor).toBeNull();
  });

  it("surfaces edge provenance and when it was formed (#225)", async () => {
    seedEntry(db, "a", "Decision A");
    seedEntry(db, "b", "Auto-linked B");
    db.edges.push({ id: "a-b-relates_to", source_id: "a", target_id: "b", type: "relates_to", weight: 0.7, provenance: "inferred", metadata: "{}", created_at: 1710000000000, updated_at: 1710000000000 });

    const res = await worker.fetch(req("POST", "/connections?id=a"), env, ctx);
    const data = await res.json() as any;
    expect(data.connections[0]).toMatchObject({ id: "b", provenance: "inferred", linkedAt: 1710000000000 });
  });

  it("filters by relationship type", async () => {
    seedEntry(db, "a", "A");
    seedEntry(db, "b", "B");
    seedEntry(db, "c", "C");
    pushEdge(db, "a", "b", "relates_to");
    pushEdge(db, "a", "c", "supersedes");

    const res = await worker.fetch(req("POST", "/connections?id=a&type=supersedes"), env, ctx);
    const data = await res.json() as any;
    expect(data.connections.map((c: any) => c.id)).toEqual(["c"]);
  });

  it("filters edge type before pair deduplication", async () => {
    seedEntry(db, "a", "A");
    seedEntry(db, "b", "B");
    pushEdge(db, "a", "b", "relates_to", 0.95);
    pushEdge(db, "a", "b", "supersedes", 0.4);

    const res = await worker.fetch(req("POST", "/connections?id=a&type=supersedes"), env, ctx);
    const data = await res.json() as any;

    expect(data.connections).toHaveLength(1);
    expect(data.connections[0]).toMatchObject({ id: "b", type: "supersedes", direction: "outgoing" });
  });

  it("preserves incoming and outgoing direction for directed edges", async () => {
    seedEntry(db, "a", "Earlier decision");
    seedEntry(db, "b", "Later decision");
    pushEdge(db, "b", "a", "supersedes", 0.8);

    const fromSource = await (await worker.fetch(req("POST", "/connections?id=b"), env, ctx)).json() as any;
    const fromTarget = await (await worker.fetch(req("POST", "/connections?id=a"), env, ctx)).json() as any;

    expect(fromSource.connections[0]).toMatchObject({ sourceId: "b", targetId: "a", direction: "outgoing" });
    expect(fromTarget.connections[0]).toMatchObject({ sourceId: "b", targetId: "a", direction: "incoming" });
  });

  it("pages deterministically without dropping a connection", async () => {
    seedEntry(db, "a", "A");
    for (const [id, weight] of [["b", 0.9], ["c", 0.8], ["d", 0.7]] as const) {
      seedEntry(db, id, id.toUpperCase());
      pushEdge(db, "a", id, "relates_to", weight);
    }

    const first = await (await worker.fetch(req("POST", "/connections", { body: { id: "a", limit: 2 } }), env, ctx)).json() as any;
    expect(first.connections.map((connection: any) => connection.id)).toEqual(["b", "c"]);
    expect(first.next_cursor).toBe("c1.2");

    const second = await (await worker.fetch(req("POST", "/connections", { body: { id: "a", limit: 2, cursor: first.next_cursor } }), env, ctx)).json() as any;
    expect(second.connections.map((connection: any) => connection.id)).toEqual(["d"]);
    expect(second.next_cursor).toBeNull();
  });

  it.each([
    [{ id: "a", type: "unknown" }, "type must be one of"],
    [{ id: "a", limit: 0 }, "limit must be"],
    [{ id: "a", cursor: "2" }, "cursor is invalid"],
    [{ id: "a", cursor: "c1.10001" }, "cursor is invalid"],
  ])("rejects invalid pagination or type controls", async (body, message) => {
    seedEntry(db, "a", "A");
    const res = await worker.fetch(req("POST", "/connections", { body }), env, ctx);
    const data = await res.json() as any;
    expect(res.status).toBe(400);
    expect(data.error).toContain(message);
  });

  it("returns an empty list when there are no connections", async () => {
    seedEntry(db, "a", "A");
    const res = await worker.fetch(req("POST", "/connections?id=a"), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.connections).toEqual([]);
  });
});
