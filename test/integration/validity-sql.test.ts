/** Track 2 Task A2 (T-0089.2.1): validity predicates and the supersede batch on real SQLite. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { changesOf, Params } from "../../src/memory/versions";
import {
  currentValiditySql, validAtSql, planSupersede, supersedeStatements, type Window,
} from "../../src/memory/validity";
import { denseProblem } from "../helpers/sql-dense";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

let d1: SqliteD1;
let env: Env;
const change = { actorId: "u1", channel: "rest" as const };

beforeEach(async () => {
  resetDatabaseInit();
  d1 = makeSqliteD1();
  env = d1.admitEnv(makeTestEnv(undefined, { DB: d1.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
});
afterEach(() => d1.close());

const seed = (id: string, createdAt: number, validFrom: number | null, validUntil: number | null, over: { tags?: string[]; ws?: string } = {}) =>
  d1.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, valid_from, valid_until)
     VALUES (?, ?, ?, 'api', ?, '["v"]', ?, 'u1', ?, ?)`,
  ).bind(id, `content ${id}`, JSON.stringify(over.tags ?? []), createdAt, over.ws ?? "w", validFrom, validUntil).run();
const row = async (id: string) => (await d1.db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;
const versions = async (id: string) => (await d1.db.prepare(`SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results as any[];
const edges = async () => (await d1.db.prepare(`SELECT source_id, target_id, type, workspace_id FROM edges ORDER BY source_id`).all()).results as any[];

// 12 windows: [created_at, valid_from, valid_until]
const WINDOWS: [string, number, number | null, number | null][] = [
  ["open-default", 100, null, null],
  ["open-stated", 500, 100, null],
  ["closed-default", 100, null, 300],
  ["closed-stated", 500, 150, 300],
  ["empty", 100, null, 100],
  ["empty-stated", 500, 200, 200],
  ["late-told", 900, 50, 250],
  ["future-created", 400, null, null],
  ["ends-at-now", 100, null, 350],
  ["long", 10, 10, 1000],
  ["unknown-start", 900, 0, 200],
  ["starts-at-t", 300, null, null],
];
const INSTANTS = [50, 100, 250, 300, 350];

/** The truth table in JS: starts at or before T and ends after T. */
const trueAt = (w: typeof WINDOWS[number], t: number) => (w[2] ?? w[1]) <= t && (w[3] === null || w[3] > t);
const currentAt = (w: typeof WINDOWS[number], now: number) => w[3] === null || w[3] > now;

describe("validity predicates", () => {
  beforeEach(async () => { for (const w of WINDOWS) await seed(...w); });

  it("currentValiditySql and validAtSql select exactly the rows the truth table says", async () => {
    for (const t of INSTANTS) {
      for (const [name, pred, oracle] of [
        ["current", currentValiditySql, currentAt],
        ["validAt", validAtSql, trueAt],
      ] as const) {
        const p = new Params();
        const sql = `SELECT e.id FROM entries e WHERE ${pred(p, "e", t)} ORDER BY e.id`;
        expect(denseProblem(sql, p.values()), `${name} ${t}`).toBeNull();
        const got = ((await d1.db.prepare(sql).bind(...p.values()).all()).results as any[]).map(r => r.id);
        expect(got, `${name} at ${t}`).toEqual(WINDOWS.filter(w => oracle(w, t)).map(w => w[0]).sort());
      }
    }
  });

  it("a predicate reuses its placeholder inside a larger statement", () => {
    const p = new Params();
    p.add("x");
    const sql = `SELECT 1 FROM entries e WHERE e.id = ?1 AND ${validAtSql(p, "e", 7)} AND ${currentValiditySql(p, "e", 7)}`;
    expect(denseProblem(sql, p.values())).toBeNull();
    expect(p.values()).toEqual(["x", 7]);
  });
});

const win = async (id: string): Promise<Window> => {
  const r = await row(id);
  return { id, from: r.valid_from ?? r.created_at, until: r.valid_until, workspaceId: r.workspace_id, status: null };
};

describe("supersedeStatements", () => {
  it("close-older: one validity version on the older row, its window closed, the edge newer -> older, vectors kept", async () => {
    await seed("old", 100, null, null);
    await seed("new", 200, null, null);
    const older = await win("old");
    const newer = await win("new");
    const plan = planSupersede(older, newer);
    const res = await env.DB.batch(supersedeStatements(env, plan, older, newer, change, DEFAULTS));
    expect(res).toHaveLength(4);
    expect(await row("old")).toMatchObject({ valid_until: 200, vector_ids: '["v"]', tags: "[]" });
    const [v] = await versions("old");
    expect(v).toMatchObject({ reason: "validity", seq: 1, tags: "[]" });
    expect(JSON.parse(v.meta)).toEqual({ cause: "supersede", by: "new" });
    expect(JSON.parse(v.state)).toMatchObject({ valid_until: null });
    expect(await edges()).toEqual([{ source_id: "new", target_id: "old", type: "supersedes", workspace_id: "w" }]);
    expect(await versions("new")).toHaveLength(0);
  });

  it("close-newer: the late-told newcomer is closed at the older start and the edge points older -> newer", async () => {
    await seed("denver", 2024, null, null);
    await seed("boston", 3000, 2018, null);
    const older = await win("denver");
    const newer = await win("boston");
    const plan = planSupersede(older, newer);
    await env.DB.batch(supersedeStatements(env, plan, older, newer, change, DEFAULTS));
    expect(await row("boston")).toMatchObject({ valid_until: 2024 });
    expect(await row("denver")).toMatchObject({ valid_until: null });
    expect(await edges()).toEqual([{ source_id: "denver", target_id: "boston", type: "supersedes", workspace_id: "w" }]);
  });

  it("a supersede that loses its compare-and-set writes no version and no edge", async () => {
    await seed("old", 100, null, null);
    await seed("new", 200, null, null);
    const older = await win("old");
    const newer = await win("new");
    await d1.db.prepare(`UPDATE entries SET valid_until = 150 WHERE id = 'old'`).run(); // a racing write
    const stmts = supersedeStatements(env, planSupersede(older, newer), older, newer, change, DEFAULTS);
    const res = await env.DB.batch(stmts);
    expect(changesOf(res[1])).toBe(0);
    expect(await row("old")).toMatchObject({ valid_until: 150 });
    expect(await versions("old")).toHaveLength(0);
    expect(await edges()).toEqual([]);
  });

  it("never closes a deprecated row", async () => {
    await seed("old", 100, null, null, { tags: ["status:deprecated"] });
    await seed("new", 200, null, null);
    const older = await win("old");
    const newer = await win("new");
    await env.DB.batch(supersedeStatements(env, planSupersede(older, newer), older, newer, change, DEFAULTS));
    expect(await row("old")).toMatchObject({ valid_until: null });
    expect(await versions("old")).toHaveLength(0);
    expect(await edges()).toEqual([]);
  });

  it("is pinned to the window's workspace: a row that moved is left alone", async () => {
    await seed("old", 100, null, null);
    await seed("new", 200, null, null);
    const older = await win("old");
    const newer = await win("new");
    await d1.db.prepare(`UPDATE entries SET workspace_id = 'other' WHERE id = 'old'`).run();
    await env.DB.batch(supersedeStatements(env, planSupersede(older, newer), older, newer, change, DEFAULTS));
    expect(await row("old")).toMatchObject({ valid_until: null });
    expect(await versions("old")).toHaveLength(0);
    expect(await edges()).toEqual([]);
  });

  it("an extra guard (a system job's compare-and-set) gates the version, the update and the edge together", async () => {
    await seed("old", 100, null, null);
    await seed("new", 200, null, null);
    const older = await win("old");
    const newer = await win("new");
    const res = await env.DB.batch(supersedeStatements(env, planSupersede(older, newer), older, newer, change, DEFAULTS,
      p => `COALESCE(e.actor_id, '') = ${p.add("")}`));
    expect(changesOf(res[1])).toBe(0);
    expect(await versions("old")).toHaveLength(0);
    expect(await edges()).toEqual([]);
  });

  it("returns no statements for a plan of none", async () => {
    await seed("old", 100, null, 150);
    await seed("new", 200, null, null);
    const older = await win("old");
    const newer = await win("new");
    expect(supersedeStatements(env, planSupersede(older, newer), older, newer, change, DEFAULTS)).toEqual([]);
  });
});

import { currentValidityAt, SQL_NOW_MS } from "../../src/memory/validity";
describe("the current-validity predicate over the database clock", () => {
  it("selects the same rows as the bound form at the same moment, bare or aliased", async () => {
    const now = Date.now();
    await seed("past", 100, null, now - 60_000);
    await seed("future", 100, null, now + 3_600_000);
    await seed("open", 100, null, null);
    const bound = async () => {
      const p = new Params();
      return ((await d1.db.prepare(`SELECT e.id FROM entries e WHERE ${currentValiditySql(p, "e", now)} ORDER BY e.id`).bind(...p.values()).all()).results as any[]).map(r => r.id);
    };
    const clock = async (sql: string) => ((await d1.db.prepare(sql).all()).results as any[]).map(r => r.id);
    expect(await bound()).toEqual(["future", "open"]);
    expect(await clock(`SELECT id FROM entries WHERE ${currentValidityAt("", SQL_NOW_MS)} ORDER BY id`)).toEqual(["future", "open"]);
    expect(await clock(`SELECT e.id FROM entries e WHERE ${currentValidityAt("e", SQL_NOW_MS)} ORDER BY e.id`)).toEqual(["future", "open"]);
  });
});
