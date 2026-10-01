import { describe, expect, it, vi } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";
import { hashToken, resolveIdentity } from "../../src/lib/identity";
import worker from "../../src/index";
import { makeTestEnv } from "../helpers/make-env";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";

/** The sqlite facade exercises the real schema + real SQL; identity only needs DB + AUTH_TOKEN. */
function makeEnv(db = makeSqliteD1().db): Env {
  return { DB: db as unknown as Env["DB"], AUTH_TOKEN: "owner-secret-token" } as Env;
}

async function counts(env: Env) {
  const one = async (sql: string) =>
    ((await env.DB.prepare(sql).first<{ n: number }>()) as { n: number }).n;
  return {
    companies: await one(`SELECT COUNT(*) AS n FROM workspaces WHERE kind = 'company'`),
    personals: await one(`SELECT COUNT(*) AS n FROM workspaces WHERE kind = 'personal'`),
    admins: await one(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`),
    memberships: await one(`SELECT COUNT(*) AS n FROM memberships`),
  };
}

describe("tenant bootstrap", () => {
  it("seeds one company workspace, one admin owner, one personal workspace, both memberships", async () => {
    const env = makeEnv();
    const roots = await ensureTenantBootstrap(env);
    expect(roots.companyWorkspaceId).toBeTruthy();
    expect(roots.ownerUserId).toBeTruthy();
    expect(roots.ownerPersonalWorkspaceId).toBeTruthy();
    const c = await counts(env);
    // Invariants 1-3 of the spec: exactly one company workspace, exactly one
    // personal workspace for exactly one user, who is a member of both.
    expect(c.companies).toBe(1);
    expect(c.personals).toBe(1);
    expect(c.admins).toBe(1);
    expect(c.memberships).toBe(2);
  });

  it("is idempotent: a second call returns the same roots and writes nothing new", async () => {
    const env = makeEnv();
    const first = await ensureTenantBootstrap(env);
    const second = await ensureTenantBootstrap(env);
    expect(second).toEqual(first);
    const c = await counts(env);
    expect(c.companies).toBe(1);
    expect(c.memberships).toBe(2);
  });

  it("detects pre-existing tenancy instead of seeding a second set", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      `INSERT INTO workspaces (id, kind, name, created_at) VALUES ('ws-x', 'company', 'X', 1)`,
    ).run();
    await ensureTenantBootstrap(env);
    const c = await counts(env);
    expect(c.companies).toBe(1);
  });

  it.each([0, 2, 3])("解放失敗%d回でも初期化済みの認証と3回上限を維持する", async (failures) => {
    const d1 = makeSqliteD1();
    const env = makeEnv(d1.db);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      d1.seed({ id: "legacy", content: "legacy memory", createdAt: 1000 });
      await env.DB.prepare("DELETE FROM memory_write_admissions").run();
      const prepare = env.DB.prepare.bind(env.DB);
      let attempts = 0;
      vi.spyOn(env.DB, "prepare").mockImplementation(sql => {
        const statement = prepare(sql);
        if (!sql.startsWith("DELETE FROM memory_write_admissions WHERE token =")) return statement;
        const bind = statement.bind.bind(statement);
        statement.bind = (...values) => {
          const bound = bind(...values);
          const run = bound.run.bind(bound);
          bound.run = async () => {
            if (++attempts <= failures) throw new Error("provider-private-detail");
            return run();
          };
          return bound;
        };
        return statement;
      });
      const roots = await ensureTenantBootstrap(env);
      expect(attempts).toBe(Math.min(failures + 1, 3));
      const row = await env.DB.prepare("SELECT workspace_id FROM entries WHERE id = 'legacy'")
        .first<{ workspace_id: string }>();
      expect(row?.workspace_id).toBe(roots.ownerPersonalWorkspaceId);
      const remaining = await env.DB.prepare("SELECT COUNT(*) AS n FROM memory_write_admissions")
        .first<{ n: number }>();
      expect(remaining?.n).toBe(failures === 3 ? 1 : 0);
      if (failures === 3) {
        expect(errorLog).toHaveBeenCalledExactlyOnceWith("Tenant bootstrap admission release failed");
      } else {
        expect(errorLog).not.toHaveBeenCalled();
      }
      expect(await ensureTenantBootstrap(env)).toEqual(roots);
    } finally {
      vi.restoreAllMocks();
      d1.close();
    }
  });

  it("backfills legacy entries and edges into the owner's personal workspace", async () => {
    const d1 = makeSqliteD1();
    d1.seed({ id: "e1", content: "legacy memory", createdAt: 1000 });
    const env = { DB: d1.db as unknown as Env["DB"], AUTH_TOKEN: "t" } as Env;
    await env.DB.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, write_marker)
       VALUES ('edge-1', 'e1', 'e1', 'relates_to', 0.5, 'explicit', '{}', 1000, 1000, ?)`,
    ).bind(d1.fixtureMarker()).run();
    // Match an upgraded production brain: legacy rows were written under an old,
    // expired capability and no admission is live when Team bootstrap begins.
    await env.DB.prepare(`DELETE FROM memory_write_admissions`).run();

    const roots = await ensureTenantBootstrap(env);
    const row = await env.DB.prepare(`SELECT workspace_id FROM entries WHERE id = 'e1'`).first<{
      workspace_id: string;
    }>();
    // Invariant 5: a v2 brain's memories stay private to its owner after upgrade.
    expect(row?.workspace_id).toBe(roots.ownerPersonalWorkspaceId);
    const orphans = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE workspace_id = ''`,
    ).first<{ n: number }>();
    expect(orphans?.n).toBe(0);
    const edge = await env.DB.prepare(
      `SELECT workspace_id FROM edges WHERE id = 'edge-1'`,
    ).first<{ workspace_id: string }>();
    expect(edge?.workspace_id).toBe(roots.ownerPersonalWorkspaceId);
    const admissions = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM memory_write_admissions`,
    ).first<{ n: number }>();
    expect(admissions?.n).toBe(0);
  });
});

describe("identity resolution", () => {
  it("resolves the owner through the static AUTH_TOKEN", async () => {
    const env = makeEnv();
    const roots = await ensureTenantBootstrap(env);
    const request = new Request("https://brain.example/recall", {
      headers: { Authorization: "Bearer owner-secret-token" },
    });
    const identity = await resolveIdentity(request, env);
    expect(identity).not.toBeNull();
    expect(identity!.role).toBe("admin");
    expect(identity!.userId).toBe(roots.ownerUserId);
    expect(identity!.personalWorkspaceId).toBe(roots.ownerPersonalWorkspaceId);
    expect(identity!.companyWorkspaceIds[0]).toBe(roots.companyWorkspaceId);
  });

  it("rejects the ?token= query form", async () => {
    // Removed in v3. A query-string credential ends up in browser history, proxy
    // and CDN access logs, and the Referer header of every outbound link — none
    // of which a bearer token survives being written to. The Authorization
    // header is the only way in now, and this token is the owner's real one, so
    // the rejection is about where it was presented, not what it is.
    const env = makeEnv();
    await ensureTenantBootstrap(env);
    const request = new Request("https://brain.example/count?token=owner-secret-token");
    expect(await resolveIdentity(request, env)).toBeNull();

    const res = await worker.fetch(
      new Request("https://brain.example/count?token=owner-secret-token"),
      { ...env, VECTORIZE: makeTestEnv().VECTORIZE, AI: makeTestEnv().AI, OAUTH_KV: makeTestEnv().OAUTH_KV } as Env,
      { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_token");
  });

  it("rejects unknown tokens and missing tokens", async () => {
    const env = makeEnv();
    await ensureTenantBootstrap(env);
    const wrong = new Request("https://x/", { headers: { Authorization: "Bearer nope" } });
    expect(await resolveIdentity(wrong, env)).toBeNull();
    const anonymous = new Request("https://x/");
    expect(await resolveIdentity(anonymous, env)).toBeNull();
  });

  it("resolves a member only through their workspace memberships", async () => {
    const env = makeEnv();
    const roots = await ensureTenantBootstrap(env);
    await env.DB.prepare(
      `INSERT INTO users (id, name, role, token_hash, suspended, created_at) VALUES ('u2', 'B', 'member', ?, 0, 1)`,
    )
      .bind(await hashToken("b-token"))
      .run();
    const request = () => new Request("https://x/", { headers: { Authorization: "Bearer b-token" } });
    // No memberships yet: the JOIN finds neither a personal nor the company
    // workspace, so the user cannot authenticate at all (invariant 3 enforced
    // structurally, not by convention).
    expect(await resolveIdentity(request(), env)).toBeNull();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workspaces (id, kind, name, created_at) VALUES ('ws-b', 'personal', 'B', 1)`,
      ),
      env.DB.prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES ('u2', 'ws-b', 1)`),
      env.DB.prepare(
        `INSERT INTO memberships (user_id, workspace_id, created_at) VALUES ('u2', ?, 1)`,
      ).bind(roots.companyWorkspaceId),
    ]);
    const identity = await resolveIdentity(request(), env);
    expect(identity).not.toBeNull();
    expect(identity!.role).toBe("member");
    expect(identity!.personalWorkspaceId).toBe("ws-b");
    expect(identity!.companyWorkspaceIds[0]).toBe(roots.companyWorkspaceId);
  });

  it("does not resolve suspended users", async () => {
    const env = makeEnv();
    await ensureTenantBootstrap(env);
    await env.DB.prepare(`UPDATE users SET suspended = 1`).run();
    const request = new Request("https://x/", { headers: { Authorization: "Bearer owner-secret-token" } });
    expect(await resolveIdentity(request, env)).toBeNull();
  });
});
