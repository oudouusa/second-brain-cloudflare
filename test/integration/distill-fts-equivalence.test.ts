/**
 * T-0059 equivalence proof: distillToRareTerms's df/total must be the same
 * whether they come from the FTS index or the LIKE full scan it replaces,
 * for every term the FTS count path actually serves (an "unsafe" term, per
 * ftsCountSafeToken, routes the WHOLE query to LIKE instead — see
 * test/unit/recall-fts-query.test.ts for the raw divergence that guard
 * exists to route around).
 *
 * Real SQLite (test/helpers/sqlite-d1.ts), because the thing under test is
 * whether FTS5 trigram MATCH counts agree with LIKE counts — unevaluable by
 * the string-matching D1 mock.
 */
import { describe, it, expect } from "vitest";
import { distillToRareTerms, probeTrigrams } from "../../src/recall/distill";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { ftsShortToken, resetFtsReadyMemo } from "../../src/recall/fts";
import { tokenizeQueryDetailed } from "../../src/text/lexical-query";
import { FTS_READY_KV_KEY, QUERY_SATURATION_FRACTION } from "../../src/constants";
import type { Env } from "../../src/env";
import type { Identity } from "../../src/lib/identity";

/** Deterministic PRNG (mulberry32), so a failing trial is reproducible from its seed. */
function mulberry32(seed: number) {
  return function random() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Category pools mixed within a single trial's corpus, spanning every shape
// the task calls out: ASCII, mixed case, non-ASCII case (unsafe for FTS
// counting — ftsCountSafeToken routes these to LIKE), CJK, identifiers,
// substrings inside longer words, and embedded quotes.
const ASCII = ["ledger", "atlas", "widget", "gadget", "dashboard", "runtime", "invoice", "printer", "harbor", "cactus", "budget", "report", "kernel", "socket", "canvas", "meadow", "quartz", "cobalt", "lumen", "forge"];
const MIXED_CASE = ["Dashboard", "REPORT", "Runtime", "GADGET", "Ledger", "Atlas"];
const ACCENTED = ["café", "résumé", "naïve", "Zürich", "façade", "Nürnberg"];
const CJK = ["認証方式", "東京都庁", "予算確定", "契約書署名", "歯医者予約", "図書館返却"];
const IDENTIFIERS = ["#149", "v1.9", "item-42", "order#7", "build-2024", "ticket-88"];
const QUOTED = [`ro"bot`, `en"try`, `it"self`, `"quoted`];
const SUBSTRING_HOSTS = (w: string) => [`pre${w}fix`, `${w}s`, `co${w}nate`];

const POOLS: { name: string; words: string[] }[] = [
  { name: "ascii", words: ASCII },
  { name: "mixed-case", words: [...ASCII, ...MIXED_CASE] },
  { name: "accented", words: [...ASCII, ...ACCENTED] },
  { name: "cjk", words: [...ASCII, ...CJK] },
  { name: "identifiers", words: [...ASCII, ...IDENTIFIERS] },
  { name: "quoted", words: [...ASCII, ...QUOTED] },
  { name: "mixed-everything", words: [...ASCII, ...MIXED_CASE, ...ACCENTED, ...CJK, ...IDENTIFIERS, ...QUOTED] },
];

function sampleDistinct(rng: () => number, pool: string[], n: number): string[] {
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

interface Trial { rows: string[]; query: string; poolName: string }

function buildTrial(rng: () => number): Trial {
  const pool = POOLS[Math.floor(rng() * POOLS.length)];
  const queryWordCount = 2 + Math.floor(rng() * 3); // 2-4 distinct query words
  const queryWords = sampleDistinct(rng, pool.words, queryWordCount);
  const rowCount = 10 + Math.floor(rng() * 40); // well under any saturation cap
  const rows: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const wordsInRow: string[] = [];
    for (const w of queryWords) {
      const r = rng();
      if (r < 0.15) wordsInRow.push(...SUBSTRING_HOSTS(w).slice(0, 1)); // buried inside a longer word only
      else if (r < 0.55) wordsInRow.push(w); // a genuine standalone match
      // else: this row skips the term entirely, varying its df
    }
    const fillerCount = 1 + Math.floor(rng() * 3);
    for (let f = 0; f < fillerCount; f++) wordsInRow.push(pool.words[Math.floor(rng() * pool.words.length)]);
    rows.push(wordsInRow.length ? wordsInRow.join(" ") : "filler row text");
  }
  return { rows, query: queryWords.join(" "), poolName: pool.name };
}

async function distillBoth(trial: Trial) {
  const sqlite = makeSqliteD1();
  resetDatabaseInit();
  const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
  await initializeDatabase(env);
  trial.rows.forEach((content, i) => sqlite.seed({ id: `row-${i}`, content, createdAt: i + 1 }));

  resetFtsReadyMemo();
  const likeOut = await distillToRareTerms(trial.query, env);

  await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
  resetFtsReadyMemo();
  const ftsOut = await distillToRareTerms(trial.query, env);

  sqlite.close();
  return { likeOut, ftsOut };
}

describe("T-0059 equivalence: FTS-counted distillation vs the LIKE scan it replaces", () => {
  const TRIALS = 320;
  const seedBase = 20260923;

  it(`agrees on kept terms and the rebuilt query across ${TRIALS} randomized corpora`, async () => {
    const divergences: string[] = [];
    let ftsRunCount = 0;
    let scanRunCount = 0;
    let likeFallbackCount = 0;

    for (let n = 0; n < TRIALS; n++) {
      const rng = mulberry32(seedBase + n);
      const trial = buildTrial(rng);
      const { likeOut, ftsOut } = await distillBoth(trial);

      const label = `trial#${n} seed=${seedBase + n} pool=${trial.poolName} query=${JSON.stringify(trial.query)}`;

      // T-0074: a short token's df is sampled, not counted, so the two paths may rank it differently
      // (by design: it can only fill a slot the counted terms leave, see distill-short-token-skew.test.ts).
      const hasShortToken = tokenizeQueryDetailed(trial.query).some(term => ftsShortToken(term.value));
      if (!hasShortToken && ftsOut.query !== likeOut.query) {
        divergences.push(`${label}: rebuilt query differs — like=${JSON.stringify(likeOut.query)} fts=${JSON.stringify(ftsOut.query)}`);
        continue;
      }

      // "scan": the one-pass count a common-word query takes instead, capped as the FTS counts would be, so held to the same bar.
      if (ftsOut.distillSource === "fts" || ftsOut.distillSource === "scan") {
        if (ftsOut.distillSource === "fts") ftsRunCount++; else scanRunCount++;
        expect(likeOut.distillSource === "like" || likeOut.distillSource === "shortcut", label).toBe(true);
        if (ftsOut.total !== likeOut.total) {
          divergences.push(`${label}: total differs — like=${likeOut.total} fts=${ftsOut.total}`);
          continue;
        }
        if (ftsOut.df && likeOut.df) {
          for (const [term, ftsDf] of ftsOut.df) {
            const likeDf = likeOut.df.get(term);
            // Every term in this generator's corpora sits far under the
            // saturation cap (rows stay in the tens; the cap floors at
            // FTS_MATCH_BUDGET+1 = 2001), so every term here is UNCAPPED —
            // this branch is exactly the equivalence bar the task requires.
            // T-0074: a term under the trigram floor cannot be counted through the
            // index; its df is a Laplace-smoothed sample of the newest rows, which
            // covers every row of these corpora, so it lands on the exact count or
            // one above it.
            const tolerance = ftsShortToken(term) ? 1 : 0;
            const drift = ftsDf - (likeDf ?? 0);
            if (drift < 0 || drift > tolerance) {
              divergences.push(`${label}: df("${term}") differs — like=${likeDf} fts=${ftsDf}`);
            }
          }
        }
      } else {
        likeFallbackCount++;
      }
    }

    expect(divergences, divergences.slice(0, 10).join("\n")).toEqual([]);
    // Sanity: the generator must actually exercise both paths, or this test
    // proves nothing. "accented" trials are expected to fall back to LIKE
    // (ftsCountSafeToken), so likeFallbackCount > 0 is expected too.
    expect(ftsRunCount + scanRunCount).toBeGreaterThan(TRIALS / 4);
    expect(ftsRunCount).toBeGreaterThan(0);
    expect(scanRunCount).toBeGreaterThan(0);
    expect(likeFallbackCount).toBeGreaterThan(0);
  }, 30000); // 320 real-SQLite trials measured at 4.09s against the 5s default; give it headroom under load.
});

describe("T-0059 cost: the FTS count path never scans entries or entries_fts in full", () => {
  it("EXPLAIN QUERY PLAN shows entries_fts searched by MATCH and entries joined by rowid", async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);
    for (let i = 0; i < 30; i++) sqlite.seed({ id: `row-${i}`, content: "atlas ledger widget filler text", createdAt: i + 1 });
    // Rows without the terms, so the counts are cheaper than one pass over the corpus and the FTS route is taken.
    for (let i = 30; i < 400; i++) sqlite.seed({ id: `row-${i}`, content: "unrelated filler text", createdAt: i + 1 });
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();

    const out = await distillToRareTerms("atlas ledger widget", env);
    expect(out.distillSource).toBe("fts");

    // T-0065: no time bounds, so distillation issues ONE batch: liveness, then one statement carrying entry_counts'
    // total and every per-term count (dfCountsStmt in src/recall/distill.ts).
    const batch = sqlite.batches.find(b => b.some(sql => sql.includes("entries_fts") && sql.includes("MATCH")));
    expect(batch, JSON.stringify(sqlite.batches, null, 2)).toBeTruthy();
    const countStatements = batch!.filter(sql => sql.includes("entries_fts") && sql.includes("MATCH"));
    expect(countStatements).toHaveLength(1);

    for (const sql of countStatements) {
      // The plan does not depend on the bound values, so every numbered parameter is bound to null.
      const params = Math.max(...[...sql.matchAll(/\?(\d+)/g)].map(m => Number(m[1])));
      const { results } = await sqlite.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...new Array(params).fill(null)).all();
      const detail = (results as { detail: string }[]).map(r => r.detail).join(" | ");
      // SQLite always labels virtual-table access "SCAN <table> VIRTUAL TABLE
      // INDEX n:xx" in EXPLAIN QUERY PLAN, even when it is using an index —
      // "SCAN" here is the fixed vocabulary for any xFilter-driven virtual
      // table walk, not evidence of a full scan. The "M" index code is FTS5's
      // own marker for "driven by a MATCH constraint" (bestIndex idxStr);
      // real rows_read for this path was already measured flat with corpus
      // growth in E2E (docs/superpowers/plans/2026-09-21-fts5-lexical-arm.md).
      expect(detail, detail).toMatch(/entries_fts VIRTUAL TABLE INDEX \d+:M/);
      // entries (aliased e) must be reached by its primary-key/rowid index,
      // never a bare table scan.
      expect(detail, detail).toMatch(/SEARCH e USING/);
      expect(detail, detail).not.toMatch(/\bSCAN e\b/);
    }
    sqlite.close();
  });
});

const memberOf = (personal: string): Identity => ({
  userId: "u1",
  role: "member",
  personalWorkspaceId: personal,
  companyWorkspaceIds: [],
  defaultShare: "" as const,
});

function seedIn(sqlite: SqliteD1, id: string, workspaceId: string, content: string, createdAt: number) {
  sqlite.seed({ id, content, createdAt });
  return sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(workspaceId, id).run();
}

describe("single-token df uses the same scoped FTS/LIKE path as multi-token df", () => {
  it.each(["like", "fts"] as const)("counts a single term with workspace and time bounds via %s", async mode => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    try {
      const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
      await initializeDatabase(env);
      await seedIn(sqlite, "early", "ws-a", "quartz first", 100);
      await seedIn(sqlite, "inside", "ws-a", "quartz second", 200);
      await seedIn(sqlite, "late", "ws-a", "ordinary note", 250);
      await seedIn(sqlite, "company", "ws-co", "quartz team", 200);
      await seedIn(sqlite, "foreign", "ws-other", "quartz outsider", 200);
      if (mode === "fts") {
        await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
        resetFtsReadyMemo();
      }
      const identity: Identity = { ...memberOf("ws-a"), companyWorkspaceIds: ["ws-co"] };
      const bounded = await distillToRareTerms("quartz", env, undefined, { after: 150, before: 225 }, identity, "personal");
      expect(bounded.distillSource).toBe(mode);
      expect(bounded.total).toBe(1);
      expect(bounded.df?.get("quartz")).toBe(1);

      const personal = await distillToRareTerms("quartz", env, undefined, {}, identity, "personal");
      expect(personal.distillSource).toBe(mode);
      expect(personal.total).toBe(3);
      expect(personal.df?.get("quartz")).toBe(2);

      const company = await distillToRareTerms("quartz", env, undefined, {}, identity, "company", "ws-co");
      expect(company.distillSource).toBe(mode);
      expect(company.total).toBe(1);
      expect(company.df?.get("quartz")).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});

describe("T-0059 scope: the FTS count path never counts another workspace's rows", () => {
  it("a foreign workspace's matching rows do not inflate df or total", async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);

    const identity = memberOf("ws-a");
    seedIn(sqlite, "mine-1", "ws-a", "atlas ledger quartz", 1);
    seedIn(sqlite, "mine-2", "ws-a", "atlas filler text", 2);
    // A foreign workspace with the SAME terms: if the scope clause were
    // dropped, these would inflate both df and total for ws-a's caller.
    for (let i = 0; i < 20; i++) seedIn(sqlite, `foreign-${i}`, "ws-b", "atlas ledger quartz", 10 + i);

    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    const out = await distillToRareTerms("atlas ledger quartz", env, undefined, {}, identity);

    // The foreign rows count in entries_fts_vocab (it has no scope), so the price sends this query to the pass.
    expect(out.distillSource).toBe("scan");
    expect(out.total).toBe(2); // ws-a's two rows only
    expect(out.df!.get("atlas")).toBe(2);
    expect(out.df!.get("ledger")).toBe(1);
    sqlite.close();
  });

  it("the FTS route is scoped the same way", async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);

    const identity = memberOf("ws-a");
    seedIn(sqlite, "mine-1", "ws-a", "atlas ledger quartz", 1);
    seedIn(sqlite, "mine-2", "ws-a", "atlas filler text", 2);
    // Enough of ws-a's own rows without the terms that the counts are the cheaper route.
    for (let i = 0; i < 200; i++) seedIn(sqlite, `other-${i}`, "ws-a", "unrelated filler text", 100 + i);
    for (let i = 0; i < 20; i++) seedIn(sqlite, `foreign-${i}`, "ws-b", "atlas ledger quartz", 10 + i);

    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    const out = await distillToRareTerms("atlas ledger quartz", env, undefined, {}, identity);

    expect(out.distillSource).toBe("fts");
    expect(out.total).toBe(202);
    expect(out.df!.get("atlas")).toBe(2);
    expect(out.df!.get("ledger")).toBe(1);
    sqlite.close();
  });
});

describe("T-0065: entry_counts' total equals the scoped COUNT(*) for every caller shape", () => {
  async function setupWorkspaces() {
    resetDatabaseInit();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);
    seedIn(sqlite, "p1", "ws-personal", "atlas ledger quartz", 1);
    seedIn(sqlite, "p2", "ws-personal", "atlas filler text", 2);
    seedIn(sqlite, "c1", "ws-team-a", "atlas ledger quartz", 3);
    seedIn(sqlite, "c2", "ws-team-b", "atlas filler text", 4);
    seedIn(sqlite, "c3", "ws-team-b", "atlas quartz", 5);
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    return { sqlite, env };
  }

  const trueScopedTotal = async (sqlite: SqliteD1, workspaceIds: string[]) => {
    const markers = workspaceIds.map(() => "?").join(",");
    const row = await sqlite.db.prepare(`SELECT count(*) AS n FROM entries WHERE workspace_id IN (${markers})`)
      .bind(...workspaceIds).first() as { n: number };
    return row.n;
  };

  it("personal-only caller", async () => {
    const { sqlite, env } = await setupWorkspaces();
    const identity: Identity = { userId: "u1", role: "member", personalWorkspaceId: "ws-personal", companyWorkspaceIds: ["ws-team-a", "ws-team-b"], defaultShare: "" };

    const out = await distillToRareTerms("atlas ledger quartz", env, undefined, {}, identity, "personal");

    expect(out.distillSource).toBe("scan");
    expect(out.total).toBe(await trueScopedTotal(sqlite, ["ws-personal"]));
    expect(out.total).toBe(2);
    sqlite.close();
  });

  it("company-layer caller sums every company workspace it belongs to", async () => {
    const { sqlite, env } = await setupWorkspaces();
    const identity: Identity = { userId: "u1", role: "member", personalWorkspaceId: "ws-personal", companyWorkspaceIds: ["ws-team-a", "ws-team-b"], defaultShare: "" };

    const out = await distillToRareTerms("atlas ledger quartz", env, undefined, {}, identity, "company");

    expect(out.distillSource).toBe("scan");
    expect(out.total).toBe(await trueScopedTotal(sqlite, ["ws-team-a", "ws-team-b"]));
    expect(out.total).toBe(3);
    sqlite.close();
  });

  it("teamId-narrowed caller sees only that one team, even though it belongs to more", async () => {
    const { sqlite, env } = await setupWorkspaces();
    const identity: Identity = { userId: "u1", role: "member", personalWorkspaceId: "ws-personal", companyWorkspaceIds: ["ws-team-a", "ws-team-b"], defaultShare: "" };

    const out = await distillToRareTerms("atlas ledger quartz", env, undefined, {}, identity, "company", "ws-team-b");

    expect(out.distillSource).toBe("scan");
    expect(out.total).toBe(await trueScopedTotal(sqlite, ["ws-team-b"]));
    expect(out.total).toBe(2);
    sqlite.close();
  });

  it("identity-less caller (no scope clause) sums every workspace", async () => {
    const { sqlite, env } = await setupWorkspaces();

    const out = await distillToRareTerms("atlas ledger quartz", env);

    expect(out.distillSource).toBe("scan");
    const row = await sqlite.db.prepare(`SELECT count(*) AS n FROM entries`).first() as { n: number };
    expect(out.total).toBe(row.n);
    expect(out.total).toBe(5);
    sqlite.close();
  });
});

describe("T-0059 liveness: a stale index (ready flag set, triggers gone) falls back to LIKE", () => {
  it("falls back to the LIKE scan when a sync trigger is missing despite fts:ready", async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);
    for (let i = 0; i < 10; i++) sqlite.seed({ id: `row-${i}`, content: "atlas ledger widget", createdAt: i + 1 });

    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    // A hot-path repair can drop a trigger without ever clearing KV — the
    // exact drift write-path isolation v2.2 defends against.
    sqlite.db.prepare(`DROP TRIGGER entries_fts_delete`).run();

    const out = await distillToRareTerms("atlas ledger widget", env);
    expect(out.distillSource).toBe("like");
    expect(out.total).toBe(10);
    sqlite.close();
  });
});

describe("T-0065: a time-bounded call never affects the unbounded scoped total", () => {
  it("an unbounded call after a bounded one still sees the whole corpus", async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);
    for (let i = 0; i < 5; i++) sqlite.seed({ id: `old-${i}`, content: "atlas ledger widget", createdAt: 1 + i });
    for (let i = 0; i < 5; i++) sqlite.seed({ id: `new-${i}`, content: "atlas ledger widget", createdAt: 100 + i });

    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();

    const bounded = await distillToRareTerms("atlas ledger widget", env, undefined, { after: 50 });
    expect(bounded.distillSource).toBe("fts");
    expect(bounded.total).toBe(5); // only the 5 rows created after t=50

    const unbounded = await distillToRareTerms("atlas ledger widget", env);
    // Every row holds every term, so the unbounded call takes the pass; the bounded path always counts.
    expect(unbounded.distillSource).toBe("scan");
    expect(unbounded.total).toBe(10); // the whole corpus, not the bounded call's leftover total
    sqlite.close();
  });
});

describe("T-0059 ranking effect: a saturated (capped) term still gets dropped, same as the true count would", () => {
  it("caps a near-universal term's df but keeps the same keep/drop outcome as LIKE", async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);

    // 8,000 rows: large enough that 30% of the corpus (the saturation cap)
    // exceeds FTS_MATCH_BUDGET (2,000), so the "common" term's FTS count is
    // genuinely capped rather than exact. "rare" appears in only 5 rows.
    const total = 8000;
    for (let i = 0; i < total; i++) {
      const content = i < total - 5 ? "common filler word" : "common rare word";
      sqlite.seed({ id: `row-${i}`, content, createdAt: i + 1 });
    }

    resetFtsReadyMemo();
    const likeOut = await distillToRareTerms("common rare", env);

    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    const ftsOut = await distillToRareTerms("common rare", env);

    expect(ftsOut.distillSource).toBe("fts");
    const trueCommonDf = likeOut.df!.get("common")!;
    const cappedCommonDf = ftsOut.df!.get("common")!;
    expect(trueCommonDf).toBe(total); // every row contains "common"
    expect(cappedCommonDf).toBeLessThan(trueCommonDf); // genuinely capped, not coincidentally equal
    expect(cappedCommonDf).toBeGreaterThan(QUERY_SATURATION_FRACTION * total); // still unambiguously over the saturation line

    // The numeric df differs (capped vs true — the one documented semantic
    // difference), but the RANKING OUTCOME is identical: "common" is dropped
    // and "rare" is kept, by both methods, since both counts land the same
    // side of the saturation boundary.
    expect(likeOut.query).toBe("rare");
    expect(ftsOut.query).toBe("rare");
    expect(ftsOut.query).toBe(likeOut.query);

    sqlite.close();
  }, 30000); // 8,000-row real-SQLite corpus; timed out at the 5s default under parallel-suite load.
});

describe("T-0059 all-saturated fallback: capped counts that cannot rank fall back to LIKE", () => {
  it("an all-saturated query keeps exactly what LIKE keeps, via the LIKE path", async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);

    // The reviewer's case: 8,000 rows, four terms with true df 8000/7000/
    // 6000/5000. All four sit above the saturation cap (2,401), so FTS caps
    // every count at the LIMIT and the kept set collapses to the cap order —
    // terma termb termc — while LIKE's exact counts keep termb termc termd.
    const total = 8000;
    const content = (i: number) =>
      [i < 8000, i < 7000, i < 6000, i < 5000]
        .map((has, j) => (has ? `term${"abcd"[j]}` : ""))
        .filter(Boolean).join(" ");
    for (let i = 0; i < total; i++) {
      const filler = i % 2 ? " filler" : "";
      sqlite.seed({ id: `row-${i}`, content: `${content(i)}${filler}`, createdAt: i + 1 });
    }

    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    const out = await distillToRareTerms("terma termb termc termd", env);

    // Without the fallback, all four df values read 2401 and rankAndRebuild
    // keeps the first three by df order: "terma termb termc".
    expect(out.distillSource).toBe("like");
    expect(out.query).toBe("termb termc termd");
    expect(out.df!.get("terma")).toBe(8000);
    expect(out.df!.get("termb")).toBe(7000);
    expect(out.df!.get("termc")).toBe(6000);
    expect(out.df!.get("termd")).toBe(5000);
    expect(out.total).toBe(8000);
    sqlite.close();
  });

  it("one unsaturated original term keeps the query on the FTS path", async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);

    // Same shape, but "rare" appears in only 5 rows: the fallback must not
    // fire because one original term is genuinely rankable.
    const total = 8000;
    for (let i = 0; i < total; i++) {
      const content = `${i < 8000 ? "term1" : ""} ${i < 7000 ? "term2" : ""} ${i < 5 ? "rare" : ""}`.trim();
      const filler = i % 2 ? " filler" : "";
      sqlite.seed({ id: `row-${i}`, content: `${content}${filler}`, createdAt: i + 1 });
    }

    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    const out = await distillToRareTerms("term1 term2 rare", env);

    // Two capped terms price the counts under twice one pass, so the counts serve it.
    expect(out.distillSource).toBe("fts");
    expect(out.query).toBe("rare");
    expect(out.df!.get("rare")).toBe(5); // exact, uncapped
    expect(out.df!.get("term1")).toBe(2401);
    sqlite.close();
  });

  it("the pass serves a query whose counts would read past twice the corpus, capped exactly as the counts would be", async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);

    const total = 8000;
    for (let i = 0; i < total; i++) {
      const content = `termw termx ${i < 7000 ? "termy" : ""} ${i < 6000 ? "termz" : ""} ${i < 5 ? "rare" : ""}`.replace(/\s+/g, " ").trim();
      sqlite.seed({ id: `row-${i}`, content, createdAt: i + 1 });
    }

    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    const out = await distillToRareTerms("termw termx termy termz rare", env);

    expect(out.distillSource).toBe("scan");
    expect(out.query).toBe("rare");
    expect(out.total).toBe(8000);
    expect(out.df!.get("rare")).toBe(5);
    // min(df, cap = 2401): what a LIMIT cap count returns for each
    for (const t of ["termw", "termx", "termy", "termz"]) expect(out.df!.get(t)).toBe(2401);
    sqlite.close();
  });
});

describe("pricing the df counts with entries_fts_vocab", () => {
  it("probes every distinct trigram of a term, folded as the trigram tokenizer folds them", () => {
    expect(probeTrigrams("abc")).toEqual(["abc"]);
    expect(probeTrigrams("Atlas")).toEqual(["atl", "tla", "las"]);
    expect(probeTrigrams("ledgers")).toEqual(["led", "edg", "dge", "ger", "ers"]);
    expect(probeTrigrams("aaaa")).toEqual(["aaa"]);
    expect(probeTrigrams("認証方式")).toEqual(["認証方", "証方式"]);
  });

  async function brain(rows: number) {
    resetDatabaseInit();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    const env: Env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);
    for (let i = 0; i < rows; i++) sqlite.seed({ id: `row-${i}`, content: "atlas ledger widget", createdAt: i + 1 });
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    return { sqlite, env };
  }

  it("a query needing more than 24 vocabulary lookups keeps the counts and reads no vocabulary", async () => {
    const { sqlite, env } = await brain(10);
    // Eight long words: far more than 24 distinct trigrams.
    const out = await distillToRareTerms("atlasatlas ledgerledger widgetwidget harborharbor cactuscactus budgetbudget reportreport kernelkernel", env);
    expect(out.distillSource).toBe("fts");
    const combined = sqlite.batches.flat().find(sql => sql.startsWith("WITH RECURSIVE g AS MATERIALIZED"));
    expect(combined).toBeTruthy();
    expect(combined).not.toContain("entries_fts_vocab");
    sqlite.close();
  });

  it("a common-word query within the lookup cap still reaches the pass", async () => {
    const { sqlite, env } = await brain(10);
    const out = await distillToRareTerms("atlas ledger widget", env);
    expect(out.distillSource).toBe("scan");
    expect(sqlite.batches.flat().find(sql => sql.startsWith("WITH RECURSIVE g AS MATERIALIZED"))).toContain("entries_fts_vocab");
    sqlite.close();
  });

  it("a missing entries_fts_vocab degrades to the LIKE scan with the same df", async () => {
    const { sqlite, env } = await brain(10);
    sqlite.db.prepare(`DROP TABLE entries_fts_vocab`).run();
    const out = await distillToRareTerms("atlas ledger widget", env);
    expect(out.distillSource).toBe("like");
    expect(out.total).toBe(10);
    expect(out.df!.get("atlas")).toBe(10);
    sqlite.close();
  });

  const sixteen = ["atlas", "ledger", "widget", "harbor", "cactus", "budget", "report", "kernel", "socket", "canvas", "meadow", "quartz", "cobalt", "lumen", "forge", "printer"];
  const memberOfTeams = (n: number): Identity => ({ userId: "u1", role: "member", personalWorkspaceId: "ws-personal", companyWorkspaceIds: Array.from({ length: n }, (_, i) => `ws-team-${i}`), defaultShare: "" });

  it("drops the price, not the combined counts, when the vocabulary probes would pass D1's bound-parameter limit", async () => {
    const { sqlite, env } = await brain(10);
    await sqlite.db.prepare(`UPDATE entries SET workspace_id = 'ws-personal' WHERE 1`).run();
    const out = await distillToRareTerms(sixteen.join(" "), env, undefined, {}, memberOfTeams(30));
    expect(out.distillSource).toBe("fts");
    const combined = sqlite.batches.flat().find(sql => sql.startsWith("WITH RECURSIVE g AS MATERIALIZED"));
    expect(combined).toBeTruthy();
    expect(combined).not.toContain("entries_fts_vocab");
    sqlite.close();
  });

  it("keeps the per-term counts when even the unpriced statement would pass the limit", async () => {
    const { sqlite, env } = await brain(10);
    await sqlite.db.prepare(`UPDATE entries SET workspace_id = 'ws-personal' WHERE 1`).run();
    const out = await distillToRareTerms(sixteen.join(" "), env, undefined, {}, memberOfTeams(70));
    expect(out.distillSource).toBe("fts");
    expect(sqlite.batches.flat().some(sql => sql.startsWith("WITH RECURSIVE g AS MATERIALIZED"))).toBe(false);
    expect(sqlite.batches.flat().some(sql => sql.startsWith("SELECT COALESCE(SUM(n), 0) AS total FROM entry_counts WHERE"))).toBe(true);
    sqlite.close();
  });
});
