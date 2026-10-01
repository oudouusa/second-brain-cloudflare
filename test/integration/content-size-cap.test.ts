/**
 * Rahil's decision (18-copy-deck.md section 6.8): a single saved note is capped at 128 KB
 * (131,072 bytes), measured as the stored content's UTF-8 byte length. Applied on every write
 * path that takes note content: REST /capture, /append, /update; MCP remember, append, update.
 * Tested at exactly the limit (must succeed) and one byte over (must be refused).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { MAX_CONTENT_BYTES } from "../../src/lib/content-size";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const AT_LIMIT = "a".repeat(MAX_CONTENT_BYTES);
const OVER_LIMIT = "a".repeat(MAX_CONTENT_BYTES + 1);

let sqlite: SqliteD1;
let env: Env;
let identity: Identity;

async function mcpCall(name: string, args: Record<string, unknown> = {}) {
  const server = buildMcpServer(env, ctx, identity);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "content-size-test", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    return String((result.content as { text?: string }[])[0]?.text ?? "");
  } finally {
    await client.close();
    await server.close();
  }
}

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);
  identity = (await resolveIdentityFromToken("test-token", env))!;
});
afterEach(() => sqlite?.close());

describe("REST POST /capture size cap", () => {
  it("accepts content at exactly the limit", async () => {
    const res = await worker.fetch(req("POST", "/capture", { body: { content: AT_LIMIT } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
  });

  it("refuses content one byte over the limit with 413 and the too_large body", async () => {
    const res = await worker.fetch(req("POST", "/capture", { body: { content: OVER_LIMIT } }), env, ctx);
    expect(res.status).toBe(413);
    const data = await res.json() as any;
    expect(data).toEqual({
      ok: false, error: "too_large", limit_bytes: MAX_CONTENT_BYTES,
      message: "Too long to save as one memory: the limit is about 20,000 words. Nothing was saved. Split it into smaller memories.",
    });
    expect(sqlite.rows()).toEqual([]);
  });
});

describe("REST POST /update size cap", () => {
  it("accepts replacement content at exactly the limit", async () => {
    sqlite.seed({ id: "e1", content: "original", createdAt: Date.now() });
    const res = await worker.fetch(req("POST", "/update", { body: { id: "e1", content: AT_LIMIT } }), env, ctx);
    expect(res.status).toBe(200);
  });

  it("refuses replacement content one byte over the limit", async () => {
    sqlite.seed({ id: "e1", content: "original", createdAt: Date.now() });
    const res = await worker.fetch(req("POST", "/update", { body: { id: "e1", content: OVER_LIMIT } }), env, ctx);
    expect(res.status).toBe(413);
    const data = await res.json() as any;
    expect(data.error).toBe("too_large");
    const row = sqlite.rows().find((r: any) => r.id === "e1")!;
    expect(row.content).toBe("original");
  });
});

describe("REST POST /append size cap (checks the resulting total)", () => {
  it("accepts a small addition to content well under the limit", async () => {
    sqlite.seed({ id: "e1", content: "original", createdAt: Date.now() });
    const res = await worker.fetch(req("POST", "/append", { body: { id: "e1", addition: "more" } }), env, ctx);
    expect(res.status).toBe(200);
  });

  it("refuses when the existing content plus the addition would exceed the limit", async () => {
    sqlite.seed({ id: "e1", content: AT_LIMIT, createdAt: Date.now() });
    const res = await worker.fetch(req("POST", "/append", { body: { id: "e1", addition: "one more byte" } }), env, ctx);
    expect(res.status).toBe(413);
    const data = await res.json() as any;
    expect(data.error).toBe("too_large");
    const row = sqlite.rows().find((r: any) => r.id === "e1")!;
    expect(row.content).toBe(AT_LIMIT);
  });

  it("accepts when existing plus addition sums to exactly the limit", async () => {
    sqlite.seed({ id: "e1", content: "a".repeat(MAX_CONTENT_BYTES - 5), tags: ["quarantine:too_long", "status:draft"], createdAt: Date.now() });
    const res = await worker.fetch(req("POST", "/append", { body: { id: "e1", addition: "bbbbb" } }), env, ctx);
    expect(res.status).toBe(200);
  });

  it("refuses when existing plus addition sums to one byte over the limit", async () => {
    sqlite.seed({ id: "e1", content: "a".repeat(MAX_CONTENT_BYTES - 5), tags: ["quarantine:too_long", "status:draft"], createdAt: Date.now() });
    const res = await worker.fetch(req("POST", "/append", { body: { id: "e1", addition: "bbbbbb" } }), env, ctx);
    expect(res.status).toBe(413);
  });
});

describe("MCP remember size cap", () => {
  it("accepts content at exactly the limit", async () => {
    const text = await mcpCall("remember", { content: AT_LIMIT });
    expect(text).toMatch(/^Stored\./);
  });

  it("refuses content one byte over the limit", async () => {
    const text = await mcpCall("remember", { content: OVER_LIMIT });
    expect(text).toBe("Not saved: this is too long for one memory (the limit is about 20,000 words). Split it into smaller memories and save each one.");
    expect(sqlite.rows()).toEqual([]);
  });
});

describe("MCP update size cap", () => {
  it("refuses content one byte over the limit", async () => {
    sqlite.seed({ id: "e1", content: "original", createdAt: Date.now() });
    const text = await mcpCall("update", { id: "e1", content: OVER_LIMIT });
    expect(text).toBe("Not saved: this is too long for one memory (the limit is about 20,000 words). Split it into smaller memories and save each one.");
    const row = sqlite.rows().find((r: any) => r.id === "e1")!;
    expect(row.content).toBe("original");
  });
});

describe("MCP append size cap (checks the resulting total, and reads \"Not added\")", () => {
  it("refuses when the existing content plus the addition would exceed the limit", async () => {
    sqlite.seed({ id: "e1", content: AT_LIMIT, createdAt: Date.now() });
    const text = await mcpCall("append", { id: "e1", addition: "one more byte" });
    expect(text).toBe("Not added: the memory would be too long (the limit is about 20,000 words). Save the new text as a separate memory.");
    const row = sqlite.rows().find((r: any) => r.id === "e1")!;
    expect(row.content).toBe(AT_LIMIT);
  });
});
