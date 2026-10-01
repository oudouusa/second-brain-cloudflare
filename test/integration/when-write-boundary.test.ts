import { appendToEntry } from "../../src/capture/store";
import { DEFAULTS } from "../../src/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { acquireMemoryWriteAdmission, releaseMemoryWriteAdmission, memoryWriteMarker } from "../../src/migration/write-lock";
import { runWhenExtractPass } from "../../src/when/pass";
import { createNightlyD1Budget } from "../../src/runtime/d1-budget";
import { importExportPayload } from "../../src/entries/import";

describe("期限情報の保存境界", () => {
  let sq: ReturnType<typeof makeSqliteD1>;
  beforeEach(() => { sq = makeSqliteD1({ autoAdmitFixtureWrites: false }); });
  afterEach(() => { sq.close(); vi.restoreAllMocks(); });
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  it("期限列の変更にも有効な許可と新しいmarkerが必要", async () => {
    sq.seed({ id: "task", createdAt: 1, content: "作業", tags: ["task"] });
    const env = makeTestEnv(undefined, { DB: sq.db as unknown as D1Database });
    const admission = await acquireMemoryWriteAdmission(env);
    const admitted = { ...env, WRITE_ADMISSION_TOKEN: admission.token };
    for (const column of ["when_at", "when_kind", "when_source", "when_label"]) {
      await expect(env.DB.prepare(`UPDATE entries SET ${column} = NULL WHERE id = 'task'`).run()).rejects.toThrow("memory-write-locked");
    }
    const marker = memoryWriteMarker(admitted);
    await env.DB.prepare("UPDATE entries SET when_at = 123, write_marker = ? WHERE id = 'task'").bind(marker).run();
    await expect(env.DB.prepare("UPDATE entries SET when_at = 456, write_marker = ? WHERE id = 'task'").bind(marker).run()).rejects.toThrow("memory-write-locked");
    await releaseMemoryWriteAdmission(env, admission);
    await expect(env.DB.prepare("UPDATE entries SET when_at = 456, write_marker = ? WHERE id = 'task'").bind(memoryWriteMarker(admitted)).run()).rejects.toThrow("memory-write-locked");
  });
  it("期限の不正値をimportせず、旧形式の欠落列はnullにする", async () => {
    const env = sq.admitEnv(makeTestEnv(undefined, { DB: sq.db as unknown as D1Database }));
    const result = await importExportPayload(env, { entries: [
      { id: "old", content: "旧形式", created_at: 1 },
      { id: "bad", content: "不正値", created_at: 1, when_at: Number.NaN },
    ] });
    expect(result).toMatchObject({ imported: 1, failed: 1 });
    expect(sq.rows()).toEqual([expect.objectContaining({ id: "old", when_at: null, when_source: null })]);
  });
  it("SQL予約不足ではモデルも候補cursorも進めない", async () => {
    sq.seed({ id: "task", createdAt: 1, content: "期限のある作業", tags: ["task"] });
    const env = sq.admitEnv(makeTestEnv(undefined, { DB: sq.db as unknown as D1Database }));
    const budget = createNightlyD1Budget(env, 3);
    // 最初のschema確認後に残る予算を消費して、候補走査を予約不能にする。
    await budget.env.DB.prepare("SELECT 1").first();
    await budget.env.DB.prepare("SELECT 1").first();
    const result = await runWhenExtractPass(budget.env, ctx, "", 2);
    expect(result.ok).toBe(false);
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(budget.stats().used).toBeLessThanOrEqual(3);
    expect(await env.OAUTH_KV.get("when:cursor:")).toBeNull();
  });
  it("本文がモデル応答中に変わったら古い期限もcursorも確定しない", async () => {
    sq.seed({ id: "task", createdAt: 1, content: "作業", tags: ["task"] });
    const env = sq.admitEnv(makeTestEnv(undefined, { DB: sq.db as unknown as D1Database }));
    vi.mocked(env.AI.run).mockImplementationOnce(async () => {
      await env.DB.prepare("UPDATE entries SET content = '変更後', write_marker = ? WHERE id = 'task'")
        .bind(memoryWriteMarker(env)).run();
      const verdict = JSON.stringify({ is_commitment: true, what: "作業", due_at: "2027-01-30", confidence: 0.9 });
      return new Response(`data: ${JSON.stringify({ response: verdict })}\n\ndata: [DONE]\n\n`).body as never;
    });
    const result = await runWhenExtractPass(env, ctx);
    expect(result.whenExtracted).toBe(0);
    expect(result.ok).toBe(false);
    expect(sq.rows()[0]).toMatchObject({ content: "変更後", when_at: null });
    expect(await env.OAUTH_KV.get("when:cursor")).toBeNull();
  });

  it("期限付き追記は本文と同時に確定し、再試行キーに期限を含める", async () => {
    sq.seed({ id: "task", createdAt: 1, content: "作業", tags: [] });
    const env = sq.admitEnv(makeTestEnv(undefined, { DB: sq.db as unknown as D1Database }));
    const pending: Promise<unknown>[] = [];
    const tracked = { waitUntil(promise: Promise<unknown>) { pending.push(promise); } } as unknown as ExecutionContext;
    const options = { operationId: "when-append", when: { at: 1790000000000, kind: "due" as const, source: "explicit" as const } };
    try {
      await appendToEntry(env, "task", "", "期限を追加", [], "api", DEFAULTS, undefined, { workspaceId: "", actorId: "" }, { actorId: "", channel: "rest" as const }, (options).when, "", tracked, options);
      expect(sq.rows()[0]).toMatchObject({ when_at: options.when.at, when_source: "explicit" });
      const body = sq.rows()[0].content;
      expect((await appendToEntry(env, "task", "", "期限を追加", [], "api", DEFAULTS, undefined, { workspaceId: "", actorId: "" }, { actorId: "", channel: "rest" as const }, (options).when, "", tracked, options)).replayed).toBe(true);
      expect(sq.rows()[0].content).toBe(body);
      await expect(appendToEntry(env, "task", "", "期限を追加", [], "api", DEFAULTS, undefined, { workspaceId: "", actorId: "" }, { actorId: "", channel: "rest" as const }, ({ ...options, when: { ...options.when, at: options.when.at + 1 } }).when, "", tracked, { ...options, when: { ...options.when, at: options.when.at + 1 } })).rejects.toThrow("operation_id");
    } finally { while (pending.length) await Promise.allSettled(pending.splice(0)); }
  });

  it("Date範囲外の安全整数も復元時に拒否する",async()=>{
    const env=sq.admitEnv(makeTestEnv(undefined,{DB:sq.db as unknown as D1Database, OAUTH_KV:makeMemoryKV()}));
    const result=await importExportPayload(env,{entries:[-9000000000000000,9000000000000000].map((when_at,i)=>({id:`bad${i}`,content:"期限",created_at:1,when_at}))});
    expect(result).toMatchObject({imported:0,failed:2});
    expect(sq.rows()).toHaveLength(0);
  });
  it("末尾まで走査した後に古い記憶のタスク化を再評価する",async()=>{
    sq.seed({id:"old",createdAt:1,content:"作業",tags:[]});
    sq.seed({id:"new",createdAt:2,content:"メモ",tags:["task"]});
    const env=sq.admitEnv(makeTestEnv(undefined,{DB:sq.db as unknown as D1Database, OAUTH_KV:makeMemoryKV()}));
    vi.mocked(env.AI.run).mockImplementation(async()=>new Response(`data: ${JSON.stringify({response: JSON.stringify({is_commitment:false})})}\n\ndata: [DONE]\n\n`).body as never);
    await env.OAUTH_KV.put("when:cursor:",JSON.stringify({createdAt:2,id:"new"}));
    await env.DB.prepare("UPDATE entries SET tags='[\"task\"]', write_marker=? WHERE id='old'").bind(memoryWriteMarker(env)).run();
    expect((await runWhenExtractPass(env,ctx,"",2)).whenJudged).toBe(0);
    expect(env.AI.run).not.toHaveBeenCalled();
    expect((await runWhenExtractPass(env,ctx,"",2)).whenJudged).toBe(2);
  });

});
