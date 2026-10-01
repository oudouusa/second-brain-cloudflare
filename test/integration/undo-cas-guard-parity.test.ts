/**
 * Codex review, T-0102 D1/D2: revertEntry's snapshot guard used to be lighter than the UPDATE's
 * own guard (workspace_id alone, vs. workspace_id + vector_ids whenever the revert re-embeds),
 * and releaseHeldAfterEdit's guard pinned tags/workspace/vector_ids but not content. Either gap
 * lets the version snapshot (or the hold snapshot) land while the row's own UPDATE loses its
 * compare-and-set to a concurrent write -- a phantom version claiming a change the entries row
 * never actually received. Same interception pattern adv-undo-r2-7.test.ts already uses: inject
 * a concurrent write right as the racing statement is prepared, before the batch commits.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import { updateEntryContent } from "../../src/capture/store";
import { revertEntry } from "../../src/memory/undo";
import { withHold } from "../../src/quarantine/tags";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
let workspaceId = "";

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  env = sqlite.admitEnv(env);
  const roots = await ensureTenantBootstrap(env);
  workspaceId = roots.ownerPersonalWorkspaceId;
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
});
afterEach(() => sqlite.close());

const live = async (id: string) => (await sqlite.db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;
const versionsOf = async (id: string) => ((await sqlite.db.prepare(`SELECT seq, reason FROM entry_versions WHERE entry_id = ? ORDER BY seq`).bind(id).all()).results ?? []) as { seq: number; reason: string }[];

/** Wraps env.DB so the first prepare() whose SQL starts with `trigger` runs `injected` against the
 * REAL db first -- the same interception adv-undo-r2-7.test.ts uses to simulate a write that lands
 * in the gap between this call's own read and its batch commit. */
function racingEnv(base: Env, trigger: string, injected: () => void): Env {
  const raw = base.DB as any;
  let fired = false;
  return { ...base, WRITE_ADMISSION_TOKEN: base.WRITE_ADMISSION_TOKEN, DB: { ...raw, prepare(sql: string) {
    if (!fired && sql.startsWith(trigger)) { fired = true; injected(); }
    return raw.prepare(sql);
  } } } as unknown as Env;
}

describe("D1: revertEntry's snapshot and UPDATE share one guard, not a lighter one for the snapshot", () => {
  it("a concurrent vector_ids change loses the whole revert, not just the UPDATE half of it", async () => {
    const writeCtx = { workspaceId, actorId: owner.userId };
    const change = { actorId: owner.userId, channel: "rest" as const };
    await sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, '[]', 'api', ?, '["v0"]', ?, ?)`,
    ).bind("e1", "original version", 1000, workspaceId, owner.userId).run();
    const first = await updateEntryContent(env, "e1", "first version", DEFAULTS, undefined, undefined, writeCtx, change, workspaceId);
    expect(first.status).toBe("updated");
    // Content changes again, so the eventual revert (back to "first version") needsReembed and the
    // UPDATE carries a vector_ids pin -- the exact condition the snapshot's own guard used to skip.
    const second = await updateEntryContent(env, "e1", "second version", DEFAULTS, undefined, undefined, writeCtx, change, workspaceId);
    expect(second.status).toBe("updated");
    const beforeRevert = await live("e1");

    // A concurrent write (a nightly re-embed, say) changes vector_ids right as the revert's own
    // snapshot statement is about to be prepared -- before the batch that carries both it and the
    // UPDATE ever runs.
    const racing = racingEnv(env, "INSERT INTO entry_versions", () => {
      sqlite.db.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', vector_ids = ? WHERE id = 'e1'`).bind(JSON.stringify(["raced-in"])).run();
    });

    const result = await revertEntry(racing, owner, "e1", change, DEFAULTS, undefined, workspaceId);
    // Whatever revertEntry reports, the row and its history must agree: either the revert fully
    // landed (content restored, one new version recorded) or it fully did not (content unchanged,
    // no phantom version) -- never a version claiming a revert the row itself never received.
    const row = await live("e1");
    const versions = await versionsOf("e1");
    const revertVersions = versions.filter(v => v.reason === "revert");
    if (row.content === beforeRevert.content) {
      expect(revertVersions).toHaveLength(0);
    } else {
      expect(row.content).toBe("first version");
      expect(revertVersions).toHaveLength(1);
    }
  });
});

describe("D2: releaseHeldAfterEdit's guard pins content, not just tags/workspace/vector_ids", () => {
  it("a concurrent content edit is never released as though it were the reviewed text", async () => {
    const change = { actorId: owner.userId, channel: "rest" as const };
    // A row held (version 1: the hold's own status snapshot, mirroring what holdStatements
    // itself writes), then edited while still held (D4.1: the hold stays, content changes) --
    // the exact "hold is not the newest version" shape releaseHeldAfterEdit exists for.
    await sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'api', ?, '[]', ?, ?)`,
    ).bind("e2", "held content", JSON.stringify(withHold(["work", "status:canonical"], "instruction")), 1000, workspaceId, owner.userId).run();
    // versioning: exempt: test seam only -- mirrors what holdStatements' own snapshot writes.
    await sqlite.db.prepare(
      `INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, state, actor_id, channel, reason, meta, valid_from, created_at)
       VALUES (?, ?, 1, NULL, ?, ?, '{}', ?, 'mcp', 'status', ?, ?, ?)`,
    ).bind("e2", workspaceId, "held content".length, JSON.stringify(["work", "status:canonical"]), owner.userId, JSON.stringify({ hold: { reasons: ["instruction"], score: 1.8, signals: ["I1"] } }), 1000, 1000).run();
    const edited = await updateEntryContent(env, "e2", "reviewed text", DEFAULTS, undefined, undefined, { workspaceId, actorId: owner.userId }, change, workspaceId);
    expect(edited.status).toBe("updated");

    const racing = racingEnv(env, "INSERT INTO entry_versions", () => {
      // A concurrent edit lands between releaseHeldAfterEdit's own read and its batch commit.
      sqlite.db.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', content = ? WHERE id = 'e2'`).bind("unreviewed replacement text").run();
    });

    const result = await revertEntry(racing, owner, "e2", change, DEFAULTS, undefined, workspaceId);
    const row = await live("e2");
    if (result.status === "released") {
      // A real release must never carry unreviewed text out as though it had been reviewed.
      expect(row.content).not.toBe("unreviewed replacement text");
    } else {
      // Lost the race: the row keeps whatever the concurrent edit left it as, not silently released.
      expect(row.content).toBe("unreviewed replacement text");
    }
  });
});

describe("D4: a vector_ids write is gated on INDEXABLE_SQL, checked at commit time", () => {
  it("storeEntry never lands vectors on a row a concurrent write deprecated mid-embed", async () => {
    const { storeEntry } = await import("../../src/capture/store");
    await sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, '[]', 'api', ?, '[]', ?, ?)`,
    ).bind("e3", "a note being embedded", 1000, workspaceId, owner.userId).run();

    // The row is deprecated (a contradiction landing, say) in the gap between storeEntry's own
    // embed call and its vector_ids UPDATE -- before that UPDATE's own prepare() ever runs.
    const racing = racingEnv(env, "UPDATE entries SET vector_ids = ?", () => {
      sqlite.db.prepare(`UPDATE entries SET write_marker = '${sqlite.fixtureMarker()}', tags = '["status:deprecated"]' WHERE id = 'e3'`).run();
    });

    const stored = await storeEntry(racing, "e3", "a note being embedded", [], "api", 2000, DEFAULTS, { workspaceId, actorId: owner.userId });

    expect(stored.committed).toBe(false);
    const row = await live("e3");
    // The deprecated row keeps its empty vector_ids -- the embed this call produced never landed.
    expect(JSON.parse(row.vector_ids)).toEqual([]);
  });
});
