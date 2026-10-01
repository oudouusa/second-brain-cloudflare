/**
 * Upgrade path from a 3.7.0-shaped database (Task 11, T-0089.1.1 T-0089.1.2).
 *
 * test/fixtures/schema-3.7.0.sql is db/schema.sql frozen at release commit 0a39810, before
 * tenancy, when_*, recall_count or entry_versions/entries_trash existed. Loading it and then
 * calling initializeDatabase exercises the real upgrade chain (every ALTER since 3.7.0, not just
 * the new tables), which is the only way "no backfill writes" is a fact about production rather
 * than about a hand-trimmed fixture.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeMemoryKV, makeTestEnv, makeAIMock, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, stripSqlComments, splitSchemaStatements, type SqliteD1 } from "../helpers/sqlite-d1";
import { req } from "../helpers/make-request";
import worker from "../../src/index";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { updateEntryContent, appendToEntry } from "../../src/capture/store";
import { applyStatus, forgetEntry } from "../../src/capture/lifecycle";
import { resolveEntryAction } from "../../src/memory/actions";
import { getTrashedEntry, restoreEntry } from "../../src/memory/trash";
import { importExportPayload } from "../../src/entries/import";
import { readEntryHistory } from "../../src/memory/history";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { VERSIONS_SINCE_KV_KEY } from "../../src/constants";
import { DEFAULTS } from "../../src/config";
import { isHeld, NOT_HELD_SQL, heldReason } from "../../src/quarantine/tags";
import type { Env } from "../../src/env";
import { recallEntries } from "../../src/recall/search";

// A string path, not new URL(...): a duplicate global URL type (DOM lib vs node:url) makes
// readFileSync's URL overload unresolvable under this project's tsconfig. Same convention as
// every other fixture path in test/ (e.g. db-init.test.ts's own schema.sql read).
const FIXTURE = resolve(import.meta.dirname, "../fixtures/schema-3.7.0.sql");

/** The real SqliteD1 facade (batch, queueing, everything Task 1-6's code relies on), started
 * empty and loaded from the frozen 3.7.0 fixture instead of the current db/schema.sql. */
async function make370D1(): Promise<SqliteD1> {
  const d1 = makeSqliteD1({ schema: false });
  const schema = readFileSync(FIXTURE, "utf8");
  for (const statement of splitSchemaStatements(stripSqlComments(schema))) {
    const sql = statement.trim();
    if (!sql) continue;
    await d1.db.exec(sql);
  }
  return d1 as any;
}

let d1: SqliteD1;
let env: Env;
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;
const totalChanges = async () => ((await (d1.db as any).prepare(`SELECT total_changes() AS n`).first()) as any).n as number;

beforeEach(async () => {
  resetDatabaseInit();
  d1 = await make370D1();
});
afterEach(() => d1.close());

describe("upgrade from a 3.7.0-shaped database", () => {
  it("creates entry_versions, entries_trash and their index, and writes no rows", async () => {
    // A realistic pre-4.0 brain: 50 ordinary entries, a capsule row, a deprecated row, and 20
    // edges between them — not the two-row toy a passing test could rubber-stamp.
    const entryTuples = Array.from({ length: 50 }, (_, i) =>
      `('e${i}', 'memory number ${i}', '["a"]', 'api', ${1000 + i}, '[]')`).join(",\n      ");
    await d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES
      ${entryTuples},
      ('cap', 'the capsule content', '["capsule:core","status:canonical"]', 'api', 6000, '[]'),
      ('dep', 'a deprecated memory', '["status:deprecated"]', 'api', 6100, '[]')`);
    const edgeTuples = Array.from({ length: 20 }, (_, i) =>
      `('edge${i}', 'e${i}', 'e${(i + 1) % 50}', 'relates_to', 0.5, 'inferred', '{}', 1000, 1000)`).join(",\n      ");
    await d1.db.exec(`INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at) VALUES
      ${edgeTuples}`);
    const before = await totalChanges();

    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);

    const objects = (await (d1.db as any).prepare(`SELECT name, type FROM sqlite_master WHERE name IN ('entry_versions','entries_trash','idx_entry_versions_entry','idx_entries_trash_deleted')`).all()).results as { name: string; type: string }[];
    expect(objects.map((o) => o.name).sort()).toEqual(["entries_trash", "entry_versions", "idx_entries_trash_deleted", "idx_entry_versions_entry"].sort());
    expect(objects.find((o) => o.name === "entry_versions")!.type).toBe("table");
    expect(objects.find((o) => o.name === "entries_trash")!.type).toBe("table");

    // total_changes() only counts INSERT/UPDATE/DELETE (row writes), never DDL: this is the
    // direct proof that upgrading a 3.7.0 brain to 4.0's schema touches no existing row and
    // inserts none of its own, even with the ALTERs (updated_at among them) still pending
    // against a 52-entry, 20-edge corpus that includes a capsule and a deprecated row.
    // 既存記憶へのbackfillはゼロ。epoch/generation/schemaの管理singletonだけを初期化する。
    expect((await totalChanges()) - before).toBe(3);
    env = d1.admitEnv(env);

    expect(await env.OAUTH_KV.get(VERSIONS_SINCE_KV_KEY)).not.toBeNull();

    // updated_at arrives by ALTER with no backfill (design: "never backfills, at any brain
    // size"), so every row reads NULL until something writes it. Half the ordinary entries are
    // touched here — after the migration this counted, so the "no rows written" claim above
    // still stands — to leave the brain in the mixed shape the spec asks for: NULL updated_at
    // on half, a real one on the rest.
    const half = Array.from({ length: 25 }, (_, i) => `'e${i}'`).join(",");
    await (d1.db as any).prepare(`UPDATE entries SET updated_at = 9999 WHERE id IN (${half})`).run();
    const nullCount = (await (d1.db as any).prepare(`SELECT COUNT(*) AS n FROM entries WHERE updated_at IS NULL`).first()).n as number;
    const setCount = (await (d1.db as any).prepare(`SELECT COUNT(*) AS n FROM entries WHERE updated_at IS NOT NULL`).first()).n as number;
    expect(nullCount).toBe(27); // 25 untouched ordinary entries + cap + dep
    expect(setCount).toBe(25);
  });

  it("an upgrade with a non-JSON entry_events payload succeeds (round 8 re-review MINOR, upgrade safety)", async () => {
    // A 3.7.0 brain predates entry_events.payload's own JSON convention on some rows; a CREATE
    // INDEX whose WHERE calls json_extract would throw "malformed JSON" evaluating this row and
    // fail the whole migration. idx_entry_events_life_end's own predicate checks only `event`.
    await d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'a memory', '[]', 'api', 1000, '[]')`);
    await d1.db.exec(`INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES ('ev1', 'e1', '', 'deleted', 'not json at all', 2000)`);

    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await expect(initializeDatabase(env)).resolves.not.toThrow();

    const idx = await (d1.db as any).prepare(`SELECT name FROM sqlite_master WHERE name = 'idx_entry_events_life_end'`).first();
    expect(idx).not.toBeNull();

    // A later ordinary insert of a 'deleted' event, still non-JSON, must not throw either.
    await expect(
      (d1.db as any).prepare(`INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES ('ev2', 'e1', '', 'deleted', 'still not json', 3000)`).run(),
    ).resolves.not.toThrow();
  });

  it("creates idx_entries_ledger and idx_entries_standing on a 3.7.0 upgrade, both empty", async () => {
    // A pre-4.0 brain never wrote either marker tag, so migrating it must not reinterpret
    // anything: both indexes are created and both start empty (T-0089.7.1, T-0089.7.2).
    await d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'an ordinary pre-4.0 memory', '["decision","standing"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });

    await initializeDatabase(env);
    env = d1.admitEnv(env);

    const objects = (await (d1.db as any).prepare(
      `SELECT name, type FROM sqlite_master WHERE name IN ('idx_entries_ledger','idx_entries_standing')`,
    ).all()).results as { name: string; type: string }[];
    expect(objects.map((o) => o.name).sort()).toEqual(["idx_entries_ledger", "idx_entries_standing"]);
    expect(objects.every((o) => o.type === "index")).toBe(true);

    // The pre-4.0 row's plain "decision"/"standing" tags are ordinary tags (P7.2), not the
    // reserved "ledger:decision"/"standing:active" markers, so neither index picks it up.
    const ledgerCount = (await (d1.db as any).prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE instr(lower(tags), '"ledger:decision"') > 0`,
    ).first()).n as number;
    const standingCount = (await (d1.db as any).prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE instr(lower(tags), '"standing:active"') > 0`,
    ).first()).n as number;
    expect(ledgerCount).toBe(0);
    expect(standingCount).toBe(0);
  });

  it("MINOR (T-0102): a 3.7.0 user tag that merely starts with 'quarantine:' is not held after the upgrade", async () => {
    // A genuine pre-4.0 user tag ("quarantine:review" -- their own word, written long before the
    // hold mechanism existed): its value is not one of the app's five recognized hold reasons, so
    // it must never read as held. Before the fix, isHeld matched the whole prefix: this row would
    // read as held with no hold version ever written for it, so undo could never release it.
    await d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'needs a second look before the audit', '["quarantine:review"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });

    await initializeDatabase(env);
    env = d1.admitEnv(env);

    const row = (await (d1.db as any).prepare(`SELECT tags FROM entries WHERE id = 'e1'`).first()) as { tags: string };
    expect(isHeld(JSON.parse(row.tags))).toBe(false);

    // The real SQL predicate every candidate query filters through, not just the JS helper: a
    // held row would be excluded here.
    const found = (await (d1.db as any).prepare(`SELECT id FROM entries WHERE id = 'e1' AND ${NOT_HELD_SQL}`).first()) as { id: string } | null;
    expect(found?.id).toBe("e1");
  });

  it("a second cold start issues only the probe, no more CREATEs", async () => {
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    env = d1.admitEnv(env);
    resetDatabaseInit();
    d1.issued.length = 0;
    await initializeDatabase(env);
    env = d1.admitEnv(env);
    expect(d1.issued.some((s) => /CREATE TABLE IF NOT EXISTS entry_versions/.test(s))).toBe(false);
    expect(d1.issued.some((s) => /CREATE TABLE IF NOT EXISTS entries_trash/.test(s))).toBe(false);
    expect(d1.issued.some((s) => /entries_fts_vocab/.test(s))).toBe(false);
  });

  it("creates entries_fts_vocab on a 3.7.0 upgrade, counting the pre-4.0 rows, and a repeat init leaves it alone", async () => {
    await d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'atlas ledger', '[]', 'api', 1000, '[]'), ('e2', 'atlas plan', '[]', 'api', 2000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });

    await initializeDatabase(env);
    env = d1.admitEnv(env);
    resetDatabaseInit();
    await initializeDatabase(env);
    env = d1.admitEnv(env);

    const table = (await (d1.db as any).prepare(`SELECT type FROM sqlite_master WHERE name = 'entries_fts_vocab'`).first()) as { type: string } | null;
    expect(table?.type).toBe("table");
    const atl = (await (d1.db as any).prepare(`SELECT doc FROM entries_fts_vocab WHERE term = 'atl'`).first()) as { doc: number } | null;
    expect(atl?.doc).toBe(2);
  });

  it("a pre-4.0 row's first update versions correctly with no gap: seq 1, valid_from = COALESCE(updated_at, created_at)", async () => {
    await d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'I live in Berlin', '["home"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    env = d1.admitEnv(env);
    const roots = await ensureTenantBootstrap(env);
    // Bootstrap assigns legacy rows to the owner's personal workspace (main tenancy.ts:127); a
    // one-time backfill of workspace_id/actor_id is out of scope for Task 11 (design row 23), so
    // it is not asserted against here.
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'e1'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const change = { actorId: roots.ownerUserId, channel: "rest" as const };
    const r = await updateEntryContent(env, "e1", "I live in Munich now", DEFAULTS, undefined, undefined, { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId }, change, roots.ownerPersonalWorkspaceId);
    expect(r.status).toBe("updated");

    const versions = (await (d1.db as any).prepare(`SELECT * FROM entry_versions WHERE entry_id = 'e1' ORDER BY seq`).all()).results as any[];
    expect(versions).toHaveLength(1);
    expect(versions[0].seq).toBe(1);
    expect(versions[0].content).toBe("I live in Berlin");
    // updated_at was NULL on this legacy row, so valid_from falls back to created_at (P13 / design "valid_from").
    expect(versions[0].valid_from).toBe(1000);
  });

  it("a 3.7 tag that merely looks reserved (quarantine:2020, outcome:won) recalls normally, isn't held, keeps its tags, and replacement can remove it (Codex review, T-0102)", async () => {
    await d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'the deal closed in Lisbon', '["quarantine:2020","outcome:won"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    env = d1.admitEnv(env);
    const roots = await ensureTenantBootstrap(env);
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'e1'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    // Recalls normally: NOT_HELD_SQL must not exclude a tag that merely shares the quarantine:
    // prefix with a real hold reason.
    const { matches } = await recallEntries({ query: "Lisbon", topK: 10, synthesize: false }, env, ctx, undefined, {});
    expect(matches.map(m => m.id)).toContain("e1");

    // Isn't held: isHeld/heldReason must not treat "2020" as a recognized hold reason.
    const row = await (d1.db as any).prepare(`SELECT tags FROM entries WHERE id = 'e1'`).first();
    expect(isHeld(JSON.parse(row.tags))).toBe(false);
    expect(heldReason(JSON.parse(row.tags))).toBeNull();

    // Keeps its tags: an ordinary edit (content-only, tags untouched) must not silently drop them.
    const change = { actorId: roots.ownerUserId, channel: "rest" as const };
    const writeCtx = { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId };
    const edited = await updateEntryContent(env, "e1", "the deal closed in Porto", DEFAULTS, undefined, undefined, writeCtx, change, roots.ownerPersonalWorkspaceId);
    expect(edited.status).toBe("updated");
    const afterEdit = await (d1.db as any).prepare(`SELECT tags FROM entries WHERE id = 'e1'`).first();
    expect(JSON.parse(afterEdit.tags).sort()).toEqual(["outcome:won", "quarantine:2020"]);

    // Replacement can remove them: they behave as ORDINARY user tags, not un-droppable reserved
    // ones -- a replacement that omits them drops them, the same as any other user tag would.
    const replaced = await updateEntryContent(env, "e1", "the deal closed in Porto", DEFAULTS, undefined, ["deals"], writeCtx, change, roots.ownerPersonalWorkspaceId);
    expect(replaced.status).toBe("updated");
    const afterReplace = await (d1.db as any).prepare(`SELECT tags FROM entries WHERE id = 'e1'`).first();
    expect(JSON.parse(afterReplace.tags)).toEqual(["deals"]);
  });

  it("a pre-4.0 row's first append versions correctly and reconstructs the prior text", async () => {
    await d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'Notes:', '["work"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    env = d1.admitEnv(env);
    const roots = await ensureTenantBootstrap(env);
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'e1'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const change = { actorId: roots.ownerUserId, channel: "rest" as const };
    const ok = (await appendToEntry(env, "e1", "Notes:", "met Sam", [], "api", DEFAULTS, undefined, { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId }, change, undefined, roots.ownerPersonalWorkspaceId)).indexed;
    expect(ok).toBe(true);

    const row = await (d1.db as any).prepare(`SELECT content FROM entries WHERE id = 'e1'`).first();
    expect(row.content).toContain("Notes:");
    expect(row.content).toContain("met Sam");
    const versions = (await (d1.db as any).prepare(`SELECT * FROM entry_versions WHERE entry_id = 'e1' ORDER BY seq`).all()).results as any[];
    expect(versions).toHaveLength(1);
    expect(versions[0].seq).toBe(1);
    expect(versions[0].valid_from).toBe(1000);
  });

  it("init sets versions:since", async () => {
    await d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'memory', '["a"]', 'api', 1000, '[]')`);
    const before = Date.now();
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    env = d1.admitEnv(env);
    const since = await env.OAUTH_KV.get(VERSIONS_SINCE_KV_KEY);
    expect(since).not.toBeNull();
    expect(Number(since)).toBeGreaterThanOrEqual(before);
  });

  it("a pre-4.0 row's first set_status versions correctly: seq 1, valid_from = COALESCE(updated_at, created_at)", async () => {
    await d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'Some memory', '["work"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    env = d1.admitEnv(env);
    const roots = await ensureTenantBootstrap(env);
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'e1'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const change = { actorId: roots.ownerUserId, channel: "rest" as const };
    const result = await applyStatus("e1", "deprecated", env, change, DEFAULTS, roots.ownerPersonalWorkspaceId);
    expect(result).toEqual({ status: "ok", indexed: false, validity: expect.any(Object), eventId: expect.any(String) });

    const versions = (await (d1.db as any).prepare(`SELECT * FROM entry_versions WHERE entry_id = 'e1' ORDER BY seq`).all()).results as any[];
    expect(versions).toHaveLength(1);
    expect(versions[0].seq).toBe(1);
    expect(versions[0].valid_from).toBe(1000);
  });

  it("a pre-4.0 row's first snooze versions correctly: seq 1, valid_from = COALESCE(updated_at, created_at)", async () => {
    await d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'Renew the passport', '["task"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    env = d1.admitEnv(env);
    const roots = await ensureTenantBootstrap(env);
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'e1'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const identity: Identity = {
      userId: roots.ownerUserId, role: "admin", personalWorkspaceId: roots.ownerPersonalWorkspaceId,
      companyWorkspaceIds: [roots.companyWorkspaceId], defaultShare: "",
    };
    const change = { actorId: roots.ownerUserId, channel: "rest" as const };
    const result = await resolveEntryAction(env, ctx, identity, "e1", "snooze", "2027-01-01", change);
    expect(result.ok).toBe(true);

    const versions = (await (d1.db as any).prepare(`SELECT * FROM entry_versions WHERE entry_id = 'e1' ORDER BY seq`).all()).results as any[];
    expect(versions).toHaveLength(1);
    expect(versions[0].seq).toBe(1);
    expect(versions[0].valid_from).toBe(1000);
  });

  it("a pre-4.0 row's first merge versions correctly: seq 1, valid_from = COALESCE(updated_at, created_at)", async () => {
    await d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, importance_score) VALUES ('e1', 'I prefer dark mode', '["ui"]', 'api', 1000, '[]', 0)`);
    const vectorize = makeVectorizeMock({
      query: vi.fn().mockResolvedValue({ matches: [{ id: "e1", score: 0.88, metadata: { parentId: "e1" } }] }),
    });
    // Merge-decision-only AI stub: embed calls answer with a vector, everything else (the merge
    // prompt) answers with the fixed decision below, matching test/integration/smart-merge.test.ts's
    // makeMergeAI shape.
    const mergedContent = "I prefer dark mode, especially at night";
    const ai = {
      run: vi.fn().mockImplementation(async (model: string) => {
        if (model === "@cf/google/embeddinggemma-300m") return { data: [new Array(768).fill(0.1)] };
        const response = JSON.stringify({ action: "merge", target_id: "e1", merged_content: mergedContent });
        return new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        });
      }),
    } as unknown as Ai;

    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: ai, VECTORIZE: vectorize });
    await initializeDatabase(env);
    env = d1.admitEnv(env);
    const roots = await ensureTenantBootstrap(env);
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'e1'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const res = await worker.fetch(req("POST", "/capture", { body: { content: "I like dark mode especially at night" } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.action).toBe("merged");
    expect(data.id).toBe("e1");

    const row = await (d1.db as any).prepare(`SELECT content FROM entries WHERE id = 'e1'`).first();
    expect(row.content).toBe(mergedContent);
    const versions = (await (d1.db as any).prepare(`SELECT * FROM entry_versions WHERE entry_id = 'e1' ORDER BY seq`).all()).results as any[];
    expect(versions).toHaveLength(1);
    expect(versions[0].seq).toBe(1);
    expect(versions[0].valid_from).toBe(1000);
  });

  it("a pre-4.0 row's forget works: it moves to the trash intact", async () => {
    await d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('e1', 'Old memory', '["x"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    env = d1.admitEnv(env);
    const roots = await ensureTenantBootstrap(env);
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'e1'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const change = { actorId: roots.ownerUserId, channel: "rest" as const };
    const result = await forgetEntry("e1", env, change, { reason: "forget", config: DEFAULTS, purge: false }, roots.ownerPersonalWorkspaceId);
    expect(result.status).toBe("deleted");
    expect((result as any).trashed).toBe(true);
    expect(await (d1.db as any).prepare(`SELECT id FROM entries WHERE id = 'e1'`).first()).toBeNull();
    expect(await (d1.db as any).prepare(`SELECT id FROM entries_trash WHERE id = 'e1'`).first()).not.toBeNull();
  });

  it("forget then restore a pre-4.0 row with NULL columns round-trips it", async () => {
    // recall_count/importance_score/contradiction_wins/contradiction_losses already exist as
    // nullable columns at 3.7.0 (unlike updated_at/when_*, which only arrive by ALTER); a real
    // pre-4.0 brain can hold rows where an older write path left them NULL rather than 0.
    await d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids, recall_count, importance_score, contradiction_wins, contradiction_losses)
      VALUES ('leg', 'legacy content', '["x"]', 'voice', 4000, '[]', NULL, NULL, NULL, NULL)`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    env = d1.admitEnv(env);
    const roots = await ensureTenantBootstrap(env);
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'leg'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const change = { actorId: roots.ownerUserId, channel: "rest" as const };
    const forgotten = await forgetEntry("leg", env, change, { reason: "forget", config: DEFAULTS, purge: false }, roots.ownerPersonalWorkspaceId);
    expect(forgotten.status).toBe("deleted");

    const trashed = await getTrashedEntry(env, undefined, "leg");
    expect(trashed).not.toBeNull();
    const restored = await restoreEntry(env, trashed!, change, DEFAULTS);
    expect(restored.status).toBe("restored");

    const row = await (d1.db as any).prepare(`SELECT * FROM entries WHERE id = 'leg'`).first() as any;
    expect(row.content).toBe("legacy content");
    expect(row.source).toBe("voice");
    expect(row.recall_count).toBeNull();
    expect(row.importance_score).toBeNull();
    expect(row.contradiction_wins).toBeNull();
    expect(row.contradiction_losses).toBeNull();
    // updated_at and when_at exist only by ALTER, with no backfill: NULL on every untouched row.
    expect(row.updated_at).toBeNull();
    expect(row.when_at).toBeNull();
  });

  it("import of a 3.7.0 export whose ids are partly in trash skips them as in_trash", async () => {
    await d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('trashed-id', 'will be trashed', '["x"]', 'api', 1000, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    env = d1.admitEnv(env);
    const roots = await ensureTenantBootstrap(env);
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'trashed-id'`).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const change = { actorId: roots.ownerUserId, channel: "rest" as const };
    const forgotten = await forgetEntry("trashed-id", env, change, { reason: "forget", config: DEFAULTS, purge: false }, roots.ownerPersonalWorkspaceId);
    expect(forgotten.status).toBe("deleted");
    expect(await (d1.db as any).prepare(`SELECT id FROM entries_trash WHERE id = 'trashed-id'`).first()).not.toBeNull();

    const summary = await importExportPayload(env, {
      version: 2,
      entries: [
        { id: "trashed-id", content: "a stale export of the trashed row", created_at: 1000 },
        { id: "fresh-id", content: "a genuinely new row", created_at: 2000 },
      ],
    }, { writeCtx: { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId } });

    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.skipped_in_trash).toBe(1);
    expect(summary.results).toContainEqual({ id: "trashed-id", status: "skipped", reason: "in_trash" });
    expect(summary.results).toContainEqual({ id: "fresh-id", status: "imported" });
    // The stale copy was skipped, not imported over the trash row it belongs to.
    expect(await (d1.db as any).prepare(`SELECT id FROM entries WHERE id = 'trashed-id'`).first()).toBeNull();
  });

  it("a pre-4.0 shared event hides older events from a non-author", async () => {
    // created_at is 0, before every seeded event below (round 3 re-review MAJOR: readEntryTimeline
    // now hides an event older than its row's own created_at) -- this row is the pre-4.0 original,
    // not a reused id, so its own real history must stay visible.
    await d1.db.exec(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES ('p1', 'a shared memory', '["x"]', 'api', 0, '[]')`);
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV(), AI: makeAIMock(), VECTORIZE: makeVectorizeMock() });
    await initializeDatabase(env);
    env = d1.admitEnv(env);
    const roots = await ensureTenantBootstrap(env);
    // Landed in the company workspace before 4.0 ever recorded fromWorkspaceId on a move event.
    await (d1.db as any).prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = 'p1'`)
      .bind(roots.companyWorkspaceId, roots.ownerUserId).run();

    const bump = (event: string, actorId: string, now: number, payload: Record<string, unknown> = {}) =>
      env.DB.prepare(`INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), "p1", actorId, event, JSON.stringify(payload), now).run();
    await bump("created", roots.ownerUserId, 100);
    await bump("shared", roots.ownerUserId, 200, { workspaceId: roots.companyWorkspaceId }); // pre-4.0: no fromWorkspaceId
    await bump("updated", roots.ownerUserId, 300);

    const { token } = await createMember(env, { name: "Bob" });
    const bob = (await resolveIdentityFromToken(token, env))!;

    const history = await readEntryHistory(env, bob, "p1");
    const events = (history?.history.items.filter((i: any) => i.kind === "event") ?? []).map((e: any) => e.event);
    expect(events).not.toContain("created");
    expect(events).toContain("shared");
    expect(events).toContain("updated");
  });
});

describe("履歴テーブル欠落時の差分upgrade", () => {
  it("新表は完全なDDLで作成し既存記憶へbackfillしない", async () => {
    const sqlite = makeSqliteD1();
    try {
      await sqlite.db.exec("DROP TABLE entry_versions; DROP TABLE entries_trash; DELETE FROM schema_meta;");
      sqlite.seed({ id: "keep", content: "original", createdAt: 1000 });
      const original = await sqlite.db.prepare("SELECT * FROM entries WHERE id = 'keep'").first();
      resetDatabaseInit();
      const testEnv = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database });
      sqlite.issued.length = 0;
      await initializeDatabase(testEnv);
      const ddl = sqlite.issued.filter(sql => /^(CREATE|ALTER) /i.test(sql));
      expect(ddl.some(sql => sql.includes("CREATE TABLE IF NOT EXISTS entry_versions") && sql.includes("prior_length_utf16"))).toBe(true);
      expect(ddl.some(sql => sql.includes("CREATE TABLE IF NOT EXISTS entries_trash") && sql.includes("nonce"))).toBe(true);
      expect(ddl.filter(sql => /^ALTER TABLE (entry_versions|entries_trash) /i.test(sql))).toEqual([]);
      expect(await sqlite.db.prepare("SELECT * FROM entries WHERE id = 'keep'").first()).toEqual(original);
    } finally { sqlite.close(); }
  });
});
