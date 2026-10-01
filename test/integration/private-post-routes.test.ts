import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { setMemoryWriteLock } from "../../src/migration/write-lock";

const ctx = { waitUntil: (_promise: Promise<unknown>) => {} } as unknown as ExecutionContext;
const auth = { Authorization: "Bearer test-token", "Content-Type": "application/json" };

function raw(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { ...auth, ...(init.headers ?? {}) },
  });
}

describe("private values stay out of canonical request URLs", () => {
  it.each([
    "/recall?query=private-sentinel",
    "/entry?id=private-sentinel",
    "/connections?id=private-sentinel",
    "/digest?tag=private-sentinel",
    "/graph?seed=private-sentinel",
    "/list?tag=private-sentinel",
  ])("rejects legacy GET %s with 405", async (path) => {
    const env = makeTestEnv(makeTestDb());
    const response = await worker.fetch(raw(path), env, ctx);
    expect(response.status).toBe(405);
  });

  it("accepts recall and private filters in bounded JSON bodies", async () => {
    const env = makeTestEnv(makeTestDb());
    const recall = await worker.fetch(raw("/recall", {
      method: "POST",
      body: JSON.stringify({ query: "private-sentinel", topK: 5 }),
    }), env, ctx);
    expect(recall.status).toBe(200);

    const list = await worker.fetch(raw("/list", {
      method: "POST",
      body: JSON.stringify({ tag: "private-sentinel", n: 5 }),
    }), env, ctx);
    expect(list.status).toBe(200);
  });

  it("keeps pure-read POST available during maintenance while recall remains a write", async () => {
    const env = makeTestEnv(makeTestDb());
    await setMemoryWriteLock(env);
    const list = await worker.fetch(raw("/list", {
      method: "POST",
      body: JSON.stringify({ n: 5 }),
    }), env, ctx);
    expect(list.status).toBe(200);
    const recall = await worker.fetch(raw("/recall", {
      method: "POST",
      body: JSON.stringify({ query: "private-sentinel" }),
    }), env, ctx);
    expect(recall.status).toBe(423);
  });

  it("rejects an oversized recall body before search or Vectorize work", async () => {
    const env = makeTestEnv(makeTestDb());
    const response = await worker.fetch(raw("/recall", {
      method: "POST",
      body: JSON.stringify({ query: "x".repeat(33 * 1024) }),
    }), env, ctx);
    expect(response.status).toBe(413);
    expect(env.VECTORIZE.query).not.toHaveBeenCalled();
  });
});
