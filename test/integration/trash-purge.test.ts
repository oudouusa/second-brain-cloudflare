import { describe, it, expect, afterEach } from "vitest";
import { makeTrashEnv, seedTrashRows, seedVersionsFor, type TrashEnv } from "../helpers/trash-env";
import { forgetEntry } from "../../src/capture/lifecycle";
import { purgeLimit, purgeTrash } from "../../src/memory/trash";
import { resolveConfig } from "../../src/config";
import { runNightlyCleanup } from "../../src/memory/cleanup";
import { NIGHTLY_CLEANUP_ROWS, TRASH_PURGE_NIGHTLY_ROWS, VERSION_DELETE_CHUNK } from "../../src/constants";

let t: TrashEnv;
afterEach(() => t?.close());

const count = async (sql: string, ...a: unknown[]) => ((await t.one<any>(sql, ...a))!.n as number);
const cfg = () => resolveConfig(t.env);
const DAY = 86_400_000;

describe("purge", () => {
  it("removes only expired rows, oldest first, up to the limit", async () => {
    t = await makeTrashEnv();
    const now = 100 * DAY;
    for (const [id, age] of [["e3", 20], ["e1", 40], ["e2", 30], ["fresh", 3]] as const) {
      await seedTrashRows(t, 1, { prefix: id, deletedAt: now - age * DAY });
    }
    const r = await purgeTrash(t.env, await cfg(), { ceiling: 2, rowTarget: 5000, now });
    expect(r).toMatchObject({ read: 2, purged: 2 });
    // e1 (40 days) and e2 (30 days) went; e3 (20 days, inside the window) and fresh stayed.
    expect((await t.all(`SELECT id FROM entries_trash ORDER BY id`)).map((x) => x.id)).toEqual(["e30", "fresh0"]);
  });

  it("deletes a purged row's own vectors, not an unrelated row's (Codex review, T-0102 F1)", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 1, { prefix: "gone", deletedAt: 1, vectorIds: JSON.stringify(["v-gone-1", "v-gone-2"]) });
    await seedTrashRows(t, 1, { prefix: "kept", deletedAt: 200 * DAY, vectorIds: JSON.stringify(["v-kept-1"]) }); // not expired

    await purgeTrash(t.env, await cfg(), { ceiling: 10, rowTarget: 5000, now: 100 * DAY });

    expect(t.env.VECTORIZE.deleteByIds).toHaveBeenCalledWith(["v-gone-1", "v-gone-2"]);
    expect(t.env.VECTORIZE.deleteByIds).not.toHaveBeenCalledWith(expect.arrayContaining(["v-kept-1"]));
  });

  it("a purged row with no vectors never calls deleteByIds", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 1, { deletedAt: 1, vectorIds: "[]" });
    await purgeTrash(t.env, await cfg(), { ceiling: 10, rowTarget: 5000, now: 100 * DAY });
    expect(t.env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
  });

  it("gives each purged row a purged event in the same batch", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 3, { deletedAt: 5, reason: "disconnect" });
    await purgeTrash(t.env, await cfg(), { ceiling: 10, rowTarget: 5000, now: 100 * DAY });
    const ev = await t.all<any>(`SELECT entry_id, actor_id, payload FROM entry_events WHERE event = 'purged' ORDER BY entry_id`);
    expect(ev.map((e) => e.entry_id)).toEqual(["t0", "t1", "t2"]);
    expect(JSON.parse(ev[0].payload)).toEqual({ channel: "system:purge", reason: "disconnect", deleted_at: 5 });
    expect(ev[0].actor_id).toBe("");
  });

  it("deletes versions only for ids that are not live", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 2, { deletedAt: 1 });
    t.seed("t1"); // t1 came back to life (restored) after the purge read it
    await seedVersionsFor(t, ["t0", "t1"], 3);
    await purgeTrash(t.env, await cfg(), { ceiling: 10, rowTarget: 5000, now: 100 * DAY });
    expect(await count(`SELECT COUNT(*) n FROM entry_versions WHERE entry_id = 't0'`)).toBe(0);
    expect(await count(`SELECT COUNT(*) n FROM entry_versions WHERE entry_id = 't1'`)).toBe(3);
  });

  it("uses the configured retention window", async () => {
    t = await makeTrashEnv();
    const now = 100 * DAY;
    await seedTrashRows(t, 1, { prefix: "a", deletedAt: now - 10 * DAY });
    const base = await cfg();
    expect((await purgeTrash(t.env, { ...base, TRASH_RETENTION_DAYS: 14 }, { ceiling: 10, rowTarget: 5000, now })).purged).toBe(0);
    expect((await purgeTrash(t.env, { ...base, TRASH_RETENTION_DAYS: 7 }, { ceiling: 10, rowTarget: 5000, now })).purged).toBe(1);
  });

  it("purgeLimit adapts to VERSION_KEEP and is capped by the ceiling", () => {
    expect(purgeLimit(20, 10, 1000)).toBe(10); // 1000 / 49 = 20, ceiling 10
    expect(purgeLimit(500, 10, 1000)).toBe(1); // 1000 / 1009 = 0, at least one
    expect(purgeLimit(20, 400, 5000)).toBe(100); // 5000 / 49
    expect(purgeLimit(5, 400, 5000)).toBe(250); // 5000 / (10 + 2 * 5), including the delete marker
  });

  it("is chosen from the real version counts: a row trashed with 500 versions is costed at 500", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 1, { prefix: "big" });
    await seedTrashRows(t, 1, { prefix: "small" });
    await seedVersionsFor(t, ["big0"], 500);
    await seedVersionsFor(t, ["small0"], 3);
    // keep is 20 now; an estimate would say 47 rows. big0 really costs 7 + 1000 = 1007, over the 1000 target.
    const r = await purgeTrash(t.env, await cfg(), { ceiling: 10, rowTarget: 1000, now: 100 * DAY });
    expect(r.purged).toBe(0);
    expect(r.trimmed).toBeGreaterThan(0);
    // The batch never wrote more than its target.
    expect(r.rowsWritten).toBeLessThanOrEqual(1000);
  });

  it("deletes a row whose versions exceed the target oldest first in chunks, then purges it", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 1, { prefix: "big" });
    await seedVersionsFor(t, ["big0"], 5000);
    const c = await cfg();
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await purgeTrash(t.env, c, { ceiling: 10, rowTarget: 5000, now: 100 * DAY });
      seen.push(await count(`SELECT COUNT(*) n FROM entry_versions WHERE entry_id = 'big0'`));
      if (r.purged) break;
      expect(r.trimmed).toBeGreaterThan(0);
      expect(r.trimmed).toBeLessThanOrEqual(VERSION_DELETE_CHUNK);
    }
    // 5,000 -> 3,000 -> 1,000 (then 7 + 2,000 fits under 5,000) -> purged with the row.
    expect(seen).toEqual([3000, 1000, 0]);
    expect(await count(`SELECT COUNT(*) n FROM entries_trash`)).toBe(0);
    // Deleted from the bottom: the surviving versions were the newest ones when it stopped.
  });

  it("trims from the bottom so the remaining chain has no gap", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 1, { prefix: "big" });
    await seedVersionsFor(t, ["big0"], 3000);
    await purgeTrash(t.env, await cfg(), { ceiling: 10, rowTarget: 5000, now: 100 * DAY });
    const seqs = (await t.all<any>(`SELECT seq FROM entry_versions WHERE entry_id = 'big0' ORDER BY seq`)).map((r) => r.seq);
    expect(seqs[0]).toBe(VERSION_DELETE_CHUNK + 1);
    expect(seqs.at(-1)).toBe(3000);
    expect(seqs.length).toBe(3000 - VERSION_DELETE_CHUNK);
  });

  it("the forget path purges at most its ceiling and target", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 30);
    t.seed("x");
    await forgetEntry("x", t.env, { actorId: "", channel: "rest" }, { reason: "forget", config: await cfg() }, t.roots.ownerPersonalWorkspaceId);
    // 30 expired rows, ceiling 10 on the forget path; the new trash row is fresh.
    expect(await count(`SELECT COUNT(*) n FROM entries_trash`)).toBe(21);
  });

  it("mirror and disconnect forgets skip the purge batch", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 3);
    t.seed("m"); t.seed("d");
    const c = await cfg();
    await forgetEntry("m", t.env, { actorId: "", channel: "system:mirror" }, { reason: "mirror", config: c, purge: false }, t.roots.ownerPersonalWorkspaceId);
    await forgetEntry("d", t.env, { actorId: "u", channel: "rest" }, { reason: "disconnect", config: c, purge: false }, t.roots.ownerPersonalWorkspaceId);
    expect(await count(`SELECT COUNT(*) n FROM entries_trash`)).toBe(5);
    expect((await t.all<any>(`SELECT reason FROM entries_trash WHERE id IN ('m','d') ORDER BY id`)).map((r) => r.reason)).toEqual(["disconnect", "mirror"]);
  });

  it("adversary (MINOR): must not delete a trash row that was restored and re-forgotten between the candidate read and the batch", async () => {
    const { getTrashedEntry, restoreEntry } = await import("../../src/memory/trash");
    t = await makeTrashEnv();
    t.seed("a"); t.version("a", 1); t.version("a", 2);
    await forgetEntry("a", t.env, { actorId: "u", channel: "rest" }, { reason: "forget", config: await cfg(), purge: false }, t.roots.ownerPersonalWorkspaceId);
    // Age the trash row past 14 days.
    await t.sqlite.db.prepare(`UPDATE entries_trash SET deleted_at = 1 WHERE id = 'a'`).run();
    const c = await cfg();

    const realBatch = t.env.DB.batch.bind(t.env.DB);
    let injected = false;
    (t.env.DB as any).batch = async (stmts: any[]) => {
      const first = stmts.map(s => String(s.sourceSql?.() ?? "")).join("\n");
      if (!injected && first.includes("'purged'") && first.includes("system:purge")) {
        injected = true;
        // Between the purge's candidate read and its batch: the user restores, then forgets again.
        const trashed = await getTrashedEntry(t.env, undefined, "a");
        expect((await restoreEntry(t.env, trashed!, { actorId: "u", channel: "rest" }, c)).status).toBe("restored");
        expect((await forgetEntry("a", t.env, { actorId: "u", channel: "rest" }, { reason: "forget", config: c, purge: false }, t.roots.ownerPersonalWorkspaceId)).status).toBe("deleted");
      }
      return realBatch(stmts);
    };
    await purgeTrash(t.env, c, { ceiling: 10, rowTarget: 1000 });

    // The trash row now in place was written a moment ago: it must survive, with its history.
    expect(await t.one(`SELECT deleted_at FROM entries_trash WHERE id = 'a'`)).not.toBeNull();
    expect((await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'a'`)).length).toBe(2);
  });
});

describe("nightly cleanup", () => {
  it("runs at most 5 batches of at most 400 rows, inside the purge's rows-written share", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 2050);
    // 9 rows per version-less trash row (R23: idx_entry_events_life_end also indexes the purged
    // event): 400 rows cost 3,600, so the 10,000-row share ends the night in the third batch
    // (400 + 400 + 311 rows). The spec's "2,000 on night one" ignores its own budget.
    const first = await runNightlyCleanup(t.env);
    expect(first.purged).toBe(1000);
    expect(first.rowsWritten).toBeLessThanOrEqual(TRASH_PURGE_NIGHTLY_ROWS);
    expect(await count(`SELECT COUNT(*) n FROM entries_trash`)).toBe(2050 - 1000);
    const second = await runNightlyCleanup(t.env);
    expect(second.purged).toBe(1000);
    expect(await count(`SELECT COUNT(*) n FROM entries_trash`)).toBe(50);
    await runNightlyCleanup(t.env);
    expect(await count(`SELECT COUNT(*) n FROM entries_trash`)).toBe(0);
  });

  it("never runs more than 5 batches a night", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 3000);
    const cfgv = await cfg();
    // With cheap rows (versions-free) and a huge share, the batch count is what stops it.
    let batches = 0;
    const real = t.sqlite.db.batch.bind(t.sqlite.db);
    (t.sqlite.db as any).batch = (s: unknown[]) => { batches++; return real(s as any); };
    await runNightlyCleanup(t.env);
    expect(batches).toBeLessThanOrEqual(5);
    void cfgv;
  });

  it("an ordinary night with nothing expired costs two executions: the purge read and the removal probe", async () => {
    t = await makeTrashEnv();
    t.sqlite.issued.length = 0;
    await runNightlyCleanup(t.env);
    // The config read is a KV call, not D1.
    expect(t.sqlite.issued).toHaveLength(2);
  });

  it("stops the purge at its 10,000-row share", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 3000);
    const r = await runNightlyCleanup(t.env);
    expect(r.rowsWritten).toBeLessThanOrEqual(TRASH_PURGE_NIGHTLY_ROWS);
    expect(r.rowsWritten).toBeGreaterThan(TRASH_PURGE_NIGHTLY_ROWS - 400);
    expect(r.purged).toBeLessThan(2000);
  });
});

describe("a night with a bulk purge and a pending removal", () => {
  async function pendingRemovalWith(entries: number, versionsEach = 0) {
    const { createMember } = await import("../../src/lib/team-admin");
    const { member } = await createMember(t.env, { name: "Ada" });
    const P = member.personalWorkspaceId;
    await t.sqlite.db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${entries})
      INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, write_marker)
      SELECT 'm' || i, 'c', '[]', 'api', 1, '[]', '${P}', '${member.userId}', '${t.sqlite.fixtureMarker()}' FROM n`);
    if (versionsEach) {
      await t.sqlite.db.exec(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${versionsEach})
        INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at, write_marker)
        SELECT 'm1', '${P}', i, 'v', NULL, '[]', '', 'rest', 'update', i, '${t.sqlite.fixtureMarker()}' FROM n`);
    }
    // Claim the removal without running its cleanup.
    await t.sqlite.db.prepare(`UPDATE users SET removed_at = 5 WHERE id = ?`).bind(member.userId).run();
    return member;
  }

  it("writes at most 15,000 cleanup rows and at most 61 executions", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 3000);
    const m = await pendingRemovalWith(200, 3000);
    t.sqlite.issued.length = 0;
    const night = await runNightlyCleanup(t.env);
    expect(night.rowsWritten).toBeLessThanOrEqual(NIGHTLY_CLEANUP_ROWS);
    // 5-batch worst case is 10 purge executions; the resume is at most 18. 26 is the ordinary night's total.
    expect(t.sqlite.issued.length).toBeLessThanOrEqual(61 - 26 + 10 + 18 + 2);
    expect(t.sqlite.issued.length).toBeLessThanOrEqual(61);
  });

  it("a removal whose final batch alone exceeds 15,000 rows waits, then completes on a night when the purge wrote nothing", async () => {
    t = await makeTrashEnv();
    const m = await pendingRemovalWith(1600); // 10 x 1,600 = 16,000 > 15,000
    await seedTrashRows(t, 50); // the purge writes something first
    const busy = await runNightlyCleanup(t.env);
    expect(busy.purged).toBe(50);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'm1'`)).not.toBeNull();
    const quiet = await runNightlyCleanup(t.env);
    expect(quiet.purged).toBe(0);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'm1'`)).toBeNull();
    void m;
  });

  it("T-0089.7.5: on an active brain (the purge writes something every night), the removal still finishes within two nights instead of starving", async () => {
    t = await makeTrashEnv();
    await pendingRemovalWith(1600); // 10 x 1,600 = 16,000 > 15,000: bigger than the whole nightly budget
    // Fresh expired trash every night, mimicking continuous churn: the purge is never quiet, so
    // `allowOversize: purgeRows === 0` alone would never fire again.
    for (let night = 0; night < 6; night++) {
      await seedTrashRows(t, 5, { prefix: `n${night}-`, deletedAt: 1 });
      const r = await runNightlyCleanup(t.env);
      expect(r.purged).toBeGreaterThan(0); // confirms the brain stayed "active" this night
      if (night === 0) {
        expect(await t.one(`SELECT id FROM entries WHERE id = 'm1'`)).not.toBeNull(); // first night: still waiting
      }
    }
    // Given its guaranteed slot the night after being turned away, it is done well within six
    // nights of a purge that never once went quiet.
    expect(await t.one(`SELECT id FROM entries WHERE id = 'm1'`)).toBeNull();
  });
});

describe("adversary (MINOR): the nightly purge must not run at half the spec's pace", () => {
  it("a bulk trash of mirrored rows (3 versions each) purges at ~666 a night, not one batch cut short by the budget", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 1000, { prefix: "m", deletedAt: 1, reason: "disconnect" });
    await t.sqlite.db.exec(`
      INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at, write_marker)
      SELECT t.id, '', s.seq, 'v', NULL, '[]', '', 'system:mirror', 'mirror', 1, '${t.sqlite.fixtureMarker()}'
        FROM entries_trash t, (SELECT 1 AS seq UNION ALL SELECT 2 UNION ALL SELECT 3) s`);

    const night = await runNightlyCleanup(t.env);
    // Mirror rows (15 rows each: PURGE_ROW_COST 9 + 2*3 versions) purge at about 666 a night
    // (10,000 / 15). A batch cut short by the row budget (not by running out of expired rows)
    // must not stop the loop.
    expect(night.purged).toBeGreaterThanOrEqual(600);
  });
});

describe("adversary round 2: the oversized-row trim branch must respect the retention cutoff", () => {
  it("must not trim a trash row restored and re-forgotten after the candidate read", async () => {
    t = await makeTrashEnv();
    t.seed("big");
    for (let s = 1; s <= 30; s++) t.version("big", s);
    await forgetEntry("big", t.env, { actorId: "u", channel: "rest" }, { reason: "forget", config: await cfg(), purge: false }, t.roots.ownerPersonalWorkspaceId);
    await t.sqlite.db.prepare(`UPDATE entries_trash SET deleted_at = 1 WHERE id = 'big'`).run();
    const c = await cfg();

    // Between the candidate read and the trim DELETE: restore, then forget again (a fresh trash row).
    const { getTrashedEntry, restoreEntry } = await import("../../src/memory/trash");
    const realBatch = t.env.DB.batch.bind(t.env.DB);
    let injected = false;
    (t.env.DB as any).batch = async (stmts: D1PreparedStatement[]) => {
      const sql = stmts.map(s => (s as any).sourceSql?.() ?? "").join("\n");
      if (!injected && /DELETE FROM entry_versions WHERE id IN \(\s*SELECT v\.id/.test(sql)) {
        injected = true;
        const trashed = await getTrashedEntry(t.env, undefined, "big");
        expect((await restoreEntry(t.env, trashed!, { actorId: "u", channel: "rest" }, c)).status).toBe("restored");
        expect((await forgetEntry("big", t.env, { actorId: "u", channel: "rest" }, { reason: "forget", config: c, purge: false }, t.roots.ownerPersonalWorkspaceId)).status).toBe("deleted");
      }
      return realBatch(stmts);
    };
    // rowTarget 20 forces the trim branch: the row costs 7 + 2 x 30 = 67.
    const r = await purgeTrash(t.env, c, { ceiling: 10, rowTarget: 20 });
    expect(injected).toBe(true);
    expect(r.trimmed).toBeGreaterThanOrEqual(0);
    // The trash row now present is minutes old: none of its history may be trimmed.
    expect((await t.all(`SELECT seq FROM entry_versions WHERE entry_id = 'big'`)).length).toBe(30);
  });
});
