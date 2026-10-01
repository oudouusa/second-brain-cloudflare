import { afterEach } from "vitest";
import { chatGptResponse, mockChatGptFetch } from "../helpers/chatgpt-provider";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { makeMemoryKV, makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { req } from "../helpers/make-request";
import { processPendingVectorization, processPendingClassification } from "../../src/capture/pending";
import { readWorkersAiHealth } from "../../src/lib/ai";
import { resolveIdentityFromToken } from "../../src/lib/identity";
import type { Env } from "../../src/env";

const quotaError = () => new Error(
  "4006: you have used up your daily free allocation of 10,000 neurons",
);

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as unknown as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

async function withMcpClient(env: Env, ctx: ExecutionContext, run: (client: Client) => Promise<void>) {
  const identity = env.CHATGPT_OWNER_WORKSPACE_ID ? await resolveIdentityFromToken(env.AUTH_TOKEN, env) : undefined;
  const server = buildMcpServer(env, ctx, identity ?? undefined);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "quota-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

function seedEntry(db: ReturnType<typeof makeTestDb>) {
  db.entries.push({
    id: "quota-entry",
    content: "findable quota fallback memory",
    tags: "[]",
    source: "api",
    created_at: Date.now(),
    updated_at: Date.now(),
    vector_ids: '["quota-entry"]',
    recall_count: 0,
    importance_score: 0,
    contradiction_wins: 0,
    contradiction_losses: 0,
  });
}

describe("Workers AI daily quota fallback", () => {
  it("recall falls back to keyword-only and never exposes raw provider code 4006", async () => {
    const db = makeTestDb();
    seedEntry(db);
    const vectorQuery = vi.fn();
    const aiRun = vi.fn().mockRejectedValue(quotaError());
    const env = makeTestEnv(db, {
      AI: { run: aiRun } as unknown as Ai,
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({ query: vectorQuery }),
    });
    const { ctx } = makeCtx();

    const response = await worker.fetch(req("POST", "/recall?query=findable+quota"), env, ctx);
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.results.map((entry: any) => entry.id)).toContain("quota-entry");
    expect(body.semantic_unavailable).toBe(true);
    expect(body.semantic_unavailable_reason).toBe("workers_ai_quota_exhausted");
    expect(body.semantic_retry_at).toEqual(expect.any(Number));
    expect(JSON.stringify(body)).not.toContain("4006");
    expect(vectorQuery).not.toHaveBeenCalled();

    const callsAfterObservation = aiRun.mock.calls.length;
    const repeated = await worker.fetch(req("POST", "/recall?query=findable+quota"), env, ctx);
    expect(repeated.status).toBe(200);
    expect(aiRun).toHaveBeenCalledTimes(callsAfterObservation);
  });

  it("new capture commits D1 with vector_ids=[] and defers AI work", async () => {
    const db = makeTestDb();
    const aiRun = vi.fn().mockRejectedValue(quotaError());
    const upsert = vi.fn();
    const insert = vi.fn();
    const env = makeTestEnv(db, {
      AI: { run: aiRun } as unknown as Ai,
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({ upsert, insert }),
    });
    const { ctx, drain } = makeCtx();

    const response = await worker.fetch(req("POST", "/capture", {
      body: { content: "save this even while embeddings are unavailable" },
    }), env, ctx);
    await drain();
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      semantic_unavailable: true,
      semantic_unavailable_reason: "workers_ai_quota_exhausted",
      classification_pending: true,
    });
    expect(body.message).toContain("/vectorize-pending");
    expect(body.message).toContain("/classify-pending");
    expect(body.message).toContain("09:00 JST");
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].vector_ids).toBe("[]");
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(upsert).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it.each([false, true])("埋め込み枯渇中も外部分類を実行し、外部障害=%sなら未分類を保持して回復する", async (directFails) => {
    const db = makeTestDb();
    const aiRun = vi.fn().mockRejectedValue(quotaError());
    const directFetch = mockChatGptFetch(vi.fn().mockImplementation(async () => chatGptResponse('{"importance":4,"canonical":false,"kind":"semantic"}', "stop", directFails ? 503 : 200)));
    const env = makeTestEnv(db, {
      AI: { run: aiRun } as unknown as Ai,
      OAUTH_KV: makeMemoryKV(),
      CHATGPT_OPERATIONS: "classify",
    });
    env.CHATGPT_OWNER_WORKSPACE_ID = (await resolveIdentityFromToken(env.AUTH_TOKEN, env))!.personalWorkspaceId;
    const { ctx, drain } = makeCtx();
    const response = await worker.fetch(req("POST", "/capture", {
      body: { content: "quota external classification recovery", workspace: "personal" },
    }), env, ctx);
    const body = await response.json() as any;
    await drain();
    expect(body).toMatchObject({ ok: true, semantic_unavailable: true, classification_pending: false, classification_status: "scheduled" });
    expect(body.message).toContain("keyword-searchable");
    expect(body.message).toContain("scheduled separately");
    expect(directFetch).toHaveBeenCalledTimes(1);
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].vector_ids).toBe("[]");
    expect(String(db.entries[0].tags).includes("kind:semantic")).toBe(!directFails);
    expect(await readWorkersAiHealth(env)).toMatchObject({ status: "quota_exhausted" });

    // 外部経路の回復だけではWorkers AIの枯渇マーカーを消さない。
    directFails = false;
    const classified = await processPendingClassification(env);
    expect(classified.failed).toBe(0);
    expect(classified.remaining).toBe(0);
    expect(await readWorkersAiHealth(env)).toMatchObject({ status: "quota_exhausted" });
    expect(aiRun).toHaveBeenCalledTimes(1);
    const original = db.entries[0].content;
    const tags = db.entries[0].tags;
    const now = Date.now() + 600_000;
    const deferred = await processPendingVectorization(env, { now, limit: 1 });
    expect(deferred).toMatchObject({ processed: 0, failed: 1, remaining: 1 });
    expect(aiRun).toHaveBeenCalledTimes(2);
    aiRun.mockResolvedValue({ data: [new Array(768).fill(0.1)] });
    const recovered = await processPendingVectorization(env, { now, limit: 1 });
    expect(recovered).toMatchObject({ processed: 1, failed: 0, remaining: 0 });
    expect(db.entries[0].content).toBe(original);
    expect(db.entries[0].tags).toBe(tags);
    expect(db.entries[0].vector_ids).not.toBe("[]");
    const calls = aiRun.mock.calls.length;
    expect(await processPendingVectorization(env, { now, limit: 1 })).toMatchObject({ processed: 0, remaining: 0 });
    expect(aiRun).toHaveBeenCalledTimes(calls);
  });

  it("MCPも外部分類の受付と索引待ちを区別する", async () => {
    const db = makeTestDb();
    const directFetch = mockChatGptFetch(vi.fn().mockImplementation(async () => chatGptResponse('{"importance":3,"canonical":false,"kind":"episodic"}')));
    const env = makeTestEnv(db, {
      AI: { run: vi.fn().mockRejectedValue(quotaError()) } as unknown as Ai,
      OAUTH_KV: makeMemoryKV(),
      CHATGPT_OPERATIONS: "classify",
    });
    env.CHATGPT_OWNER_WORKSPACE_ID = (await resolveIdentityFromToken(env.AUTH_TOKEN, env))!.personalWorkspaceId;
    const { ctx, drain } = makeCtx();
    await withMcpClient(env, ctx, async client => {
      const response = await client.callTool({ name: "remember", arguments: { content: "external classification MCP quota", workspace: "personal" } });
      const text = (response.content as { text: string }[])[0].text;
      expect(text).toContain("keyword-searchable");
      expect(text).toContain("scheduled separately");
      expect(text).not.toContain("classification is also deferred");
    });
    await drain();
    expect(directFetch).toHaveBeenCalledTimes(1);
    expect(db.entries[0].tags).toContain("kind:episodic");
  });

  it("append commits D1, preserves old vectors, and queues the passage during quota", async () => {
    const db = makeTestDb();
    seedEntry(db);
    const originalVectorIds = db.entries[0].vector_ids;
    const env = makeTestEnv(db, {
      AI: { run: vi.fn().mockRejectedValue(quotaError()) } as unknown as Ai,
      OAUTH_KV: makeMemoryKV(),
    });
    const { ctx, drain } = makeCtx();

    const response = await worker.fetch(req("POST", "/append", {
      body: { id: "quota-entry", addition: "durable quota append" },
    }), env, ctx);
    await drain();
    const responseBody = await response.json() as any;

    expect(response.status).toBe(200);
    expect(responseBody).toMatchObject({
      ok: true,
      semantic_unavailable: true,
      semantic_unavailable_reason: "workers_ai_quota_exhausted",
    });
    expect(responseBody.semantic_retry_at).toEqual(expect.any(Number));
    expect(responseBody.message).toContain("queued");
    expect(responseBody.message).toContain("09:00 JST");
    expect(JSON.stringify(responseBody)).not.toContain("4006");
    expect(db.entries[0].content).toContain("durable quota append");
    expect(db.entries[0].vector_ids).toBe(originalVectorIds);
    expect(JSON.parse(db.entries[0].pending_append_passages)).toEqual([
      expect.objectContaining({ content: "durable quota append" }),
    ]);
  });

  it("update remains fail-closed with 429 and an explicit reset time", async () => {
    const db = makeTestDb();
    seedEntry(db);
    const original = { content: db.entries[0].content, vector_ids: db.entries[0].vector_ids };
    const env = makeTestEnv(db, {
      AI: { run: vi.fn().mockRejectedValue(quotaError()) } as unknown as Ai,
      OAUTH_KV: makeMemoryKV(),
    });
    const { ctx, drain } = makeCtx();

    const response = await worker.fetch(req("POST", "/update", {
      body: { id: "quota-entry", content: "must not replace content" },
    }), env, ctx);
    await drain();
    const responseBody = await response.json() as any;

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(responseBody.code).toBe("workers_ai_quota_exhausted");
    expect(responseBody.error).toContain("09:00 JST");
    expect(JSON.stringify(responseBody)).not.toContain("4006");
    expect(db.entries[0].content).toBe(original.content);
    expect(db.entries[0].vector_ids).toBe(original.vector_ids);
  });

  it("coalesces repeated quota-time appends into one bounded pending passage", async () => {
    const db = makeTestDb();
    seedEntry(db);
    const env = makeTestEnv(db, {
      AI: { run: vi.fn().mockRejectedValue(quotaError()) } as unknown as Ai,
      OAUTH_KV: makeMemoryKV(),
    });
    const { ctx } = makeCtx();

    for (const addition of ["first queued detail", "second queued detail"]) {
      const response = await worker.fetch(req("POST", "/append", {
        body: { id: "quota-entry", addition },
      }), env, ctx);
      expect(response.status).toBe(200);
    }

    const queued = JSON.parse(db.entries[0].pending_append_passages);
    expect(queued).toHaveLength(1);
    expect(queued[0].content).toContain("first queued detail");
    expect(queued[0].content).toContain("second queued detail");
    expect(db.entries[0].content).toContain("first queued detail");
    expect(db.entries[0].content).toContain("second queued detail");
  });

  it("health passively reports a previously observed quota outage without probing AI", async () => {
    const db = makeTestDb();
    seedEntry(db);
    const aiRun = vi.fn().mockRejectedValue(quotaError());
    const env = makeTestEnv(db, {
      AI: { run: aiRun } as unknown as Ai,
      OAUTH_KV: makeMemoryKV(),
    });
    const { ctx } = makeCtx();

    await worker.fetch(req("POST", "/recall?query=findable"), env, ctx);
    const callsAfterObservation = aiRun.mock.calls.length;
    const response = await worker.fetch(req("GET", "/health"), env, ctx);
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.status).toBe("degraded");
    expect(body.database).toEqual({ status: "reachable" });
    expect(body.ai).toMatchObject({ ok: false, status: "quota_exhausted" });
    expect(body.ai.resetAt).toEqual(expect.any(Number));
    expect(aiRun).toHaveBeenCalledTimes(callsAfterObservation);
  });

  it("MCP remember stores and MCP recall explains keyword fallback without raw 4006", async () => {
    const db = makeTestDb();
    const env = makeTestEnv(db, {
      AI: { run: vi.fn().mockRejectedValue(quotaError()) } as unknown as Ai,
      OAUTH_KV: makeMemoryKV(),
    });
    const { ctx, drain } = makeCtx();

    await withMcpClient(env, ctx, async client => {
      const remember = await client.callTool({
        name: "remember",
        arguments: { content: "MCP quota fallback memory" },
      });
      const rememberText = (remember.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(rememberText).toContain("Stored");
      expect(rememberText).toContain("/vectorize-pending");
      expect(rememberText).toContain("/classify-pending");
      expect(rememberText).not.toContain("4006");

      const recall = await client.callTool({
        name: "recall",
        arguments: { query: "User wants to find the MCP quota fallback memory — what was stored?" },
      });
      const recallText = (recall.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(recallText).toContain("MCP quota fallback memory");
      expect(recallText).toContain("09:00 JST");
      expect(recallText).not.toContain("4006");
    });
    await drain();

    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].vector_ids).toBe("[]");
  });

  it("MCP append accepts quota-deferred work while MCP update stays unchanged", async () => {
    const db = makeTestDb();
    seedEntry(db);
    const originalVectorIds = db.entries[0].vector_ids;
    const env = makeTestEnv(db, {
      AI: { run: vi.fn().mockRejectedValue(quotaError()) } as unknown as Ai,
      OAUTH_KV: makeMemoryKV(),
    });
    const { ctx } = makeCtx();

    await withMcpClient(env, ctx, async client => {
      const append = await client.callTool({
        name: "append",
        arguments: { id: "quota-entry", addition: "MCP durable quota append" },
      });
      const appendText = (append.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(appendText).toContain("durable in D1");
      expect(appendText).toContain("queued");
      expect(appendText).toContain("09:00 JST");
      expect(appendText).not.toContain("4006");

      const beforeUpdate = db.entries[0].content;
      const update = await client.callTool({
        name: "update",
        arguments: { id: "quota-entry", content: "must not replace content" },
      });
      const updateText = (update.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(updateText).toContain("unchanged");
      expect(updateText).toContain("09:00 JST");
      expect(updateText).not.toContain("4006");
      expect(db.entries[0].content).toBe(beforeUpdate);
    });

    expect(db.entries[0].content).toContain("MCP durable quota append");
    expect(db.entries[0].vector_ids).toBe(originalVectorIds);
  });
});


it("実SQLiteで枯渇中の保存・分類・検索から索引回復まで本文を保持する", async () => {
  const sqlite = makeSqliteD1();
  const aiRun = vi.fn().mockRejectedValue(quotaError());
  const directFetch = mockChatGptFetch(vi.fn().mockImplementation(async () => chatGptResponse('{"importance":4,"canonical":false,"kind":"semantic"}')));
  const env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as D1Database,
    VECTORIZE_GRACE_MS: "1",
    AI: { run: aiRun } as unknown as Ai,
    OAUTH_KV: makeMemoryKV(),
    CHATGPT_OPERATIONS: "classify",
  });
  env.CHATGPT_OWNER_WORKSPACE_ID = (await resolveIdentityFromToken(env.AUTH_TOKEN, env))!.personalWorkspaceId;
  const { ctx, drain } = makeCtx();
  try {
    const response = await worker.fetch(req("POST", "/capture", {
      body: { workspace: "personal", content: "Cedar quota recovery synthetic memory", tags: ["quota-test"] },
    }), env, ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as { id: string };
    await drain();
    const before = await sqlite.db.prepare("SELECT content, tags, vector_ids, importance_score FROM entries WHERE id = ?").bind(body.id).first() as any;
    expect(before).toMatchObject({ content: "Cedar quota recovery synthetic memory", vector_ids: "[]", importance_score: 4 });
    expect(JSON.parse(before.tags)).toEqual(expect.arrayContaining(["quota-test", "kind:semantic"]));
    const recall = await worker.fetch(req("POST", "/recall?query=Cedar+quota"), env, ctx);
    const recalled = await recall.json() as any;
    expect(recalled.results.map((r: any) => r.id)).toContain(body.id);
    expect(recalled.semantic_unavailable).toBe(true);
    expect(aiRun).toHaveBeenCalledTimes(1);
    aiRun.mockResolvedValue({ data: [new Array(768).fill(0.1)] });
    const recoveryResponse = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    expect(recoveryResponse.status).toBe(200);
    const recovered = await recoveryResponse.json();
    expect(recovered).toMatchObject({ processed: 1, failed: 0, remaining: 0 });
    const after = await sqlite.db.prepare("SELECT content, tags, vector_ids FROM entries WHERE id = ?").bind(body.id).first() as any;
    expect(after.content).toBe(before.content);
    expect(after.tags).toBe(before.tags);
    expect(after.vector_ids).not.toBe("[]");
  } finally {
    await drain();
    sqlite.close();
  }
});
