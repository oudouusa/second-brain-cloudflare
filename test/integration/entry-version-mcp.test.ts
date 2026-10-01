/**
 * BE-8 (T-0101.1.1, T-0101.3.2): MCP get(id, version) and REST GET /entry/version agree, and
 * get without version is unchanged. Real SQLite: versions are written through the actual MCP
 * `update` tool, not hand-seeded, so the version row is exactly what a real edit leaves behind.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

async function call(name: string, args: Record<string, unknown> = {}, user: Identity | null = identity) {
  const server = buildMcpServer(env, ctx, user ?? undefined);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "entry-version-test", version: "1" });
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
  env = sqlite.admitEnv(env);
  await ensureTenantBootstrap(env);
  identity = (await resolveIdentityFromToken("test-token", env))!;
});
afterEach(() => sqlite.close());

describe("get(id, version)", () => {
  it("履歴本文はURLパラメータ付きGETで取得できない", async () => {
    const response = await worker.fetch(req("GET", "/entry/version?id=private-id&seq=1"), env, ctx);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(await response.text()).not.toContain("private-id");
  });

  it.each([null, [], { id: "" }, { id: "e", seq: "1" }, { id: "e", seq: 0 }, { id: "e", seq: 1.5 }])("不正な履歴JSONを拒否する: %j", async body => {
    const response = await worker.fetch(req("POST", "/entry/version", { body }), env, ctx);
    expect(response.status).toBe(400);
  });

  it("履歴読取にも認証と8KB本文上限を適用する", async () => {
    const denied = await worker.fetch(req("POST", "/entry/version", { token: null, body: { id: "e", seq: 1 } }), env, ctx);
    expect(denied.status).toBe(401);
    const oversized = await worker.fetch(req("POST", "/entry/version", { body: { id: "x".repeat(8192), seq: 1 } }), env, ctx);
    expect(oversized.status).toBe(413);
  });

  it("reads the text before the change, with reason, actor and via", async () => {
    sqlite.seed({ id: "e1", content: "first text", createdAt: 1000 });
    await call("update", { id: "e1", content: "second text" });

    const text = await call("get", { id: "e1", version: 1 });
    expect(text).toContain("first text");
    // The version was written through the MCP update tool, so its channel is mcp.
    expect(text).toContain("update by You via an AI tool");
    expect(text).toContain("ID: e1");
  });

  it("get without version is byte-identical to today", async () => {
    sqlite.seed({ id: "e2", content: "current text", createdAt: 1000, tags: ["work"] });
    const withoutVersion = await call("get", { id: "e2" });
    expect(withoutVersion).toContain("current text");
    expect(withoutVersion).not.toContain("version");
  });

  it("no_version for a seq that was never recorded", async () => {
    sqlite.seed({ id: "e3", content: "x", createdAt: 1000 });
    const text = await call("get", { id: "e3", version: 5 });
    expect(text).toBe("Entry e3 has no version 5.");
  });

  it("not_visible for an unknown id", async () => {
    const text = await call("get", { id: "ghost", version: 1 });
    expect(text).toBe("No version 1 of entry ghost is visible to you.");
  });

  it("pruned for a seq below the oldest kept version", async () => {
    sqlite.seed({ id: "e4", content: "v0", createdAt: 1000 });
    for (let i = 1; i <= 23; i++) await call("update", { id: "e4", content: `v${i}` });
    const text = await call("get", { id: "e4", version: 1 });
    expect(text).toContain("is no longer kept");
    expect(text).toContain("The oldest kept is version");
  });

  it("REST and MCP return the same text for the same seq", async () => {
    sqlite.seed({ id: "e5", content: "shared text", createdAt: 1000 });
    await call("update", { id: "e5", content: "changed text" });

    const mcpText = await call("get", { id: "e5", version: 1 });
    const res = await worker.fetch(req("POST", "/entry/version?id=e5&seq=1"), env, ctx);
    const rest = await res.json() as any;
    expect(mcpText).toContain(rest.content);
    expect(rest.content).toBe("shared text");
  });
});
