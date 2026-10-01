/**
 * Track 2 Task A8: D1 executions for the validity write path (spec 14 8.1), each against the same
 * operation with nothing for the hooks to do. A batch is one execution. Pins that live with their
 * feature: capture with a contradiction (supersede.test.ts, 9 -> 5), deprecate / forget / restore
 * (retraction-restore.test.ts), update with validity (validity-explicit.test.ts).
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { applyStatus } from "../../src/capture/lifecycle";
import { applyInsightResolution } from "../../src/memory/actions";
import { trashMirroredEntries } from "../../src/memory/trash";
import { revertEntry } from "../../src/memory/undo";
import { planSupersede, supersedeStatements, type Window } from "../../src/memory/validity";
import { DEFAULTS } from "../../src/config";
import type { Identity } from "../../src/lib/identity";

let t: TrashEnv;
afterEach(() => t?.close());
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const change = () => ({ actorId: t.roots.ownerUserId, channel: "rest" as const });
const owner = (): Identity => ({
  userId: t.roots.ownerUserId, role: "admin", personalWorkspaceId: t.roots.ownerPersonalWorkspaceId,
  companyWorkspaceIds: [t.roots.companyWorkspaceId], defaultShare: "",
});
const ws = () => t.roots.ownerPersonalWorkspaceId;

async function supersede(older: string, newer: string) {
  const win = async (id: string): Promise<Window> => {
    const r = (await t.one<any>(`SELECT * FROM entries WHERE id = ?`, id))!;
    return { id, from: r.valid_from ?? r.created_at, until: r.valid_until, workspaceId: r.workspace_id, status: null };
  };
  const o = await win(older);
  const n = await win(newer);
  await t.env.DB.batch(supersedeStatements(t.env, planSupersede(o, n), o, n, change(), DEFAULTS));
}

/** Executions of `run`, on a brain where `x` replaced `y` (`withHistory`) or has no history at all. */
async function cost(withHistory: boolean, extraTags = "[]", run: () => Promise<unknown>): Promise<number> {
  t?.close();
  t = await makeTrashEnv();
  t.seed("y", { created_at: 1000, tags: extraTags, source: extraTags === "[]" ? "api" : "system", actor_id: extraTags === "[]" ? t.roots.ownerUserId : "" });
  t.seed("x", { created_at: 2000, tags: extraTags, source: extraTags === "[]" ? "api" : "system", actor_id: extraTags === "[]" ? t.roots.ownerUserId : "" });
  if (withHistory) await supersede("y", "x");
  t.sqlite.executions.length = 0;
  await run();
  return t.sqlite.executions.length;
}

describe("Track 2 execution pins", () => {
  it("undo into 'wrong' and back: the hooks ride the revert batch and its own audit batch, 0 extra", async () => {
    const plain = await cost(false, "[]", async () => {
      await applyStatus("x", "deprecated", t.env, change(), DEFAULTS, ws());
      t.sqlite.executions.length = 0;
      await revertEntry(t.env, owner(), "x", change(), DEFAULTS, undefined, ws());
    });
    const hooked = await cost(true, "[]", async () => {
      await applyStatus("x", "deprecated", t.env, change(), DEFAULTS, ws());
      t.sqlite.executions.length = 0;
      const r = await revertEntry(t.env, owner(), "x", change(), DEFAULTS, undefined, ws());
      expect(r).toMatchObject({ validity: { reclosed: [{ id: "y" }] } });
    });
    expect(hooked).toBe(plain);
  });

  it("insight dismiss: one audit batch more only when a hook changed something", async () => {
    const dismiss = async () => {
      const found = await t.all<any>(`SELECT id, tags, vector_ids, workspace_id FROM entries WHERE id = 'x'`);
      t.sqlite.executions.length = 0;
      await applyInsightResolution(t.env, ctx, change(), found, 1, "dismiss");
    };
    const plain = await cost(false, '["auto-insight"]', dismiss);
    const hooked = await cost(true, '["auto-insight"]', dismiss);
    expect(hooked).toBe(plain + 1);
  });

  it("a disconnect purge page stays within 50 executions with the restore hook in every chunk", async () => {
    t?.close();
    t = await makeTrashEnv();
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      t.seed(`old${i}`, { created_at: 1000 + i, source: "notion" });
      t.seed(`m${i}`, { created_at: 5000 + i, source: "notion" });
      ids.push(`m${i}`);
    }
    for (let i = 0; i < 200; i++) await supersede(`old${i}`, `m${i}`);
    t.sqlite.executions.length = 0;
    const r = await trashMirroredEntries(t.env, owner(), ids, { provider: "notion" });
    expect(r.purged).toBe(200);
    expect(t.sqlite.executions.length).toBeLessThanOrEqual(50);
    expect((await t.one<any>(`SELECT COUNT(*) AS n FROM entries WHERE id LIKE 'old%' AND valid_until IS NULL`))!.n).toBe(200);
  });
});
