/**
 * Part C (05-proof.md, T-0089.5.3): the recall response carries a short, citable `receipt` -
 * the recall_log id when the log is on and this call logged, otherwise a short hash of the
 * query and the time bucket. Zero cost when the log is off: no new D1 read or write, and the
 * candidate-selection SQL is untouched (only the log write's own bound id changes).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { makeTestEnv, makeTestDb, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { writeOverrides } from "../../src/config";
import { RECALL_LOG_PER_DAY } from "../../src/constants";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (p: Promise<any>) => p } as any;

function makeMatch(id: string, score: number) {
  return { id, score, metadata: { parentId: id, isUpdate: false } };
}

async function mcpTextOf(env: Env, name: string, args: Record<string, unknown>): Promise<string> {
  const server = buildMcpServer(env, { waitUntil: (p: Promise<any>) => p } as any);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "receipt-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    return (result.content as { text?: string }[])[0]?.text ?? "";
  } finally {
    await client.close();
  }
}

describe("recall receipt", () => {
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    db.entries.push(
      { id: "e1", content: "first memory about the topic", tags: "[]", source: "api", created_at: 1000, vector_ids: "[]" },
      { id: "e2", content: "second memory about the topic", tags: "[]", source: "api", created_at: 2000, vector_ids: "[]" },
    );
  });

  function envWithMatches(overrides: Record<string, unknown> = {}) {
    return makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [makeMatch("e1", 0.9), makeMatch("e2", 0.8)] }),
      }),
      ...overrides,
    });
  }

  describe("REST, RECALL_LOG off (the default everywhere)", () => {
    it("carries a receipt on a recall with results", async () => {
      const env = envWithMatches();
      const res = await worker.fetch(req("POST", "/recall?query=the+topic"), env, ctx);
      const data = await res.json() as any;
      expect(typeof data.receipt).toBe("string");
      expect(data.receipt.length).toBeGreaterThan(0);
    });

    it("carries a receipt on a recall with no results", async () => {
      const env = envWithMatches({
        VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [] }) }),
      });
      const res = await worker.fetch(req("POST", "/recall?query=nothing+matches+this"), env, ctx);
      const data = await res.json() as any;
      expect(data.results).toEqual([]);
      expect(typeof data.receipt).toBe("string");
      expect(data.receipt.length).toBeGreaterThan(0);
    });

    it("the same query gets the same receipt moments apart; a different query gets a different one", async () => {
      const env = envWithMatches();
      const first = await (await worker.fetch(req("POST", "/recall?query=the+topic"), env, ctx)).json() as any;
      const second = await (await worker.fetch(req("POST", "/recall?query=the+topic"), env, ctx)).json() as any;
      const different = await (await worker.fetch(req("POST", "/recall?query=a+different+topic"), env, ctx)).json() as any;
      expect(second.receipt).toBe(first.receipt);
      expect(different.receipt).not.toBe(first.receipt);
    });

    it("writes no recall_log row and makes no extra D1 call for the receipt itself", async () => {
      const env = envWithMatches();
      const before = db.entries.length;
      await worker.fetch(req("POST", "/recall?query=the+topic"), env, ctx);
      // recall_log is a D1Mock-unmodeled table; the real assertion is that the log write
      // path is the existing no-op (test/unit/recall-log.test.ts pins that directly). This
      // just confirms the receipt code path does not touch the entries the mock does model.
      expect(db.entries.length).toBe(before);
    });
  });

  describe("REST, RECALL_LOG on", () => {
    async function envWithLogOn() {
      const kv = makeMemoryKV();
      const env = envWithMatches({ OAUTH_KV: kv });
      const written = await writeOverrides(env, { RECALL_LOG: "on" });
      expect(written.ok).toBe(true);
      return env;
    }

    it("the receipt is the id of the row this call logged", async () => {
      const env = await envWithLogOn();
      const res = await worker.fetch(req("POST", "/recall?query=the+topic"), env, ctx);
      const data = await res.json() as any;
      expect(typeof data.receipt).toBe("string");
      // A real recall_log id (crypto.randomUUID()), not the short hex hash the off-path uses.
      expect(data.receipt).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("still returns a receipt once the daily cap is spent and this call is not actually logged", async () => {
      const env = await envWithLogOn();
      for (let i = 0; i < RECALL_LOG_PER_DAY; i++) {
        await worker.fetch(req("POST", "/recall?query=warm+up+the+cap"), env, ctx);
      }
      const res = await worker.fetch(req("POST", "/recall?query=the+topic"), env, ctx);
      const data = await res.json() as any;
      expect(res.status).toBe(200);
      expect(typeof data.receipt).toBe("string");
      expect(data.receipt.length).toBeGreaterThan(0);
    });
  });

  describe("MCP recall", () => {
    it("the reply text names a receipt, on a recall with results", async () => {
      const env = envWithMatches();
      const text = await mcpTextOf(env, "recall", { query: "the topic" });
      expect(text).toMatch(/receipt: \S+/);
    });

    it("the reply text names a receipt, on a recall with no results", async () => {
      const env = envWithMatches({
        VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [] }) }),
      });
      const text = await mcpTextOf(env, "recall", { query: "nothing matches this" });
      expect(text).toContain("Nothing found matching that query.");
      expect(text).toMatch(/receipt: \S+/);
    });
  });
});
