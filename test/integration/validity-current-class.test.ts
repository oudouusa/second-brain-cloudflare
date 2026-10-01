/**
 * Track 2 fix round (T-0089.2.1, spec 14 5.5): the rest of the review's reader class. Every queue or
 * answer that treats a row as live today must also treat a replaced or ended row as history.
 * Real SQLite; each test fails without its reader's validity predicate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityFromToken } from "../../src/lib/identity";
import { runStalenessPass } from "../../src/staleness/pass";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let ws = "";
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
const OLD = Date.now() - 400 * 86_400_000;

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  ws = (await ensureTenantBootstrap(env)).ownerPersonalWorkspaceId;
});
afterEach(async () => { await Promise.allSettled(pending.splice(0)); sqlite.close(); });

const seed = (id: string, tags: string[], validUntil: number | null, over: { source?: string; actor?: string; createdAt?: number; content?: string } = {}) =>
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, valid_until)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
  ).bind(id, over.content ?? `content ${id}`, JSON.stringify(tags), over.source ?? "api", over.createdAt ?? OLD, over.createdAt ?? OLD, ws, over.actor ?? "owner", validUntil).run();

describe("the rest of the current-reader class", () => {
  it("the insight review queue (GET /patterns) does not offer a replaced insight", async () => {
    await seed("ins-live", ["auto-insight"], null, { source: "system", actor: "" });
    await seed("ins-replaced", ["auto-insight"], OLD + 1000, { source: "system", actor: "" });
    const data = await (await worker.fetch(req("GET", "/patterns"), env, ctx)).json() as any;
    const ids = (data.patterns ?? data.entries ?? data.items ?? []).map((p: any) => p.id);
    expect(ids).toEqual(["ins-live"]);
  });

  it("the digest tool never returns an ended digest as the current summary", async () => {
    await seed("dig-ended", ["synthesized", "pricing"], OLD + 1000, { source: "system", actor: "", createdAt: OLD + 500, content: "Old summary" });
    const identity = (await resolveIdentityFromToken("test-token", env))!;
    const server = buildMcpServer(env, ctx, identity);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "class", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const r = await client.callTool({ name: "digest", arguments: { tag: "pricing" } });
    await client.close(); await server.close();
    expect(String((r.content as any[])[0].text)).toMatch(/^No digest yet/);
  });

  it("the nightly staleness pass spends no slot on a replaced row", async () => {
    await seed("fact-replaced", ["volatility:state"], OLD + 1000);
    await seed("fact-live", ["volatility:state"], null);
    await runStalenessPass(env, ctx);
    const tags = async (id: string) => JSON.parse(((await env.DB.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(id).first()) as any).tags);
    expect(await tags("fact-live")).toContain("stale:as-of");
    expect(await tags("fact-replaced")).not.toContain("stale:as-of");
    const checked = (await env.DB.prepare(`SELECT staleness_checked_at FROM entries WHERE id = 'fact-replaced'`).first()) as any;
    expect(checked.staleness_checked_at).toBeNull();
  });
});
