/**
 * The Cursor hooks, run as real processes with the stdin shape this adapter
 * assumes Cursor sends, against a loopback HTTP stub (127.0.0.1:0, no real
 * network). Like the vscode-copilot-hooks contract test, this proves the
 * hooks' own request/response handling and dedup logic against the stub, not
 * that the URLs they build are ones a real Worker accepts (agent-hooks-core's
 * own unit tests and the Claude Code contract test already cover that against
 * the shared core).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { cleanTemp } from "../helpers/tmp";

afterAll(cleanTemp);

const HOOKS = resolve(import.meta.dirname, "../../integrations/cursor-hooks");
const FIXTURE = join(HOOKS, "fixtures/real-shape-transcript.jsonl");

interface Captured { method: string; url: string; body: string }
interface StubBehaviour {
  recallStatus?: number; recallResults?: unknown[]; briefStatus?: number; recallDelayMs?: number;
  captureStatus?: number; captureError?: string; healthVersion?: string;
}

let server: Server;
let origin = "";
let captured: Captured[] = [];
let behaviour: StubBehaviour = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      captured.push({ method: req.method ?? "", url: req.url ?? "", body });
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const send = () => {
        if (req.url?.startsWith("/health")) return reply(200, { ok: true, version: behaviour.healthVersion ?? "3.0.0" });
        if (req.url?.startsWith("/recall")) {
          if (behaviour.recallStatus && behaviour.recallStatus >= 400) return reply(behaviour.recallStatus, { ok: false, code: "unauthorized" });
          return reply(200, { ok: true, results: behaviour.recallResults ?? [{ id: "m1", content: "a remembered thing", truncated: false }], insight: null });
        }
        if (req.url?.startsWith("/brief")) {
          if (behaviour.briefStatus) return reply(behaviour.briefStatus, { ok: false });
          return reply(200, { ok: true });
        }
        if (req.url === "/capture") {
          if (behaviour.captureStatus && behaviour.captureStatus >= 400) return reply(behaviour.captureStatus, { ok: false, code: "unauthorized", error: behaviour.captureError });
          return reply(200, { ok: true, id: "new-id" });
        }
        return reply(404, { ok: false });
      };
      const delay = req.url?.startsWith("/recall") ? behaviour.recallDelayMs : undefined;
      delay ? setTimeout(send, delay) : send();
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

let scratch: string;
let project: string;
let cacheDir: string;

beforeEach(() => {
  captured = [];
  behaviour = {};
  scratch = mkdtempSync(join(tmpdir(), "sb-cursor-hooks-"));
  project = join(scratch, "brain-app");
  cacheDir = join(scratch, "cache");
  mkdirSync(project);
});
afterEach(cleanTemp);

/** Spawn a hook exactly as Cursor would: payload on stdin, then EOF. Isolated HOME and cache. */
function runHook(script: string, payload: object, extraEnv: Record<string, string> = {}, args: string[] = []) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    // Cursor runs user hooks from ~/.cursor, never the project: cwd says so.
    const hooksHome = join(scratch, ".cursor");
    mkdirSync(hooksHome, { recursive: true });
    const child = spawn("node", [`${HOOKS}/${script}`, ...args], {
      cwd: hooksHome,
      env: {
        PATH: process.env.PATH,
        HOME: scratch, XDG_CACHE_HOME: cacheDir,
        SECOND_BRAIN_URL: origin, SECOND_BRAIN_TOKEN: "test-token",
        ...extraEnv,
      } as unknown as NodeJS.ProcessEnv, // wrangler's types make AUTH_TOKEN required; the hook must not inherit it
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

// The documented Cursor payload: `conversation_id` and `workspace_roots` are
// common fields on every event; only `stop` carries `transcript_path`.
const startPayload = (id = "conv-1") => ({ conversation_id: id, session_id: `sess-${id}`, hook_event_name: "sessionStart", workspace_roots: [project] });
const stopPayload = (transcript_path: string, id = "conv-1") => ({ conversation_id: id, hook_event_name: "stop", workspace_roots: [project], transcript_path });
const endPayload = (id = "conv-1") => ({ conversation_id: id, session_id: `sess-${id}`, hook_event_name: "sessionEnd", workspace_roots: [project] });

/** A transcript where a real install keeps it: ~/.cursor/projects/<p>/agent-transcripts/<id>/<id>.jsonl. */
function transcriptFor(id: string) {
  const dir = join(scratch, ".cursor", "projects", "brain-app", "agent-transcripts", id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  copyFileSync(FIXTURE, file);
  return file;
}
const runStop = (id: string, env: Record<string, string> = {}) => runHook("session-end.js", stopPayload(transcriptFor(id), id), env, ["--event=stop"]);
const runEnd = (id: string, env: Record<string, string> = {}) => runHook("session-end.js", endPayload(id), env, ["--event=sessionEnd"]);
const spooled = () => {
  const d = join(cacheDir, "second-brain", "capture-spool", "cursor");
  return existsSync(d) ? readdirSync(d).filter(n => n.endsWith(".json")) : [];
};

describe("session-start.js", () => {
  it("emits the flat additional_context shape, the one output Cursor's docs say reaches the model", async () => {
    const r = await runHook("session-start.js", startPayload());
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(Object.keys(parsed)).toEqual(["additional_context"]);
    expect(parsed.additional_context).toContain("[Second Brain] Context recalled");
    expect(parsed.additional_context).toContain("a remembered thing");
    expect(parsed.additional_context).not.toContain("Bearer");
    expect(parsed.additional_context).not.toContain("test-token");
  });

  it("scopes recall to workspace_roots, not the hooks directory it runs from", async () => {
    await runHook("session-start.js", startPayload());
    const recall = captured.find(c => c.method === "POST" && c.url === "/recall")!;
    expect(JSON.parse(recall.body).project).toBe("brain-app");
  });

  it("asks for recall without LLM synthesis", async () => {
    await runHook("session-start.js", startPayload());
    const recall = captured.find(c => c.method === "POST" && c.url === "/recall")!;
    expect(JSON.parse(recall.body).synthesize).toBe(false);
  });

  it("reports a rejected token: exit 1, [Second Brain] stderr, no stdout, no secrets", async () => {
    behaviour.recallStatus = 401;
    const r = await runHook("session-start.js", startPayload());
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^\[Second Brain\] recall failed: HTTP 401/);
    expect(r.stderr).not.toContain("test-token");
    expect(r.stderr).not.toContain("Bearer");
  });

  it("fails without hanging when the Worker is down", async () => {
    const started = Date.now();
    const r = await runHook("session-start.js", startPayload(), { SECOND_BRAIN_URL: "http://127.0.0.1:1" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^\[Second Brain\] recall failed:/);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 10000);

  it("still resolves within the 3s cap even when the stub delays recall", async () => {
    behaviour.recallDelayMs = 6000;
    const started = Date.now();
    const r = await runHook("session-start.js", startPayload());
    expect(Date.now() - started).toBeLessThan(6000);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^\[Second Brain\] recall failed: no reply within [0-3]\.\ds/);
  }, 10000);

  it("does nothing without credentials, and honours the opt-out", async () => {
    const r = await runHook("session-start.js", startPayload(), { SECOND_BRAIN_URL: "", SECOND_BRAIN_TOKEN: "" });
    expect(r.code).toBe(0); expect(r.stdout).toBe(""); expect(captured).toHaveLength(0);
    const r2 = await runHook("session-start.js", startPayload(), { SECOND_BRAIN_HOOK_RECALL: "0" });
    expect(r2.stdout).toBe("");
    expect(captured).toHaveLength(0);
  });
});

describe("stop then sessionEnd: one capture per conversation", () => {
  it("stop sends nothing; sessionEnd makes one POST /capture with the exact header and body shape", async () => {
    const stop = await runStop("conv-1");
    expect(stop.code, stop.stderr).toBe(0);
    expect(captured).toHaveLength(0);

    const r = await runEnd("conv-1");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    const captures = captured.filter(c => c.url === "/capture");
    expect(captures).toHaveLength(1);
    const body = JSON.parse(captures[0].body);
    expect(body.source).toBe("cursor-session");
    expect(body.workspace).toBe("personal");
    expect(body.content).toMatch(/^Cursor session in brain-app, \d{4}-\d{2}-\d{2}/);
    expect(body.content).toContain("User: Let's wire the nightly digest");
    expect(body.content).toContain("User: Actually hold off on shipping");
    expect(body.content).not.toContain("<user_query>");
    expect(body.content).not.toContain("sk-abcdef1234567890ABCDEF");
    expect(body.content).toContain("[redacted]");
    expect(body.content.length).toBeLessThanOrEqual(2000);
    expect(body.tags).toEqual(["brain-app"]);
  });

  it("many stops (one per agent turn) still produce exactly one capture", async () => {
    for (let i = 0; i < 5; i++) expect((await runStop("conv-2")).code).toBe(0);
    await runEnd("conv-2");
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(1);
  });

  it("sessionEnd with no recorded transcript (transcripts off) is a quiet no-op", async () => {
    const r = await runEnd("conv-never-stopped");
    expect(r.code, r.stderr).toBe(0);
    expect(captured).toHaveLength(0);
  });

  it("a transcript outside ~/.cursor/projects is never recorded or read", async () => {
    const outside = join(scratch, "conv-3.jsonl");
    copyFileSync(FIXTURE, outside);
    await runHook("session-end.js", stopPayload(outside, "conv-3"), {}, ["--event=stop"]);
    await runEnd("conv-3");
    expect(captured).toHaveLength(0);
  });

  it("never captures the same conversation twice", async () => {
    await runStop("conv-4"); await runEnd("conv-4");
    captured = [];
    await runEnd("conv-4");
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });

  it("reports a rejected token on capture: stderr line and exit 1", async () => {
    behaviour.captureStatus = 401;
    await runStop("conv-5");
    const r = await runEnd("conv-5");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^\[Second Brain\] session capture failed: HTTP 401/);
  });

  it("does not capture against a Worker older than 3.0, and says so once", async () => {
    behaviour.healthVersion = "2.4.0";
    await runStop("conv-6");
    const first = await runEnd("conv-6");
    expect(first.code).toBe(1);
    expect(first.stderr).toContain("needs Worker 3.0+");
    await runStop("conv-7");
    const second = await runEnd("conv-7");
    expect(second.code).toBe(0); // notice is once per 24h
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });

  it("keeps the capture when the Worker is down, and the next session start resends it after recall", async () => {
    await runStop("conv-8");
    const r = await runEnd("conv-8", { SECOND_BRAIN_URL: "http://127.0.0.1:1" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Second Brain: could not save this session right now. Capture kept on this computer to retry.");
    expect(spooled()).toHaveLength(1);

    const start = await runHook("session-start.js", startPayload("conv-9"));
    expect(start.code, start.stderr).toBe(0);
    const order = captured.map(c => c.url.split("?")[0]);
    expect(order.lastIndexOf("/recall")).toBeLessThan(order.indexOf("/capture"));
    expect(spooled()).toHaveLength(0);
  });

  it("honours SECOND_BRAIN_HOOK_CAPTURE_CURSOR without touching recall", async () => {
    await runStop("conv-10");
    const r = await runEnd("conv-10", { SECOND_BRAIN_HOOK_CAPTURE_CURSOR: "0" });
    expect(r.code, r.stderr).toBe(0);
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });

  it("dry run prints the body and sends nothing", async () => {
    await runStop("conv-11");
    const r = await runEnd("conv-11", { SECOND_BRAIN_DRY_RUN: "1" });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ source: "cursor-session", project: "brain-app" });
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });
});
