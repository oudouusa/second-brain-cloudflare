/** Isolated staging entrypoint. Never used by wrangler.jsonc or deployed to production. */
import { AsyncLocalStorage } from "node:async_hooks";
import production from "../../src/index";
import { McpExecutor as ProductionExecutor } from "../../src/mcp/executor";
import { embeddingMetadata } from "../../src/embedding/profile";
import { observeWorkersAiQuotaError } from "../../src/lib/ai";
import { resetRecallCounters, trackingContext, completeMetrics } from "./measurement.mjs";
import { measureD1 } from "./d1-metrics.mjs";

const state = new AsyncLocalStorage<any>();
const environments = new WeakMap<object, any>();
const modes = ["healthy", "quota", "embedding-failure", "vector-failure"];
function sample(request: Request, stage: string) {
  const id = request.headers.get("x-sb54-sample") ?? "";
  const mode = request.headers.get("x-sb54-mode") ?? "";
  const fixture = request.headers.get("x-sb54-fixture") ?? "";
  if (!/^[a-z0-9-]{1,100}$/.test(id) || !modes.includes(mode)
    || !/^(200|1000|10000)-(ordinary-noise|excluded-window|equal-authority-overflow|no-answer)-(en|ja)$/.test(fixture)) {
    throw new Error("Invalid staging sample");
  }
  return { id, stage, mode, fixture, pending: [] as Promise<unknown>[], rowsRead: 0, rowsWritten: 0, statements: 0,
    kv: new Map(), aiCalls: 0, vectorCalls: 0,
    // Per-statement records also cover waitUntil work after the response.
    onResult: (metrics: object) => console.log(JSON.stringify({ event: "sb54-d1", id, stage, ...metrics })) };
}
function adapted(env: any) {
  if (environments.has(env)) return environments.get(env);
  // Stable DB identity preserves the production bootstrap memo. Per-request
  // counters/provider modes live in AsyncLocalStorage, including background I/O.
  const result = { ...env, DB: measureD1(env.DB, () => state.getStore()),
    OAUTH_KV: {
      get: async (key: string, options?: any) => {
        const value = state.getStore().kv.get(key) ?? null;
        return value && (options === "json" || options?.type === "json") ? JSON.parse(value) : value;
      },
      put: async (key: string, value: string) => { state.getStore().kv.set(key, value); },
      delete: async (key: string) => { state.getStore().kv.delete(key); },
      list: async () => ({ keys: [], list_complete: true }),
    },
    AI: { run: async (model: string) => {
      const s = state.getStore(); s.aiCalls++;
      if (s.mode === "embedding-failure") throw new Error("synthetic embedding failure");
      if (model === "@cf/google/embeddinggemma-300m") return { data: [Array(768).fill(.1)] };
      throw new Error("Unexpected synthetic generation request");
    } },
    VECTORIZE: {
      query: async () => {
        const s = state.getStore(); s.vectorCalls++;
        if (s.mode === "vector-failure") throw new Error("synthetic vector failure");
        return { matches: s.fixture.includes("no-answer") ? [] : [{
          id: `${s.fixture}-vector`, score: .99,
          metadata: { ...embeddingMetadata(), parentId: `${s.fixture}-answer`,
            workspace_id: `ws-${s.fixture}`, created_at: Date.UTC(2026, 8, 6) - 180 * 86400000 },
        }] };
      },
      getByIds: async () => [],
      describe: async () => ({ vectorCount: 0 }),
    },
  };
  environments.set(env, result);
  return result;
}

// Inherit the actual production executor, including dynamic MCP import and
// authentication. No alternate recall implementation or direct function route.
export class McpExecutor extends ProductionExecutor {
  constructor(ctx: any, env: any) {
    // ネイティブの基底コンストラクタには実際のDurableObjectStateを渡す。
    super(ctx, adapted(env));
    Object.defineProperty(this, "ctx", { value: trackingContext(ctx, () => state.getStore()) });
  }
  async reset(request: Request) {
    const s = sample(request, "reset");
    return state.run(s, async () => {
      const { beginMemoryWriteAdmission, memoryWriteMarker } = await import("../../src/migration/write-lock");
      const ctx = { waitUntil: (p: Promise<unknown>) => this.ctx.waitUntil(p) } as ExecutionContext;
      const admission = await beginMemoryWriteAdmission(this.env, ctx);
      try {
        await resetRecallCounters(admission.env.DB, `ws-${s.fixture}`, memoryWriteMarker(admission.env));
      } finally { await admission.finish(); }
      return completeMetrics(new Response("reset"), s);
    });
  }
  async handleMcp(request: Request, oauthUserId?: string) {
    const s = sample(request, "do");
    return state.run(s, async () => {
      if (s.mode === "quota") await observeWorkersAiQuotaError(this.env, new Error("4006: daily free allocation used"));
      try { return await completeMetrics(await super.handleMcp(request, oauthUserId), s); }
      finally { console.log(JSON.stringify({ event: "sb54", ...s, kv: undefined, pending: undefined })); }
    });
  }
}

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    if (!env.STAGING_TOKEN)
      return new Response("Unauthorized", { status: 401 });
    const path = new URL(request.url).pathname;
    if (!["/mcp", "/reset"].includes(path) || request.method !== "POST")
      return new Response("Not found", { status: 404 });
    if (path === "/reset") {
      if (request.headers.get("authorization") !== `Bearer ${env.STAGING_TOKEN}`)
        return new Response("Unauthorized", { status: 401 });
      const response = await env.MCP_EXECUTOR.getByName("mcp-v1").reset(request);
      // RPC の本文を呼出元の実行中に読み切り、リセットの応答転送を完了させる。
      return new Response(await response.arrayBuffer(), response);
    }
    const s = sample(request, "public");
    return state.run(s, async () => {
      try { return await completeMetrics(await production.fetch(request, adapted(env), trackingContext(ctx, () => state.getStore())), s); }
      finally { console.log(JSON.stringify({ event: "sb54", ...s, kv: undefined, pending: undefined })); }
    });
  },
};
