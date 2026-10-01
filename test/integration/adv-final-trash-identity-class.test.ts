import { afterEach, expect, it, vi } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { createMember, cleanupMemberData } from "../../src/lib/team-admin";
import { resolveIdentityByUserId } from "../../src/lib/identity";
import { forgetEntry } from "../../src/capture/lifecycle";
import { getTrashedEntry, restoreEntry, deleteForever, purgeTrash } from "../../src/memory/trash";
import { DEFAULTS } from "../../src/config";

let t: TrashEnv;
afterEach(() => { t?.close(); vi.restoreAllMocks(); });

const forget = (id: string, actorId: string, workspaceId: string) =>
  forgetEntry(id, t.env, { actorId, channel: "rest" }, { reason: "forget", config: DEFAULTS, purge: false }, workspaceId);

/**
 * Structural coverage for adv-final MAJOR 1 ("restore can consume the wrong trash row"), treated
 * as a class: every trash mutation must be conditional on the exact row (or the exact current
 * workspace state) it acts on, never on an id alone or a stale earlier read. One test, one section
 * per mutation, each its own id so the four scenarios cannot interfere with each other.
 */
it("every trash mutation is conditional on the exact row it read or the workspace it is scoped to, not id alone", async () => {
  t = await makeTrashEnv();
  const owner = (await resolveIdentityByUserId(t.env, t.roots.ownerUserId))!;

  // 1. restore: a stale read must not consume a different member's trash row that later reused the same id.
  {
    const { member: bob } = await createMember(t.env, { name: "Bob-restore" });
    t.seed("id-restore", { content: "owner's memory" });
    await forget("id-restore", owner.userId, owner.personalWorkspaceId);
    const ownerRead = (await getTrashedEntry(t.env, owner, "id-restore"))!;

    // Interleaving: the owner's trash row expires and is purged; Bob captures and forgets the same id.
    await t.sqlite.deleteFixtureRows("DELETE FROM entries_trash WHERE id = ?", "id-restore");
    t.seed("id-restore", { content: "Bob's private memory", actor_id: bob.userId, workspace_id: bob.personalWorkspaceId });
    await forget("id-restore", bob.userId, bob.personalWorkspaceId);

    const result = await restoreEntry(t.env, ownerRead, { actorId: owner.userId, channel: "rest" }, DEFAULTS);
    expect(result.status).not.toBe("restored");
    expect(await t.one("SELECT id FROM entries WHERE id = ?", "id-restore")).toBeNull();
    expect(await t.one<{ workspace_id: string }>("SELECT workspace_id FROM entries_trash WHERE id = ?", "id-restore"))
      .toMatchObject({ workspace_id: bob.personalWorkspaceId });
  }

  // 2. Delete forever: a stale authorizedWorkspaceId must not permanently delete a different
  // member's trash row that later reused the same id.
  {
    const { member: bob } = await createMember(t.env, { name: "Bob-delete" });
    t.seed("id-delete", { content: "owner's memory" });
    await forget("id-delete", owner.userId, owner.personalWorkspaceId);
    const ownerRead = (await getTrashedEntry(t.env, owner, "id-delete"))!;

    await t.sqlite.deleteFixtureRows("DELETE FROM entries_trash WHERE id = ?", "id-delete");
    t.seed("id-delete", { content: "Bob's private memory", actor_id: bob.userId, workspace_id: bob.personalWorkspaceId });
    await forget("id-delete", bob.userId, bob.personalWorkspaceId);

    const result = await deleteForever(t.env, "id-delete", { actorId: owner.userId, channel: "rest" }, ownerRead.workspace_id, ownerRead.nonce);
    expect(result.status).not.toBe("deleted");
    expect(await t.one<{ workspace_id: string }>("SELECT workspace_id FROM entries_trash WHERE id = ?", "id-delete"))
      .toMatchObject({ workspace_id: bob.personalWorkspaceId });
  }

  // 3. Purge: a row that was a genuinely expired candidate when the nightly sweep read it, but got
  // replaced by a fresh, unexpired row under the same id before the delete batch actually ran, must survive.
  {
    const { member: bob } = await createMember(t.env, { name: "Bob-purge" });
    await t.sqlite.db.exec(
      `INSERT INTO entries_trash (id, workspace_id, actor_id, content, row_json, edges_json, vector_ids, deleted_at, deleted_by, channel, reason, write_marker)
       VALUES ('id-purge', '${t.roots.ownerPersonalWorkspaceId}', '', 'c', '{"created_at":1}', '[]', '[]', 1, '', 'rest', 'forget', '${t.sqlite.fixtureMarker()}')`,
    );

    const realBatch = t.env.DB.batch.bind(t.env.DB);
    let swapped = false;
    (t.env.DB as unknown as { batch: typeof realBatch }).batch = async (stmts) => {
      if (!swapped) {
        swapped = true;
        await t.sqlite.deleteFixtureRows("DELETE FROM entries_trash WHERE id = ?", "id-purge");
        t.seed("id-purge", { content: "Bob's fresh memory", actor_id: bob.userId, workspace_id: bob.personalWorkspaceId });
        await forget("id-purge", bob.userId, bob.personalWorkspaceId);
      }
      return realBatch(stmts);
    };
    try {
      await purgeTrash(t.env, DEFAULTS, { ceiling: 100, rowTarget: 5000, now: Date.now() });
    } finally {
      (t.env.DB as unknown as { batch: typeof realBatch }).batch = realBatch;
    }

    expect(await t.one<{ workspace_id: string }>("SELECT workspace_id FROM entries_trash WHERE id = ?", "id-purge"))
      .toMatchObject({ workspace_id: bob.personalWorkspaceId });
  }

  // 4. Member removal: the final sweep must act on the workspace's rows as they are when it runs,
  // not a pre-computed id list from earlier in the same call, and must never touch another workspace.
  {
    const { member: bob } = await createMember(t.env, { name: "Bob-removed" });
    t.seed("id-mr-old", { content: "old", workspace_id: bob.personalWorkspaceId, actor_id: bob.userId });
    await forget("id-mr-old", bob.userId, bob.personalWorkspaceId);
    t.seed("id-mr-owner", { content: "owner's own" });
    await forget("id-mr-owner", owner.userId, owner.personalWorkspaceId);

    const realBatch = t.env.DB.batch.bind(t.env.DB);
    let injected = false;
    (t.env.DB as unknown as { batch: typeof realBatch }).batch = async (stmts) => {
      // cleanupMemberData's final sweep is its only 6-statement batch; everything upstream (the
      // chunked version cleanup, and createMember/forgetEntry called from inside this hook) uses
      // .run() or a smaller batch, so this only fires once, right before the sweep itself.
      if (!injected && stmts.length === 6) {
        injected = true;
        t.seed("id-mr-new", { content: "forgotten after the scan", workspace_id: bob.personalWorkspaceId, actor_id: bob.userId });
        await forget("id-mr-new", bob.userId, bob.personalWorkspaceId);
      }
      return realBatch(stmts);
    };
    try {
      await cleanupMemberData(t.env, bob.userId, bob.personalWorkspaceId);
    } finally {
      (t.env.DB as unknown as { batch: typeof realBatch }).batch = realBatch;
    }

    expect(await t.one("SELECT id FROM entries_trash WHERE id = ?", "id-mr-old")).toBeNull();
    expect(await t.one("SELECT id FROM entries_trash WHERE id = ?", "id-mr-new")).toBeNull();
    expect(await t.one("SELECT id FROM entries_trash WHERE id = ?", "id-mr-owner")).not.toBeNull();
  }
});

/**
 * The follow-up finding (Codex re-check of 0436a226): rowid + deleted_at can BOTH collide when a
 * delete and a reuse land in the same millisecond and the deleted row was the table's own max
 * rowid — SQLite is then free to hand the very same rowid back to the next insert. Each section
 * below runs in its own fresh, otherwise-empty trash table (so the rowid it frees is guaranteed to
 * be reused) and freezes Date.now() so deleted_at collides too — the exact worst case the id-plus-
 * rowid-plus-deleted_at guard could not tell apart, which the nonce column (a fresh
 * crypto.randomUUID()/randomblob per row, never reused) always can.
 */
it("every trash mutation resists a same-millisecond, rowid-reusing row swap, not just a purge-and-reuse gap", async () => {
  // Large enough that a trash row seeded with deleted_at = 1 (section 3) is comfortably past
  // every retention/purge cutoff computed from it.
  const FROZEN = 1_700_000_000_000;

  // 1. Restore.
  {
    const env = await makeTrashEnv();
    try {
      vi.spyOn(Date, "now").mockReturnValue(FROZEN);
      const owner = (await resolveIdentityByUserId(env.env, env.roots.ownerUserId))!;
      const { member: bob } = await createMember(env.env, { name: "Bob" });
      env.seed("x", { content: "owner's memory" });
      await forgetEntry("x", env.env, { actorId: owner.userId, channel: "rest" }, { reason: "forget", config: DEFAULTS, purge: false }, owner.personalWorkspaceId);
      const ownerRead = (await getTrashedEntry(env.env, owner, "x"))!;
      const ownerRowid = (await env.one<{ rowid: number }>("SELECT rowid FROM entries_trash WHERE id = ?", "x"))!.rowid;

      await env.sqlite.deleteFixtureRows("DELETE FROM entries_trash WHERE id = ?", "x");
      env.seed("x", { content: "Bob's memory", actor_id: bob.userId, workspace_id: bob.personalWorkspaceId });
      await forgetEntry("x", env.env, { actorId: bob.userId, channel: "rest" }, { reason: "forget", config: DEFAULTS, purge: false }, bob.personalWorkspaceId);
      const bobTrash = (await env.one<{ rowid: number; deleted_at: number }>("SELECT rowid, deleted_at FROM entries_trash WHERE id = ?", "x"))!;
      expect(bobTrash).toMatchObject({ rowid: ownerRowid, deleted_at: ownerRead.deleted_at }); // the collision is real, not assumed

      const result = await restoreEntry(env.env, ownerRead, { actorId: owner.userId, channel: "rest" }, DEFAULTS);
      expect(result.status).not.toBe("restored");
      expect(await env.one("SELECT id FROM entries WHERE id = ?", "x")).toBeNull();
      expect(await env.one<{ workspace_id: string }>("SELECT workspace_id FROM entries_trash WHERE id = ?", "x")).toMatchObject({ workspace_id: bob.personalWorkspaceId });
    } finally {
      vi.restoreAllMocks();
      env.close();
    }
  }

  // 2. Delete forever.
  {
    const env = await makeTrashEnv();
    try {
      vi.spyOn(Date, "now").mockReturnValue(FROZEN);
      const owner = (await resolveIdentityByUserId(env.env, env.roots.ownerUserId))!;
      const { member: bob } = await createMember(env.env, { name: "Bob" });
      env.seed("x", { content: "owner's memory" });
      await forgetEntry("x", env.env, { actorId: owner.userId, channel: "rest" }, { reason: "forget", config: DEFAULTS, purge: false }, owner.personalWorkspaceId);
      const ownerRead = (await getTrashedEntry(env.env, owner, "x"))!;
      const ownerRowid = (await env.one<{ rowid: number }>("SELECT rowid FROM entries_trash WHERE id = ?", "x"))!.rowid;

      await env.sqlite.deleteFixtureRows("DELETE FROM entries_trash WHERE id = ?", "x");
      env.seed("x", { content: "Bob's memory", actor_id: bob.userId, workspace_id: bob.personalWorkspaceId });
      await forgetEntry("x", env.env, { actorId: bob.userId, channel: "rest" }, { reason: "forget", config: DEFAULTS, purge: false }, bob.personalWorkspaceId);
      const bobRowid = (await env.one<{ rowid: number }>("SELECT rowid FROM entries_trash WHERE id = ?", "x"))!.rowid;
      expect(bobRowid).toBe(ownerRowid); // the collision is real, not assumed

      const result = await deleteForever(env.env, "x", { actorId: owner.userId, channel: "rest" }, ownerRead.workspace_id, ownerRead.nonce);
      expect(result.status).not.toBe("deleted");
      expect(await env.one<{ workspace_id: string }>("SELECT workspace_id FROM entries_trash WHERE id = ?", "x")).toMatchObject({ workspace_id: bob.personalWorkspaceId });
    } finally {
      vi.restoreAllMocks();
      env.close();
    }
  }

  // 3. Purge: the candidate read and the delete batch straddle the same swap.
  {
    const env = await makeTrashEnv();
    try {
      vi.spyOn(Date, "now").mockReturnValue(FROZEN);
      const { member: bob } = await createMember(env.env, { name: "Bob" });
      await env.sqlite.db.exec(
        `INSERT INTO entries_trash (id, workspace_id, actor_id, content, row_json, edges_json, vector_ids, deleted_at, deleted_by, channel, reason, nonce, write_marker)
         VALUES ('x', '${env.roots.ownerPersonalWorkspaceId}', '', 'c', '{"created_at":1}', '[]', '[]', 1, '', 'rest', 'forget', lower(hex(randomblob(16))), '${env.sqlite.fixtureMarker()}')`,
      );
      const ownerRowid = (await env.one<{ rowid: number }>("SELECT rowid FROM entries_trash WHERE id = ?", "x"))!.rowid;

      const realBatch = env.env.DB.batch.bind(env.env.DB);
      let swapped = false;
      (env.env.DB as unknown as { batch: typeof realBatch }).batch = async (stmts) => {
        if (!swapped) {
          swapped = true;
          await env.sqlite.deleteFixtureRows("DELETE FROM entries_trash WHERE id = ?", "x");
          env.seed("x", { content: "Bob's fresh memory", actor_id: bob.userId, workspace_id: bob.personalWorkspaceId });
          await forgetEntry("x", env.env, { actorId: bob.userId, channel: "rest" }, { reason: "forget", config: DEFAULTS, purge: false }, bob.personalWorkspaceId);
        }
        return realBatch(stmts);
      };
      try {
        await purgeTrash(env.env, DEFAULTS, { ceiling: 100, rowTarget: 5000, now: FROZEN });
      } finally {
        (env.env.DB as unknown as { batch: typeof realBatch }).batch = realBatch;
      }
      const bobRow = (await env.one<{ rowid: number; workspace_id: string }>("SELECT rowid, workspace_id FROM entries_trash WHERE id = ?", "x"))!;
      expect(bobRow.rowid).toBe(ownerRowid); // the collision is real, not assumed
      expect(bobRow).toMatchObject({ workspace_id: bob.personalWorkspaceId });
    } finally {
      vi.restoreAllMocks();
      env.close();
    }
  }

  // 4. Member removal: the final sweep's own workspace scope, not any earlier-read row identity,
  // is what protects it — a rowid/deleted_at collision on an UNRELATED id changes nothing here.
  {
    const env = await makeTrashEnv();
    try {
      vi.spyOn(Date, "now").mockReturnValue(FROZEN);
      const owner = (await resolveIdentityByUserId(env.env, env.roots.ownerUserId))!;
      const { member: bob } = await createMember(env.env, { name: "Bob" });
      env.seed("owner-row", { content: "owner's own" });
      await forgetEntry("owner-row", env.env, { actorId: owner.userId, channel: "rest" }, { reason: "forget", config: DEFAULTS, purge: false }, owner.personalWorkspaceId);

      // A same-millisecond delete-and-reuse in Bob's own workspace, right before the final sweep:
      // the freed slot is Bob's own row's rowid (SQLite can only reuse a just-freed slot, not an
      // arbitrary occupied one, so the owner's still-live row is never the one reused here) — the
      // point is that SOME rowid collision happens right before the sweep, and the sweep's
      // protection (workspace scope, not row identity) must not care either way.
      env.seed("bob-row", { content: "bob's own", workspace_id: bob.personalWorkspaceId, actor_id: bob.userId });
      await forgetEntry("bob-row", env.env, { actorId: bob.userId, channel: "rest" }, { reason: "forget", config: DEFAULTS, purge: false }, bob.personalWorkspaceId);
      const bobRowidBefore = (await env.one<{ rowid: number }>("SELECT rowid FROM entries_trash WHERE id = ?", "bob-row"))!.rowid;
      await env.sqlite.deleteFixtureRows("DELETE FROM entries_trash WHERE id = ?", "bob-row");
      env.seed("bob-row", { content: "bob's own, again", workspace_id: bob.personalWorkspaceId, actor_id: bob.userId });
      await forgetEntry("bob-row", env.env, { actorId: bob.userId, channel: "rest" }, { reason: "forget", config: DEFAULTS, purge: false }, bob.personalWorkspaceId);
      const bobRowid = (await env.one<{ rowid: number }>("SELECT rowid FROM entries_trash WHERE id = ?", "bob-row"))!.rowid;
      expect(bobRowid).toBe(bobRowidBefore); // the collision is real, not assumed

      await cleanupMemberData(env.env, bob.userId, bob.personalWorkspaceId);

      expect(await env.one("SELECT id FROM entries_trash WHERE id = ?", "bob-row")).toBeNull();
      expect(await env.one("SELECT id FROM entries_trash WHERE id = ?", "owner-row")).not.toBeNull();
    } finally {
      vi.restoreAllMocks();
      env.close();
    }
  }
});
