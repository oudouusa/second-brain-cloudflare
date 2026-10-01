import { afterEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { makeTrashEnv, trashNonce, type TrashEnv } from "../helpers/trash-env";
import { forgetEntry } from "../../src/capture/lifecycle";
import { resolveConfig } from "../../src/config";

// T-0089.1.1 close-out round 2: POST /restore and undo-from-trash take an optional nonce. Given one,
// only the trash row with that nonce comes back; absent, today's permission-checked behaviour holds.

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
const headers = { "Content-Type": "application/json", Authorization: "Bearer test-token" };

let t: TrashEnv;
afterEach(() => t?.close());

const post = (path: string, body: unknown) =>
  worker.fetch(new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) }), t.env, ctx);
const forget = async (id: string) => forgetEntry(id, t.env, { actorId: t.roots.ownerUserId, channel: "rest" }, { reason: "forget", config: await resolveConfig(t.env), purge: false }, t.roots.ownerPersonalWorkspaceId);

describe.each([["/restore"], ["/undo"]])("POST %s with a nonce", (path) => {
  it("a stale nonce restores nothing; the matching nonce restores the row", async () => {
    t = await makeTrashEnv();
    t.seed("a", { content: "first life" });
    await forget("a");
    const stale = await trashNonce(t.env, "a");
    // The row the caller saw is purged; the id is reused and trashed again.
    await t.sqlite.deleteFixtureRows(`DELETE FROM entries_trash WHERE id = 'a'`);
    t.seed("a", { content: "second life" });
    await forget("a");

    const refused = await post(path, { id: "a", nonce: stale });
    expect(refused.status).toBe(404);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'a'`)).toBeNull();
    expect((await t.one<{ content: string }>(`SELECT content FROM entries_trash WHERE id = 'a'`))!.content).toBe("second life");

    const ok = await post(path, { id: "a", nonce: await trashNonce(t.env, "a") });
    expect(ok.status).toBe(200);
    expect((await t.one<{ content: string }>(`SELECT content FROM entries WHERE id = 'a'`))!.content).toBe("second life");
  });

  it("without a nonce behaves as before", async () => {
    t = await makeTrashEnv();
    t.seed("b");
    await forget("b");
    expect((await post(path, { id: "b" })).status).toBe(200);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'b'`)).not.toBeNull();
  });

  it("a nonce that is not a non-empty string is 400", async () => {
    t = await makeTrashEnv();
    t.seed("c");
    await forget("c");
    for (const nonce of ["", 7, null]) expect((await post(path, { id: "c", nonce })).status).toBe(400);
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'c'`)).not.toBeNull();
  });
});

describe("POST /undo with a nonce never reverts a live row", () => {
  it("a live memory with a nonce is 404 and unchanged", async () => {
    t = await makeTrashEnv();
    t.seed("live", { content: "current" });
    t.version("live", 1, { content: "older" });
    const res = await post("/undo", { id: "live", nonce: "any" });
    expect(res.status).toBe(404);
    expect((await t.one<{ content: string }>(`SELECT content FROM entries WHERE id = 'live'`))!.content).toBe("current");
  });
});
