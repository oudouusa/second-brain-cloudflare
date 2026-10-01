/**
 * The two system jobs that write through captureEntry (nightly digest, weekly
 * insight) must say so, so its merge/replace path can never overwrite a row a
 * user or agent wrote. The behaviour itself is pinned in
 * test/unit/capture-entry.test.ts; this pins that each job passes the flag.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const seen: { source: string; opts: any }[] = [];
vi.mock("../../src/capture/entry", async (importActual) => {
  const actual = await importActual<typeof import("../../src/capture/entry")>();
  return {
    ...actual,
    captureEntry: (...args: Parameters<typeof actual.captureEntry>) => {
      seen.push({ source: args[2], opts: args[8] });
      return actual.captureEntry(...args);
    },
  };
});

import { compressTag } from "../../src/compression/digest";
import { runWeeklyInsights } from "../../src/insight/weekly";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { pricingInsight, PRICING_INSIGHTS } from "../helpers/insight-fixture";
import type { Env } from "../../src/env";

const DAY = 86400000;
const NOW = 400 * DAY;
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

function makeAI() {
  const sse = (text: string) => new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return {
    run: vi.fn().mockImplementation(async (model: string, opts: any) => {
      if (model === "@cf/google/embeddinggemma-300m") return { data: [new Array(768).fill(0.1)] };
      const prompt = String(opts?.messages?.[0]?.content ?? "");
      if (prompt.includes("Memory A:")) {
        return sse(pricingInsight(PRICING_INSIGHTS["0"]));
      }
      return opts?.stream ? sse("A digest of the work memories.") : { response: "3" };
    }),
  } as unknown as Ai;
}

describe("system jobs declare themselves to captureEntry", () => {
  let sqlite: SqliteD1;
  let env: Env;

  beforeEach(async () => {
    seen.length = 0;
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    env = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(), OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    })) as Env;
    await initializeDatabase(env);
  });

  afterEach(() => sqlite.close());

  it("the digest passes systemWrite with a system:digest channel", async () => {
    for (let i = 0; i < 12; i++) {
      sqlite.seed({ id: `w-${i}`, content: `Memory about work number ${i}`, createdAt: NOW - 200 * DAY + i, tags: ["rocket-project"] });
    }
    await compressTag("rocket-project", env, ctx);
    expect(seen).toHaveLength(1);
    expect(seen[0].source).toBe("system");
    expect(seen[0].opts).toEqual({ systemWrite: "digest", channel: "system:digest" });
  });

  it("the weekly insight passes systemWrite with a system:insight channel", async () => {
    sqlite.seed({ id: "a-0", content: "Decision: price tier 0 flat at nine dollars a month for predictable billing.", createdAt: NOW - 120 * DAY, tags: ["pricing"] });
    sqlite.seed({ id: "b-0", content: "Decision: move tier 0 to usage-based billing instead of flat pricing.", createdAt: NOW, tags: ["pricing"] });
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES ('cand-0', 'a-0', 'b-0', 0.87, ?, 10, 'vector', 'pending', ?)`,
    ).bind(120 * DAY, NOW).run();
    await runWeeklyInsights(env, ctx);
    expect(seen).toHaveLength(1);
    expect(seen[0].opts).toEqual({ systemWrite: "insight", channel: "system:insight" });
  });
});
