/**
 * rows_written per write on a real workerd D1 (local wrangler only, no Cloudflare account).
 * D1's free plan allows 100k rows written per day account-wide, and every partial index a row
 * belongs to adds one written row per insert, delete or indexed-column change. This measures
 * that cost per operation so a release can be compared with the one before it.
 * Opt in with EVAL_WORKERD=1; it prints a JSON table and only asserts sanity.
 */
import { describe, it, expect, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { openD1 } from "../eval/d1";
import { cleanTemp } from "../helpers/tmp";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { buildMcpServer } from "../../src/mcp/server";
import worker from "../../src/index";
import { req } from "../helpers/make-request";
import { setDbReady } from "../../src/runtime/state";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityFromToken } from "../../src/lib/identity";
import type { Env } from "../../src/env";

afterAll(cleanTemp);

let written = 0;
function metered(db: D1Database): D1Database {
  const wrapStmt = (s: any): any => new Proxy(s, { get(t, p) {
    if (p === "bind") return (...a: unknown[]) => wrapStmt(t.bind(...a));
    if (p === "all" || p === "run" || p === "raw") return async (...a: unknown[]) => { const r = await t[p](...a); written += r?.meta?.rows_written ?? 0; return r; };
    if (p === "first") return async (col?: string) => { const r = await t.all(); written += r.meta.rows_written ?? 0; const row = r.results[0] ?? null; return col && row ? row[col] : row; };
    return typeof t[p] === "function" ? t[p].bind(t) : t[p];
  } });
  return new Proxy(db, { get(t: any, p) {
    if (p === "prepare") return (sql: string) => wrapStmt(t.prepare(sql));
    if (p === "batch") return async (stmts: any[]) => { const rs = await t.batch(stmts); for (const r of rs) written += r?.meta?.rows_written ?? 0; return rs; };
    return typeof t[p] === "function" ? t[p].bind(t) : t[p];
  } });
}

describe.runIf(process.env.EVAL_WORKERD === "1")("write amplification on workerd", () => {
  it("rows_written per operation", async () => {
    const d1 = await openD1("workerd");
    try {
      resetDatabaseInit();
      const raw = makeTestEnv(undefined, { DB: d1.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
      await initializeDatabase(raw);
      await ensureTenantBootstrap(raw);
      const identity = (await resolveIdentityFromToken("test-token", raw))!;
      const ws = identity.personalWorkspaceId;
      const N = 2000, now = Date.now();
      await d1.db.prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, recall_count, importance_score, workspace_id, actor_id, when_at, when_kind, when_source)
        WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ?)
        SELECT 'e'||x, 'memory '||x,
               CASE WHEN x % 20 = 0 THEN '["task","work"]' WHEN x % 50 = 1 THEN '["auto-insight"]' WHEN x % 100 = 2 THEN '["work","stale:as-of"]' ELSE '["work","kind:semantic"]' END,
               'api', ? - x * 3600000, '["v"]', 0, 3, ?, ?,
               CASE WHEN x % 200 = 0 THEN ? + 3600000 ELSE NULL END, CASE WHEN x % 200 = 0 THEN 'due' ELSE NULL END, CASE WHEN x % 200 = 0 THEN 'explicit' ELSE NULL END
        FROM c`).bind(N, now, ws, identity.userId, now).run();

      const env = makeTestEnv(undefined, { DB: metered(d1.db) as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
      const pending: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
      const mcp = async (name: string, args: Record<string, unknown>) => {
        const server = buildMcpServer(env, ctx, identity);
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "wa", version: "1" });
        await Promise.all([client.connect(ct), server.connect(st)]);
        try { const r = await client.callTool({ name, arguments: args }); return String((r.content as { text?: string }[])[0]?.text ?? ""); }
        finally { await client.close(); await server.close(); }
      };
      const measure = async (run: () => Promise<unknown>) => { written = 0; await run(); await Promise.all(pending.splice(0)); return written; };
      const mean = async (n: number, run: (i: number) => Promise<unknown>) => {
        const xs: number[] = [];
        for (let i = 0; i < n; i++) xs.push(await measure(() => run(i)));
        return { mean: xs.reduce((a, b) => a + b, 0) / n, min: Math.min(...xs), max: Math.max(...xs) };
      };
      const sql = (q: string, ...b: unknown[]) => env.DB.prepare(q).bind(...b).run();

      // warm the one-time paths (config reads, init probes) so they are not billed to the first sample
      await measure(() => mcp("remember", { content: "warm up capture note zero", tags: ["work"] }));
      const table: Record<string, unknown> = {};
      table.capture_plain = await mean(10, i => mcp("remember", { content: `Plain note ${i} about the garden fence repair`, tags: ["work"] }));
      table.capture_task = await mean(10, i => mcp("remember", { content: `I need to send report number ${i} to the accountant`, tags: ["task", "work"] }));
      table.capture_dated = await mean(10, i => mcp("remember", { content: `Dentist appointment number ${i} on 2030-05-01 at 10:00`, tags: ["work"] }));
      const dated = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM entries WHERE content LIKE 'Dentist appointment%' AND when_at IS NOT NULL`).first<{ n: number }>())!.n;
      table.update_content_plain = await mean(10, i => mcp("update", { id: `e${3 + i * 7}`, content: `Rewritten memory ${i} with new wording` }));
      table.set_status_plain = await mean(10, i => mcp("set_status", { id: `e${4 + i * 7}`, status: "canonical" }));
      // what resolve done / not_a_task / snooze / clear_date write: one UPDATE of tags or when_at
      table.tag_change_task_done = await mean(10, i => sql(`UPDATE entries SET tags = ? WHERE id = ?`, '["task","task:done","work"]', `e${20 * (i + 1)}`));
      table.tag_change_plain_row = await mean(10, i => sql(`UPDATE entries SET tags = ? WHERE id = ?`, '["work","kind:semantic","extra"]', `e${5 + i * 11}`));
      table.when_at_change = await mean(5, i => sql(`UPDATE entries SET when_at = ? WHERE id = ?`, now + 86400000, `e${200 * (i + 1)}`));
      // the real resolve paths, audit events included (REST exists on both trees, the MCP tool only on 4.0)
      setDbReady(true);
      const restResolve = async (path: string, body: unknown) => { const res = await worker.fetch(req("POST", path, { body }), env, ctx); expect(res.status).toBe(200); };
      table.rest_loops_resolve_done = await mean(5, i => restResolve("/loops/resolve", { id: `e${20 * (i + 20)}`, action: "done" }));
      table.rest_due_snooze = await mean(5, i => restResolve("/due/snooze", { id: `e${200 * (i + 6)}`, until: new Date(now + 5 * 86400000).toISOString() }));
      if ((await mcp("resolve", { id: "e2000", action: "done" })).startsWith("Resolved")) {
        table.mcp_resolve_done = await mean(5, i => mcp("resolve", { id: `e${20 * (i + 30)}`, action: "done" }));
      }
      console.log(`WRITE_AMPLIFICATION ${JSON.stringify({ datedCaptureRowsWithWhenAt: dated, ...table })}`);
      for (const v of Object.values(table)) expect((v as { mean: number }).mean).toBeGreaterThan(0);
    } finally { await d1.close(); }
  }, 300_000);
});
