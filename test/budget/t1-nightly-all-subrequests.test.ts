/**
 * Budget auditor (brief 19), Track 1 as it merges (v4/t1-foundations 2e879ccc + v4/t1-close 9562edda).
 * Workers Free allows 1,000 subrequests to Cloudflare services per invocation, and every nightly job runs inside
 * the ONE "0 1 * * *" scheduled() invocation. test/unit/cron-subrequest-budget.test.ts bills D1 executions and
 * KV only; this counts every binding call (D1 executions with a batch as one, KV, Workers AI, Vectorize) for one
 * real nightly run with Track 1's two passes at their ceilings: the vectorize-pending pass with 10 deferred rows of
 * 5 chunks each (its 50-embed budget), and the trash purge over expired rows with versions.
 * Requires src/vectorize/pending.ts (t1-close); skipped where it does not exist yet.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import worker from "../../src/index";

const HAS_PENDING = existsSync(resolve(__dirname, "../../src/vectorize/pending.ts"));
const CLOUDFLARE_SUBREQUESTS = 1000;
const OLD = Date.now() - 60 * 60_000;

let close: (() => void) | undefined;
afterEach(() => close?.());

describe.runIf(HAS_PENDING)("the whole nightly invocation, every binding counted", () => {
  // The default ceiling case, and budget auditor R11 pinned: one legacy 3.7 row of 2,000,000 characters (3.7 had no
  // size cap), which embedded 1,521 chunks (about 1,061 neurons) in one night at eaf5c8d1.
  it.each([
    ["the default ceiling", Number(process.env.T1N_ROWS ?? 10), Number(process.env.T1N_CHARS ?? 7_500)],
    ["R11: one legacy 2 MB row", 1, 2_000_000],
  ])("stays well inside 1,000 Cloudflare-service subrequests with Track 1's passes at their ceilings (%s)", async (_label, rows, chars) => {
    const { makeTrashEnv, seedTrashRows, seedVersionsFor } = await import("../helpers/trash-env");
    const bill: Record<string, number> = { d1: 0, kv: 0, ai: 0, vectorize: 0 };
    const d1Sql: string[] = [];
    // One vector per input text, as Workers AI returns for a batch (embedMany checks the count).
    const ai = { run: async (model: string, input: any) => {
      if (model === "@cf/google/embeddinggemma-300m") {
        const texts = Array.isArray(input?.text) ? input.text : [input?.text];
        return { data: texts.map(() => Array.from({ length: 384 }, (_, i) => (i % 7) / 10)) };
      }
      return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"response":"ok"}\n\ndata: [DONE]\n\n')); c.close(); } });
    } } as unknown as Ai;
    const embedTexts: number[] = [];
    const t = await makeTrashEnv({ AI: ai });
    close = () => t.close();

    // Deferred rows at the pass's ceiling: T1N_ROWS rows of T1N_CHARS characters (defaults: 10 rows of 5 chunks).
    const sentence = "The deferred note keeps a sentence break every so often so chunking behaves as in production. ";
    for (let i = 0; i < rows; i++) t.seed(`deferred-${i}`, { content: `Row ${i}. ${sentence.repeat(Math.ceil(chars / sentence.length))}`.slice(0, chars), created_at: OLD + i });
    // Expired trash with versions, so the purge runs its batches.
    const expired = Date.now() - 30 * 86_400_000;
    await seedTrashRows(t, 50, { prefix: "gone", deletedAt: expired });
    await seedVersionsFor(t, Array.from({ length: 50 }, (_, i) => `gone${i}`), 20);

    const db = t.env.DB as any;
    const wrap = (s: any, sql = ""): any => new Proxy(s, { get(target, p) {
      if (p === "__inner") return target;
      if (p === "bind") return (...a: unknown[]) => wrap(target.bind(...a), sql);
      if (p === "all" || p === "first" || p === "run" || p === "raw") return (...a: unknown[]) => { bill.d1++; d1Sql.push(sql); return target[p](...a); };
      const v = target[p]; return typeof v === "function" ? v.bind(target) : v;
    } });
    const prepare = db.prepare.bind(db), batch = db.batch.bind(db), exec = db.exec.bind(db);
    const kv = t.env.OAUTH_KV as any, vz = t.env.VECTORIZE as any;
    const counted = (obj: any, key: string) => new Proxy(obj, { get(target, p) {
      const v = target[p];
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => { bill[key]++; return v.apply(target, a); };
    } });
    const env = {
      ...t.env,
      DB: { prepare: (sql: string) => wrap(prepare(sql), sql.replace(/\s+/g, " ").trim().slice(0, 60)), batch: (s: any[]) => { bill.d1++; d1Sql.push("BATCH"); return batch(s.map((x: any) => x.__inner ?? x)); }, exec: (q: string) => { bill.d1++; d1Sql.push("EXEC " + q.slice(0, 40)); return exec(q); } },
      OAUTH_KV: counted(kv, "kv"), VECTORIZE: counted(vz, "vectorize"), AI: { run: (m: string, input: any) => { bill.ai++; if (String(m).startsWith("@cf/baai/bge")) embedTexts.push(...(Array.isArray(input?.text) ? input.text : [input?.text]).map((x: string) => x.length)); return (ai as any).run(m, input); } },
    };

    const cpu = () => { const u = (process as any).threadCpuUsage ? (process as any).threadCpuUsage() : process.cpuUsage(); return (u.user + u.system) / 1000; };
    const t0 = cpu();
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ cron: "0 1 * * *", scheduledTime: Date.now() } as ScheduledEvent, env as any, { waitUntil: (p: Promise<unknown>) => pending.push(p) } as any);
    await Promise.allSettled(pending);

    const cpuMs = cpu() - t0;
    const total = bill.d1 + bill.kv + bill.ai + bill.vectorize;
    // bge-small reads at most 512 tokens of each input; about 4 characters a token.
    const neurons = embedTexts.reduce((a, len) => a + Math.min(len / 4, 512), 0) * 1841 / 1e6;
    require("node:fs").writeFileSync(process.env.T1_NIGHTLY_OUT ?? "/tmp/t1-nightly-bill.json", JSON.stringify({ rows, chars, ...bill, total, embeddedChunks: embedTexts.length, neurons: Math.round(neurons), cpuMsInclSqlite: Math.round(cpuMs), d1Sql }));
    expect(total).toBeLessThan(CLOUDFLARE_SUBREQUESTS / 2);
    // The pass's own budget is 250 chunks a night (plus up to 25 graph-pass embeds). "The oldest row always gets the
    // night, all of it" lets one legacy row over 128 KB (3.7 had no size cap) exceed it: T1N_ROWS=1 T1N_CHARS=2000000
    // embeds 1,521 chunks at 1619f2ad, about 1,100 neurons, and repeats every night if the cron is killed for CPU.
    expect(embedTexts.length).toBeLessThanOrEqual(250 + 25);
  }, 60_000);
});
