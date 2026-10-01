/** Opt-in, local-only Issue #54 replay. Uses the production recall pipeline. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import { observeWorkersAiQuotaError } from "../../src/lib/ai";
import { recallEntries } from "../../src/recall/search";
import type { Identity } from "../../src/lib/identity";
import type { RecallDiagnostics } from "../../src/recall/types";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../../test/helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../../test/helpers/sqlite-d1";

const NOW = Date.UTC(2026, 8, 6);
const OLD = NOW - 180 * 86_400_000;
const modes = ["healthy", "quota", "embedding-failure", "vector-failure"] as const;
const workloads = ["ordinary-noise", "excluded-window", "equal-authority-overflow", "no-answer"] as const;
const languages = ["en", "ja"] as const;
const root = resolve(import.meta.dirname, "../..");
const identity: Identity = { userId: "synthetic", role: "member", personalWorkspaceId: "load-own",
  companyWorkspaceIds: [], defaultShare: "" };
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
function hashFiles(paths: string[]): string {
  const h = createHash("sha256");
  for (const path of [...paths].sort()) h.update(path).update("\0").update(readFileSync(resolve(root, path))).update("\0");
  return h.digest("hex");
}
function files(path: string): string[] {
  return readdirSync(resolve(root, path), { withFileTypes: true })
    .flatMap(item => item.isDirectory() ? files(`${path}/${item.name}`) : [`${path}/${item.name}`]);
}
function integer(value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error("Invalid bounded replay setting");
  return Number(value);
}
const sizes = (process.env.RECALL_LOAD_SIZES ?? "200,1000,10000").split(",").map(value => integer(value, 200, 10000));
if (sizes.length > 3 || new Set(sizes).size !== sizes.length) throw new Error("Use one to three distinct sizes");
const repeats = integer(process.env.RECALL_LOAD_REPEATS ?? "5", 1, 20);
const output = process.env.RECALL_LOAD_OUTPUT;
if (!output) throw new Error("RECALL_LOAD_OUTPUT is required; existing files are never overwritten");
afterEach(() => vi.restoreAllMocks());

it("records synthetic replay observations without calling them Cloudflare measurements", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  // Expected injected provider outages should not bury the metadata-only report.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const samples: Record<string, unknown>[] = [];
  for (const size of sizes) for (const workload of workloads) for (const language of languages) {
    const sqlite = makeSqliteD1();
    try {
      const word = language === "en" ? "cat" : "認証";
      const query = workload === "no-answer" ? "unobtainium-9f872e" : word;
      const recipe: Parameters<SqliteD1["seed"]>[0][] = [{ id: "answer", content: `${word} decision approved.`,
        createdAt: OLD, importanceScore: 5, tags: ["kind:semantic", "status:canonical"] }];
      for (let i = 0; i < size - 1; i++) {
        const excluded = workload === "excluded-window" && i >= 8;
        const authority = workload === "equal-authority-overflow" && i < 40;
        const usable = workload === "excluded-window" && i < 8;
        recipe.push({ id: `noise-${i}`, createdAt: NOW - i,
          content: excluded || authority || usable ? `${word} decision approved.`
            : language === "en" ? "We concatenate routine fields." : "認証x 定例メモ。",
          importanceScore: excluded || authority ? 5 : 0,
          tags: ["kind:semantic", ...(excluded || authority || usable ? ["status:canonical"] : []),
            ...(excluded ? ["status:deprecated"] : [])],
        });
      }
      for (const entry of recipe) sqlite.seed(entry);
      await sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE 1").bind("load-own").run();
      const fixtureSha256 = hash(JSON.stringify({ now: NOW, recipe, workspace: "load-own", query }));
      const candidateCalls: { rows: number; ms: number; binds: number }[] = [];
      const prepare = sqlite.db.prepare.bind(sqlite.db);
      const spy = vi.spyOn(sqlite.db, "prepare").mockImplementation(sql => {
        const statement = prepare(sql);
        if (!sql.startsWith("SELECT id, content, tags, source, created_at FROM entries WHERE")) return statement;
        const bind = statement.bind.bind(statement);
        statement.bind = (...args) => {
          const bound = bind(...args); const all = bound.all.bind(bound);
          bound.all = async () => {
            const start = performance.now(); const result = await all();
            candidateCalls.push({ rows: result.results.length, ms: performance.now() - start, binds: args.length });
            return result;
          };
          return bound;
        };
        return statement;
      });
      // One unrecorded warm-up per mode. Every measured invocation still gets a
      // fresh KV and reset recall counters; no result/cache feedback between arms.
      for (const mode of modes) for (let repetition = -1; repetition < repeats; repetition++) {
        await sqlite.db.prepare("UPDATE entries SET recall_count = 0, last_recalled_at = NULL WHERE 1").run();
        const vector = vi.fn().mockResolvedValue({ matches: workload === "no-answer" ? [] : [{
          id: "v-answer", score: .99, values: Array(128).fill(.1),
          metadata: { parentId: "answer", created_at: OLD, workspace_id: "load-own" },
        }] });
        if (mode === "vector-failure") vector.mockRejectedValue(new Error("synthetic vector failure"));
        const env = sqlite.admitEnv(makeTestEnv(undefined, {
          DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(),
          VECTORIZE: makeVectorizeMock({ query: vector }),
        }));
        if (mode === "quota") await observeWorkersAiQuotaError(env, new Error("4006: daily free allocation used"));
        if (mode === "embedding-failure") vi.mocked(env.AI.run).mockRejectedValue(new Error("synthetic embedding failure"));
        const pending: Promise<unknown>[] = [];
        const ctx = { waitUntil: (task: Promise<unknown>) => { pending.push(task); } } as ExecutionContext;
        const diagnostics: RecallDiagnostics = {};
        candidateCalls.length = 0;
        const cpu = process.cpuUsage(); const start = performance.now();
        let handlerMs = 0;
        let result: Awaited<ReturnType<typeof recallEntries>>;
        try {
          result = await recallEntries({ query, topK: 5, hops: 0, kind: "semantic", synthesize: false },
            env, ctx, DEFAULTS, { identity, diagnostics });
          handlerMs = performance.now() - start;
        } finally {
          for (let i = 0; i < pending.length; i++) await pending[i];
        }
        const completedMs = performance.now() - start; const usedCpu = process.cpuUsage(cpu);
        expect(diagnostics.keywordIds?.length ?? 0).toBeLessThanOrEqual(128);
        expect(candidateCalls.length).toBeLessThanOrEqual(2);
        const rows = candidateCalls.reduce((sum, call) => sum + call.rows, 0);
        expect(rows).toBeLessThanOrEqual(mode === "vector-failure" ? 160 : 128);
        expect(candidateCalls.every(call => call.binds <= 100)).toBe(true);
        expect(diagnostics.operations?.d1RowsRead).toBeNull();
        if (repetition < 0) continue;
        samples.push({ id: `${size}/${workload}/${language}/${mode}/${repetition}`,
          size, workload, language, mode, repetition, fixtureSha256,
          expectation: workload === "equal-authority-overflow" && mode !== "healthy" ? "known-limit"
            : workload === "no-answer" ? "empty" : "find-answer",
          rank: workload === "no-answer" ? null : result.matches.findIndex(row => row.id === "answer") + 1,
          returned: result.matches.length, keywordCandidates: diagnostics.keywordIds?.length ?? 0,
          candidateSelects: candidateCalls.length, candidateRowsReturned: rows,
          candidateSqlMs: candidateCalls.reduce((sum, call) => sum + call.ms, 0),
          handlerMs, completedMs, nodeProcessCpuMs: (usedCpu.user + usedCpu.system) / 1000,
          semanticUnavailable: result.semanticUnavailable,
          d1BindingCalls: diagnostics.operations?.d1Statements,
          aiCalls: diagnostics.operations?.aiCalls, vectorQueries: diagnostics.operations?.vectorizeQueries,
          cloudflareRowsRead: null, publicWorkerCpuMs: null, durableObjectCpuMs: null,
        });
      }
      spy.mockRestore();
    } finally { sqlite.close(); }
  }
  const search = readFileSync(resolve(root, "src/recall/search.ts"));
  const report = {
    schema: "recall-load-local.v1", environment: "node-sqlite-synthetic", createdAt: new Date().toISOString(),
    node: process.version, platform: `${process.platform}/${process.arch}`,
    sourceSha256: hashFiles(files("src")), schemaSha256: hashFiles(["db/schema.sql"]),
    harnessSha256: hashFiles(["experiments/recall-load/replay.test.ts", "experiments/recall-load/vitest.config.ts",
      "test/helpers/sqlite-d1.ts", "test/helpers/make-env.ts", "vitest.config.ts", "vitest.setup.ts", "package-lock.json"]),
    searchBlob: createHash("sha1").update(`blob ${search.length}\0`).update(search).digest("hex"),
    settings: { sizes, repeats, modes, workloads, languages, candidateCap: 128, topK: 5, hops: 0, cache: "fresh-kv-per-invocation" },
    remoteMeasurements: false, realModelQualityMeasured: false, samples,
  };
  expect(samples).toHaveLength(sizes.length * workloads.length * languages.length * modes.length * repeats);
  writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}, 180_000);
