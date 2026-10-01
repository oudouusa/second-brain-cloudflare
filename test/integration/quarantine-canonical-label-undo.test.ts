/**
 * W2 (16-t3-t4-trust-spec.md 5.7): "Undo reverts to the prior tags, so the label disappears with
 * the edit, and comes back on redo." Real SQLite, MCP client/server pair.
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
import { editedCanonicalAt } from "../../src/quarantine/tags";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let identity: Identity;
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

async function call(name: string, args: Record<string, unknown> = {}) {
  const server = buildMcpServer(env, ctx, identity);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "canonical-label-undo-test", version: "1" });
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

const tagsOf = (id: string) => {
  const row = sqlite.rows().find(r => r.id === id)!;
  return JSON.parse(row.tags as string) as string[];
};

describe("undo of the edit removes the label; redo restores it", () => {
  it("round-trips through undo and redo", async () => {
    sqlite.seed({ id: "e1", content: "Canonical fact.", createdAt: 1000, tags: ["status:canonical"] });

    await call("update", { id: "e1", content: "Updated canonical fact." });
    expect(editedCanonicalAt(tagsOf("e1"))).toBe(new Date().toISOString().slice(0, 10));

    await call("undo", { id: "e1" });
    expect(editedCanonicalAt(tagsOf("e1"))).toBeNull();
    expect(tagsOf("e1")).toContain("status:canonical");

    await call("undo", { id: "e1" }); // redo: undo of the undo restores the edit
    expect(editedCanonicalAt(tagsOf("e1"))).toBe(new Date().toISOString().slice(0, 10));
  });
});
