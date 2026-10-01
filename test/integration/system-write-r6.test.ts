import { describe, it, expect, vi } from "vitest";
import { captureEntry } from "../../src/capture/entry";
import { compressTag } from "../../src/compression/digest";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
const stream = (text: string) => new ReadableStream({ start(c) {
  c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
  c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
}});

async function setup(score: number, decision: string) {
  resetDatabaseInit();
  const sqlite = makeSqliteD1();
  const vectors = new Map<string, any>();
  const env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as any,
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockResolvedValue({ matches: [{ id: "old", score, metadata: { parentId: "old" } }] }),
      upsert: vi.fn(async (rows: any[]): Promise<any> => { for (const row of rows) vectors.set(row.id, row.metadata); return { mutationId: "m" }; }),
    }),
    AI: { run: vi.fn(async (model: string) => model === "@cf/google/embeddinggemma-300m"
      ? { data: [new Array(768).fill(0.1)] } : stream(decision)) } as any,
  })) as Env;
  await initializeDatabase(env);
  sqlite.seed({ id: "old", content: "Old digest", tags: ["synthesized"], source: "system", createdAt: 1000 });
  return { sqlite, env, vectors };
}

describe("lost pinned supersede", () => {
  it("D1: row moves between snapshot and pinned supersede: newcomer returned 'stored' without contradiction-resolved", async () => {
    const { sqlite, env, vectors } = await setup(0.72, '{"contradicts":true,"conflicting_id":"old","reason":"different"}');
    sqlite.db.prepare(`UPDATE entries SET content = 'I live in Paris', tags = '["home"]', source = 'api', actor_id = 'u2' WHERE id = 'old'`).run();
    const db = env.DB as any; const prepare = db.prepare.bind(db); let raced = false;
    db.prepare = (sql: string) => {
      if (!raced && sql.startsWith("INSERT INTO entry_versions")) {
        raced = true; sqlite.db.prepare("UPDATE entries SET workspace_id = 'company-ws' WHERE id = 'old'").run();
      }
      return prepare(sql);
    };
    const result: any = await captureEntry("I live in Berlin", [], "api", env, ctx, undefined, { workspaceId: "", actorId: "u1" }, undefined, { channel: "rest" });
    await Promise.allSettled(pending);
    const old = await env.DB.prepare("SELECT tags, contradiction_losses FROM entries WHERE id = 'old'").first() as any;
    const mine = await env.DB.prepare("SELECT tags, contradiction_wins FROM entries WHERE id = ?").bind(result.id).first() as any;
    const edges = await env.DB.prepare("SELECT COUNT(*) AS n FROM edges WHERE target_id = 'old'").first() as any;
    console.log("D1 raced", raced, "status", result.status, "old", JSON.stringify(old), "new", JSON.stringify(mine), "edges", edges.n);
    expect(JSON.parse(mine.tags)).not.toContain("contradiction-resolved");
    expect(result.status).toBe("stored");
    expect(result.tags).not.toContain("contradiction-resolved");
    // Vector ids are per upload (T-0089.1.1): read the newcomer's vector through its parentId.
    expect([...vectors.values()].filter((m: any) => m.parentId === result.id).pop()?.tags).toEqual(JSON.parse(mine.tags));
    sqlite.close();
  });
});
