import { describe, it, expect, vi } from "vitest";
import { captureEntry } from "../../src/capture/entry";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
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

describe("user capture whose conflict row moved mid-capture", () => {
  for (const canonical of [true, false]) {
    it(`U${canonical ? 1 : 2}: USER capture, conflict row ${canonical ? "canonical " : ""}moved to another workspace mid-capture`, async () => {
      const { sqlite, env } = await setup(0.72, '{"contradicts":true,"conflicting_id":"old","reason":"different"}');
      sqlite.db.prepare(`UPDATE entries SET content = 'I live in Paris', tags = ?, source = 'api', actor_id = 'u2' WHERE id = 'old'`).bind(JSON.stringify(canonical ? ["home", "status:canonical"] : ["home"])).run();
      const db = env.DB as any; const prepare = db.prepare.bind(db); let raced = false;
      db.prepare = (sql: string) => {
        if (!raced && /^SELECT (content, )?tags, source, actor_id/.test(sql)) {
          raced = true;
          sqlite.db.prepare("UPDATE entries SET workspace_id = 'company-ws' WHERE id = 'old'").run();
        }
        return prepare(sql);
      };
      const result = await captureEntry("I live in Berlin", [], "api", env, ctx, undefined, { workspaceId: "", actorId: "u1" }, undefined, { channel: "rest" });
      const old = await env.DB.prepare("SELECT workspace_id, tags, contradiction_losses FROM entries WHERE id = 'old'").first() as any;
      const edge = await env.DB.prepare("SELECT workspace_id FROM edges WHERE target_id = 'old' AND type = 'supersedes'").first() as any;
      console.log(`U${canonical ? 1 : 2}`, "raced", raced, "status", result.status, "old", JSON.stringify(old), "edge", JSON.stringify(edge));
      expect(JSON.parse(old.tags)).not.toContain("status:deprecated");
      // A lost race is not a contradiction: no counters, no supersedes edge, the newcomer is kept.
      expect(old.contradiction_losses).toBe(0);
      expect(edge).toBeNull();
      expect(result.status).toBe("contradiction_protected");
      sqlite.close();
    });
  }
});

describe("user capture supersede is pinned to the writer's workspace", () => {
  it("a non-canonical conflict row that moved after the snapshot is not superseded in its new workspace", async () => {
    const { sqlite, env } = await setup(0.72, '{"contradicts":true,"conflicting_id":"old","reason":"different"}');
    sqlite.db.prepare(`UPDATE entries SET content = 'I live in Paris', tags = '["home"]', source = 'api', actor_id = 'u2' WHERE id = 'old'`).run();
    const db = env.DB as any; const prepare = db.prepare.bind(db); let raced = false;
    db.prepare = (sql: string) => {
      // After the snapshot read and the newcomer INSERT: the row moves just before the supersede batch.
      if (!raced && sql.startsWith("INSERT INTO entry_versions")) {
        raced = true;
        sqlite.db.prepare("UPDATE entries SET workspace_id = 'company-ws' WHERE id = 'old'").run();
      }
      return prepare(sql);
    };
    await captureEntry("I live in Berlin", [], "api", env, ctx, undefined, { workspaceId: "", actorId: "u1" }, undefined, { channel: "rest" });
    const old = await env.DB.prepare("SELECT tags, valid_until FROM entries WHERE id = 'old'").first() as any;
    expect(raced).toBe(true);
    expect(JSON.parse(old.tags)).not.toContain("status:deprecated");
    expect(old.valid_until).toBeNull();
    sqlite.close();
  });
});
