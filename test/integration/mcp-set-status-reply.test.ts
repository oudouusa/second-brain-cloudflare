/**
 * BE-12 (part of T-0101.8.2): the set_status reply names what the status
 * means, not just what it is now called — "deprecated" reads as "wrong or not
 * to be used" under 02-time-aware-truth.md, not "no longer accurate".
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../../src/mcp/server";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let identity: Identity;
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = buildMcpServer(env, ctx, identity);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "set-status-reply-test", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function call(name: string, args: Record<string, unknown>) {
  return withClient(async (client) => {
    const result = await client.callTool({ name, arguments: args });
    return String((result.content as { text?: string }[])[0]?.text ?? "");
  });
}

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  env = sqlite.admitEnv(env);
  await ensureTenantBootstrap(env);
  identity = (await resolveIdentityFromToken("test-token", env))!;
});
afterEach(() => sqlite?.close());

describe("set_status reply names the meaning", () => {
  it("deprecated: names it wrong, hidden and kept, and that undo is available", async () => {
    const id = "e-deprecated";
    sqlite.seed({ id, content: "some fact", createdAt: Date.now() });
    const text = await call("set_status", { id, status: "deprecated" });
    expect(text).toBe(`Marked memory ${id} as wrong: it is hidden from recall and kept in its history. Undo is available.`);
  });

  it("canonical: marks it trusted", async () => {
    const id = "e-canonical";
    sqlite.seed({ id, content: "some fact", createdAt: Date.now() });
    const text = await call("set_status", { id, status: "canonical" });
    expect(text).toBe(`Marked entry ${id} as trusted.`);
  });

  it("draft: marks it unconfirmed", async () => {
    const id = "e-draft";
    sqlite.seed({ id, content: "some fact", createdAt: Date.now() });
    const text = await call("set_status", { id, status: "draft" });
    expect(text).toBe(`Marked entry ${id} as unconfirmed.`);
  });

  it("the input schema is unchanged: id and status only", async () => {
    const schema = await withClient(async (client) => {
      const { tools } = await client.listTools();
      return tools.find((t) => t.name === "set_status")!.inputSchema;
    });
    expect(Object.keys((schema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["id", "status"]);
  });
});
