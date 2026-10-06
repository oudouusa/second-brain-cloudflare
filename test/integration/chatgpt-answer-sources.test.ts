import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../../src/projects/registry";
import worker from "../../src/index";
import { initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { chatGptResponse, mockChatGptFetch } from "../helpers/chatgpt-provider";
import type { Env } from "../../src/env";

describe("ChatGPT回答の参照元をサーバーで確定する", () => {
  let db: ReturnType<typeof makeSqliteD1>;
  let env: Env;
  let roots: Awaited<ReturnType<typeof ensureTenantBootstrap>>;
  let fetcher: ReturnType<typeof mockChatGptFetch>;
  beforeEach(async () => {
    db = makeSqliteD1();
    env = makeTestEnv(undefined, { DB: db.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), CHATGPT_OPERATIONS: "answer" });
    await initializeDatabase(env);
    roots = await ensureTenantBootstrap(env);
    env.CHATGPT_OWNER_WORKSPACE_ID = roots.ownerPersonalWorkspaceId;
    fetcher = mockChatGptFetch(vi.fn(async () => chatGptResponse("資料に基づく回答 [1]")));
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const seed = async (id: string, workspace = roots.ownerPersonalWorkspaceId, tags: string[] = []) => {
    await db.db.prepare("INSERT INTO entries (id, content, tags, source, created_at, workspace_id) VALUES (?, ?, ?, 'test', ?, ?)")
      .bind(id, `quartz release ${id}`, JSON.stringify(tags), Date.now() - 1000, workspace).run();
  };
  const call = (body: object = {}, token?: string, path = "/chat") => worker.fetch(new Request(`https://example.test${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token ?? env.AUTH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "quartz release", workspace: "personal", memories: "TEAM_CONTEXT_CANARY", ...body }),
  }), env, { waitUntil: vi.fn() } as unknown as ExecutionContext);

  it("共有文章・本文改ざん・偽IDとreceiptを無視し、検索した個人資料だけを送る", async () => {
    await seed("personal-source");
    await seed("TEAM_CONTEXT_CANARY", roots.companyWorkspaceId);
    const response = await call({ ids: ["TEAM_CONTEXT_CANARY"], receipt: "forged", CHATGPT_WORKSPACE_ID: roots.companyWorkspaceId });
    expect(response.status).toBe(200);
    const sse = await response.text();
    const first = JSON.parse(sse.split("\n")[0].slice(6));
    expect(first.type).toBe("sources");
    expect(first.sources).toHaveLength(1);
    expect(first.sources[0]).toMatchObject({ id: "personal-source", content: "quartz release personal-source", workspace: "personal" });
    expect(sse).toContain("data: [DONE]");
    expect(fetcher).toHaveBeenCalledOnce();
    const input = JSON.parse(fetcher.mock.calls[0][1].body).input;
    expect(input[1].content).toContain("1. [");
    expect(input[1].content).toContain(first.sources[0].content);
    expect(JSON.stringify(input)).not.toContain("TEAM_CONTEXT_CANARY");
  });

  it.each(["削除", "共有へ移動", "保留", "有効期間終了"])("初回検索後の%sを回答時に反映する", async change => {
    await seed("old-source");
    const initial = await call({ synthesize: false }, undefined, "/recall");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ results: [{ id: "old-source" }] });
    if (change === "削除") await db.deleteFixtureRows("DELETE FROM entries WHERE id = 'old-source'");
    if (change === "共有へ移動") await db.db.prepare("UPDATE entries SET workspace_id = ? WHERE id = 'old-source'").bind(roots.companyWorkspaceId).run();
    if (change === "保留") await db.db.prepare("UPDATE entries SET tags = '[\"quarantine:instruction\",\"status:draft\"]' WHERE id = 'old-source'").run();
    if (change === "有効期間終了") await db.db.prepare("UPDATE entries SET valid_until = ? WHERE id = 'old-source'").bind(Date.now() - 500).run();
    const response = await call({ memories: "quartz release old-source" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "no_personal_memories" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("空検索ではクライアント資料で補完しない", async () => {
    const response = await call();
    expect(response.status).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("タグの絞り込みを再検索でも保持する", async () => {
    await seed("selected", roots.ownerPersonalWorkspaceId, ["release-plan"]);
    await seed("outside-filter");
    const response = await call({ tag: "release-plan" });
    expect(response.status).toBe(200);
    const sse = await response.text();
    expect(sse).toContain("selected");
    expect(sse).not.toContain("outside-filter");
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("outside-filter");
  });
  it("個人プロジェクトの絞り込みを保持し、同名共有プロジェクトを混ぜない", async () => {
    for (const workspace of [roots.ownerPersonalWorkspaceId, roots.companyWorkspaceId]) {
      await createProject(env.DB, workspace, { id: "release-plan", name: "Release" }, db.admitEnv(env));
    }
    await seed("selected", roots.ownerPersonalWorkspaceId, ["project:release-plan"]);
    await seed("outside-project");
    await seed("team-project", roots.companyWorkspaceId, ["project:release-plan"]);
    const response = await call({ project: "release-plan" });
    expect(response.status).toBe(200);
    const sse = await response.text();
    expect(sse).toContain("selected");
    expect(sse).not.toContain("outside-project");
    expect(sse).not.toContain("team-project");
  });
  it("共有領域にしかないプロジェクトを個人として解決しない", async () => {
    await createProject(env.DB, roots.companyWorkspaceId, { id: "team-only", name: "Team" }, db.admitEnv(env));
    const response = await call({ project: "team-only" });
    expect(response.status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{ workspace: "forged" }, { tag: 12 }, { project: 12 }])("不正な検索条件を拒否する: %j", async body => {
    const response = await call(body);
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("存在しないプロジェクトを全領域検索へ広げない", async () => {
    await seed("personal-source");
    const response = await call({ project: "missing-project" });
    expect(response.status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("認証に失敗した要求から検索・推論を始めない", async () => {
    const response = await call({}, "invalid");
    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    expect(env.AI.run).not.toHaveBeenCalled();
  });
  it("回答の直接接続障害は503で、Workers AIへ戻らない", async () => {
    await seed("personal-source");
    fetcher.mockImplementation(async () => chatGptResponse("unavailable", "stop", 503));
    const response = await call();
    expect(response.status).toBe(503);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.mocked(env.AI.run).mock.calls.every(([, input]) => !(input as { stream?: boolean }).stream)).toBe(true);
  });
  it("検索失敗時にクライアント本文やWorkers AIで回答しない", async () => {
    await seed("personal-source");
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation(sql => {
      if (/FROM entries\b/.test(sql)) throw new Error("合成DB障害");
      return prepare(sql);
    });
    const response = await call();
    expect(response.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
