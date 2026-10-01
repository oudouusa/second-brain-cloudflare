import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, type Identity } from "../../src/lib/identity";
import { loadHistory } from "../../src/memory/versions";
import type { Env } from "../../src/env";

let d1: SqliteD1;
let env: Env;
let alice: Identity;   // owner and admin
let bob: Identity;
let carol: Identity;   // a second admin
let company: string;

beforeEach(async () => {
  resetDatabaseInit();
  d1 = makeSqliteD1();
  env = d1.admitEnv(makeTestEnv(undefined, { DB: d1.db as unknown as D1Database, OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  company = roots.companyWorkspaceId;
  alice = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
  bob = (await resolveIdentityByUserId(env, (await createMember(env, { name: "Bob" })).member.userId))!;
  carol = (await resolveIdentityByUserId(env, (await createMember(env, { name: "Carol", role: "admin" })).member.userId))!;
});
afterEach(() => d1.close());

/** Each version records the text it retired, stamped with the workspace the memory lived in then. */
async function seedChain(id: string, states: { text: string; ws: string }[], live: string, liveWs: string) {
  await d1.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, '[]', 'api', 1, 1, '[]', ?, ?)`,
  ).bind(id, live, liveWs, alice.userId).run();
  for (const [i, s] of states.entries()) {
    await d1.db.prepare(
      `INSERT INTO entry_versions (entry_id, workspace_id, seq, content, tags, reason, actor_id, created_at) VALUES (?, ?, ?, ?, '[]', 'update', ?, ?)`,
    ).bind(id, s.ws, i + 1, s.text, alice.userId, 10 + i).run();
  }
}
const seen = async (who: Identity | undefined, id: string) => {
  const live = ((await d1.db.prepare(`SELECT content FROM entries WHERE id = ?`).bind(id).first()) as any).content;
  const chain = await loadHistory(env, who, { id, content: live }, 500);
  return chain.rows.map(r => `${r.seq}:${chain.text(r.seq)}`);
};

describe("history visibility (D-SH)", () => {
  // Personal era (seq 1, 2) then shared to the company (seq 3, 4 stamped company).
  const personalThenCompany = () => seedChain("e1", [
    { text: "draft one", ws: alice.personalWorkspaceId },
    { text: "draft two", ws: alice.personalWorkspaceId },
    { text: "shared text", ws: company },
    { text: "shared edit", ws: company },
  ], "shared final", company);

  it("the author sees personal-era and company-era versions", async () => {
    await personalThenCompany();
    expect(await seen(alice, "e1")).toEqual(["4:shared edit", "3:shared text", "2:draft two", "1:draft one"]);
  });

  it("a teammate sees versions only from the share point; the oldest visible text equals the text at share time", async () => {
    await personalThenCompany();
    const bobSees = await seen(bob, "e1");
    expect(bobSees).toEqual(["4:shared edit", "3:shared text"]);
    expect(bobSees[bobSees.length - 1]).toBe("3:shared text");
  });

  it("company, unshare, edit, reshare: the teammate never sees an older readable version below an unreadable one", async () => {
    await seedChain("e2", [
      { text: "company v1", ws: company },
      { text: "personal edit", ws: alice.personalWorkspaceId },   // after an unshare
      { text: "reshared", ws: company },
    ], "live", company);
    expect(await seen(bob, "e2")).toEqual(["3:reshared"]);
    expect(await seen(alice, "e2")).toHaveLength(3);
  });

  it("an admin non-author is bound by the rule", async () => {
    await personalThenCompany();
    expect(await seen(carol, "e1")).toEqual(["4:shared edit", "3:shared text"]);
  });

  it("a pre-bootstrap version stamped \"\" on a shared memory is hidden from a second admin and shown to the owner", async () => {
    await seedChain("e3", [
      { text: "legacy", ws: "" },
      { text: "after", ws: company },
    ], "live", company);
    expect(await seen(alice, "e3")).toEqual(["2:after", "1:legacy"]);
    expect(await seen(carol, "e3")).toEqual(["2:after"]);
    expect(await seen(bob, "e3")).toEqual(["2:after"]);
  });

  it("the identity-less owner reads all", async () => {
    await personalThenCompany();
    expect(await seen(undefined, "e1")).toHaveLength(4);
  });

  it("issues one statement, plus the bootstrap only when it meets a \"\" row", async () => {
    await personalThenCompany();
    d1.issued.length = 0;
    await seen(bob, "e1");
    expect(d1.issued.filter(s => /entry_versions/.test(s))).toHaveLength(1);
  });
});
