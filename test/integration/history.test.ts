import { DEFAULTS } from "../../src/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { listMemoryHistory } from "../../src/memory/history";
import { loadHistory } from "../../src/memory/versions";
import { resolveIdentityFromToken } from "../../src/lib/identity";
import { deleteForever } from "../../src/memory/trash";
import { trashNonce } from "../helpers/trash-env";
import { WRITE_CAS_ATTEMPTS } from "../../src/constants";
import { updateEntryContent } from "../../src/capture/store";
import { forgetEntry } from "../../src/capture/lifecycle";
import { makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

describe("non-destructive replacement history", () => {
  let sqlite: SqliteD1;
  let env: Env;
  let pending: Promise<unknown>[];
  let ctx: ExecutionContext;

  beforeEach(() => {
    sqlite = makeSqliteD1();
    env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database }));
    pending = [];
    ctx = { waitUntil: promise => { pending.push(promise); } } as ExecutionContext;
  });

  afterEach(async () => {
    await Promise.allSettled(pending);
    sqlite.close();
  });

  it("preserves the prior body outside recall and exposes it through REST history", async () => {
    sqlite.seed({
      id: "current",
      content: "The deployment target is the legacy blue cluster.",
      createdAt: 1_700_000_000_000,
      tags: ["work", "deployment", "status:canonical"],
      vectorIds: ["old-vector"],
      importanceScore: 4,
    });

    const updated = await worker.fetch(new Request("http://localhost/update", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({
        id: "current",
        content: "The deployment target is the corrected green cluster.",
      }),
    }), env, ctx);
    const receipt = await updated.json() as any;

    expect(updated.status).toBe(200);
    expect(receipt.previous_id).toBeUndefined();
    expect(sqlite.rows()).toHaveLength(1);
    expect(sqlite.rows()[0].content).toBe("The deployment target is the corrected green cluster.");
    const historyResponse = await worker.fetch(new Request("http://localhost/history", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ id: "current" }),
    }), env, ctx);
    expect(historyResponse.status).toBe(200);
    const history = await historyResponse.json() as any;
    expect(history.versions).toEqual([]);
    expect(history.history.items).toContainEqual(expect.objectContaining({
      kind: "change", seq: 1, reason: "update",
      before_preview: "The deployment target is the legacy blue cluster.",
    }));
    const versionResponse = await worker.fetch(new Request("http://localhost/entry/version", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ id: "current", seq: 1 }),
    }), env, ctx);
    expect(versionResponse.status).toBe(200);
    expect(await versionResponse.json()).toMatchObject({ content: "The deployment target is the legacy blue cluster." });
  });

  it("keeps the replacement and its before-image atomic when the source loses its CAS", async () => {
    sqlite.seed({
      id: "current",
      content: "Original",
      createdAt: 1_700_000_000_000,
      tags: ["work"],
      vectorIds: ["old-vector"],
    });
    const baseDb = env.DB;
    let changed = 0;
    env = Object.assign(Object.create(env), {
      DB: {
        prepare: baseDb.prepare.bind(baseDb),
        exec: baseDb.exec.bind(baseDb),
        batch: async (statements: D1PreparedStatement[]) => {
          if (statements.some(s => /^UPDATE entries(?: AS e)? SET/.test((s as any).sourceSql()) && (s as any).sourceSql().includes("content ="))) {
            changed++;
            await baseDb.prepare(
              `UPDATE entries SET content = ?, write_marker = ? WHERE id = ?`,
            ).bind(`Concurrent winner ${changed}`, sqlite.fixtureMarker(), "current").run();
          }
          return baseDb.batch(statements);
        },
      },
    }) as Env;

    const result = await updateEntryContent(env, "current", "Losing replacement", undefined, undefined, undefined, { workspaceId: "", actorId: "owner" }, { actorId: "", channel: "rest" as const }, "");

    expect(result.status).toBe("conflict");
    expect(changed).toBe(WRITE_CAS_ATTEMPTS);
    expect(sqlite.rows()).toHaveLength(1);
    expect(sqlite.rows()[0].content).toBe(`Concurrent winner ${WRITE_CAS_ATTEMPTS}`);
    expect((await baseDb.prepare(`SELECT seq FROM entry_versions`).all()).results).toEqual([]);
    expect(await listMemoryHistory(env, "current", 20)).toEqual([]);
    expect((await baseDb.prepare(`SELECT id FROM edges`).all()).results).toEqual([]);
  });

  it("accepts a committed one-row CAS when D1 counts derived trigger writes", async () => {
    sqlite.seed({ id: "current", content: "Before", createdAt: 1_700_000_000_000 });
    const baseDb = env.DB;
    let inflated = false;
    const reported = Object.create(baseDb) as D1Database;
    reported.batch = (async (statements: D1PreparedStatement[]) => {
      const results = await baseDb.batch(statements);
      const sourceAt = statements.findIndex(s => /^UPDATE entries(?: AS e)? SET/.test((s as any).sourceSql()) && (s as any).sourceSql().includes("content ="));
      if (sourceAt >= 0) {
        inflated = true;
        // Miniflare/D1 includes FTS and entry_counts trigger changes here.
        // The source UPDATE still matches only the primary-key row.
        results[sourceAt].meta.changes = 10;
      }
      return results;
    }) as D1Database["batch"];
    env = Object.assign(Object.create(env), { DB: reported }) as Env;

    const result = await updateEntryContent(env, "current", "After", undefined, undefined, undefined, { workspaceId: "", actorId: "" }, { actorId: "", channel: "rest" as const }, "");

    expect(result.status).toBe("updated");
    expect(sqlite.rows().find(row => row.id === "current")?.content).toBe("After");
    expect(inflated).toBe(true);
    expect(sqlite.rows()).toHaveLength(1);
    const chain = await loadHistory(env, (await resolveIdentityFromToken("test-token", env))!, { id: "current", content: "After" }, 20);
    expect(chain.text(1)).toBe("Before");
  });

  it("permanently forgets the current entry together with all preserved versions", async () => {
    sqlite.seed({
      id: "current",
      content: "Version one",
      createdAt: 1_700_000_000_000,
      tags: ["personal"],
      vectorIds: ["version-one-vector"],
    });
    const first = await updateEntryContent(env, "current", "Version two", undefined, undefined, undefined, { workspaceId: "", actorId: "" }, { actorId: "", channel: "rest" as const }, "");
    expect(first.status).toBe("updated");
    const second = await updateEntryContent(env, "current", "Version three", undefined, undefined, undefined, { workspaceId: "", actorId: "" }, { actorId: "", channel: "rest" as const }, "");
    expect(second.status).toBe("updated");
    expect(sqlite.rows()).toHaveLength(1);
    expect((await env.DB.prepare(`SELECT seq FROM entry_versions WHERE entry_id = ?`).bind("current").all()).results).toHaveLength(2);

    const forgotten = await forgetEntry("current", env, { actorId: "", channel: "rest" as const }, { reason: "forget", config: DEFAULTS }, "");

    expect(forgotten.status).toBe("deleted");
    expect(sqlite.rows()).toEqual([]);
    // forgetは取り消し可能なtrash。永久削除で履歴も削除する。
    expect((await env.DB.prepare(`SELECT seq FROM entry_versions WHERE entry_id = ?`).bind("current").all()).results).toHaveLength(2);
    const deleted = await deleteForever(env, "current", { actorId: "", channel: "rest" }, "", await trashNonce(env, "current"));
    expect(deleted.status).toBe("deleted");
    expect((await env.DB.prepare(`SELECT seq FROM entry_versions`).all()).results).toEqual([]);
    expect((await env.DB.prepare(`SELECT id FROM edges`).all()).results).toEqual([]);
    expect(await listMemoryHistory(env, "current", 20)).toEqual([]);
  });
});
