/**
 * BE-11 (T-0101.3.1): the MCP `history` tool lists versions, not just events — contract 4.1's
 * merged changes-and-events, rendered as readable fields instead of a raw payload dump. Real
 * SQLite: versions are written through the actual MCP `update`/`share` tools.
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
import { createMember } from "../../src/lib/team-admin";
import { VERSIONS_SINCE_KV_KEY } from "../../src/constants";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

async function call(name: string, args: Record<string, unknown> = {}, user: Identity | null = owner) {
  const server = buildMcpServer(env, ctx, user ?? undefined);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-history-versions-test", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    return String((result.content as { text?: string }[])[0]?.text ?? "");
  } finally {
    await client.close();
    await server.close();
  }
}

async function member(name: string, role: "admin" | "member" = "member"): Promise<Identity> {
  const { token } = await createMember(env, { name, role });
  return (await resolveIdentityFromToken(token, env))!;
}

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  env = sqlite.admitEnv(env);
  const roots = await ensureTenantBootstrap(env);
  owner = (await resolveIdentityFromToken("test-token", env))!;
  void roots;
});
afterEach(() => sqlite.close());

describe("history() lists versions", () => {
  it("lists versions with before text and client", async () => {
    sqlite.seed({ id: "e1", content: "first text", createdAt: 1000 });
    await call("update", { id: "e1", content: "second text" });

    const text = await call("history", { id: "e1" });
    expect(text).toContain("Changes (newest first):");
    expect(text).toContain('before: "first text"');
    expect(text).toContain("edited");
    expect(text).toContain("via an AI tool");
  });

  it("no JSON payload dump", async () => {
    sqlite.seed({ id: "e2", content: "v0", createdAt: 1000 });
    await call("update", { id: "e2", content: "v1" });
    const text = await call("history", { id: "e2" });
    expect(text).not.toMatch(/\{"channel":/);
    expect(text).not.toContain('"seq":');
  });

  it("no em dash", async () => {
    sqlite.seed({ id: "e3", content: "v0", createdAt: 1000 });
    await call("update", { id: "e3", content: "v1" });
    const text = await call("history", { id: "e3" });
    expect(text).not.toContain("—");
  });

  it("description no longer says earlier text is not recorded before 4.0", async () => {
    const server = buildMcpServer(env, ctx, owner);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "desc-test", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const { tools } = await client.listTools();
    const description = tools.find(t => t.name === "history")?.description ?? "";
    expect(description).not.toContain("Earlier text is not recorded before 4.0");
    expect(description).toContain("wants an older version back");
    await client.close();
    await server.close();
  });

  it("footers appear only when true", async () => {
    await env.OAUTH_KV.put(VERSIONS_SINCE_KV_KEY, "1");
    sqlite.seed({ id: "e4", content: "v0", createdAt: Date.now() });
    const text = await call("history", { id: "e4" });
    expect(text).not.toContain("Older changes are not kept");
    expect(text).not.toContain("were not recorded");
    expect(text).not.toContain("Earlier history belongs to");
  });

  it("pruned footer appears after enough edits", async () => {
    sqlite.seed({ id: "e5", content: "v0", createdAt: 1000 });
    for (let i = 1; i <= 23; i++) await call("update", { id: "e5", content: `v${i}` });
    const text = await call("history", { id: "e5" });
    expect(text).toContain("Older changes are not kept (the last 20 are).");
  });

  it("teammate cut matches GET /entry", async () => {
    const author = await member("Bob");
    const { token: teammateToken } = await createMember(env, { name: "Carla" });
    const teammate = (await resolveIdentityFromToken(teammateToken, env))!;
    sqlite.seed({ id: "e6", content: "state0", createdAt: 100 });
    await sqlite.db.prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'e6'`)
      .bind(author.personalWorkspaceId, author.userId).run();
    await call("update", { id: "e6", content: "state1" }, author);
    await call("share", { id: "e6", workspace: "company" }, author);
    await call("update", { id: "e6", content: "state2" }, author);

    const mcpText = await call("history", { id: "e6" }, teammate);
    expect(mcpText).toContain("Earlier history belongs to Bob.");
    expect(mcpText).not.toContain('before: "state0"');

    const res = await worker.fetch(req("POST", "/entry?id=e6", { token: teammateToken }), env, ctx);
    const data = await res.json() as any;
    expect(data.entry.history.footer.shared_cut_by).toBe("Bob");
  });
});
