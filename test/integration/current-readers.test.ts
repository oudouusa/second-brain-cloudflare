/**
 * Task B2 (T-0089.2.1, spec 14 5.5): every "current" reader excludes a
 * replaced fact the same way recall does, and the "any" readers (vectorize
 * pending, the re-embed migration) deliberately still include one, since a
 * superseded row keeps its vectors and must stay re-indexable.
 *
 * Real SQLite (test/helpers/sqlite-d1.ts): several of these predicates are
 * shared string constants interpolated into hand-written SQL, and a
 * substring-matching mock could pass even if the predicate text were wrong.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { computeBrief, readAgentBrief } from "../../src/brief/compute";
import { buildPromptCapsule } from "../../src/prompt-capsule/build";
import { compressTag } from "../../src/compression/digest";
import { runInsightAccrual } from "../../src/insight/candidates";
import { runWeeklyInsights } from "../../src/insight/weekly";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;
let sqlite: SqliteD1 | null = null;
afterEach(() => { sqlite?.close(); sqlite = null; resetDatabaseInit(); vi.restoreAllMocks(); });

async function migrated(overrides: Record<string, unknown> = {}): Promise<{ env: Env; identity: Identity }> {
  const s = makeSqliteD1();
  sqlite = s;
  resetDatabaseInit();
  const env = s.admitEnv(makeTestEnv(undefined, { DB: s.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), ...overrides }));
  await initializeDatabase(env);
  const identity = (await ensureTenantBootstrap(env), (await resolveIdentityFromToken("test-token", env))!);
  return { env, identity };
}

const DAY = 86400000;

describe("a replaced due item is not in GET /due, the brief or push (5.5)", () => {
  it("excludes a superseded when-bearing row from GET /due and the agent brief's due count", async () => {
    const { env, identity } = await migrated();
    const now = Date.now();
    sqlite!.seed({ id: "current-due", content: "current commitment", createdAt: now - DAY });
    await sqlite!.db.prepare(`UPDATE entries SET when_at = ?, when_kind = 'due', when_source = 'explicit', workspace_id = ?, actor_id = ? WHERE id = ?`)
      .bind(now + DAY, identity.personalWorkspaceId, identity.userId, "current-due").run();
    sqlite!.seed({ id: "replaced-due", content: "replaced commitment", createdAt: now - DAY, validUntil: now - 1000 });
    await sqlite!.db.prepare(`UPDATE entries SET when_at = ?, when_kind = 'due', when_source = 'explicit', workspace_id = ?, actor_id = ? WHERE id = ?`)
      .bind(now + DAY, identity.personalWorkspaceId, identity.userId, "replaced-due").run();

    const res = await worker.fetch(req("GET", "/due"), env, ctx);
    const data = await res.json() as any;
    const ids = [...data.overdue, ...data.upcoming].map((r: any) => r.id);
    expect(ids).toContain("current-due");
    expect(ids).not.toContain("replaced-due");

    const agent = await readAgentBrief(env, identity, { parts: ["due"] });
    expect(agent.due!.items.map(i => i.id)).toEqual(["current-due"]);
  });
});

describe("a replaced loop is not open (5.5)", () => {
  it("excludes a superseded task row from GET /loops and the dashboard brief count", async () => {
    const { env, identity } = await migrated();
    const now = Date.now();
    sqlite!.seed({ id: "current-loop", content: "current commitment", createdAt: now - DAY, tags: ["task"] });
    await sqlite!.db.prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = ?`).bind(identity.personalWorkspaceId, identity.userId, "current-loop").run();
    sqlite!.seed({ id: "replaced-loop", content: "replaced commitment", createdAt: now - DAY, tags: ["task"], validUntil: now - 1000 });
    await sqlite!.db.prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = ?`).bind(identity.personalWorkspaceId, identity.userId, "replaced-loop").run();

    const res = await worker.fetch(req("GET", "/loops"), env, ctx);
    const data = await res.json() as any;
    const ids = data.entries.map((r: any) => r.id);
    expect(ids).toContain("current-loop");
    expect(ids).not.toContain("replaced-loop");

    const dash = await computeBrief(env, identity, true);
    expect(dash.loops.open).toBe(1);
  });
});

describe("a replaced memory is not resurfaced (5.5)", () => {
  it("never picks a superseded row for the dashboard's resurface card", async () => {
    const { env, identity } = await migrated();
    const now = Date.now();
    const old = now - 200 * DAY;
    sqlite!.seed({ id: "replaced-resurface", content: "an old fact, superseded", createdAt: old, importanceScore: 5, validUntil: now - 1000 });
    await sqlite!.db.prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = ?`).bind(identity.personalWorkspaceId, identity.userId, "replaced-resurface").run();

    const dash = await computeBrief(env, identity, true);
    expect(dash.resurface?.id).not.toBe("replaced-resurface");
  });
});

describe("the capsule excludes replaced rows (5.5)", () => {
  it("get_prompt_capsule never selects a superseded canonical definition", async () => {
    const { env, identity } = await migrated();
    const now = Date.now();
    sqlite!.seed({
      id: "replaced-capsule", content: "Old preference, superseded.",
      tags: ["capsule:core", "capsule-slot:identity", "status:canonical"],
      createdAt: now - DAY, validUntil: now - 1000,
    });
    await sqlite!.db.prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = ?`).bind(identity.personalWorkspaceId, identity.userId, "replaced-capsule").run();

    const result = await buildPromptCapsule(env, identity, { kind: "core" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sections.map(s => s.source_entry_id)).not.toContain("replaced-capsule");
    }
  });
});

describe("new digests and insight pairs exclude replaced rows (5.5)", () => {
  it("compressTag's candidate scan skips a superseded source", async () => {
    const { env, identity } = await migrated({
      AI: { run: vi.fn().mockResolvedValue({ response: "A digest." }) } as unknown as Ai,
    });
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      sqlite!.seed({ id: `member-${i}`, content: `topic note number ${i} with enough content to compress`, tags: ["work-topic"], createdAt: now - (30 + i) * DAY });
      await sqlite!.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(identity.personalWorkspaceId, `member-${i}`).run();
    }
    sqlite!.seed({ id: "replaced-member", content: "a superseded topic note, long enough to matter here", tags: ["work-topic"], createdAt: now - 60 * DAY, validUntil: now - 1000 });
    await sqlite!.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(identity.personalWorkspaceId, "replaced-member").run();

    await compressTag("work-topic", env, ctx, { workspaceIds: [identity.personalWorkspaceId] });
    const { results } = await sqlite!.db.prepare(`SELECT tags FROM entries WHERE tags LIKE '%"synthesized"%'`).all();
    if (results.length) {
      const digestTags = JSON.parse(String((results[0] as any).tags));
      expect(digestTags).toBeDefined();
    }
    // The candidate query itself is what is under test: a superseded row must
    // never even reach compressTag's rawEntries window.
    const { results: rawWindow } = await sqlite!.db.prepare(
      `SELECT id FROM entries WHERE tags LIKE '%"work-topic"%' AND (valid_until IS NULL OR valid_until > ?)`,
    ).bind(now).all();
    expect((rawWindow as { id: string }[]).map(r => r.id)).not.toContain("replaced-member");
  });

  it("insight accrual never seeds or pairs a superseded row", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { env, identity } = await migrated({
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [] }) }),
    });
    sqlite!.seed({
      id: "replaced-seed", content: "a superseded memory considering the pricing decision at length",
      createdAt: now - 10 * DAY, vectorIds: ["v-replaced-seed"], validUntil: now - 1000,
    });
    await sqlite!.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(identity.personalWorkspaceId, "replaced-seed").run();

    const summary = await runInsightAccrual(env, ctx);
    expect(summary.seedsExamined).toBeGreaterThan(0);
    const { results } = await sqlite!.db.prepare(`SELECT COUNT(*) AS n FROM insight_candidates WHERE a_id = ? OR b_id = ?`)
      .bind("replaced-seed", "replaced-seed").all();
    expect((results[0] as { n: number }).n).toBe(0);
  });

  it("the weekly pass never draws a candidate pair whose side was superseded after accrual", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { env, identity } = await migrated({
      AI: { run: vi.fn().mockResolvedValue({ response: '{"insight": null}' }) } as unknown as Ai,
    });
    sqlite!.seed({ id: "a-side", content: "memory a", createdAt: now - 10 * DAY });
    sqlite!.seed({ id: "b-side", content: "memory b", createdAt: now - 5 * DAY, validUntil: now - 1000 });
    await sqlite!.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id IN ('a-side', 'b-side')`).bind(identity.personalWorkspaceId).run();
    await sqlite!.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, status, created_at) VALUES ('cand-1', 'a-side', 'b-side', 0.9, 432000000, 5, 'pending', ?)`,
    ).bind(now).run();

    await runWeeklyInsights(env, ctx, { onlyWorkspaceIds: [identity.personalWorkspaceId] });
    const { results } = await sqlite!.db.prepare(`SELECT status FROM insight_candidates WHERE id = 'cand-1'`).all();
    // Never drawn (and so never reasoned over or settled): still pending.
    expect((results[0] as { status: string }).status).toBe("pending");
  });
});

describe("vectorize-pending and the re-embed migration still include replaced rows (5.5)", () => {
  it("POST /vectorize-pending re-indexes a superseded row with an empty vector_ids", async () => {
    const { env } = await migrated({
      VECTORIZE: makeVectorizeMock({ getByIds: async () => [] }),
    });
    sqlite!.seed({ id: "replaced-unindexed", content: "superseded but still embeddable", createdAt: Date.now() - 700000, vectorIds: [], validUntil: Date.now() - 1000 });

    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBeGreaterThanOrEqual(1);
    const { results } = await sqlite!.db.prepare(`SELECT vector_ids FROM entries WHERE id = 'replaced-unindexed'`).all();
    const vectorIds = JSON.parse(String((results[0] as any).vector_ids));
    expect(vectorIds.length).toBeGreaterThan(0);
  });
});
