import { describe, it, expect, beforeEach } from "vitest";
import worker, { buildMcpServer, type Env } from "../../src/index";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;
const STANDARD_NOTICE = "pointer-contract notice: consider the standard pointer form (Source of truth / Use when / Search terms) — see SECONDBRAIN.md.";

function pointerEnv(db: D1Mock, max?: string): Env {
  return makeTestEnv(db, {
    POINTER_CONTRACT: "1",
    ...(max !== undefined ? { POINTER_MAX_CHARS: max } : {}),
  });
}

function seedEntry(db: D1Mock, overrides: Partial<{
  id: string;
  content: string;
  tags: string;
  source: string;
  created_at: number;
  vector_ids: string;
}> = {}) {
  const entry = {
    id: "entry-1",
    content: "Original pointer",
    tags: "[]",
    source: "api",
    created_at: Date.now(),
    vector_ids: "[]",
    ...overrides,
  };
  db.entries.push(entry);
  return entry;
}

function mcpTool(env: Env, name: "remember" | "append" | "update") {
  const server = buildMcpServer(env, ctx);
  return (server as any)._registeredTools[name].handler as (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
}

async function jsonBody(res: Response): Promise<any> {
  return await res.json() as any;
}

describe("pointer contract", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("does not run validation or add notices when the flag is unset", async () => {
    const secret = `api_key: ${"A".repeat(20)}`;
    const content = `${"x".repeat(1300)}\n${secret}\nplain note without pointer fields`;

    const res = await worker.fetch(req("POST", "/capture", { body: { content } }), env, ctx);
    const data = await jsonBody(res);

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.notice).toBeUndefined();
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toContain(secret);
  });

  it("rejects over-limit HTTP capture, append, and update before mutation", async () => {
    env = pointerEnv(db, "10");

    const captureRes = await worker.fetch(req("POST", "/capture", { body: { content: "x".repeat(11) } }), env, ctx);
    expect(captureRes.status).toBe(400);
    expect((await jsonBody(captureRes)).error).toBe(
      "pointer contract: content exceeds 10 chars (11). Store the full text in canonical docs (dev-vault / repo docs) and save a short pointer instead."
    );
    expect(db.entries).toHaveLength(0);

    seedEntry(db, { content: "Original append content" });
    const appendRes = await worker.fetch(req("POST", "/append", { body: { id: "entry-1", addition: "y".repeat(11) } }), env, ctx);
    expect(appendRes.status).toBe(400);
    expect((await jsonBody(appendRes)).error).toContain("content exceeds 10 chars (11)");
    expect(db.entries[0].content).toBe("Original append content");

    const updateRes = await worker.fetch(req("POST", "/update", { body: { id: "entry-1", content: "z".repeat(11) } }), env, ctx);
    expect(updateRes.status).toBe(400);
    expect((await jsonBody(updateRes)).error).toContain("content exceeds 10 chars (11)");
    expect(db.entries[0].content).toBe("Original append content");
  });

  it("returns readable MCP errors for over-limit remember, append, and update", async () => {
    env = pointerEnv(db, "5");
    const expected = "pointer contract: content exceeds 5 chars (6). Store the full text in canonical docs (dev-vault / repo docs) and save a short pointer instead.";

    const rememberResult = await mcpTool(env, "remember")({ content: "abcdef" });
    expect(rememberResult.content[0].text).toBe(expected);
    expect(db.entries).toHaveLength(0);

    seedEntry(db, { content: "Original" });
    const appendResult = await mcpTool(env, "append")({ id: "entry-1", addition: "abcdef" });
    expect(appendResult.content[0].text).toBe(expected);
    expect(db.entries[0].content).toBe("Original");

    const updateResult = await mcpTool(env, "update")({ id: "entry-1", content: "abcdef" });
    expect(updateResult.content[0].text).toBe(expected);
    expect(db.entries[0].content).toBe("Original");
  });

  it("rejects representative secret patterns without echoing the secret value", async () => {
    const cases = [
      { name: "openai_or_anthropic_key", secret: `sk-${"A".repeat(20)}` },
      { name: "github_token", secret: `ghp_${"B".repeat(36)}` },
      { name: "aws_access_key", secret: `AKIA${"C".repeat(16)}` },
      { name: "generic_secret_assignment", secret: `password=${"d".repeat(16)}` },
    ];

    for (const item of cases) {
      db = makeTestDb();
      env = pointerEnv(db);

      const res = await worker.fetch(req("POST", "/capture", { body: { content: `pointer ${item.secret}` } }), env, ctx);
      const data = await jsonBody(res);

      expect(res.status).toBe(400);
      expect(data.error).toContain(item.name);
      expect(data.error).not.toContain(item.secret);
      expect(db.entries).toHaveLength(0);
    }
  });

  it("saves remember content without the standard form and appends a notice", async () => {
    env = pointerEnv(db);

    const result = await mcpTool(env, "remember")({ content: "Short pointer without the standard headings" });

    expect(db.entries).toHaveLength(1);
    expect(result.content[0].text).toContain("Stored. ID:");
    expect(result.content[0].text).toContain(STANDARD_NOTICE);
  });

  it("does not add the standard-form notice when remember content includes a standard field", async () => {
    env = pointerEnv(db);

    const result = await mcpTool(env, "remember")({
      content: "Source of truth: docs/architecture.md\nUse when: checking the architecture\nSearch terms: architecture",
    });

    expect(db.entries).toHaveLength(1);
    expect(result.content[0].text).toContain("Stored. ID:");
    expect(result.content[0].text).not.toContain("pointer-contract notice:");
  });

  it("saves append content and returns an advisory when combined content exceeds three times the max", async () => {
    env = pointerEnv(db, "10");
    seedEntry(db, { content: "12345678901234567890" });

    const res = await worker.fetch(req("POST", "/append", { body: { id: "entry-1", addition: "ok" } }), env, ctx);
    const data = await jsonBody(res);

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.notice).toBe("pointer-contract notice: combined content now exceeds 30 chars; consider update (replace) or splitting, and move the body to canonical docs.");
    expect(db.entries[0].content).toContain("ok");
  });

  it("allows normal short pointer writes without extra notices", async () => {
    env = pointerEnv(db);

    const captureRes = await worker.fetch(req("POST", "/capture", {
      body: { content: "Source of truth: docs/runbook.md\nUse when: running checks\nSearch terms: checks" },
    }), env, ctx);
    const captureData = await jsonBody(captureRes);
    expect(captureRes.status).toBe(200);
    expect(captureData.ok).toBe(true);
    expect(captureData.notice).toBeUndefined();

    const id = captureData.id as string;
    const appendRes = await worker.fetch(req("POST", "/append", { body: { id, addition: "small update" } }), env, ctx);
    const appendData = await jsonBody(appendRes);
    expect(appendRes.status).toBe(200);
    expect(appendData.ok).toBe(true);
    expect(appendData.notice).toBeUndefined();

    const updateRes = await worker.fetch(req("POST", "/update", {
      body: { id, content: "Source of truth: docs/runbook.md\nUse when: after replacement\nSearch terms: replacement" },
    }), env, ctx);
    const updateData = await jsonBody(updateRes);
    expect(updateRes.status).toBe(200);
    expect(updateData.ok).toBe(true);
    expect(updateData.notice).toBeUndefined();
  });

  it("uses the default max for unset and invalid values, and honors an explicit max", async () => {
    env = makeTestEnv(db, { POINTER_CONTRACT: "true" });
    const defaultRes = await worker.fetch(req("POST", "/capture", { body: { content: "x".repeat(1201) } }), env, ctx);
    expect((await jsonBody(defaultRes)).error).toContain("content exceeds 1200 chars (1201)");

    db = makeTestDb();
    env = makeTestEnv(db, { POINTER_CONTRACT: "1", POINTER_MAX_CHARS: "not-a-number" });
    const invalidRes = await worker.fetch(req("POST", "/capture", { body: { content: "x".repeat(1201) } }), env, ctx);
    expect((await jsonBody(invalidRes)).error).toContain("content exceeds 1200 chars (1201)");

    db = makeTestDb();
    env = pointerEnv(db, "7");
    const explicitRes = await worker.fetch(req("POST", "/capture", { body: { content: "x".repeat(8) } }), env, ctx);
    expect((await jsonBody(explicitRes)).error).toContain("content exceeds 7 chars (8)");
  });
});
