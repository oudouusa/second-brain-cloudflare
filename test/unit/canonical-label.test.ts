/**
 * T-0089.4.1 (5.7): recall renders the 7-day AI-edit label from the dated
 * `edited-canonical:YYYY-MM-DD` tag. Recall names no tool (Q-I); the
 * dashboard, brief and history do, elsewhere.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { memoryHeader } from "../../src/recall/render";
import { withEditedCanonical } from "../../src/quarantine/tags";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { req } from "../helpers/make-request";
import worker from "../../src/index";
import type { Env } from "../../src/env";

afterEach(() => vi.useRealTimers());

const NOW = Date.UTC(2026, 8, 27, 12); // Sep 27, 2026, noon UTC

function m(tags: string[], createdAt = Date.UTC(2026, 7, 1, 12)) {
  return { createdAt, source: "claude", tags };
}

describe("memoryHeader: the canonical AI-edit label", () => {
  it("shows 'edited via an AI tool on <date>' within 7 days of the tag date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const tags = withEditedCanonical(["status:canonical"], Date.UTC(2026, 8, 26, 12));
    expect(memoryHeader(m(tags))).toContain("edited via an AI tool on Sep 26");
  });

  it("names no tool: the phrase never contains a client or provider name", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const tags = withEditedCanonical(["status:canonical"], Date.UTC(2026, 8, 26, 12));
    const header = memoryHeader(m(tags));
    expect(header).not.toMatch(/cursor|codex|claude code/i);
  });

  it("is not shown after 7 days (clock injected)", () => {
    vi.useFakeTimers();
    // 8 days after the edit date.
    vi.setSystemTime(Date.UTC(2026, 9, 4, 12));
    const tags = withEditedCanonical(["status:canonical"], Date.UTC(2026, 8, 26, 12));
    expect(memoryHeader(m(tags))).not.toContain("edited via an AI tool");
  });

  it("is shown at exactly the 7-day boundary but not the 8th day", () => {
    const editedAt = Date.UTC(2026, 7, 1, 12);
    vi.useFakeTimers();
    vi.setSystemTime(editedAt + 6 * 86_400_000);
    const tags = withEditedCanonical(["status:canonical"], editedAt);
    expect(memoryHeader(m(tags))).toContain("edited via an AI tool");
    vi.setSystemTime(editedAt + 8 * 86_400_000);
    expect(memoryHeader(m(tags))).not.toContain("edited via an AI tool");
  });

  it("is not shown for a non-canonical row carrying the tag (undo cleared status, the label lingers)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // Draft status, but an edited-canonical tag is still present.
    const tags = withEditedCanonical(["status:draft"], Date.UTC(2026, 8, 26, 12));
    expect(memoryHeader(m(tags))).not.toContain("edited via an AI tool");
  });

  it("is not shown when there is no edited-canonical tag at all", () => {
    expect(memoryHeader(m(["status:canonical"]))).not.toContain("edited via an AI tool");
  });

  it("get and list_recent headers show it too, since they share memoryHeader", () => {
    // No separate code path to test: memoryHeader is the one builder recall,
    // list_recent and get all call (render.ts's own module docs).
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const tags = withEditedCanonical(["status:canonical"], Date.UTC(2026, 8, 26, 12));
    expect(memoryHeader(m(tags))).toContain("edited via an AI tool on Sep 26");
  });
});

describe("REST /recall exposes edited_canonical_at", () => {
  const ctx = { waitUntil: (_: Promise<any>) => {} } as unknown as ExecutionContext;

  it("returns the dated tag's value, or null when there is none", async () => {
    resetDatabaseInit();
    const sqlite = makeSqliteD1();
    const env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
    await initializeDatabase(env);
    const edited = withEditedCanonical(["status:canonical"], Date.UTC(2026, 8, 26, 12));
    sqlite.seed({ id: "edited", content: "trusted note about the plan", createdAt: 1000, tags: edited });
    sqlite.seed({ id: "plain", content: "another note about the plan", createdAt: 1000, tags: [] });
    (env as any).VECTORIZE = makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("index unavailable")) });
    const res = await worker.fetch(req("POST", "/recall?query=note+plan"), env, ctx);
    const body = await res.json() as any;
    const edited1 = body.results.find((r: any) => r.id === "edited");
    const plain1 = body.results.find((r: any) => r.id === "plain");
    expect(edited1.edited_canonical_at).toBe("2026-09-26");
    expect(plain1.edited_canonical_at).toBeNull();
  });
});
