/**
 * The Codex CLI hooks, run as processes against a local HTTP stub (no real
 * network), then each captured request replayed through the real Worker.
 *
 * session-start.js is exercised via stdin, exactly like every other adapter.
 * session-end.js itself is NOT exercised here: its whole job is to spawn a
 * detached capture-worker.js and exit, which this suite cannot observe
 * without racing a background process. capture-worker.js - the file that
 * actually reads the transcript and calls the Worker - is spawned directly,
 * with its payload as argv[2], the same way session-end.js's dispatchCapture
 * invokes it in production (see test/unit/codex-cli-hooks.test.ts for that
 * dispatch call itself).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import type { Env } from "../../src/env";
import { cleanTemp } from "../helpers/tmp";

afterAll(cleanTemp);

const HOOKS = resolve(import.meta.dirname, "../../integrations/codex-cli-hooks");
const FIXTURE = join(HOOKS, "fixtures/sample-transcript.jsonl");
const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;

interface Captured { method: string; url: string; body: string }
interface StubBehaviour {
  healthVersion?: string; recallStatus?: number; recallResults?: unknown[];
  briefStatus?: number; captureStatus?: number; captureError?: string; delayMs?: number; unknownProject?: boolean;
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
          if (behaviour.unknownProject && req.url.includes("project="))
            return reply(404, { ok: false, error: 'unknown project "x"', known_projects: [] });
          return reply(200, { ok: true, results: behaviour.recallResults ?? [{ id: "m1", content: "a remembered thing", truncated: false }], insight: null });
        }
        if (req.url?.startsWith("/brief")) {
          if (behaviour.unknownProject && req.url.includes("project="))
            return reply(404, { ok: false, error: 'unknown project "x"', known_projects: [] });
          if (behaviour.briefStatus) return reply(behaviour.briefStatus, { ok: false });
          return reply(200, { ok: true, attention: { due: 0 }, loops: { open: 0, items: [] } });
        }
        if (req.url === "/capture") {
          if (behaviour.captureStatus && behaviour.captureStatus >= 400) return reply(behaviour.captureStatus, { ok: false, code: "unauthorized", error: behaviour.captureError });
          return reply(200, { ok: true, id: "new-id" });
        }
        return reply(200, { ok: true, id: "new-id" });
      };
      behaviour.delayMs ? setTimeout(send, behaviour.delayMs) : send();
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

let sqlite: SqliteD1;
let env: Env;
let scratch: string;
let project: string;

beforeEach(async () => {
  captured = [];
  behaviour = {};
  scratch = mkdtempSync(join(tmpdir(), "sb-codex-hooks-"));
  project = join(scratch, "brain-app");
  mkdirSync(project);
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = sqlite.admitEnv(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);
});
afterEach(() => sqlite?.close());

function baseEnv(extraEnv: Record<string, string>) {
  return {
    PATH: process.env.PATH,
    HOME: scratch, XDG_CACHE_HOME: join(scratch, "cache"),
    SECOND_BRAIN_URL: origin, SECOND_BRAIN_TOKEN: "test-token",
    ...extraEnv, WRITE_ADMISSION_TOKEN: extraEnv.WRITE_ADMISSION_TOKEN,
  } as unknown as NodeJS.ProcessEnv; // wrangler's types make AUTH_TOKEN required; the hook must not inherit it
}

/** session-start.js: payload on stdin, then EOF - exactly what Codex is documented to do. */
function runStart(payload: object, extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn("node", [`${HOOKS}/session-start.js`], {
      cwd: project, env: baseEnv(extraEnv), stdio: "pipe",
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("error", fail);
    child.on("close", code => done({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

/** capture-worker.js: payload as argv[2] JSON - the same call session-end.js's dispatchCapture makes. */
function runWorker(payload: object, extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn("node", [`${HOOKS}/capture-worker.js`, JSON.stringify(payload)], {
      cwd: project, env: baseEnv(extraEnv), stdio: "pipe",
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("error", fail);
    child.on("close", code => done({ code, stdout, stderr }));
  });
}

function replay(c: Captured): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost${c.url}`, {
      method: c.method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: c.method === "GET" || c.method === "HEAD" ? undefined : c.body,
    }),
    env, ctx,
  );
}

const startPayload = (source = "startup") => ({ session_id: "s1", cwd: project, hook_event_name: "SessionStart", source });
// Transcripts are only read from inside Codex's own sessions directory
// ($CODEX_HOME/sessions, default ~/.codex/sessions; HOME is `scratch` in these
// spawned hooks), resolved with realpath. Each test gets its own copy, laid out
// the way a real install lays them out.
function sessionsDir() {
  const d = join(scratch, ".codex", "sessions", "2026", "09", "27");
  mkdirSync(d, { recursive: true });
  return d;
}
function transcriptFor(sessionId: string) {
  const file = join(sessionsDir(), `rollout-${sessionId}.jsonl`);
  copyFileSync(FIXTURE, file);
  return file;
}
const workerPayload = (sessionId = "cx1") => ({ sessionId, cwd: project, transcriptPath: transcriptFor(sessionId), reason: "close" });

describe("session-start.js", () => {
  it("POST /recallで受理されるJSONを送り, and prints the exact hookSpecificOutput.additionalContext shape", async () => {
    const r = await runStart(startPayload());
    expect(r.code, r.stderr).toBe(0);

    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: expect.stringContaining("Context recalled"),
      },
    });
    expect(parsed.hookSpecificOutput.additionalContext).toContain("a remembered thing");
    expect(parsed.hookSpecificOutput.additionalContext.trimStart().startsWith("{")).toBe(false);

    const recalls = captured.filter(c => c.method === "POST" && c.url === "/recall");
    expect(recalls.length).toBeGreaterThanOrEqual(1);
    // The project arm 404s until the project's first capture registers it,
    // so seed one capture with the same project before replaying.
    const slug = JSON.parse(recalls[0].body).project;
    expect(slug).toBeTruthy();
    const seed = await worker.fetch(
      new Request("http://localhost/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: JSON.stringify({ content: "seed memory for the hook contract", project: slug }),
      }),
      env, ctx,
    );
    expect(seed.status).toBe(200);
    for (const c of recalls) {
      const res = await replay(c);
      expect(res.status, c.url).toBe(200);
    }
  });

  it("skips resume and fork, runs on compact", async () => {
    expect((await runStart(startPayload("resume"))).stdout).toBe("");
    expect((await runStart(startPayload("fork"))).stdout).toBe("");
    expect(captured).toHaveLength(0);
    expect((await runStart(startPayload("compact"))).stdout).toContain("Context recalled");
  });

  it("re-emits the cached block on compaction and makes no request at all", async () => {
    const first = await runStart(startPayload("startup"));
    expect(first.code, first.stderr).toBe(0);
    captured = [];
    const second = await runStart(startPayload("compact"));
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(captured).toHaveLength(0);
  });

  it("surfaces a rejected token: stderr line and exit 1 (the 401 path)", async () => {
    behaviour.recallStatus = 401;
    const r = await runStart(startPayload());
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^\[Second Brain\] recall failed: HTTP 401 unauthorized/);
  });

  it("reports a network error when the Worker is down", async () => {
    const r = await runStart(startPayload(), { SECOND_BRAIN_URL: "http://127.0.0.1:1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^\[Second Brain\] recall failed:/);
  });

  it("does nothing without credentials, and honours the opt-out", async () => {
    const r = await runStart(startPayload(), { SECOND_BRAIN_URL: "", SECOND_BRAIN_TOKEN: "" });
    expect(r.code).toBe(0); expect(r.stdout).toBe(""); expect(captured).toHaveLength(0);
    await runStart(startPayload(), { SECOND_BRAIN_HOOK_RECALL: "0" });
    expect(captured).toHaveLength(0);
  });
});

describe("capture-worker.js", () => {
  it("parses the fixture and makes one POST /capture with the exact header and redacted body", async () => {
    const r = await runWorker(workerPayload());
    expect(r.code, r.stderr).toBe(0);

    const captures = captured.filter(c => c.url === "/capture");
    expect(captures).toHaveLength(1);
    const body = JSON.parse(captures[0].body);
    expect(body).toMatchObject({ source: "codex-session", workspace: "personal", project: "brain-app", tags: ["brain-app"] });
    expect(body.content.startsWith(`Codex session in brain-app, ${new Date().toISOString().slice(0, 10)}`)).toBe(true);
    expect(body.content).toContain("User: The nightly digest cron is starving the sync job again");
    expect(body.content).toContain("User: OK, run it inside the existing hourly slot");
    expect(body.content).toContain("User: Ship it, and use this token for the deploy: Bearer [redacted]");
    for (const banned of ["do-not-capture-this", "private reasoning", "supersecrettoken456"]) {
      expect(body.content, banned).not.toContain(banned);
    }
    expect(body.content.length).toBeLessThanOrEqual(2000);

    const res = await replay(captures[0]);
    expect(res.status).toBe(200);
    expect((await res.json() as any).ok).toBe(true);
  });

  it("does not capture a second time for the same session id (the marker)", async () => {
    const first = await runWorker(workerPayload("same-session"));
    expect(first.code, first.stderr).toBe(0);
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(1);

    captured = [];
    const second = await runWorker(workerPayload("same-session"));
    expect(second.code, second.stderr).toBe(0);
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });

  it("captures again for a different session id", async () => {
    await runWorker(workerPayload("session-a"));
    captured = [];
    const r = await runWorker(workerPayload("session-b"));
    expect(r.code, r.stderr).toBe(0);
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(1);
  });

  it("surfaces a rejected token on the capture call: stderr line and exit 1 (the 401 path)", async () => {
    behaviour.captureStatus = 401;
    const r = await runWorker(workerPayload("cx-401"));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^\[Second Brain\] session capture failed: HTTP 401/);
  });

  it("spools instead of losing the capture when the Worker is down (network error)", async () => {
    // A budget audit's requirement: a transient failure (network, 5xx, 429)
    // is never lost silently. exit 0, not 1: the capture was handled
    // (spooled for retry), not dropped.
    const r = await runWorker(workerPayload("cx-down"), { SECOND_BRAIN_URL: "http://127.0.0.1:1" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Second Brain: could not save this session right now. Capture kept on this computer to retry.");
    expect(captured).toHaveLength(0);
  });

  it("does not capture against a Worker older than 3.0, and says so once", async () => {
    behaviour.healthVersion = "2.4.0";
    const first = await runWorker(workerPayload("cx-old"));
    expect(first.code).toBe(1);
    expect(first.stderr).toContain("needs Worker 3.0+");
    captured = [];
    const second = await runWorker(workerPayload("cx-old-2"));
    expect(second.code).toBe(0); // notice is once per 24h
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });

  it("does not capture a transcript with no substantial human text", async () => {
    const { writeFileSync } = await import("node:fs");
    const empty = join(sessionsDir(), "rollout-cx-empty.jsonl");
    writeFileSync(empty, [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } }),
    ].join("\n") + "\n");
    const r = await runWorker({ sessionId: "cx-empty", cwd: project, transcriptPath: empty, reason: "idle" });
    expect(r.code, r.stderr).toBe(0);
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });

  it("honours the Codex-specific opt-out without touching the global one", async () => {
    const r = await runWorker(workerPayload("cx-opt-out"), { SECOND_BRAIN_HOOK_CAPTURE_CODEX: "0" });
    expect(r.code, r.stderr).toBe(0);
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });

  it("dry run prints the body and sends nothing", async () => {
    const r = await runWorker(workerPayload("cx-dry"), { SECOND_BRAIN_DRY_RUN: "1" });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ source: "codex-session" });
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });
});

describe("kept captures are resent by the next session start", () => {
  const spooled = () => {
    const d = join(scratch, "cache", "second-brain", "capture-spool", "codex");
    return existsSync(d) ? readdirSync(d).filter(n => n.endsWith(".json")) : [];
  };

  it("a 429 keeps the capture, then session-start.js resends it after printing recall and clears it", async () => {
    behaviour.captureStatus = 429;
    behaviour.captureError = "daily_limit";
    const end = await runWorker(workerPayload("cx-kept"));
    expect(end.code, end.stderr).toBe(0);
    expect(end.stderr).toContain("Second Brain: daily database limit reached (resets 00:00 UTC). Capture kept on this computer to retry.");
    expect(spooled()).toHaveLength(1);

    behaviour = {};
    captured = [];
    const start = await runStart(startPayload());
    expect(start.code, start.stderr).toBe(0);
    expect(start.stdout).toContain("Context recalled");
    const order = captured.map(c => c.url.split("?")[0]);
    expect(order).toContain("/capture");
    expect(order.lastIndexOf("/recall")).toBeLessThan(order.indexOf("/capture")); // retry only after recall
    expect(JSON.parse(captured.find(c => c.url === "/capture")!.body)).toMatchObject({ source: "codex-session" });
    expect(spooled()).toHaveLength(0);
  });

  it("a transcript outside ~/.codex/sessions is never read", async () => {
    const outside = join(scratch, "rollout-cx-outside.jsonl");
    copyFileSync(FIXTURE, outside);
    const r = await runWorker({ sessionId: "cx-outside", cwd: project, transcriptPath: outside, reason: "close" });
    expect(r.code, r.stderr).toBe(0);
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });
});
