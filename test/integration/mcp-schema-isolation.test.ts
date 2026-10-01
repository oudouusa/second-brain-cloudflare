import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../../src/mcp/server";
import type { Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";

it("共通スキーマを使う同時接続でも本文・hot context・入力検査を利用者間で混ぜない", async () => {
  const sqlite = makeSqliteD1();
  const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
  const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;
  const clients: Client[] = [];
  try {
    for (const user of ["alice", "bob"]) {
      await sqlite.db.prepare(
        "INSERT INTO entries(id,content,tags,source,created_at,workspace_id,actor_id,memory_tier,pinned) VALUES(?,?,?,'test',?,?,?,'hot',1)",
      ).bind(user, `${user}専用の記憶`, '["kind:semantic"]', Date.now(), `personal-${user}`, user).run();
      const identity: Identity = {
        userId: user, role: "member", personalWorkspaceId: `personal-${user}`,
        companyWorkspaceIds: [], defaultShare: "personal",
      };
      const server = buildMcpServer(env, ctx, identity);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: user, version: "1" });
      clients.push(client);
      await Promise.all([client.connect(ct), server.connect(st)]);
    }
    const resultText = (result: Awaited<ReturnType<Client["callTool"]>>) =>
      JSON.stringify(result.content);
    const firstLists = await Promise.all(clients.map(client => client.listTools()));
    expect(firstLists[0]).toEqual(firstLists[1]);
    for (const [index, user] of ["alice", "bob"].entries()) {
      const other = user === "alice" ? "bob" : "alice";
      const [own, foreign, hot, invalid] = await Promise.all([
        clients[index].callTool({ name: "get", arguments: { id: user } }),
        clients[index].callTool({ name: "get", arguments: { id: other } }),
        clients[index].callTool({ name: "get_hot_context", arguments: {} }),
        clients[index].callTool({ name: "recall", arguments: { query: "記憶", topK: 0 } }),
      ]);
      expect(resultText(own)).toContain(`${user}専用の記憶`);
      expect(resultText(foreign)).not.toContain(`${other}専用の記憶`);
      expect(resultText(hot)).toContain(`${user}専用の記憶`);
      expect(resultText(hot)).not.toContain(`${other}専用の記憶`);
      expect(invalid.isError).toBe(true);
    }
    // 並行検査でdefaultやエラーが共通スキーマの公開内容を変えない。
    expect(await clients[0].listTools()).toEqual(firstLists[0]);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    sqlite.close();
  }
});
