import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

describe("single-token corpus df in recall", () => {
  const open: SqliteD1[] = [];
  afterEach(() => open.splice(0).forEach(sqlite => sqlite.close()));

  it.each([
    { query: "記法", content: "記法の整理を記録した" },
    { query: "PR70", content: "同期PR70の確認を記録した" },
  ])("returns the sole keyword hit in the top five for $query", async ({ query, content }) => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    open.push(sqlite);
    const dense = Array.from({ length: 20 }, (_, i) => ({
      id: `semantic-${i}`,
      score: 0.95 - i * 0.01,
      metadata: { parentId: `semantic-${i}`, created_at: 1000 },
    }));
    const baseEnv: Env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: dense }) }),
    });
    const env = sqlite.admitEnv(baseEnv);
    await initializeDatabase(env);
    sqlite.seed({ id: "known-item", content, createdAt: 1000 });
    for (const candidate of dense) {
      sqlite.seed({ id: candidate.id, content: `別件の意味検索候補 ${candidate.id}`, createdAt: 1000 });
    }
    // The target is unique in a larger readable corpus. A one-row keyword
    // sample estimates IDF as ln(1+1/2); corpus df=1 gives its real weight.
    for (let i = 0; i < 160; i++) {
      sqlite.seed({ id: `filler-${i}`, content: `無関係な記録 ${i}`, createdAt: 1000 });
    }
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext;
    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries(
      { query, topK: 5, hops: 0, synthesize: false },
      env,
      ctx,
      undefined,
      { diagnostics },
    );
    await Promise.all(pending);

    expect(diagnostics.keywordIds).toContain("known-item");
    expect(diagnostics.denseIds).not.toContain("known-item");
    expect(result.matches.map(match => match.id)).toContain("known-item");
  });
});
