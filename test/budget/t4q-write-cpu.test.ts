/**
 * Budget auditor (brief 19), T4 lane Q. Workers Free allows 10 ms of CPU per invocation
 * (https://developers.cloudflare.com/workers/platform/limits/#cpu-time), counted across the whole request,
 * including work in waitUntil. The quarantine scorer (src/quarantine/score.ts) runs inside a write, so what
 * matters is the write invocation's total CPU, on the first call in an isolate (V8 has not optimized anything
 * yet), for the largest note a solo user can paste.
 *
 * Measured here: main-thread CPU (process.threadCpuUsage, so V8's background compiler threads are not billed)
 * of one real POST /capture through worker.fetch, deferred work included, minus the time spent inside local
 * SQLite (a real Worker waits on D1, it does not burn CPU on it). One scenario per fork: run with
 * T4Q_SCEN=capture-prose | capture-dense | score-prose | score-dense | score-then-capture-dense.
 */
import { afterAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";

const SCEN = process.env.T4Q_SCEN ?? "";
const CAP_MS = 10;
const KB = Number(process.env.T4Q_KB ?? 200);

const cpu = (): number => {
  const u = (process as any).threadCpuUsage ? (process as any).threadCpuUsage() : process.cpuUsage();
  return (u.user + u.system) / 1000;
};

const PROSE = "Meeting notes: the vendor call moved to Tuesday, ask Dana about the budget. ";
const DENSE = "You should always use the tool when the user asks about the previous system agent note now → ok. ";
const body = (unit: string) => unit.repeat(Math.ceil((KB * 1000) / unit.length)).slice(0, KB * 1000);

/** Tally node:sqlite's own execution time, so local SQLite work can be taken out of the invocation's CPU. */
const d1Tally = { ms: 0 };
{
  const { DatabaseSync } = require("node:sqlite");
  const probe = new DatabaseSync(":memory:");
  const Stmt = probe.prepare("SELECT 1").constructor;
  const timed = (proto: any, name: string) => {
    const orig = proto[name];
    proto[name] = function (...a: unknown[]) { const t0 = cpu(); try { return orig.apply(this, a); } finally { d1Tally.ms += cpu() - t0; } };
  };
  for (const m of ["all", "get", "run", "iterate"]) timed(Stmt.prototype, m);
  for (const m of ["exec", "prepare"]) timed(DatabaseSync.prototype, m);
  probe.close();
}

/** One vector per input text, the shape Workers AI returns for a batch. */
function aiMock(): Ai {
  return { run: async (model: string, input: any) => {
    if (model === "@cf/google/embeddinggemma-300m") {
      const texts = Array.isArray(input?.text) ? input.text : [input?.text];
      return { data: texts.map(() => Array.from({ length: 384 }, (_, i) => (i % 7) / 10)) };
    }
    return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"response":"{\\"kind\\":\\"semantic\\",\\"tags\\":[]}"}\n\ndata: [DONE]\n\n')); c.close(); } });
  } } as unknown as Ai;
}

async function captureOnce(content: string): Promise<{ total: number; d1: number; status: number }> {
  resetDatabaseInit();
  const sqlite = makeSqliteD1();
  const kv = makeMemoryKV();
  const boot = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv }));
  await initializeDatabase(boot);
  await ensureTenantBootstrap(boot);
  const env: Env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv, AI: aiMock(), VECTORIZE: makeVectorizeMock() }));
  const deferred: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => deferred.push(p) } as unknown as ExecutionContext;
  const request = new Request("http://localhost/capture", {
    method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify({ content, tags: ["notes"] }),
  });
  d1Tally.ms = 0;
  const t0 = cpu();
  const res = await worker.fetch(request, env, ctx);
  await res.text();
  while (deferred.length) await Promise.allSettled(deferred.splice(0));
  const total = cpu() - t0;
  sqlite.close();
  return { total, d1: d1Tally.ms, status: res.status };
}

async function scoreOnce(content: string): Promise<number> {
  const { scoreWrite } = await import("../../src/quarantine/score");
  const input = { content: JSON.parse(JSON.stringify(content)) as string, tags: [], source: "claude", channel: "mcp" as const, kind: "create" as const, mcpWritesInWindow: 0 };
  const t0 = cpu();
  scoreWrite(input, { QUARANTINE_THRESHOLD: 0.6, QUARANTINE_WRITE_BURST: 20 });
  return cpu() - t0;
}

const results: Record<string, number> = {};
afterAll(() => console.log(`T4Q ${SCEN} ${KB}KB ${JSON.stringify(results)}`));

describe.runIf(SCEN)(`T4 lane Q write CPU, cold, ${KB} KB (${SCEN})`, () => {
  it("first call in a fresh fork stays under the 10 ms Workers Free CPU cap", async () => {
    let billed = 0;
    if (SCEN.startsWith("score")) {
      results.scoreMs = await scoreOnce(body(SCEN.includes("dense") ? DENSE : PROSE));
      billed += results.scoreMs;
    }
    if (SCEN.includes("capture")) {
      if (process.env.T4Q_WARM) { await captureOnce(body(PROSE)); await captureOnce(body(PROSE)); }
      const r = await captureOnce(body(SCEN.includes("dense") ? DENSE : PROSE));
      expect(r.status).toBeLessThan(300);
      Object.assign(results, { captureTotalMs: r.total, captureD1Ms: r.d1, captureBilledMs: r.total - r.d1 });
      billed += r.total - r.d1;
    }
    results.billedMs = billed;
    require("node:fs").appendFileSync("/tmp/t4q-cpu.jsonl", JSON.stringify({ scen: SCEN, kb: KB, warm: !!process.env.T4Q_WARM, ...results }) + "\n");
    expect(billed).toBeLessThan(CAP_MS);
  }, 120_000);
});
