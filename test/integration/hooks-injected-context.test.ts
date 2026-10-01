/**
 * Privacy: a capture holds what the person typed (and, for Claude Code, what
 * the assistant said), never context the client injected into the transcript.
 * Codex puts AGENTS.md and <environment_context> into role:user records, Cursor
 * wraps the typed query among rules and attached files, and Claude Code adds
 * <system-reminder>, command and IDE wrappers. Each fixture is synthetic and
 * plants a sentinel in every injected block: none may reach the capture body.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanTemp } from "../helpers/tmp";

const root = resolve(import.meta.dirname, "../..");
const core = require("../../integrations/agent-hooks-core/core.js");
const codex = require("../../integrations/codex-cli-hooks/capture-worker.js");
const cursorEnd = require("../../integrations/cursor-hooks/session-end.js");
const claudeEnd = require("../../integrations/claude-code-hooks/session-end.js");

afterEach(() => { vi.unstubAllGlobals(); cleanTemp(); });

const SENTINELS = ["AGENTS_SENTINEL", "ENV_SENTINEL", "TOOL_SENTINEL", "SYSTEM_SENTINEL"];
const TYPED_1 = "Move the nightly digest off the shared cron";
const TYPED_2 = "Also log a line when it stops early.";
const ASSISTANT = "Done: the digest runs in its own cron slot";
const env = { SECOND_BRAIN_URL: "http://127.0.0.1:9", SECOND_BRAIN_TOKEN: "local-test-token" };
const fixture = (client: string) => join(root, "integrations", client, "fixtures", "injected-context-transcript.jsonl");

function stubWorker() {
  const bodies: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/capture") bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(path === "/health" ? { ok: true, version: "4.0.0" } : { ok: true }), { status: 200 });
  }));
  return bodies;
}

function expectClean(content: string) {
  for (const s of SENTINELS) expect(content).not.toContain(s);
  expect(content).not.toMatch(/<environment_context>|<INSTRUCTIONS>|AGENTS\.md|<system-reminder>|<user_info>|<rules>/i);
  expect(content).toContain(TYPED_1);
  expect(content).toContain(TYPED_2);
  // Second line of defense: secrets the person typed are redacted.
  expect(content).not.toContain("Hunter2Staging");
  expect(content).not.toContain("aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z");
  expect(content).toContain("postgres://app:[redacted]@db.internal/app");
}

describe("Codex: injected role:user blocks never reach a capture", () => {
  it("parser drops the AGENTS.md, environment, developer and tool blocks, keeps typed and assistant turns", () => {
    const turns = codex.parseTranscript(readFileSync(fixture("codex-cli-hooks"), "utf8"));
    const all = turns.map((t: any) => t.text).join("\n");
    for (const s of SENTINELS) expect(all).not.toContain(s);
    const users = turns.filter((t: any) => t.role === "user").map((t: any) => t.text);
    expect(users).toHaveLength(2); // the response_item/event_msg pair counts once
    expect(all).not.toContain("Typed words that share a block"); // dropped whole with its wrapper
    expect(users[0]).toMatch(new RegExp(`^${TYPED_1}`));
    expect(users[1]).toMatch(/^Also log a line/);
    expect(turns.some((t: any) => t.role === "assistant" && t.text.startsWith(ASSISTANT))).toBe(true);
  });

  it("the posted capture is clean end to end", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "sb-injected-codex-"));
    const sessions = join(scratch, "sessions", "2026", "09", "20");
    mkdirSync(sessions, { recursive: true });
    const transcript = join(sessions, "rollout-synthetic.jsonl");
    copyFileSync(fixture("codex-cli-hooks"), transcript);
    const bodies = stubWorker();
    await codex.run({ transcriptPath: transcript, cwd: scratch, sessionId: "codex-injected" },
      { transcriptRoot: join(scratch, "sessions"), env, cacheDir: join(scratch, "cache") });
    expect(bodies).toHaveLength(1);
    expectClean(bodies[0].content);
  });
});

describe("Cursor: only <user_query> counts as typed", () => {
  it("parser drops rules, user_info, attached files and unwrapped text, keeps typed and assistant turns", () => {
    const lines = readFileSync(fixture("cursor-hooks"), "utf8").split("\n").filter(Boolean);
    const turns = lines.map((l) => cursorEnd.turnFromLine(l)).filter(Boolean);
    const all = turns.map((t: any) => t.text).join("\n");
    for (const s of SENTINELS) expect(all).not.toContain(s);
    expect(turns.filter((t: any) => t.role === "user")).toHaveLength(2);
    expect(turns.some((t: any) => t.role === "assistant" && t.text.startsWith(ASSISTANT))).toBe(true);
  });

  it("the posted capture is clean end to end", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "sb-injected-cursor-"));
    const projects = join(scratch, "projects");
    const dir = join(projects, "acme", "agent-transcripts", "conv-injected");
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, "conv-injected.jsonl");
    copyFileSync(fixture("cursor-hooks"), transcript);
    const project = join(scratch, "acme");
    mkdirSync(project);
    const bodies = stubWorker();
    const opts = { transcriptRoot: projects, env, cacheDir: join(scratch, "cache") };
    await cursorEnd.runSessionEnd({ conversation_id: "conv-injected", workspace_roots: [project], transcript_path: transcript }, { ...opts, event: "stop" });
    await cursorEnd.runSessionEnd({ conversation_id: "conv-injected", workspace_roots: [project] }, { ...opts, event: "sessionEnd" });
    expect(bodies).toHaveLength(1);
    expectClean(bodies[0].content);
  });
});

describe("Claude Code: harness wrappers never reach a capture", () => {
  it("drops system-reminder, command, IDE, meta and tool_result content; keeps typed and assistant turns", () => {
    const turns = claudeEnd.readTranscriptTail(fixture("claude-code-hooks"));
    const body = claudeEnd.buildCaptureBody(turns, { project: "acme", sessionId: "synthetic", workspace: "personal", token: "local-test-token" });
    expectClean(body.content);
    expect(body.content).toContain(`Assistant: ${ASSISTANT}`);
    expect(body.content).toContain("Assistant: Added the early-stop log line");
  });

  it("a system-reminder block AFTER the typed text is removed too (it used to ride along)", () => {
    const line = JSON.stringify({ type: "user", message: { role: "user", content: [
      { type: "text", text: "Please move the digest off the shared cron." },
      { type: "text", text: "<system-reminder>Contents of /home/dev/CLAUDE.md: AGENTS_SENTINEL</system-reminder>" },
    ] } });
    expect(claudeEnd.turnFromLine(line).text).toBe("Please move the digest off the shared cron.");
  });
});

describe("recall-only adapters never read a transcript", () => {
  it.each(["vscode-copilot-hooks", "gemini-cli-hooks"])("%s has no capture path", (client) => {
    const dir = join(root, "integrations", client);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/performCapture|readFileSync|createReadStream|readTranscript/);
    }
  });
});

describe("stripInjectedContext", () => {
  it("drops a whole block that holds any wrapper-like tag or instruction-file header anywhere", () => {
    expect(core.stripInjectedContext("fix the digest\n<system-reminder>x</system-reminder>")).toBe("");
    expect(core.stripInjectedContext("fix the digest\n<tool_context>x</tool_context>")).toBe("");
    expect(core.stripInjectedContext("fix the digest\n\n# AGENTS.md instructions for /x\nrules")).toBe("");
    expect(core.stripInjectedContext("fix the digest. Contents of /x/CLAUDE.md follow")).toBe("");
    expect(core.stripInjectedContext("<environment_context><cwd>/x</cwd></environment_context>")).toBe("");
    expect(core.stripInjectedContext("a sentence that mentions <div> tags")).toBe("");
    expect(core.stripInjectedContext("  plain typed text, kept as typed  ")).toBe("plain typed text, kept as typed");
    expect(core.stripInjectedContext("compare a < b and c > d")).toBe("compare a < b and c > d");
  });
});

describe("secret redaction, second line of defense", () => {
  const corpus = [
    "token aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z in prose",
    "STRIPE_KEY=abcd1234efgh5678",
    "DB_PASSWORD: correct-horse-battery",
    "private_key = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'",
    "AWS_CREDENTIALS=AKIAIOSFODNN7EXAMPLE",
    "url postgres://app:Hunter2Staging@db.internal/app",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "rk_live_51Habcdefghijklmnop",
    'DB_PASSWORD="correct horse battery staple"',
    "api_key: 'open sesame please'",
  ];
  const secrets = ["aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z", "abcd1234efgh5678", "correct-horse-battery", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
    "AKIAIOSFODNN7EXAMPLE", "Hunter2Staging", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "rk_live_51Habcdefghijklmnop",
    "correct horse battery staple", "open sesame please"];

  it("redacts long tokens, credential-looking key=value lines, URL passwords and JWTs", () => {
    const out = core.redactSecrets(corpus.join("\n"));
    for (const s of secrets) expect(out).not.toContain(s);
    expect(out).toContain("postgres://app:[redacted]@db.internal/app");
  });

  it("leaves git SHAs, UUIDs, paths and env references alone", () => {
    const keep = "commit 3c25b260f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6, id 71a8e58f-8b65-4591-903e-01e87cc36d2a, "
      + "file /home/dev/acme/src/index.ts, apiKey = process.env.OPENAI_API_KEY";
    expect(core.redactSecrets(keep)).toBe(keep);
  });

  it("the Claude Code copy behaves identically to the shared core", () => {
    const text = corpus.join("\n") + "\ncommit 3c25b260f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6 apiKey = process.env.X";
    expect(claudeEnd.redactSecrets(text, "local-test-token")).toBe(core.redactSecrets(text, "local-test-token"));
  });
});
