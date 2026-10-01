import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../src/env";
import { runGraphPass } from "../../src/graph/pass";
import { EDGE_INFERENCE_POLICY } from "../../src/graph/edges";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { beginMemoryWriteAdmission } from "../../src/migration/write-lock";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";

const key = (workspace: string) => `graph:refresh-cursor:${JSON.stringify([EDGE_INFERENCE_POLICY, workspace])}`;
async function fixture(ties = false) {
  const sq = makeSqliteD1(); const kv = makeMemoryKV();
  await initializeDatabase(makeTestEnv(undefined, { DB: sq.db as unknown as D1Database, OAUTH_KV: kv }));
  for (let i = 0; i < 12; i++) sq.seed({ id: `m-${String(i).padStart(2, "0")}`, content: `Unique memory ${i}`,
    tags: ["topic-a"], createdAt: ties ? 1000 : 1000 + i });
  const visits: string[] = [];
  const wrap = (stmt: any, q: string): any => ({
    bind: (...args: any[]) => wrap(stmt.bind(...args), q),
    all: async () => {
      const result = await stmt.all();
      if (q.startsWith("SELECT e.id, e.content, e.created_at")) visits.push(...result.results.map((e: any) => e.id));
      return result;
    },
    first: (...args: any[]) => stmt.first(...args), run: () => stmt.run(), __inner: stmt,
  });
  const DB = { prepare: (q: string) => wrap(sq.db.prepare(q), q.trim()), exec: (q: string) => sq.db.exec(q),
    batch: (stmts: any[]) => sq.db.batch(stmts.map(s => s.__inner)) } as unknown as D1Database;
  const vectorize = makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [] }) });
  const env = makeTestEnv(undefined, { DB, OAUTH_KV: kv, VECTORIZE: vectorize });
  const run = async (workspace: string | null = "") => {
    visits.length = 0; const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
    const admitted = await beginMemoryWriteAdmission(env, ctx);
    try { return { result: await runGraphPass(admitted.env, admitted.ctx, workspace, 4), visits }; }
    finally { await admitted.finish(); while (pending.length) await Promise.allSettled(pending.splice(0)); }
  };
  return { sq, kv, env, vectorize, run };
}

beforeEach(() => { resetDatabaseInit(); vi.restoreAllMocks(); });
afterEach(() => { resetDatabaseInit(); vi.restoreAllMocks(); });

describe("workspace graph keyset scan", () => {
  it.each([null, ""])("保留行を埋込み・近傍queryへ渡さない（workspace=%s）", async workspace => {
    const f = await fixture();
    try {
      await f.sq.db.prepare("UPDATE entries SET tags = ? WHERE id LIKE 'm-%'")
        .bind('["quarantine:instruction","status:draft"]').run();
      await f.run(workspace);
      expect(f.env.AI.run).not.toHaveBeenCalled();
      expect(f.vectorize.query).not.toHaveBeenCalled();
    } finally { f.sq.close(); }
  });
  it.each([false, true])("visits all 12 no-neighbor memories in three passes and wraps, ties=%s", async ties => {
    const f = await fixture(ties);
    try {
      const all: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await f.run(); expect(r.result).toEqual({ inserted: 0 });
        expect(r.visits).toHaveLength(4); all.push(...r.visits);
      }
      expect(new Set(all).size).toBe(12);
      expect((await f.run()).visits).toEqual(all.slice(0, 4));
      const rows = f.sq.rows(); expect(rows).toHaveLength(12);
      expect(rows.every(r => r.content === `Unique memory ${Number(String(r.id).slice(2))}`)).toBe(true);
    } finally { f.sq.close(); }
  });

  it("keeps workspace cursors and candidate rows separate", async () => {
    const f = await fixture(true);
    try {
      await f.sq.db.prepare("UPDATE entries SET workspace_id = ? WHERE id < ?").bind("ws-other", "m-06").run();
      const a = [...(await f.run()).visits]; const b = [...(await f.run("ws-other")).visits];
      expect(a).toEqual(["m-11", "m-10", "m-09", "m-08"]);
      expect(b).toEqual(["m-05", "m-04", "m-03", "m-02"]);
      expect((await f.run()).visits).toEqual(["m-07", "m-06"]);
      expect(await f.kv.get(key(""))).not.toEqual(await f.kv.get(key("ws-other")));
    } finally { f.sq.close(); }
  });

  it("keeps moving past failed candidates and revisits them after wrap", async () => {
    const f = await fixture();
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(f.vectorize.query).mockRejectedValueOnce(new Error("synthetic failure"));
      const first = [...(await f.run()).visits];
      expect((await f.run()).visits).not.toEqual(first);
      await f.run(); expect((await f.run()).visits).toEqual(first);
    } finally { f.sq.close(); }
  });

  it("does not need the cursor row to still exist and sees edits/new rows after wrap", async () => {
    const f = await fixture();
    try {
      await f.run();
      await f.sq.db.batch([
        f.sq.db.prepare("UPDATE entries SET write_marker = ? WHERE id = ?").bind(f.sq.fixtureMarker("delete"), "m-08"),
        f.sq.db.prepare("DELETE FROM entries WHERE id = ?").bind("m-08"),
      ]);
      await f.sq.db.prepare("UPDATE entries SET content = ? WHERE id = ?").bind("Edited later", "m-11").run();
      f.sq.seed({ id: "m-new", content: "New later memory", tags: ["topic-a"], createdAt: 2000 });
      expect((await f.run()).visits).toEqual(["m-07", "m-06", "m-05", "m-04"]);
      await f.run();
      const wrapped = (await f.run()).visits;
      expect(wrapped).toContain("m-new"); expect(wrapped).toContain("m-11");
    } finally { f.sq.close(); }
  });

  it.each(["{", "null", "[]", '{"createdAt":"1000","id":"m-04"}', '{"createdAt":1000,"id":""}'])(
    "starts safely from the head on invalid cursor %s", async raw => {
      const f = await fixture();
      try {
        vi.spyOn(console, "error").mockImplementation(() => {});
        await f.kv.put(key(""), raw);
        expect((await f.run()).visits).toEqual(["m-11", "m-10", "m-09", "m-08"]);
      } finally { f.sq.close(); }
    });

  it("KV cursor failure never fabricates links or drops memory rows", async () => {
    const f = await fixture();
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const get = f.kv.get.bind(f.kv); const put = f.kv.put.bind(f.kv);
      vi.spyOn(f.kv, "get").mockImplementation(((k: string, ...args: any[]) => {
        if (k.startsWith("graph:refresh-cursor:")) return Promise.reject(new Error("private KV failure"));
        return (get as any)(k, ...args);
      }) as any);
      vi.spyOn(f.kv, "put").mockImplementation(((k: string, ...args: any[]) => {
        if (k.startsWith("graph:refresh-cursor:")) return Promise.reject(new Error("private KV failure"));
        return (put as any)(k, ...args);
      }) as any);
      expect((await f.run()).result).toEqual({ inserted: 0 }); expect(f.sq.rows()).toHaveLength(12);
    } finally { f.sq.close(); }
  });
});
