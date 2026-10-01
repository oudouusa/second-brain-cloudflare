// 4.0.0: 履歴・undo・brief・standing・validityのschemaを取り込み再固定。
// 3.5.0: remember/appendのwhen・when_kindを共有schemaへ追加したため再固定。
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../../src/mcp/server";
import { makeTestEnv } from "../helpers/make-env";

// Captured from main@a500d0a's actual tools/list BEFORE changing descriptions.
// Remove exactly two descriptions, not all descriptions or schemas. This makes
// accidental changes to any other field/tool observable while allowing the
// explicitly requested prompt-policy change. It is NOT a model-behavior eval.
// 4.0.0のstanding/validity/historyに加え、長文保留のschema上限3箇所をレビュー済み。
const UNAFFECTED_TOOLS_SHA256 = "33c0ad6b8278bc76728190c387283ad8195eaa888cecfd14c5ab8e1cc2312af9";

async function listTools() {
  const env = makeTestEnv();
  const server = buildMcpServer(env, { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "instruction-policy-test", version: "1.0.0" });
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP instruction policy agrees with the copyable client policy", () => {
  it("preserves every other tool field, registration order and schema byte-for-byte", async () => {
    const tools = await listTools();
    const unaffected = tools.map(tool => {
      if (!["recall", "remember"].includes(tool.name)) return tool;
      const { description: _description, ...rest } = tool;
      return rest;
    });
    expect(createHash("sha256").update(JSON.stringify(unaffected)).digest("hex"))
      .toBe(UNAFFECTED_TOOLS_SHA256);
  });

  it("advertises missing-context retrieval and reuse rather than a fixed message schedule", async () => {
    const tools = await listTools();
    const description = tools.find(tool => tool.name === "recall")!.description!;
    expect(description).toContain("missing prior context could change the answer");
    expect(description).toContain("otherwise reuse current context or earlier results");
    expect(description).not.toMatch(/start of every conversation|every 3-4 messages/);
    // Existing advice about interpreting evidence and truncated output survives.
    expect(description).toContain("rank 1 is a candidate, not a guarantee");
    expect(description).toContain("TRUNCATION");
  });

  it("advertises authorized selective writes, exclusions and explicit visibility", async () => {
    const tools = await listTools();
    const description = tools.find(tool => tool.name === "remember")!.description!;
    expect(description).toContain("existing storage authorization");
    expect(description).toContain("do not save every response or intermediate proposal");
    expect(description).toContain("unconfirmed idea only when requested");
    expect(description).toContain("Respect exclusions and never store credentials");
    expect(description).toContain('workspace: "personal" unless company storage is authorized');
    expect(description).not.toContain("Call this automatically, without asking permission");
    expect(description).toContain("Do not ask again for each note already covered");
  });
});
