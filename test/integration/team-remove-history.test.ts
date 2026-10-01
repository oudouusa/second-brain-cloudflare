import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTrashEnv, seedTrashRows, seedVersionsFor, type TrashEnv } from "../helpers/trash-env";
import { makeVectorizeMock } from "../helpers/make-env";
import { createMember } from "../../src/lib/team-admin";
import { runNightlyCleanup } from "../../src/memory/cleanup";
import { drainPendingVectorDeletes } from "../../src/vectorize/batch";
import { NIGHTLY_CLEANUP_ROWS, MEMBER_HISTORY_CHUNK, MEMBER_HISTORY_MAX_CHUNKS, VECTORIZE_DELETE_MAX_IDS_PER_CALL } from "../../src/constants";

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };

let t: TrashEnv;
afterEach(() => { t?.close(); });

const remove = (id: string) =>
  worker.fetch(new Request("http://localhost/team/members/remove", { method: "POST", headers, body: JSON.stringify({ id }) }), t.env, ctx);
const versionSeqs = async (id: string) => (await t.all<any>(`SELECT seq FROM entry_versions WHERE entry_id = ? ORDER BY seq`, id)).map((r) => r.seq);

async function withMember(overrides = {}) {
  t = await makeTrashEnv(overrides);
  const { member } = await createMember(t.env, { name: "Ada" });
  return member;
}

describe("member removal keeps history consistent", () => {
  it("deletes the member's entries, their versions, their trash rows and those rows' versions", async () => {
    const m = await withMember();
    const P = m.personalWorkspaceId;
    t.seed("live", { workspace_id: P, actor_id: m.userId }); t.version("live", 1, { workspace_id: P }); t.version("live", 2, { workspace_id: P });
    await seedTrashRows(t, 1, { prefix: "gone", deletedAt: Date.now(), workspaceId: P });
    await seedVersionsFor(t, ["gone0"], 3);
    t.seed("other"); t.version("other", 1);

    const res = await remove(m.userId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, done: true, removedEntries: 1 });
    expect(await t.one(`SELECT id FROM entries WHERE id = 'live'`)).toBeNull();
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'gone0'`)).toBeNull();
    expect(await versionSeqs("live")).toEqual([]);
    expect(await versionSeqs("gone0")).toEqual([]);
    expect(await versionSeqs("other")).toEqual([1]);
  });

  it("deletes the member's personal-era versions of a shared memory bottom-up; the company chain above still reconstructs", async () => {
    const m = await withMember();
    const P = m.personalWorkspaceId, C = t.roots.companyWorkspaceId;
    t.seed("shared", { workspace_id: C, actor_id: m.userId });
    t.version("shared", 1, { workspace_id: P }); t.version("shared", 2, { workspace_id: P });
    t.version("shared", 3, { workspace_id: C }); t.version("shared", 4, { workspace_id: C });
    await remove(m.userId);
    expect(await versionSeqs("shared")).toEqual([3, 4]);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'shared'`)).not.toBeNull();
  });

  it("a company memory unshared into the personal workspace loses all its versions", async () => {
    const m = await withMember();
    const P = m.personalWorkspaceId, C = t.roots.companyWorkspaceId;
    t.seed("back", { workspace_id: P, actor_id: m.userId });
    t.version("back", 1, { workspace_id: P }); t.version("back", 2, { workspace_id: C }); t.version("back", 3, { workspace_id: P });
    await remove(m.userId);
    expect(await versionSeqs("back")).toEqual([]);
  });

  it("with more history than one call's cap returns 202 done:false and completes on the next call, never leaving a gap or an orphan", async () => {
    const m = await withMember({ VECTORIZE: makeVectorizeMock({ deleteByIds: vi.fn().mockResolvedValue({}) }) });
    const P = m.personalWorkspaceId;
    t.seed("big", { workspace_id: P, actor_id: m.userId, vector_ids: '["vx"]' });
    const total = MEMBER_HISTORY_CHUNK * MEMBER_HISTORY_MAX_CHUNKS + 500;
    await t.sqlite.db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${total})
      INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at, write_marker)
      SELECT 'big', '${P}', i, 'v', NULL, '[]', '', 'rest', 'update', i, '${t.sqlite.fixtureMarker()}' FROM n`);

    const first = await remove(m.userId);
    expect(first.status).toBe(202);
    // FX3 finding 7: the 202 keeps the 3.7 removedEntries/removedVectors fields, with partial
    // (here: zero, since nothing is deleted until done:true) counts, rather than omitting them.
    expect(await first.json()).toMatchObject({ ok: true, done: false, removedEntries: 0, removedVectors: 0 });
    // Bottom-up: the oldest 10,000 went, the newest 500 remain contiguous, and the entry still exists.
    const seqs = await versionSeqs("big");
    expect(seqs[0]).toBe(MEMBER_HISTORY_CHUNK * MEMBER_HISTORY_MAX_CHUNKS + 1);
    expect(seqs).toHaveLength(500);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'big'`)).not.toBeNull();
    // Nothing is audited and no vector is deleted on a done:false call.
    await Promise.all(pending);
    expect(await t.all(`SELECT id FROM admin_events WHERE event = 'member_removed'`)).toHaveLength(0);
    expect(t.env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();

    const second = await remove(m.userId);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, done: true, removedEntries: 1, removedVectors: 1 });
    await Promise.all(pending);
    expect(await t.all(`SELECT id FROM admin_events WHERE event = 'member_removed'`)).toHaveLength(1);
    expect(t.env.VECTORIZE.deleteByIds).toHaveBeenCalledWith(["vx"]);
    expect(await versionSeqs("big")).toEqual([]);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'big'`)).toBeNull();
  });

  it("collects the affected entry ids once per call, not once per chunk", async () => {
    const m = await withMember();
    const P = m.personalWorkspaceId;
    t.seed("big", { workspace_id: P, actor_id: m.userId });
    await t.sqlite.db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3500)
      INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at, write_marker)
      SELECT 'big', '${P}', i, 'v', NULL, '[]', '', 'rest', 'update', i, '${t.sqlite.fixtureMarker()}' FROM n`);
    t.sqlite.issued.length = 0;
    await remove(m.userId);
    expect(t.sqlite.issued.filter((s) => /SELECT DISTINCT entry_id FROM entry_versions/.test(s))).toHaveLength(1);
  });

  it("a removal left at done:false is completed by the nightly run, which writes member_removed with resumed true", async () => {
    const m = await withMember();
    const P = m.personalWorkspaceId;
    t.seed("big", { workspace_id: P, actor_id: m.userId });
    await seedVersionsFor(t, [], 0);
    await t.sqlite.db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10500)
      INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at, write_marker)
      SELECT 'big', '${P}', i, 'v', NULL, '[]', '', 'rest', 'update', i, '${t.sqlite.fixtureMarker()}' FROM n`);
    expect((await remove(m.userId)).status).toBe(202);

    const night = await runNightlyCleanup(t.env);
    expect(night.removalResumed).toBe(true);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'big'`)).toBeNull();
    const ev = await t.one<any>(`SELECT actor_id, target_user_id, payload FROM admin_events WHERE event = 'member_removed'`);
    expect(ev).toMatchObject({ actor_id: "", target_user_id: m.userId });
    expect(JSON.parse(ev.payload)).toMatchObject({ resumed: true, removedEntries: 1 });
    // Nothing pending on the next night: the probe finds nobody.
    expect((await runNightlyCleanup(t.env)).removalResumed).toBe(false);
  });

  it("FX3 finding 2: the nightly resume caps its own vector delete and the next drain finishes the rest", async () => {
    const overCap = VECTORIZE_DELETE_MAX_IDS_PER_CALL + 50;
    const vectorIds = Array.from({ length: overCap }, (_, i) => `vx-${i}`);
    const m = await withMember({ VECTORIZE: makeVectorizeMock({ deleteByIds: vi.fn().mockResolvedValue({}) }) });
    const P = m.personalWorkspaceId;
    t.seed("big", { workspace_id: P, actor_id: m.userId, vector_ids: JSON.stringify(vectorIds) });
    await seedVersionsFor(t, [], 0);
    await t.sqlite.db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10500)
      INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at, write_marker)
      SELECT 'big', '${P}', i, 'v', NULL, '[]', '', 'rest', 'update', i, '${t.sqlite.fixtureMarker()}' FROM n`);
    expect((await remove(m.userId)).status).toBe(202);

    // The nightly run finishes the D1 side (done:true) and its own vector delete is capped.
    await runNightlyCleanup(t.env);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'big'`)).toBeNull();
    const deletedByNight = (t.env.VECTORIZE.deleteByIds as any).mock.calls.flat(2) as string[];
    expect(deletedByNight).toHaveLength(VECTORIZE_DELETE_MAX_IDS_PER_CALL);

    // The remainder is queued, not lost: a drain (the next night's own leading step, called here
    // directly) finishes deleting every vector this removal ever owned.
    await drainPendingVectorDeletes(t.env, overCap);
    const deletedTotal = (t.env.VECTORIZE.deleteByIds as any).mock.calls.flat(2) as string[];
    expect(new Set(deletedTotal)).toEqual(new Set(vectorIds));
  });

  it("the nightly run resumes at most one pending removal and at most 10 chunks", async () => {
    const m1 = await withMember();
    const { member: m2 } = await createMember(t.env, { name: "Bea" });
    for (const [m, id] of [[m1, "b1"], [m2, "b2"]] as const) {
      t.seed(id, { workspace_id: m.personalWorkspaceId, actor_id: m.userId });
      await t.sqlite.db.exec(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12000)
        INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at, write_marker)
        SELECT '${id}', '${m.personalWorkspaceId}', i, 'v', NULL, '[]', '', 'rest', 'update', i, '${t.sqlite.fixtureMarker()}' FROM n`);
    }
    // Claim both removals (each answers 202 and leaves history behind).
    expect((await remove(m1.userId)).status).toBe(202);
    expect((await remove(m2.userId)).status).toBe(202);
    const before = ((await t.one<any>(`SELECT COUNT(*) n FROM entry_versions`))!.n);
    t.sqlite.issued.length = 0;
    const night = await runNightlyCleanup(t.env);
    const executions = t.sqlite.issued.length;
    const after = ((await t.one<any>(`SELECT COUNT(*) n FROM entry_versions`))!.n);
    // One member only, at most 10 chunks of 1,000: the one resumed has 2,000 left and finishes; the other is untouched.
    expect(night.removalResumed).toBe(true);
    expect(before - after).toBe(2000);
    expect(night.rowsWritten).toBeLessThanOrEqual(NIGHTLY_CLEANUP_ROWS);
    // forkではbatch内各statementも数える。履歴3chunkのmarker UPDATEとDELETE、
    // 最終batchのentry/trash/edge markerを含め24文。書込予算は上の実消去数でも検査する。
    expect(executions).toBe(24);
  });
});
