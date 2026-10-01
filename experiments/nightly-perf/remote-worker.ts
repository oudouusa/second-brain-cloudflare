/** 所有者の一時試験Worker専用。productionのwranglerから参照しない。 */
import { AsyncLocalStorage } from "node:async_hooks";
import production from "../../src/index";
import { beginMemoryWriteAdmission, memoryWriteMarker } from "../../src/migration/write-lock";
import { embeddingMetadata } from "../../src/embedding/profile";
import { measureD1 } from "../recall-remote/d1-metrics.mjs";
import { McpExecutor } from "../../src/mcp/executor";

const state = new AsyncLocalStorage<any>();
const environments = new WeakMap<object, any>();
function metricsFor(id: string) {
  return { id, statements: 0, rowsRead: 0, rowsWritten: 0, kv: new Map(),
    kvGet: 0, kvPut: 0, aiCalls: 0, proxyCalls: 0, vectorCalls: 0,
    records: [] as object[],
    onResult: (metrics: object) => state.getStore().records.push(metrics),
  };
}
function serializable(metrics: object) { return { ...metrics, kv: undefined, onResult: undefined }; }

/** 試験だけの計測subclass。productionのnamespace/class設定には使わない。 */
export class NightlyProbeExecutor extends McpExecutor {
  private recent?: { time: number; metrics: object };
  constructor(ctx: DurableObjectState, env: any) { super(ctx, adapted(env)); }
  override async runNightly(time: number): Promise<void> {
    const metrics = metricsFor(`do-${time}`);
    let succeeded = false;
    await state.run(metrics, async () => {
      try { await super.runNightly(time); succeeded = true; }
      finally {
        this.recent = { time, metrics: serializable(metrics) };
        console.log(JSON.stringify({ event: "http_request", operation: `sb80-do-${time}`,
          method: "POST", status: succeeded ? 200 : 500, outcome: succeeded ? "success" : "error" }));
      }
    });
  }
  takeMetrics(time: number): object {
    if (this.recent?.time !== time) throw new Error("Missing executor metrics");
    const result = this.recent.metrics;
    this.recent = undefined;
    return result;
  }
}
function adapted(env: any) {
  if (environments.has(env)) return environments.get(env);
  const result = { ...env, DB: measureD1(env.DB, () => state.getStore()),
    CLIPROXY_API_KEY: "synthetic-only", CLIPROXY_MODEL: "gpt-5.6-luna",
    CLIPROXY_OPERATIONS: "classify,query-tags,smart-merge,contradiction,recall-summary,digest,answer,weekly-insight",
    OAUTH_KV: {
      get: async (key: string) => { const s = state.getStore(); s.kvGet++; return s.kv.get(key) ?? null; },
      put: async (key: string, value: string) => { const s = state.getStore(); s.kvPut++; s.kv.set(key, value); },
      delete: async (key: string) => state.getStore().kv.delete(key),
      list: async () => ({ keys: [], list_complete: true }),
    },
    AI: { run: async (model: string) => {
      state.getStore().aiCalls++;
      if (model !== "@cf/google/embeddinggemma-300m") throw new Error("Unexpected synthetic model");
      return { data: [Array(768).fill(.1)] };
    } },
    CLIPROXY: { fetch: async (_url: unknown, init: RequestInit) => {
      state.getStore().proxyCalls++;
      const payload = JSON.parse(String(init.body));
      return Response.json({ choices: [{ finish_reason: "stop", message: { content:
        payload.model === "gpt-5.6-terra" ? "Synthetic project evidence summarized."
          : JSON.stringify({ importance: 3, canonical: false, kind: "semantic" }) } }] });
    } },
    VECTORIZE: {
      query: async (_v: unknown, options: any) => {
        state.getStore().vectorCalls++;
        return { matches: options?.filter ? [] : Array.from({ length: 4 }, (_, i) => ({
          id: `solo-e${11 + i}`, score: .95, metadata: embeddingMetadata(),
        })) };
      },
      upsert: async () => { state.getStore().vectorCalls++; return { mutationId: "m" }; },
      deleteByIds: async () => { state.getStore().vectorCalls++; return { mutationId: "m" }; },
      getByIds: async () => { state.getStore().vectorCalls++; return []; },
      describe: async () => ({ vectorCount: 0, processedUpToMutation: "m", processedUpToDatetime: "9999-12-31T23:59:59.999Z" }),
    },
  };
  environments.set(env, result);
  return result;
}

async function reset(env: any, ctx: ExecutionContext) {
  const fixture = await env.DB.prepare("SELECT COUNT(*) AS n FROM sb80_fixture").first();
  if (fixture?.n !== 200) throw new Error("Wrong staging fixture");
  const admission = await beginMemoryWriteAdmission(env, ctx);
  try {
    const e = admission.env;
    const remove = memoryWriteMarker(e, "delete");
    const write = memoryWriteMarker(e);
    await e.DB.batch([
      e.DB.prepare("UPDATE edges SET write_marker = ?").bind(remove),
      e.DB.prepare("DELETE FROM edges"),
      e.DB.prepare("UPDATE vector_cleanup_ops SET write_marker = ?").bind(remove),
      e.DB.prepare("DELETE FROM vector_cleanup_ops"),
      e.DB.prepare("UPDATE entries SET write_marker = ? WHERE id NOT IN (SELECT id FROM sb80_fixture)").bind(remove),
      e.DB.prepare("DELETE FROM entries WHERE id NOT IN (SELECT id FROM sb80_fixture)"),
      e.DB.prepare(`UPDATE entries SET
        content = (SELECT content FROM sb80_fixture f WHERE f.id = entries.id),
        tags = (SELECT tags FROM sb80_fixture f WHERE f.id = entries.id),
        vector_ids = '[]', updated_at = NULL, staleness_checked_at = NULL,
        importance_score = 0, recall_count = 0, last_recalled_at = NULL,
        pending_append_passages = '[]', write_marker = ?
        WHERE id IN (SELECT id FROM sb80_fixture)`).bind(write),
      e.DB.prepare("DELETE FROM maintenance_cursor"),
    ]);
  } finally { await admission.finish(); }
}

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    if (!env.STAGING_TOKEN || request.headers.get("authorization") !== `Bearer ${env.STAGING_TOKEN}`)
      return new Response("Unauthorized", { status: 401 });
    const path = new URL(request.url).pathname;
    const cron = request.headers.get("x-sb80-cron") ?? "0 1 * * *";
    if (request.method !== "POST" || !["/run", "/reset"].includes(path)
      || !["0 1 * * *", "10 1 * * *"].includes(cron)) return new Response("Not found", { status: 404 });
    const id = request.headers.get("x-sb80-sample") ?? "";
    if (!/^[a-z0-9-]{1,59}$/.test(id)) return new Response("Invalid sample", { status: 400 });
    const s: any = metricsFor(id);
    return state.run(s, async () => {
      const pending: Promise<unknown>[] = [];
      const tracked = Object.create(ctx) as ExecutionContext;
      tracked.waitUntil = (p: Promise<unknown>) => { pending.push(p); ctx.waitUntil(p); };
      try {
        const scheduledTime = Date.now();
        if (path === "/reset") await reset(adapted(env), tracked);
        else await production.scheduled({ cron, scheduledTime } as ScheduledEvent, adapted(env), tracked);
        while (pending.length) {
          const settled = await Promise.allSettled(pending.splice(0));
          if (settled.some(result => result.status === "rejected")) throw new Error("Background task rejected");
        }
        const metrics = { ...serializable(s), scheduledTime,
          ...(path === "/run" && env.MCP_EXECUTOR ? {
            executor: await env.MCP_EXECUTOR.getByName("nightly-v1").takeMetrics(scheduledTime),
          } : {}),
        };
        // 既存のログ秘匿を維持し、許可済みイベントでTailのCPUと対応づける。
        // SQL本文を含まないD1メタデータは認証済みレスポンスだけに返す。
        console.log(JSON.stringify({ event: "http_request", operation: `sb80-${id}`,
          method: "POST", status: 200, outcome: "success" }));
        return Response.json(metrics);
      } catch {
        console.log(JSON.stringify({ event: "http_request", operation: `sb80-${id}`,
          method: "POST", status: 500, outcome: "error" }));
        return new Response("Staging operation failed", { status: 500 });
      }
    });
  },
};
