import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { makeMirrorStore } from "../../src/integrations/mirror";
import { chatGptEnvForWorkspaces, runChatGptGeneration, type ChatGptOperation } from "../../src/lib/chatgpt";
import { createNightlyD1Budget } from "../../src/runtime/d1-budget";
import { chatGptResponse, mockChatGptFetch } from "../helpers/chatgpt-provider";
import worker from "../../src/index";
import type { Env } from "../../src/env";

const operations: ChatGptOperation[] = ["classify", "query-tags", "smart-merge", "contradiction", "recall-summary", "digest", "answer", "weekly-insight"];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("所有者の個人領域への限定", () => {
  it.each([[], [""], ["member"], ["team"], ["owner", "team"], ["owner", "member"]].map(ids => ({ ids })))("不明・別利用者・混在範囲では通常経路を維持する: $ids", ({ ids }) => {
    const env = makeTestEnv(undefined, { CHATGPT_OPERATIONS: operations.join(","), CHATGPT_OWNER_WORKSPACE_ID: "owner" });
    const scoped = chatGptEnvForWorkspaces(env, ids);
    expect(scoped.CHATGPT_OPERATIONS).toBe("");
    expect(scoped.CHATGPT_WORKSPACE_ID).toBeUndefined();
    expect(env.CHATGPT_OPERATIONS).toBe(operations.join(","));
  });
  it("個人範囲の有効化でもD1予算・隠れたwrite admission・KVを保持する", async () => {
    const env = makeTestEnv(undefined, { CHATGPT_OPERATIONS: "answer", CHATGPT_OWNER_WORKSPACE_ID: "owner" });
    Object.defineProperty(env, "WRITE_ADMISSION_TOKEN", { value: "synthetic-capability" });
    const budget = createNightlyD1Budget(env, 4);
    const scoped = chatGptEnvForWorkspaces(budget.env, ["owner", "owner"]);
    expect(scoped.CHATGPT_OPERATIONS).toBe("answer");
    expect(scoped.CHATGPT_WORKSPACE_ID).toBe("owner");
    expect(scoped.OAUTH_KV).toBe(env.OAUTH_KV);
    expect(scoped.WRITE_ADMISSION_TOKEN).toBe("synthetic-capability");
    await scoped.DB.prepare("SELECT 1").first();
    expect(budget.stats().used).toBe(1);
    expect(env.CHATGPT_WORKSPACE_ID).toBeUndefined();
  });
  it.each(operations)("%s: 呼び出し側が範囲を設定し忘れても通信前に拒否する", async operation => {
    const fetch = mockChatGptFetch(vi.fn());
    const env = makeTestEnv(undefined, { CHATGPT_OPERATIONS: operations.join(","), CHATGPT_OWNER_WORKSPACE_ID: "owner" });
    await expect(runChatGptGeneration(env, operation, "合成入力", 64)).rejects.toMatchObject({ code: "personal_scope_required" });
    expect(fetch).not.toHaveBeenCalled();
    expect(env.AI.run).not.toHaveBeenCalled();
  });
});

describe("実際の認証とworkspaceを使うHTTP境界", () => {
  let db: ReturnType<typeof makeSqliteD1>, env: Env;
  let roots: Awaited<ReturnType<typeof ensureTenantBootstrap>>;
  let member: Awaited<ReturnType<typeof createMember>>;
  let fetcher: ReturnType<typeof mockChatGptFetch>;
  beforeEach(async () => {
    db = makeSqliteD1();
    env = makeTestEnv(undefined, { DB: db.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), CHATGPT_OPERATIONS: operations.join(",") });
    await initializeDatabase(env);
    roots = await ensureTenantBootstrap(env);
    member = await createMember(env, { name: "別の利用者" });
    env.CHATGPT_OWNER_WORKSPACE_ID = roots.ownerPersonalWorkspaceId;
    fetcher = mockChatGptFetch(vi.fn(async () => chatGptResponse("個人の回答")));
  });
  afterEach(() => db?.close());
  const call = (path: string, token: string, body: object) => worker.fetch(new Request(`https://example.test${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Second-Brain-ChatGPT-Workspace": "owner" }, body: JSON.stringify(body),
  }), env, { waitUntil: vi.fn() } as unknown as ExecutionContext);
  it("所有者が個人範囲を指定した回答だけがプランを使い、使用量導線を識別できる", async () => {
    const response = await call("/chat", env.AUTH_TOKEN, { query: "状態は？", memories: "合成記憶", workspace: "personal" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("個人の回答");
    expect(response.headers.get("X-Second-Brain-AI-Provider")).toBe("chatgpt");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(env.AI.run).not.toHaveBeenCalled();
  });
  it.each([undefined, "company"])("所有者でも範囲 %s の回答はWorkers AIを使う", async workspace => {
    const response = await call("/chat", env.AUTH_TOKEN, { query: "状態は？", memories: "共有の合成記憶", workspace, CHATGPT_WORKSPACE_ID: roots.ownerPersonalWorkspaceId });
    expect(response.status).toBe(200);
    await response.text();
    expect(response.headers.get("X-Second-Brain-AI-Provider")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(env.AI.run).toHaveBeenCalledOnce();
  });
  it.each(["member", "admin"])("%sの個人範囲は所有者のプランを使えない", async role => {
    if (role === "admin") await db.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(member.member.userId).run();
    const response = await call("/chat", member.token, { query: "状態は？", memories: "別利用者の合成記憶", workspace: "personal", CHATGPT_WORKSPACE_ID: roots.ownerPersonalWorkspaceId });
    expect(response.status).toBe(200); await response.text();
    expect(fetcher).not.toHaveBeenCalled();
    expect(env.AI.run).toHaveBeenCalledOnce();
  });
  it("接続未設定の所有者は資格情報がなくても通常の回答を使える", async () => {
    env.CHATGPT_OWNER_WORKSPACE_ID = "";
    const response = await call("/chat", env.AUTH_TOKEN, { query: "状態は？", workspace: "personal" });
    expect(response.status).toBe(200); await response.text();
    expect(fetcher).not.toHaveBeenCalled(); expect(env.AI.run).toHaveBeenCalledOnce();
  });
  it("個人検索の要約だけに直接接続を許可し、混在検索とmember検索には許可しない", async () => {
    fetcher.mockImplementation(async () => chatGptResponse("個人要約"));
    env.VECTORIZE = makeVectorizeMock({ getByIds: vi.fn(async (ids: string[]) => ids.map((id, i) => ({
      id, values: Array.from({ length: 128 }, (_, n) => n === i ? 0.2 : 0.1), metadata: { parentId: id },
    }))) });
    for (const [id, workspace] of [["owner-result", roots.ownerPersonalWorkspaceId], ["member-result", member.member.personalWorkspaceId], ["team-result", roots.companyWorkspaceId]]) {
      for (const n of [1, 2]) {
        await db.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id) VALUES (?, ?, '["案件"]', 'test', ?, ?, ?)`)
          .bind(`${id}-${n}`, n === 1 ? "東京の設計レビューで認証方式の課題を確認した。" : "広告費の月次報告は金曜締切で経理への提出が必要。", Date.now(), JSON.stringify([`${id}-${n}`]), workspace).run();
      }
    }
    for (const [token, workspace, expected] of [[env.AUTH_TOKEN, "personal", 1], [env.AUTH_TOKEN, undefined, 0], [member.token, "personal", 0]] as const) {
      fetcher.mockClear();
      const response = await call("/recall", token, { query: "案件の記録", workspace, tag: "案件", synthesize: true });
      expect(response.status).toBe(200);
      const data = await response.json() as { results: unknown[] };
      if (expected === 1) expect(data.results).toHaveLength(2);
      expect(fetcher).toHaveBeenCalledTimes(expected);
    }
  });
  it("一括再分類も行ごとに範囲を選び、Teamやmemberの入力を直接送らない", async () => {
    fetcher.mockImplementation(async () => chatGptResponse('{"importance":3,"canonical":false,"kind":"semantic"}'));
    env.AI.run = vi.fn().mockResolvedValue(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode('data: {"response":"{\\"importance\\":3,\\"canonical\\":false,\\"kind\\":\\"semantic\\"}"}\n\n')); c.close();
    } }));
    for (const [id, workspace] of [["owner-row", roots.ownerPersonalWorkspaceId], ["member-row", member.member.personalWorkspaceId], ["team-row", roots.companyWorkspaceId]]) {
      await db.db.prepare("INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id) VALUES (?, ?, '[]', 'test', ?, '[\"v\"]', ?)")
        .bind(id, `合成資料 ${id}`, Date.now() - 600000, workspace).run();
    }
    const response = await call("/classify-pending", env.AUTH_TOKEN, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ processed: 3, failed: 0 });
    expect(fetcher).toHaveBeenCalledOnce();
    const prompts = JSON.stringify(fetcher.mock.calls);
    expect(prompts).toContain("owner-row"); expect(prompts).not.toContain("member-row"); expect(prompts).not.toContain("team-row");
    expect(env.AI.run).toHaveBeenCalledTimes(2);
  });
  it("mirrorの実WriteContextで選び、共有mirrorを所有者のプランへ送らない", async () => {
    env.CHATGPT_OPERATIONS = "classify";
    fetcher.mockImplementation(async () => chatGptResponse('{"importance":3,"canonical":false,"kind":"semantic"}'));
    for (const [workspaceId, content] of [[roots.ownerPersonalWorkspaceId, "個人の合成カレンダー予定"], [roots.companyWorkspaceId, "共有の合成カレンダー予定"]]) {
      const store = makeMirrorStore(db.admitEnv(env), { workspaceId, actorId: roots.ownerUserId });
      await store.createEntry(content, ["予定"], "calendar");
    }
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.stringify(fetcher.mock.calls)).toContain("個人の合成");
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("共有の合成");
    expect(db.rows()).toHaveLength(2);
    expect(new Set(db.rows().map(row => row.workspace_id))).toEqual(new Set([roots.ownerPersonalWorkspaceId, roots.companyWorkspaceId]));
  });
  it("候補の実workspaceでプレビューを選び、Teamの推論は通常経路を使う", async () => {
    fetcher.mockImplementation(async () => chatGptResponse('{"insight":false}'));
    env.AI.run = vi.fn().mockImplementation(async () => new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: '{"insight":false}' })}\n\n`)); c.close();
    } }));
    for (const [prefix, workspace] of [["個人", roots.ownerPersonalWorkspaceId], ["共有", roots.companyWorkspaceId]]) {
      for (const suffix of ["a", "b"]) await db.db.prepare("INSERT INTO entries (id, content, tags, source, created_at, workspace_id) VALUES (?, ?, '[]', 'test', ?, ?)")
        .bind(`${prefix}-${suffix}`, `${prefix}の合成候補 ${suffix}`, Date.now(), workspace).run();
      await db.db.prepare("INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at) VALUES (?, ?, ?, 0.9, 0, 0.9, 'vector', 'pending', ?)")
        .bind(`${prefix}-pair`, `${prefix}-a`, `${prefix}-b`, Date.now()).run();
    }
    const response = await worker.fetch(new Request("https://example.test/insights/dry-run?limit=2", { headers: { Authorization: `Bearer ${env.AUTH_TOKEN}` } }), env, { waitUntil: vi.fn() } as unknown as ExecutionContext);
    expect(response.status).toBe(200);
    expect((await response.json() as { candidates: unknown[] }).candidates).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledOnce(); expect(env.AI.run).toHaveBeenCalledOnce();
    expect(JSON.stringify(fetcher.mock.calls)).toContain("個人の合成");
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("共有の合成");
    expect(db.rows()).toHaveLength(4);
  });
});
