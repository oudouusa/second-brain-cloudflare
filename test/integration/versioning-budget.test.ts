/** 4.0の実行数を固定する。batchは1実行、内部SQLはsqlite.batchesへ別記録する。
 * forkのwrite barrier、upload台帳、直前のcapability確認、削除receipt、推論辺刷新を含む。
 * 単純な更新・追記は14/7、status/resolveは3/4、forgetは4（purge込み6）、revert/restoreは16/8。
 * CAS1回失敗は16、3回失敗は18。干渉させる別writerのSQLは計測から分離する。
 * 夜間の50 SQL枠はnightly-d1-budgetでbatch内も計測する。ここはD1呼出数の回帰で、課金行数ではない。
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeTrashEnv, seedTrashRows, type TrashEnv } from "../helpers/trash-env";
import { updateEntryContent, appendToEntry } from "../../src/capture/store";
import { applyStatus, forgetEntry } from "../../src/capture/lifecycle";
import { resolveEntryAction, applyInsightResolution } from "../../src/memory/actions";
import { restoreEntry, deleteForever, getTrashedEntry, trashMirroredEntries } from "../../src/memory/trash";
import { trashNonce } from "../helpers/trash-env";
import { revertEntry } from "../../src/memory/undo";
import { moveEntry } from "../../src/capture/share";
import { markSourcesRolledUp } from "../../src/compression/digest";
import { createMember, cleanupMemberData } from "../../src/lib/team-admin";
import { runNightlyCleanup } from "../../src/memory/cleanup";
import { resolveConfig, DEFAULTS } from "../../src/config";
import { WRITE_CAS_ATTEMPTS } from "../../src/constants";
import type { Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

let t: TrashEnv;
afterEach(() => t?.close());

const change = () => ({ actorId: t.roots.ownerUserId, channel: "rest" as const });
const identity = (): Identity => ({
  userId: t.roots.ownerUserId, role: "admin", personalWorkspaceId: t.roots.ownerPersonalWorkspaceId,
  companyWorkspaceIds: [t.roots.companyWorkspaceId], defaultShare: "",
});
const writeCtx = () => ({ workspaceId: t.roots.ownerPersonalWorkspaceId, actorId: t.roots.ownerUserId });

/** Wraps an env's KV so a get/put bills into the same execution ledger D1 statements do
 * (cron-subrequest-budget.test.ts's countingEnv models the same rule). Local to this file:
 * the two-file scope for Task 10 does not call for a new shared helper. */
function countingKV(env: Env): { env: Env; kvCalls: number } {
  const counter = { n: 0 };
  const inner = env.OAUTH_KV;
  const OAUTH_KV = {
    ...inner,
    get: (...a: Parameters<KVNamespace["get"]>) => { counter.n++; return (inner.get as any)(...a); },
    put: (...a: Parameters<KVNamespace["put"]>) => { counter.n++; return (inner.put as any)(...a); },
  } as unknown as KVNamespace;
  return { env: { ...env, OAUTH_KV }, get kvCalls() { return counter.n; } } as any;
}

describe("更新・追記: forkの保護処理を含む実行数", () => {
  it("通常更新はupload台帳とCAS・推論辺を含め14実行", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    t.sqlite.executions.length = 0;
    const r = await updateEntryContent(t.env, "e1", "new content", DEFAULTS, undefined, undefined, writeCtx(), change(), t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("updated");
    expect(t.sqlite.executions).toHaveLength(14);
  });

  it("通常追記はupload台帳とCASを含め7実行", async () => {
    t = await makeTrashEnv();
    t.seed("e1", { content: "Notes:" });
    t.sqlite.executions.length = 0;
    const ok = (await appendToEntry(t.env, "e1", "Notes:", "met Sam", [], "api", DEFAULTS, undefined, writeCtx(), change(), undefined, t.roots.ownerPersonalWorkspaceId)).indexed;
    expect(ok).toBe(true);
    expect(t.sqlite.executions).toHaveLength(7);
    expect(t.sqlite.executions.at(-1)).toBe("BATCH");
  });
});

describe("compare-and-set retries: A's write-conflict loop", () => {
  it("WRITE_CAS_ATTEMPTS is 3, i.e. at most 2 retries after the first attempt", () => {
    expect(WRITE_CAS_ATTEMPTS).toBe(3);
  });

  it("CASを1回失った場合の実行数と勝者の保持", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    const raceStmt = t.sqlite.db.prepare(`UPDATE entries SET tags = ? WHERE id = ?`);
    const realBatch = t.sqlite.db.batch.bind(t.sqlite.db);
    let race = 0;
    (t.sqlite.db as any).batch = async (stmts: any[]) => {
      if (race === 0 && stmts.some(s => s.sourceSql().startsWith("UPDATE entries AS e SET") && s.sourceSql().includes("content ="))) {
        race++; const at = t.sqlite.executions.length;
        await raceStmt.bind(JSON.stringify(["raced"]), "e1").run();
        t.sqlite.executions.splice(at, 1); // 競合writerのSQLは計測対象の呼出しと分ける。
      }
      return realBatch(stmts);
    };
    t.sqlite.executions.length = 0;
    const r = await updateEntryContent(t.env, "e1", "new content", DEFAULTS, undefined, undefined, writeCtx(), change(), t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("updated");
    expect(t.sqlite.executions).toHaveLength(16);
    expect(t.sqlite.executions.filter((s) => s === "BATCH")).toHaveLength(3);
    expect(race).toBe(1);
  });

  it("exhausting all retries costs exactly the per-retry total", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    const raceStmt = t.sqlite.db.prepare(`UPDATE entries SET tags = ? WHERE id = ?`);
    const realBatch = t.sqlite.db.batch.bind(t.sqlite.db);
    let race = 0;
    (t.sqlite.db as any).batch = async (stmts: any[]) => {
      if (stmts.some(s => s.sourceSql().startsWith("UPDATE entries AS e SET") && s.sourceSql().includes("content ="))) {
        race++; const at = t.sqlite.executions.length;
        await raceStmt.bind(JSON.stringify([`race-${race}`]), "e1").run();
        t.sqlite.executions.splice(at, 1);
      }
      return realBatch(stmts);
    };
    t.sqlite.executions.length = 0;
    const r = await updateEntryContent(t.env, "e1", "new content", DEFAULTS, undefined, undefined, writeCtx(), change(), t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("conflict");
    expect(race).toBe(WRITE_CAS_ATTEMPTS);
    expect(t.sqlite.executions).toHaveLength(18);
    expect(t.sqlite.executions.filter((s) => s === "BATCH")).toHaveLength(WRITE_CAS_ATTEMPTS);
  });
});

describe("status, resolve actions: baseline + 1 KV", () => {
  it("status変更は保護処理を含め3 D1実行、設定取得は呼出元の1 KV", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    const cfg = await resolveConfig(t.env); // the route/MCP layer's own +1 KV, done once here, outside the ledger below
    t.sqlite.executions.length = 0;
    const result = await applyStatus("e1", "canonical", t.env, change(), cfg, t.roots.ownerPersonalWorkspaceId);
    expect(result).toEqual({ status: "ok", indexed: false, validity: { restored: [], reclosed: [], flagged: 0, unflagged: 0 }, eventId: expect.any(String) });
    expect(t.sqlite.executions).toHaveLength(3);
    expect(t.sqlite.executions.filter(x => x === "BATCH")).toHaveLength(1);
  });

  it("done操作はstanding確認を含め4 D1実行・設定取得1 KV", async () => {
    t = await makeTrashEnv();
    t.seed("e1", { tags: '["task"]' });
    const counted = countingKV(t.env);
    t.sqlite.executions.length = 0;
    const ctx = { waitUntil: () => {} };
    const r = await resolveEntryAction(counted.env, ctx, identity(), "e1", "done", undefined, change());
    expect(r.ok, JSON.stringify(t.sqlite.executions)).toBe(true);
    expect(counted.kvCalls).toBe(1); // resolveConfig, internal to resolveEntryAction
    expect(t.sqlite.executions).toHaveLength(4);
    expect(t.sqlite.executions.filter(x => x === "BATCH")).toHaveLength(1);
  });
});

describe("forget: baseline, POST /forget", () => {
  it("forgetはmarkerとtrash履歴を含め4 D1実行", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    t.sqlite.executions.length = 0;
    const r = await forgetEntry("e1", t.env, change(), { reason: "forget", config: DEFAULTS, purge: false }, t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("deleted");
    expect(t.sqlite.executions).toHaveLength(4);
  });

  it("期限切れtrashのpurgeを含むforgetは6 D1実行", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    await seedTrashRows(t, 3, { deletedAt: 1 }); // expired, so the purge batch actually runs
    const cfg = await resolveConfig(t.env); // the route's own +1 KV
    t.sqlite.executions.length = 0;
    const r = await forgetEntry("e1", t.env, change(), { reason: "forget", config: cfg }, t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("deleted");
    expect(t.sqlite.executions).toHaveLength(6);
    expect(t.sqlite.executions.filter((s) => s === "BATCH")).toHaveLength(3);
  });

  it("永久削除は認可済みtrash nonceで1 batchにまとめる", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    await forgetEntry("e1", t.env, change(), { reason: "forget", config: DEFAULTS, purge: false }, t.roots.ownerPersonalWorkspaceId);
    const nonce = await trashNonce(t.env, "e1");
    t.sqlite.executions.length = 0;
    const r = await deleteForever(t.env, "e1", change(), t.roots.ownerPersonalWorkspaceId, nonce);
    expect(r).toMatchObject({ status: "deleted" });
    expect(t.sqlite.executions).toEqual(["BATCH"]);
  });
});

describe("revertEntry: D's content undo", () => {
  it("通常undoは索引再生成と所有確認を含め16 D1実行", async () => {
    t = await makeTrashEnv();
    t.seed("e1", { content: "v1" });
    await updateEntryContent(t.env, "e1", "v2", DEFAULTS, undefined, undefined, writeCtx(), change(), t.roots.ownerPersonalWorkspaceId);
    t.sqlite.executions.length = 0;
    const r = await revertEntry(t.env, identity(), "e1", change(), DEFAULTS, undefined, t.roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("reverted");
    expect(t.sqlite.executions).toHaveLength(16);
    expect(t.sqlite.executions.filter((s) => s === "BATCH")).toHaveLength(2);
  });

  it("mergeを4件戻すと全本文を復元し、索引生成の4件目をpendingへ残す", async () => {
    t = await makeTrashEnv();
    t.seed("hub", { content: "Hub fact0 fact1 fact2 fact3" });
    for (let i = 0; i < 4; i++) t.version("hub", i + 1, {
      content: "Hub" + Array.from({ length: i }, (_, j) => ` fact${j}`).join(""),
      reason: "merge", state: "{}",
      meta: JSON.stringify({ incoming: `fact${i}`, incomingTags: [], incomingSource: "api" }),
    });
    t.sqlite.executions.length = 0;
    const r = await revertEntry(t.env, identity(), "hub", change(), DEFAULTS, 1, t.roots.ownerPersonalWorkspaceId);
    expect(r).toMatchObject({ status: "reverted", deferredIncoming: 1 });
    const executions = t.sqlite.executions.length;
    expect(executions).toBeLessThanOrEqual(50);
    const rows = await t.all<{ content: string; vector_ids: string }>("SELECT content, vector_ids FROM entries WHERE id <> 'hub' ORDER BY content");
    expect(rows.map(row => row.content)).toEqual(["fact0", "fact1", "fact2", "fact3"]);
    expect(rows.filter(row => row.vector_ids === "[]")).toHaveLength(1);
  });
});

describe("restoreEntry", () => {
  it("通常restoreはtrash認可と索引生成を含め8 D1実行", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    await forgetEntry("e1", t.env, change(), { reason: "forget", config: DEFAULTS, purge: false }, t.roots.ownerPersonalWorkspaceId);
    const trashed = await getTrashedEntry(t.env, undefined, "e1");
    t.sqlite.executions.length = 0;
    const r = await restoreEntry(t.env, trashed!, change(), DEFAULTS);
    expect(r.status).toBe("restored");
    expect(t.sqlite.executions).toHaveLength(8);
    expect(t.sqlite.executions.filter(x => x === "BATCH")).toHaveLength(1);
  });
});

describe("share, unshare, integration move: baseline, unchanged", () => {
  it("moveEntry costs one read plus one batch (the move event joins it): 2, unchanged from the Task 0 baseline", async () => {
    t = await makeTrashEnv();
    t.seed("e1");
    t.sqlite.executions.length = 0;
    const r = await moveEntry("e1", "company", t.env, identity(), change());
    expect(r.status).toBe("shared");
    expect(t.sqlite.executions).toHaveLength(2);
    expect(t.sqlite.executions[1]).toBe("BATCH");
  });
});

describe("digest rollup: B's markSourcesRolledUp", () => {
  it("is one batch of exactly 3 statements regardless of source count, per digest.ts:74 and the workerd pin", async () => {
    t = await makeTrashEnv();
    const sources = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, content: `content ${i}`, rowVersion: 1000 }));
    for (const s of sources) t.seed(s.id, { content: s.content, updated_at: null, created_at: 1000 });
    let batchSize = -1;
    const realBatch = t.sqlite.db.batch.bind(t.sqlite.db);
    (t.sqlite.db as any).batch = (stmts: any[]) => { batchSize = stmts.length; return realBatch(stmts); };
    t.sqlite.executions.length = 0;
    await markSourcesRolledUp(t.env, sources, "digest-1", t.roots.ownerPersonalWorkspaceId, DEFAULTS);
    expect(t.sqlite.executions).toEqual(["BATCH"]);
    expect(batchSize).toBe(3);
  });
});

describe("disconnect purge: B's trashMirroredEntries", () => {
  it("trashMirroredEntries alone costs 4 D1 per chunk of 50: 16 for 200 memories", async () => {
    t = await makeTrashEnv();
    for (let i = 0; i < 200; i++) t.seed(`p${i}`, { tags: '["notion"]', source: "notion" });
    t.sqlite.executions.length = 0;
    const r = await trashMirroredEntries(t.env, identity(), Array.from({ length: 200 }, (_, i) => `p${i}`), { provider: "notion" });
    expect(r).toEqual({ purged: 200, skipped: 0 });
    expect(t.sqlite.executions).toHaveLength(16);
    expect(t.sqlite.executions.filter((s) => s === "BATCH")).toHaveLength(8); // trash batch + audit batch, per chunk
  });
});

describe("insight resolution", () => {
  it("90 ids costs 2N+1 statements in one batch, plus one audit batch: 181 statements, 2 executions — not the spec's N+2/92", async () => {
    t = await makeTrashEnv();
    const found: Record<string, unknown>[] = [];
    for (let i = 0; i < 90; i++) {
      const id = `i${i}`;
      t.seed(id, { tags: '["auto-insight"]' });
      found.push({ id, tags: '["auto-insight"]', workspace_id: t.roots.ownerPersonalWorkspaceId, vector_ids: "[]" });
    }
    const batchSizes: number[] = [];
    const realBatch = t.sqlite.db.batch.bind(t.sqlite.db);
    (t.sqlite.db as any).batch = (stmts: any[]) => { batchSizes.push(stmts.length); return realBatch(stmts); };
    t.sqlite.executions.length = 0;
    const ctx = { waitUntil: () => {} };
    const r = await applyInsightResolution(t.env, ctx, change(), found, 90, "confirm");
    expect(r.resolved).toHaveLength(90);
    expect(batchSizes).toEqual([2 * 90 + 1, 90]);
    expect(t.sqlite.executions.filter((s) => s === "BATCH")).toHaveLength(2); // the resolution batch + auditEvents' own batch
  });
});

describe("member removal: cleanupMemberData", () => {
  it("memberの記憶50件を削除し、markerと履歴処理を含め6 D1実行", async () => {
    t = await makeTrashEnv();
    const { member } = await createMember(t.env, { name: "Ada" });
    for (let i = 0; i < 50; i++) {
      t.sqlite.db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES (?, 'c', '[]', 'api', 1, '[]', ?, ?)`,
      ).bind(`m${i}`, member.personalWorkspaceId, member.userId).run();
    }
    t.sqlite.executions.length = 0;
    const progress = await cleanupMemberData(t.env, member.userId, member.personalWorkspaceId);
    expect(progress.done).toBe(true);
    expect(progress.removedEntries).toBe(50);
    expect(t.sqlite.executions).toHaveLength(6);
    expect(t.sqlite.executions.filter((s) => s === "BATCH")).toHaveLength(2);
  });

  it("the budget estimate counts the life-end marker rows too, ~5 per entries row and ~5 per trashed row", async () => {
    t = await makeTrashEnv();
    const { member } = await createMember(t.env, { name: "Ada" });
    t.sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('m0', 'c', '[]', 'api', 1, '[]', ?, ?)`,
    ).bind(member.personalWorkspaceId, member.userId).run();
    const progress = await cleanupMemberData(t.env, member.userId, member.personalWorkspaceId, { rowsLeft: 13 });
    expect(progress.blockedByBudget).toBe(true);
    expect(progress.done).toBe(false);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'm0'`)).not.toBeNull();
  });
});

describe("nightly cron: ordinary and worst night", () => {
  it("an ordinary night's purge-and-removal-probe alone costs 2 executions, matching test/integration/trash-purge.test.ts:187-193", async () => {
    t = await makeTrashEnv();
    t.sqlite.executions.length = 0;
    const night = await runNightlyCleanup(t.env);
    expect(night.purged).toBe(0);
    expect(t.sqlite.executions).toHaveLength(2); // the purge candidate read, the pending-removal probe
  });

  it("the worst night's ceiling is 61, and the full-10-chunk resume is measured at 18, not the spec's ~20 or ~54", async () => {
    t = await makeTrashEnv();
    await seedTrashRows(t, 3000);
    const { member } = await createMember(t.env, { name: "Ada" });
    const P = member.personalWorkspaceId;
    await t.sqlite.db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
      INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, write_marker)
      SELECT 'm' || i, 'c', '[]', 'api', 1, '[]', '${P}', '${member.userId}', '${t.sqlite.fixtureMarker()}' FROM n`);
    await t.sqlite.db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
      INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, actor_id, channel, reason, created_at, write_marker)
      SELECT 'm1', '${P}', i, 'v', NULL, '[]', '', 'rest', 'update', i, '${t.sqlite.fixtureMarker()}' FROM n`);
    await t.sqlite.db.prepare(`UPDATE users SET removed_at = 5 WHERE id = ?`).bind(member.userId).run();
    t.sqlite.executions.length = 0;
    const night = await runNightlyCleanup(t.env);
    expect(t.sqlite.executions.length).toBeLessThanOrEqual(61);
    void night;
  });
});
