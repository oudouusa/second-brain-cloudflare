/**
 * Task B1 (T-0089.2.1, spec 14 5.5 and 5.9): current recall never presents a
 * replaced fact as current, on every candidate path, and every current
 * reader and listing carries the six validity fields.
 *
 * Driven against real SQLite (test/helpers/sqlite-d1.ts) with the real
 * migration applied — the thing under test is the WHERE clause itself and
 * the exact SQL text of the six-field contract, which a substring-matching
 * mock could pass even if the real query lost the predicate (same reasoning
 * as test/integration/deprecated-stays-unindexed.test.ts).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { recallEntries } from "../../src/recall/search";
import { getConnections, buildGraph, expandGraph } from "../../src/graph/traverse";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { req } from "../helpers/make-request";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";
import type { RecallDiagnostics } from "../../src/recall/types";

async function mcpTextOf(env: Env, name: string, args: Record<string, unknown>): Promise<string> {
  const server = buildMcpServer(env, { waitUntil: (_: Promise<any>) => {} } as any);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "validity-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    return (result.content as { text?: string }[])[0]?.text ?? "";
  } finally {
    await client.close();
  }
}

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

let sqlite: SqliteD1 | null = null;
afterEach(() => { sqlite?.close(); sqlite = null; resetDatabaseInit(); });

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: s.db as unknown as Env["DB"] } as unknown as Env);
  return s;
}

function envOf(s: SqliteD1, overrides: Record<string, unknown> = {}): Env {
  return s.admitEnv(makeTestEnv(undefined, { DB: s.db as unknown as Env["DB"], ...overrides }));
}

const DAY = 86400000;
// recallEntries reads the real wall clock (Date.now()) for its validity
// predicate, so this must track it rather than a fixed constant.
const NOW = Date.now();

describe("current recall never presents a replaced fact (T-0089.2.1)", () => {
  it("excludes a replaced row on the dense arm, and admits an ended row's absence too", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "current", content: "quartz ledger current note", createdAt: NOW - 10 * DAY });
    sqlite.seed({ id: "replaced", content: "quartz ledger replaced note", createdAt: NOW - 20 * DAY, validUntil: NOW - 5 * DAY });
    sqlite.seed({ id: "ended", content: "quartz ledger ended note", createdAt: NOW - 30 * DAY, validFrom: NOW - 30 * DAY, validUntil: NOW - 15 * DAY });
    const env = envOf(sqlite, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [
            { id: "current", score: 0.9, metadata: { parentId: "current" } },
            { id: "replaced", score: 0.85, metadata: { parentId: "replaced" } },
            { id: "ended", score: 0.8, metadata: { parentId: "ended" } },
          ],
        }),
      }),
    });

    const { matches } = await recallEntries({ query: "quartz ledger", topK: 10, synthesize: false }, env, ctx);
    expect(matches.map(m => m.id)).toEqual(["current"]);
  });

  it("excludes a replaced row on the keyword LIKE arm", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "current", content: "widget shipment tracked here", createdAt: NOW - 10 * DAY });
    sqlite.seed({ id: "replaced", content: "widget shipment tracked here too", createdAt: NOW - 20 * DAY, validUntil: NOW - 5 * DAY });
    const env = envOf(sqlite, { VECTORIZE: makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("index unavailable")) }) });

    const diagnostics: RecallDiagnostics = {};
    const { matches } = await recallEntries({ query: "widget shipment", topK: 10, synthesize: false }, env, ctx, DEFAULTS, { diagnostics });
    expect(diagnostics.ftsUsed).toBe(false);
    expect(matches.map(m => m.id)).toEqual(["current"]);
  });

  it("excludes a replaced row on the FTS arm", async () => {
    sqlite = await migrated();
    resetFtsReadyMemo();
    sqlite.seed({ id: "current", content: "widget shipment tracked here", createdAt: NOW - 10 * DAY });
    sqlite.seed({ id: "replaced", content: "widget shipment tracked here too", createdAt: NOW - 20 * DAY, validUntil: NOW - 5 * DAY });
    const env = envOf(sqlite, {
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("index unavailable")) }),
      OAUTH_KV: makeMemoryKV(),
    });
    await env.OAUTH_KV!.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();

    const diagnostics: RecallDiagnostics = {};
    const { matches } = await recallEntries({ query: "widget shipment", topK: 10, synthesize: false }, env, ctx, DEFAULTS, { diagnostics });
    expect(diagnostics.ftsUsed).toBe(true);
    expect(matches.map(m => m.id)).toEqual(["current"]);
  });

  it("excludes a replaced row from the graph hop arm", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "seed", content: "seed memory", createdAt: NOW - 10 * DAY });
    sqlite.seed({ id: "current-neighbor", content: "current neighbor", createdAt: NOW - 10 * DAY });
    sqlite.seed({ id: "replaced-neighbor", content: "replaced neighbor", createdAt: NOW - 20 * DAY, validUntil: NOW - 5 * DAY });
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
       VALUES ('e1', 'seed', 'current-neighbor', 'relates_to', 0.9, 'explicit', '{}', 1, 1),
              ('e2', 'seed', 'replaced-neighbor', 'relates_to', 0.9, 'explicit', '{}', 1, 1)`,
    ).run();

    const neighbors = await expandGraph(["seed"], { hops: 1 }, envOf(sqlite), DEFAULTS);
    expect(neighbors.map(n => n.id)).toEqual(["current-neighbor"]);
  });

  it("a row whose validity is reopened (restored) is present again", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "restored", content: "quartz ledger restored note", createdAt: NOW - 20 * DAY, validUntil: NOW - 5 * DAY });
    const env = envOf(sqlite, {
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [{ id: "restored", score: 0.9, metadata: { parentId: "restored" } }] }) }),
    });

    const before = await recallEntries({ query: "quartz ledger", topK: 10, synthesize: false }, env, ctx);
    expect(before.matches.map(m => m.id)).toEqual([]);

    // Simulates the retraction restore rule reopening the row it once closed
    // (A5): valid_until goes back to NULL.
    await sqlite.db.prepare(`UPDATE entries SET valid_until = NULL WHERE id = 'restored'`).run();

    const after = await recallEntries({ query: "quartz ledger", topK: 10, synthesize: false }, env, ctx);
    expect(after.matches.map(m => m.id)).toEqual(["restored"]);
  });

  it("recall statement counts are unchanged", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "e1", content: "budget pin check", createdAt: NOW - DAY });
    const issued: string[] = [];
    const inner = sqlite.db;
    const DB = {
      prepare: (sql: string) => { issued.push(sql); return inner.prepare(sql); },
      exec: (sql: string) => inner.exec(sql),
      batch: (stmts: any[]) => inner.batch(stmts),
    };
    const env = envOf(sqlite, {
      DB: DB as unknown as Env["DB"],
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [{ id: "e1", score: 0.9, metadata: { parentId: "e1" } }] }) }),
    });
    await recallEntries({ query: "budget pin", topK: 5, synthesize: false }, env, ctx);
    // Unchanged from recall-free-tier-budget.test.ts's pinned direct-recall
    // shape: this is a smoke check that the validity predicate rode inside
    // existing statements rather than adding a new one, not a full re-pin.
    const hydrationCalls = issued.filter(s => s.includes("superseded_by_json")).length;
    expect(hydrationCalls).toBe(1);
  });
});

describe("GET /graph and connections still show replaced rows, with valid_until (5.5)", () => {
  it("getConnections includes a replaced neighbor and reports its validUntil", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "a", content: "a", createdAt: 1000 });
    sqlite.seed({ id: "b", content: "b replaced", createdAt: 1000, validUntil: 5000 });
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
       VALUES ('e1', 'a', 'b', 'relates_to', 0.9, 'explicit', '{}', 1, 1)`,
    ).run();

    const connections = await getConnections("a", undefined, envOf(sqlite), DEFAULTS);
    expect(connections.map(c => c.id)).toEqual(["b"]);
    expect(connections[0].validUntil).toBe(5000);
  });

  it("buildGraph includes a replaced node and reports its validUntil", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "a", content: "a", createdAt: 1000 });
    sqlite.seed({ id: "b", content: "b replaced", createdAt: 1000, validUntil: 5000 });
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
       VALUES ('e1', 'a', 'b', 'relates_to', 0.9, 'explicit', '{}', 1, 1)`,
    ).run();

    const graph = await buildGraph({ seed: "a" }, envOf(sqlite), DEFAULTS);
    const node = graph.nodes.find(n => n.id === "b");
    expect(node).toBeDefined();
    expect(node!.validUntil).toBe(5000);
  });
});

describe("REST validity fields (5.9)", () => {
  it("POST /recall carries the six validity fields; superseded_by names the live replacement", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "closer", content: "closer note", createdAt: NOW - 5 * DAY, validFrom: NOW - 5 * DAY });
    sqlite.seed({ id: "closed", content: "closed note", createdAt: NOW - 20 * DAY, validUntil: NOW - 5 * DAY });
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
       VALUES ('e1', 'closer', 'closed', 'supersedes', 1.0, 'system', '{}', 1, 1)`,
    ).run();
    const env = envOf(sqlite, {
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [{ id: "closer", score: 0.9, metadata: { parentId: "closer" } }] }) }),
    });

    const res = await worker.fetch(req("POST", "/recall?query=closer+note"), env, ctx);
    const data = await res.json() as any;
    const result = data.results.find((r: any) => r.id === "closer");
    expect(result).toMatchObject({
      valid_from_stated: true,
      valid_until: null,
      validity_state: "current",
      superseded_by: null,
      retracted_source: false,
    });
    expect(typeof result.valid_from).toBe("number");
  });

  it("POST /entry names the live replacement in superseded_by for a replaced row", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "closer", content: "closer note", createdAt: NOW - 5 * DAY, validFrom: NOW - 5 * DAY });
    sqlite.seed({ id: "closed", content: "closed note", createdAt: NOW - 20 * DAY, validUntil: NOW - 5 * DAY });
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
       VALUES ('e1', 'closer', 'closed', 'supersedes', 1.0, 'system', '{}', 1, 1)`,
    ).run();

    const res = await worker.fetch(req("POST", "/entry?id=closed"), envOf(sqlite), ctx);
    const data = await res.json() as any;
    expect(data.entry).toMatchObject({
      validity_state: "replaced",
      valid_until: NOW - 5 * DAY,
      superseded_by: { id: "closer", preview: "closer note" },
    });
  });

  it("GET /list carries the six validity fields", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "a", content: "a note", createdAt: 1000 });

    const res = await worker.fetch(req("GET", "/list"), envOf(sqlite), ctx);
    const data = await res.json() as any;
    expect(data[0]).toMatchObject({
      validity_state: "current",
      valid_until: null,
      superseded_by: null,
      retracted_source: false,
      valid_from_stated: false,
    });
  });
});

describe("MCP get and list_recent show the replaced bracket (5.9)", () => {
  it("get(id) shows the replaced bracket, naming the live closer and the window", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "closer", content: "closer note", createdAt: NOW - 5 * DAY, validFrom: NOW - 5 * DAY });
    sqlite.seed({ id: "closed", content: "closed note", createdAt: NOW - 20 * DAY, validUntil: NOW - 5 * DAY });
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
       VALUES ('e1', 'closer', 'closed', 'supersedes', 1.0, 'system', '{}', 1, 1)`,
    ).run();

    const text = await mcpTextOf(envOf(sqlite), "get", { id: "closed" });
    expect(text).toContain("[replaced on");
    expect(text).toContain("by closer:");
    expect(text).toContain("until");
  });

  it("get(id) shows [marked wrong] for a deprecated row", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "wrong", content: "a plan that never happened", createdAt: NOW - 5 * DAY, tags: ["status:deprecated"] });

    const text = await mcpTextOf(envOf(sqlite), "get", { id: "wrong" });
    expect(text).toContain("[marked wrong]");
  });

  it("list_recent marks a replaced row with the same bracket", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "closer", content: "closer note", createdAt: NOW - 5 * DAY, validFrom: NOW - 5 * DAY });
    sqlite.seed({ id: "closed", content: "closed note", createdAt: NOW - 20 * DAY, validUntil: NOW - 5 * DAY });
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
       VALUES ('e1', 'closer', 'closed', 'supersedes', 1.0, 'system', '{}', 1, 1)`,
    ).run();

    const text = await mcpTextOf(envOf(sqlite), "list_recent", { n: 10 });
    expect(text).toContain("[replaced on");
  });
});

describe("a stated start renders \"true since\" (5.9)", () => {
  it("recall shows true since <Mon YYYY> for a row with a stated valid_from", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "e1", content: "quartz ledger stated start", createdAt: NOW - 5 * DAY, validFrom: Date.UTC(2026, 0, 15) });
    const env = envOf(sqlite, {
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [{ id: "e1", score: 0.9, metadata: { parentId: "e1" } }] }) }),
    });

    const text = await mcpTextOf(env, "recall", { query: "quartz ledger", topK: 5 });
    expect(text).toContain("true since Jan 2026");
  });

  it("does not render a since-date for an unstated start (UNKNOWN_START)", async () => {
    sqlite = await migrated();
    // validFrom: 0 is UNKNOWN_START — an end-only fact, not a stated date.
    sqlite.seed({ id: "e1", content: "quartz ledger end-only fact", createdAt: NOW - 5 * DAY, validFrom: 0 });
    const env = envOf(sqlite, {
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [{ id: "e1", score: 0.9, metadata: { parentId: "e1" } }] }) }),
    });

    const text = await mcpTextOf(env, "recall", { query: "quartz ledger", topK: 5 });
    expect(text).not.toContain("true since");
  });
});
