/**
 * POST /update audits `updated` only when the write actually happened.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (p: Promise<unknown>) => { void p; } } as ExecutionContext;

describe("POST /update audit trail", () => {
  let sqlite: SqliteD1;
  let env: Env;
  let aiFails: boolean;

  beforeEach(async () => {
    resetDatabaseInit();
    aiFails = false;
    sqlite = makeSqliteD1();
    env = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
        upsert: vi.fn().mockResolvedValue({ mutationId: "m" }),
        insert: vi.fn().mockResolvedValue({ mutationId: "m" }),
      }),
      AI: {
        run: vi.fn().mockImplementation(async (model: string) => {
          if (aiFails) throw new Error("AI binding overloaded");
          if (model === "@cf/google/embeddinggemma-300m") return { data: [new Array(768).fill(0.1)] };
          return { response: '{"importance":2,"canonical":false,"kind":"semantic"}' };
        }),
      } as unknown as Ai,
    }));
    await initializeDatabase(env);
    await ensureTenantBootstrap(env);
  });

  afterEach(() => sqlite.close());

  async function updatedEvents(id?: string) {
    await new Promise(r => setTimeout(r, 10));
    const { results } = await env.DB.prepare(
      `SELECT entry_id, payload FROM entry_events WHERE event = 'updated'`,
    ).all();
    const rows = results as { entry_id: string; payload: string }[];
    return id ? rows.filter(r => r.entry_id === id) : rows;
  }

  async function seed(): Promise<string> {
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "Base memory for REST update audit" } }), env, ctx);
    return ((await res.json()) as { id: string }).id;
  }

  it("writes an updated event when the update succeeds", async () => {
    const id = await seed();
    const res = await worker.fetch(req("POST", "/update", { body: { id, content: "Replaced body for audit" } }), env, ctx);
    expect(res.status).toBe(200);
    const rows = await updatedEvents(id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload).channel).toBe("rest");
  });

  it("records channel rest on capture, append and forget too", async () => {
    const id = await seed();
    await worker.fetch(req("POST", "/append", { body: { id, addition: "more detail" } }), env, ctx);
    await worker.fetch(req("POST", "/forget", { body: { id } }), env, ctx);
    await new Promise(r => setTimeout(r, 10));
    const { results } = await env.DB.prepare(`SELECT event, payload FROM entry_events`).all();
    const rows = results as { event: string; payload: string }[];
    expect(rows.map(r => r.event).sort()).toEqual(["appended", "created", "deleted"]);
    for (const r of rows) expect(JSON.parse(r.payload).channel).toBe("rest");
  });

  it("writes no updated event when the re-embed fails", async () => {
    const id = await seed();
    aiFails = true;
    const res = await worker.fetch(req("POST", "/update", { body: { id, content: "Replaced body that cannot embed" } }), env, ctx);
    expect(res.status).toBe(500);
    expect(await updatedEvents(id)).toHaveLength(0);
  });

  it("writes no updated event for an entry that does not exist", async () => {
    const res = await worker.fetch(req("POST", "/update", { body: { id: "nope", content: "Replaced body" } }), env, ctx);
    expect(res.status).toBe(404);
    expect(await updatedEvents()).toHaveLength(0);
  });
});
