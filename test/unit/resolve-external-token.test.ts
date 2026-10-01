/**
 * BE-5 (T-0101.5.1): a static-bearer caller (the AUTH_TOKEN or a member token,
 * via mcp-remote/Claude Desktop) never held an OAuth grant, so its props mark
 * `via: "token"` — resolveClientLabel (src/mcp/client-label.ts) uses that to
 * skip the legacy grant lookup outright rather than spend two KV reads on a
 * unwrapToken call that can never succeed for this kind of token.
 */
import { describe, it, expect, afterEach } from "vitest";
import { resolveExternalToken } from "../../src/index";
import { makeTestEnv, makeTestDb, makeMemoryKV } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import type { Env } from "../../src/env";

const request = new Request("http://localhost/mcp");

let sqlite: SqliteD1 | undefined;
afterEach(() => { sqlite?.close(); sqlite = undefined; });

describe("resolveExternalToken", () => {
  it("resolves the static AUTH_TOKEN with via: token", async () => {
    const env: Env = makeTestEnv(makeTestDb());
    const result = await resolveExternalToken({ token: env.AUTH_TOKEN, request, env });
    expect(result).toEqual({ props: { userId: "owner", via: "token" } });
  });

  it("resolves a member's own token with via: token", async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    const env: Env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
    await initializeDatabase(env);
    await ensureTenantBootstrap(env);
    const bob = await createMember(env, { name: "Bob" });
    const result = await resolveExternalToken({ token: bob.token, request, env });
    expect(result).toEqual({ props: { userId: bob.member.userId, via: "token" } });
  });

  it("returns null for an unrecognized token", async () => {
    const env: Env = makeTestEnv(makeTestDb());
    const result = await resolveExternalToken({ token: "not-a-real-token", request, env });
    expect(result).toBeNull();
  });
});
