/**
 * session-start.js, run as a real process with the stdin shape this adapter
 * guesses VS Code Copilot's Local harness sends, against a loopback HTTP stub
 * (port 0, no real network). No Worker import here: unlike the Claude Code
 * contract test, this one only needs to prove the hook's own request/response
 * handling and its stdout shape, not that the URLs it builds are ones a real
 * Worker accepts (agent-hooks-core.test.ts and the Claude Code contract test
 * already cover that against the shared core).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { cleanTemp } from "../helpers/tmp";

afterAll(cleanTemp);

const HOOKS = resolve(import.meta.dirname, "../../integrations/vscode-copilot-hooks");

interface Captured { method: string; url: string }
interface StubBehaviour { recallStatus?: number; recallResults?: unknown[]; briefStatus?: number; recallDelayMs?: number; briefDelayMs?: number }

let server: Server;
let origin = "";
let captured: Captured[] = [];
let behaviour: StubBehaviour = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    captured.push({ method: req.method ?? "", url: req.url ?? "" });
    const reply = (status: number, json: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const send = () => {
      if (req.url?.startsWith("/recall")) {
        if (behaviour.recallStatus && behaviour.recallStatus >= 400) return reply(behaviour.recallStatus, { ok: false, code: "unauthorized" });
        return reply(200, { ok: true, results: behaviour.recallResults ?? [{ id: "m1", content: "a remembered thing", truncated: false }], insight: null });
      }
      if (req.url?.startsWith("/brief")) {
        if (behaviour.briefStatus) return reply(behaviour.briefStatus, { ok: false });
        return reply(200, { ok: true, attention: { due: 2 }, loops: { open: 1, items: [{ id: "task-1", content: "Send invoice" }] } });
      }
      return reply(404, { ok: false });
    };
    const delay = req.url?.startsWith("/recall") ? behaviour.recallDelayMs
      : req.url?.startsWith("/brief") ? behaviour.briefDelayMs : undefined;
    delay ? setTimeout(send, delay) : send();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

let scratch: string;
let project: string;

beforeEach(() => {
  captured = [];
  behaviour = {};
  scratch = mkdtempSync(join(tmpdir(), "sb-vscode-hooks-"));
  project = join(scratch, "brain-app");
  mkdirSync(project);
});
afterEach(cleanTemp);

/** Spawn the hook exactly as a Local harness session would: payload on stdin, then EOF. */
function runHook(payload: object, extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn("node", [`${HOOKS}/session-start.js`], {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        HOME: scratch, XDG_CACHE_HOME: join(scratch, "cache"),
        SECOND_BRAIN_URL: origin, SECOND_BRAIN_TOKEN: "test-token",
        ...extraEnv,
      } as unknown as NodeJS.ProcessEnv,
      stdio: "pipe",
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("error", fail);
    child.on("close", code => done({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const payload = (source = "startup") => ({ session_id: "s1", cwd: project, source });

describe("vscode-copilot-hooks/session-start.js", () => {
  it("emits the exact hookSpecificOutput.additionalContext JSON shape on success", async () => {
    const r = await runHook(payload());
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual(["additionalContext", "hookEventName"]);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("[Second Brain] Context recalled");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("a remembered thing");
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain("Bearer");
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain("test-token");

    const recalls = captured.filter(c => c.url === "/recall" && c.method === "POST");
    expect(recalls.length).toBeGreaterThanOrEqual(1);
  });

  it("is silent with exit 0 for a skipped source (resume)", async () => {
    const r = await runHook(payload("resume"));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(captured).toHaveLength(0);
  });

  it("is silent with exit 0 for a skipped source (fork)", async () => {
    const r = await runHook(payload("fork"));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(captured).toHaveLength(0);
  });

  it("reports a rejected token: exit 1, [Second Brain] stderr, no stdout, no secrets", async () => {
    behaviour.recallStatus = 401;
    const r = await runHook(payload());
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^\[Second Brain\] recall failed: HTTP 401/);
    expect(r.stderr).not.toContain("test-token");
    expect(r.stderr).not.toContain("Bearer");
  });

  it("fails without hanging when the Worker is down", async () => {
    const started = Date.now();
    const r = await runHook(payload(), { SECOND_BRAIN_URL: "http://127.0.0.1:1" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^\[Second Brain\] recall failed:/);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 10000);

  it("still resolves within the shared 3s brief-grace cap when only /brief is slow", async () => {
    // This adapter deliberately inherits Claude Code's 15s recall timeout (see
    // the comment above RECALL_TIMEOUT_MS in session-start.js), so a slow
    // /recall itself is not exercised here within a ~10s test budget. The
    // brief never blocks recall, though: its own grace period is a fixed 3s
    // regardless of the recall timeout, and that is what this proves - a
    // /brief that never answers must not hold up a successful recall past
    // ~3s plus overhead.
    behaviour.briefDelayMs = 8000;
    const started = Date.now();
    const r = await runHook(payload());
    const elapsed = Date.now() - started;
    expect(r.code, r.stderr).toBe(0);
    expect(elapsed).toBeLessThan(6000); // well under the brief's own delay: the 3s grace cap decides, not the stub
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.hookSpecificOutput.additionalContext).toContain("a remembered thing");
  }, 10000);
});
