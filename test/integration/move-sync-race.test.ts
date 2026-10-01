/** 移動後の同期はD1の現在の保存先で索引を更新し、古い同期設定へ戻さない。 */
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

describe("移動後の再同期で保存先を維持する", () => {
  it("古い同期設定でもD1の現在の保存先を索引に反映する", async () => {
    const { vectorize, store } = makeStatefulVectorizeMock();
    const d1 = makeSqliteD1();
    let env = { ...makeTestEnv(d1.db as unknown as D1Mock, { VECTORIZE: vectorize, OAUTH_KV: makeMemoryKV() }), AUTH_TOKEN: "test-token" } as Env;
    resetDatabaseInit();
    await initializeDatabase(env);
    env = d1.admitEnv(env);
    const roots = await ensureTenantBootstrap(env);
    const helper = makeCtx();

    await captureEntry("Mirrored page, later moved by #347", [], "notion", env, helper.ctx, undefined, {
      workspaceId: roots.ownerPersonalWorkspaceId,
      actorId: roots.ownerUserId,
    });
    await helper.drain();
    const { id } = await env.DB.prepare(`SELECT id FROM entries WHERE source = 'notion' LIMIT 1`).first<{ id: string }>() ?? {};

    // #347 moves it into company and correctly re-stamps its vectors —
    // establishing the state a completed move actually leaves behind.
    const moveResult = await moveEntry(id!, "company", env, {
      userId: roots.ownerUserId, role: "admin", personalWorkspaceId: roots.ownerPersonalWorkspaceId, companyWorkspaceIds: [roots.companyWorkspaceId],
    } as any, { actorId: "", channel: "rest" as const });
    expect(moveResult.status).toBe("shared");
    await restampVectorWorkspace(env, (moveResult as any).vectorIds, roots.companyWorkspaceId);
    for (const vid of (moveResult as any).vectorIds) {
      expect(store.get(vid)?.metadata.workspace_id).toBe(roots.companyWorkspaceId); // correct, post-move
    }

    // The connection's OWN setting is still "personal" (#347 never touches
    // it) — exactly what a scheduled sync resolves its write context from.
    const staleWriteCtx = { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId };
    const mirrorStore = makeMirrorStore(env, staleWriteCtx);
    const updated = await mirrorStore.updateEntry(id!, "Mirrored page, edited upstream after the move");
    expect(updated).toBe("updated");

    const row = await env.DB.prepare(`SELECT workspace_id, vector_ids FROM entries WHERE id = ?`).bind(id!).first<{ workspace_id: string; vector_ids: string }>();
    // The D1 row itself is untouched by updateEntry, as documented — it is
    // still correctly in company.
    expect(row!.workspace_id).toBe(roots.companyWorkspaceId);

    const newVectorIds: string[] = JSON.parse(row!.vector_ids || "[]");
    for (const vid of newVectorIds) {
      // 元のpersonal設定ではなく、移動済みのcompanyを保持する。
      expect(store.get(vid)?.metadata.workspace_id).toBe(roots.companyWorkspaceId);
    }
  });
});
