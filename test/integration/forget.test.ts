import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTrashEnv, type TrashEnv } from "../helpers/trash-env";
import { makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

let t: TrashEnv;
afterEach(() => t?.close());

describe("POST /forget", () => {
  it("returns 400 when body is invalid JSON", async () => {
    t = await makeTrashEnv();
    const res = await worker.fetch(
      new Request("http://localhost/forget", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: "{not json",
      }),
      t.env,
      ctx
    );
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });

  it("returns 400 when id is missing", async () => {
    t = await makeTrashEnv();
    const res = await worker.fetch(req("POST", "/forget", { body: {} }), t.env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toBe("id is required");
  });

  it("returns 404 for non-existent id", async () => {
    t = await makeTrashEnv();
    const res = await worker.fetch(req("POST", "/forget", { body: { id: "no-such-id" } }), t.env, ctx);
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });

  it("moves an existing entry to the trash and deletes its vectors", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    t = await makeTrashEnv({ VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }) });
    t.seed("entry-1", { vector_ids: '["entry-1","entry-1-update-111"]' });

    const res = await worker.fetch(req("POST", "/forget", { body: { id: "entry-1" } }), t.env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.id).toBe("entry-1");
    expect(data.deletedVectors).toBe(2);
    expect(data.trash).toBe(true);

    expect(await t.one(`SELECT id FROM entries WHERE id = 'entry-1'`)).toBeNull();
    expect(await t.one(`SELECT id FROM entries_trash WHERE id = 'entry-1'`)).not.toBeNull();
    expect(deleteByIdsMock).toHaveBeenCalledWith(["entry-1", "entry-1-update-111"]);
  });

  it("trims whitespace from id before lookup", async () => {
    t = await makeTrashEnv();
    t.seed("entry-1");
    const res = await worker.fetch(req("POST", "/forget", { body: { id: "  entry-1  " } }), t.env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.id).toBe("entry-1");
  });

  it("cascade-deletes edges touching the forgotten entry", async () => {
    t = await makeTrashEnv();
    t.seed("entry-1");
    for (const id of ["other", "another", "x", "y"]) t.seed(id);
    await t.edge("e1", "entry-1", "other");
    await t.edge("e2", "another", "entry-1");
    await t.edge("e3", "x", "y");
    const res = await worker.fetch(req("POST", "/forget", { body: { id: "entry-1" } }), t.env, ctx);
    expect(res.status).toBe(200);
    // Edges with entry-1 as source OR target are removed; the unrelated edge survives — no dangling edges.
    expect((await t.all(`SELECT id FROM edges`)).map((e) => e.id)).toEqual(["e3"]);
  });

  it("is non-fatal when Vectorize delete fails", async () => {
    t = await makeTrashEnv({ VECTORIZE: makeVectorizeMock({ deleteByIds: vi.fn().mockRejectedValue(new Error("Vectorize down")) }) });
    t.seed("entry-1", { vector_ids: '["entry-1"]' });
    const res = await worker.fetch(req("POST", "/forget", { body: { id: "entry-1" } }), t.env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(await t.one(`SELECT id FROM entries WHERE id = 'entry-1'`)).toBeNull();
  });
});
