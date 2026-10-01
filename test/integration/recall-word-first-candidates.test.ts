import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

describe("LIKE candidate ordering on real SQLite", () => {
  const open: SqliteD1[] = [];
  afterEach(() => open.splice(0).forEach(sqlite => sqlite.close()));

  async function fixture() {
    resetDatabaseInit();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    open.push(sqlite);
    const env: Env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [] }) }),
    });
    const admittedEnv = sqlite.admitEnv(env);
    await initializeDatabase(admittedEnv);
    return { sqlite, env: admittedEnv };
  }

  async function recall(env: Env, query: string) {
    const diagnostics: RecallDiagnostics = {};
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext;
    const result = await recallEntries(
      { query, topK: 5, hops: 0, synthesize: false }, env, ctx, undefined, { diagnostics },
    );
    await Promise.all(pending);
    return { result, diagnostics };
  }

  it("admits an older whole word when 130 newer bigram hits saturate the 128 candidate slots", async () => {
    const { sqlite, env } = await fixture();
    sqlite.seed({ id: "whole-word", content: "ティアドロップの仕様", createdAt: 1_000 });
    for (let i = 0; i < 130; i++) {
      sqlite.seed({ id: `bigram-${i}`, content: `別件のアップ ${i}`, createdAt: 2_000 + i });
    }

    const { result, diagnostics } = await recall(env, "ティアドロップ");
    expect(diagnostics.ftsRoute).toBe("like-ineligible-token");
    expect(diagnostics.keywordIds).toContain("whole-word");
    // 稀語窓の残り枠は上流splitLikeTermsと同じくdfの合計で見積もるため、重なる語の分だけ128に満たない。
    expect(diagnostics.keywordIds!.length).toBeLessThanOrEqual(128);
    expect(result.matches.slice(0, 5).map(match => match.id)).toContain("whole-word");
  });

  it("retains a row found only by a CJK bigram", async () => {
    const { sqlite, env } = await fixture();
    sqlite.seed({ id: "bigram-only", content: "監査未登方針", createdAt: 1_000 });

    const { diagnostics } = await recall(env, "未登録");
    expect(diagnostics.keywordIds).toContain("bigram-only");
  });

  it("puts two whole-word probe hits ahead of a newer one-hit row", async () => {
    const { sqlite, env } = await fixture();
    sqlite.seed({ id: "two-hits", content: "alpha beta decision", createdAt: 1_000 });
    sqlite.seed({ id: "one-hit", content: "alpha note", createdAt: 2_000 });

    const { diagnostics } = await recall(env, "alpha beta");
    expect(diagnostics.keywordIds?.slice(0, 2)).toEqual(["two-hits", "one-hit"]);
  });

  it("orders equal whole-word matches by newest creation time", async () => {
    const { sqlite, env } = await fixture();
    sqlite.seed({ id: "older", content: "ティアドロップ旧版", createdAt: 1_000 });
    sqlite.seed({ id: "newer", content: "ティアドロップ新版", createdAt: 2_000 });

    const { diagnostics } = await recall(env, "ティアドロップ");
    expect(diagnostics.keywordIds?.slice(0, 2)).toEqual(["newer", "older"]);
  });
});
