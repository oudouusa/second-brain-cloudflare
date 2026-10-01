/**
 * The WriteContext contract: every entry write stamps its row with the workspace
 * and actor of whoever issued it, defaulting to OWNER_WRITE_CONTEXT ('', '') —
 * pre-team semantics — when a caller has not been threaded yet.
 *
 * Uses the real-SQLite facade because the subject IS the SQL: which values land
 * in which columns of db/schema.sql's entries table. A string-matched D1 mock
 * would pass whatever the fixture said and prove nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeKVMock, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/env";
import { DEFAULTS } from "../../src/config";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { captureEntry } from "../../src/capture/entry";
import { importExportPayload } from "../../src/entries/import";
import { OWNER_WRITE_CONTEXT } from "../../src/lib/scope";

function makeEmbedAI(): Ai {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/google/embeddinggemma-300m") return { data: [new Array(768).fill(0.1)] };
      // Non-embedding calls are the classifier, whose failures are non-fatal;
      // rejecting keeps the fixture minimal without affecting what we assert.
      throw new Error("no LLM in this fixture");
    }),
  } as unknown as Ai;
}

function makeSqliteEnv(db = makeSqliteD1()): { env: Env; d1: typeof db } {
  const env = {
    DB: db.db as unknown as Env["DB"],
    VECTORIZE: makeVectorizeMock(),
    AI: makeEmbedAI(),
    OAUTH_KV: makeKVMock(),
    AUTH_TOKEN: "test-token",
  } as Env;
  return { env, d1: db };
}

/** schema.sql predates the runtime ALTERs; init adds updated_at etc. Idempotent. */
async function makeReadyEnv(db = makeSqliteD1()) {
  const { env, d1 } = makeSqliteEnv(db);
  // The init memo is module-scoped, so each fresh in-memory DB needs its own pass.
  resetDatabaseInit();
  await initializeDatabase(env);
  return { env: d1.admitEnv(env), d1 };
}

function makeCtx(): ExecutionContext {
  return { waitUntil: () => {} } as unknown as ExecutionContext;
}

describe("WriteContext stamping", () => {
  it("captureEntry with a custom context stamps workspace_id and actor_id", async () => {
    const { env, d1 } = await makeReadyEnv();
    const result = await captureEntry(
      "team memory",
      [],
      "api",
      env,
      makeCtx(),
      DEFAULTS,
      { workspaceId: "ws-acme", actorId: "user-7" },
    );
    expect(result.status).toBe("stored");
    const row = await env.DB.prepare(`SELECT workspace_id, actor_id FROM entries WHERE id = ?`)
      .bind((result as { id: string }).id)
      .first<{ workspace_id: string; actor_id: string }>();
    expect(row?.workspace_id).toBe("ws-acme");
    expect(row?.actor_id).toBe("user-7");
    d1.close();
  });

  it("captureEntry with no context stamps '' and '' (owner semantics)", async () => {
    const { env, d1 } = await makeReadyEnv();
    const result = await captureEntry("legacy memory", [], "api", env, makeCtx(), DEFAULTS);
    expect(result.status).toBe("stored");
    const row = await env.DB.prepare(`SELECT workspace_id, actor_id FROM entries WHERE id = ?`)
      .bind((result as { id: string }).id)
      .first<{ workspace_id: string; actor_id: string }>();
    expect(row?.workspace_id).toBe(OWNER_WRITE_CONTEXT.workspaceId);
    expect(row?.actor_id).toBe(OWNER_WRITE_CONTEXT.actorId);
    d1.close();
  });

  it("imported rows carry an explicit writeCtx's workspace_id/actor_id", async () => {
    const { env, d1 } = await makeReadyEnv();
    const summary = await importExportPayload(
      env,
      { version: 2, entries: [{ id: "imp-1", content: "restored memory", tags: [] }] },
      { writeCtx: { workspaceId: "ws-bob", actorId: "user-bob" } },
    );
    expect(summary.imported).toBe(1);
    const row = await env.DB.prepare(`SELECT workspace_id, actor_id FROM entries WHERE id = 'imp-1'`)
      .first<{ workspace_id: string; actor_id: string }>();
    expect(row?.workspace_id).toBe("ws-bob");
    expect(row?.actor_id).toBe("user-bob");
    d1.close();
  });

  it("imported rows default to '' / '' when no context is threaded (pre-tenancy callers)", async () => {
    const { env, d1 } = await makeReadyEnv();
    const summary = await importExportPayload(
      env,
      { version: 2, entries: [{ id: "imp-2", content: "restored memory", tags: [] }] },
    );
    expect(summary.imported).toBe(1);
    const row = await env.DB.prepare(`SELECT workspace_id, actor_id FROM entries WHERE id = 'imp-2'`)
      .first<{ workspace_id: string; actor_id: string }>();
    expect(row?.workspace_id).toBe("");
    expect(row?.actor_id).toBe("");
    d1.close();
  });

  it("trusted restore preserves each entry and edge tenant context", async () => {
    const { env, d1 } = await makeReadyEnv();
    const payload = {
      version: 2,
      entries: [
        { id: "team-a", content: "Alice private", workspace_id: "ws-alice", actor_id: "user-alice" },
        { id: "team-b", content: "Alice related", workspace_id: "ws-alice", actor_id: "user-alice" },
      ],
      edges: [
        { id: "team-edge", source_id: "team-a", target_id: "team-b", workspace_id: "ws-alice" },
      ],
    };

    const entries = await importExportPayload(env, payload, { preserveWriteContext: true });
    expect(entries.imported).toBe(2);
    const edges = await importExportPayload(env, payload, {
      offset: payload.entries.length,
      preserveWriteContext: true,
    });
    expect(edges.edges_imported).toBe(1);

    const rows = (await env.DB.prepare(
      `SELECT id, workspace_id, actor_id FROM entries WHERE id IN ('team-a', 'team-b') ORDER BY id`,
    ).all()).results as { id: string; workspace_id: string; actor_id: string }[];
    expect(rows).toEqual([
      { id: "team-a", workspace_id: "ws-alice", actor_id: "user-alice" },
      { id: "team-b", workspace_id: "ws-alice", actor_id: "user-alice" },
    ]);
    const edge = await env.DB.prepare(`SELECT workspace_id FROM edges WHERE id = 'team-edge'`)
      .first<{ workspace_id: string }>();
    expect(edge?.workspace_id).toBe("ws-alice");
    d1.close();
  });

  it("trusted restoreはbatch失敗後の行別再試行でも各tenantとactorを保持する", async () => {
    const { env, d1 } = await makeReadyEnv();
    try {
      const realBatch = d1.db.batch.bind(d1.db);
      let rejected = false;
      d1.db.batch = async statements => {
        if (!rejected && statements.some(stmt => /INSERT INTO entries\s*\(/.test(stmt.sourceSql()))) {
          rejected = true;
          throw new Error("fixture: insert batch failed");
        }
        return realBatch(statements);
      };
      const summary = await importExportPayload(env, { entries: [
        { id: "alice", content: "private A", workspace_id: "ws-alice", actor_id: "user-alice" },
        { id: "bob", content: "private B", workspace_id: "ws-bob", actor_id: "user-bob" },
      ] }, { preserveWriteContext: true });
      expect(rejected).toBe(true);
      expect(summary).toMatchObject({ imported: 2, failed: 0 });
      const rows = (await env.DB.prepare("SELECT id, workspace_id, actor_id FROM entries ORDER BY id").all()).results;
      expect(rows).toEqual([
        { id: "alice", workspace_id: "ws-alice", actor_id: "user-alice" },
        { id: "bob", workspace_id: "ws-bob", actor_id: "user-bob" },
      ]);
    } finally { d1.close(); }
  });

  it("ordinary import ignores tenant metadata supplied by the payload", async () => {
    const { env, d1 } = await makeReadyEnv();
    const payload = {
      version: 2,
      entries: [
        { id: "safe-a", content: "A", workspace_id: "ws-forged", actor_id: "user-forged" },
        { id: "safe-b", content: "B", workspace_id: "ws-forged", actor_id: "user-forged" },
      ],
      edges: [
        { id: "safe-edge", source_id: "safe-a", target_id: "safe-b", workspace_id: "ws-forged" },
      ],
    };
    const writeCtx = { workspaceId: "ws-caller", actorId: "user-caller" };

    await importExportPayload(env, payload, { writeCtx });
    await importExportPayload(env, payload, { offset: payload.entries.length, writeCtx });

    const rows = (await env.DB.prepare(
      `SELECT workspace_id, actor_id FROM entries WHERE id IN ('safe-a', 'safe-b')`,
    ).all()).results as { workspace_id: string; actor_id: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.workspace_id === writeCtx.workspaceId && row.actor_id === writeCtx.actorId)).toBe(true);
    const edge = await env.DB.prepare(`SELECT workspace_id FROM edges WHERE id = 'safe-edge'`)
      .first<{ workspace_id: string }>();
    expect(edge?.workspace_id).toBe(writeCtx.workspaceId);
    d1.close();
  });
});
