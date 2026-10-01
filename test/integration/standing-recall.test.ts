/**
 * Standing fires in recall (spec 15 2.8/2.9, Track 7 lane D Task 11).
 *
 * Firing tests seed a SQLite D1 and a standing KV cache directly, with a controlled AI mock that
 * maps exact query/content text to a chosen unit vector — real cosine similarity, deterministic
 * fixtures, no dependence on the shipped embedding model's actual output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";
import { recallEntries } from "../../src/recall/search";
import { renderRecallText } from "../../src/recall/render";
import type { RecallDiagnostics } from "../../src/recall/types";
import { encodeVector } from "../../src/standing/codec";
import { resetStandingIsolateState, standingKvKey } from "../../src/standing/cache";
import { STANDING_MAX_FIRES } from "../../src/constants";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { snapshotRecallBudget } from "../helpers/recall-budget";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { TAG_VOCABULARY_KEY } from "../../src/tags/vocabulary";
import type { Identity } from "../../src/lib/identity";
import worker from "../../src/index";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";

const DIM = 128;
const pad = (xy: number[]): number[] => [...xy, ...new Array(DIM - xy.length).fill(0)];
const ON_TOPIC = pad([1, 0]);

// Every embedding call returns the same vector: recall's own dense arm is kept empty via the
// Vectorize query mock instead, so what the base embedding actually resolves to never matters —
// only whether the standing text embeds close to (or, unused here, far from) the cached items.
function aiFor(vector: number[] = ON_TOPIC) {
  const run = vi.fn(async (model: string, input?: { text?: string | string[] }) => {
    if (typeof model === "string" && model === DEFAULTS.EMBEDDING_MODEL) {
      const texts = Array.isArray(input?.text) ? input!.text : [input?.text as string];
      return { data: texts.map(() => [...vector, ...new Array(768 - vector.length).fill(0)]) };
    }
    throw new Error(`unexpected AI.run model in standing-recall test: ${model}`);
  });
  return { ai: { run } as unknown as Ai, run };
}

function insertEntry(sqlite: SqliteD1, opts: {
  id: string; content?: string; tags?: string[]; workspaceId?: string; actorId?: string; createdAt?: number; vectorIds?: string[];
}): void {
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
     VALUES (?, ?, ?, 'api', ?, ?, ?, ?)`,
  ).bind(
    opts.id, opts.content ?? "a standing instruction", JSON.stringify(opts.tags ?? ["standing:active"]),
    opts.createdAt ?? 1000, JSON.stringify(opts.vectorIds ?? [opts.id]), opts.workspaceId ?? "", opts.actorId ?? "",
  ).run();
}

async function seedStandingCache(
  kv: KVNamespace, workspaceId: string,
  items: { id: string; vec: number[]; projects?: string[]; createdAt?: number }[],
): Promise<void> {
  const cache = {
    v: 1, model: DEFAULTS.EMBEDDING_MODEL, dim: DIM, builtAt: Date.now(),
    items: items.map(i => ({ id: i.id, projects: i.projects ?? [], createdAt: i.createdAt ?? 1000, vecs: [encodeVector(i.vec)] })),
  };
  await kv.put(standingKvKey(workspaceId), JSON.stringify(cache));
}

const open: SqliteD1[] = [];

beforeEach(() => {
  resetStandingIsolateState();
  resetFtsReadyMemo();
});
afterEach(() => open.splice(0).forEach(s => s.close()));

/** By default finds nothing on its own: no seeded root, an empty Vectorize index, no keyword hit. */
async function setup(opts: { ai?: Ai; denseMatches?: { id: string; score: number; created_at: number }[] } = {}) {
  const sqlite = makeSqliteD1();
  open.push(sqlite);
  const kv = makeMemoryKV();
  await kv.put(TAG_VOCABULARY_KEY, JSON.stringify({ tags: [], rebuiltAt: Date.now() }));
  const matches = (opts.denseMatches ?? []).map(m => ({ id: m.id, score: m.score, metadata: { parentId: m.id, created_at: m.created_at } }));
  const env: Env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as D1Database,
    OAUTH_KV: kv,
    VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches }) }),
    ...(opts.ai ? { AI: opts.ai } : {}),
  }));
  const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;
  return { env: sqlite.admitEnv(env), ctx, sqlite, kv };
}

describe("standing fires in recall", () => {
  it("with no standing key, output carries no standing field", async () => {
    const { ai } = aiFor();
    const { env, ctx } = await setup({ ai });
    const result = await recallEntries({ query: "atlas ledger", topK: 5, synthesize: false }, env, ctx, DEFAULTS);
    expect(result.standing).toBeUndefined();
    expect(renderRecallText(result.matches, result.insight, { config: DEFAULTS, standing: result.standing })).not.toMatch(/Standing instruction/);
  });

  it("fires above the threshold, renders above the results, at most STANDING_MAX_FIRES", async () => {
    const { ai } = aiFor();
    const { env, ctx, sqlite, kv } = await setup({ ai, denseMatches: [{ id: "root", score: .9, created_at: 999 }] });
    insertEntry(sqlite, { id: "root", tags: ["work"], content: "an ordinary result", createdAt: 999 });
    const ids = ["s1", "s2", "s3"];
    for (const id of ids) insertEntry(sqlite, { id, content: `prefer boring tech (${id})`, createdAt: 1000 + ids.indexOf(id) });
    await seedStandingCache(kv, "", ids.map(id => ({ id, vec: ON_TOPIC })));

    const result = await recallEntries({ query: "database preference", topK: 5, synthesize: false }, env, ctx, DEFAULTS);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.standing).toHaveLength(STANDING_MAX_FIRES);
    for (const f of result.standing!) expect(f.score).toBeGreaterThanOrEqual(DEFAULTS.STANDING_THRESHOLD);

    const text = renderRecallText(result.matches, result.insight, { config: DEFAULTS, standing: result.standing });
    expect(text).toMatch(/^\*\*Standing instructions you set\*\*/);
    // Rendered above the results: the standing block is the leading text.
    expect(text.indexOf("Standing instruction")).toBeLessThan(text.indexOf("1. ["));
  });

  it.each([
    ["stopped (tag removed)", { tags: ["work"] }],
    ["deprecated", { tags: ["standing:active", "status:deprecated"] }],
    ["held", { tags: ["standing:active", "quarantine:instruction"] }],
  ])("a %s row never fires even with a stale cache saying it should", async (_label, rowOverrides) => {
    const { ai } = aiFor();
    const { env, ctx, sqlite, kv } = await setup({ ai });
    insertEntry(sqlite, { id: "stale-fire", ...rowOverrides });
    await seedStandingCache(kv, "", [{ id: "stale-fire", vec: ON_TOPIC }]);

    const result = await recallEntries({ query: "database preference", topK: 5, synthesize: false }, env, ctx, DEFAULTS);
    expect(result.standing ?? []).toHaveLength(0);
  });

  it("a forgotten row (absent from entries) never fires even with a stale cache saying it should", async () => {
    const { ai } = aiFor();
    const { env, ctx, kv } = await setup({ ai });
    // No insertEntry: the row was moved to entries_trash and no longer exists here.
    await seedStandingCache(kv, "", [{ id: "forgotten-id", vec: ON_TOPIC }]);

    const result = await recallEntries({ query: "database preference", topK: 5, synthesize: false }, env, ctx, DEFAULTS);
    expect(result.standing ?? []).toHaveLength(0);
  });

  it("a teammate never sees another workspace's standing memory", async () => {
    const { ai } = aiFor();
    const { env, ctx, sqlite, kv } = await setup({ ai });
    insertEntry(sqlite, { id: "mine", workspaceId: "ws-a" });
    await seedStandingCache(kv, "ws-a", [{ id: "mine", vec: ON_TOPIC }]);

    const stranger: Identity = { userId: "u-b", role: "member", personalWorkspaceId: "ws-b", companyWorkspaceIds: [], defaultShare: "" };
    const result = await recallEntries(
      { query: "database preference", topK: 5, synthesize: false }, env, ctx, DEFAULTS,
      { identity: stranger },
    );
    expect(result.standing ?? []).toHaveLength(0);
  });

  it("keyword-only recall makes no AI call and does not fire", async () => {
    const { ai, run } = aiFor();
    const { env, ctx, sqlite, kv } = await setup({ ai });
    insertEntry(sqlite, { id: "s1" });
    await seedStandingCache(kv, "", [{ id: "s1", vec: ON_TOPIC }]);

    const result = await recallEntries(
      { query: "database preference", topK: 5, synthesize: false }, env, ctx, DEFAULTS,
      { variant: { arms: "keyword-only" } },
    );
    expect(run).not.toHaveBeenCalled();
    expect(result.standing ?? []).toHaveLength(0);
  });

  it("a fire with no other results costs exactly one extra D1 statement", async () => {
    const { ai } = aiFor();

    const baseline = await setup({ ai });
    const baselineDiagnostics: RecallDiagnostics = {};
    const baselineResult = await recallEntries(
      { query: "database preference", topK: 5, synthesize: false }, baseline.env, baseline.ctx, DEFAULTS,
      { diagnostics: baselineDiagnostics },
    );
    const baselineStatements = snapshotRecallBudget(baselineDiagnostics, baselineResult).d1Statements;
    expect(baselineResult.matches).toHaveLength(0);
    expect(baselineResult.standing).toBeUndefined();

    // A fresh isolate memo: the baseline call above already memoized "no cache" for this same
    // workspace key, and the 60-second isolate memo would otherwise serve that stale answer
    // instead of reading the (different) KV instance this second setup() just seeded.
    resetStandingIsolateState();
    const fired = await setup({ ai });
    insertEntry(fired.sqlite, { id: "s1" });
    await seedStandingCache(fired.kv, "", [{ id: "s1", vec: ON_TOPIC }]);
    const firedDiagnostics: RecallDiagnostics = {};
    const firedResult = await recallEntries(
      { query: "database preference", topK: 5, synthesize: false }, fired.env, fired.ctx, DEFAULTS,
      { diagnostics: firedDiagnostics },
    );
    const firedStatements = snapshotRecallBudget(firedDiagnostics, firedResult).d1Statements;
    expect(firedResult.matches).toHaveLength(0);
    expect(firedResult.standing).toHaveLength(1);
    expect(firedStatements).toBe(baselineStatements + 1);
  });

  it("explain adds why to a fired standing instruction", async () => {
    const { ai } = aiFor();
    const { env, ctx, sqlite, kv } = await setup({ ai });
    insertEntry(sqlite, { id: "s1" });
    await seedStandingCache(kv, "", [{ id: "s1", vec: ON_TOPIC }]);

    const result = await recallEntries({ query: "database preference", topK: 5, synthesize: false, explain: true }, env, ctx, DEFAULTS);
    expect(result.standing![0].why).toMatch(/^standing: similarity 1\.00 >= 0\.\d\d$/);
  });
});

describe("GET /standing", () => {
  const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;
  let sqlite: SqliteD1;
  let env: Env;
  let token: string;

  beforeEach(async () => {
    resetDatabaseInit();
    resetStandingIsolateState();
    sqlite = makeSqliteD1();
    env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AUTH_TOKEN: "owner-token" }));
    await initializeDatabase(env);
    await ensureTenantBootstrap(env);
    token = "owner-token";
  });
  afterEach(() => sqlite.close());

  function call(method: string, path: string): Promise<Response> {
    return worker.fetch(
      new Request(`http://localhost${path}`, { method, headers: { Authorization: `Bearer ${token}` } }),
      env, ctx,
    );
  }

  it("lists a cached row as firing, and an uncached one as pending_refresh", async () => {
    insertEntry(sqlite, { id: "cached", workspaceId: "", createdAt: 1000 });
    insertEntry(sqlite, { id: "uncached", workspaceId: "", createdAt: 2000 });
    const kv = env.OAUTH_KV;
    await seedStandingCache(kv, "", [{ id: "cached", vec: ON_TOPIC, createdAt: 1000 }]);

    const res = await call("GET", "/standing");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; standing: { id: string; firing: boolean; reason?: string }[] };
    expect(body.ok).toBe(true);
    const byId = new Map(body.standing.map(s => [s.id, s]));
    expect(byId.get("cached")).toMatchObject({ firing: true });
    expect(byId.get("cached")!.reason).toBeUndefined();
    expect(byId.get("uncached")).toMatchObject({ firing: false, reason: "pending_refresh" });
  });

  it("reports a held row as held, never firing", async () => {
    insertEntry(sqlite, { id: "held", workspaceId: "", tags: ["standing:active", "quarantine:instruction"] });
    await seedStandingCache(env.OAUTH_KV, "", [{ id: "held", vec: ON_TOPIC }]);

    const res = await call("GET", "/standing");
    const body = await res.json() as { standing: { id: string; firing: boolean; reason?: string }[] };
    expect(body.standing.find(s => s.id === "held")).toMatchObject({ firing: false, reason: "held" });
  });

  it("reports a never-indexed row as not_indexed_yet", async () => {
    insertEntry(sqlite, { id: "no-vector", workspaceId: "", vectorIds: [] });

    const res = await call("GET", "/standing");
    const body = await res.json() as { standing: { id: string; firing: boolean; reason?: string }[] };
    expect(body.standing.find(s => s.id === "no-vector")).toMatchObject({ firing: false, reason: "not_indexed_yet" });
  });
});
