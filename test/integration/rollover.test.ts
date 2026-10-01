import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import {
  rolloverEntry,
  RolloverAlreadyExistsError,
  RolloverNotNeededError,
  RolloverOperationConflictError,
  RolloverSourceChangedError,
} from "../../src/memory/rollover";
import { makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { forgetEntry } from "../../src/capture/lifecycle";
import { DEFAULTS } from "../../src/config";
import worker from "../../src/index";

describe("non-destructive memory rollover", () => {
  let sqlite: SqliteD1;
  let env: Env;
  let pending: Promise<unknown>[];
  let ctx: ExecutionContext;

  beforeEach(() => {
    sqlite = makeSqliteD1();
    env = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as unknown as D1Database,
    }));
    pending = [];
    ctx = { waitUntil: promise => { pending.push(promise); } } as ExecutionContext;
  });

  afterEach(async () => {
    await Promise.allSettled(pending);
    sqlite.close();
  });

  async function seedLongSource(id = "source", length = 8_000): Promise<void> {
    sqlite.seed({
      id,
      content: "x".repeat(length),
      createdAt: 1_700_000_000_000,
      tags: ["work", "kind:semantic", "rolled-up", "stale:as-of", "volatility:state"],
      vectorIds: ["source-vector"],
      importanceScore: 4,
    });
    await env.DB.prepare(
      `UPDATE entries SET memory_tier = ?, pinned = ?, write_marker = ? WHERE id = ?`,
    ).bind("hot", 1, `${env.WRITE_ADMISSION_TOKEN}:write:seed-tier`, id).run();
  }

  it("preserves the journal, creates a bounded continuation and records both provenance links", async () => {
    await seedLongSource();

    const result = await rolloverEntry(env, "source", "Current state: rollout is ready.", ctx, undefined, {
      operationId: "rollover-once",
      writeContext: { workspaceId: "", actorId: "owner" },
    });
    await Promise.allSettled(pending.splice(0));

    expect(result).toMatchObject({
      sourceId: "source",
      sourceChars: 8_000,
      snapshotChars: 32,
      replayed: false,
      indexingScheduled: true,
    });
    const rows = sqlite.rows();
    expect(rows).toHaveLength(2);
    const source = rows.find(row => row.id === "source")!;
    const continuation = rows.find(row => row.id === result.id)!;
    expect(source.content).toBe("x".repeat(8_000));
    expect(source.memory_tier).toBe("cold");
    expect(source.pinned).toBe(0);
    expect(continuation).toMatchObject({
      content: "Current state: rollout is ready.",
      source: "api",
      memory_tier: "hot",
      pinned: 1,
      importance_score: 4,
      actor_id: "owner",
    });
    expect(JSON.parse(String(continuation.tags))).toEqual([
      "work",
      "kind:semantic",
      "volatility:state",
    ]);
    expect(JSON.parse(String(continuation.vector_ids))).toHaveLength(1);

    const edges = await env.DB.prepare(
      `SELECT source_id, target_id, type, provenance, metadata FROM edges ORDER BY type`,
    ).all<{ source_id: string; target_id: string; type: string; provenance: string; metadata: string }>();
    expect(edges.results).toHaveLength(2);
    expect(edges.results.map(edge => edge.type).sort()).toEqual(["drawn_from", "follows"]);
    expect(edges.results.every(edge => edge.source_id === result.id && edge.target_id === "source")).toBe(true);
    expect(edges.results.every(edge => edge.provenance === "system")).toBe(true);
    const receipt = edges.results.find(edge => edge.type === "drawn_from")!;
    expect(JSON.parse(receipt.metadata)).toMatchObject({
      rollover: { version: 1, sourceChars: 8_000 },
    });
  });

  it("trashに残る継続IDを再利用せず、原本と削除済み履歴を保持する", async () => {
    await seedLongSource();
    const options = { operationId: "trashed-rollover", writeContext: { workspaceId: "", actorId: "owner" } };
    const first = await rolloverEntry(env, "source", "Current state", ctx, DEFAULTS, options);
    await Promise.allSettled(pending.splice(0));
    await forgetEntry(first.id, env, { actorId: "owner", channel: "rest" }, { reason: "forget", config: DEFAULTS, purge: false }, "");
    const before = sqlite.rows().find(row => row.id === "source");
    await expect(rolloverEntry(env, "source", "Current state", ctx, DEFAULTS, options)).rejects.toThrow();
    expect(sqlite.rows().find(row => row.id === "source")).toEqual(before);
    expect(sqlite.rows().some(row => row.id === first.id)).toBe(false);
    expect((await env.DB.prepare("SELECT id FROM entries_trash WHERE id = ?").bind(first.id).first())).toEqual({ id: first.id });
  });

  it("exposes the same operation through the authenticated REST route", async () => {
    await seedLongSource("rest-source");

    const response = await worker.fetch(new Request("http://localhost/rollover", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        id: "rest-source",
        snapshot: "REST current state",
        operation_id: "rest-rollover",
      }),
    }), env, ctx);
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      source_id: "rest-source",
      replayed: false,
      source_chars: 8_000,
      snapshot_chars: 18,
      indexing_scheduled: true,
    });
    expect(sqlite.rows().some(row => row.id === body.id && row.content === "REST current state")).toBe(true);
  });

  it("replays the same operation without a duplicate and rejects a different payload", async () => {
    await seedLongSource();
    const options = {
      operationId: "stable-operation",
      writeContext: { workspaceId: "", actorId: "owner" },
    } as const;

    const first = await rolloverEntry(env, "source", "Current snapshot", ctx, undefined, options);
    const replay = await rolloverEntry(env, "source", "Current snapshot", ctx, undefined, options);

    expect(replay).toMatchObject({ id: first.id, replayed: true, indexingScheduled: false });
    expect(sqlite.rows()).toHaveLength(2);
    await expect(
      rolloverEntry(env, "source", "Different snapshot", ctx, undefined, options),
    ).rejects.toBeInstanceOf(RolloverOperationConflictError);

    await expect(rolloverEntry(env, "source", "Another branch", ctx, undefined, {
      operationId: "different-operation",
      writeContext: { workspaceId: "", actorId: "owner" },
    })).rejects.toMatchObject({
      constructor: RolloverAlreadyExistsError,
      continuationId: first.id,
    });
  });

  it("refuses to split a short entry", async () => {
    sqlite.seed({ id: "short", content: "x".repeat(7_999), createdAt: 1_700_000_000_000 });

    await expect(rolloverEntry(env, "short", "Snapshot", ctx, undefined, {
      operationId: "too-early",
      writeContext: { workspaceId: "", actorId: "owner" },
    })).rejects.toBeInstanceOf(RolloverNotNeededError);
    expect(sqlite.rows()).toHaveLength(1);
  });

  it("bounds idempotency keys in the domain helper as well as at transport edges", async () => {
    await seedLongSource();

    await expect(rolloverEntry(env, "source", "Snapshot", ctx, undefined, {
      operationId: "x".repeat(129),
      writeContext: { workspaceId: "", actorId: "owner" },
    })).rejects.toMatchObject({ name: "MemoryInputError", status: 400 });
    expect(sqlite.rows()).toHaveLength(1);
  });

  it("rolls back when the source changes between the read and atomic batch", async () => {
    await seedLongSource();
    const baseDb = env.DB;
    let changed = false;
    let rolloverPrepared = false;
    env = Object.assign(Object.create(env), {
      DB: {
        prepare(sql: string) {
          if (/^INSERT INTO entries\s/.test(sql)) rolloverPrepared = true;
          return baseDb.prepare(sql);
        },
        exec: baseDb.exec.bind(baseDb),
        batch: async (statements: D1PreparedStatement[]) => {
          if (!changed && rolloverPrepared) {
            changed = true;
            await baseDb.prepare(
              `UPDATE entries SET content = ?, write_marker = ? WHERE id = ?`,
            ).bind("concurrent winner", `${env.WRITE_ADMISSION_TOKEN}:write:concurrent`, "source").run();
          }
          return baseDb.batch(statements);
        },
      },
    }) as Env;

    await expect(rolloverEntry(env, "source", "Snapshot", ctx, undefined, {
      operationId: "losing-rollover",
      writeContext: { workspaceId: "", actorId: "owner" },
    })).rejects.toBeInstanceOf(RolloverSourceChangedError);
    expect(changed).toBe(true);
    expect(sqlite.rows()).toHaveLength(1);
    expect(sqlite.rows()[0]).toMatchObject({ content: "concurrent winner", memory_tier: "hot", pinned: 1 });
    const edges = await baseDb.prepare(`SELECT id FROM edges`).all();
    expect(edges.results).toHaveLength(0);
  });

  it("keeps the D1 snapshot when deferred semantic indexing fails", async () => {
    await seedLongSource();
    env = Object.assign(Object.create(env), {
      AI: { run: vi.fn().mockRejectedValue(new Error("Workers AI unavailable")) },
    }) as Env;

    const result = await rolloverEntry(env, "source", "Keyword-safe snapshot", ctx, undefined, {
      operationId: "degraded-rollover",
      writeContext: { workspaceId: "", actorId: "owner" },
    });
    await Promise.allSettled(pending.splice(0));

    expect(result.indexingScheduled).toBe(true);
    const continuation = sqlite.rows().find(row => row.id === result.id)!;
    expect(continuation.content).toBe("Keyword-safe snapshot");
    expect(continuation.vector_ids).toBe("[]");
  });
});
