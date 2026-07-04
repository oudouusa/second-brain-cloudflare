import { describe, it, expect, beforeEach } from "vitest";
import { buildMcpServer, type Env } from "../../src/index";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function seedEntry(db: D1Mock, id: string) {
  db.entries.push({
    id,
    content: `Entry ${id}`,
    tags: "[]",
    source: "test",
    created_at: 1000,
    vector_ids: "[]",
  });
}

function pushEdge(
  db: D1Mock,
  id: string,
  source_id: string,
  target_id: string,
  type: string,
  provenance = "explicit",
  weight = 1,
) {
  db.edges.push({
    id,
    source_id,
    target_id,
    type,
    weight,
    provenance,
    metadata: "{}",
    created_at: db.edges.length + 1,
    updated_at: db.edges.length + 1,
  });
}

function getUnlinkTool(env: Env) {
  const server = buildMcpServer(env, ctx);
  return (server as any)._registeredTools.unlink.handler as (args: {
    source_id: string;
    target_id: string;
    type?: string;
  }) => Promise<{ content: { type: "text"; text: string }[] }>;
}

describe("MCP unlink tool", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
    seedEntry(db, "a");
    seedEntry(db, "b");
    seedEntry(db, "c");
  });

  it("removes only the requested edge type when type is specified", async () => {
    pushEdge(db, "ab-related", "a", "b", "relates_to", "explicit", 1);
    pushEdge(db, "ab-supersedes", "a", "b", "supersedes", "inferred", 0.4);

    const result = await getUnlinkTool(env)({ source_id: "a", target_id: "b", type: "relates_to" });

    expect(result.content[0].text).toContain("Deleted 1 edge(s)");
    expect(db.edges.map((e: any) => e.id)).toEqual(["ab-supersedes"]);
  });

  it("removes all edge types between two entries in both directions when type is omitted", async () => {
    pushEdge(db, "ab-related", "a", "b", "relates_to");
    pushEdge(db, "ab-supersedes", "a", "b", "supersedes");
    pushEdge(db, "ba-caused", "b", "a", "caused_by");
    pushEdge(db, "ac-related", "a", "c", "relates_to");

    const result = await getUnlinkTool(env)({ source_id: "a", target_id: "b" });

    expect(result.content[0].text).toContain("Deleted 3 edge(s)");
    expect(db.edges.map((e: any) => e.id)).toEqual(["ac-related"]);
  });

  it("removes an edge saved in the reverse source/target direction", async () => {
    pushEdge(db, "ba-related", "b", "a", "relates_to");

    const result = await getUnlinkTool(env)({ source_id: "a", target_id: "b", type: "relates_to" });

    expect(result.content[0].text).toContain("b -> a");
    expect(db.edges).toHaveLength(0);
  });

  it("returns a normal zero-delete response when no edge matches", async () => {
    const result = await getUnlinkTool(env)({ source_id: "a", target_id: "b", type: "relates_to" });

    expect(result.content[0].text).toContain("Deleted 0 edge(s)");
    expect(result.content[0].text).toContain("between a and b with type relates_to");
    expect(db.edges).toHaveLength(0);
  });

  it("returns a readable error when an entry ID does not exist", async () => {
    const result = await getUnlinkTool(env)({ source_id: "a", target_id: "missing" });

    expect(result.content[0].text).toBe("No entry found with ID: missing");
  });

  it("includes deleted edge type, provenance, and weight in the response", async () => {
    pushEdge(db, "edge-1", "a", "b", "supersedes", "system", 0.75);

    const result = await getUnlinkTool(env)({ source_id: "a", target_id: "b", type: "supersedes" });
    const text = result.content[0].text;

    expect(text).toContain("id: edge-1");
    expect(text).toContain("type: supersedes");
    expect(text).toContain("edge: a -> b");
    expect(text).toContain("provenance: system");
    expect(text).toContain("weight: 0.75");
  });

  it("does not add usage events or call Workers AI", async () => {
    pushEdge(db, "edge-1", "a", "b", "relates_to");
    db.usageEvents.push({ id: "usage-1", operation: "existing" });
    const beforeUsageEvents = db.usageEvents.length;

    await getUnlinkTool(env)({ source_id: "a", target_id: "b" });

    expect(db.usageEvents).toHaveLength(beforeUsageEvents);
    expect(env.AI.run).not.toHaveBeenCalled();
  });
});
