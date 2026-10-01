import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { DEFAULTS } from "../../src/config";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { recallEntries } from "../../src/recall/search";
import { buildMcpServer } from "../../src/mcp/server";
import type { RecallDiagnostics, RecallInternalOptions } from "../../src/recall/types";
import type { Env } from "../../src/env";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { req } from "../helpers/make-request";

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
async function drain() {
  for (let i = 0; i < pending.length; i++) await pending[i];
  pending.length = 0;
}
const databases: SqliteD1[] = [];

afterEach(async () => {
  await drain();
  for (const sqlite of databases.splice(0)) sqlite.close();
  vi.restoreAllMocks();
});

async function setup(publicPath = false, tagged = false, memberVectors = false) {
  resetDatabaseInit();
  resetFtsReadyMemo();
  const sqlite = makeSqliteD1();
  databases.push(sqlite);
  const query = vi.fn().mockResolvedValue({
    matches: [{ id: "dense-doc", score: 0.9, metadata: { parentId: "dense-doc", content: "semantic neighbor", created_at: 1 } }],
  });
  const getByIds = vi.fn().mockImplementation(async (ids: string[]) => ids.map(id => ({
    id,
    values: new Array(128).fill(0.1),
    metadata: { parentId: id.split("-chunk-")[0] },
  })));
  const env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query, getByIds }),
  }));
  await initializeDatabase(env);
  const roots = publicPath ? await ensureTenantBootstrap(env) : undefined;
  const tags = tagged ? ["pulsar", "work", "project:alpha"] : [];
  sqlite.seed({ id: "dense-doc", content: "an unrelated semantic neighbor note", createdAt: 1,
    tags: memberVectors ? tags : [], vectorIds: memberVectors ? ["dense-doc-chunk-0"] : [] });
  sqlite.seed({ id: "kw-doc", content: "the zylophantine rollout checklist", createdAt: 2,
    tags, vectorIds: memberVectors ? ["kw-doc-chunk-0"] : [] });
  if (roots) {
    await sqlite.db.prepare("UPDATE entries SET workspace_id = ? WHERE 1").bind(roots.ownerPersonalWorkspaceId).run();
  }
  await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
  resetFtsReadyMemo();
  sqlite.issued.length = 0;
  sqlite.batches.length = 0;
  return { env, query, getByIds, sqlite };
}

async function run(
  env: Env,
  variant?: RecallInternalOptions["variant"],
  query = "zylophantine rollout",
  filters: Partial<Parameters<typeof recallEntries>[0]> = {},
) {
  const diagnostics: RecallDiagnostics = {};
  const result = await recallEntries(
    { query, topK: 5, synthesize: false, ...filters }, env, ctx, undefined, { diagnostics, variant },
  );
  await drain();
  return { ids: result.matches.map(m => m.id), matches: result.matches.map(m => ({ id: m.id, score: m.score })), diagnostics, cacheHit: result.querySignalCacheHit };
}

describe("internal.variant.arms", () => {
  it("keeps default and explicit both identical", async () => {
    const { env, query } = await setup();
    const a = await run(env);
    const b = await run(env, { arms: "both" });
    expect(a.ids).toEqual(b.ids);
    expect(new Set(a.ids)).toEqual(new Set(["kw-doc", "dense-doc"]));
    expect(a.diagnostics.ftsRoute).toBe("fts");
    expect(query).toHaveBeenCalled();
  });

  it("keyword-only skips embedding and Vectorize; no arm makes an LLM call", async () => {
    const { env, query } = await setup(false, true);
    await run(env, { arms: "both" });
    const ai = env.AI.run as ReturnType<typeof vi.fn>;
    expect(ai.mock.calls).toHaveLength(1);
    expect(ai.mock.calls.filter(([model]) => model === DEFAULTS.EMBEDDING_MODEL)).toHaveLength(1);
    ai.mockClear();
    query.mockClear();

    const r = await run(env, { arms: "keyword-only" });
    expect(r.ids).toEqual(["kw-doc"]);
    expect(query).not.toHaveBeenCalled();
    expect(ai.mock.calls).toHaveLength(0);
  });

  it("makes no LLM call for tag inference when no known tag appears in the query", async () => {
    const { env } = await setup(false, true);
    await run(env, undefined, "quarterly planning session");
    const ai = env.AI.run as ReturnType<typeof vi.fn>;
    expect(ai.mock.calls.filter(([model]) => model === DEFAULTS.LLM_MODEL)).toHaveLength(0);
    expect(ai.mock.calls.map(([model]) => model)).toEqual([DEFAULTS.EMBEDDING_MODEL]);
  });

  it("dense-only skips the keyword arm and reports why", async () => {
    const { env, sqlite } = await setup();
    const r = await run(env, { arms: "dense-only" });
    expect(r.ids).toEqual(["dense-doc"]);
    expect(r.diagnostics.ftsRoute).toBe("skipped-by-variant");
    expect(r.diagnostics.keywordIds).toEqual([]);
    expect(sqlite.batches.some(batch => batch.some(sql => sql.includes("SELECT e.id, e.content") && sql.includes("entries_fts MATCH")))).toBe(false);
  });

  it("dense-only still sends a real 128-dimension embedding to Vectorize", async () => {
    const { env, query } = await setup();
    await run(env, { arms: "dense-only" });
    expect((env.AI.run as ReturnType<typeof vi.fn>).mock.calls.filter(([model]) => model === DEFAULTS.EMBEDDING_MODEL)).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
    const vector = query.mock.calls[0][0] as number[];
    expect(vector).toHaveLength(128);
    expect(vector.every(value => Math.abs(value - 1 / Math.sqrt(128)) < 1e-12)).toBe(true);
  });

  it.each(["tag", "project"])("ignores every arm flag for %s-scoped member-first recall", async scope => {
    const { env, getByIds } = await setup(false, true, true);
    const filters = scope === "tag"
      ? { tag: "work" }
      : { project: [{ id: "alpha", workspace_id: "", name: "Alpha", description: "", aliases: [], status: "active" as const, created_at: 1, updated_at: null }] };
    const variants = [undefined, { arms: "both" as const }, { arms: "dense-only" as const }, { arms: "keyword-only" as const }];
    const outputs = [];
    for (const variant of variants) {
      const before = getByIds.mock.calls.length;
      const ai = env.AI.run as ReturnType<typeof vi.fn>;
      const embeddingsBefore = ai.mock.calls.filter(([model]) => model === DEFAULTS.EMBEDDING_MODEL).length;
      const result = await run(env, variant, "zylophantine rollout", filters);
      outputs.push(result.matches);
      expect(result.ids).toEqual(expect.arrayContaining(["kw-doc", "dense-doc"]));
      expect(getByIds.mock.calls.length).toBeGreaterThan(before);
      expect(result.cacheHit).toBe(outputs.length > 1);
      expect(ai.mock.calls.filter(([model]) => model === DEFAULTS.EMBEDDING_MODEL)).toHaveLength(embeddingsBefore + (result.cacheHit ? 0 : 1));
      expect(result.diagnostics.operations?.embeddingCalls).toBe(result.cacheHit ? 0 : 1);
      expect(result.diagnostics.ftsRoute).toBe("like-member-first");
    }
    for (const output of outputs.slice(1)) expect(output).toEqual(outputs[0]);
  });

  it("rejects an unknown arm value before running recall", async () => {
    const { env } = await setup();
    const invalid = { arms: "unexpected" } as unknown as RecallInternalOptions["variant"];
    await expect(run(env, invalid)).rejects.toThrow("Unknown recall variant arms: unexpected");
  });

  it.each(["zylophantine rollout", "semantic neighbor", "absent phrase"])(
    "matches the unmodified SQL, top-k IDs, and stable diagnostics for %s",
    async queryText => {
      const { env, sqlite } = await setup();
      const { ids, diagnostics } = await run(env, undefined, queryText);
      const { stageMs: _timings, ...stableDiagnostics } = diagnostics;
      expect({ sql: sqlite.issued, batches: sqlite.batches, ids, diagnostics: stableDiagnostics }).toMatchSnapshot();
    },
  );

  it("HTTP and MCP recall cannot pass a variant through", async () => {
    const { env, query } = await setup(true);
    const response = await worker.fetch(req("POST", "/recall", { body: { query: "zylophantine rollout", variant: { arms: "dense-only" }, arms: "keyword-only", synthesize: false } }), env, ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as { results: { id: string }[] };
    expect(body.results.map(item => item.id)).toEqual(expect.arrayContaining(["kw-doc", "dense-doc"]));
    expect(query).toHaveBeenCalled();

    query.mockClear();
    const server = buildMcpServer(databases.at(-1)!.admitEnv(env), ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "variant-boundary-test", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name: "recall", arguments: {
        query: "zylophantine rollout", variant: { arms: "dense-only" }, arms: "keyword-only",
      } });
      const text = (result.content as { text?: string }[])[0]?.text ?? "";
      expect(text).toContain("zylophantine rollout checklist");
      expect(text).toContain("unrelated semantic neighbor note");
      expect(query).toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
