import { afterEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { createMember } from "../../src/lib/team-admin";
import { forgetEntry } from "../../src/capture/lifecycle";
import { resolveConfig } from "../../src/config";

let t: TrashEnv;
afterEach(() => t?.close());

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;
const getVersion = (token: string, id: string) => worker.fetch(
  new Request("http://localhost/entry/version", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id, seq: 1 }),
  }), t.env, ctx,
);
const restore = (token: string, id: string) => worker.fetch(
  new Request("http://localhost/restore", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  }), t.env, ctx,
);

describe("final review: teammate read and trash permissions", () => {
  it("a teammate can read a company version but cannot restore its author's company trash", async () => {
    t = await makeTrashEnv();
    const { token } = await createMember(t.env, { name: "Reader" });
    const company = t.roots.companyWorkspaceId;
    t.seed("shared", { workspace_id: company });
    t.version("shared", 1, { workspace_id: company });

    const version = await getVersion(token, "shared");
    expect(version.status).toBe(200);
    expect(await version.json()).toMatchObject({ ok: true, id: "shared", content: "v1" });

    const cfg = await resolveConfig(t.env);
    expect((await forgetEntry("shared", t.env, {
      actorId: t.roots.ownerUserId, channel: "rest",
    }, { reason: "forget", config: cfg, purge: false }, company)).status).toBe("deleted");
    const denied = await restore(token, "shared");
    expect(denied.status).toBe(403);
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'shared'`)).not.toBeNull();
  });

  it("a removed member's bearer token cannot read versions or restore company trash", async () => {
    t = await makeTrashEnv();
    const { token, member } = await createMember(t.env, { name: "Former member" });
    const company = t.roots.companyWorkspaceId;
    t.seed("shared", { workspace_id: company });
    t.version("shared", 1, { workspace_id: company });
    t.seed("trashed", { workspace_id: company });
    const cfg = await resolveConfig(t.env);
    expect((await forgetEntry("trashed", t.env, {
      actorId: t.roots.ownerUserId, channel: "rest",
    }, { reason: "forget", config: cfg, purge: false }, company)).status).toBe("deleted");

    expect((await getVersion(token, "shared")).status).toBe(200);
    await t.env.DB.prepare(`UPDATE users SET removed_at = ? WHERE id = ?`).bind(Date.now(), member.userId).run();
    const version = await getVersion(token, "shared");
    const trash = await restore(token, "trashed");
    expect(version.status).toBe(401);
    expect(trash.status).toBe(401);
    expect(await version.json()).toMatchObject({ ok: false, code: "removed" });
    expect(await trash.json()).toMatchObject({ ok: false, code: "removed" });
  });
});
