import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { getHotContext, HOT_CONTEXT_MAX_CHARS } from "../../src/memory/tier";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";

const immediateCtx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    content: `content ${id}`,
    tags: "[]",
    source: "api",
    created_at: 1000,
    updated_at: 1000,
    vector_ids: "[]",
    recall_count: 0,
    importance_score: 0,
    contradiction_wins: 0,
    contradiction_losses: 0,
    memory_tier: "warm",
    pinned: 0,
    last_recalled_at: null,
    ...overrides,
  };
}

describe("manual memory tiers", () => {
  it("starts new memories warm and changes tier without re-embedding", async () => {
    const db = makeTestDb();
    const env = makeTestEnv(db);
    const pending: Promise<unknown>[] = [];
    const captureCtx = {
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
    } as unknown as ExecutionContext;
    const capture = await worker.fetch(req("POST", "/capture", { body: { content: "new warm memory" } }), env, captureCtx);
    await Promise.allSettled(pending);
    expect(capture.status).toBe(200);
    expect(db.entries[0].memory_tier).toBe("warm");

    vi.mocked(env.VECTORIZE.upsert).mockClear();
    const changed = await worker.fetch(req("POST", "/memory/tier", {
      body: { id: db.entries[0].id, tier: "cold" },
    }), env, immediateCtx);
    expect(changed.status).toBe(200);
    expect(db.entries[0].memory_tier).toBe("cold");
    expect(env.VECTORIZE.upsert).not.toHaveBeenCalled();
  });

  it("pins and unpins independently of tier", async () => {
    const db = makeTestDb();
    db.entries.push(row("a", { memory_tier: "cold" }));
    const env = makeTestEnv(db);

    expect((await worker.fetch(req("POST", "/memory/pin", { body: { id: "a", pinned: true } }), env, immediateCtx)).status).toBe(200);
    expect(db.entries[0]).toMatchObject({ memory_tier: "cold", pinned: 1 });
    expect((await worker.fetch(req("POST", "/memory/pin", { body: { id: "a", pinned: false } }), env, immediateCtx)).status).toBe(200);
    expect(db.entries[0]).toMatchObject({ memory_tier: "cold", pinned: 0 });
  });

  it("builds importance-ordered hot context and enforces 12,000 characters", async () => {
    const db = makeTestDb();
    db.entries.push(
      row("important", { memory_tier: "hot", importance_score: 5, content: "priority" }),
      row("pinned-cold", { memory_tier: "cold", pinned: 1, importance_score: 3, content: "pinned" }),
      row("ordinary", { memory_tier: "warm", importance_score: 9, content: "not included" }),
      row("deprecated", { memory_tier: "hot", tags: '["status:deprecated"]', content: "not included" }),
      row("large", { memory_tier: "hot", importance_score: 1, content: "x".repeat(20_000) }),
    );
    const hot = await getHotContext(makeTestEnv(db));
    expect(hot.text.indexOf("important")).toBeLessThan(hot.text.indexOf("pinned-cold"));
    expect(hot.text).not.toContain("ordinary");
    expect(hot.text).not.toContain("deprecated");
    expect(hot.text.length).toBeLessThanOrEqual(HOT_CONTEXT_MAX_CHARS);
    expect(hot.truncated).toBe(true);
  });

  it("keeps cold memories in ordinary recall and records last_recalled_at", async () => {
    const db = makeTestDb();
    db.entries.push(row("cold", { memory_tier: "cold", content: "Glacier project decision" }));
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "cold", score: 0.9, metadata: { parentId: "cold", isUpdate: false } }],
        }),
      }),
    });
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
    } as unknown as ExecutionContext;
    const response = await worker.fetch(req("POST", "/recall?query=glacier"), env, ctx);
    const body = await response.json() as { results: { id: string }[] };
    expect(body.results.map(result => result.id)).toContain("cold");
    await Promise.all(pending);
    expect(db.entries[0].last_recalled_at).toEqual(expect.any(Number));
  });
});
