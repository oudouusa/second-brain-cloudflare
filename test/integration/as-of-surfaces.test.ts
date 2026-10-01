/**
 * Task B4 (T-0089.2.2, spec 14 5.9): as_of on MCP recall and GET /recall — the header, per-result
 * markers, belief block, refusal of a future or unparseable date, and REST/MCP parity.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { buildMcpServer, RECALL_DESCRIPTION } from "../../src/mcp/server";
import worker from "../../src/index";
import { req } from "../helpers/make-request";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { insertVersion, insertSupersedesEdge } from "../helpers/as-of-fixtures";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;
let sqlite: SqliteD1 | null = null;
afterEach(() => { sqlite?.close(); sqlite = null; resetDatabaseInit(); });

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: s.db as unknown as Env["DB"] } as unknown as Env);
  return s;
}

function envOf(s: SqliteD1, matches: { id: string; score: number }[]): Env {
  return s.admitEnv(makeTestEnv(undefined, {
    DB: s.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: matches.map(m => ({ id: m.id, score: m.score, metadata: { parentId: m.id } })) }) }),
  }));
}

async function mcpRecall(env: Env, args: Record<string, unknown>): Promise<string> {
  const server = buildMcpServer(env, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "as-of-surfaces-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name: "recall", arguments: args });
    return (result.content as { text?: string }[])[0]?.text ?? "";
  } finally {
    await client.close();
  }
}

const DAY = 86400000;
const NOW = Date.now();

/** current + old (its own true window still shown at T) + wrong-new (retracted belief, attached to old). */
async function seedScenario(s: SqliteD1): Promise<{ retractedAt: number; changedAt: number }> {
  s.seed({ id: "current", content: "kayak trip route along the river", createdAt: NOW - 40 * DAY });
  const changedAt = NOW - 15 * DAY;
  s.seed({ id: "old", content: "cellar plan: wine racks along the east wall", createdAt: NOW - 40 * DAY });
  insertVersion(s, { entryId: "old", seq: 1, content: "cellar plan: wine racks along the north wall", createdAt: changedAt });
  s.seed({ id: "wrong-new", content: "cellar plan: wine racks along the west wall", createdAt: NOW - 30 * DAY, validUntil: NOW - 10 * DAY });
  s.db.prepare(`UPDATE entries SET tags = '["status:deprecated"]' WHERE id = 'wrong-new'`).run();
  insertSupersedesEdge(s, "edge-1", "wrong-new", "old", NOW - 30 * DAY);
  const retractedAt = NOW - 10 * DAY;
  insertVersion(s, { entryId: "wrong-new", seq: 1, content: "cellar plan: wine racks along the west wall", tags: [], createdAt: retractedAt, reason: "status" });
  return { retractedAt, changedAt };
}

describe("as-of surfaces: MCP recall and GET /recall (5.9)", () => {
  it("MCP as_of renders the header, markers and belief block exactly as specified", async () => {
    sqlite = await migrated();
    await seedScenario(sqlite);
    const env = envOf(sqlite, [{ id: "current", score: 0.9 }, { id: "old", score: 0.5 }]);

    const asOf = NOW - 20 * DAY; // between wrong-new's supersede and its own retraction
    const text = await mcpRecall(env, { query: "cellar wine racks kayak river", as_of: new Date(asOf).toISOString().slice(0, 10) });

    expect(text).toContain("what was true then, with every correction made since");
    expect(text).toContain("cellar plan: wine racks along the north wall");
    expect(text).toMatch(/since changed, see history/);
    expect(text).toContain("Believed then, later retracted");
    expect(text).toContain("cellar plan: wine racks along the west wall".slice(0, 40));
  });

  it("REST as_of returns the as_of object and per-result fields", async () => {
    sqlite = await migrated();
    const { retractedAt, changedAt } = await seedScenario(sqlite);
    const env = envOf(sqlite, [{ id: "current", score: 0.9 }, { id: "old", score: 0.5 }]);

    const asOf = NOW - 20 * DAY;
    const res = await worker.fetch(req("POST", `/recall?query=${encodeURIComponent("cellar wine racks kayak river")}&as_of=${encodeURIComponent(new Date(asOf).toISOString().slice(0, 10))}`), env, ctx);
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.as_of).toBeTruthy();
    expect(data.as_of.at).toBeTypeOf("number");
    const old = data.results.find((r: any) => r.id === "old");
    expect(old.as_of_text_changed_at).toBe(changedAt);
    expect(old.status_at).toBeNull();
    const belief = data.results.find((r: any) => r.id === "wrong-new");
    expect(belief.retracted_belief).toEqual({ retracted_at: retractedAt, attached_to: "old" });
  });

  it("future as_of is refused on both surfaces", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "e1", content: "marina slip reserved for the season", createdAt: NOW - 10 * DAY });
    const env = envOf(sqlite, [{ id: "e1", score: 0.9 }]);

    const future = new Date(NOW + 30 * DAY).toISOString().slice(0, 10);
    const mcpText = await mcpRecall(env, { query: "marina slip", as_of: future });
    expect(mcpText.toLowerCase()).toMatch(/future/);

    const res = await worker.fetch(req("POST", `/recall?query=marina+slip&as_of=${future}`), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });

  it("unparseable as_of is refused on both surfaces", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "e1", content: "marina slip reserved for the season", createdAt: NOW - 10 * DAY });
    const env = envOf(sqlite, [{ id: "e1", score: 0.9 }]);

    const mcpText = await mcpRecall(env, { query: "marina slip", as_of: "not a date" });
    expect(mcpText.toLowerCase()).toMatch(/date/);

    const res = await worker.fetch(req("POST", `/recall?query=marina+slip&as_of=not-a-date`), env, ctx);
    expect(res.status).toBe(400);
  });

  it("as_of combined with after or before is refused on both surfaces (review NIT)", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "e1", content: "marina slip reserved for the season", createdAt: NOW - 10 * DAY });
    const env = envOf(sqlite, [{ id: "e1", score: 0.9 }]);
    const isoDate = new Date(NOW - 5 * DAY).toISOString().slice(0, 10);

    const mcpText = await mcpRecall(env, { query: "marina slip", as_of: isoDate, after: NOW - 30 * DAY });
    expect(mcpText).toBe("Pass as_of, or after/before, not both.");
    expect(mcpText).not.toContain("—");

    const res = await worker.fetch(req("POST", `/recall?query=marina+slip&as_of=${isoDate}&after=${NOW - 30 * DAY}`), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toBe("Pass as_of, or after/before, not both.");
  });

  it("REST and MCP return the same ids in the same order", async () => {
    sqlite = await migrated();
    await seedScenario(sqlite);
    const asOf = NOW - 20 * DAY;
    const isoDate = new Date(asOf).toISOString().slice(0, 10);

    // Only the top-level (actually-true) results: an attached belief renders as its own "ID: X"
    // line under REST's flat array, but nested inline (no top-level "ID:" line of its own) under
    // MCP's text, by design (5.9: "a belief attached to a result is rendered under it").
    const envForMcp = envOf(sqlite, [{ id: "current", score: 0.9 }, { id: "old", score: 0.5 }]);
    const mcpText = await mcpRecall(envForMcp, { query: "cellar wine racks kayak river", as_of: isoDate });
    const mcpIds = [...mcpText.matchAll(/^ID: (\S+)$/gm)].map(m => m[1]);

    const envForRest = envOf(sqlite, [{ id: "current", score: 0.9 }, { id: "old", score: 0.5 }]);
    const res = await worker.fetch(req("POST", `/recall?query=${encodeURIComponent("cellar wine racks kayak river")}&as_of=${isoDate}`), envForRest, ctx);
    const data = await res.json() as any;
    const restIds = data.results.filter((r: any) => !r.retracted_belief).map((r: any) => r.id);

    expect(mcpIds).toEqual(restIds);
  });

  it("the description contains the AS OF section", () => {
    expect(RECALL_DESCRIPTION).toMatch(/AS OF\./);
    expect(RECALL_DESCRIPTION).toMatch(/as_of/);
    expect(RECALL_DESCRIPTION).toMatch(/never ranks? above|never the answer/i);
  });

  it("no em dash in any new string (MCP text or REST JSON)", async () => {
    sqlite = await migrated();
    await seedScenario(sqlite);
    const asOf = NOW - 20 * DAY;
    const isoDate = new Date(asOf).toISOString().slice(0, 10);

    const envForMcp = envOf(sqlite, [{ id: "current", score: 0.9 }, { id: "old", score: 0.5 }]);
    const mcpText = await mcpRecall(envForMcp, { query: "cellar wine racks kayak river", as_of: isoDate });
    expect(mcpText).not.toContain("—");
    // Only the AS OF section is new here; the rest of RECALL_DESCRIPTION predates this task and
    // is out of scope (the repo-wide no-em-dash guard, test/unit/no-em-dash-replies.test.ts,
    // is itself scoped to reply text, not tool descriptions).
    const asOfSection = RECALL_DESCRIPTION.slice(RECALL_DESCRIPTION.indexOf("AS OF."), RECALL_DESCRIPTION.indexOf("CHOOSE ON FIT."));
    expect(asOfSection).not.toBe("");
    expect(asOfSection).not.toContain("—");

    const envForRest = envOf(sqlite, [{ id: "current", score: 0.9 }, { id: "old", score: 0.5 }]);
    const res = await worker.fetch(req("POST", `/recall?query=${encodeURIComponent("cellar wine racks kayak river")}&as_of=${isoDate}`), envForRest, ctx);
    const raw = await res.text();
    expect(raw).not.toContain("—");
  });
});
