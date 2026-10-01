/**
 * GET /brief against real SQLite: what it returns, and what it costs.
 *
 * The brief runs on every app open, so its cost is a product decision, not an
 * implementation detail — this codebase holds a Worker invocation to a
 * self-imposed budget of roughly 50 D1 calls (the platform's real ceiling is
 * 1,000 D1/KV/Vectorize calls per invocation), and an endpoint that quietly
 * grew to a dozen would eat a quarter of that self-imposed budget before the
 * user typed anything. The count is pinned here for the same reason /import's
 * is: the way this regresses is by someone adding "just one more" query to a
 * Promise.all.
 */
import { describe, it, expect, afterEach } from "vitest";
import worker from "../../src/index";
import { withStaleAsOf } from "../../src/memory/stale";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";
import type { Env } from "../../src/env";
import { computeAgentBrief, computeLeanBrief } from "../../src/brief/compute";
import type { Identity } from "../../src/lib/identity";

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; setDbReady(false); });

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;

function dbOf(s: SqliteD1) {
  const issuedAt = new WeakMap<object, number>();
  const wrap = (statement: any, index: number): any => {
    const wrapped = {
      bind(...args: unknown[]) { return wrap(statement.bind(...args), index); },
      all() { return statement.all(); },
      first() { return statement.first(); },
      run() { return statement.run(); },
    };
    issuedAt.set(wrapped, index);
    return wrapped;
  };
  return {
    prepare: (sql: string) => {
      const statement = s.db.prepare(sql);
      return wrap(statement, s.issued.length - 1);
    },
    exec: (sql: string) => s.db.exec(sql),
    async batch(stmts: { run(): Promise<any> }[]) {
      const out: any[] = [];
      try {
        for (const st of stmts) out.push(await st.run());
        // Each statement's rows are kept, not discarded: a batch carries reads as
        // well as writes now — identity resolution pairs its SELECT with the
        // throttled last_used_at stamp so the pair costs one subrequest — and D1
        // returns a result per statement. `changes: 1` is preserved for the write
        // paths that read it.
        return out.map((r: any) => ({ ...r, meta: { changes: 1, ...r?.meta } }));
      } finally {
        // A rejected remote D1 batch is still one subrequest. Compact it on the
        // error path too or the write-fence retry is misreported as N queries.
        // Prepared writes can be interleaved with awaited reads while the batch
        // is assembled, so remove their exact slots instead of assuming they are
        // the final N issued statements.
        const indexes = [...new Set(stmts.map(st => issuedAt.get(st as object)))]
          .filter((index): index is number => index !== undefined)
          .sort((a, b) => b - a);
        for (const index of indexes) s.issued.splice(index, 1);
        s.issued.push(`BATCH(${stmts.length})`);
      }
    },
  };
}

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  setDbReady(true); // the brief must not pay for schema init on every open
  s.issued.length = 0;
  return s;
}

function envOf(s: SqliteD1): Env {
  return makeTestEnv(dbOf(s) as any);
}

const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

describe("GET /brief", () => {
  it("requires auth", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("GET", "/brief", { token: null }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("costs a fixed handful of D1 queries regardless of how much is there", async () => {
    sq = await migrated();
    const now = Date.now();
    for (let i = 0; i < 200; i++) {
      sq.seed({
        id: `id-${i}`,
        content: `Memory ${i}`,
        createdAt: now - (i % 5) * HOUR,
        source: i % 2 ? "claude-desktop" : "email-gmail",
      });
    }
    sq.issued.length = 0;

    const res = await worker.fetch(req("GET", "/brief"), envOf(sq), ctx);
    expect(res.status).toBe(200);

    // Six brief reads plus Team Edition's first-use identity/bootstrap cost.
    // A legacy brain already contains fenced entry rows, so its first bootstrap
    // intentionally retries once under a write admission: initial bootstrap 3,
    // admission 1, admitted bootstrap 4 (including the personal-workspace
    // invariant check), release 1, identity 1, brief 6 = 16.
    // Bootstrap is memoised per database; subsequent app opens pay only 7.
    //
    // This is the COLD path: `users.last_used_at` is NULL on a brain nobody has
    // authenticated against, so this request also owes the stamp. It rides in
    // the identity batch rather than becoming another subrequest. The write
    // really happens; the assertion below proves it landed.
    // 4.0のchanges追加1 SELECT。cold bootstrap保護を含め計18 SQL。
    expect(sq.issued).toHaveLength(18);
    const stamped = await sq.db
      .prepare(`SELECT last_used_at FROM users WHERE last_used_at IS NOT NULL`)
      .first() as { last_used_at: number } | null;
    expect(stamped?.last_used_at).toBeGreaterThan(0);
  });

  it("does not pay the last_used_at stamp again on the next app open", async () => {
    // The throttle is what keeps the line above a once-an-hour cost rather than
    // a permanent one. Without it every request in the deployment would carry
    // an extra D1 write, which is the version of this feature that would not be
    // worth shipping.
    sq = await migrated();
    sq.seed({ id: "id-0", content: "Memory", createdAt: Date.now() - HOUR });
    // One env, so the tenant bootstrap memo (keyed on env.DB) survives between
    // the two requests the way it does in production.
    const env = envOf(sq);
    const stampedAt = async () => ((await sq!.db
      .prepare(`SELECT last_used_at FROM users WHERE last_used_at IS NOT NULL`)
      .first()) as { last_used_at: number } | null)?.last_used_at;
    await worker.fetch(req("GET", "/brief"), env, ctx);
    const first = await stampedAt();
    expect(first).toBeGreaterThan(0);
    const cold = sq.issued.length;
    sq.issued.length = 0;

    const res = await worker.fetch(req("GET", "/brief"), env, ctx);

    expect(res.status).toBe(200);
    // Eight reads and the identity batch (S2's changes query counted the same as
    // every other concurrent read here). The bootstrap the first open paid for
    // is gone, and the stamp inside that batch is now a no-op the throttle
    // skips — the statement is still carried, but it matches no row and writes
    // nothing.
    expect(sq.issued).toHaveLength(9);
    expect(cold).toBeGreaterThan(sq.issued.length);
    expect(await stampedAt()).toBe(first);
  });

  it("reports what arrived and where it came from", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "a", content: "From Claude", createdAt: now - HOUR, source: "claude-desktop" });
    sq.seed({ id: "b", content: "From Claude too", createdAt: now - 2 * HOUR, source: "claude-desktop" });
    sq.seed({ id: "c", content: "From mail", createdAt: now - 3 * HOUR, source: "email-gmail" });
    // Older than the window: counted by nobody.
    sq.seed({ id: "old", content: "Last week", createdAt: now - 8 * DAY, source: "cli" });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.captured).toBe(3);
    expect(data.sources).toEqual([
      { source: "claude-desktop", count: 2 },
      { source: "email-gmail", count: 1 },
    ]);
  });

  it("surfaces patterns awaiting a decision, and skips dismissed ones", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "p1", content: "You keep deferring the pricing decision", createdAt: now - HOUR, tags: ["auto-insight"] });
    sq.seed({ id: "p2", content: "Dismissed already", createdAt: now - HOUR, tags: ["auto-insight", "status:deprecated"] });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.patterns.map((p: any) => p.id)).toEqual(["p1"]);
  });

  it("resurfaces an old important memory, never a recent or trivial one", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({
      id: "old-important", content: "The pricing floor is $6k", createdAt: now - 200 * DAY,
      importanceScore: 4, source: "claude-desktop", tags: ["pricing"],
    });
    sq.seed({ id: "old-trivial", content: "Renewed the domain", createdAt: now - 200 * DAY, importanceScore: 1 });
    sq.seed({ id: "new-important", content: "Shipped today", createdAt: now - HOUR, importanceScore: 5 });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.resurface?.id).toBe("old-important");
    // The dashboard's resurface panel shows where a memory came from and its
    // tags alongside the content, so both ride along on the same row.
    expect(data.resurface?.source).toBe("claude-desktop");
    expect(data.resurface?.tags).toEqual(["pricing"]);
  });

  it("returns a complete activity strip, including the days nothing happened", async () => {
    sq = await migrated();
    const now = Date.now();
    const todayBucket = Math.floor(now / 86400000);
    const todayStart = todayBucket * 86400000;
    sq.seed({ id: "today", content: "Today", createdAt: todayStart + HOUR });
    sq.seed({ id: "older", content: "Four days ago", createdAt: todayStart - 4 * DAY + HOUR });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    // Absent days would compress a quiet fortnight into a busy-looking one.
    expect(data.activity).toHaveLength(14);
    const todayEntry = data.activity.find((d: any) => d.day === todayBucket);
    expect(todayEntry?.count).toBe(1);
    expect(data.activity.filter((d: any) => d.count === 0).length).toBe(12);
  });

  it("reports this week's topics in the user's own vocabulary", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "t1", content: "A", createdAt: now - HOUR, tags: ["signpath", "kind:episodic", "5118"] });
    sq.seed({ id: "t2", content: "B", createdAt: now - 2 * HOUR, tags: ["signpath", "status:canonical"] });
    sq.seed({ id: "old", content: "C", createdAt: now - 30 * DAY, tags: ["ancient-topic"] });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.topics).toEqual([{ tag: "signpath", count: 2 }]);
  });

  it("counts what quietly degrades recall", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "u", content: "Never embedded", createdAt: now - HOUR, vectorIds: [] });
    // Tagged through the production writer, not a literal. This fixture used to
    // say "stale:as-of:2026-01-01" — a dated form nothing has ever written — and
    // passed only because the count matched a bare substring. The predicate is
    // exact now, so a fixture that invents a tag shape fails instead of quietly
    // agreeing with itself.
    sq.seed({ id: "s", content: "Possibly out of date", createdAt: now - HOUR, vectorIds: ["v"], tags: withStaleAsOf([]) });
    sq.seed({ id: "ok", content: "Fine", createdAt: now - HOUR, vectorIds: ["v"] });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.attention.unindexed).toBe(1);
    expect(data.attention.stale).toBe(1);
    expect(data.total).toBe(3);
  });

  it("counts open loops due within 48 hours, at zero extra queries", async () => {
    // Zero extra queries is proven by the sibling "costs a fixed handful of
    // D1 queries" tests above staying pinned at their same 10/7 after this
    // field was added — `due` is a CASE/SUM folded into the query those tests
    // already measure, not a query of its own. This test is only about the
    // count being right.
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "due-soon", content: "File the report", createdAt: now - HOUR, tags: ["task"] });
    sq.db.prepare(`UPDATE entries SET when_at = ? WHERE id = 'due-soon'`).bind(now + HOUR).run();
    sq.seed({ id: "due-later", content: "Renew next quarter", createdAt: now - HOUR, tags: ["task"] });
    sq.db.prepare(`UPDATE entries SET when_at = ? WHERE id = 'due-later'`).bind(now + 30 * DAY).run();
    sq.seed({ id: "no-when", content: "Just a task", createdAt: now - HOUR, tags: ["task"] });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;

    expect(data.attention.due).toBe(1);
  });

  // Finding 3: attention.due used to require OPEN_LOOP_SQL (a "task" tag),
  // but GET /due never did — an untagged remember(when: ...) moved the feed
  // but never this chip. Both now share DUE_SQL (src/when/input.ts).
  it("counts an UNTAGGED entry with when_at in the window (Finding 3)", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "untagged-due", content: "Renew the passport", createdAt: now - HOUR, tags: [] });
    sq.db.prepare(`UPDATE entries SET when_at = ? WHERE id = 'untagged-due'`).bind(now + HOUR).run();

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;

    expect(data.attention.due).toBe(1);
  });

  it("excludes a deprecated entry from attention.due (Finding 3)", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "deprecated-due", content: "Old commitment", createdAt: now - HOUR, tags: ["status:deprecated"] });
    sq.db.prepare(`UPDATE entries SET when_at = ? WHERE id = 'deprecated-due'`).bind(now + HOUR).run();

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;

    expect(data.attention.due).toBe(0);
  });

  it("keeps resurfacing something when there are fewer candidates than days", async () => {
    // OFFSET past the end returns no rows, so wrapping against a fixed
    // constant instead of the candidate count would show nothing on most days
    // for a small brain — silently, which is the worst kind.
    sq = await migrated();
    sq.seed({
      id: "only-one",
      content: "The one old important memory",
      createdAt: Date.now() - 200 * DAY,
      importanceScore: 4,
    });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.resurface?.id).toBe("only-one");
  });

  it("answers 200 with tags: [] when the resurfaced row's tags column is not valid JSON", async () => {
    sq = await migrated();
    sq.seed({
      id: "corrupt-tags", content: "Old and important, but hand-edited badly",
      createdAt: Date.now() - 200 * DAY, importanceScore: 4,
    });
    // Bypasses seed()'s JSON.stringify: a hand-edited row or a migration bug,
    // not something a normal write path can produce. The RESURFACE_FILTER's
    // tags NOT LIKE clauses are substring checks, so this row is still
    // resurface-eligible at the SQL layer even though its tags cannot parse.
    sq.db.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind("not valid json{{", "corrupt-tags").run();

    const res = await worker.fetch(req("GET", "/brief"), envOf(sq), ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.resurface?.id).toBe("corrupt-tags");
    expect(data.resurface?.tags).toEqual([]);
  });

  it("answers cleanly on a brain with nothing to say", async () => {
    sq = await migrated();
    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.ok).toBe(true);
    expect(data.captured).toBe(0);
    expect(data.sources).toEqual([]);
    expect(data.patterns).toEqual([]);
    expect(data.resurface).toBeNull();
    expect(data.loops).toEqual({ open: 0, items: [] });
  });

  it("reports open commitments, newest first, capped at three", async () => {
    sq = await migrated();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      sq.seed({ id: `t${i}`, content: `Task ${i}`, createdAt: now - i * HOUR, tags: ["task"] });
    }
    sq.seed({ id: "done", content: "Already finished", createdAt: now, tags: ["task", "task:done"] });
    sq.seed({ id: "build", content: "Ran a migration", createdAt: now, tags: ["task", "build-log"] });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.loops.open).toBe(5);
    expect(data.loops.items).toHaveLength(3);
    expect(data.loops.items.map((i: any) => i.id)).toEqual(["t0", "t1", "t2"]);
    expect(data.loops.items[0]).toMatchObject({ content: "Task 0", source: expect.any(String) });
  });

  it("GET /brief returns changes", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "e1", content: "A memory", createdAt: now - 10 * HOUR });
    sq.db.prepare(
      `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("ev1", "e1", "", "held", JSON.stringify({ channel: "rest", reasons: ["instruction"] }), now - HOUR).run();

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.changes).toMatchObject({ window_hours: 48, count: 1, held: 1, truncated: false });
    expect(data.changes.items).toHaveLength(1);
    expect(data.changes.items[0]).toMatchObject({ kind: "item", event: "held", id: "e1" });
  });

  // R21 review (open question): REST auth is a single bearer token per user, the same one hooks
  // and any other AI tool integration hold — no header or cookie here distinguishes "a human on
  // the dashboard" from any other caller with that token. A held item's preview must not leak to
  // a plain token caller by default; only ?reveal_held=1 (a future dashboard action, S4) gets it.
  it("GET /brief withholds a held preview from a bare token caller; reveal_held=1 opts in", async () => {
    sq = await migrated();
    const now = Date.now();
    // The row's own tags carry the hold (T-0102: masking keys off the row's current held status,
    // not off this event's own family), matching what a real "held" event leaves behind.
    sq.seed({ id: "e1", content: "The launch codes are 1234", createdAt: now - 10 * HOUR, tags: ["quarantine:instruction", "status:draft"] });
    sq.db.prepare(
      `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("ev1", "e1", "", "held", JSON.stringify({ channel: "rest", reasons: ["instruction"] }), now - HOUR).run();

    const byDefault = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(byDefault.changes.items[0]).toMatchObject({ kind: "item", event: "held", id: "e1", preview: null });
    expect(JSON.stringify(byDefault)).not.toContain("launch codes");

    const revealed = await (await worker.fetch(req("GET", "/brief?reveal_held=1"), envOf(sq), ctx)).json() as any;
    expect(revealed.changes.items[0]).toMatchObject({ kind: "item", event: "held", id: "e1", preview: "The launch codes are 1234" });
  });
});

/** S2 (T-0089.4.3): the MCP and lean briefs, measured the same way GET /brief is above —
 * against real SQLite, counting every D1 call. The legacy '' workspace matches sq.seed()'s
 * default, and an admin identity reads it the same way a pre-tenancy owner does. */
describe("MCP and lean briefs (S2)", () => {
  const identity: Identity = { userId: "u1", role: "admin", personalWorkspaceId: "", companyWorkspaceIds: [], defaultShare: "" };

  it("MCP brief prints the block without held previews", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "e1", content: "The secret plan", createdAt: now - 10 * HOUR });
    sq.db.prepare(
      `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("ev1", "e1", "", "held", JSON.stringify({ channel: "rest", reasons: ["instruction"] }), now - HOUR).run();

    const env = envOf(sq);
    sq.issued.length = 0;
    const text = await computeAgentBrief(env, ctx, identity);
    expect(text).toContain("What AI tools changed");
    expect(text).toContain("Held: instruction");
    expect(text).not.toContain("The secret plan");
    // Pinned the same way GET /brief's cold/warm counts are above: the way this regresses is by
    // someone adding "just one more" query to a Promise.all.
    expect(sq.issued.length).toBe(8);
  });

  it("empty changes adds no text to the MCP brief", async () => {
    sq = await migrated();
    sq.seed({ id: "t1", content: "A task", createdAt: Date.now(), tags: ["task"] });
    const text = await computeAgentBrief(envOf(sq), ctx, identity);
    expect(text).not.toContain("What AI tools changed");
  });

  it("lean brief returns counts and groups only, never items", async () => {
    sq = await migrated();
    const now = Date.now();
    // QUARANTINE_STATUS_BURST defaults to 10 (src/config.ts): the "status" family only
    // collapses into a group once a run reaches that length, so this seeds 10, not some
    // smaller round number, to actually cross the real default threshold.
    for (let i = 0; i < 10; i++) {
      sq.seed({ id: `e${i}`, content: `Memory ${i}`, createdAt: now - i * HOUR });
      sq.db.prepare(
        `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(`ev${i}`, `e${i}`, "u1", "status_changed", JSON.stringify({ channel: "mcp", status: "canonical" }), now - i * MIN).run();
    }

    const env = envOf(sq);
    sq.issued.length = 0;
    const data = await computeLeanBrief(env, ctx, identity);
    expect(data.changes).toEqual({ count: 10, held: 0, groups: [{ family: "status", count: 10, client: null, at: expect.any(Number) }] });
    expect((data.changes as any).items).toBeUndefined();
    expect(sq.issued.length).toBe(5);
  });
});
