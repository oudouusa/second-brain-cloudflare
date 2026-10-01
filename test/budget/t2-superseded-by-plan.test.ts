/**
 * Budget auditor (brief 19), Track 2 time core. GET /list, GET /entry, list_recent, get and recall hydration return a
 * `superseded_by` computed by a correlated subquery per returned row. With `ORDER BY s.created_at DESC LIMIT 1` and
 * `s.workspace_id = entries.workspace_id`, SQLite drives it from idx_entries_workspace_created and walks the whole
 * workspace for every row that has no superseding fact: measured on workerd at 3e5961b7, GET /list?n=50 reads
 * 100,135 rows at 2k memories and 500,135 at 10k (release 132 and 135), and a topK-10 recall 29,151 and 133,551
 * (release 9,151 and 33,551). The lookup must start from edges (idx_edges_target) and fetch `s` by primary key.
 * The as-of belief read (T2-B, src/recall/as-of.ts) repeated the pattern: 20,008 rows at 10k memories for one
 * as-of recall on workerd at 936bf372, against 1,306 for the same recall without as_of.
 * Requires the valid_until column; skipped before Track 2.
 */
import { afterEach, describe, expect, it } from "vitest";

let close: (() => void) | undefined;
afterEach(() => close?.());

describe("the superseded_by lookup starts from edges, never from the workspace index", () => {
  it("GET /list and recall hydration plans", async () => {
    const { makeTrashEnv } = await import("../helpers/trash-env");
    const worker = (await import("../../src/index")).default;
    const t = await makeTrashEnv();
    close = () => t.close();
    const cols = await t.env.DB.prepare(`SELECT name FROM pragma_table_info('entries')`).all();
    if (!(cols.results as { name: string }[]).some(c => c.name === "valid_until")) return;
    for (let i = 0; i < 500; i++) t.seed(`f${i}`, { content: `memory ${i} about the atlas ledger`, created_at: 100 + i, vector_ids: `["f${i}"]` });

    const captured: { sql: string; args: unknown[] }[] = [];
    const db = t.env.DB as any;
    const prepare = db.prepare.bind(db);
    const wrap = (s: any, sql: string): any => new Proxy(s, { get(target, p) {
      if (p === "bind") return (...a: unknown[]) => { captured.push({ sql, args: a }); return wrap(target.bind(...a), sql); };
      if (p === "__inner") return target;
      const v = target[p]; return typeof v === "function" ? v.bind(target) : v;
    } });
    const env = { ...t.env, DB: { prepare: (sql: string) => wrap(prepare(sql), sql), batch: (s: any[]) => db.batch(s.map((x: any) => x.__inner ?? x)), exec: (q: string) => db.exec(q) } } as any;
    const today = new Date().toISOString().slice(0, 10);
    for (const p of ["/list?n=50", "/recall?query=atlas+ledger&topK=10&synthesize=0", `/recall?query=atlas+ledger&topK=10&synthesize=0&as_of=${today}`]) {
      const params = new URL(`http://localhost${p}`).searchParams;
      const isRecall = p.startsWith("/recall");
      const res = await worker.fetch(new Request(`http://localhost${isRecall ? "/recall" : p}`, {
        method: isRecall ? "POST" : "GET", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        ...(isRecall ? { body: JSON.stringify({ query: params.get("query"), topK: 10, synthesize: false,
          ...(params.has("as_of") ? { as_of: params.get("as_of") } : {}) }) } : {}),
      }), env, { waitUntil: () => {} } as any);
      expect(res.status).toBe(200);

    }
    // Every statement that joins the supersedes edges to entries (the superseded_by readers and, since T2-B B3/B4,
    // the as-of belief read in src/recall/as-of.ts) must start from edges.
    const lookups = captured.filter(c => /supersedes/.test(c.sql) && /\bentries\b/.test(c.sql) && /\bedges\b/.test(c.sql));
    expect(lookups.length, "statements carrying the superseded_by lookup").toBeGreaterThanOrEqual(2);
    const bad: string[] = [];
    for (const { sql, args } of lookups) {
      const plan = ((await prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args.map(a => (a === undefined ? null : a))).all()).results as { detail: string }[]).map(r => r.detail);
      if (plan.some(d => /^SEARCH s USING INDEX idx_entries_workspace_created/.test(d))) bad.push(`${plan.join(" ; ")}  <=  ${sql.replace(/\s+/g, " ").slice(0, 80)}`);
    }
    expect(bad).toEqual([]);
  }, 60_000);
});
