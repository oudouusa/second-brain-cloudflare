import { afterEach, expect, it, vi } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId } from "../../src/lib/identity";
import { forgetEntry } from "../../src/capture/lifecycle";
import { deleteForever, getTrashedEntry, restoreEntry } from "../../src/memory/trash";
import { DEFAULTS } from "../../src/config";

let t: TrashEnv;
afterEach(() => { t?.close(); vi.restoreAllMocks(); });

it("a stale restore cannot restore a different member's new trash row with the same id", async () => {
  t = await makeTrashEnv();
  const owner = (await resolveIdentityByUserId(t.env, t.roots.ownerUserId))!;
  const { member: bob } = await createMember(t.env, { name: "Bob" });

  t.seed("reused", { content: "owner's memory" });
  await forgetEntry("reused", t.env, { actorId: owner.userId, channel: "rest" },
    { reason: "forget", config: DEFAULTS, purge: false }, owner.personalWorkspaceId);
  const ownerRead = (await getTrashedEntry(t.env, owner, "reused"))!;

  // Interleaving: the old trash expires and is purged; Bob imports the same id and forgets it.
  await t.sqlite.deleteFixtureRows("DELETE FROM entries_trash WHERE id = ?", "reused");
  t.seed("reused", { content: "Bob's private memory", actor_id: bob.userId,
    workspace_id: bob.personalWorkspaceId });
  await forgetEntry("reused", t.env, { actorId: bob.userId, channel: "rest" },
    { reason: "forget", config: DEFAULTS, purge: false }, bob.personalWorkspaceId);

  const result = await restoreEntry(t.env, ownerRead, { actorId: owner.userId, channel: "rest" }, DEFAULTS);
  expect(await t.one("SELECT id FROM entries WHERE id = ?", "reused")).toBeNull();
  expect(result.status).not.toBe("restored");
  expect(await t.one<{ workspace_id: string }>("SELECT workspace_id FROM entries_trash WHERE id = ?", "reused"))
    .toMatchObject({ workspace_id: bob.personalWorkspaceId });
});

it("same-millisecond Delete forever and ID reuse cannot pass the stale restore rowid guard", async () => {
  t = await makeTrashEnv();
  vi.spyOn(Date, "now").mockReturnValue(1_000_000_000);
  const owner = (await resolveIdentityByUserId(t.env, t.roots.ownerUserId))!;
  const { member: bob } = await createMember(t.env, { name: "Bob" });
  t.seed("same-ms", { content: "owner's memory" });
  await forgetEntry("same-ms", t.env, { actorId: owner.userId, channel: "rest" },
    { reason: "forget", config: DEFAULTS, purge: false }, owner.personalWorkspaceId);
  const ownerRead = (await getTrashedEntry(t.env, owner, "same-ms"))!;
  // Raw, not through TrashedEntryRow (adv-final MAJOR 1 follow-up): rowid is no longer part of
  // that type, since the fix below no longer trusts it — this is only proving the exploit's own
  // setup produces a genuine rowid collision, not something the fix needs to consult.
  const ownerRowid = (await t.one<{ rowid: number }>("SELECT rowid FROM entries_trash WHERE id = ?", "same-ms"))!.rowid;

  expect((await deleteForever(t.env, "same-ms", { actorId: owner.userId, channel: "rest" },
    owner.personalWorkspaceId, ownerRead.nonce)).status).toBe("deleted");
  t.seed("same-ms", { content: "Bob's private memory", actor_id: bob.userId,
    workspace_id: bob.personalWorkspaceId });
  await forgetEntry("same-ms", t.env, { actorId: bob.userId, channel: "rest" },
    { reason: "forget", config: DEFAULTS, purge: false }, bob.personalWorkspaceId);
  const bobTrash = (await t.one<{ rowid: number; deleted_at: number }>(
    "SELECT rowid, deleted_at FROM entries_trash WHERE id = ?", "same-ms"))!;
  expect(bobTrash).toMatchObject({ rowid: ownerRowid, deleted_at: ownerRead.deleted_at });

  const result = await restoreEntry(t.env, ownerRead, { actorId: owner.userId, channel: "rest" }, DEFAULTS);
  expect(result.status).not.toBe("restored");
  expect(await t.one("SELECT id FROM entries WHERE id = ?", "same-ms")).toBeNull();
});
