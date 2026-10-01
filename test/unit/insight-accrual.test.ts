import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runInsightAccrual as runInsightAccrualImpl, ACCRUAL_CURSOR_KEY, isEligiblePair } from "../../src/insight/candidates";
import { scoreCandidate, type ScorableEntry } from "../../src/insight/score";
import { makeTestEnv, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";
import { readDerivedStateGeneration } from "../../src/migration/write-lock";
import { beginMemoryWriteAdmission } from "../../src/migration/write-lock";

const DAY = 86400000;
const NOW = 400 * DAY;
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

async function runInsightAccrual(env: Env, executionCtx: ExecutionContext) {
  const pending: Promise<unknown>[] = [];
  const localCtx = Object.create(executionCtx) as ExecutionContext;
  localCtx.waitUntil = promise => { pending.push(Promise.resolve(promise)); };
  const admitted = await beginMemoryWriteAdmission(env, localCtx);
  // These tests intentionally freeze Date.now() to 1971-era domain timestamps. SQLite's
  // trigger clock remains real wall time, so make the test capability non-expiring.
  await admitted.env.DB.prepare(
    `UPDATE memory_write_admissions SET expires_at = ? WHERE token = ?`,
  ).bind(Number.MAX_SAFE_INTEGER, admitted.env.WRITE_ADMISSION_TOKEN).run();
  try {
    const result = await runInsightAccrualImpl(admitted.env, admitted.ctx);
    await Promise.allSettled(pending);
    return result;
  } finally {
    await admitted.finish();
  }
}

const SEED_TEXT = "A long enough decision about the pricing model to clear the eligibility floor, in full.";
const OLD_TEXT = "An earlier position on how the pricing model should work, written at real length.";

/** One neighbour, described the way Vectorize returns it. */
function match(over: Record<string, any> = {}) {
  const { metadata: metaOver, ...rest } = over;
  return {
    id: "vec-old-1",
    score: 0.87,
    ...rest,
    metadata: {
      parentId: "old-1",
      created_at: NOW - 90 * DAY,
      tags: ["pricing"],
      content: OLD_TEXT,
      source: "claude-desktop",
      ...(metaOver ?? {}),
    },
  };
}

/**
 * A real D1 row for the neighbour a `match()` points at. Since accrual now
 * hydrates neighbour data from D1 rather than trusting vector metadata, any
 * test whose neighbour is meant to actually qualify needs a live row here —
 * metadata alone is no longer enough to make one eligible.
 */
function seedNeighbour(sqlite: SqliteD1, overrides: Partial<{
  id: string; content: string; createdAt: number; tags: string[]; source: string; importanceScore: number;
}> = {}) {
  sqlite.seed({
    id: "old-1",
    content: OLD_TEXT,
    createdAt: NOW - 90 * DAY,
    tags: ["pricing"],
    source: "claude-desktop",
    importanceScore: 0,
    ...overrides,
  });
}

function makeEnv(sqlite: SqliteD1, matches: any[], kv = makeMemoryKV()): Env {
  const vectorize = makeVectorizeMock({
    // Echoes back whatever ids were requested. A fixed single-id response
    // only ever coincidentally matched single-seed tests; any scenario with
    // more than one seed needs each seed's own head vector to resolve.
    getByIds: vi.fn().mockImplementation(async (ids: string[]) =>
      ids.map(id => ({ id, values: new Array(128).fill(0.1) }))),
    query: vi.fn().mockResolvedValue({ matches }),
  });
  return makeTestEnv(undefined, { DB: sqlite.db as any, VECTORIZE: vectorize, OAUTH_KV: kv });
}

async function candidateCount(sqlite: SqliteD1): Promise<number> {
  const row = await sqlite.db.prepare(
    `SELECT COUNT(*) AS n FROM insight_candidates`,
  ).first() as { n: number };
  return row.n;
}

async function putCurrentCursor(
  sqlite: SqliteD1,
  kv: KVNamespace,
  cursor: { createdAt: number; id: string },
): Promise<void> {
  const generation = await readDerivedStateGeneration({ DB: sqlite.db } as unknown as Env);
  await kv.put(ACCRUAL_CURSOR_KEY, JSON.stringify({ ...cursor, generation }));
}

describe("runInsightAccrual()", () => {
  let sqlite: SqliteD1;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    sqlite = makeSqliteD1();
    expect(sqlite.columns()).toContain("valid_until");
    sqlite.seed({
      id: "seed-1", content: SEED_TEXT, createdAt: NOW,
      tags: ["pricing"], source: "claude-desktop",
      vectorIds: ["vec-seed-1"], importanceScore: 3,
    });
  });

  afterEach(() => sqlite.close());

  it("records a pair that is close in meaning and far apart in time", async () => {
    seedNeighbour(sqlite);
    await runInsightAccrual(makeEnv(sqlite, [match()]), ctx);
    expect(await candidateCount(sqlite)).toBe(1);
  });

  it("packs the real 15-by-10 maximum into 13 INSERT statements below 50 D1 queries", async () => {
    const kv = makeMemoryKV();
    await putCurrentCursor(sqlite, kv, { createdAt: NOW - 2 * DAY, id: "" });
    for (let i = 0; i < 14; i++) {
      sqlite.seed({
        id: `seed-max-${String(i).padStart(2, "0")}`,
        content: `${SEED_TEXT} Seed ${i}.`,
        createdAt: NOW,
        tags: ["pricing"],
        source: "claude-desktop",
        vectorIds: [`vec-seed-max-${i}`],
      });
    }
    for (let i = 0; i < 10; i++) {
      seedNeighbour(sqlite, {
        id: `old-max-${i}`,
        content: `${OLD_TEXT} Neighbour ${i}.`,
        createdAt: NOW - 90 * DAY,
      });
    }
    const matches = Array.from({ length: 10 }, (_, i) => match({
      id: `vec-old-max-${i}`,
      score: 0.9,
      metadata: { parentId: `old-max-${i}` },
    }));
    const before = sqlite.issued.length;

    await runInsightAccrual(makeEnv(sqlite, matches, kv), ctx);

    const issued = sqlite.issued.slice(before);
    expect(await candidateCount(sqlite)).toBe(150);
    expect(issued.filter(sql => sql.includes("INSERT INTO insight_candidates"))).toHaveLength(13);
    expect(issued.length).toBeLessThan(50);
  });

  it("normalises the pair so ids are stored in a stable order", async () => {
    seedNeighbour(sqlite);
    await runInsightAccrual(makeEnv(sqlite, [match()]), ctx);
    const row = await sqlite.db.prepare(
      `SELECT a_id, b_id FROM insight_candidates`,
    ).first() as { a_id: string; b_id: string };
    expect(row.a_id < row.b_id).toBe(true);
  });

  it("ignores a neighbour written days rather than months apart", async () => {
    seedNeighbour(sqlite, { id: "recent-1", createdAt: NOW - 2 * DAY });
    await runInsightAccrual(makeEnv(sqlite, [
      match({ score: 0.95, metadata: { parentId: "recent-1" } }),
    ]), ctx);
    expect(await candidateCount(sqlite)).toBe(0);
  });

  it("ignores a neighbour below the similarity floor", async () => {
    // No D1 row needed: the score check is a cheap pre-filter on Vectorize's
    // own similarity score, decided before any neighbour is ever hydrated.
    await runInsightAccrual(makeEnv(sqlite, [match({ score: 0.6 })]), ctx);
    expect(await candidateCount(sqlite)).toBe(0);
  });

  it("ignores another chunk of the entry itself, and never pays to hydrate it", async () => {
    await runInsightAccrual(makeEnv(sqlite, [
      match({ id: "vec-seed-1-chunk-2", score: 0.99, metadata: { parentId: "seed-1" } }),
    ]), ctx);
    expect(await candidateCount(sqlite)).toBe(0);
    // Once neighbour dates come from D1, a same-parent chunk always hydrates
    // to the seed's own row (same id, same created_at), so the gap floor
    // would reject it too — but only after paying for a needless D1 lookup.
    // The guard's remaining job is exactly that: no hydration statement
    // should be issued for a batch that is only self-matches.
    const hydrationCalls = sqlite.issued.filter(sql => sql.includes("WHERE id IN"));
    expect(hydrationCalls.length).toBe(0);
  });

  it("ignores a machine-authored neighbour", async () => {
    seedNeighbour(sqlite, { tags: ["synthesized", "pricing"] });
    await runInsightAccrual(makeEnv(sqlite, [match()]), ctx);
    expect(await candidateCount(sqlite)).toBe(0);
  });

  it("uses D1's created_at rather than stale vector metadata for the gap check", async () => {
    // The neighbour is genuinely four months old in D1...
    seedNeighbour(sqlite, { createdAt: NOW - 120 * DAY });
    // ...but its vector's metadata — stamped whenever it was last embedded,
    // e.g. an append — claims it is two days old, which would fail the
    // 30-day floor if trusted.
    await runInsightAccrual(makeEnv(sqlite, [
      match({ metadata: { created_at: NOW - 2 * DAY } }),
    ]), ctx);
    expect(await candidateCount(sqlite)).toBe(1);
  });

  it("uses the neighbour's D1 importance for the importance boost, not zero", async () => {
    seedNeighbour(sqlite, { importanceScore: 5 });
    await runInsightAccrual(makeEnv(sqlite, [match()]), ctx);

    const row = await sqlite.db.prepare(`SELECT score FROM insight_candidates`).first() as { score: number };
    // seed-1 has importanceScore 3 (beforeEach); old-1 has 5 here.
    // importanceBoost uses max(a.importance, b.importance) — 5, not 3 — which
    // only happens if the neighbour's real D1 importance reaches
    // scoreCandidate rather than the hardcoded 0 it used to get.
    const seedScorable: ScorableEntry = { id: "seed-1", tags: ["pricing"], importance: 3, createdAt: NOW };
    const neighbourScorable: ScorableEntry = { id: "old-1", tags: ["pricing"], importance: 5, createdAt: NOW - 90 * DAY };
    const expected = scoreCandidate(seedScorable, neighbourScorable, 0.87);
    expect(row.score).toBeCloseTo(expected, 10);
  });

  it("advances the cursor to the newest seed it examined", async () => {
    const kv = makeMemoryKV();
    seedNeighbour(sqlite);
    await runInsightAccrual(makeEnv(sqlite, [match()], kv), ctx);
    const cursor = JSON.parse((await kv.get(ACCRUAL_CURSOR_KEY))!) as { createdAt: number; id: string };
    expect(cursor).toMatchObject({ createdAt: NOW, id: "seed-1", generation: expect.any(String) });
  });

  it("leaves the cursor untouched when Vectorize is unavailable", async () => {
    const kv = makeMemoryKV();
    const vectorize = makeVectorizeMock({
      getByIds: vi.fn().mockRejectedValue(new Error("index unavailable")),
    });
    const env = makeTestEnv(undefined, { DB: sqlite.db as any, VECTORIZE: vectorize, OAUTH_KV: kv });

    await runInsightAccrual(env, ctx);

    expect(await kv.get(ACCRUAL_CURSOR_KEY)).toBeNull();
  });

  it("leaves the cursor untouched when no vector could be fetched", async () => {
    // Not an error — getByIds simply returned nothing. Advancing here would
    // skip these seeds permanently, which is the whole failure the cursor
    // ordering exists to prevent.
    const kv = makeMemoryKV();
    const vectorize = makeVectorizeMock({
      getByIds: vi.fn().mockResolvedValue([]),
      query: vi.fn().mockResolvedValue({ matches: [] }),
    });
    const env = makeTestEnv(undefined, { DB: sqlite.db as any, VECTORIZE: vectorize, OAUTH_KV: kv });

    await runInsightAccrual(env, ctx);

    expect(await kv.get(ACCRUAL_CURSOR_KEY)).toBeNull();
  });

  it("advances the cursor past a window with no eligible seed, so rejected rows are not re-read forever", async () => {
    const kv = makeMemoryKV();
    // Push the cursor past the default seed-1 so this run's window contains
    // only the row below.
    await putCurrentCursor(sqlite, kv, { createdAt: NOW, id: "seed-1" });
    sqlite.seed({
      id: "too-short", content: "short.", createdAt: NOW + DAY,
      tags: ["pricing"], source: "claude-desktop", vectorIds: ["vec-too-short"], importanceScore: 0,
    });

    await runInsightAccrual(makeEnv(sqlite, [], kv), ctx);

    // "too-short" was examined and correctly rejected (fails the content
    // floor) — not skipped. Holding the cursor here would re-read it, and
    // only it, forever.
    const cursor = JSON.parse((await kv.get(ACCRUAL_CURSOR_KEY))!) as { createdAt: number; id: string };
    expect(cursor).toMatchObject({ createdAt: NOW + DAY, id: "too-short", generation: expect.any(String) });
  });

  it("keeps a same-timestamp tie from being lost across the batch boundary", async () => {
    const kv = makeMemoryKV();
    const tieIds = Array.from({ length: 26 }, (_, i) => `tie-${String(i).padStart(2, "0")}`);
    for (const id of tieIds) {
      sqlite.seed({
        id, content: SEED_TEXT, createdAt: NOW + DAY,
        tags: ["pricing"], source: "claude-desktop", vectorIds: [`vec-${id}`], importanceScore: 0,
      });
    }

    await runInsightAccrual(makeEnv(sqlite, [], kv), ctx);
    const afterFirst = JSON.parse((await kv.get(ACCRUAL_CURSOR_KEY))!) as { createdAt: number; id: string };
    expect(afterFirst.createdAt).toBe(NOW + DAY);
    // A single-column `created_at > cursor` comparison would now exclude
    // every remaining tied row forever: none of their timestamps are greater
    // than the cursor's, only their ids are.
    expect(tieIds).toContain(afterFirst.id);

    await runInsightAccrual(makeEnv(sqlite, [], kv), ctx);
    const afterSecond = JSON.parse((await kv.get(ACCRUAL_CURSOR_KEY))!) as { createdAt: number; id: string };
    expect(tieIds.indexOf(afterSecond.id)).toBeGreaterThan(tieIds.indexOf(afterFirst.id));
  });

  it("excludes entries at or before a previously-set cursor", async () => {
    const kv = makeMemoryKV();
    sqlite.seed({
      id: "seed-2", content: SEED_TEXT, createdAt: NOW + DAY,
      tags: ["pricing"], source: "claude-desktop", vectorIds: ["vec-seed-2"], importanceScore: 0,
    });
    // Sitting exactly on seed-1's own position.
    await putCurrentCursor(sqlite, kv, { createdAt: NOW, id: "seed-1" });

    const env = makeEnv(sqlite, [], kv);
    await runInsightAccrual(env, ctx);

    // If seed-1 were wrongly re-included (e.g. `>` loosened to `>=`), it
    // would reach Vectorize a second time.
    expect(((env.VECTORIZE as any).query as any).mock.calls.length).toBe(1);
    const cursorAfter = JSON.parse((await kv.get(ACCRUAL_CURSOR_KEY))!) as { createdAt: number; id: string };
    expect(cursorAfter.id).toBe("seed-2");
  });

  it("ignores an eventually-consistent cursor from an older D1 generation", async () => {
    const kv = makeMemoryKV();
    const oldGeneration = await readDerivedStateGeneration({ DB: sqlite.db } as unknown as Env);
    await kv.put(ACCRUAL_CURSOR_KEY, JSON.stringify({
      createdAt: NOW,
      id: "seed-1",
      generation: oldGeneration,
    }));
    const newGeneration = "generation-after-restore";
    await sqlite.db.prepare(
      `UPDATE embedding_migration_generation SET generation = ? WHERE id = 'embedding-v1'`,
    ).bind(newGeneration).run();

    const summary = await runInsightAccrual(makeEnv(sqlite, [], kv), ctx);

    expect(summary.seedsExamined).toBe(1);
    const cursorAfter = JSON.parse((await kv.get(ACCRUAL_CURSOR_KEY))!);
    expect(cursorAfter).toMatchObject({ createdAt: NOW, id: "seed-1", generation: newGeneration });
  });

  it("writes the cursor as the newest examined seed's own timestamp, not the wall clock", async () => {
    sqlite.close();
    sqlite = makeSqliteD1();
    expect(sqlite.columns()).toContain("valid_until");
    const earlier = NOW - 2 * DAY;
    const later = NOW - DAY;
    sqlite.seed({
      id: "seed-a", content: SEED_TEXT, createdAt: earlier,
      tags: ["pricing"], source: "claude-desktop", vectorIds: ["vec-seed-1"], importanceScore: 0,
    });
    sqlite.seed({
      id: "seed-b", content: SEED_TEXT, createdAt: later,
      tags: ["pricing"], source: "claude-desktop", vectorIds: ["vec-seed-2"], importanceScore: 0,
    });

    const kv = makeMemoryKV();
    await runInsightAccrual(makeEnv(sqlite, [], kv), ctx);

    const cursorAfter = JSON.parse((await kv.get(ACCRUAL_CURSOR_KEY))!) as { createdAt: number; id: string };
    expect(cursorAfter.createdAt).toBe(later);
    expect(cursorAfter.createdAt).not.toBe(NOW);
    expect(cursorAfter.id).toBe("seed-b");
  });

  it("does not throw when the whole pass fails", async () => {
    const broken = { prepare: () => { throw new Error("D1 down"); } } as any;
    // Nothing was ever read, so the summary reports zero examined rather than
    // throwing or resolving to nothing — the caller (POST /insights/accrue)
    // always gets a shape it can report, even on a broken run.
    await expect(
      runInsightAccrualImpl(makeTestEnv(undefined, { DB: broken, OAUTH_KV: makeMemoryKV() }), ctx),
    ).resolves.toEqual({ seedsExamined: 0 });
  });

  it("seeds a candidate from a supersedes edge", async () => {
    sqlite.seed({
      id: "old-decision", createdAt: NOW - 120 * DAY, tags: ["pricing"],
      content: "Decision: price the first tier flat at nine dollars a month for predictability, always.",
    });
    sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
       VALUES ('edge-1', 'seed-1', 'old-decision', 'supersedes', 1.0, 'system', '{}', ?, ?)`,
    ).bind(NOW, NOW).run();

    await runInsightAccrual(makeEnv(sqlite, []), ctx);

    const row = await sqlite.db.prepare(
      `SELECT signal FROM insight_candidates`,
    ).first() as { signal: string };
    expect(row.signal).toBe("supersedes");
  });

  it("ignores a supersedes edge between entries written days apart", async () => {
    sqlite.seed({
      id: "yesterday", createdAt: NOW - DAY, tags: ["pricing"],
      content: "Decision: price the first tier flat at nine dollars a month for predictability, always.",
    });
    sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
       VALUES ('edge-2', 'seed-1', 'yesterday', 'supersedes', 1.0, 'system', '{}', ?, ?)`,
    ).bind(NOW, NOW).run();

    await runInsightAccrual(makeEnv(sqlite, []), ctx);

    expect(await candidateCount(sqlite)).toBe(0);
  });

  it("does not seed a supersedes candidate whose deprecated side fails eligibility", async () => {
    // A system-provenance supersedes edge always calls deprecateEntry() on its
    // target (src/capture/entry.ts), so without this filter essentially every
    // supersedes candidate pairs a live entry with a deprecated one whose
    // vectors have already been deleted. This is the design spec's own
    // documented false positive (docs/superpowers/specs/2026-08-10-insight-
    // pass-design.md), reproduced directly: the gap floor alone says yes, and
    // only isInsightEligible on the deprecated side says no.
    sqlite.seed({
      id: "old-decision", createdAt: NOW - 120 * DAY, tags: ["pricing", "status:deprecated"],
      content: "Decision: price the first tier flat at nine dollars a month for predictability, always.",
    });
    sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
       VALUES ('edge-3', 'seed-1', 'old-decision', 'supersedes', 1.0, 'system', '{}', ?, ?)`,
    ).bind(NOW, NOW).run();

    await runInsightAccrual(makeEnv(sqlite, []), ctx);

    expect(await candidateCount(sqlite)).toBe(0);
  });

  it("does not seed a supersedes candidate when the newer side is machine-authored", async () => {
    // The eligibility filter runs on BOTH sides, not just the deprecated one —
    // a supersedes edge's source can just as easily fail on its own tags,
    // source, or content floor, and the vector path already checks both sides
    // after hydrating from D1. This pins that the supersedes path now does
    // the same, rather than only handling the deprecated-target case.
    sqlite.seed({
      id: "sup-a", createdAt: NOW - 120 * DAY, tags: ["synthesized", "work"], source: "system",
      content: "[Synthesized from 12 entries] A long enough synthesized summary of a recurring theme in this brain overall.",
    });
    sqlite.seed({
      id: "sup-b", createdAt: NOW, tags: ["pricing"],
      content: "Decision: a perfectly ordinary, eligible entry that clears the content floor on its own merits, easily.",
    });
    sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
       VALUES ('edge-4', 'sup-a', 'sup-b', 'supersedes', 1.0, 'system', '{}', ?, ?)`,
    ).bind(NOW, NOW).run();

    await runInsightAccrual(makeEnv(sqlite, []), ctx);

    expect(await candidateCount(sqlite)).toBe(0);
  });

  it("does not let a flood of dead system supersedes edges starve out a live explicit one", async () => {
    // The filter for a deprecated target used to run only in JS, after
    // `ORDER BY e.created_at DESC LIMIT 10` had already picked the ten rows
    // it would ever see. A system-provenance supersedes edge always
    // deprecates its target the instant it is created (src/capture/entry.ts
    // calls deprecateEntry(conflictId) immediately before createEdge(...,
    // "supersedes", { provenance: "system" })), so every one of those rows
    // was always going to fail isInsightEligible. System edges outnumber
    // explicit ones roughly 3:1 in a real brain and are usually the newest,
    // so more than ten of them — all newer than the one explicit edge below
    // — fill the window with rows that can never qualify, and the explicit
    // pair is never examined. There is no cursor on this query, so that is
    // not unlucky timing: it starves the same way on every later run too.
    const explicitContent =
      "Decision: keep the explicit supersedes edge readable and long enough to clear the content floor, in full.";
    sqlite.seed({ id: "explicit-a", createdAt: NOW - 120 * DAY, tags: ["pricing"], content: explicitContent });
    sqlite.seed({ id: "explicit-b", createdAt: NOW - 200 * DAY, tags: ["pricing"], content: explicitContent });
    sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
       VALUES ('edge-explicit', 'explicit-a', 'explicit-b', 'supersedes', 1.0, 'explicit', '{}', ?, ?)`,
    ).bind(NOW, NOW).run();

    // One shared live source, 11 distinct deprecated targets, 11 system
    // edges — more than the LIMIT 10 the query applies. All 11 edges are
    // newer than the explicit edge above, so an unfiltered top-10-by-recency
    // window is filled entirely by these before the explicit edge is ever
    // reached. (The source is shared, not distinct per edge, purely to keep
    // this test's row count under ACCRUAL_SEED_LIMIT — ACCRUAL_SEED_LIMIT
    // governs a separate, unrelated selection over `entries` earlier in the
    // same run, and this test does not want to also be exercising that.)
    sqlite.seed({
      id: "sys-src", createdAt: NOW - 60 * DAY, tags: ["pricing"],
      content: "A perfectly ordinary system-edge source entry, long enough to clear the content floor easily.",
    });
    for (let i = 0; i < 11; i++) {
      const tgt = `sys-tgt-${i}`;
      sqlite.seed({
        id: tgt, createdAt: NOW - 150 * DAY, tags: ["pricing", "status:deprecated"],
        content: `A perfectly ordinary system-edge target entry, number ${i}, long enough to clear the content floor easily.`,
      });
      sqlite.db.prepare(
        `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
         VALUES (?, 'sys-src', ?, 'supersedes', 1.0, 'system', '{}', ?, ?)`,
      ).bind(`edge-sys-${i}`, tgt, NOW + i * 1000, NOW + i * 1000).run();
    }

    await runInsightAccrual(makeEnv(sqlite, []), ctx);

    expect(await candidateCount(sqlite)).toBe(1);
    const row = await sqlite.db.prepare(
      `SELECT a_id, b_id, signal FROM insight_candidates`,
    ).first() as { a_id: string; b_id: string; signal: string };
    expect(row.signal).toBe("supersedes");
    expect([row.a_id, row.b_id].sort()).toEqual(["explicit-a", "explicit-b"]);
  });

  describe("seedsExamined", () => {
    // POST /insights/accrue (src/routes/admin.ts) reports this back so a
    // self-hoster priming a large brain can see the pass making progress.
    it("counts the whole window pulled this pass, not just the eligible subset", async () => {
      seedNeighbour(sqlite);
      // "too-short" fails the content floor and is never a seed, but it was
      // still in the window this pass examined.
      sqlite.seed({
        id: "too-short", content: "short.", createdAt: NOW + DAY,
        tags: ["pricing"], source: "claude-desktop", vectorIds: ["vec-too-short"], importanceScore: 0,
      });
      const summary = await runInsightAccrual(makeEnv(sqlite, [match()]), ctx);
      // beforeEach seeds "seed-1"; seedNeighbour() adds "old-1"; this test
      // adds "too-short" — three rows in the window total.
      expect(summary).toEqual({ seedsExamined: 3 });
    });

    it("is nonzero even when the whole window is rejected (results.length, not seeds.length)", async () => {
      // Fresh database, deliberately without beforeEach's eligible "seed-1" —
      // this exercises the `!seeds.length` early return with results.length
      // > 0, to confirm seedsExamined counts the window, not the eligible
      // subset, on that path too.
      sqlite.close();
      sqlite = makeSqliteD1();
      expect(sqlite.columns()).toContain("valid_until");
      sqlite.seed({
        id: "too-short", content: "short.", createdAt: NOW,
        tags: ["pricing"], source: "claude-desktop", vectorIds: ["vec-too-short"], importanceScore: 0,
      });
      const summary = await runInsightAccrual(makeEnv(sqlite, []), ctx);
      expect(summary).toEqual({ seedsExamined: 1 });
    });

    it("is zero when the window itself is empty", async () => {
      sqlite.close();
      sqlite = makeSqliteD1();
      expect(sqlite.columns()).toContain("valid_until");
      const summary = await runInsightAccrual(makeEnv(sqlite, []), ctx);
      expect(summary).toEqual({ seedsExamined: 0 });
    });
  });
});

describe("isEligiblePair()", () => {
  const assistant = { tags: ["work", "claude-response"] };
  const user = { tags: ["work", "pricing"] };

  it("rejects two assistant notes, which have no original between them", () => {
    expect(isEligiblePair(assistant, assistant)).toBe(false);
  });

  // The case a blunt per-entry exclusion would have destroyed, and the one most
  // likely to regress: a decision recorded in a session meeting a thought
  // recorded months earlier is the useful kind of insight.
  it("allows an assistant note paired with a user memory", () => {
    expect(isEligiblePair(assistant, user)).toBe(true);
    expect(isEligiblePair(user, assistant)).toBe(true);
  });

  it("allows two user memories", () => {
    expect(isEligiblePair(user, user)).toBe(true);
  });
});
