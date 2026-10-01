/** 実 scheduled 入口の SQL 診断。ローカル時間や返却行数を課金指標にしない。 */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { STALENESS_AGE_MS } from "../../src/staleness/pass";
import { makeSqliteD1 } from "../../test/helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../../test/helpers/make-env";

type Trace = { sql: string; bindings: unknown[]; plan: unknown[]; changes: number | null; error: boolean };
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const output = process.env.NIGHTLY_PROBE_OUTPUT;
if (!output) throw new Error("NIGHTLY_PROBE_OUTPUT に新しいローカル出力先を指定してください");
const out = resolve(output);
mkdirSync(out, { recursive: true, mode: 0o700 });
const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
execFileSync("git", ["diff", "--exit-code", "HEAD", "--", "src", "db", "wrangler.jsonc", "package.json", "package-lock.json"]);
const hashes = Object.fromEntries([
  "experiments/nightly-perf/local-probe.test.ts", "test/helpers/sqlite-d1.ts",
  "test/helpers/make-env.ts", "vitest.setup.ts", "db/schema.sql", "package-lock.json",
].map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
const split = readFileSync("wrangler.jsonc", "utf8").includes('"10 1 * * *"');

beforeEach(() => { vi.restoreAllMocks(); resetDatabaseInit(); });
afterEach(() => { vi.restoreAllMocks(); resetDatabaseInit(); });

it.each([200, 1000, 10000].flatMap(size => [false, true].map(multi => ({ size, multi }))))(
  "実夜間SQL・元記憶保持・workspace境界: %j", async ({ size, multi }) => {
    // SQLite trigger の実時刻より未来の土曜。両armは同じUTC日に実行し、出力でも照合する。
    const date = new Date();
    const now = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(),
      date.getUTCDate() + 7 + ((6 - date.getUTCDay() + 7) % 7), 1);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const sq = makeSqliteD1({ autoAdmitFixtureWrites: false });
    try {
      const kv = makeMemoryKV();
      await initializeDatabase(makeTestEnv(undefined, { DB: sq.db as unknown as D1Database, OAUTH_KV: kv }));
      const spaces = multi ? ["ws-a", "ws-z"] : [""];
      const selected = spaces[0];
      for (const workspaceId of spaces) {
        for (let i = 0; i < size; i++) sq.seed({
          id: `${workspaceId || "solo"}-e${i}`,
          content: `Synthetic person ${i} works on project ${Math.floor(i / 11) % 7}.`,
          tags: i < 77 ? [`topic-${Math.floor(i / 11)}`] : ["noise", "synthesized", "status:deprecated"],
          source: "api", createdAt: now - STALENESS_AGE_MS - 86400000 + i,
          workspaceId,
        });
      }
      const originals = sq.rows().map(row => [row.id, row.content, row.workspace_id]);
      const originalHash = hash(originals);
      const originalIds = new Set(originals.map(row => row[0]));
      const otherHash = hash(sq.rows().filter(row => row.workspace_id === "ws-z"));
      const traces: Trace[] = [];
      const bindingsByStatement = new WeakMap<object, { inner: any; sql: string; args: unknown[] }>();
      const prepareTrace = async (sql: string, args: unknown[]) => {
        const plan = (await sq.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all()).results;
        const item: Trace = { sql: normalize(sql), bindings: args, plan, changes: null, error: false };
        traces.push(item);
        return item;
      };
      const wrap = (inner: any, sql: string, args: unknown[] = []): any => {
        const invoke = async (method: string, extra: unknown[] = []) => {
          const item = await prepareTrace(sql, args);
          try {
            const result = await inner[method](...extra);
            item.changes = result?.meta?.changes ?? null;
            return result;
          } catch (error) { item.error = true; throw error; }
        };
        const result = {
          bind: (...values: unknown[]) => wrap(inner.bind(...values), sql, values),
          all: () => invoke("all"), run: () => invoke("run"),
          first: (...extra: unknown[]) => invoke("first", extra),
        };
        bindingsByStatement.set(result, { inner, sql, args });
        return result;
      };
      const DB = {
        prepare: (sql: string) => wrap(sq.db.prepare(sql), sql),
        exec: () => { throw new Error("計測区間内の予期しないDDL"); },
        batch: async (batch: object[]) => {
          const parts = batch.map(stmt => {
            const part = bindingsByStatement.get(stmt);
            if (!part) throw new Error("未知のstatement");
            return part;
          });
          const items = await Promise.all(parts.map(part => prepareTrace(part.sql, part.args)));
          try {
            const results = await sq.db.batch(parts.map(part => part.inner));
            results.forEach((result, i) => { items[i].changes = (result.meta as any).changes ?? null; });
            return results;
          } catch (error) { items.forEach(item => { item.error = true; }); throw error; }
        },
      } as unknown as D1Database;
      const counts = { kvGet: 0, kvPut: 0, proxy: 0 };
      const env = makeTestEnv(undefined, {
        DB,
        OAUTH_KV: { ...kv,
          get: async (...args: any[]) => { counts.kvGet++; return (kv.get as any)(...args); },
          put: async (...args: any[]) => { counts.kvPut++; return (kv.put as any)(...args); },
        } as KVNamespace,
        VECTORIZE: makeVectorizeMock({ query: vi.fn(async (_v, options) => ({ matches: options?.filter ? []
          : Array.from({ length: 4 }, (_, i) => ({ id: `${selected || "solo"}-e${11 + i}`, score: 0.95 })) })) }),
        CLIPROXY_API_KEY: "synthetic-local-only", CLIPROXY_MODEL: "gpt-5.6-luna",
        CLIPROXY_OPERATIONS: "classify,query-tags,smart-merge,contradiction,recall-summary,digest,answer,weekly-insight",
        CLIPROXY: { fetch: async (_url: unknown, init: RequestInit) => {
          counts.proxy++;
          const payload = JSON.parse(String(init.body));
          return Response.json({ choices: [{ finish_reason: "stop", message: { content:
            payload.model === "gpt-5.6-terra" ? "Synthetic project evidence summarized."
              : JSON.stringify({ importance: 3, canonical: false, kind: "semantic" }) } }] });
        } } as Fetcher,
      });
      const logs: unknown[] = [];
      vi.spyOn(console, "log").mockImplementation(value => {
        try { logs.push(JSON.parse(String(value))); } catch { /* 非JSONログは集計しない */ }
      });
      const errors: string[] = [];
      vi.spyOn(console, "error").mockImplementation((...args) => errors.push(String(args[0])));
      resetDatabaseInit();
      const invocations = [];
      for (const cron of split ? ["0 1 * * *", "10 1 * * *"] : ["0 1 * * *"]) {
        const start = traces.length;
        const pending: Promise<unknown>[] = [];
        const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as ExecutionContext;
        await worker.scheduled({ cron, scheduledTime: now } as ScheduledEvent, env, ctx);
        while (pending.length) {
          const results = await Promise.allSettled(pending.splice(0));
          expect(results.every(result => result.status === "fulfilled")).toBe(true);
        }
        invocations.push({ cron, statements: traces.length - start });
      }
      const rows = sq.rows();
      const digests = rows.filter(row => !originalIds.has(row.id)
        && JSON.parse(String(row.tags)).includes("synthesized"));
      // 上流の圧縮処理は原文末尾に参照を追記する。今回作った実在digestへの参照だけを除く。
      const remainingOriginals = rows.filter(row => originalIds.has(row.id)).map(row => {
        let content = String(row.content);
        for (const digest of digests) {
          const suffix = `\n\n[Digest: ${digest.id}]`;
          if (content.endsWith(suffix)) content = content.slice(0, -suffix.length);
        }
        return [row.id, content, row.workspace_id];
      });
      const result = {
        schema: "nightly-local-probe.v1", source, hashes, now, sizePerWorkspace: size,
        totalSourceRows: size * spaces.length, workspaceCount: spaces.length, selectedWorkspace: selected,
        topology: split ? "split" : "combined", invocations, counts, logs, errors,
        originalHash, afterOriginalHash: hash(remainingOriginals),
        otherWorkspaceUnchanged: !multi || hash(rows.filter(row => row.workspace_id === "ws-z")) === otherHash,
        synthesized: digests.length,
        trace: traces, billedRowsMeasured: false, remoteCpuMeasured: false, realProviderMeasured: false,
      };
      writeFileSync(resolve(out, `${size}-${multi ? "multi" : "solo"}.json`), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      expect(result.afterOriginalHash).toBe(originalHash);
      expect(result.otherWorkspaceUnchanged).toBe(true);
      expect(result.synthesized).toBeGreaterThan(0);
      expect(traces.some(trace => trace.error)).toBe(false);
      expect(errors).toEqual([]);
    } finally { sq.close(); }
  },
);
