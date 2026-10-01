/**
 * session-start.js, run as a real process with the stdin shape Gemini CLI is
 * documented (defensively, per README.md's Unverified list) to send, against a
 * loopback HTTP stub (port 0, no real network). No Worker import here: this
 * only needs to prove the hook's own request/response handling, its stdout
 * shape, and - the important one - that it never blocks the (synchronous,
 * CLI-blocking) host past its own 3s cap, not that the URLs it builds are ones
 * a real Worker accepts (agent-hooks-core.test.ts and the Claude Code contract
 * test already cover that against the shared core).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { cleanTemp } from "../helpers/tmp";

afterAll(cleanTemp);

const HOOKS = resolve(import.meta.dirname, "../../integrations/gemini-cli-hooks");

interface Captured { method: string; url: string }
interface StubBehaviour { recallStatus?: number; recallResults?: unknown[]; briefStatus?: number; recallDelayMs?: number }

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
    const delay = req.url?.startsWith("/recall") ? behaviour.recallDelayMs : undefined;
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
  scratch = mkdtempSync(join(tmpdir(), "sb-gemini-hooks-"));
  project = join(scratch, "brain-app");
  mkdirSync(project);
});
afterEach(cleanTemp);

/** Spawn the hook exactly as a Gemini CLI SessionStart run would: payload on stdin, then EOF. */
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

describe("gemini-cli-hooks/session-start.js", () => {
  it("emits the exact hookSpecificOutput.additionalContext JSON shape on success, JSON-only on stdout", async () => {
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
    // Only JSON on stdout - no plain-text fallback like Codex allows.
    expect(r.stdout.trimStart().startsWith("{")).toBe(true);

    const recalls = captured.filter(c => c.url === "/recall" && c.method === "POST");
    expect(recalls.length).toBeGreaterThanOrEqual(1);
  });

  it("is silent with exit 0 for a skipped source (resume) - no stdout, no requests", async () => {
    const r = await runHook(payload("resume"));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(captured).toHaveLength(0);
  });

  it("runs a fresh recall for startup and clear (no assumed compact/rerun source)", async () => {
    const startup = await runHook(payload("startup"));
    expect(startup.stdout).toContain("Context recalled");
    captured = [];
    const clear = await runHook(payload("clear"));
    expect(clear.stdout).toContain("Context recalled");
    expect(captured.filter(c => c.url === "/recall" && c.method === "POST").length).toBeGreaterThanOrEqual(1);
  });

  it("emits nothing when there is no context to recall", async () => {
    behaviour.recallResults = [];
    behaviour.briefStatus = 404;
    const r = await runHook(payload());
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
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

  it("fails without hanging when the Worker is down (connection refused)", async () => {
    const started = Date.now();
    const r = await runHook(payload(), { SECOND_BRAIN_URL: "http://127.0.0.1:1" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^\[Second Brain\] recall failed:/);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 10000);

  it("does nothing without credentials, and honours the opt-out", async () => {
    const r = await runHook(payload(), { SECOND_BRAIN_URL: "", SECOND_BRAIN_TOKEN: "" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(captured).toHaveLength(0);
    await runHook(payload(), { SECOND_BRAIN_HOOK_RECALL: "0" });
    expect(captured).toHaveLength(0);
  });

  // The scenario the whole adapter exists for: Gemini's hooks run synchronously
  // and the CLI waits on this process, with no documented host-side timeout
  // ceiling. A stub that hangs ~8s must not hang the process for anywhere near
  // that long - the adapter's own capMs: 3000 is the only thing preventing an
  // indefinitely hung terminal. The assertion window (well under 4s) is tight;
  // the vitest timeout on the test itself is generous so a slow CI runner can't
  // turn a real regression into a flaky pass.
  it("still exits within its own ~3s cap when the stub hangs for ~8s (synchronous-CLI-blocking safety)", async () => {
    behaviour.recallDelayMs = 8000;
    const started = Date.now();
    const r = await runHook(payload());
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(4000);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^\[Second Brain\] recall failed: no reply within [0-3]\.\ds/);
  }, 15000);
});
