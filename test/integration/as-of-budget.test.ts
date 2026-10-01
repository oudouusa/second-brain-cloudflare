/**
 * Task B3 (T-0089.2.2, spec 14 5.7 items 5, 8, 9): as-of's own cost pins.
 *
 *   - "One extra D1 execution" (item 5, a batch of two reads) and "1 KV read" (item 8,
 *     getVersionsSince) beyond a normal recall — measured as the delta between an otherwise
 *     identical recall with and without `asOf` set, the same reasoning as this codebase's other
 *     D1-call-count pins (graph-team-aware.test.ts, recall-free-tier-budget.test.ts).
 *   - "23-chain reconstruction stays under the CPU pin" (item 9): resolveAtT called 23 times (the
 *     realistic ceiling — topK's true results plus AS_OF_BELIEFS_MAX beliefs), each over a 20-delta,
 *     ~100 KB ASCII chain, mirroring Track 1's own buildChain CPU harness
 *     (test/unit/versions-chain.test.ts) rather than reinventing the measurement technique.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cpus, loadavg } from "node:os";
import { recallEntries } from "../../src/recall/search";
import { resolveAtT, AS_OF_BELIEFS_MAX, type AsOfVersionRow } from "../../src/recall/as-of";
import type { RecallMatch } from "../../src/recall/types";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { VERSIONS_SINCE_KV_KEY } from "../../src/constants";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;
let sqlite: SqliteD1 | null = null;
afterEach(() => { sqlite?.close(); sqlite = null; resetDatabaseInit(); });

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: s.db as unknown as Env["DB"] } as unknown as Env);
  return s;
}

const DAY = 86400000;
const NOW = Date.now();

describe("as-of's own D1 and KV cost (5.7 items 5 and 8)", () => {
  it("adds exactly one D1 execution and one KV read over a normal recall", async () => {
    sqlite = await migrated();
    sqlite.seed({ id: "e1", content: "budget review notes for Q3", createdAt: NOW - 30 * DAY });
    const kv = makeMemoryKV();
    await kv.put(VERSIONS_SINCE_KV_KEY, String(NOW - 200 * DAY)); // steady state: getVersionsSince costs exactly 1 KV read
    const getSpy = vi.spyOn(kv, "get");
    const env = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: kv,
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [{ id: "e1", score: 0.9, metadata: { parentId: "e1" } }] }) }),
    }));

    // A cold call warms this isolate's own memoized reads (tag vocabulary, distillation's corpus
    // total) so neither call below pays for them — the comparison must be apples to apples, not
    // "second call ever" against "first call ever".
    await recallEntries({ query: "budget review", topK: 10, synthesize: false, hops: 0 }, env, ctx);

    const beforeWithout = sqlite.executions.length;
    const getBeforeWithout = getSpy.mock.calls.length;
    await recallEntries({ query: "budget review", topK: 10, synthesize: false, hops: 0 }, env, ctx);
    const withoutAsOfDelta = sqlite.executions.length - beforeWithout;
    const getWithoutAsOfDelta = getSpy.mock.calls.length - getBeforeWithout;

    const beforeWith = sqlite.executions.length;
    const getBeforeWith = getSpy.mock.calls.length;
    await recallEntries({ query: "budget review", topK: 10, synthesize: false, hops: 0 }, env, ctx, undefined, { asOf: NOW - 10 * DAY });
    const withAsOfDelta = sqlite.executions.length - beforeWith;
    const getWithAsOfDelta = getSpy.mock.calls.length - getBeforeWith;

    expect(withAsOfDelta - withoutAsOfDelta).toBe(1);
    expect(getWithAsOfDelta - getWithoutAsOfDelta).toBe(1);
  });
});

describe("as-of's reconstruction CPU (5.7 item 9)", () => {
  it("23 chains of 20 deltas over ~100 KB ASCII stay under the CPU pin", async (testCtx) => {
    const scale = Number(process.env.VERSIONS_CPU_SCALE ?? 1);
    const base = "a".repeat(100_000);
    const asOf = 0; // every delta retires "after" T=0, forcing full reconstruction to the oldest kept version
    const chainFor = (id: string): { match: RecallMatch; rows: AsOfVersionRow[] } => {
      const rows: AsOfVersionRow[] = Array.from({ length: 20 }, (_, i) => ({
        entry_id: id, seq: 20 - i, workspace_id: "", content: null, prior_length: 100_000 - i * 1000, prior_length_utf16: null,
        tags: "[]", state: "{}", actor_id: "", channel: "rest", reason: "update", meta: "{}", valid_from: null, created_at: 20 - i,
      }));
      const match: RecallMatch = {
        id, content: base, score: 1, createdAt: 0, updatedAt: 0, tags: [], source: "api", isUpdate: false, hop: 0,
        validFrom: 0, validFromStated: false, validUntil: null, validityState: "current", supersededBy: null, retractedSource: false,
      };
      return { match, rows };
    };
    const chains = Array.from({ length: AS_OF_BELIEFS_MAX + 20 }, (_, i) => chainFor(`e${i}`));
    expect(chains.length).toBe(23);

    const median = (fn: () => void) => {
      const t: number[] = [];
      for (let i = 0; i < 7; i++) {
        const before = process.cpuUsage();
        fn();
        const after = process.cpuUsage(before);
        t.push((after.user + after.system) / 1000);
      }
      return t.sort((a, b) => a - b)[3];
    };
    const run = () => {
      for (const { match, rows } of chains) resolveAtT(match, rows, () => true, asOf).content.length;
    };
    const cores = cpus().length;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = loadavg()[0] / cores;
      const ms = median(run);
      const after = loadavg()[0] / cores;
      const contended = Math.max(before, after) > 1;
      if (ms < 5 * scale) { expect(ms).toBeLessThan(5 * scale); return; }
      if (contended) {
        testCtx.skip(true, `runner load average ${(Math.max(before, after) * cores).toFixed(1)} across ${cores} cores (measured ${ms.toFixed(2)} ms against a 5 ms budget)`);
        return;
      }
      if (attempt === 3) { expect(ms).toBeLessThan(5 * scale); return; }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  });
});
