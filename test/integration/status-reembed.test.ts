/**
 * BE-9 (T-0101.8.2): leaving "deprecated" for any other status re-embeds before the status
 * commits, so the entry does not sit un-deprecated with the stale empty index deprecateEntry left
 * behind on the way in. Real SQLite: applyStatus's guarded UPDATE now sets tags and vector_ids
 * together, a SQL shape a hand-matched mock cannot tell apart from a no-op.
 */
import { DEFAULTS } from "../../src/config";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { applyStatus } from "../../src/capture/lifecycle";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let upsertMock: any;

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  upsertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
  env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ upsert: upsertMock }),
  }));
  await initializeDatabase(env);
  await sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'api', ?, ?, ?, '', 'u1')`,
  ).bind("entry-1", "Some important work content", JSON.stringify(["work", "status:deprecated"]), 1000, null, "[]").run();
});
afterEach(() => sqlite.close());

const row = async () => (await sqlite.db.prepare(`SELECT * FROM entries WHERE id = 'entry-1'`).first()) as Record<string, any>;

describe("applyStatus() leaving deprecated", () => {
  it("deprecated to canonical re-embeds and is found by recall", async () => {
    const result = await applyStatus("entry-1", "canonical", env, { actorId: "u1", channel: "rest" }, DEFAULTS, "");
    expect(result).toEqual({ status: "ok", indexed: true, validity: expect.any(Object), eventId: expect.any(String) });
    expect(upsertMock).toHaveBeenCalled();

    const r = await row();
    const tags: string[] = JSON.parse(r.tags);
    expect(tags).toContain("status:canonical");
    expect(tags).not.toContain("status:deprecated");
    const vectorIds: string[] = JSON.parse(r.vector_ids);
    expect(vectorIds.length).toBeGreaterThan(0);
  });

  it("re-embed failure leaves status and vectors unchanged", async () => {
    upsertMock.mockRejectedValue(new Error("transient Vectorize error"));
    const result = await applyStatus("entry-1", "canonical", env, { actorId: "u1", channel: "rest" }, DEFAULTS, "");
    expect(result).toEqual({ status: "reembed_failed" });

    const r = await row();
    const tags: string[] = JSON.parse(r.tags);
    expect(tags).toContain("status:deprecated");
    expect(r.vector_ids).toBe("[]");
  });

  it("keyword-only when Vectorize is missing, indexed false", async () => {
    env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(), VECTORIZE: undefined as any }));
    const result = await applyStatus("entry-1", "draft", env, { actorId: "u1", channel: "rest" }, DEFAULTS, "");
    expect(result).toEqual({ status: "ok", indexed: false, validity: expect.any(Object), eventId: expect.any(String) });

    const r = await row();
    const tags: string[] = JSON.parse(r.tags);
    expect(tags).toContain("status:draft");
    // Committed keyword-only: vector_ids stays empty rather than the write failing outright.
    expect(r.vector_ids).toBe("[]");
  });

  it("canonical to draft does not embed", async () => {
    await sqlite.db.prepare(`UPDATE entries SET tags = ? WHERE id = 'entry-1'`).bind(JSON.stringify(["work", "status:canonical"])).run();
    const result = await applyStatus("entry-1", "draft", env, { actorId: "u1", channel: "rest" }, DEFAULTS, "");
    expect(result).toEqual({ status: "ok", indexed: false, validity: expect.any(Object), eventId: expect.any(String) });
    expect(upsertMock).not.toHaveBeenCalled();

    const r = await row();
    const tags: string[] = JSON.parse(r.tags);
    expect(tags).toContain("status:draft");
  });
});
