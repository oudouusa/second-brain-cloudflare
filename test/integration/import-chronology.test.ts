/**
 * The keyword AND tier reads the FTS index newest-first by rowid (planFtsMatch), which is only "newest"
 * if rowids follow time. Capture writes created_at = now, so they do; /import is the only path that
 * backdates. A restore must therefore insert oldest first whatever order the file is in, or the tier
 * would return the OLDEST rows of a restored brain, permanently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { DEFAULTS } from "../../src/config";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { importExportPayload } from "../../src/entries/import";
import type { Env } from "../../src/env";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { makeMemoryKV, makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;
const LIMIT = 50;

let sqlite: SqliteD1;
let env: Env;

const entry = (id: string, createdAt: number, content = `alpha bravo charlie note ${id}`) =>
  ({ id, content, tags: [], source: "api", created_at: createdAt, updated_at: createdAt });

/** Import a payload the way the settings page does: the same file, page after page. */
async function restore(entries: ReturnType<typeof entry>[], limit = 100) {
  let offset = 0;
  while (offset < entries.length) {
    const result = await importExportPayload(env, { entries, edges: [], projects: [] } as never, { limit, offset });
    expect(result.next_offset).toBeGreaterThan(offset);
    offset = result.next_offset;
  }
}

const rowidOrder = async () => ((await sqlite.db.prepare(`SELECT id FROM entries ORDER BY rowid`).all()).results as { id: string }[]).map(r => r.id);

async function andTierIds(): Promise<string[]> {
  const diagnostics: RecallDiagnostics = {};
  await recallEntries({ query: "alpha bravo charlie", topK: 5, synthesize: false }, env, ctx, { ...DEFAULTS, KEYWORD_CANDIDATE_LIMIT: LIMIT }, { diagnostics });
  expect(diagnostics.ftsRoute).toBe("fts-bounded");
  return diagnostics.keywordIds!;
}

beforeEach(async () => {
  resetDatabaseInit();
  resetFtsReadyMemo();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("index unavailable")) }),
  });
  await initializeDatabase(env);
  env = sqlite.admitEnv(env);
  await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
  resetFtsReadyMemo();
});
afterEach(() => sqlite.close());

describe("GET /export order", () => {
  it("emits entries oldest first, the order a restore should insert them in", async () => {
    const db = makeTestDb();
    for (let i = 0; i < 5; i++) db.entries.push({ id: `e${i}`, content: `m${i}`, tags: "[]", source: "api", created_at: 1000 + i, vector_ids: "[]", recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0 });
    const res = await worker.fetch(req("GET", "/export"), makeTestEnv(db), ctx);
    const data = await res.json() as { entries: { id: string }[] };
    expect(data.entries.map(e => e.id)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
  });
});

describe("restore inserts oldest first, whatever order the file is in", () => {
  const rows = Array.from({ length: 800 }, (_, i) => entry(`r${i}`, 1000 + i));

  it("a file in export order (oldest first)", async () => {
    await restore(rows, 300);
    const ids = await andTierIds();
    expect(ids).toContain("r799");
    expect(ids).not.toContain("r0");
  });

  it("a file from an older export (newest first): sorted on the way in, and consistently across pages", async () => {
    await restore([...rows].reverse(), 300);
    expect(await rowidOrder()).toEqual(rows.map(r => r.id));
    const ids = await andTierIds();
    expect(ids).toContain("r799");
    expect(ids).not.toContain("r0");
  });

  it("a shuffled file, with equal timestamps keeping their file order", async () => {
    const tied = [entry("t-b", 5), entry("t-a", 5), entry("t-old", 1), entry("t-new", 9)];
    await restore(tied, 2);
    expect(await rowidOrder()).toEqual(["t-old", "t-b", "t-a", "t-new"]);
  });

  it("a null or missing created_at sorts with the newest, because the import stamps it with the current time", async () => {
    await restore([entry("ok-2", 20), { ...entry("nul", 0), created_at: null as never }, entry("ok-1", 10), { ...entry("gone", 0), created_at: undefined as never }], 10);
    expect(await rowidOrder()).toEqual(["ok-1", "ok-2", "nul", "gone"]);
  });

  it("an entry whose created_at is unusable is still attempted, after the dated ones", async () => {
    await restore([entry("ok-2", 20), { ...entry("bad", 0), created_at: "later" as never }, entry("ok-1", 10)], 10);
    expect((await rowidOrder()).slice(0, 2)).toEqual(["ok-1", "ok-2"]);
  });
});

describe("export -> import round trip", () => {
  it("returns the newest all-token rows first from the restored brain", async () => {
    const db = makeTestDb();
    for (let i = 0; i < 800; i++) db.entries.push({ id: `r${i}`, content: `alpha bravo charlie note ${i}`, tags: "[]", source: "api", created_at: 1000 + i, vector_ids: "[]", recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0 });
    const exportEnv = makeTestEnv(db);
    const exported = { entries: [] as ReturnType<typeof entry>[] };
    for (let offset = 0; offset < 800; offset += 100) {
      const res = await worker.fetch(req("GET", `/export?paged=1&offset=${offset}&limit=100`), exportEnv, ctx);
      expect(res.status).toBe(200);
      const page = await res.json() as { entries: ReturnType<typeof entry>[] };
      exported.entries.push(...page.entries);
    }

    await restore(exported.entries, 300);

    const ids = await andTierIds();
    expect(ids).toContain("r799");
    expect(ids).not.toContain("r0");
  });

  // Honest limit: rowids follow insertion, not created_at. Merging an OLDER archive into a brain that
  // already holds newer rows inserts the archive after them, so the AND tier (newest rowid first) keeps
  // archive rows over live ones when more than the limit match. It still returns rows carrying every
  // word, only the choice among more than KEYWORD_CANDIDATE_LIMIT of them differs.
  it("known exception: an old archive merged into a live brain outranks the live rows in the AND tier", async () => {
    for (let i = 0; i < 60; i++) sqlite.seed({ id: `live-${i}`, content: `alpha bravo charlie live ${i}`, createdAt: 900_000 + i });
    await restore(Array.from({ length: 800 }, (_, i) => entry(`arch-${i}`, 1000 + i)), 300);

    const ids = await andTierIds();
    expect(ids.filter(id => id.startsWith("arch-")).length).toBeGreaterThan(0);
    expect(ids.filter(id => id.startsWith("live-"))).toEqual([]);
  });
});
