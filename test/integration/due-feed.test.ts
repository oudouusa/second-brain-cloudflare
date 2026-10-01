/**
 * GET /due — the time-anchored feed a future push sender reads from.
 * Real SQLite, like GET /stale and GET /loops: this endpoint IS a WHERE
 * clause, and a mock that matches queries by substring cannot tell a correct
 * predicate from a broken one.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";
import { parseExplicitWhen } from "../../src/when/input";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; setDbReady(false); });

function dbOf(s: SqliteD1) {
  return { prepare: (sql: string) => s.db.prepare(sql), exec: (sql: string) => s.db.exec(sql), batch: (stmts: any[]) => s.db.batch(stmts) };
}

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  setDbReady(true);
  return s;
}

const envOf = (s: SqliteD1): Env => makeTestEnv(dbOf(s) as any);

const DAY = 24 * 60 * 60 * 1000;

function seedWhen(s: SqliteD1, id: string, content: string, whenAt: number, whenKind = "due", whenSource = "explicit") {
  s.seed({ id, content, createdAt: 1000 });
  s.db.prepare(`UPDATE entries SET when_at = ?, when_kind = ?, when_source = ? WHERE id = ?`)
    .bind(whenAt, whenKind, whenSource, id).run();
}

describe("GET /due", () => {
  it("requires auth", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("GET", "/due", { token: null }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("buckets into overdue and upcoming, and excludes entries with no when", async () => {
    sq = await migrated();
    const now = Date.now();
    seedWhen(sq, "past", "Renew the passport", now - DAY);
    seedWhen(sq, "soon", "File the report", now + DAY);
    seedWhen(sq, "far", "Something next month", now + 30 * DAY);
    sq.seed({ id: "no-when", content: "Never anchored", createdAt: 1000 });

    const data = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;

    expect(data.overdue.map((r: any) => r.id)).toEqual(["past"]);
    expect(data.upcoming.map((r: any) => r.id)).toEqual(["soon"]);
    expect(data.counts).toEqual({ overdue: 1, upcoming: 1 });
  });

  it("orders each bucket by when_at ascending", async () => {
    sq = await migrated();
    const now = Date.now();
    seedWhen(sq, "later-overdue", "B", now - DAY);
    seedWhen(sq, "earlier-overdue", "A", now - 2 * DAY);
    seedWhen(sq, "later-upcoming", "D", now + 2 * DAY);
    seedWhen(sq, "earlier-upcoming", "C", now + DAY);

    const data = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;

    expect(data.overdue.map((r: any) => r.id)).toEqual(["earlier-overdue", "later-overdue"]);
    expect(data.upcoming.map((r: any) => r.id)).toEqual(["earlier-upcoming", "later-upcoming"]);
  });

  it("carries content (truncated), a label, tags, and the when fields", async () => {
    sq = await migrated();
    const now = Date.now();
    const longContent = "x".repeat(300);
    sq.seed({ id: "e1", content: longContent, createdAt: 1000, tags: ["task", "work"] });
    sq.db.prepare(`UPDATE entries SET when_at = ?, when_kind = 'due', when_source = 'regex' WHERE id = 'e1'`)
      .bind(now - DAY).run();

    const data = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;

    const row = data.overdue[0];
    expect(row.content).toBe(longContent.slice(0, 200));
    expect(row.content.length).toBe(200);
    // No when_label on the regex path — falls back to the first 80 characters of content.
    expect(row.label).toBe(longContent.slice(0, 80));
    expect(row.tags).toEqual(expect.arrayContaining(["task", "work"]));
    expect(row.when_kind).toBe("due");
    expect(row.when_source).toBe("regex");
    expect(typeof row.when_at).toBe("number");
  });

  it("uses when_label as the label when the nightly pass set one", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "e2", content: "A much longer note about filing something eventually", createdAt: 1000 });
    sq.db.prepare(`UPDATE entries SET when_at = ?, when_kind = 'due', when_source = 'model', when_label = 'File the report' WHERE id = 'e2'`)
      .bind(now - DAY).run();

    const data = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;

    expect(data.overdue[0].label).toBe("File the report");
  });

  it("treats the exact 48-hour boundary as upcoming, not excluded", async () => {
    sq = await migrated();
    const now = Date.now();
    seedWhen(sq, "boundary", "Right at the edge", now + 48 * 60 * 60 * 1000);

    const data = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;
    expect(data.upcoming.map((r: any) => r.id)).toContain("boundary");
  });

  it("does not include something more than 48 hours out", async () => {
    sq = await migrated();
    const now = Date.now();
    seedWhen(sq, "too-far", "Not yet", now + 49 * 60 * 60 * 1000);

    const data = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;
    expect(data.upcoming).toEqual([]);
    expect(data.overdue).toEqual([]);
  });

  it("caps each bucket at 20 rows but counts the whole bucket", async () => {
    sq = await migrated();
    const now = Date.now();
    for (let i = 0; i < 25; i++) seedWhen(sq, `overdue-${i}`, `Item ${i}`, now - (i + 1) * 1000);

    const data = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;
    expect(data.overdue).toHaveLength(20);
    expect(data.counts.overdue).toBe(25);
  });

  // Finding 3: GET /due never required a "task" tag, but it also never
  // explicitly excluded deprecated entries — add that, and share the
  // predicate (DUE_SQL) with GET /brief's attention.due so they cannot
  // disagree the way they used to.
  it("does not include a deprecated entry", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "deprecated-due", content: "Old commitment", createdAt: 1000, tags: ["status:deprecated"] });
    sq.db.prepare(`UPDATE entries SET when_at = ? WHERE id = 'deprecated-due'`).bind(now - DAY).run();

    const data = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;

    expect(data.overdue).toEqual([]);
    expect(data.counts.overdue).toBe(0);
  });

  it("includes an untagged entry", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "untagged", content: "Renew the passport", createdAt: 1000, tags: [] });
    sq.db.prepare(`UPDATE entries SET when_at = ? WHERE id = 'untagged'`).bind(now - DAY).run();

    const data = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;

    expect(data.overdue.map((r: any) => r.id)).toEqual(["untagged"]);
  });
});

describe("POST /due/snooze", () => {
  it("requires auth", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/due/snooze", { token: null, body: { id: "x", until: "2027-01-01" } }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("requires id and until", async () => {
    sq = await migrated();
    const noId = await worker.fetch(req("POST", "/due/snooze", { body: { until: "2027-01-01" } }), envOf(sq), ctx);
    expect(noId.status).toBe(400);
    const noUntil = await worker.fetch(req("POST", "/due/snooze", { body: { id: "x" } }), envOf(sq), ctx);
    expect(noUntil.status).toBe(400);
  });

  it("rejects an unparseable until", async () => {
    sq = await migrated();
    seedWhen(sq, "e1", "File the report", Date.now() - DAY);
    const res = await worker.fetch(req("POST", "/due/snooze", { body: { id: "e1", until: "not-a-date" } }), envOf(sq), ctx);
    expect(res.status).toBe(400);
  });

  it("rejects a past until", async () => {
    sq = await migrated();
    seedWhen(sq, "e1", "File the report", Date.now() - DAY);
    const res = await worker.fetch(req("POST", "/due/snooze", { body: { id: "e1", until: "2020-01-01" } }), envOf(sq), ctx);
    expect(res.status).toBe(400);
  });

  it("rejects an until more than 5 years out", async () => {
    sq = await migrated();
    seedWhen(sq, "e1", "File the report", Date.now() - DAY);
    const farFuture = new Date(Date.now() + 6 * 365 * DAY).toISOString().slice(0, 10);
    const res = await worker.fetch(req("POST", "/due/snooze", { body: { id: "e1", until: farFuture } }), envOf(sq), ctx);
    expect(res.status).toBe(400);
  });

  it("404s for an id the caller cannot see", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/due/snooze", { body: { id: "missing", until: "2027-01-01" } }), envOf(sq), ctx);
    expect(res.status).toBe(404);
  });

  it("sets when_at to the new date and records an audit event", async () => {
    sq = await migrated();
    seedWhen(sq, "e1", "File the report", Date.now() - DAY);
    const until = "2027-06-15";

    const res = await worker.fetch(req("POST", "/due/snooze", { body: { id: "e1", until } }), envOf(sq), ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.when_at).toBe(Date.parse(until));

    const row = (await sq.db.prepare(`SELECT when_at FROM entries WHERE id = 'e1'`).first()) as any;
    expect(row.when_at).toBe(Date.parse(until));

    const events = (await sq.db.prepare(`SELECT event, payload FROM entry_events WHERE entry_id = 'e1'`).all()).results as any[];
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("status_changed");
    expect(JSON.parse(events[0].payload)).toEqual({ due_action: "snooze", until: Date.parse(until), prior: { when_at: expect.any(Number), when_kind: "due", when_label: null, when_source: "explicit" }, channel: "rest" });
  });
});

describe("POST /due/clear", () => {
  it("requires auth", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/due/clear", { token: null, body: { id: "x" } }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("requires id", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/due/clear", { body: {} }), envOf(sq), ctx);
    expect(res.status).toBe(400);
  });

  it("404s for an id the caller cannot see", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/due/clear", { body: { id: "missing" } }), envOf(sq), ctx);
    expect(res.status).toBe(404);
  });

  it("nulls when_at/when_kind/when_label and sets when_source to cleared", async () => {
    sq = await migrated();
    sq.seed({ id: "e1", content: "File the report", createdAt: 1000 });
    sq.db.prepare(`UPDATE entries SET when_at = ?, when_kind = 'due', when_source = 'model', when_label = 'File the report' WHERE id = 'e1'`)
      .bind(Date.now() - DAY).run();

    const res = await worker.fetch(req("POST", "/due/clear", { body: { id: "e1" } }), envOf(sq), ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);

    const row = (await sq.db.prepare(`SELECT when_at, when_kind, when_label, when_source FROM entries WHERE id = 'e1'`).first()) as any;
    expect(row.when_at).toBeNull();
    expect(row.when_kind).toBeNull();
    expect(row.when_label).toBeNull();
    expect(row.when_source).toBe("cleared");

    const events = (await sq.db.prepare(`SELECT event, payload FROM entry_events WHERE entry_id = 'e1'`).all()).results as any[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({ due_action: "clear", prior: { when_at: expect.any(Number), when_kind: "due", when_label: "File the report", when_source: "model" }, channel: "rest" });
  });

  it("drops the entry from GET /due once cleared", async () => {
    sq = await migrated();
    seedWhen(sq, "e1", "File the report", Date.now() - DAY);

    await worker.fetch(req("POST", "/due/clear", { body: { id: "e1" } }), envOf(sq), ctx);

    const data = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;
    expect(data.overdue.map((r: any) => r.id)).not.toContain("e1");
  });
});

/**
 * The user-visible contract TIMEZONE anchoring exists for: a reminder
 * captured as a bare date is overdue when the CONFIGURED zone's clock passes
 * midnight on that date, not when UTC's does. Before this, "2026-09-23"
 * turned overdue at 2026-09-22T20:00 Eastern (8pm the evening before) — a
 * push notification would have fired a night early for anyone west of
 * Greenwich.
 */
describe("GET /due — timezone-anchored overdue boundary", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("is NOT overdue just before midnight in the configured zone, and IS overdue just after", async () => {
    sq = await migrated();
    // SQLite's admission fence uses its real clock, so choose a future year
    // before replacing Date.now in the Worker under test.
    const year = new Date().getUTCFullYear() + 1;
    const parsed = parseExplicitWhen(`${year}-09-23`, undefined, undefined, "America/New_York");
    expect(parsed.error).toBeUndefined();
    seedWhen(sq, "e1", "File the report", parsed.value!.at);

    // 2026-09-23T01:00Z is 2026-09-22T21:00 Eastern (EDT, UTC-4) — 9pm the
    // evening before, not yet due.
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(year, 8, 23, 1, 0));
    const notYet = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;
    expect(notYet.overdue.map((r: any) => r.id)).not.toContain("e1");

    // 2026-09-23T05:01Z is 2026-09-23T01:01 Eastern — just past local midnight.
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(year, 8, 23, 5, 1));
    const overdue = await (await worker.fetch(req("GET", "/due"), envOf(sq), ctx)).json() as any;
    expect(overdue.overdue.map((r: any) => r.id)).toContain("e1");
  });
});
