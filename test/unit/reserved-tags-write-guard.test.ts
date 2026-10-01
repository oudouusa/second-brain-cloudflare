/**
 * Codex cross-vendor review, MAJOR (T-0102): callers could still write the
 * tag namespaces this contract reserved -- REST and MCP `remember` and
 * `update` accepted a caller-supplied `quarantine:` (and the other new
 * namespaces) straight through, and a forged tag then survived a later
 * replacement, because it had already become worker-owned.
 *
 * The fix is one guard, stripNewReservedTags (src/tags/system.ts), called
 * from the two domain chokepoints every caller write path already funnels
 * through: normalizeCaptureInput (create) and applyTagReplacement (replace).
 * This file proves the class is closed end to end -- through the real
 * captureEntry/updateEntryContent write paths, not just the pure helpers --
 * and structurally guards that every caller of those two chokepoints keeps
 * computing the same guard for its reply, so a new call site cannot silently
 * skip it.
 *
 * append is deliberately NOT covered here: neither the MCP `append` tool nor
 * POST /append accepts a caller `tags` field at all -- both read `tags` from
 * the row's own already-stored tags (server.ts, routes/capture.ts), so there
 * is nothing for a caller to forge on that path. Mirror integrations
 * (integrations/{email,notion,calendar}.ts) call MirrorStore.createEntry
 * with a fixed literal tags array (the provider id), never external content,
 * so they are not a vector either -- both are asserted structurally below.
 *
 * Codex recheck (T-0089.4.2): import (entries/import.ts's parseTags) was left out of the class
 * above on the theory that it is a person restoring their own export, not an inbound caller-tag
 * surface. A forged `quarantine:*`/`edited-canonical:*`/Track 7 tag on an imported row proved
 * that theory wrong -- it let an import hide a memory, or forge a trust label, exactly like a
 * caller could through capture or replace. parseTags now runs the same stripNewReservedTags
 * guard, so import is no longer exempt.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { captureEntry } from "../../src/capture/entry";
import { updateEntryContent } from "../../src/capture/store";
import { importExportPayload } from "../../src/entries/import";
import { OWNER_WRITE_CONTEXT } from "../../src/lib/scope";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";
import { QUARANTINE_TAG_PREFIX, EDITED_CANONICAL_TAG_PREFIX } from "../../src/quarantine/tags";
import { COUNTERPARTY_TAG_PREFIX, OWED_TO_ME_TAG, STANDING_TAG } from "../../src/tags/t7";

const ROOT = resolve(import.meta.dirname, "../..");

function makeCtx(): ExecutionContext {
  return { waitUntil: () => {} } as unknown as ExecutionContext;
}

const FORGED_TAGS = [
  `${QUARANTINE_TAG_PREFIX}instruction`,
  `${EDITED_CANONICAL_TAG_PREFIX}2026-09-27`,
  STANDING_TAG,
  `${COUNTERPARTY_TAG_PREFIX}attacker`,
  OWED_TO_ME_TAG,
];

describe("a caller cannot forge a reserved tag through captureEntry (create)", () => {
  it("drops every forged tag, keeps an ordinary one", async () => {
    const db = makeTestDb();
    const env = makeTestEnv(db);
    const ctx = makeCtx();
    const result = await captureEntry("A note", [...FORGED_TAGS, "work"], "api", env, ctx);
    expect(result.status).toBe("stored");
    const stored = JSON.parse(db.entries[0].tags);
    expect(stored).toEqual(["work"]);
  });

  it("stores nothing but the reserved tags stripped when that is all the caller sent", async () => {
    const db = makeTestDb();
    const env = makeTestEnv(db);
    const ctx = makeCtx();
    await captureEntry("Another note", FORGED_TAGS, "api", env, ctx);
    const stored = JSON.parse(db.entries[0].tags);
    for (const forged of FORGED_TAGS) expect(stored).not.toContain(forged);
  });
});

describe("a caller cannot forge a reserved tag through updateEntryContent (replace), and cannot lock one in later", () => {
  it("drops every forged tag from a replacement", async () => {
    const db = makeTestDb();
    const env = makeTestEnv(db);
    const ctx = makeCtx();
    const created = await captureEntry("Original", ["work"], "api", env, ctx);
    if (created.status !== "stored") throw new Error("setup failed");

    const result = await updateEntryContent(env, created.id, "Updated content", undefined, undefined, [...FORGED_TAGS, "new-topic"], OWNER_WRITE_CONTEXT, { actorId: "", channel: "rest" }, "");
    expect(result.status).toBe("updated");
    const row = db.entries.find(e => e.id === created.id)!;
    const stored = JSON.parse(row.tags);
    expect(stored).toContain("new-topic");
    for (const forged of FORGED_TAGS) expect(stored).not.toContain(forged);
  });

  it("a create-time forgery attempt cannot be locked in by a later edit either", async () => {
    const db = makeTestDb();
    const env = makeTestEnv(db);
    const ctx = makeCtx();
    // The create already stripped this (see the suite above); this proves the
    // row never carries it to begin with, so there is nothing left to "keep"
    // through a later replacement -- unlike a genuinely system-set one, which
    // applyTagReplacement's isWorkerOwnedTag path is supposed to preserve.
    const created = await captureEntry("Original", [`${QUARANTINE_TAG_PREFIX}instruction`], "api", env, ctx);
    if (created.status !== "stored") throw new Error("setup failed");
    expect(JSON.parse(db.entries[0].tags)).not.toContain(`${QUARANTINE_TAG_PREFIX}instruction`);

    await updateEntryContent(env, created.id, "Edited", undefined, undefined, ["work"], OWNER_WRITE_CONTEXT, { actorId: "", channel: "rest" }, "");
    const row = db.entries.find(e => e.id === created.id)!;
    expect(JSON.parse(row.tags)).toEqual(["work"]);
  });
});

describe("a caller cannot forge a reserved tag through import either", () => {
  it("drops every forged tag from an imported row, keeps an ordinary one", async () => {
    const db = makeTestDb();
    const env = makeTestEnv(db);
    const summary = await importExportPayload(env, {
      entries: [{ id: "imported-1", content: "A note", tags: [...FORGED_TAGS, "work"] }],
    }, { writeCtx: OWNER_WRITE_CONTEXT });
    expect(summary.imported).toBe(1);
    const stored = JSON.parse(db.entries[0].tags);
    expect(stored).toContain("work");
    for (const forged of FORGED_TAGS) expect(stored).not.toContain(forged);
  });
});

describe("append never receives a caller-supplied tag, so it needs no strip", () => {
  it("the MCP append tool schema has no tags parameter", () => {
    const source = readFileSync(resolve(ROOT, "src/mcp/server.ts"), "utf8");
    const appendBlock = source.slice(source.indexOf('"append"'), source.indexOf('"update"'));
    expect(appendBlock).not.toMatch(/tags:\s*z\./);
    // It reads tags from the row it already has, never from the request.
    expect(appendBlock).toContain('const tags: string[] = JSON.parse(row.tags as string)');
  });

  it("POST /append's body type carries no tags field", () => {
    const source = readFileSync(resolve(ROOT, "src/routes/capture.ts"), "utf8");
    const appendBlock = source.slice(source.indexOf('"/append"'), source.indexOf('"/update"'));
    expect(appendBlock).not.toMatch(/body\.tags/);
    expect(appendBlock).toContain('const tags: string[] = JSON.parse(row.tags as string)');
  });
});

describe("mirror integrations pass only a fixed literal tags array, never external content", () => {
  it("every MirrorStore.createEntry call site passes an inline array literal", () => {
    const integrationsDir = resolve(ROOT, "src/integrations");
    const files = readdirSync(integrationsDir).filter(f => f.endsWith(".ts"));
    let callSites = 0;
    for (const file of files) {
      const source = readFileSync(join(integrationsDir, file), "utf8");
      const calls = [...source.matchAll(/\.createEntry\(\s*content,\s*(\[[^\]]*\]),/g)];
      callSites += calls.length;
      for (const call of calls) {
        // A bare identifier here (no "[" ... "]") would mean a variable, and a
        // variable could carry attacker-controlled text; a literal cannot.
        expect(call[1].startsWith("["), `${file}: ${call[0]}`).toBe(true);
      }
    }
    expect(callSites).toBeGreaterThan(0);
  });
});

describe("every caller of the two chokepoints computes the same guard for its reply", () => {
  // A structural check, not a behavioral one: greps every call site of
  // captureEntry/updateEntryContent outside their own definitions and tests,
  // and requires a stripNewReservedTags call in the same function body (the
  // guard used to build the "not saved" reply). Catches a FUTURE write path
  // that starts calling either chokepoint without wiring the message -- the
  // strip itself cannot be skipped (it lives inside the chokepoints), but the
  // caller-facing note silently going missing on a new surface would be its
  // own regression.
  const CALLER_FILES = ["src/mcp/server.ts", "src/routes/capture.ts"];

  it("every remember/capture and update call site also calls stripNewReservedTags", () => {
    for (const file of CALLER_FILES) {
      const source = readFileSync(resolve(ROOT, file), "utf8");
      const captureCalls = (source.match(/\bcaptureEntry\(/g) ?? []).length;
      const updateCalls = (source.match(/\bupdateEntryContent\(/g) ?? []).length;
      const guardCalls = (source.match(/\bstripNewReservedTags\(/g) ?? []).length;
      expect(guardCalls, file).toBeGreaterThanOrEqual(Math.min(captureCalls, 1) + Math.min(updateCalls, 1));
    }
  });
});
