import { expect, it, vi } from "vitest";
import { compressTag } from "../../src/compression/digest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import type { Env } from "../../src/env";

const stream = (text: string) => new ReadableStream({ start(c) {
  c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
  c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close();
}});

it("does not roll up a source edited after the digest's source read", async () => {
  resetDatabaseInit();
  const sqlite = makeSqliteD1();
  let edited = false;
  const env = sqlite.admitEnv(makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vi.fn(async (): Promise<any> => ({ matches: [] })) }),
    AI: { run: vi.fn(async (model: string, opts: any) => {
      if (model === "@cf/google/embeddinggemma-300m") return { data: [new Array(768).fill(0.1)] };
      const prompt = String(opts?.messages?.[0]?.content ?? "");
      if (prompt.includes("write a single cohesive paragraph")) {
        await sqlite.db.prepare("UPDATE entries SET content = ?, tags = ? WHERE id = ?")
          .bind("MY NEW EDIT", JSON.stringify(["rocket-project", "user-edited"]), "w-0").run();
        edited = true;
        return stream("A summary of the old work notes.");
      }
      return stream("3");
    }) } as any,
  })) as Env;
  await initializeDatabase(env);
  for (let i = 0; i < 12; i++) sqlite.seed({ id: `w-${i}`, content: `Old work note ${i}`, createdAt: Date.now() - 200 * 86400000 + i, tags: ["rocket-project"] });

  await compressTag("rocket-project", env, { waitUntil() {} } as unknown as ExecutionContext);
  const source = sqlite.rows().find(r => r.id === "w-0")!;
  expect(edited).toBe(true);
  expect(JSON.parse(String(source.tags))).not.toContain("rolled-up");
  expect(source.content).toBe("MY NEW EDIT");
  sqlite.close();
});
