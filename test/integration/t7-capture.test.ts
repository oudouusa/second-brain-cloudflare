/**
 * Standing/decision/commitment capture (Task 7, T-0089.7.1/.2/.3): every reply
 * string in the Chat table for set, cap, too long, decision (with and without
 * confidence), inbound and outbound, plus every validation error and the
 * standing cache invalidation this task owns.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";
import { STANDING_MAX_CHARS } from "../../src/constants";

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any,
    drain: () => Promise.allSettled(pending),
  };
}

describe("POST /capture — standing", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("saves a standing instruction and replies with the Chat table's wording", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", {
      body: { content: "When choosing a database, prefer boring, proven technology (Postgres or SQLite) over new systems.", standing: true },
    }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.message).toBe(`Saved as a standing instruction. It will come up when this topic does, in any AI tool. ID: ${data.id}`);
    expect(JSON.parse(db.entries[0].tags)).toContain("standing:active");
  });

  it("saves as an ordinary memory when over STANDING_MAX_CHARS, and says so", async () => {
    const { ctx } = makeCtx();
    const long = "x".repeat(STANDING_MAX_CHARS + 1);
    const res = await worker.fetch(req("POST", "/capture", { body: { content: long, standing: true } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.message).toBe(`Saved as an ordinary memory: a standing instruction must be under 500 characters. ID: ${data.id}`);
    expect(JSON.parse(db.entries[0].tags)).not.toContain("standing:active");
  });

  it("saves as an ordinary memory at the cap, and says so", async () => {
    const { ctx } = makeCtx();
    // Seed 50 existing standing rows in the caller's (legacy '') workspace.
    for (let i = 0; i < 50; i++) {
      db.entries.push({
        id: `existing-${i}`, content: `standing ${i}`, tags: JSON.stringify(["standing:active"]),
        source: "api", created_at: i, vector_ids: "[]", workspace_id: "", actor_id: "",
      });
    }
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "When X, do Y.", standing: true } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.message).toBe(`Standing memory limit reached; this was saved as an ordinary memory. Stop an old one to make room. ID: ${data.id}`);
    const stored = db.entries.find((e: any) => e.id === data.id);
    expect(JSON.parse(stored.tags)).not.toContain("standing:active");
  });

  it("refuses standing combined with a decision or a commitment", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "x", standing: true, decision: true } }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toBe("A decision can't also be a standing instruction or a commitment. Nothing was saved.");
    expect(db.entries).toHaveLength(0);
  });

  it("a caller-supplied standing:active tag is ignored and reported, with the specific note", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "an ordinary note", tags: ["standing:active"] } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.message).toBe('Note: the tag "standing:active" was ignored; use standing: true.');
    expect(JSON.parse(db.entries[0].tags)).not.toContain("standing:active");
  });

  it("schedules a standing cache build with the known vector after capture", async () => {
    const { ctx, drain } = makeCtx();
    const putSpy = vi.fn(env.OAUTH_KV.put.bind(env.OAUTH_KV));
    env.OAUTH_KV.put = putSpy as any;
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "When X happens, do Y.", standing: true } }), env, ctx);
    expect(res.status).toBe(200);
    await drain();
    const standingPuts = putSpy.mock.calls.filter(call => (call[0] as string).startsWith("standing:v1:"));
    expect(standingPuts.length).toBeGreaterThan(0);
  });
});

describe("POST /capture — decision", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("logs a decision with stated confidence, in one INSERT", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", {
      body: { content: "Decided to hire Dana for the design lead role.", decision: true, confidence: 0.7, confidence_source: "stated" },
    }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.message).toMatch(/^Logged the decision\. I'll bring it up for review around .+\. ID: .+ \(confidence 0\.7, stated\)$/);
    const tags: string[] = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("ledger:decision");
    expect(tags).toContain("confidence:0.70");
    expect(tags).toContain("confidence-source:stated");
    expect(db.entries[0].when_kind).toBe("due");
    expect(db.entries[0].when_source).toBe("explicit");
    // NIT (review): when_label must actually be written, not just computed and discarded.
    expect(db.entries[0].when_label).toBe("Decided to hire Dana for the design lead role");
  });

  it("logs a decision with no confidence, and never implies a question was asked", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "We're going with Postgres.", decision: true } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.message).toMatch(/^Logged the decision\. I'll bring it up for review around .+\. ID: .+$/);
    expect(data.message).not.toContain("confidence");
    const tags: string[] = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("ledger:decision");
    expect(tags.some(t => t.startsWith("confidence:"))).toBe(false);
  });

  it("defaults review to +90 days when neither review_by nor when is given", async () => {
    const { ctx } = makeCtx();
    const before = Date.now();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "Decided to switch to TypeScript.", decision: true } }), env, ctx);
    expect(res.status).toBe(200);
    const whenAt = db.entries[0].when_at as number;
    const days = (whenAt - before) / 86400000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
  });

  it("rejects confidence without decision: true", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "x", confidence: 0.7 } }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toBe("confidence and review_by only work with decision: true. Nothing was saved.");
    expect(db.entries).toHaveLength(0);
  });

  it("rejects review_by and when both given", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", {
      body: { content: "x", decision: true, review_by: "2027-01-01", when: "2027-02-01" },
    }), env, ctx);
    expect(res.status).toBe(400);
    expect(db.entries).toHaveLength(0);
  });

  it("clamps an out-of-range confidence and rounds to the nearest 0.05", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", {
      body: { content: "x", decision: true, confidence: 0.98, confidence_source: "stated" },
    }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.message).toContain("confidence 0.95 — the ledger's maximum, stated");
    expect(JSON.parse(db.entries[0].tags)).toContain("confidence:0.95");
  });
});

describe("POST /capture — commitments", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("owed_by: inbound, task + owed-to-me + counterparty, when_kind defaults to due", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", {
      body: { content: "Priya: send the signed contract", owed_by: "Priya", when: "2026-09-01" },
    }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.message).toBe(`Tracking it as owed to you by Priya, due Sep 1. ID: ${data.id}`);
    const tags: string[] = JSON.parse(db.entries[0].tags);
    expect(tags.sort()).toEqual(["counterparty:priya", "owed-to-me", "task"].sort());
    expect(db.entries[0].when_kind).toBe("due");
  });

  it("owed_to: outbound, task + counterparty, no owed-to-me", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", {
      body: { content: "I owe Sam the deck", owed_to: "Sam", when: "2026-08-10" },
    }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.message).toBe(`Tracking it as something you owe Sam, due Aug 10. ID: ${data.id}`);
    const tags: string[] = JSON.parse(db.entries[0].tags);
    expect(tags.sort()).toEqual(["counterparty:sam", "task"].sort());
  });

  it("refuses owed_by and owed_to both given", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "x", owed_by: "Priya", owed_to: "Sam" } }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toBe("Use owed_by or owed_to, not both. Nothing was saved.");
    expect(db.entries).toHaveLength(0);
  });
});

describe("REST /capture and MCP remember parity (workerd-free, in-process)", () => {
  it("produce identical rows for the same standing capture", async () => {
    const dbRest = makeTestDb();
    const envRest = makeTestEnv(dbRest);
    const { ctx } = makeCtx();
    await worker.fetch(req("POST", "/capture", { body: { content: "When X, do Y.", standing: true } }), envRest, ctx);

    const { buildMcpServer } = await import("../../src/mcp/server");
    const { Client } = await import("@modelcontextprotocol/client");
    const { InMemoryTransport } = await import("@modelcontextprotocol/client");
    const dbMcp = makeTestDb();
    const envMcp = makeTestEnv(dbMcp);
    const server = buildMcpServer(envMcp, ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    await client.callTool({ name: "remember", arguments: { content: "When X, do Y.", standing: true } });
    await client.close();

    expect(JSON.parse(dbRest.entries[0].tags)).toEqual(JSON.parse(dbMcp.entries[0].tags));
  });
});
