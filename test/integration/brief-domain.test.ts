import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { computeBrief, computeLeanBrief, formatAgentBrief, readAgentBrief } from "../../src/brief/compute";
import { resolveEntryAction } from "../../src/memory/actions";
import { readEntryTimeline } from "../../src/memory/history";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

let sqlite: SqliteD1;
let env: Env;
let auth: Identity;
const ctx = { waitUntil: (_: Promise<unknown>) => {} };

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  env = sqlite.admitEnv(env);
  await ensureTenantBootstrap(env);
  auth = (await resolveIdentityFromToken("test-token", env))!;
});
afterEach(() => sqlite.close());

describe("shared brief domain", () => {
  it("dashboard brief counts what the agent brief lists, from one set of predicates", async () => {
    const soon = Date.now() + 3600000;
    sqlite.seed({ id: "t1", content: "Pay rent", createdAt: 2000, tags: ["task"] });
    await env.DB.prepare(`UPDATE entries SET when_at = ?, when_kind = 'due', when_source = 'explicit' WHERE id = 't1'`).bind(soon).run();
    sqlite.seed({ id: "t2", content: "Book flights", createdAt: 1000, tags: ["task"] });

    const dash = await computeBrief(env, auth, true);
    const agent = await readAgentBrief(env, auth, { parts: ["due", "loops"] });
    expect(dash.attention.due).toBe(agent.due!.total);
    expect(dash.loops.open).toBe(agent.loops!.total);
    expect(agent.loops!.items.map(i => i.id)).toEqual(["t1", "t2"]);
  });

  it("lean brief keeps the dashboard's due/loops shape and caps items at three", async () => {
    for (let i = 0; i < 5; i++) sqlite.seed({ id: `t${i}`, content: `Task ${i}`, createdAt: 1000 + i, tags: ["task"] });
    const lean = await computeLeanBrief(env, ctx, auth);
    expect(lean).toMatchObject({ ok: true, lean: true, attention: { due: 0 }, loops: { open: 5 } });
    expect(lean.loops.items.map(i => i.id)).toEqual(["t4", "t3", "t2"]);
  });

  it("formats an empty brief as the quiet state and omits empty sections", () => {
    expect(formatAgentBrief({})).toBe("Nothing needs attention.");
    const text = formatAgentBrief({ loops: { total: 1, items: [{ id: "x", content: "Do it" }] } });
    expect(text).toContain("You owe");
    expect(text).not.toContain("Due");
  });
});

describe("shared resolution path", () => {
  it("marks done, refuses a missing id with 404 and a missing until with 400", async () => {
    sqlite.seed({ id: "t", content: "Task", createdAt: 1, tags: ["task"] });
    expect(await resolveEntryAction(env, ctx, auth, "t", "done", undefined, { actorId: auth.userId, channel: "rest" })).toMatchObject({ ok: true, id: "t" });
    expect(JSON.parse(String(sqlite.rows()[0].tags))).toContain("task:done");
    expect(await resolveEntryAction(env, ctx, auth, "nope", "done", undefined, { actorId: auth.userId, channel: "rest" })).toMatchObject({ ok: false, status: 404 });
    expect(await resolveEntryAction(env, ctx, auth, "t", "snooze", undefined, { actorId: auth.userId, channel: "rest" })).toMatchObject({ ok: false, status: 400 });
  });
});

describe("shared entry timeline", () => {
  it("returns events oldest first and honours the limit by keeping the newest", async () => {
    sqlite.seed({ id: "e", content: "Entry", createdAt: 1 });
    for (let i = 1; i <= 4; i++) {
      await env.DB.prepare(`INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, 'e', ?, 'updated', '{}', ?)`).bind(`ev${i}`, auth.userId, i).run();
    }
    const all = await readEntryTimeline(env, "e", auth);
    expect(all.timeline.map(t => t.created_at)).toEqual([1, 2, 3, 4]);
    const recent = await readEntryTimeline(env, "e", auth, "", 2, true);
    expect(recent.timeline.map(t => t.created_at)).toEqual([3, 4]);
  });
});
