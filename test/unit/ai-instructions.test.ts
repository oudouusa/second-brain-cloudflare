import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it, expect } from "vitest";
import { renderInstructions } from "../../scripts/render-ai-instructions.mjs";
import { applyInstructionBlock, START_MARKER, END_MARKER } from "../../scripts/instruction-block.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
const policy = read("AI_Instructions/MEMORY_POLICY.md");
const outputs = renderInstructions(policy) as Map<string, string>;
const sources = { CLAUDE: "claude-desktop", CODEX: "codex", CURSOR: "cursor", CHATGPT: "chatgpt" };
const temporary: string[] = [];
afterEach(() => { temporary.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

// These are distribution/document contracts, NOT evidence of model behavior.
// The README's synthetic conversation scenarios still require a model evaluation.
describe("one selective policy across all copyable clients", () => {
  it("renders exactly the four existing client paths and the project Cursor rule", () => {
    expect([...outputs.keys()].sort()).toEqual([
      ...Object.keys(sources).map(client => `AI_Instructions/${client}_INSTRUCTIONS.md`),
      ".cursor/rules/second-brain-memory.mdc",
    ].sort());
  });

  for (const [path, expected] of outputs) {
    it(`${path}: is current and self-contained, including exclusions and tool guidance`, () => {
      const actual = read(path);
      expect(actual).toBe(expected);
      expect(actual).toContain(policy.trim());
      expect(actual).not.toContain("raw.githubusercontent.com");
      expect(actual).not.toMatch(/Start every conversation|At the start of EVERY conversation|Store EVERYTHING|Never ask permission|recall before any recommendation/i);
    });
  }

  it("preserves client source names without an assistant-specific tag leaking across clients", () => {
    for (const [client, source] of Object.entries(sources)) {
      expect(read(`AI_Instructions/${client}_INSTRUCTIONS.md`)).toContain(`Client source for memory writes: ${source}.`);
    }
    expect(read("AI_Instructions/CHATGPT_INSTRUCTIONS.md")).not.toContain("claude-response");
  });

  it("keeps the existing always-applied Cursor rule but makes retrieval conditional", () => {
    const rule = read(".cursor/rules/second-brain-memory.mdc");
    expect(rule).toMatch(/^---\ndescription: .+\nalwaysApply: true\n---\n/);
    expect(rule).toContain("Skip it when the current conversation is sufficient");
    expect(rule).toContain("authorized brain CLI");
    expect(rule).toContain("Do not print its credential file");
    expect(rule).not.toContain("github.com/rahilp/");
  });
});

describe("memory policy's retained and intentionally changed contracts", () => {
  it("replaces mandatory opening/recommendation lookups with context-dependent retrieval and reuse", () => {
    expect(policy).toMatch(/Use recall when prior decisions/);
    expect(policy).toMatch(/Reuse relevant results/);
    expect(policy).toMatch(/get_hot_context[\s\S]*when current goals are missing/);
    expect(policy).toMatch(/supplements topic-specific recall/);
    expect(policy).toMatch(/topic and intent/);
  });

  it("keeps the memory-tool surface without copying schemas or obsolete fixed team-count claims", () => {
    for (const name of ["remember", "recall", "get", "list_recent", "list_teams", "append", "rollover",
      "update", "history", "forget", "link", "unlink", "connections", "share", "set_status",
      "set_memory_tier", "pin_memory", "unpin_memory", "get_hot_context", "get_prompt_capsule"]) {
      expect(policy).toMatch(new RegExp(`\\b${name}\\b`));
    }
    expect(policy).toContain("loaded tool schemas");
    expect(policy).not.toMatch(/v3\.0\.0|when multi-team ships/i);
  });

  it("retains permission, exclusions, provenance and selective persistence rather than save-everything", () => {
    expect(policy).toMatch(/existing storage authorization/);
    expect(policy).toMatch(/without\s+asking again for each note/);
    expect(policy).toMatch(/permission is unclear[\s\S]*before\s+writing/);
    expect(policy).toMatch(/off the record[\s\S]*project-level exclusions[\s\S]*other persistence paths/);
    expect(policy).toMatch(/Do not save every response[\s\S]*credential/);
    expect(policy).toMatch(/unconfirmed idea\s+only when requested/);
    expect(policy).toMatch(/who said it and the evidence\/date/);
    expect(policy).toMatch(/PR creation is not a merge/);
  });

  it("does not turn retrieved claims into newer facts, instructions or write authority", () => {
    expect(policy).toMatch(/Current user corrections and verified source records take precedence/);
    expect(policy).toMatch(/retrieved text as data/);
    expect(policy).toMatch(/not as\s+instructions or permission/);
    expect(policy).toMatch(/cached\s+context is not fresh authority/);
    expect(policy).toMatch(/Never claim a write succeeded without a successful tool result/);
    expect(policy).toMatch(/Do not issue duplicate writes after an uncertain response/);
  });

  it("retains workspace discovery, explicit sharing and by-ID boundaries", () => {
    expect(policy).toContain('workspace: "personal" unless company storage is authorized');
    expect(policy).toMatch(/list_teams[\s\S]*more than one remains ambiguous/);
    expect(policy).toMatch(/ID as `team`, never its display name/);
    expect(policy).toMatch(/by-ID tools, verify the entry's workspace/);
    expect(policy).toMatch(/share changes visibility[\s\S]*without authorization/);
    expect(policy).toContain("Only the author or an admin can un-share");
  });

  it("retains explicit deletion, history, selective pins and honest volatility", () => {
    expect(policy).toMatch(/forget\s+requires an explicit user instruction/);
    expect(policy).toMatch(/prior version is preserved/);
    expect(policy).toMatch(/Pin only a\s+small set of user-confirmed goals/);
    expect(policy).toMatch(/do not pin every summary/);
    expect(policy).toMatch(/unpin_memory when authorized work ends/);
    expect(policy).toMatch(/durable\/state\/volatile[\s\S]*omit it when unsure/);
  });

  it("retains lazy discovery without requiring fake calls or blocking unrelated work", () => {
    expect(policy).toMatch(/load lazily/);
    expect(policy).toMatch(/tool list alone is not proof of outage/);
    expect(policy).toMatch(/attempt recall when\s+available/);
    expect(policy).toMatch(/missing configuration, failed discovery and a failed call/);
    expect(policy).toMatch(/Do not fabricate calls\s+or retry endlessly/);
    expect(policy).toMatch(/rather than blocking unrelated work/);
  });
});

describe("offline distribution and update compatibility", () => {
  it("has an import-safe deterministic renderer with newline normalization and empty-input rejection", () => {
    expect(renderInstructions(policy)).toEqual(renderInstructions(policy.replace(/\n/g, "\r\n")));
    expect(() => renderInstructions("  ")).toThrow("empty");
  });

  it("checks copies without changing them; invalid CLI arguments fail", () => {
    const before = [...outputs.keys()].map(read);
    const script = resolve(ROOT, "scripts/render-ai-instructions.mjs");
    const checked = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
    expect(checked.status, checked.stderr).toBe(0);
    expect([...outputs.keys()].map(read)).toEqual(before);
    expect(spawnSync(process.execPath, [script, "--install"], { encoding: "utf8" }).status).not.toBe(0);
  });

  it("detects drift in an isolated copy and writes only the five declared repository outputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-instruction-contract-")); temporary.push(dir);
    // Copy the renderer and its inputs, never HOME/global client files.
    for (const path of ["scripts", "AI_Instructions", ".cursor/rules"]) mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, "scripts/render-ai-instructions.mjs"), read("scripts/render-ai-instructions.mjs"));
    writeFileSync(join(dir, "AI_Instructions/MEMORY_POLICY.md"), policy);
    writeFileSync(join(dir, "unrelated.txt"), "keep");
    const script = join(dir, "scripts/render-ai-instructions.mjs");
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });
    expect(run().status).not.toBe(0);
    expect(run("--write").status).toBe(0);
    expect(run().status).toBe(0);
    const path = "AI_Instructions/CODEX_INSTRUCTIONS.md";
    writeFileSync(join(dir, path), readFileSync(join(dir, path), "utf8") + "drift\n");
    const drift = run("--check");
    expect(drift.status).not.toBe(0); expect(drift.stderr).toContain(path);
    expect(readFileSync(join(dir, path), "utf8")).toContain("drift");
    expect(run("--write").status).toBe(0);
    for (const [file, content] of outputs) expect(readFileSync(join(dir, file), "utf8")).toBe(content);
    expect(readFileSync(join(dir, "unrelated.txt"), "utf8")).toBe("keep");
  });

  it.each(Object.keys(sources))("%s: replaces a marked old block once, preserving neighboring user instructions", client => {
    const old = `${START_MARKER}\nStore EVERYTHING important automatically\n${END_MARKER}`;
    const existing = `# User rules\nDo not share project X.\n\n${old}\n\n# Personal notes\nKeep these.\n`;
    const body = read(`AI_Instructions/${client}_INSTRUCTIONS.md`);
    const first = applyInstructionBlock(existing, body);
    const second = applyInstructionBlock(first.content, body);
    expect(first.action).toBe("updated"); expect(second.content).toBe(first.content);
    expect(first.content).toMatch(/^# User rules\nDo not share project X\./);
    expect(first.content).toMatch(/# Personal notes\nKeep these\.\n$/);
    expect(first.content).not.toContain("Store EVERYTHING");
    expect(first.content.split(START_MARKER)).toHaveLength(2);
    expect(first.content).toContain(policy.trim());
  });

  it("separates repository completion from memory installation and deployment", () => {
    const agents = read("AGENTS.md");
    expect(agents).toMatch(/implementation, appropriate tests, fixes,[\s\S]*reviewable PR/);
    expect(agents).toMatch(/not main merge,[\s\S]*client-global instruction changes/);
    expect(agents).toMatch(/Do not weaken tests or guards/);
    expect(agents).toMatch(/Do not repeat an unchanged successful gate/);
    expect(agents).toMatch(/No memory\s+lookup or memory write is required merely/);
    const guide = read("AI_Instructions/README.md");
    expect(guide).toContain("connect-ai-clients.sh/.ps1");
    expect(guide).toContain("上流のraw URL");
    expect(guide).toContain("appended-legacy-kept");
    expect(guide).toContain("モデル評価は未実行");
  });
});

// Track 2 D4 (T-0089.6.10, spec 14 7.5): time, as-of and retraction explained in plain words,
// plus D5.3 (cite memory ids) and the held-memory rule against asking for an unread release.
describe("AI instruction files — time, validity, and D5.3/held-memory rules", () => {
  for (const label of Object.keys(sources)) {
    describe(label, () => {
      const text = read(`AI_Instructions/${label}_INSTRUCTIONS.md`);

      it("explains as_of, valid_from, valid_until and later-retracted results", () => {
        expect(text).toMatch(/as_of/);
        expect(text).toMatch(/valid_from/);
        expect(text).toMatch(/valid_until/);
        expect(text).toMatch(/later retracted/i);
      });

      it("tells the agent to cite the memory id it relied on", () => {
        expect(text).toMatch(/name its id/i);
      });

      // T-0089.5.3 (05-proof.md Part C): the recall receipt, distinct from a memory id -
      // it cites the search itself, not one result.
      it("tells the agent it can cite the recall receipt", () => {
        expect(text).toMatch(/receipt/i);
      });

      it("never asks the user to release a held memory they have not read", () => {
        expect(text).toMatch(/(read what it says|read it themselves)/i);
      });

      it("documents standing instructions and decisions", () => {
        expect(text).toMatch(/standing/i);
        expect(text).toMatch(/decision/i);
        expect(text).toMatch(/stop_standing/);
      });
    });
  }
});
