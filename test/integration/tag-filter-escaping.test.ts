/**
 * Tag filters, run for real.
 *
 * A tag is user data and it goes into a LIKE pattern, where `_` matches any character and
 * `%` matches everything. `#q3_planning` is the ordinary multi-word hashtag convention and
 * src/text/hashtags.ts matches \w, so underscore tags arrive without anyone doing anything
 * unusual; the API's tags[] array and the integrations mirror accept any string at all.
 *
 * These are read paths, so the failure is over-broad results rather than the permanent
 * rollup the same bug caused in compressTag — a `#q3_planning` filter also returning
 * `q3-planning` entries is wrong but recoverable. `?tag=%` is the sharper one: the filter
 * silently stops filtering and returns the whole brain, which looks like a valid answer.
 *
 * test/helpers/d1-mock.ts cannot cover any of this — it compares decoded tag strings, so
 * LIKE wildcards in the tag do not exist there. That is stated on the helper itself.
 */
import { describe, it, expect, afterEach } from "vitest";
import { buildEntryFilterQuery } from "../../src/capture/entry";
import { recallEntries } from "../../src/recall/search";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { embeddingMetadata } from "../../src/embedding/profile";
import worker from "../../src/index";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { tagLikePattern } from "../../src/memory/tag-sql";
import { memoryWriteMarker } from "../../src/migration/write-lock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

let sqlite: SqliteD1 | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

/**
 * An Env whose DB is real SQLite.
 *
 * `makeSqliteD1` applies db/schema.sql, which deliberately omits the columns
 * initializeDatabase adds by ALTER (updated_at, staleness_checked_at, the counters) — so
 * `exec` really executes and seedEnv runs the real initializeDatabase over it. Listing
 * those columns here instead would be a second copy of the migration, wrong the moment one
 * is added.
 *
 * `batch` runs sequentially, which is enough for the read paths under test. Vectorize
 * returns one vector per requested id so the tag-scoped branch has something to score;
 * WHICH ids it is asked for is decided entirely by the tag query, which is the point.
 */
function envOver(s: SqliteD1): Env {
  const DB = {
    prepare: (sql: string) => s.db.prepare(sql),
    exec: async (sql: string) => s.db.prepare(sql).run(),
    batch: async (stmts: any[]) => Promise.all(stmts.map(st => st.run())),
  } as unknown as D1Database;
  const VECTORIZE = {
    ...makeVectorizeMock(),
    getByIds: async (ids: string[]) =>
      ids.map(id => ({
        id,
        values: new Array(128).fill(0.1),
        metadata: { parentId: id.replace(/^v-/, ""), ...embeddingMetadata() },
      })),
  } as unknown as Vectorize;
  return makeTestEnv(undefined, { DB, VECTORIZE });
}

/** Seeded SQLite plus an Env over it, with the real schema migration applied. */
async function seedEnv(): Promise<Env> {
  sqlite = seeded();
  const env = envOver(sqlite);
  resetDatabaseInit();
  await initializeDatabase(env);
  return env;
}

const OWN = Array.from({ length: 11 }, (_, i) => `own-${i}`).sort();
const OTHER = Array.from({ length: 9 }, (_, i) => `other-${i}`).sort();

/**
 * Eleven entries on an underscore tag, nine on the neighbour a `_` wildcard would reach.
 * Every entry carries a vector id so the tag-scoped recall path has something to fetch.
 */
function seeded(): SqliteD1 {
  const s = makeSqliteD1();
  // buildEntryFilterQueryが使う有効期間列はschema 9の参照DDLに含まれる。
  expect(s.columns()).toContain("valid_from");
  expect(s.columns()).toContain("valid_until");
  OWN.forEach((id, i) => s.seed({ id, content: `planning note ${i}`, createdAt: 1000 + i, tags: ["q3_planning"], vectorIds: [`v-${id}`] }));
  OTHER.forEach((id, i) => s.seed({ id, content: `planning note ${i}`, createdAt: 2000 + i, tags: ["q3-planning"], vectorIds: [`v-${id}`] }));
  return s;
}

describe("GET /entries and /list tag filter", () => {
  // buildEntryFilterQuery is the real builder both routes use, so this exercises the
  // shipped SQL and bindings rather than a copy of them.
  async function ids(tag: string): Promise<string[]> {
    sqlite = seeded();
    const { sql, bindings } = buildEntryFilterQuery({ n: 100, tag });
    const { results } = await sqlite.db.prepare(sql).bind(...bindings).all();
    return (results as { id: string }[]).map(r => r.id).sort();
  }

  it("does not reach a neighbouring tag through an underscore wildcard", async () => {
    expect(await ids("q3_planning")).toEqual(OWN);
  });

  it("does not return everything for a percent tag", async () => {
    expect(await ids("%")).toEqual([]);
    expect(await ids("%planning%")).toEqual([]);
  });

  it("still returns exactly the entries carrying the tag it was given", async () => {
    expect(await ids("q3-planning")).toEqual(OTHER);
  });
});

describe("tag-scoped recall candidate query", () => {
  /**
   * Two halves, because neither alone is worth much. This half captures the statement
   * recallEntries actually issues and checks it carries an escaped pattern and the ESCAPE
   * clause; the half below proves that combination behaves correctly in SQLite. Asserting
   * only the second would pass against a recallEntries that never adopted the helpers —
   * it did, when this test was first written that way.
   */
  it("issues an escaped pattern and an ESCAPE clause", async () => {
    const db = makeTestDb();
    db.entries.push({
      id: "e-0", content: "m", tags: JSON.stringify(["q3_planning"]), source: "api",
      created_at: 1, updated_at: 1, vector_ids: JSON.stringify(["v-0"]),
      recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0,
    });
    const prepared: string[] = [];
    const bound: unknown[][] = [];
    const DB = {
      prepare(sql: string) {
        const flat = sql.replace(/\s+/g, " ").trim();
        prepared.push(flat);
        const stmt = db.prepare(sql);
        return {
          ...stmt,
          bind: (...args: unknown[]) => { if (flat.includes("tags LIKE ?")) bound.push(args); return stmt.bind(...args); },
        };
      },
      exec: (sql: string) => db.exec(sql),
      batch: (stmts: any[]) => db.batch(stmts),
    } as unknown as D1Database;
    const env = makeTestEnv(db, {
      DB,
      VECTORIZE: makeVectorizeMock({
        getByIds: async () => [{ id: "v-0", values: new Array(128).fill(0.1), metadata: { parentId: "e-0" } }],
      }),
    });

    await recallEntries({ query: "planning", topK: 5, tag: "q3_planning" }, env, ctx);

    const tagQueries = prepared.filter(s => s.includes("tags LIKE ?"));
    expect(tagQueries).toHaveLength(2);
    expect(tagQueries.every(sql => sql.includes("ESCAPE"))).toBe(true);
    expect(bound).toHaveLength(2);
    expect(bound.every(args => args.includes(tagLikePattern("q3_planning")))).toBe(true);
    expect(bound.every(args => !args.includes(`%"q3_planning"%`))).toBe(true); // the unescaped form
  });

  /**
   * The behavioural half: the real recallEntries against real SQLite, asserting on the
   * entries it comes back with.
   *
   * This deliberately does not rebuild the query. An earlier version of this test did, and
   * it passed with search.ts's escaping removed — it was proving the helper works, not that
   * recall uses it. Only the entry ids answer the question the test is named for.
   */
  async function recalled(tag: string): Promise<string[]> {
    const env = await seedEnv();
    const { matches } = await recallEntries(
      { query: "planning", topK: 50, tag, synthesize: false },
      env,
      ctx,
    );
    return matches.map(m => m.id).sort();
  }

  it("returns only the entries carrying an underscore tag", async () => {
    expect(await recalled("q3_planning")).toEqual(OWN);
  });

  it("returns nothing for a percent tag rather than the whole brain", async () => {
    expect(await recalled("%")).toEqual([]);
    expect(await recalled("%planning%")).toEqual([]);
  });

  it("still returns the entries carrying an ordinary tag", async () => {
    expect(await recalled("q3-planning")).toEqual(OTHER);
  });

  it("reapplies tag, kind, and date filters when hydrating graph neighbors", async () => {
    sqlite = makeSqliteD1();
    const env = envOver(sqlite);
    resetDatabaseInit();
    await initializeDatabase(env);

    sqlite.seed({ id: "work-root", content: "alpha beta root", createdAt: 1000, tags: ["work", "kind:semantic"], vectorIds: ["v-work-root"] });
    sqlite.seed({ id: "a-personal", content: "alpha beta personal evidence", createdAt: 1000, tags: ["personal", "kind:semantic"] });
    sqlite.seed({ id: "b-wrong-kind", content: "alpha beta episodic evidence", createdAt: 1000, tags: ["work", "kind:episodic"] });
    sqlite.seed({ id: "c-too-old", content: "alpha beta old evidence", createdAt: 800, tags: ["work", "kind:semantic"] });
    sqlite.seed({ id: "d-too-new", content: "alpha beta future evidence", createdAt: 1200, tags: ["work", "kind:semantic"] });
    sqlite.seed({ id: "z-eligible", content: "alpha beta eligible evidence", createdAt: 1000, tags: ["work", "kind:semantic"] });
    const admittedEnv = sqlite.admitEnv(env);
    for (const id of ["a-personal", "b-wrong-kind", "c-too-old", "d-too-new", "z-eligible"]) {
      await admittedEnv.DB.prepare(
        `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, write_marker)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `edge-${id}`, "work-root", id, "decided", 1, "explicit", "{}", 1, 1,
        memoryWriteMarker(admittedEnv),
      ).run();
    }

    const { matches } = await recallEntries(
      {
        query: "alpha beta",
        topK: 5,
        tag: "work",
        kind: "semantic",
        after: 900,
        before: 1100,
        hops: 1,
        synthesize: false,
      },
      admittedEnv,
      ctx,
    );

    expect(matches.map(match => match.id)).toEqual(["work-root", "z-eligible"]);
    expect(matches.every(match => match.tags.includes("work"))).toBe(true);
  });
});

/**
 * The route, end to end: a real HTTP request through the worker, against real SQLite,
 * asserting on the response body. `?tag=%` returning the whole brain is the case that
 * looks most like a valid answer and is therefore least likely to be noticed.
 */
describe("POST /list tag filter, end to end", () => {
  async function listed(tag: string): Promise<string[]> {
    const env = await seedEnv();
    const res = await worker.fetch(
      req("POST", `/list?n=100&tag=${encodeURIComponent(tag)}`),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }[]).map(r => r.id).sort();
  }

  it("does not reach a neighbouring tag through an underscore wildcard", async () => {
    expect(await listed("q3_planning")).toEqual(OWN);
  });

  it("does not return every entry for a percent tag", async () => {
    expect(await listed("%")).toEqual([]);
  });

  it("still returns the entries carrying an ordinary tag", async () => {
    expect(await listed("q3-planning")).toEqual(OTHER);
  });
});
