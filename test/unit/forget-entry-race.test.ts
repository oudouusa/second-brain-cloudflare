/**
 * forgetEntry reports `deleted` only when its batch's entries DELETE removed a row, so two racing
 * deleters (a sync and a purge) cannot both claim, and audit, one deletion.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { forgetEntry } from "../../src/capture/lifecycle";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { makeVectorizeMock } from "../helpers/make-env";
import { resolveConfig } from "../../src/config";

let t: TrashEnv;
afterEach(() => t?.close());

async function forget(id: string) {
  return forgetEntry(id, t.env, { actorId: "", channel: "rest" }, { reason: "forget", config: await resolveConfig(t.env), purge: false }, t.roots.ownerPersonalWorkspaceId);
}

describe("forgetEntry", () => {
  it("reports deleted when the batch removed the row", async () => {
    t = await makeTrashEnv();
    t.seed("x", { vector_ids: '["v1"]' });
    expect(await forget("x")).toEqual({ status: "deleted", vectorCount: 1, trashed: true, edgesDropped: false, validity: expect.any(Object) });
  });

  it("reports not_found, and touches no vectors, when a racing deleter got there first", async () => {
    const deleteByIds = vi.fn().mockResolvedValue({});
    t = await makeTrashEnv({ VECTORIZE: makeVectorizeMock({ deleteByIds }) });
    t.seed("x", { vector_ids: '["v1"]' });
    // The row is deleted between forget's read and its batch.
    const real = t.sqlite.db.batch.bind(t.sqlite.db);
    (t.sqlite.db as any).batch = async (stmts: unknown[]) => {
      await t.sqlite.deleteFixtureRows(`DELETE FROM entries WHERE id = 'x'`);
      return real(stmts as any);
    };
    expect(await forget("x")).toEqual({ status: "not_found" });
    expect(deleteByIds).not.toHaveBeenCalled();
    // The racing deleter's row is not resurrected into the trash.
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'x'`)).toBeNull();
  });

  it("never half-applies its batch when a share/unshare races it out of the caller's workspace (Codex review, T-0102, director follow-up MAJOR)", async () => {
    // The row's early workspace check (line 52 above) passes at read time, then a share/unshare
    // moves the row to a different workspace before the batch commits -- the same gap R2-3 already
    // named for the entries DELETE alone. Every statement in trashManyStatements' batch (the trash
    // INSERT, the version DELETE, the edges DELETE and the entries DELETE) must now share the
    // identical (id, workspace) guard, so a race that defeats one defeats all of them: the row, its
    // edges and its version history stay exactly as they were, not half-removed.
    t = await makeTrashEnv();
    t.seed("x", { vector_ids: "[]" });
    t.seed("y", { vector_ids: "[]" });
    t.edge("e1", "x", "y");
    t.version("x", 1);
    const movedTo = t.roots.companyWorkspaceId;
    const real = t.sqlite.db.batch.bind(t.sqlite.db);
    (t.sqlite.db as any).batch = async (stmts: unknown[]) => {
      await t.sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'x'`).bind(movedTo).run();
      return real(stmts as any);
    };
    expect(await forget("x")).toEqual({ status: "not_found" });
    expect(await t.one(`SELECT id FROM entries WHERE id = 'x'`)).not.toBeNull();
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'x'`)).toBeNull();
    expect(await t.one(`SELECT id FROM edges WHERE id = 'e1'`)).not.toBeNull();
    expect(await t.one(`SELECT entry_id FROM entry_versions WHERE entry_id = 'x' AND seq = 1`)).not.toBeNull();
  });
});
