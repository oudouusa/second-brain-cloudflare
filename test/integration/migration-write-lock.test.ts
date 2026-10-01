import { describe, expect, it, vi } from "vitest";
import { makeSqliteD1 as makeSqliteD1Base } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/env";
import {
  assertMemoryWritesAllowed,
  acquireFinalDeltaLease,
  beginMemoryWriteAdmission,
  clearMemoryWriteLock,
  markMemoryWriteLockComplete,
  MemoryWriteLockedError,
  readMemoryWriteLock,
  readDerivedStateGeneration,
  releaseFinalDeltaLease,
  memoryWriteMarker,
  setMemoryWriteLock,
} from "../../src/migration/write-lock";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { clearMigration } from "../../src/migration/embedding";

const makeSqliteD1 = () => makeSqliteD1Base({ autoAdmitFixtureWrites: false });

describe("embedding cutover write lock", () => {
  it("並行した世代読取りは一致し、移行後は新しい世代を返す", async () => {
    const sqlite = makeSqliteD1();
    try {
      const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database });
      await initializeDatabase(env);
      await env.DB.prepare("DELETE FROM embedding_migration_generation").run();
      const generations = await Promise.all([
        readDerivedStateGeneration(env), readDerivedStateGeneration(env), readDerivedStateGeneration(env),
      ]);
      expect(new Set(generations).size).toBe(1);
      expect(generations[0]).toMatch(/^[a-f0-9-]{36}$/);
      await clearMigration(env);
      const current = await readDerivedStateGeneration(env);
      expect(current).not.toBe(generations[0]);
      expect(await readDerivedStateGeneration(env)).toBe(current);
    } finally {
      sqlite.close();
      resetDatabaseInit();
    }
  });

  it("preserves a committed response when admission release exhausts its retries", async () => {
    const env = makeTestEnv();
    const ctx = { waitUntil: (_promise: Promise<unknown>) => {} } as ExecutionContext;
    const tracked = await beginMemoryWriteAdmission(env, ctx);
    const originalPrepare = env.DB.prepare.bind(env.DB);
    let releaseAttempts = 0;
    env.DB.prepare = ((sql: string) => {
      if (!sql.startsWith("DELETE FROM memory_write_admissions WHERE token =")) {
        return originalPrepare(sql);
      }
      return {
        bind: () => ({
          run: async () => {
            releaseAttempts++;
            throw new Error("injected release failure");
          },
        }),
      } as unknown as D1PreparedStatement;
    }) as D1Database["prepare"];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(tracked.finish()).resolves.toBeUndefined();

    expect(releaseAttempts).toBe(3);
    expect(error).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("is strongly stored in D1 and explicitly reversible", async () => {
    const d1 = makeSqliteD1();
    const env = { DB: d1.db } as unknown as Env;
    resetDatabaseInit();
    await initializeDatabase(env);

    expect(await readMemoryWriteLock(env)).toBeNull();
    const lock = await setMemoryWriteLock(env, "final-delta");
    const deltaToken = await acquireFinalDeltaLease(env, lock.ownerId);
    expect(lock.reason).toBe("final-delta");
    expect(lock.ownerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readMemoryWriteLock(env)).toEqual(lock);
    await expect(assertMemoryWritesAllowed(env)).rejects.toBeInstanceOf(MemoryWriteLockedError);

    await releaseFinalDeltaLease(env, lock.ownerId, deltaToken);
    expect(await clearMemoryWriteLock(env, lock.ownerId, { force: true })).toBe(true);
    expect(await readMemoryWriteLock(env)).toBeNull();
    await expect(assertMemoryWritesAllowed(env)).resolves.toBeUndefined();
    d1.close();
  });

  it("admits only an owner-scoped derived-vector update while source fields stay fenced", async () => {
    const d1 = makeSqliteD1();
    const env = { DB: d1.db } as unknown as Env;
    resetDatabaseInit();
    await initializeDatabase(env);
    d1.seed({ id: "entry-1", content: "source is immutable", createdAt: 1 });
    const lock = await setMemoryWriteLock(env, "final-delta");
    const deltaToken = await acquireFinalDeltaLease(env, lock.ownerId);

    await expect(d1.db.prepare(`UPDATE entries SET content = ? WHERE id = ?`)
      .bind("must fail", "entry-1").run()).rejects.toThrow(/memory-write-locked/);
    await expect(d1.db.prepare(`UPDATE entries SET vector_ids = ? WHERE id = ?`)
      .bind('["unowned"]', "entry-1").run()).rejects.toThrow(/memory-write-locked/);
    await expect(d1.db.prepare(
      `UPDATE entries SET vector_ids = ?, migration_lease_owner = ? WHERE id = ?`,
    ).bind('["wrong"]', "wrong-owner", "entry-1").run()).rejects.toThrow(/memory-write-locked/);

    // The final delta must still be the sole derived-vector writer under the lock.
    // The fresh owner nonce, not a changed vector ID, is the privilege proof.
    await expect(d1.db.prepare(
      `UPDATE entries SET vector_ids = ?, migration_lease_owner = ? WHERE id = ?`,
    ).bind('[]', `${lock.ownerId}:${deltaToken}:test-nonce`, "entry-1").run()).resolves.toBeDefined();
    expect(d1.rows()[0]).toMatchObject({
      content: "source is immutable",
      vector_ids: '[]',
      migration_lease_owner: `${lock.ownerId}:${deltaToken}:test-nonce`,
    });
    await expect(d1.db.prepare(
      `UPDATE entries SET migration_lease_owner = ? WHERE id = ?`,
    ).bind(lock.ownerId, "entry-1").run()).rejects.toThrow(/memory-write-locked/);

    await releaseFinalDeltaLease(env, lock.ownerId, deltaToken);
    expect(await clearMemoryWriteLock(env, lock.ownerId, { force: true })).toBe(true);
    await expect(d1.db.prepare(
      `UPDATE entries SET vector_ids = ?, migration_lease_owner = ? WHERE id = ?`,
    ).bind('["after-unlock"]', `${lock.ownerId}:late`, "entry-1").run())
      .rejects.toThrow(/memory-write-locked/);
    // Unlocking does not revive anonymous SQL. A new current admission and a fresh
    // row marker are both required after the epoch rotation.
    await expect(d1.db.prepare(`UPDATE entries SET vector_ids = ? WHERE id = ?`)
      .bind('["anonymous"]', "entry-1").run()).rejects.toThrow(/memory-write-locked/);
    const ctx = { waitUntil: (_promise: Promise<unknown>) => {} } as ExecutionContext;
    const admitted = await beginMemoryWriteAdmission(env, ctx);
    await expect(d1.db.prepare(
      `UPDATE entries SET vector_ids = ?, write_marker = ? WHERE id = ?`,
    ).bind('["ordinary"]', memoryWriteMarker(admitted.env), "entry-1").run()).resolves.toBeDefined();
    await admitted.finish();
    d1.close();
  });

  it("rejects wrong and expired final-delta tokens at the SQL fence", async () => {
    const d1 = makeSqliteD1();
    const env = { DB: d1.db } as unknown as Env;
    resetDatabaseInit();
    await initializeDatabase(env);
    d1.seed({ id: "entry-1", content: "source", createdAt: 1 });
    const lock = await setMemoryWriteLock(env, "final-delta");
    const deltaToken = await acquireFinalDeltaLease(env, lock.ownerId);

    await expect(d1.db.prepare(
      `UPDATE entries SET vector_ids = ?, migration_lease_owner = ? WHERE id = ?`,
    ).bind('[]', `${lock.ownerId}:wrong-token:nonce`, "entry-1").run())
      .rejects.toThrow(/memory-write-locked/);

    await d1.db.prepare(
      `UPDATE migration_control SET active_delta_expires_at = 0 WHERE id = 'memory-write-lock'`,
    ).run();
    await expect(d1.db.prepare(
      `UPDATE entries SET vector_ids = ?, migration_lease_owner = ? WHERE id = ?`,
    ).bind('[]', `${lock.ownerId}:${deltaToken}:nonce`, "entry-1").run())
      .rejects.toThrow(/memory-write-locked/);

    // Recovery is explicit: once the operator has terminated the old request and the
    // lease is expired, force can remove the lock. A suspended old SQL marker remains
    // unusable after that removal, so it cannot resume with its stale privilege.
    expect(await clearMemoryWriteLock(env, lock.ownerId, { force: true })).toBe(true);
    await expect(d1.db.prepare(
      `UPDATE entries SET vector_ids = ?, migration_lease_owner = ? WHERE id = ?`,
    ).bind('[]', `${lock.ownerId}:${deltaToken}:late`, "entry-1").run())
      .rejects.toThrow(/memory-write-locked/);
    d1.close();
  });

  it("serializes final delta leases and refuses every unlock while one is active", async () => {
    const d1 = makeSqliteD1();
    const env = { DB: d1.db } as unknown as Env;
    resetDatabaseInit();
    await initializeDatabase(env);
    const lock = await setMemoryWriteLock(env, "final-delta");
    const firstToken = await acquireFinalDeltaLease(env, lock.ownerId);

    await expect(acquireFinalDeltaLease(env, lock.ownerId)).rejects
      .toBeInstanceOf(MemoryWriteLockedError);
    expect(await clearMemoryWriteLock(env, lock.ownerId, { force: true })).toBe(false);
    await expect(markMemoryWriteLockComplete(env, lock.ownerId, "wrong-token")).rejects
      .toBeInstanceOf(MemoryWriteLockedError);

    await markMemoryWriteLockComplete(env, lock.ownerId, firstToken);
    expect(await clearMemoryWriteLock(env, lock.ownerId)).toBe(false);
    await releaseFinalDeltaLease(env, lock.ownerId, firstToken);
    expect(await clearMemoryWriteLock(env, lock.ownerId)).toBe(true);
    d1.close();
  });

  it("claims a legacy ownerless lock once without rotating an existing owner", async () => {
    const d1 = makeSqliteD1();
    const env = { DB: d1.db } as unknown as Env;
    resetDatabaseInit();
    await initializeDatabase(env);
    await d1.db.prepare(
      `INSERT INTO migration_control (id, locked_at, reason, owner_id)
       VALUES ('memory-write-lock', 1, 'legacy', NULL)`,
    ).run();

    const claimed = await setMemoryWriteLock(env, "claimed");
    expect(claimed.ownerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await setMemoryWriteLock(env, "must-not-rotate")).toEqual(claimed);
    expect(await readMemoryWriteLock(env)).toEqual(claimed);
    d1.close();
  });

  it("ignores an expired R2 snapshot lease in both admission and the SQL trigger", async () => {
    const d1 = makeSqliteD1();
    const env = { DB: d1.db } as unknown as Env;
    resetDatabaseInit();
    await initializeDatabase(env);
    await d1.db.prepare(
      `INSERT INTO migration_control
         (id, locked_at, reason, owner_id, active_delta_expires_at)
       VALUES ('memory-write-lock', 1, 'r2-backup-snapshot', 'dead-worker', 1)`,
    ).run();

    expect(await readMemoryWriteLock(env)).toBeNull();
    const ctx = { waitUntil: (_promise: Promise<unknown>) => {} } as ExecutionContext;
    const admitted = await beginMemoryWriteAdmission(env, ctx);
    await expect(d1.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, write_marker)
       VALUES ('after-expiry', 'accepted', '[]', 'api', 1, '[]', ?)`,
    ).bind(memoryWriteMarker(admitted.env)).run()).resolves.toBeDefined();
    await admitted.finish();
    expect(d1.rows().map(row => row.id)).toContain("after-expiry");
    d1.close();
  });
});
