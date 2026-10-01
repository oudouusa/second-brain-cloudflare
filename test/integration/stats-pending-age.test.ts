import { describe, it, expect } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";

describe("索引待ちの最古日時", () => {
  it("猶予期間・索引済み・廃止済みを除き、待ちがなければnull", async () => {
    const sqlite = makeSqliteD1();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
    const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: makeMemoryKV() });
    const now = Date.now();
    const stats = async () => {
      const res = await worker.fetch(req("GET", "/stats"), env, ctx);
      expect(res.status).toBe(200);
      return await res.json() as { unvectorized: number; oldest_unvectorized_at: number | null };
    };
    try {
      sqlite.seed({ id: "fresh", content: "猶予期間", createdAt: now });
      sqlite.seed({ id: "indexed", content: "索引済み", createdAt: now - 9000000, vectorIds: ["indexed"] });
      sqlite.seed({ id: "deprecated", content: "廃止済み", createdAt: now - 9000000, tags: ["status:deprecated"] });
      expect(await stats()).toMatchObject({ unvectorized: 0, oldest_unvectorized_at: null });
      sqlite.seed({ id: "oldest", content: "回復待ち", createdAt: now - 7200000 });
      sqlite.seed({ id: "newer", content: "回復待ち", createdAt: now - 3600000 });
      expect(await stats()).toMatchObject({ unvectorized: 2, oldest_unvectorized_at: now - 7200000 });
    } finally {
      await Promise.allSettled(pending);
      sqlite.close();
    }
  });
});
