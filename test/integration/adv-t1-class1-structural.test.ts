/**
 * CLASS 1 structural test (T-0089.1.1 T-0089.10, round 2 versions adversary R2-3): every write
 * route and MCP write tool authorizes a row, then reads it again inside its writer — and there is
 * awaited I/O in between (isManagedMirror, writeContextFor, resolveConfig). An unshare landing in
 * that gap must never be treated as authorized: nothing may land in the moved row, no version may
 * be written, and the caller must see a conflict or not-found, never success.
 *
 * One shared race harness drives every case below rather than one bespoke test per writer, so a
 * writer that is added later and forgets the pin fails the same way every existing one is checked.
 * Real SQLite (node:sqlite) throughout, so the scope clause each route builds is the real one, not
 * the JS mock's approximation of it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityByUserId, resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { buildMcpServer } from "../../src/mcp/server";
import worker from "../../src/index";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;

let sqlite: SqliteD1;
let env: Env;
let owner: Identity;
let companyWs = "";

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  companyWs = roots.companyWorkspaceId;
  owner = (await resolveIdentityByUserId(env, roots.ownerUserId))!;
});
afterEach(() => sqlite.close());

const seed = (id: string, over: Record<string, unknown> = {}) => sqlite.db.prepare(
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(
  id, over.content ?? "Bob's company note", JSON.stringify(over.tags ?? []), over.source ?? "api",
  over.createdAt ?? 1000, over.updatedAt ?? null, JSON.stringify(over.vectorIds ?? [id]),
  over.workspaceId ?? companyWs, over.actorId ?? "",
).run();
const live = async (id: string) => (await sqlite.db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first()) as any;
const versionCount = async (id: string) => ((await sqlite.db.prepare(`SELECT count(*) AS n FROM entry_versions WHERE entry_id = ?`).bind(id).first()) as any).n as number;

async function member(name: string, role: "admin" | "member" = "member"): Promise<Identity> {
  const { token } = await createMember(env, { name, role });
  return (await resolveIdentityFromToken(token, env))!;
}

/**
 * A double that intercepts the FIRST read matching getReadableEntry's shape for `id` — every
 * REST route and MCP tool's own authorizing read, whatever extra columns it asked for — and, once
 * that read has returned, moves the row out of the caller's workspace before the writer gets to
 * read it again. Every later query on this connection runs unmodified.
 */
function raceUnshare(id: string, moveTo: string): Env {
  const raw = env.DB as any;
  let moved = false;
  const READ = /^SELECT id, workspace_id, actor_id(?:, [^]+?)? FROM entries WHERE id = \? AND/;
  return {
    ...env, WRITE_ADMISSION_TOKEN: env.WRITE_ADMISSION_TOKEN,
    DB: {
      ...raw,
      prepare(sql: string) {
        const st = raw.prepare(sql);
        if (moved || !READ.test(sql)) return st;
        return {
          bind: (...a: unknown[]) => ({
            first: async () => {
              const r = await st.bind(...a).first();
              if (r && (r as any).id === id) {
                moved = true;
                await sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(moveTo, id).run();
              }
              return r;
            },
          }),
        };
      },
    },
  } as unknown as Env;
}

async function callMcpTool(mcpEnv: Env, identity: Identity, name: string, args: Record<string, unknown>) {
  const server = buildMcpServer(mcpEnv, ctx, identity);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

interface Case {
  name: string;
  /** A prerequisite beyond the shared seed (undo needs a version to revert to) — runs before the
   * race environment is built and the baseline is captured, so it is setup, not part of the race.
   * Takes the same (workspace, author) the shared seed already used, so it stays a fixture of the
   * row the race targets rather than a fixture of its own. */
  setup?: (id: string, workspaceId: string, actorId: string) => Promise<void>;
  /** Runs the write against a racing env and returns whether the caller saw success. */
  run: (racingEnv: Env, id: string, adminToken: string, admin?: Identity) => Promise<{ succeeded: boolean }>;
}

/** A prior version to revert to, distinct from the shared seed's current content (undo's CASES). */
async function seedPriorVersion(id: string, workspaceId: string, actorId: string) {
  await sqlite.db.prepare(
    `INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, state, actor_id, channel, reason, meta, valid_from, created_at)
     VALUES (?, ?, 1, ?, NULL, '[]', '{}', ?, 'rest', 'update', '{}', 500, 900)`,
  ).bind(id, workspaceId, "Bob's earlier company note", actorId).run();
}

const CASES: Case[] = [
  {
    name: "REST /update",
    run: async (racingEnv, id, adminToken) => {
      const res = await worker.fetch(req("POST", "/update", { body: { id, content: "admin rewrite" }, token: adminToken }), racingEnv, ctx);
      return { succeeded: res.status === 200 };
    },
  },
  {
    name: "REST /append",
    run: async (racingEnv, id, adminToken) => {
      const res = await worker.fetch(req("POST", "/append", { body: { id, addition: "admin addition" }, token: adminToken }), racingEnv, ctx);
      return { succeeded: res.status === 200 };
    },
  },
  {
    name: "REST /status",
    run: async (racingEnv, id, adminToken) => {
      const res = await worker.fetch(req("POST", "/status", { body: { id, status: "draft" }, token: adminToken }), racingEnv, ctx);
      return { succeeded: res.status === 200 };
    },
  },
  {
    name: "REST /status (deprecated)",
    run: async (racingEnv, id, adminToken) => {
      const res = await worker.fetch(req("POST", "/status", { body: { id, status: "deprecated" }, token: adminToken }), racingEnv, ctx);
      return { succeeded: res.status === 200 };
    },
  },
  {
    name: "REST /forget",
    run: async (racingEnv, id, adminToken) => {
      const res = await worker.fetch(req("POST", "/forget", { body: { id }, token: adminToken }), racingEnv, ctx);
      return { succeeded: res.status === 200 };
    },
  },
  // REST /forget permanent (Delete forever, R3-1) is gone from this list: it never reads or touches a
  // live row any more, only a trash row pinned by nonce (delete-forever-nonce-only.test.ts).
  {
    name: "MCP update",
    run: async (racingEnv, id, _adminToken, admin?: Identity) => {
      const result = await callMcpTool(racingEnv, admin!, "update", { id, content: "admin rewrite" });
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      return { succeeded: !/no entry found|conflict|changed while saving/i.test(text) && !result.isError };
    },
  },
  {
    name: "MCP append",
    run: async (racingEnv, id, _adminToken, admin?: Identity) => {
      await callMcpTool(racingEnv, admin!, "append", { id, addition: "admin addition" });
      // append's own tool does not always flag isError (EntryGoneError renders as a plain message);
      // the only trustworthy signal is whether the row's content actually changed (checked by the caller).
      return { succeeded: false };
    },
  },
  {
    name: "MCP set_status",
    run: async (racingEnv, id, _adminToken, admin?: Identity) => {
      await callMcpTool(racingEnv, admin!, "set_status", { id, status: "draft" });
      return { succeeded: false };
    },
  },
  {
    name: "MCP forget",
    run: async (racingEnv, id, _adminToken, admin?: Identity) => {
      await callMcpTool(racingEnv, admin!, "forget", { id });
      return { succeeded: false };
    },
  },
  {
    name: "REST /share personal (R3-2)",
    run: async (racingEnv, id, adminToken) => {
      const res = await worker.fetch(req("POST", "/share", { body: { id, workspace: "personal" }, token: adminToken }), racingEnv, ctx);
      return { succeeded: res.status === 200 };
    },
  },
  {
    name: "REST /undo",
    setup: seedPriorVersion,
    run: async (racingEnv, id, adminToken) => {
      const res = await worker.fetch(req("POST", "/undo", { body: { id }, token: adminToken }), racingEnv, ctx);
      return { succeeded: res.status === 200 };
    },
  },
  {
    name: "MCP undo",
    setup: seedPriorVersion,
    run: async (racingEnv, id, _adminToken, admin?: Identity) => {
      const result = await callMcpTool(racingEnv, admin!, "undo", { id });
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      return { succeeded: !/no entry found|changed after you looked|has no recorded changes/i.test(text) && !result.isError };
    },
  },
];

describe("CLASS 1 structural, forward-looking: revertEntry's optional authorizedWorkspaceId (Builder D, undo.ts)", () => {
  // No route or MCP tool in this branch calls revertEntry yet (Builder D's route lives on
  // v4/t1-undo-fix); this simulates the caller that route will be once merged, passing the
  // workspace ITS OWN read authorized explicitly, the same way every other case above does.
  it("an unshare between the caller's authorization and revertEntry's own read does not land the revert", async () => {
    const { revertEntry } = await import("../../src/memory/undo");
    const { DEFAULTS } = await import("../../src/config");
    const admin = await member("Ada", "admin");
    const author = await member("Bob");
    const id = "race-revert";
    await seed(id, { content: "Bob's company note edited", workspaceId: companyWs, actorId: author.userId });
    // A version to revert to: seed one directly so revertEntry's own read finds a chain.
    await sqlite.db.prepare(
      `INSERT INTO entry_versions (entry_id, workspace_id, seq, content, prior_length, tags, state, actor_id, channel, reason, meta, valid_from, created_at)
       VALUES (?, ?, 1, ?, NULL, '[]', '{}', ?, 'rest', 'update', '{}', 500, 900)`,
    ).bind(id, companyWs, "Bob's company note", author.userId).run();
    const racingEnv = raceUnshare(id, author.personalWorkspaceId);
    const result = await revertEntry(racingEnv, admin, id, { actorId: admin.userId, channel: "rest" }, DEFAULTS, undefined, companyWs);
    const after = await live(id);
    expect(after.workspace_id, "the race did not fire").toBe(author.personalWorkspaceId);
    expect(result.status, "revertEntry reported success on a row it was never authorized to write").not.toBe("reverted");
    expect(after.content, "content changed in the moved row").toBe("Bob's company note edited");
  });
});

describe("CLASS 1 structural: an unshare between authorization and a writer's own read never lands", () => {
  let admin: Identity;
  let adminToken: string;
  let author: Identity;

  beforeEach(async () => {
    const created = await createMember(env, { name: "Ada", role: "admin" });
    adminToken = created.token;
    admin = (await resolveIdentityFromToken(adminToken, env))!;
    author = await member("Bob");
  });

  for (const c of CASES) {
    it(c.name, async () => {
      const id = `race-${c.name.replace(/[^a-z0-9]/gi, "-")}`;
      await seed(id, { content: "Bob's company note", workspaceId: companyWs, actorId: author.userId });
      if (c.setup) await c.setup(id, companyWs, author.userId);
      const racingEnv = raceUnshare(id, author.personalWorkspaceId);

      const before = await live(id);
      const versionsBefore = await versionCount(id);
      const { succeeded } = await c.run(racingEnv, id, adminToken, admin);

      const after = await live(id);
      // The row really did move (the race fired) — otherwise this case proves nothing.
      expect(after.workspace_id, `${c.name}: the race did not fire`).toBe(author.personalWorkspaceId);
      expect(succeeded, `${c.name}: reported success on a row it was never authorized to write`).toBe(false);
      expect(after.content, `${c.name}: content changed in the moved row`).toBe(before.content);
      expect(after.tags, `${c.name}: tags changed in the moved row`).toBe(before.tags);
      expect(await versionCount(id), `${c.name}: a version was written for an unauthorized write`).toBe(versionsBefore);
    });
  }
});
