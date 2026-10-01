import { afterEach, expect, it } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { resolveIdentityByUserId } from "../../src/lib/identity";
import { moveEntry } from "../../src/capture/share";
import { storeEntry } from "../../src/capture/store";
import { runNightlyVectorizePending } from "../../src/vectorize/pending";
import { DEFAULTS } from "../../src/config";

let t: TrashEnv;
afterEach(() => t?.close());

it("競合に負けたuploadのcleanupは勝者のuploadごとのvectorを削除しない", async () => {
  t = await makeTrashEnv();
  const content = "a deferred fact whose owner shares it";
  const createdAt = Date.now() - 60 * 60_000;
  t.seed("race", { content, created_at: createdAt });
  const owner = (await resolveIdentityByUserId(t.env, t.roots.ownerUserId))!;
  const present = new Map<string, string>();
  const upsert = t.env.VECTORIZE.upsert.bind(t.env.VECTORIZE);
  const remove = t.env.VECTORIZE.deleteByIds.bind(t.env.VECTORIZE);
  let moved = false;
  let winnerCommitted = false;
  let winnerStarted = false;
  (t.env.VECTORIZE as any).upsert = async (vectors: any[]) => {
    for (const v of vectors) present.set(v.id, v.metadata.workspace_id);
    const result = await upsert(vectors);
    if (!moved) {
      moved = true;
      expect((await moveEntry("race", "company", t.env, owner,
        { actorId: owner.userId, channel: "rest" })).status).toBe("shared");
    }
    return result;
  };
  (t.env.VECTORIZE as any).deleteByIds = async (ids: string[]) => {
    if (!winnerStarted) {
      winnerStarted = true;
      const winner = await storeEntry(t.env, "race", content, [], "api", createdAt, DEFAULTS,
        { workspaceId: t.roots.companyWorkspaceId, actorId: owner.userId });
      expect(winner.committed).toBe(true);
      winnerCommitted = true;
    }
    for (const id of ids) present.delete(id);
    return remove(ids);
  };

  await runNightlyVectorizePending(t.env, DEFAULTS);
  const row = (await t.one<{ vector_ids: string }>("SELECT vector_ids FROM entries WHERE id = 'race'"))!;
  const ids = JSON.parse(row.vector_ids) as string[];
  expect(winnerCommitted).toBe(true);
  // Per-upload vector ids (round 6): the winner's one vector, whatever its id, is the only one listed.
  expect(ids).toHaveLength(1);
  expect(ids.every(id => present.get(id) === t.roots.companyWorkspaceId)).toBe(true);
});
