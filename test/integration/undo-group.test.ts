/**
 * S3 (T-0089.4.3, 16-t3-t4-trust-spec.md Lane S, 5.9): "undo all" / "release
 * all". Real SQLite throughout (test/helpers/sqlite-d1.ts) -- membership and
 * per-member resolution both read entry_events and entry_versions with real
 * SQL semantics (json_each, a correlated MAX(seq) subquery, the reader-scope
 * clause), which test/helpers/d1-mock.ts does not model. Group keys are never
 * hand-encoded: every test discovers its real key from getChanges, the same
 * way the brief and the dashboard would.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import type { Env } from "../../src/env";
import type { Identity } from "../../src/lib/identity";
import { getChanges, UNDO_GROUP_PAGE, type ChangeGroup } from "../../src/brief/changes";
import { undoGroup, undoGroupMcpReply } from "../../src/memory/undo";
import { DEFAULTS } from "../../src/config";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { buildMcpServer } from "../../src/mcp/server";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const identity: Identity = { userId: "u1", role: "member", personalWorkspaceId: "ws-p", companyWorkspaceIds: [], defaultShare: "" };
const CFG = { ...DEFAULTS, QUARANTINE_STATUS_BURST: 3, QUARANTINE_WRITE_BURST: 3 };

describe("undoGroup() (S3)", () => {
  let sqlite: SqliteD1;
  let env: Env;
  let now: number;

  beforeEach(async () => {
    sqlite = makeSqliteD1();
    env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
    resetDatabaseInit();
    await initializeDatabase(env);
  env = sqlite.admitEnv(env);
    now = Date.UTC(2026, 8, 27, 12, 0, 0);
    vi.spyOn(Date, "now").mockReturnValue(now);
  });
  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  async function seedEntry(id: string, tags: string[]) {
    sqlite.seed({ id, content: `Memory ${id}`, createdAt: now - 10 * HOUR, tags, source: "api" });
    await sqlite.db.prepare(`UPDATE entries SET workspace_id = 'ws-p', actor_id = 'u1' WHERE id = ?`).bind(id).run();
  }

  async function insertVersion(opts: {
    entryId: string; seq: number; tags: string[]; actorId: string; channel: string; reason: string;
    meta?: Record<string, unknown>; createdAt: number; workspaceId?: string;
  }) {
    await sqlite.db.prepare(
      `INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, prior_length_utf16, tags, state, actor_id, channel, reason, meta, valid_from, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, '{}', ?, ?, ?, ?, NULL, ?)`,
    ).bind(
      opts.entryId, opts.workspaceId ?? "ws-p", opts.seq, `Memory ${opts.entryId}`, JSON.stringify(opts.tags), opts.actorId, opts.channel, opts.reason,
      JSON.stringify(opts.meta ?? {}), opts.createdAt,
    ).run();
  }

  async function insertEvent(opts: { id: string; entryId: string; event: string; actorId: string; createdAt: number; payload: Record<string, unknown> }) {
    await sqlite.db.prepare(
      `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(opts.id, opts.entryId, opts.actorId, opts.event, JSON.stringify(opts.payload), opts.createdAt).run();
  }

  /** A row moved to the trash: entries_trash's row_json follows entry-columns.ts's
   * ENTRY_ROW_COLUMNS shape (what restoreColumnsSql reads back on undo). */
  async function insertTrashRow(id: string, opts: { actorId: string; deletedAt: number }) {
    const rowJson = JSON.stringify({ tags: ["work"], source: "api", created_at: opts.deletedAt - HOUR, workspace_id: "ws-p", actor_id: opts.actorId });
    await sqlite.db.prepare(
      `INSERT INTO entries_trash (id, workspace_id, actor_id, content, row_json, edges_json, vector_ids, deleted_at, deleted_by, channel, reason, nonce)
       VALUES (?, 'ws-p', ?, ?, ?, '[]', '[]', ?, ?, 'mcp', 'forget', lower(hex(randomblob(16))))`,
    ).bind(id, opts.actorId, `Memory ${id}`, rowJson, opts.deletedAt, opts.actorId).run();
  }

  /** A "status" burst, same actor and client, all inside a 10-minute window (below the shipped
   * QUARANTINE_STATUS_BURST default, so CFG lowers it to 3 to keep fixtures small -- the same
   * technique brief-changes.test.ts's own "group thresholds" tests use). A version's `tags`
   * column is the pre-image: whatever the row looked like right BEFORE that version's own write
   * (selectList in versions.ts snapshots `e.tags` before applying the new value) -- so each
   * member's live row already carries the POST-change tags (["work","status:canonical"], set
   * directly by seed()) and gets exactly one version, seq 1, holding the PRE-change tags
   * (["work"]), channel mcp, client "Cursor", created_at inside [windowStart, windowEnd]. */
  async function seedStatusBurst(ids: string[], windowStart: number): Promise<number> {
    let t = windowStart;
    for (const id of ids) {
      await seedEntry(id, ["work", "status:canonical"]);
      // Round 3 re-review MAJOR: classifyFromRows now matches a version to the group by an exact
      // event id, stamped into the version's own meta.event_id -- the same id this member's own
      // entry_events row carries, exactly the link src/capture/lifecycle.ts's applyStatus and
      // src/memory/undo.ts's releaseHeldAfterEdit/revertEntry stamp for real at write time.
      await insertVersion({ entryId: id, seq: 1, tags: ["work"], actorId: "u1", channel: "mcp", reason: "status", meta: { client: "Cursor", event_id: `ev-${id}` }, createdAt: t });
      await insertEvent({ id: `ev-${id}`, entryId: id, event: "status_changed", actorId: "u1", createdAt: t, payload: { channel: "mcp", status: "canonical", client: "Cursor" } });
      t += MIN;
    }
    return t - MIN;
  }

  async function discoverGroup(): Promise<ChangeGroup> {
    const changes = await getChanges(env, identity, undefined, CFG);
    const group = changes.items.find((i): i is ChangeGroup => i.kind === "group");
    if (!group) throw new Error("no group formed — check the burst fixture");
    return group;
  }

  async function tagsOf(id: string): Promise<string[]> {
    const row = await sqlite.db.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(id).first() as { tags: string };
    return JSON.parse(row.tags) as string[];
  }

  async function maxSeqOf(id: string): Promise<number> {
    const row = await sqlite.db.prepare(`SELECT MAX(seq) as m FROM entry_versions WHERE entry_id = ?`).bind(id).first() as { m: number };
    return row.m;
  }

  it("undo group reverts each member to before the group's first change", async () => {
    const ids = ["e0", "e1", "e2"];
    await seedStatusBurst(ids, now - HOUR);
    const group = await discoverGroup();

    const result = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);
    expect(result).not.toBeNull();
    expect(result!.results.slice().sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      ids.map(id => ({ id, result: "reverted" })).sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(result!.remaining).toBe(0);
    expect(result!.done).toBe(true);

    for (const id of ids) {
      const tags = await tagsOf(id);
      expect(tags).not.toContain("status:canonical");
      expect(tags).toContain("work");
    }
  });

  it("a member written twice inside the group reverts to before its FIRST change, not its second (Codex cross-vendor review, round 2 re-review MAJOR)", async () => {
    // e0 was edited twice inside the burst window, both by u1/mcp/Cursor: seq 1's own pre-image
    // is ["work"] (before either edit), seq 2's is ["work","status:canonical"] (after the first
    // edit, before the second). Reverting the group must land on seq 1's pre-image -- "before the
    // group's first change" -- not seq 2's, which would only undo the second of the two edits.
    // e1/e2 are the burst's other two members (QUARANTINE_STATUS_BURST needs 3 to form a group).
    const ids = ["e0", "e1", "e2"];
    const windowStart = now - HOUR;
    await seedStatusBurst(ids, windowStart);
    await sqlite.db.prepare(`UPDATE entries SET tags = ? WHERE id = 'e0'`).bind(JSON.stringify(["v2", "work", "status:canonical"])).run();
    // e0's own SECOND group event (round 3 re-review MAJOR): classifyFromRows now requires a
    // version's own meta.event_id, not a time window or an actor/client match, so a second
    // in-group edit needs its own second qualifying event too, not just a second version.
    await insertVersion({ entryId: "e0", seq: 2, tags: ["work", "status:canonical"], actorId: "u1", channel: "mcp", reason: "status", meta: { client: "Cursor", event_id: "ev-e0-2" }, createdAt: windowStart + 30_000 });
    await insertEvent({ id: "ev-e0-2", entryId: "e0", event: "status_changed", actorId: "u1", createdAt: windowStart + 30_000, payload: { channel: "mcp", status: "canonical", client: "Cursor" } });

    const group = await discoverGroup();
    const result = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);

    const byId = Object.fromEntries(result!.results.map(r => [r.id, r.result]));
    expect(byId.e0).toBe("reverted");
    expect(byId.e1).toBe("reverted");
    expect(byId.e2).toBe("reverted");
    expect(result!.done).toBe(true);
    const tags = await tagsOf("e0");
    expect(tags).not.toContain("status:canonical");
    expect(tags).not.toContain("v2");
    expect(tags).toContain("work");
  });

  it("an earlier separate edit by the group's own actor and client is never folded in (round 3 re-review MAJOR, repro 1)", async () => {
    // e0's own real group event is seq 2. Seq 1 is a genuinely earlier, unrelated edit -- same
    // actor (u1), same client label (Cursor), immediately adjacent in the chain -- exactly what
    // the old actor/client walk-back could not tell apart from the group's own second change.
    // classifyFromRows now only ever matches by meta.event_id, so seq 1 (no event_id at all) can
    // never be folded in, whatever it shares with the group's own writer.
    const windowStart = now - HOUR;
    await seedEntry("e0", ["work", "status:canonical"]);
    await insertVersion({ entryId: "e0", seq: 1, tags: ["original"], actorId: "u1", channel: "mcp", reason: "status", meta: { client: "Cursor" }, createdAt: windowStart - 30 * MIN });
    await insertVersion({ entryId: "e0", seq: 2, tags: ["work"], actorId: "u1", channel: "mcp", reason: "status", meta: { client: "Cursor", event_id: "ev-e0" }, createdAt: windowStart });
    await insertEvent({ id: "ev-e0", entryId: "e0", event: "status_changed", actorId: "u1", createdAt: windowStart, payload: { channel: "mcp", status: "canonical", client: "Cursor" } });
    await seedStatusBurst(["e1", "e2"], windowStart + MIN);

    const group = await discoverGroup();
    const result = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);

    const byId = Object.fromEntries(result!.results.map(r => [r.id, r.result]));
    expect(byId.e0).toBe("reverted");
    // Reverted only to seq 2's own pre-image ("work"), never past it to seq 1's ("original").
    expect(await tagsOf("e0")).toEqual(["work"]);
  });

  it("a third party's edit sandwiched between the group's own two events gives changed_since, never done (round 3 re-review MAJOR, repro 2)", async () => {
    const windowStart = now - HOUR;
    await seedEntry("e0", ["work", "status:canonical"]);
    await insertVersion({ entryId: "e0", seq: 1, tags: ["work"], actorId: "u1", channel: "mcp", reason: "status", meta: { client: "Cursor", event_id: "ev-e0-1" }, createdAt: windowStart });
    await insertEvent({ id: "ev-e0-1", entryId: "e0", event: "status_changed", actorId: "u1", createdAt: windowStart, payload: { channel: "mcp", status: "canonical", client: "Cursor" } });
    // A third party's edit lands between the group's own two events -- same actor and client
    // label even, the exact case the old design could not rule out without a real link.
    await insertVersion({ entryId: "e0", seq: 2, tags: ["work", "status:canonical"], actorId: "u2", channel: "mcp", reason: "update", meta: { client: "Cursor" }, createdAt: windowStart + 20_000 });
    await insertVersion({ entryId: "e0", seq: 3, tags: ["edited", "status:canonical"], actorId: "u1", channel: "mcp", reason: "status", meta: { client: "Cursor", event_id: "ev-e0-3" }, createdAt: windowStart + 40_000 });
    await insertEvent({ id: "ev-e0-3", entryId: "e0", event: "status_changed", actorId: "u1", createdAt: windowStart + 40_000, payload: { channel: "mcp", status: "canonical", client: "Cursor" } });
    await sqlite.db.prepare(`UPDATE entries SET tags = ? WHERE id = 'e0'`).bind(JSON.stringify(["final", "work", "status:canonical"])).run();
    await seedStatusBurst(["e1", "e2"], windowStart + MIN);

    const group = await discoverGroup();
    const result = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);

    const byId = Object.fromEntries(result!.results.map(r => [r.id, r.result]));
    expect(byId.e0).toBe("changed_since");
    expect(await tagsOf("e0")).toEqual(["final", "work", "status:canonical"]);
    expect(await maxSeqOf("e0")).toBe(3);
  });

  it("a member changed since by someone else is skipped as changed_since and untouched", async () => {
    const ids = ["e0", "e1", "e2"];
    const windowStart = now - HOUR;
    const windowEnd = await seedStatusBurst(ids, windowStart);
    // Someone else edits e1 after the group's own window closed: a new version (seq 2) whose
    // pre-image is e1's current tags, and a live row moved on to something new.
    await insertVersion({ entryId: "e1", seq: 2, tags: ["work", "status:canonical"], actorId: "u2", channel: "mcp", reason: "update", createdAt: windowEnd + MIN });
    await sqlite.db.prepare(`UPDATE entries SET tags = ? WHERE id = 'e1'`).bind(JSON.stringify(["edited", "status:canonical", "work"])).run();

    const group = await discoverGroup();
    const result = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);

    const byId = Object.fromEntries(result!.results.map(r => [r.id, r.result]));
    expect(byId.e0).toBe("reverted");
    expect(byId.e2).toBe("reverted");
    expect(byId.e1).toBe("changed_since");

    // Untouched: e1 still has exactly the tags u2 left it with, and no seq 3 was written.
    expect(await tagsOf("e1")).toEqual(["edited", "status:canonical", "work"]);
    expect(await maxSeqOf("e1")).toBe(2);
  });

  it("release-all group releases each held member", async () => {
    const ids = ["h0", "h1", "h2"];
    let t = now - HOUR;
    for (const id of ids) {
      await seedEntry(id, ["work", "quarantine:instruction"]);
      await insertVersion({ entryId: id, seq: 1, tags: ["work"], actorId: "u1", channel: "rest", reason: "update", createdAt: t - HOUR });
      await insertVersion({ entryId: id, seq: 2, tags: ["work", "quarantine:instruction"], actorId: "u1", channel: "mcp", reason: "update", createdAt: t });
      await insertEvent({ id: `ev-${id}`, entryId: id, event: "held", actorId: "", createdAt: t, payload: { channel: "mcp", reasons: ["instruction"] } });
      t += MIN;
    }

    const group = await discoverGroup();
    expect(group.family).toBe("held");
    const result = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);

    expect(result!.results.slice().sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      ids.map(id => ({ id, result: "released" })).sort((a, b) => a.id.localeCompare(b.id)),
    );
    for (const id of ids) {
      const tags = await tagsOf(id);
      expect(tags.some(t2 => t2.startsWith("quarantine:"))).toBe(false);
    }
  });

  it("undo group restores each trashed member, skipping one someone already restored", async () => {
    const ids = ["t0", "t1", "t2"];
    let t = now - HOUR;
    for (const id of ids) {
      await insertTrashRow(id, { actorId: "u1", deletedAt: t });
      await insertEvent({ id: `ev-${id}`, entryId: id, event: "deleted", actorId: "u1", createdAt: t, payload: { channel: "mcp", trash: true, client: "Cursor" } });
      t += MIN;
    }

    const group = await discoverGroup();
    expect(group.family).toBe("trash");

    // t1 is restored by someone else (an ordinary /undo or /restore call) before undo/group runs:
    // no longer in entries_trash, and back in entries.
    await sqlite.db.prepare(`UPDATE entries_trash SET write_marker = ? WHERE id = 't1'`).bind(sqlite.fixtureMarker('delete')).run();
    await sqlite.db.prepare(`DELETE FROM entries_trash WHERE id = 't1'`).run();
    await seedEntry("t1", ["work"]);

    const result = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);

    // t1 is silently excluded: never re-attempted, never reported.
    expect(result!.results.slice().sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [{ id: "t0", result: "restored" }, { id: "t2", result: "restored" }],
    );
    expect(result!.remaining).toBe(0);
    expect(result!.done).toBe(true);

    for (const id of ["t0", "t2"]) {
      const row = await sqlite.db.prepare(`SELECT id FROM entries WHERE id = ?`).bind(id).first();
      expect(row).not.toBeNull();
      const trashRow = await sqlite.db.prepare(`SELECT id FROM entries_trash WHERE id = ?`).bind(id).first();
      expect(trashRow).toBeNull();
    }
    // t1's own already-restored state is exactly as the "someone else" left it, untouched by this call.
    expect(await tagsOf("t1")).toEqual(["work"]);
  });

  it("pages of 5, remaining counts down, 40 or fewer statements per page", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `e${i}`);
    await seedStatusBurst(ids, now - HOUR);
    const group = await discoverGroup();
    expect(group.count).toBe(12);

    sqlite.issued.length = 0;
    const page1 = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);
    expect(page1!.results).toHaveLength(UNDO_GROUP_PAGE);
    expect(page1!.remaining).toBe(7);
    expect(page1!.done).toBe(false);
    expect(sqlite.issued.length).toBeLessThanOrEqual(40);

    const page2 = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);
    expect(page2!.results).toHaveLength(UNDO_GROUP_PAGE);
    expect(page2!.remaining).toBe(2);
    expect(page2!.done).toBe(false);

    const page3 = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);
    expect(page3!.results).toHaveLength(2);
    expect(page3!.remaining).toBe(0);
    expect(page3!.done).toBe(true);

    const allReverted = [...page1!.results, ...page2!.results, ...page3!.results];
    expect(allReverted.every(r => r.result === "reverted")).toBe(true);
    expect(new Set(allReverted.map(r => r.id)).size).toBe(12);
  });

  it("advances past the first page when the undo lands in the group's end millisecond", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `e${i}`);
    await seedStatusBurst(ids, now - 11 * MIN); // newest event is exactly Date.now()
    const group = await discoverGroup();
    expect(group.until).toBe(now);
    const change = { actorId: "u1", channel: "mcp" as const, client: "Cursor" };

    const first = await undoGroup(env, identity, group.group, change, CFG);
    const second = await undoGroup(env, identity, group.group, change, CFG);

    expect(first!.remaining).toBe(7);
    expect(second!.results.map(r => r.id)).toEqual(ids.slice(5, 10));
    expect(second!.remaining).toBe(2);
  });

  it("a tampered group key selects only the caller's readable, permitted events", async () => {
    const ids = ["e0", "e1", "e2"];
    await seedStatusBurst(ids, now - HOUR);
    // Someone else's memories, in a workspace this reader cannot see.
    const otherIds = ["o0", "o1", "o2"];
    let t = now - HOUR;
    for (const id of otherIds) {
      sqlite.seed({ id, content: `Memory ${id}`, createdAt: now - 10 * HOUR, tags: ["work", "status:canonical"], source: "api" });
      await sqlite.db.prepare(`UPDATE entries SET workspace_id = 'ws-other', actor_id = 'u2' WHERE id = ?`).bind(id).run();
      await insertVersion({ entryId: id, seq: 1, tags: ["work"], actorId: "u2", channel: "rest", reason: "update", createdAt: t - HOUR, workspaceId: "ws-other" });
      await insertVersion({ entryId: id, seq: 2, tags: ["work", "status:canonical"], actorId: "u2", channel: "mcp", reason: "status", meta: { client: "Cursor" }, createdAt: t, workspaceId: "ws-other" });
      t += MIN;
    }

    const group = await discoverGroup();
    const decoded = JSON.parse(Buffer.from(group.group.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { a: string; c: string | null; s: number; e: number };

    // A tampered key claiming the SAME shape but someone else's actor: matches nothing in this
    // reader's scope, since changeEventRows' own "whose changes" clause is tied to the reader
    // (identity.userId), not to the key's own actor field.
    const tampered = Buffer.from(JSON.stringify({ f: "status", a: "u2", c: "Cursor", s: decoded.s, e: decoded.e }))
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const result = await undoGroup(env, identity, tampered, { actorId: "u1", channel: "mcp" }, CFG);
    expect(result!.results).toHaveLength(0);
    expect(result!.total).toBe(0);

    // The reader's own real group still resolves normally and never touches o0-o2.
    const real = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);
    expect(real!.results.map(r => r.id).sort()).toEqual(ids.slice().sort());
    for (const id of otherIds) {
      expect(await maxSeqOf(id)).toBe(2);
    }
  });

  it("a widened group key cannot roll back an earlier teammate edit outside the group", async () => {
    const start = now - HOUR;
    await seedStatusBurst(["e0", "e1", "e2"], start);
    // The status group's first change to e0 is seq 2. Seq 1 is an earlier edit by
    // a teammate using the same client; its pre-image must remain outside the undo.
    await sqlite.db.prepare(`UPDATE entry_versions SET seq = 2 WHERE entry_id = 'e0'`).run();
    await insertVersion({ entryId: "e0", seq: 1, tags: ["original"], actorId: "u2",
      channel: "mcp", reason: "update", meta: { client: "Cursor" }, createdAt: start - 30 * MIN });
    const group = await discoverGroup();
    const decoded = JSON.parse(Buffer.from(group.group.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const widened = Buffer.from(JSON.stringify({ ...decoded, s: start - 30 * MIN }))
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    await undoGroup(env, identity, widened, { actorId: "u1", channel: "mcp" }, CFG);

    expect(await tagsOf("e0")).toEqual(["work"]);
  });

  it("group larger than 50 is capped", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `e${String(i).padStart(2, "0")}`);
    await seedStatusBurst(ids, now - HOUR);
    const group = await discoverGroup();

    const result = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);
    expect(result!.total).toBe(50);
    expect(result!.capped).toBe(true);
  });

  it("3 real MCP update calls on canonical rows form a group, and undoGroup reverts all 3 (round 4 re-review MAJOR: canonical edits were dead for undo-group)", async () => {
    const ids = ["c0", "c1", "c2"];
    for (const id of ids) await seedEntry(id, ["work", "status:canonical"]);

    const server = buildMcpServer(env, { waitUntil: () => {} } as unknown as ExecutionContext, identity);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "group-review", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      for (const id of ids) {
        await client.callTool({ name: "update", arguments: { id, content: `${id} edited` } });
      }
    } finally {
      await client.close();
      await server.close();
    }

    const changes = await getChanges(env, identity, undefined, CFG);
    const group = changes.items.find((i): i is ChangeGroup => i.kind === "group" && i.family === "canonical_edit");
    expect(group, `no canonical_edit group formed — items: ${JSON.stringify(changes.items)}`).toBeDefined();

    const result = await undoGroup(env, identity, group!.group, { actorId: "u1", channel: "mcp" }, CFG);
    expect(result!.results.slice().sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      ids.map(id => ({ id, result: "reverted" })).sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(result!.done).toBe(true);
    for (const id of ids) {
      const row = await sqlite.db.prepare(`SELECT content FROM entries WHERE id = ?`).bind(id).first() as { content: string };
      expect(row!.content).toBe(`Memory ${id}`);
    }
  });

  it("a teammate's edit lands on c2 while c0's own revert is re-embedding: c2 comes back changed_since, with the teammate's edit intact, not wiped (round 4 re-review MAJOR)", async () => {
    const ids = ["c0", "c1", "c2"];
    for (const id of ids) await seedEntry(id, ["work", "status:canonical"]);

    const server = buildMcpServer(env, { waitUntil: () => {} } as unknown as ExecutionContext, identity);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "group-review", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      // Distinct, strictly ascending timestamps, all at or before `now` (getChanges' own window
      // is created_at <= its read of Date.now()) -- the group's own membership order is
      // oldest-first, so this pins c0 as the loop's first revert and c2 as its last, matching the
      // reviewer's own repro precisely rather than leaving it to however SQLite happens to break
      // a tie among 3 identical timestamps.
      for (const [i, id] of ids.entries()) {
        vi.spyOn(Date, "now").mockReturnValue(now - (ids.length - 1 - i) * 1000);
        await client.callTool({ name: "update", arguments: { id, content: `${id} edited` } });
      }
      vi.spyOn(Date, "now").mockReturnValue(now);
    } finally {
      await client.close();
      await server.close();
    }

    const changes = await getChanges(env, identity, undefined, CFG);
    const group = changes.items.find((i): i is ChangeGroup => i.kind === "group" && i.family === "canonical_edit");
    expect(group, `no canonical_edit group formed — items: ${JSON.stringify(changes.items)}`).toBeDefined();

    // The race: undoGroup classifies every member up front, then reverts them one at a time in
    // the SAME call, each with its own re-embed. A teammate's edit to c2 landing during c0's own
    // re-embed (the reviewer's own repro) falls in the gap between c2's classification and c2's
    // own turn in that same loop.
    let fired = false;
    const realRun = env.AI.run.bind(env.AI);
    (env.AI as unknown as { run: (...args: unknown[]) => unknown }).run = vi.fn(async (...args: unknown[]) => {
      if (!fired) {
        fired = true;
        const newest = await sqlite.db.prepare(`SELECT MAX(seq) as m FROM entry_versions WHERE entry_id = 'c2'`).first() as { m: number };
        await insertVersion({ entryId: "c2", seq: newest!.m + 1, tags: ["work", "status:canonical"], actorId: "u2", channel: "mcp", reason: "update", createdAt: Date.now() });
        await sqlite.db.prepare(`UPDATE entries SET content = ? WHERE id = 'c2'`).bind("c2 teammate edit").run();
      }
      return (realRun as (...a: unknown[]) => unknown)(...args);
    });

    const result = await undoGroup(env, identity, group!.group, { actorId: "u1", channel: "mcp" }, CFG);
    expect(fired).toBe(true);
    const byId = Object.fromEntries(result!.results.map(r => [r.id, r.result]));
    expect(byId.c0).toBe("reverted");
    expect(byId.c1).toBe("reverted");
    expect(byId.c2).toBe("changed_since");

    const row = await sqlite.db.prepare(`SELECT content FROM entries WHERE id = 'c2'`).first() as { content: string };
    expect(row!.content).toBe("c2 teammate edit");
  });

  it("MCP undo(group) replies with progress and never accepts an id list", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `e${i}`);
    await seedStatusBurst(ids, now - HOUR);
    const group = await discoverGroup();

    const page1 = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);
    expect(undoGroupMcpReply(page1!)).toBe(
      "Undid 5 of 12 changes in that group; call undo with the same group again to continue.",
    );

    await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);
    const page3 = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);
    expect(undoGroupMcpReply(page3!)).toBe("Undid all 12 changes in that group.");
  });

  it("rejects MCP undo with both id and group before any bulk write", async () => {
    const ids = ["e0", "e1", "e2"];
    await seedStatusBurst(ids, now - HOUR);
    const group = await discoverGroup();
    const server = buildMcpServer(env, { waitUntil: () => {} } as unknown as ExecutionContext, identity);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "group-review", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      await client.callTool({ name: "undo", arguments: { id: "e0", group: group.group } });
    } finally {
      await client.close();
      await server.close();
    }

    for (const id of ids) expect(await maxSeqOf(id)).toBe(1);
  });

  it("the oldest member's version created_at, however far from the group's own event times, is still included (Codex review, T-0102 E1; round 3 re-review MAJOR supersedes the fix)", async () => {
    // E1's own bug: a version's created_at can drift from its audit event's own, slightly later
    // Date.now() call by an unbounded amount under real Workers scheduling, and the old design
    // compared the two directly (decoded.start, a lower bound derived from event times). No fixed
    // slack was ever enough (the director's own follow-up on E1's first fix). classifyFromRows no
    // longer reads created_at AT ALL -- it matches a version to the group by its own meta.event_id,
    // the same id its causing event carries -- so this now proves something stronger than either
    // of E1's two prior tests: not just "close enough", but "time doesn't factor in at all".
    const ids = ["e0", "e1", "e2"];
    const windowStart = now - HOUR;
    let t = windowStart;
    for (const id of ids) {
      await seedEntry(id, ["work", "status:canonical"]);
      const versionAt = id === ids[0] ? t - HOUR : t;
      await insertVersion({ entryId: id, seq: 1, tags: ["work"], actorId: "u1", channel: "mcp", reason: "status", meta: { client: "Cursor", event_id: `ev-${id}` }, createdAt: versionAt });
      await insertEvent({ id: `ev-${id}`, entryId: id, event: "status_changed", actorId: "u1", createdAt: t, payload: { channel: "mcp", status: "canonical", client: "Cursor" } });
      t += MIN;
    }
    const group = await discoverGroup();

    const result = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);

    const byId = Object.fromEntries(result!.results.map(r => [r.id, r.result]));
    expect(byId[ids[0]]).toBe("reverted");
    expect(result!.remaining).toBe(0);
    expect(result!.done).toBe(true);
  });

  it("every page of a 50-member group stays at 40 or fewer statements, not growing page over page (Codex review, T-0102 R23)", async () => {
    // R23 (auditor, MINOR): E2's fix reclassifies every id from ids[0] on every call (paging is
    // stateless), so with one classifyMember SELECT per id, each already-"done" member from a
    // prior page still cost its own SELECT to reclassify -- growing by UNDO_GROUP_PAGE statements
    // every page, reaching 71 by the group's tenth page against this lane's 40-statement target.
    const ids = Array.from({ length: 50 }, (_, i) => `e${i}`);
    await seedStatusBurst(ids, now - HOUR);
    const group = await discoverGroup();
    expect(group.count).toBe(50);

    const reverted: string[] = [];
    for (let page = 1; page <= 10; page++) {
      sqlite.issued.length = 0;
      const result = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);
      expect(sqlite.issued.length, `page ${page}`).toBeLessThanOrEqual(40);
      expect(result!.results).toHaveLength(UNDO_GROUP_PAGE);
      reverted.push(...result!.results.map(r => r.id));
    }
    expect(new Set(reverted).size).toBe(50);
  });

  it("more than UNDO_GROUP_PAGE blocked members ahead of actionable ones does not stall the group forever (Codex review, T-0102 E2)", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `e${i}`);
    const windowStart = now - HOUR;
    const windowEnd = await seedStatusBurst(ids, windowStart);
    // The first 6 members (more than UNDO_GROUP_PAGE = 5) are each edited by someone else after
    // the group's own window closes, so classifyMember reports them changed_since forever -- they
    // never become "done" and are never actually reverted.
    const blocked = ids.slice(0, 6);
    for (const id of blocked) {
      await insertVersion({ entryId: id, seq: 2, tags: ["work", "status:canonical"], actorId: "u2", channel: "mcp", reason: "update", createdAt: windowEnd + MIN });
      await sqlite.db.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(["edited", "status:canonical", "work"]), id).run();
    }
    const group = await discoverGroup();
    expect(group.count).toBe(12);

    const result = await undoGroup(env, identity, group.group, { actorId: "u1", channel: "mcp" }, CFG);

    const byId = Object.fromEntries(result!.results.map(r => [r.id, r.result]));
    for (const id of blocked) expect(byId[id]).toBe("changed_since");
    // The old code stopped scanning the moment 5 (UNDO_GROUP_PAGE) blocked members had been
    // reported, having advanced no further than index 5 -- and since that scan position is never
    // persisted between calls, every later call re-examined the exact same 5 and could never reach
    // an actionable member at all. This call must reach past all 6 blocked members and actually
    // revert some of the remaining 6 actionable ones.
    const reverted = result!.results.filter(r => r.result === "reverted");
    expect(reverted.length).toBeGreaterThan(0);
    expect(result!.remaining).toBeLessThan(6);
  });
});
