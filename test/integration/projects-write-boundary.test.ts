import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, updateProject, deleteProject, ensureProject } from "../../src/projects/registry";
import { importExportPayload } from "../../src/entries/import";
import { acquireMemoryWriteAdmission, releaseMemoryWriteAdmission, memoryWriteMarker } from "../../src/migration/write-lock";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";

describe("Projectsの書込み排他", () => {
  let sq: ReturnType<typeof makeSqliteD1>;
  let env: ReturnType<typeof makeTestEnv>;
  beforeEach(() => {
    sq = makeSqliteD1({ autoAdmitFixtureWrites: false });
    env = makeTestEnv(undefined, { DB: sq.db as unknown as D1Database });
  });
  afterEach(() => sq.close());

  it("CRUDと自動作成に有効な許可が必要で、解放後の許可は再利用できない", async () => {
    await expect(createProject(env.DB, "a", { id: "site", name: "Site" }, env)).rejects.toThrow("memory-write-locked");
    const admission = await acquireMemoryWriteAdmission(env);
    const admitted = { ...env, WRITE_ADMISSION_TOKEN: admission.token };
    await createProject(env.DB, "a", { id: "site", name: "Site" }, admitted);
    await updateProject(env.DB, "a", "site", { aliases: ["web"] }, admitted);
    expect(await ensureProject(env.DB, "b", "site", admitted)).toBe(true);
    expect(await deleteProject(env.DB, "b", "site", admitted)).toBe(true);
    expect(await deleteProject(env.DB, "b", "site", admitted)).toBe(false);
    await releaseMemoryWriteAdmission(env, admission);
    await expect(updateProject(env.DB, "a", "site", { name: "Changed" }, admitted)).rejects.toThrow("memory-write-locked");
    await expect(deleteProject(env.DB, "a", "site", admitted)).rejects.toThrow("memory-write-locked");
    await expect(ensureProject(env.DB, "b", "new", admitted)).rejects.toThrow("memory-write-locked");
  });

  it("同じ行markerの再利用と、delete用途でないmarkerによる削除を拒否する", async () => {
    const admission = await acquireMemoryWriteAdmission(env);
    const admitted = { ...env, WRITE_ADMISSION_TOKEN: admission.token };
    await createProject(env.DB, "a", { id: "site", name: "Site" }, admitted);
    await expect(env.DB.prepare("UPDATE projects SET name = 'Changed' WHERE workspace_id = 'a' AND id = 'site'").run()).rejects.toThrow("memory-write-locked");
    await expect(env.DB.prepare("DELETE FROM projects WHERE workspace_id = 'a' AND id = 'site'").run()).rejects.toThrow("memory-write-locked");
  });

  it("復元中は通常更新を拒否し、有効な復元leaseによるINSERTだけを許可する", async () => {
    const admission = await acquireMemoryWriteAdmission(env);
    const admitted = { ...env, WRITE_ADMISSION_TOKEN: admission.token };
    await createProject(env.DB, "a", { id: "site", name: "Site" }, admitted);
    await env.DB.prepare(`INSERT INTO restore_state (id, backup_id, run_id, started_at, lease_owner, lease_expires_at)
      VALUES ('r2-v1', 'backup', 'run', ?, 'lease', ?)` ).bind(Date.now(), Date.now() + 60_000).run();
    await expect(updateProject(env.DB, "a", "site", { name: "Changed" }, admitted)).rejects.toThrow("memory-write-locked");
    await expect(deleteProject(env.DB, "a", "site", admitted)).rejects.toThrow("memory-write-locked");
    await expect(ensureProject(env.DB, "a", "other", admitted)).rejects.toThrow("memory-write-locked");
    const payload = { version: 3, entries: [], projects: [{ id: "site", workspace_id: "b", name: "Restored" }] };
    const result = await importExportPayload(env, payload, { writeLockOwner: "run", restoreLeaseOwner: "lease", preserveWriteContext: true });
    expect(result).toMatchObject({ projects_imported: 1, remaining_projects: 0 });
    await env.DB.prepare("UPDATE restore_state SET lease_expires_at = 0 WHERE id = 'r2-v1'").run();
    await expect(env.DB.prepare(`INSERT INTO projects (id, workspace_id, name, created_at, restore_lease_owner, write_marker)
      VALUES ('expired', 'b', 'Expired', 1, 'lease', ?)` ).bind(memoryWriteMarker(admitted)).run()).rejects.toThrow("memory-write-locked");
  });

  it("復元ページのbatchが排他で失敗したら行ごとの再試行をしない", async () => {
    const admitted = sq.admitEnv(env);
    let batches = 0;
    const failing = { ...admitted, DB: { ...admitted.DB, batch: async () => { batches++; throw new Error("memory-write-locked"); } } as unknown as D1Database };
    await expect(importExportPayload(failing, { version: 3, entries: [], projects: [{ id: "site", name: "Site" }] })).rejects.toThrow("memory-write-locked");
    expect(batches).toBe(1);
    expect((await env.DB.prepare("SELECT id FROM projects").all()).results).toEqual([]);
  });
});
