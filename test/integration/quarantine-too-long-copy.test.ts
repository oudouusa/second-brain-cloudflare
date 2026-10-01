/**
 * Copy deck section 9 (T-0089.4.2, replacing the withdrawn pending-scan design): the too_long
 * hold gets its own reply text, distinct from the generic held template -- it tells the reader
 * what to do (read it, release it if fine) and how to avoid the hold (save it shorter), not that
 * a check is running. Real SQLite, MCP client/server pair, and the REST route directly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../../src/mcp/server";
import worker from "../../src/index";
import { req } from "../helpers/make-request";
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

async function call(name: string, args: Record<string, unknown> = {}) {
  const server = buildMcpServer(env, ctx, identity);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "too-long-copy-test", version: "1" });
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
afterEach(() => sqlite.close());

const HEAD = 24 * 1024;
const TAIL = 8 * 1024;
const benignLongContent = () => "x".repeat(HEAD + TAIL + 2000);

describe("MCP remember reply for a too_long hold", () => {
  it("uses the copy deck's too_long copy, not the generic held template", async () => {
    const text = await call("remember", { content: benignLongContent() });
    expect(text).toBe(
      `Stored. ID: ${text.match(/ID: ([0-9a-f-]{36})/)?.[1]}. Held out of search: it is too long to check automatically for hidden `
      + "instructions. Ask the user to read it in the dashboard and release it if it's fine. Saving "
      + "it as shorter memories (about 5,000 words or less each) avoids the hold.",
    );
    expect(text).not.toContain("held out of recall");
    expect(text).not.toContain("nightly check");
  });
});

describe("MCP get held line for a too_long hold", () => {
  it("shows the read-then-release line", async () => {
    const remember = await call("remember", { content: benignLongContent() });
    const id = remember.match(/ID: ([0-9a-f-]{36})/)?.[1]!;
    const text = await call("get", { id });
    expect(text.startsWith("held: too long to check automatically; read it, then release it if it's fine\n")).toBe(true);
  });
});

describe("REST POST /capture for a too_long hold", () => {
  it("returns held.reason 'too_long' and the copy deck's REST message", async () => {
    const res = await worker.fetch(req("POST", "/capture", { body: { content: benignLongContent() } }), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.held).toEqual({ reason: "too_long" });
    expect(data.message).toBe(
      "Saved, but held out of search because it is too long to check automatically. Read it and "
      + "release it if it's fine. Shorter memories (about 5,000 words or less) are not held.",
    );
  });
});
