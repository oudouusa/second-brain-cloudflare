import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveConfig, type Config } from "../../src/config";
import { ENTRY_COUNTS_TABLE_DDL } from "../../src/db/init";
import { EMBEDDING_PROFILE } from "../../src/embedding/profile";
import type { Env } from "../../src/env";
import type { Identity } from "../../src/lib/identity";
import { scopeWhereForRead } from "../../src/lib/scope";
import { readQuerySignalCache, type QuerySignalCacheInput, type QuerySignals } from "../../src/recall/query-signal-cache";
import { recallEntries } from "../../src/recall/search";
import { renderRecallText } from "../../src/recall/render";
import type { RecallDiagnostics } from "../../src/recall/types";
import { makeTestEnv } from "../../test/helpers/make-env";
import { makeSqliteD1 } from "../../test/helpers/sqlite-d1";
import { fixtureVectorize, type FixtureVector } from "./vectorize-fixture";

type TraceSink = { fusion: unknown[]; rerank: unknown[]; mmr: unknown[]; distill?: unknown };
const activeTrace = () => (globalThis as typeof globalThis & { __knownItemTrace?: TraceSink }).__knownItemTrace;

vi.mock("../../src/recall/rrf", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/recall/rrf")>();
  return { ...actual, rrfFuse: (...args: Parameters<typeof actual.rrfFuse>) => {
    const scores = actual.rrfFuse(...args);
    activeTrace()?.fusion.push({ dense: args[0], keyword: args[1], ranked: [...scores]
      .sort((a, b) => b[1] - a[1]) });
    return scores;
  } };
});

vi.mock("../../src/recall/math", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/recall/math")>();
  const ids = (matches: { id: string; metadata?: Record<string, unknown>; score: number }[]) =>
    matches.map(match => ({ id: String(match.metadata?.parentId ?? match.id), score: match.score }));
  return {
    ...actual,
    rerankWithTimeDecay: (...args: Parameters<typeof actual.rerankWithTimeDecay>) => {
      const output = actual.rerankWithTimeDecay(...args);
      activeTrace()?.rerank.push({ input: ids(args[0]), output: ids(output) });
      return output;
    },
    mmrRerank: <T extends import("../../src/recall/math").VectorizeMatch>(...args: Parameters<typeof actual.mmrRerank<T>>) => {
      const output = actual.mmrRerank(...args);
      activeTrace()?.mmr.push({ input: ids(args[0]), output: ids(output) });
      return output;
    },
  };
});

vi.mock("../../src/recall/distill", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/recall/distill")>();
  return { ...actual, distillToRareTerms: async (...args: Parameters<typeof actual.distillToRareTerms>) => {
    const result = await actual.distillToRareTerms(...args);
    const trace = activeTrace();
    if (trace) trace.distill = { terms: result.terms, df: result.df ? [...result.df] : null,
      total: result.total, source: result.distillSource };
    return result;
  } };
});

vi.mock("../../src/recall/query-signal-cache", () => ({
  readQuerySignalCache: vi.fn(),
  writeQuerySignalCache: vi.fn(),
}));

const ROOT = process.env.KNOWN_ITEM_FIXTURES;
const MODE = process.env.KNOWN_ITEM_MODE ?? "record";
const RUN_ID = process.env.KNOWN_ITEM_RUN_ID ? `-${process.env.KNOWN_ITEM_RUN_ID}` : "";
const INPUT_RUN_ID = process.env.KNOWN_ITEM_INPUT_RUN_ID ? `-${process.env.KNOWN_ITEM_INPUT_RUN_ID}` : RUN_ID;

function fixedNow(): { timestamp: number; iso: string } {
  const value = process.env.KNOWN_ITEM_NOW;
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error("KNOWN_ITEM_NOW must be an ISO 8601 timestamp with a timezone");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("KNOWN_ITEM_NOW must be a valid ISO 8601 timestamp");
  return { timestamp, iso: new Date(timestamp).toISOString() };
}

function validateRunId(value: string | undefined, name: string): void {
  if (value && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`${name} must contain only letters, digits, underscores, or hyphens`);
  }
}

interface QueryCase {
  category: string;
  query: string;
  term: string;
  target: string;
}

class RecordStop extends Error {}

function readJson<T>(name: string): T {
  if (!ROOT) throw new Error("KNOWN_ITEM_FIXTURES is required");
  return JSON.parse(readFileSync(resolve(ROOT, name), "utf8")) as T;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Exact property order and null handling from src/recall/query-signal-cache.ts cacheKey().
function keyMaterial(input: Readonly<QuerySignalCacheInput>, config: Readonly<Config>): string {
  return JSON.stringify({
    version: 1,
    embeddingProfileId: EMBEDDING_PROFILE.profileId,
    embeddingPromptVersion: EMBEDDING_PROFILE.promptVersion,
    embeddingMode: input.embeddingMode,
    embeddingModel: config.EMBEDDING_MODEL,
    tagInferenceModel: config.LLM_MODEL,
    denseInput: input.denseInput,
    lexicalQuery: input.lexicalQuery,
    tag: input.tag?.trim().toLowerCase() || null,
    scopeKey: input.scopeKey ?? null,
  });
}

async function snapshotIdentity(db: ReturnType<typeof makeSqliteD1>["db"]): Promise<Identity> {
  const { results: users } = await db.prepare(
    "SELECT id, role, default_share FROM users WHERE role = 'admin' AND suspended = 0 AND (removed_at IS NULL OR removed_at = 0)",
  ).all();
  if (users.length !== 1) throw new Error(`Expected one active owner, got ${users.length}`);
  const user = users[0] as { id: string; role: "admin"; default_share: string };
  const { results: memberships } = await db.prepare(
    "SELECT w.id, w.kind FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.created_at, w.id",
  ).bind(user.id).all();
  const rows = memberships as { id: string; kind: string }[];
  const personal = rows.filter(row => row.kind === "personal");
  if (personal.length !== 1) throw new Error(`Expected one personal workspace, got ${personal.length}`);
  return {
    userId: user.id,
    role: user.role,
    defaultShare: user.default_share === "personal" || user.default_share === "company" ? user.default_share : "",
    personalWorkspaceId: personal[0].id,
    companyWorkspaceIds: rows.filter(row => row.kind === "company").map(row => row.id),
  };
}

afterEach(() => vi.restoreAllMocks());

it("records cache inputs from the production recall prelude, or replays supplied signals", async () => {
  if (MODE !== "record" && MODE !== "replay") throw new Error("KNOWN_ITEM_MODE must be record or replay");
  if (!ROOT) throw new Error("KNOWN_ITEM_FIXTURES is required");
  const now = fixedNow();
  validateRunId(process.env.KNOWN_ITEM_RUN_ID, "KNOWN_ITEM_RUN_ID");
  validateRunId(process.env.KNOWN_ITEM_INPUT_RUN_ID, "KNOWN_ITEM_INPUT_RUN_ID");
  const planQueries = new Set((process.env.KNOWN_ITEM_PLAN_QUERIES ?? "").split(",").map(query => query.trim()).filter(Boolean));
  const dbFile = process.env.KNOWN_ITEM_DB_FILE ?? "db.sql";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/.test(dbFile)) {
    throw new Error("KNOWN_ITEM_DB_FILE must be a SQL filename inside KNOWN_ITEM_FIXTURES");
  }
  vi.spyOn(Date, "now").mockReturnValue(now.timestamp);
  // A deliberate record stop is logged by recallEntries as an error. It is an expected boundary.
  if (MODE === "record") vi.spyOn(console, "error").mockImplementation(() => {});

  const sqlite = makeSqliteD1({ schema: false, autoAdmitFixtureWrites: false });
  const boundStatements: { sql: string; count: number }[] = [];
  const trackedDb = {
    ...sqlite.db,
    prepare(sql: string) {
      const statement = sqlite.db.prepare(sql);
      return new Proxy(statement, {
        get(target, property) {
          if (property === "bind") return (...args: unknown[]) => {
            boundStatements.push({ sql, count: args.length });
            return target.bind(...args);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  const aiCalls: string[] = [];
  const pending: Promise<unknown>[] = [];
  try {
    await sqlite.db.exec(readFileSync(resolve(ROOT, dbFile), "utf8"));
    // Table-selective D1 exports omit entry_counts. Rebuild this derived table only
    // in the in-memory SQLite fixture; recall's scoped corpus counts still need it.
    const countsTable = await sqlite.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entry_counts'",
    ).first();
    if (!countsTable) await sqlite.db.exec(`${ENTRY_COUNTS_TABLE_DDL};
      INSERT INTO entry_counts SELECT workspace_id, COUNT(*) FROM entries GROUP BY workspace_id;`);
    const identity = await snapshotIdentity(sqlite.db);
    const readScope = scopeWhereForRead(identity);
    const countFromEntries = await sqlite.db.prepare(
      `SELECT COUNT(*) AS total FROM entries WHERE ${readScope.clause}`,
    ).bind(...readScope.bindings).first() as { total: number };
    const countFromSnapshot = await sqlite.db.prepare(
      `SELECT COALESCE(SUM(n), 0) AS total FROM entry_counts WHERE ${readScope.clause}`,
    ).bind(...readScope.bindings).first() as { total: number };
    expect(countFromSnapshot.total).toBe(countFromEntries.total);
    const scopeTotal = countFromSnapshot.total;
    const queries = readJson<QueryCase[]>("queries.json");
    if (!queries.length || new Set(queries.map(item => item.query)).size !== queries.length) {
      throw new Error("queries.json must contain at least one query and no duplicate queries");
    }
    const vectors = readJson<FixtureVector[]>("vectors.json");
    const configOverrides = readJson<unknown>("config-overrides.json");
    const kv = {
      get: async (key: string) => key === "config:overrides" && configOverrides !== null
        ? JSON.stringify(configOverrides) : null,
      put: async () => {},
    } as unknown as KVNamespace;
    const env = makeTestEnv(undefined, {
      DB: trackedDb as unknown as Env["DB"],
      VECTORIZE: fixtureVectorize(vectors),
      OAUTH_KV: kv,
      AUTH_TOKEN: "offline-harness-only",
      AI: { run: async (model: string) => {
        aiCalls.push(`Workers AI: ${model}`);
        throw new Error("AI disabled in local replay");
      } } as unknown as Ai,
      CLIPROXY: { fetch: async () => {
        aiCalls.push("CLIProxy");
        throw new Error("AI disabled in local replay");
      } } as unknown as Fetcher,
    });
    const config = await resolveConfig(env);
    const ctx = { waitUntil: (task: Promise<unknown>) => { pending.push(task); } } as ExecutionContext;
    const records: unknown[] = [];
    const replaySignals = MODE === "replay"
      ? JSON.parse(readFileSync(resolve(ROOT, "../signals-by-input.json"), "utf8")) as Record<string, QuerySignals> : {};
    const replayResults: unknown[] = [];
    const inputRecords = MODE === "replay"
      ? (JSON.parse(readFileSync(resolve(ROOT, `../signals-inputs${INPUT_RUN_ID}.json`), "utf8")) as {
          records: { query: string; canonicalInput: string }[];
        }).records : [];

    for (const item of queries) {
      if (MODE === "replay") {
        const record = inputRecords.find(row => row.query === item.query);
        if (!record || !replaySignals[record.canonicalInput]) {
          replayResults.push({ query: item.query, target: item.target, rank: null, status: "missing-signal" });
          continue;
        }
      }
      let calls = 0;
      const sqlStart = sqlite.issued.length;
      const bindStart = boundStatements.length;
      const trace: TraceSink = { fusion: [], rerank: [], mmr: [] };
      (globalThis as typeof globalThis & { __knownItemTrace?: TraceSink }).__knownItemTrace = trace;
      vi.mocked(readQuerySignalCache).mockImplementationOnce(async (input, _env, cfg) => {
        calls++;
        const canonicalInput = stableJson(input);
        if (MODE === "record") {
          records.push({
            category: item.category,
            query: item.query,
            term: item.term,
            target: item.target,
            input,
            canonicalInput,
            keyMaterial: keyMaterial(input, cfg),
            settings: {
              EMBEDDING_MODEL: cfg.EMBEDDING_MODEL,
              LLM_MODEL: cfg.LLM_MODEL,
              embeddingMode: input.embeddingMode,
            },
          });
          throw new RecordStop();
        }
        const signal = replaySignals[canonicalInput];
        if (!signal || signal.values.length !== EMBEDDING_PROFILE.dimensions || !Array.isArray(signal.queryTags)) {
          throw new Error(`Missing or invalid signals for ${item.query}`);
        }
        return signal;
      });

      const diagnostics: RecallDiagnostics = {};
      const call = recallEntries({ query: item.query, topK: 5, hops: 0, synthesize: false },
        env, ctx, config, { identity, diagnostics });
      if (MODE === "record") {
        await expect(call).rejects.toBeInstanceOf(RecordStop);
      } else {
        const result = await call;
        const rendered = renderRecallText(result.matches, result.insight, {
          queryTokens: result.queryTokens,
          currentQueryTokens: result.currentQueryTokens,
          config,
          compoundStale: result.compoundStale,
        });
        const renderedIds = [...rendered.matchAll(/^ID: (.+)$/gm)].map(match => match[1]);
        const statementCount = sqlite.issued.length - sqlStart;
        const corpusStatementCount = sqlite.issued.slice(sqlStart).filter(sql =>
          /(?:FROM entry_counts|SELECT COUNT\(\*\) AS total, .* FROM entries)/i.test(sql)).length;
        const candidateReads = boundStatements.slice(bindStart).filter(entry =>
          /^SELECT id, content, tags, source, created_at FROM entries WHERE/.test(entry.sql));
        const candidatePlans = planQueries.has(item.query)
          ? await Promise.all(candidateReads.map(async entry => ({
              bindings: entry.count,
              placeholders: (entry.sql.match(/\?/g) ?? []).length,
              detail: ((await sqlite.db.prepare(`EXPLAIN QUERY PLAN ${entry.sql}`)
                .bind(...Array(entry.count).fill(null)).all()).results as { detail: string }[])
                .map(row => row.detail),
            }))) : undefined;
        replayResults.push({ query: item.query, target: item.target, status: "replayed",
          rank: result.matches.findIndex(match => match.id === item.target) + 1 || null,
          ids: result.matches.map(match => match.id), renderedIds, diagnostics, trace,
          d1Statements: statementCount,
          candidateBindings: candidateReads.map(entry => entry.count),
          candidatePlans,
          d1CorpusStatements: corpusStatementCount });
      }
      expect(calls).toBe(1);
      (globalThis as typeof globalThis & { __knownItemTrace?: TraceSink }).__knownItemTrace = undefined;
    }

    if (MODE === "record") {
      expect(aiCalls).toEqual([]);
      expect(pending).toEqual([]);
      expect(records).toHaveLength(queries.length);
      writeFileSync(resolve(ROOT, `../signals-inputs${RUN_ID}.json`), JSON.stringify({
        version: 1,
        mode: "record",
        fixedNow: now.iso,
        inputCount: records.length,
        aiCalls,
        records,
      }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    } else {
      await Promise.all(pending);
      writeFileSync(resolve(ROOT, `../replay-results${RUN_ID}.json`), JSON.stringify({
        version: 1, mode: "replay", fixedNow: now.iso, aiCalls,
        scopeTotal,
        results: replayResults,
      }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    }
  } finally {
    sqlite.close();
  }
});
