/**
 * #351: a mirror sync's updateEntry must stamp re-embedded vectors from the
 * row's own current workspace, not from the sync's write context. The
 * connection's mirrorWorkspace can still say "personal" after #347 moved the
 * row into company; the manual-edit path already stamps from the row
 * (embedContextForRow), and updateEntry now agrees with it.
 */
import { describe, it, expect, vi } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import type { D1Mock } from "../helpers/d1-mock";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { captureEntry } from "../../src/capture/entry";
import { moveEntry, restampVectorWorkspace } from "../../src/capture/share";
import { makeMirrorStore } from "../../src/integrations/mirror";
import type { Env } from "../../src/env";

function makeStatefulVectorizeMock() {
  const store = new Map<string, { id: string; values: number[]; metadata: Record<string, unknown> }>();
  const upsert = vi.fn(async (vectors: { id: string; values: number[]; metadata: Record<string, unknown> }[]) => {
    for (const v of vectors) store.set(v.id, { id: v.id, values: v.values, metadata: { ...v.metadata } });
    return { mutationId: "m" };
  });
  const getByIds = vi.fn(async (ids: string[]) => ids.map((id) => store.get(id)).filter((v): v is NonNullable<typeof v> => !!v));
  const vectorize = makeVectorizeMock({ upsert: upsert as never, getByIds: getByIds as never });
  return { vectorize, store };
}

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

describe("#351: mirror updateEntry stamps vectors from the row's own workspace", () => {
  it("updateEntry re-stamps vectors with the row's own workspace, not the sync's write context", async () => {
    const { vectorize, store } = makeStatefulVectorizeMock();
    const d1 = makeSqliteD1();
    let env = { ...makeTestEnv(d1.db as unknown as D1Mock, { VECTORIZE: vectorize, OAUTH_KV: makeMemoryKV() }), AUTH_TOKEN: "test-token" } as Env;
    resetDatabaseInit();
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    env = d1.admitEnv(env);
    const helper = makeCtx();

    await captureEntry("Mirrored page, later moved to company", [], "notion", env, helper.ctx, undefined, {
      workspaceId: roots.ownerPersonalWorkspaceId,
      actorId: roots.ownerUserId,
    });
    await helper.drain();
    const { id } = await env.DB.prepare(`SELECT id FROM entries WHERE source = 'notion' LIMIT 1`).first<{ id: string }>() ?? {};

    const moveResult = await moveEntry(id!, "company", env, {
      userId: roots.ownerUserId, role: "admin", personalWorkspaceId: roots.ownerPersonalWorkspaceId, companyWorkspaceIds: [roots.companyWorkspaceId],
    } as any, { actorId: roots.ownerUserId, channel: "rest" });
    expect(moveResult.status).toBe("shared");
    await restampVectorWorkspace(env, (moveResult as any).vectorIds, roots.companyWorkspaceId);

    // The connection still says personal, as a scheduled sync would resolve it.
    const staleWriteCtx = { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId };
    const mirrorStore = makeMirrorStore(env, staleWriteCtx);
    expect(await mirrorStore.updateEntry(id!, "Mirrored page, edited upstream after the move")).toBe("updated");

    const row = await env.DB.prepare(`SELECT workspace_id, vector_ids FROM entries WHERE id = ?`).bind(id!).first<{ workspace_id: string; vector_ids: string }>();
    expect(row!.workspace_id).toBe(roots.companyWorkspaceId);

    const newVectorIds: string[] = JSON.parse(row!.vector_ids || "[]");
    expect(newVectorIds.length).toBeGreaterThan(0);
    for (const vid of newVectorIds) {
      expect(store.get(vid)?.metadata.workspace_id).toBe(roots.companyWorkspaceId);
    }
  });
});
