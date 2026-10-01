/**
 * The Claude Code hooks, run as processes with the stdin Claude Code actually
 * sends, against a stub that records requests — then each request is replayed
 * through the real Worker. A parameter rename on either side fails here.
 *
 * The previous version fed session-end `{messages:[…]}` on stdin. Claude Code
 * has never sent that; it sends hook metadata with a transcript_path. The test
 * passed and the hook never captured a session.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
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

const HOOKS = resolve(import.meta.dirname, "../../integrations/claude-code-hooks");
const FIXTURE = join(HOOKS, "fixtures/sample-transcript.jsonl");
const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;

interface Captured { method: string; url: string; body: string }
interface StubBehaviour { healthVersion?: string; recallStatus?: number; recallResults?: unknown[]; briefStatus?: number; briefDelayMs?: number; delayMs?: number; recallDelayMs?: number; unknownProject?: boolean; badProject?: boolean }

let server: Server;
let origin = "";
let captured: Captured[] = [];
let behaviour: StubBehaviour = {};
let recallReplied = false;
let briefBeforeRecallReply = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      captured.push({ method: req.method ?? "", url: req.url ?? "", body });
      if (req.url?.startsWith("/brief")) briefBeforeRecallReply = !recallReplied;
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const send = () => {
        if (req.url?.startsWith("/health")) return reply(200, { ok: true, version: behaviour.healthVersion ?? "3.0.0" });
        if (req.url?.startsWith("/recall")) {
          recallReplied = true;
          if (behaviour.recallStatus && behaviour.recallStatus >= 400) return reply(behaviour.recallStatus, { ok: false, code: "unauthorized" });
          if (behaviour.unknownProject && JSON.parse(body || "{}").project)
            return reply(404, { ok: false, error: 'unknown project "x"', known_projects: [] });
          if (behaviour.badProject && JSON.parse(body || "{}").project)
            return reply(400, { ok: false, code: "invalid_project" });
          return reply(200, { ok: true, results: behaviour.recallResults ?? [{ id: "m1", content: "a remembered thing", truncated: false }], insight: null });
        }
        if (req.url?.startsWith("/brief")) {
          if (behaviour.unknownProject && req.url.includes("project="))
            return reply(404, { ok: false, error: 'unknown project "x"', known_projects: [] });
          if (behaviour.briefStatus) return reply(behaviour.briefStatus, { ok: false });
          return reply(200, { ok: true, attention: { due: 2 }, loops: { open: 1, items: [{ id: "task-1", content: "Send invoice" }] } });
        }
        return reply(200, { ok: true, id: "new-id" });
      };
      const delay = req.url?.startsWith("/recall") ? behaviour.recallDelayMs ?? behaviour.delayMs
        : req.url?.startsWith("/brief") ? behaviour.briefDelayMs ?? behaviour.delayMs : behaviour.delayMs;
      delay ? setTimeout(send, delay) : send();
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
// HOME is redirected to `scratch` for isolation, so the hook's cwd must be a
// directory BELOW it: parseProjectName deliberately reports no project for
// $HOME itself, and Claude Code always runs with cwd set to a project.
let project: string;

beforeEach(async () => {
  captured = [];
  behaviour = {};
  recallReplied = false;
  briefBeforeRecallReply = false;
  scratch = mkdtempSync(join(tmpdir(), "sb-hooks-"));
  project = join(scratch, "brain-app");
  mkdirSync(project);
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  await sqlite.db.prepare("INSERT INTO projects (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)").bind("brain-app", roots.ownerPersonalWorkspaceId, "Brain App", 1).run();
});
afterEach(() => sqlite?.close());

/** Spawn a hook exactly as Claude Code does: payload on stdin, then EOF. Isolated HOME and cache. */
function runHook(script: string, payload: object, extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn("node", [`${HOOKS}/${script}`], {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        HOME: scratch, XDG_CACHE_HOME: join(scratch, "cache"),
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

const startPayload = (source = "startup") => ({ session_id: "s1", transcript_path: FIXTURE, cwd: project, hook_event_name: "SessionStart", source });
const endPayload = (transcript_path: string, reason = "prompt_input_exit") => ({ session_id: "fx", transcript_path, cwd: project, hook_event_name: "SessionEnd", reason });

describe("session-start.js", () => {
  it("makes a private POST /recall the Worker accepts, and prints framed context", async () => {
    const r = await runHook("session-start.js", startPayload());
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith("[Second Brain] Context recalled")).toBe(true);
    expect(r.stdout).not.toContain("Bearer");
    expect(r.stdout.trimStart().startsWith("{")).toBe(false);

    const recalls = captured.filter(c => c.url === "/recall");
    expect(recalls.length).toBeGreaterThanOrEqual(1);
    expect(recalls[0].method).toBe("POST");
    const requestBody = JSON.parse(recalls[0].body);
    expect(requestBody.query).toBeTruthy();
    expect(requestBody.workspace).toBe("personal");
    const briefs = captured.filter(c => c.url.startsWith("/brief?"));
    expect(briefs).toHaveLength(1);
    expect(new URL(`http://x${briefs[0].url}`).searchParams.get("project")).toBeTruthy();
    // preview keeps the hook from advancing the dashboard's resurface rotation
    expect(new URL(`http://x${briefs[0].url}`).searchParams.get("preview")).toBe("1");
    expect(r.stdout).toContain("Due: 2");
    expect(r.stdout).toContain("Open commitments: 1");
    // The project arm 404s until the project's first capture registers it,
    // so seed one capture with the same project before replaying.
    const slug = requestBody.project;
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
      expect((await res.json() as any).ok).toBe(true);
    }
    for (const c of briefs) {
      const res = await replay(c);
      expect(res.status, c.url).toBe(200);
    }
  });

  it("starts the brief request before recall finishes", async () => {
    behaviour.recallDelayMs = 200;
    const r = await runHook("session-start.js", startPayload());
    expect(r.code).toBe(0);
    expect(briefBeforeRecallReply).toBe(true);
  });

  it("falls back from the project arm to free text when the project arm is empty", async () => {
    behaviour.recallResults = [];
    await runHook("session-start.js", startPayload());
    const recalls = captured.filter(c => c.url === "/recall");
    expect(recalls).toHaveLength(2);
    expect(JSON.parse(recalls[0].body).project).toBeTruthy();
    expect(JSON.parse(recalls[1].body).project).toBeUndefined();
  });

  it("asks for the lean brief in the same workspace as recall", async () => {
    await runHook("session-start.js", startPayload());
    const brief = new URL(`http://x${captured.find(c => c.url.startsWith("/brief?"))!.url}`).searchParams;
    expect(brief.get("lean")).toBe("1");
    expect(brief.get("workspace")).toBe("personal");
  });

  it("falls back to an unscoped brief when the project is not registered, as recall does", async () => {
    behaviour.unknownProject = true;
    const r = await runHook("session-start.js", startPayload());
    const briefs = captured.filter(c => c.url.startsWith("/brief?")).map(c => new URL(`http://x${c.url}`).searchParams);
    expect(briefs).toHaveLength(2);
    expect(briefs[0].get("project")).toBeTruthy();
    expect(briefs[1].get("project")).toBeNull();
    expect(briefs[1].get("workspace")).toBe("personal");
    expect(r.stdout).toContain("Due: 2");
  });

  it("does not wait long for a slow brief once recall is done", async () => {
    behaviour.briefDelayMs = 8000;
    const started = Date.now();
    const r = await runHook("session-start.js", startPayload());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("a remembered thing");
    expect(r.stdout).not.toContain("Due:");
    expect(Date.now() - started).toBeLessThan(5500);
  }, 15000);

  it("prints recall when the brief request fails", async () => {
    behaviour.briefStatus = 500;
    const r = await runHook("session-start.js", startPayload());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("a remembered thing");
    expect(r.stdout).not.toContain("Due:");
    expect(captured.filter(c => c.url.startsWith("/brief?"))).toHaveLength(1);
  });

  it("falls back to free text when the project is not registered (404)", async () => {
    behaviour.unknownProject = true;
    const r = await runHook("session-start.js", startPayload());
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith("[Second Brain] Context recalled")).toBe(true);
    const recalls = captured.filter(c => c.url === "/recall");
    expect(recalls).toHaveLength(2);
    expect(JSON.parse(recalls[0].body).project).toBeTruthy();
    expect(JSON.parse(recalls[1].body).project).toBeUndefined();
  });

  it("falls back to free text when the Worker rejects the project slug (400)", async () => {
    behaviour.badProject = true;
    const r = await runHook("session-start.js", startPayload());
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith("[Second Brain] Context recalled")).toBe(true);
    const recalls = captured.filter(c => c.url === "/recall");
    expect(recalls).toHaveLength(2);
    expect(JSON.parse(recalls[1].body).project).toBeUndefined();
  });

  it("still fails loudly on other project-arm errors (500)", async () => {
    behaviour.recallStatus = 500;
    const r = await runHook("session-start.js", startPayload());
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/recall failed: HTTP 500/);
    expect(captured.filter(c => c.url === "/recall")).toHaveLength(1);
  });

  it("surfaces a rejected token: stderr line and exit 1 (the #327 failure mode, made visible)", async () => {
    behaviour.recallStatus = 401;
    const r = await runHook("session-start.js", startPayload());
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^\[Second Brain\] recall failed: HTTP 401 unauthorized/);
  });

  it("skips resume and fork, runs on compact", async () => {
    expect((await runHook("session-start.js", startPayload("resume"))).stdout).toBe("");
    expect((await runHook("session-start.js", startPayload("fork"))).stdout).toBe("");
    expect(captured).toHaveLength(0);
    expect((await runHook("session-start.js", startPayload("compact"))).stdout).toContain("Context recalled");
  });

  it("re-emits the cached block on compaction and makes no request at all", async () => {
    // The session id survives compaction, so the block printed at startup is
    // still this session's context — printing it again costs nothing.
    const first = await runHook("session-start.js", startPayload("startup"));
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("Context recalled");
    expect(captured.filter(c => c.url === "/recall").length).toBeGreaterThanOrEqual(1);

    captured = [];
    const second = await runHook("session-start.js", startPayload("compact"));
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(captured).toHaveLength(0);
  });

  it("falls back to a live recall when compaction finds no cached block", async () => {
    const r = await runHook("session-start.js", { ...startPayload("compact"), session_id: "never-seen-before" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Context recalled");
    expect(captured.filter(c => c.url === "/recall").length).toBeGreaterThanOrEqual(1);
  });

  it("does nothing without credentials, and honours the opt-out", async () => {
    const r = await runHook("session-start.js", startPayload(), { SECOND_BRAIN_URL: "", SECOND_BRAIN_TOKEN: "" });
    expect(r.code).toBe(0); expect(r.stdout).toBe(""); expect(captured).toHaveLength(0);
    await runHook("session-start.js", startPayload(), { SECOND_BRAIN_HOOK_RECALL: "0" });
    expect(captured).toHaveLength(0);
  });
});

describe("session-end.js", () => {
  it("reads transcript_path and makes one POST /capture the Worker accepts", async () => {
    const transcript = join(scratch, "fx.jsonl");
    copyFileSync(FIXTURE, transcript);
    const r = await runHook("session-end.js", endPayload(transcript));
    expect(r.code, r.stderr).toBe(0);

    const captures = captured.filter(c => c.url === "/capture");
    expect(captures).toHaveLength(1);
    const body = JSON.parse(captures[0].body);
    expect(body).toMatchObject({ source: "claude-code", workspace: "personal" });
    expect(body.content).toContain("nightly digest");
    expect(body.content).toContain("Final: budget-capped digest merged");
    for (const banned of ["SECRET_TOKEN", "private reasoning", "sidechain", "<system-reminder>", "<task-notification>"]) {
      expect(body.content, banned).not.toContain(banned);
    }
    expect(body.content.length).toBeLessThanOrEqual(2000);

    const res = await replay(captures[0]);
    expect(res.status).toBe(200);
    expect((await res.json() as any).ok).toBe(true);
  });

  it("does not capture a transcript with no human text", async () => {
    const transcript = join(scratch, "tools.jsonl");
    writeFileSync(transcript, [
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(500) }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
    ].join("\n") + "\n");
    const r = await runHook("session-end.js", endPayload(transcript));
    expect(r.code).toBe(0);
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });

  it("does not capture against a Worker older than 3.0, and says so once", async () => {
    behaviour.healthVersion = "2.4.0";
    const transcript = join(scratch, "fx.jsonl"); copyFileSync(FIXTURE, transcript);
    const first = await runHook("session-end.js", endPayload(transcript));
    expect(first.code).toBe(1);
    expect(first.stderr).toContain("needs Worker 3.0+");
    const second = await runHook("session-end.js", endPayload(transcript));
    expect(second.code).toBe(0);           // notice is once per 24 h
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });

  it("ignores the legacy stdin shape instead of guessing", async () => {
    const r = await runHook("session-end.js", { messages: [{ role: "user", content: "x".repeat(300) }] });
    expect(r.code).toBe(0);
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });

  it("reports a failed capture: stderr line and exit 1", async () => {
    const transcript = join(scratch, "fx.jsonl"); copyFileSync(FIXTURE, transcript);
    // Point at a closed port so the POST fails at the network layer.
    const r = await runHook("session-end.js", endPayload(transcript), { SECOND_BRAIN_URL: "http://127.0.0.1:1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^\[Second Brain\] session capture failed:/);
  });

  it("still exits within its own timeout when the Worker is slow", async () => {
    behaviour.delayMs = 1500;
    const transcript = join(scratch, "fx.jsonl"); copyFileSync(FIXTURE, transcript);
    const t0 = Date.now();
    const r = await runHook("session-end.js", endPayload(transcript));
    expect(r.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(20000);
  }, 30000);

  it("dry run prints the body and sends nothing", async () => {
    const transcript = join(scratch, "fx.jsonl"); copyFileSync(FIXTURE, transcript);
    const r = await runHook("session-end.js", endPayload(transcript), { SECOND_BRAIN_DRY_RUN: "1" });
    expect(JSON.parse(r.stdout)).toMatchObject({ source: "claude-code" });
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });
});
