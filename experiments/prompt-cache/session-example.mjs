#!/usr/bin/env node
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { createCapsuleSession } from "./capsule-session.mjs";
import { sha256 } from "./capsule-source.mjs";

// Executable, synthetic two-turn integration example. No network or credentials.
function capsule(kind, slot, content) {
  const text = JSON.stringify({ schema: "prompt-capsule.v1", kind, sections: [{ slot, content }] }, null, 2);
  return { text, promptHash: `sha256:${sha256(text)}`, charCount: text.length, complete: true };
}

try {
  const { values } = parseArgs({ options: {
    api: { type: "string", default: "responses" },
    model: { type: "string", default: "configured-model" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    process.stdout.write("Usage: node experiments/prompt-cache/session-example.mjs [--api responses|messages] [--model ID]\n"
      + "Runs a synthetic two-turn capsule update. No model or memory-service requests are sent.\n");
  } else {
    const scopeKey = "synthetic-owner-and-source";
    const session = createCapsuleSession({
      api: values.api, model: values.model, scopeKey,
      core: capsule("core", "constraints", "Use the current user's authorized scope."),
      project: capsule("project", "current-state", "The change is under review."),
      requiredSlots: { core: ["constraints"] },
    });
    const first = session.beginTurn({ scopeKey, userText: "Explain the pending change." });
    const firstHistory = first.input ?? first.messages;
    const mockOutput = values.api === "responses"
      ? { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Review is pending." }] }] }
      : { content: [{ type: "thinking", thinking: "", signature: "synthetic-opaque-signature" },
        { type: "text", text: "Review is pending." }] };
    session.completeTurn(mockOutput);
    const second = session.beginTurn({
      scopeKey, userText: "Use the updated review outcome.",
      project: capsule("project", "current-state", "The review has completed."),
    });
    const secondHistory = second.input ?? second.messages;
    assert.deepEqual(secondHistory.slice(0, firstHistory.length), firstHistory);
    assert.match(secondHistory.at(-2).content[0].text, /The review has completed/);
    session.completeTurn(mockOutput);
    process.stdout.write(JSON.stringify({
      evidence_kind: "synthetic-consumer-contract", external_requests: 0,
      prefix_preserved: true, update_appended: true, cache_hit_measured: false,
      ...session.descriptor(),
    }) + "\n");
    session.close();
  }
} catch (error) {
  process.stderr.write(`Session example failed: ${error.code ?? error.name}\n`);
  process.exitCode = 1;
}
