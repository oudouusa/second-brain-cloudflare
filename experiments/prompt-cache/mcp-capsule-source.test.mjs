import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { CapsuleSourceError } from "./capsule-source.mjs";
import { parseMcpCapsuleToolResult } from "./mcp-capsule-source.mjs";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toolResult({ kind = "core", workspace = "personal", etagOverride, isError = false } = {}) {
  const text = JSON.stringify({
    schema: "prompt-capsule.v1",
    kind,
    sections: [{ slot: kind === "core" ? "principles" : "current-state", content: "Stable context" }],
  }, null, 2);
  const capsule = {
    ok: true,
    schema: "prompt-capsule.v1",
    kind,
    ...(kind === "project" ? { project_id: "p-123" } : {}),
    workspace,
    team: workspace === "personal" ? null : "ws-company",
    prompt_hash: `sha256:${sha256(text)}`,
    text,
    sections: [{ slot: kind === "core" ? "principles" : "current-state", source_entry_id: "mem-1" }],
    omitted_slots: [],
    complete: true,
    char_count: text.length,
    max_chars: 12000,
  };
  const bodyText = JSON.stringify(capsule, null, 2);
  const etag = etagOverride ?? `"pcv1-${sha256(`pcv1\0${bodyText}`)}"`;
  return {
    isError,
    content: [{ type: "text", text: JSON.stringify({
      ok: true,
      schema: "prompt-capsule-mcp.v1",
      etag,
      capsule,
    }, null, 2) }],
  };
}

test("MCP Capsule source verifies the envelope, payload hash and strong ETag", () => {
  const server = new URL("https://brain.example/mcp");
  const result = parseMcpCapsuleToolResult(toolResult(), server, {
    kind: "core",
    workspace: "personal",
  });
  assert.equal(result.source, "worker-mcp-oauth");
  assert.equal(result.text.includes("Stable context"), true);
  assert.match(result.endpointHash, /^[0-9a-f]{64}$/);
  assert.match(result.etagHash, /^[0-9a-f]{64}$/);
});

test("MCP Capsule source fails closed on tool errors and ETag drift", () => {
  const server = new URL("https://brain.example/mcp");
  assert.throws(
    () => parseMcpCapsuleToolResult(toolResult({ isError: true }), server, { kind: "core", workspace: "personal" }),
    error => error instanceof CapsuleSourceError && error.code === "mcp_tool_error",
  );
  assert.throws(
    () => parseMcpCapsuleToolResult(toolResult({ etagOverride: `"pcv1-${"a".repeat(64)}"` }), server, {
      kind: "core",
      workspace: "personal",
    }),
    error => error instanceof CapsuleSourceError && error.code === "etag_mismatch",
  );
});

test("MCP project target mismatches remain rejected by the shared Capsule validator", () => {
  assert.throws(
    () => parseMcpCapsuleToolResult(toolResult({ kind: "project" }), new URL("https://brain.example/mcp"), {
      kind: "project",
      projectId: "another-project",
      workspace: "personal",
    }),
    error => error instanceof CapsuleSourceError && error.code === "target_mismatch",
  );
});
