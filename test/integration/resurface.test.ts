/**
 * Resurface v2: GET /brief's "worth re-reading" pick.
 *
 * v1 picked the oldest-and-important memory blind to what it actually was,
 * and a live count against prod found it resurfacing a hotel stay two months
 * after the trip — a fact that was true then and means nothing now. v2 (1)
 * excludes episodic and finished-task rows from the pool, (2) prefers a
 * candidate sharing one of the brief's own top topic tags, and (3) remembers
 * what it has shown so the same memory does not repeat within a month and a
 * dismissed one never comes back.
 */
import { describe, it, expect, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { setDbReady } from "../../src/runtime/state";
import { resurfaceStateKey } from "../../src/runtime/resurface-state";
import { createProject } from "../../src/projects/registry";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; setDbReady(false); });

function dbOf(s: SqliteD1) {
  return {
    prepare: (sql: string) => s.db.prepare(sql),
    exec: (sql: string) => s.db.exec(sql),
    async batch(stmts: { run(): Promise<any> }[]) {
      const out: any[] = [];
      for (const st of stmts) out.push(await st.run());
      s.issued.splice(s.issued.length - stmts.length, stmts.length, `BATCH(${stmts.length})`);
      return out.map((r: any) => ({ ...r, meta: { changes: 1, ...r?.meta } }));
    },
  };
}

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  setDbReady(true);
  return s;
}

/** A stateful KV so same-day stability and dismissal can be tested across calls. */
function envWithKv(s: SqliteD1): Env {
  return s.admitEnv(makeTestEnv(dbOf(s) as any, { OAUTH_KV: makeMemoryKV() }));
}

/** Default (stateless) KV — every call reads as a first-ever request. */
function envOf(s: SqliteD1): Env {
  return makeTestEnv(dbOf(s) as any);
}

const DAY = 24 * 60 * 60 * 1000;
const OLD = 200 * DAY;

describe("GET /brief — resurface v2 exclusions", () => {
  it("never picks an episodic memory", async () => {
    sq = await migrated();
    sq.seed({ id: "ep", content: "Checked into the hotel", createdAt: Date.now() - OLD, importanceScore: 5, tags: ["kind:episodic"] });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.resurface).toBeNull();
  });

  it("never picks a finished task", async () => {
    sq = await migrated();
    sq.seed({ id: "done", content: "Follow up with the accountant", createdAt: Date.now() - OLD, importanceScore: 5, tags: ["task", "task:done"] });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.resurface).toBeNull();
  });

  it("still picks a plain old important memory", async () => {
    sq = await migrated();
    sq.seed({ id: "keep", content: "The pricing floor is $6k", createdAt: Date.now() - OLD, importanceScore: 5, tags: ["pricing"] });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.resurface?.id).toBe("keep");
  });
});

describe("GET /brief — topic preference", () => {
  it("prefers a candidate sharing this week's top topic over an older, plain one", async () => {
    sq = await migrated();
    const now = Date.now();
    // "signpath" is this week's topic: two recent captures carry it.
    sq.seed({ id: "recent-1", content: "Signpath work", createdAt: now - 1000, importanceScore: 1, tags: ["signpath"] });
    sq.seed({ id: "recent-2", content: "More signpath work", createdAt: now - 2000, importanceScore: 1, tags: ["signpath"] });
    // Two resurface candidates: one on-topic, one not. Both equally old/important.
    sq.seed({ id: "on-topic", content: "Signpath launch plan", createdAt: now - OLD, importanceScore: 5, tags: ["signpath"] });
    sq.seed({ id: "off-topic", content: "Unrelated old note", createdAt: now - OLD - 1, importanceScore: 5, tags: ["unrelated"] });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.resurface?.id).toBe("on-topic");
  });

  it("falls back to the full pool when nothing shares a top topic", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "recent-1", content: "Signpath work", createdAt: now - 1000, importanceScore: 1, tags: ["signpath"] });
    sq.seed({ id: "only-candidate", content: "An old important memory about something else", createdAt: now - OLD, importanceScore: 5, tags: ["gardening"] });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.resurface?.id).toBe("only-candidate");
  });
});

describe("GET /brief — same-day stability and rotation", () => {
  it("shows the same pick twice in one day", async () => {
    sq = await migrated();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      sq.seed({ id: `c${i}`, content: `Candidate ${i}`, createdAt: now - OLD - i, importanceScore: 5 });
    }
    const env = envWithKv(sq);

    const first = await (await worker.fetch(req("GET", "/brief"), env, ctx)).json() as any;
    const second = await (await worker.fetch(req("GET", "/brief"), env, ctx)).json() as any;

    expect(second.resurface?.id).toBe(first.resurface?.id);
  });

  // Cross-vendor review MAJOR (T-0102), finding 6(c): the same-day re-fetch had no held guard,
  // unlike pickResurface's own fresh-pick query (resurfaceFilter already carries NOT_HELD_SQL).
  it("never re-shows a pick that was held after it was first shown", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "only", content: "the secret plan is X", createdAt: now - OLD, importanceScore: 5 });
    const env = envWithKv(sq);

    const first = await (await worker.fetch(req("GET", "/brief"), env, ctx)).json() as any;
    expect(first.resurface?.id).toBe("only");

    sq.db.prepare(`UPDATE entries SET tags = ? WHERE id = 'only'`).bind(JSON.stringify(["quarantine:instruction", "status:draft"])).run();

    const second = await (await worker.fetch(req("GET", "/brief"), env, ctx)).json() as any;
    expect(second.resurface).toBeNull();
    expect(JSON.stringify(second)).not.toContain("secret plan");
  });

  // Cross-vendor review MINOR (T-0102), finding 8: the persisted resurface state is keyed by
  // workspace only, never by project, so a project-scoped pick (a narrower `scope`) would
  // overwrite the same slot the UNSCOPED brief's own same-day stability reads from.
  it("never persists a project-scoped pick, so it cannot corrupt the unscoped brief's own same-day pick", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "proj1", content: "a project memory", createdAt: now - OLD, importanceScore: 5, tags: ["project:site"] });
    const env = envWithKv(sq);
    const { ownerPersonalWorkspaceId } = await ensureTenantBootstrap(env);
    await createProject(env.DB, ownerPersonalWorkspaceId, { id: "site", name: "Site", aliases: [] }, env);

    const scoped1 = await (await worker.fetch(req("GET", "/brief?project=site"), env, ctx)).json() as any;
    expect(scoped1.resurface?.id).toBe("proj1");
    expect(await env.OAUTH_KV.get(resurfaceStateKey(ownerPersonalWorkspaceId))).toBeNull();

    const scoped2 = await (await worker.fetch(req("GET", "/brief?project=site"), env, ctx)).json() as any;
    expect(scoped2.resurface?.id).toBe("proj1");
    expect(await env.OAUTH_KV.get(resurfaceStateKey(ownerPersonalWorkspaceId))).toBeNull();

    // The unscoped brief still persists normally, unaffected by the project-scoped calls above.
    const unscoped = await (await worker.fetch(req("GET", "/brief"), env, ctx)).json() as any;
    expect(unscoped.resurface?.id).toBe("proj1");
    expect(await env.OAUTH_KV.get(resurfaceStateKey(ownerPersonalWorkspaceId))).not.toBeNull();
  });

  it("does not repeat a pick shown within the last 30 days", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "only", content: "The one candidate", createdAt: now - OLD, importanceScore: 5 });
    const kv = makeMemoryKV();
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv });
    const { ownerPersonalWorkspaceId } = await ensureTenantBootstrap(env);
    // Simulate yesterday having already shown "only".
    const yesterday = Math.floor((now - DAY) / DAY);
    await kv.put(
      resurfaceStateKey(ownerPersonalWorkspaceId),
      JSON.stringify({ day: yesterday, shownId: "only", recent: [{ id: "only", day: yesterday }], dismissed: [] }),
    );

    const data = await (await worker.fetch(req("GET", "/brief"), env, ctx)).json() as any;
    // "only" is excluded and there is no other candidate, so nothing is shown
    // rather than repeating the excluded pick.
    expect(data.resurface).toBeNull();
  });
});

describe("POST /resurface/dismiss", () => {
  it("requires auth", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/resurface/dismiss", { token: null, body: { id: "x" } }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("requires an id", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/resurface/dismiss", { body: {} }), envOf(sq), ctx);
    expect(res.status).toBe(400);
  });

  it("keeps a dismissed memory from ever being picked again", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "dismiss-me", content: "Never show this again", createdAt: now - OLD, importanceScore: 5 });
    const env = envWithKv(sq);

    const before = await (await worker.fetch(req("GET", "/brief"), env, ctx)).json() as any;
    expect(before.resurface?.id).toBe("dismiss-me");

    const dismissRes = await worker.fetch(req("POST", "/resurface/dismiss", { body: { id: "dismiss-me" } }), env, ctx);
    expect((await dismissRes.json() as any).ok).toBe(true);

    const after = await (await worker.fetch(req("GET", "/brief"), env, ctx)).json() as any;
    expect(after.resurface).toBeNull();
  });
});

describe("GET /brief?preview=1", () => {
  it("does not persist a fresh pick, so a repeat preview call can pick differently", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "solo", content: "The only candidate", createdAt: now - OLD, importanceScore: 5 });
    const kv = makeMemoryKV();
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv });
    const { ownerPersonalWorkspaceId } = await ensureTenantBootstrap(env);

    await worker.fetch(req("GET", "/brief?preview=1"), env, ctx);

    expect(await kv.get(resurfaceStateKey(ownerPersonalWorkspaceId))).toBeNull();
  });

  it("still reads existing state for same-day stability, it just never writes", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "pinned", content: "Pinned for today", createdAt: now - OLD, importanceScore: 5 });
    sq.seed({ id: "other", content: "Would be picked otherwise", createdAt: now - OLD - 1, importanceScore: 5 });
    const kv = makeMemoryKV();
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv });
    const { ownerPersonalWorkspaceId } = await ensureTenantBootstrap(env);
    const today = Math.floor(now / DAY);
    await kv.put(
      resurfaceStateKey(ownerPersonalWorkspaceId),
      JSON.stringify({ day: today, shownId: "pinned", recent: [{ id: "pinned", day: today }], dismissed: [] }),
    );

    const data = await (await worker.fetch(req("GET", "/brief?preview=1"), env, ctx)).json() as any;
    expect(data.resurface?.id).toBe("pinned");
  });
});

describe("GET /brief — a dismissed memory survives exclusion-list truncation", () => {
  // Regression for the adversarial review's defect 2: excludedIds() used to put
  // recently-shown ids AHEAD of dismissed ones, and the caller only binds so
  // many of the list into the pick query. After enough distinct daily picks, an
  // explicitly dismissed memory fell off the bound list entirely and could
  // resurface again — contradicting the documented "never comes back".
  it("stays excluded even with 25 more-recently-shown ids ahead of it in KV", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "dismissed-candidate", content: "Explicitly dismissed, must never return", createdAt: now - OLD, importanceScore: 5 });
    sq.seed({ id: "other-candidate", content: "The only memory left once the dismissal holds", createdAt: now - OLD - 1, importanceScore: 5 });

    const kv = makeMemoryKV();
    const env = makeTestEnv(dbOf(sq) as any, { OAUTH_KV: kv });
    const { ownerPersonalWorkspaceId } = await ensureTenantBootstrap(env);
    const today = Math.floor(now / DAY);
    // 25 days of prior picks (ids that are not real entries — only their
    // presence in `recent` matters), plus one dismissal from long before any
    // of them. Pre-fix ordering put these 25 ahead of the dismissal and this
    // whole list would then be sliced to a fixed cap, dropping it.
    const recent = Array.from({ length: 25 }, (_, i) => ({ id: `shown-${i}`, day: today - i }));
    await kv.put(
      resurfaceStateKey(ownerPersonalWorkspaceId),
      JSON.stringify({ day: -1, shownId: null, recent, dismissed: ["dismissed-candidate"] }),
    );

    const data = await (await worker.fetch(req("GET", "/brief"), env, ctx)).json() as any;

    expect(data.resurface?.id).toBe("other-candidate");
  });
});

describe("GET /brief — resurface pick query cost", () => {
  // Pins the 2-query branch (Task B's own budget note): a fresh pick with a
  // non-empty topic-preferred pool costs the preferred-pool COUNT probe plus
  // the pick itself, and nothing more. A third query sneaking into that
  // branch would be invisible to any test that only checks the response body.
  it("costs exactly one extra D1 query for the topic-preference probe, never a third", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "recent-1", content: "Signpath work", createdAt: now - 1000, importanceScore: 1, tags: ["signpath"] });
    sq.seed({ id: "recent-2", content: "More signpath work", createdAt: now - 2000, importanceScore: 1, tags: ["signpath"] });
    sq.seed({ id: "old-topic", content: "Old signpath decision", createdAt: now - OLD, importanceScore: 5, tags: ["signpath"] });

    const env = envOf(sq);
    await worker.fetch(req("GET", "/brief"), env, ctx); // warm identity/tenant-bootstrap cost
    sq.issued.length = 0;

    const res = await worker.fetch(req("GET", "/brief"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.resurface?.id).toBe("old-topic");

    // 7 parallel-batch reads (S2, T-0089.4.3: getChanges joined the same
    // Promise.all) + 1 identity batch + 2 resurface queries (probe, pick) =
    // 10. The default stateless KV mock means every call re-selects fresh
    // rather than hitting same-day stability, so this is the topic-
    // preferred branch on every request.
    expect(sq.issued).toHaveLength(10);
  });
});
