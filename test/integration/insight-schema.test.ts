import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { initializeDatabase } from "../../src/db/init";

describe("insight_candidates schema", () => {
  it("is created on a brain that has never seen it", async () => {
    const sqlite = makeSqliteD1({ schema: false });
    const env = { DB: sqlite.db } as any;
    await initializeDatabase(env);

    const row = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='insight_candidates'`,
    ).first() as { name?: string } | null;
    expect(row?.name).toBe("insight_candidates");
    sqlite.close();
  });

  it("is present in the checked-in schema too", async () => {
    // schema: true applies db/schema.sql. If the two ever drift, this fails
    // while the test above still passes — which is the drift worth catching.
    const sqlite = makeSqliteD1();
    const row = await sqlite.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='insight_candidates'`,
    ).first() as { name?: string } | null;
    expect(row?.name).toBe("insight_candidates");
    sqlite.close();
  });

  it("rejects the same pair twice", async () => {
    const sqlite = makeSqliteD1();

    const insert = (id: string) => sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES (?, 'a', 'b', 0.9, 1, 1.0, 'vector', 'pending', 1)`,
    ).bind(id).run();

    await insert("one");
    await expect(insert("two")).rejects.toThrow();
    sqlite.close();
  });
});

describe("sqlite-d1 facade batch()", () => {
  // test/helpers/sqlite-d1.ts itself is not a *.test.ts file, so vitest's
  // default include glob never collects tests written inside it — this lives
  // here instead, exercising the facade the same way the schema tests above
  // do, against the table this task adds.
  it("counts every statement inside a batch as a D1 query", async () => {
    const sqlite = makeSqliteD1();
    const before = sqlite.issued.length;
    await sqlite.db.batch([
      sqlite.db.prepare(`INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at) VALUES ('x', 'a', 'b', 1, 1, 1, 'vector', 'pending', 1)`),
      sqlite.db.prepare(`INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at) VALUES ('y', 'c', 'd', 1, 1, 1, 'vector', 'pending', 1)`),
    ]);
    expect(sqlite.issued.length - before).toBe(2);
    sqlite.close();
  });
});
