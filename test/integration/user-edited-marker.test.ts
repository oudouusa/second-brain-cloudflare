/**
 * QA: the `user-edited` marker on a digest or insight cannot be shed by replacing the row's
 * tags, and a plain user row is never given it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { updateEntryContent } from "../../src/capture/store";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

describe("user-edited marker", () => {
  let sqlite: SqliteD1;
  let env: Env;
  beforeEach(async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    env = sqlite.admitEnv(makeTestEnv(undefined, {
      DB: sqlite.db as any, OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
      AI: { run: vi.fn().mockResolvedValue({ data: [new Array(768).fill(0.1)] }) } as unknown as Ai,
    })) as Env;
    await initializeDatabase(env);
  });
  afterEach(() => sqlite.close());

  const tagsOf = (id: string) => JSON.parse(String(sqlite.rows().find(r => r.id === id)!.tags)) as string[];

  it.each([["synthesized"], ["auto-insight"]])("an edit with a replacement tag list keeps %s and adds user-edited", async (tag) => {
    sqlite.seed({ id: "row", content: "system text", createdAt: 1000, tags: [tag, "work"], source: "system" });
    await updateEntryContent(env, "row", "my correction", undefined, undefined, ["mine"], { workspaceId: "", actorId: "u1" }, { actorId: "u1", channel: "rest" }, "");
    expect(tagsOf("row")).toEqual(expect.arrayContaining([tag, "user-edited", "mine"]));
    expect(tagsOf("row")).not.toContain("work");
  });

  it("a second edit does not duplicate the marker, and a plain row never gets one", async () => {
    sqlite.seed({ id: "row", content: "system text", createdAt: 1000, tags: ["synthesized"], source: "system" });
    sqlite.seed({ id: "plain", content: "plain text", createdAt: 1000, tags: ["work"], source: "api" });
    await updateEntryContent(env, "row", "edit one", undefined, undefined, undefined, { workspaceId: "", actorId: "u1" }, { actorId: "u1", channel: "rest" }, "");
    await updateEntryContent(env, "row", "edit two", undefined, undefined, undefined, { workspaceId: "", actorId: "u1" }, { actorId: "u1", channel: "rest" }, "");
    await updateEntryContent(env, "plain", "plain edited", undefined, undefined, undefined, { workspaceId: "", actorId: "u1" }, { actorId: "u1", channel: "rest" }, "");
    expect(tagsOf("row").filter(t => t === "user-edited")).toHaveLength(1);
    expect(tagsOf("plain")).not.toContain("user-edited");
  });
});
