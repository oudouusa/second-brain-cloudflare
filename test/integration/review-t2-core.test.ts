/**
 * Cross-vendor adversarial review of Track 2 core (57583d10..3e5961b7, lanes A1-A5, B1/B2/B5).
 * Each test reproduces one defect found in that diff; every test here FAILS against 3e5961b7.
 * Real SQLite throughout: the subjects are the SQL predicates themselves.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { standingKvKey, standingTouched } from "../../src/standing/cache";
import { parseStandingCache } from "../../src/standing/codec";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let workspaceId = "";
let pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;

beforeEach(async () => {
  resetDatabaseInit();
  pending = [];
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  workspaceId = roots.ownerPersonalWorkspaceId;
});
afterEach(async () => { await Promise.allSettled(pending); sqlite.close(); });

const seed = (id: string, tags: string[], validUntil: number | null, vectorIds: string = "[]") =>
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, valid_until)
     VALUES (?, ?, ?, 'api', 5000, ?, ?, 'owner', ?)`,
  ).bind(id, `content ${id}`, JSON.stringify(tags), vectorIds, workspaceId, validUntil).run();

describe("a replaced fact in the stale-review queue", () => {
  it("GET /stale and the brief's stale count must not ask about a row whose window already closed", async () => {
    // "stale:as-of" asks a person to re-verify a claim. A superseded row keeps its tags
    // (D2.1: history, not wrong), so without a validity predicate STALE_REVIEW_SQL — which
    // excludes deprecated rows precisely because re-verifying retired rows is make-work
    // (src/memory/stale.ts:12-13) — still queues a fact the brain already knows ended.
    seed("ended-stale", ["stale:as-of"], 4000); // closed before now
    seed("live-stale", ["stale:as-of"], null);

    const res = await worker.fetch(req("GET", "/stale"), env, ctx);
    const data = await res.json() as any;
    expect(data.entries.map((e: any) => e.id)).toEqual(["live-stale"]);
    expect(data.total).toBe(1);
  });
});

describe("a replaced standing instruction in the cache build", () => {
  it("buildStandingCache must not cache a standing:active row whose window closed", async () => {
    // The cache build (src/standing/cache.ts) filters deprecated/conflict-held/quarantine but
    // has no validity predicate: a standing instruction superseded by a newer capture
    // (valid_until set in the past) is cached and keeps firing once the recall fire path reads
    // the cache — the one reader class spec 14 5.5 says must never show a replaced fact.
    seed("s-live", ["standing:active"], null, '["c-live"]');
    seed("s-ended", ["standing:active"], 4000, '["c-ended"]');

    const cfg = { STANDING_MAX: 50, EMBEDDING_DIM: 384, EMBEDDING_MODEL: DEFAULTS.EMBEDDING_MODEL };
    const vec = new Array(384).fill(0.01);
    standingTouched(env, ctx, cfg, [workspaceId], [
      { id: "s-live", vector: vec },
      { id: "s-ended", vector: vec },
    ]);
    await Promise.all(pending);

    const raw = await env.OAUTH_KV.get(standingKvKey(workspaceId), "json");
    // This branch's makeMemoryKV predates KV "json" parsing (a T7-C addition): it returns the raw string.
    const cache = parseStandingCache(typeof raw === "string" ? JSON.parse(raw) : raw, { model: cfg.EMBEDDING_MODEL, dim: cfg.EMBEDDING_DIM });
    expect(cache?.items.map(i => i.id).sort()).toEqual(["s-live"]);
  });
});

describe("import bypasses P5 (no future stated starts)", () => {
  it("POST /import must drop a future valid_from like any other malformed window", async () => {
    // importedWindow (src/entries/import.ts) drops inverted and non-numeric windows but accepts
    // a valid_from in the future — the one thing parseValidityDate refuses every typed writer
    // (P5). currentValiditySql never checks the start ("stated starts are never in the future"),
    // so the imported row reads as current everywhere while claiming it only becomes true next year.
    const future = Date.now() + 365 * 86400000;
    const res = await worker.fetch(req("POST", "/import", {
      body: { entries: [{ id: "from-future", content: "a fact", created_at: 1000, valid_from: future }] },
    }), env, ctx);
    const body = await res.json() as any;
    expect(body).toMatchObject({ ok: true, imported: 1 });
    const row = await env.DB.prepare(`SELECT valid_from FROM entries WHERE id = 'from-future'`).first() as any;
    expect(row.valid_from).toBeNull();
  });
});
