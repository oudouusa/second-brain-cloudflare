import assert from "node:assert/strict";
import test from "node:test";
import { createCapsuleSession, CAPSULE_CONTEXT_POLICY } from "./capsule-session.mjs";
import { validateCapsulePayload, sha256 } from "./capsule-source.mjs";

function payload(kind = "core", content = "Use relevant evidence.", slot = "principles") {
  const sections = [{ slot, content }];
  const text = JSON.stringify({ schema: "prompt-capsule.v1", kind, sections }, null, 2);
  return {
    ok: true, schema: "prompt-capsule.v1", kind,
    ...(kind === "project" ? { project_id: "p-fixture" } : {}),
    workspace: "personal", team: null, text, prompt_hash: `sha256:${sha256(text)}`,
    sections: [{ slot, source_entry_id: "synthetic-entry" }],
    populated: true, complete: true, omitted_slots: [], invalid_entries: [], duplicate_slots: [],
    char_count: text.length, max_chars: 12_000,
  };
}
const source = (kind = "core", text, slot) => validateCapsulePayload(payload(kind, text, slot), { kind });
const options = { model: "opaque-model-id", scopeKey: "synthetic-principal-and-target", core: source() };
const result = api => api === "responses"
  ? { output: [{ type: "reasoning", encrypted_content: "opaque-synthetic-reasoning", summary: [] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }] }
  : { content: [{ type: "thinking", thinking: "", signature: "opaque-synthetic-signature" }, { type: "text", text: "OK" }] };
const history = request => request.input ?? request.messages;

for (const api of ["responses", "messages"]) {
  test(`${api}: updates append after immutable history and preserve opaque provider output`, () => {
    const session = createCapsuleSession({ ...options, api, requiredSlots: { core: ["principles"] } });
    const first = session.beginTurn({ scopeKey: options.scopeKey, userText: "First task" });
    const original = structuredClone(first);
    history(first)[0].content[0].text = "caller mutation";
    assert.deepEqual(session.retryRequest(), original);
    const response = result(api);
    session.completeTurn(response);
    const savedOutput = structuredClone(api === "responses" ? response.output : [{ role: "assistant", content: response.content }]);
    (response.output ?? response.content)[0].type = "caller mutation";
    const updated = source("core", "Prefer the newly confirmed result.", "principles");
    const second = session.beginTurn({ scopeKey: options.scopeKey, userText: "Current correction", core: updated });
    const prefix = [...history(original), ...savedOutput];
    assert.deepEqual(history(second).slice(0, prefix.length), prefix);
    assert.match(history(second).at(-2).content[0].text, /Prefer the newly confirmed result/);
    assert.equal(history(second).at(-1).content[0].text, "Current correction");
    session.completeTurn(result(api));
    const third = session.beginTurn({ scopeKey: options.scopeKey, userText: "Next task", core: { ...updated, etagHash: "metadata-only" } });
    const expected = history(second).length + savedOutput.length + 1;
    assert.equal(history(third).length, expected); // No duplicate update for unchanged text.
    const descriptor = JSON.stringify(session.descriptor());
    for (const secret of [options.scopeKey, options.core.text, updated.text, "opaque-synthetic"]) {
      assert.equal(descriptor.includes(secret), false);
    }
  });

  test(`${api}: tool-result continuation precedes a simultaneous capsule update`, () => {
    const session = createCapsuleSession({ ...options, api });
    session.beginTurn({ scopeKey: options.scopeKey, userText: "Inspect the project" });
    const call = api === "responses"
      ? { output: [{ type: "function_call", call_id: "call-1", name: "inspect", arguments: "{}" }] }
      : { content: [{ type: "tool_use", id: "call-1", name: "inspect", input: {} }] };
    session.completeTurn(call);
    const input = api === "responses"
      ? [{ type: "function_call_output", call_id: "call-1", output: "Confirmed" }]
      : [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "Confirmed" }] }];
    const request = session.beginTurn({ scopeKey: options.scopeKey, input, core: source("core", "Updated evidence", "principles") });
    assert.deepEqual(history(request).at(-2), input[0]);
    assert.match(history(request).at(-1).content[0].text, /Updated background snapshots/);
  });

  test(`${api}: changing only the model name leaves behavior and configuration unchanged`, () => {
    const requests = ["gpt-6-astra", "claude-fable-5-1", "future-unknown-model"].map(model => {
      const session = createCapsuleSession({ ...options, api, model });
      const { model: _model, ...request } = session.beginTurn({ scopeKey: options.scopeKey, userText: "Same task" });
      assert.equal(request.reasoning, undefined);
      assert.equal(request.output_config, undefined);
      return request;
    });
    assert.deepEqual(requests[0], requests[1]);
    assert.deepEqual(requests[1], requests[2]);
    assert.ok(JSON.stringify(requests[0]).includes(CAPSULE_CONTEXT_POLICY));
  });
}

test("required slots are consumer requirements, independent of complete=true", () => {
  const preferences = source("core", "Prefer concise replies.", "preferences");
  assert.equal(preferences.complete, true);
  assert.throws(() => createCapsuleSession({ ...options, core: preferences, requiredSlots: { core: ["constraints"] } }), /required_slot_missing/);
  const session = createCapsuleSession({ ...options, requiredSlots: { core: ["principles"] } });
  assert.throws(() => session.beginTurn({ scopeKey: options.scopeKey, core: preferences, userText: "Next" }), /required_slot_missing/);
  assert.equal(session.descriptor().closed, true);
});

test("scope changes invalidate in-flight work and removed slots require a fresh session", () => {
  const session = createCapsuleSession(options);
  session.beginTurn({ scopeKey: options.scopeKey, userText: "First" });
  assert.throws(() => session.beginTurn({ scopeKey: options.scopeKey, userText: "Concurrent" }), /turn_in_flight/);
  assert.throws(() => session.beginTurn({ scopeKey: "another-principal", userText: "Next" }), /scope_changed/);
  assert.throws(() => session.completeTurn(result("responses")), /session_closed/);
  assert.equal(session.descriptor().core_hash, null);
  const project = source("project", "Stable decision.", "decisions");
  const removal = createCapsuleSession({ ...options, project });
  assert.throws(() => removal.beginTurn({ scopeKey: options.scopeKey, project: null, userText: "Next" }), /removal_requires_restart/);
  assert.equal(removal.descriptor().closed, true);
});

test("budgets reject whole requests and failed preparation does not append a turn", () => {
  const session = createCapsuleSession({ ...options, maxRequestBytes: 2500 });
  assert.throws(() => session.beginTurn({ scopeKey: options.scopeKey, userText: "x".repeat(5000) }), /request_budget_exceeded/);
  assert.equal(session.descriptor().history_items, 1);
  assert.doesNotThrow(() => session.beginTurn({ scopeKey: options.scopeKey, userText: "Short" }));
  assert.throws(() => createCapsuleSession({ ...options, maxInputTokens: 100 }), /token_budget_requires_counter/);
  const tokenSession = createCapsuleSession({ ...options, maxInputTokens: 100, countTokens: () => 101 });
  assert.throws(() => tokenSession.beginTurn({ scopeKey: options.scopeKey, userText: "Short" }), /token_budget_exceeded/);
  assert.equal(tokenSession.descriptor().in_flight, false);
});

test("source integrity and slot order cannot be bypassed with a claimed complete flag", () => {
  assert.throws(() => createCapsuleSession({ ...options, core: { ...options.core, text: "tampered" } }), /invalid_capsule_source/);
  const text = JSON.stringify({ schema: "prompt-capsule.v1", kind: "core", sections: [{ slot: "principles", content: "A" }, { slot: "identity", content: "B" }] });
  const bad = { text, promptHash: `sha256:${sha256(text)}`, charCount: text.length, complete: true };
  assert.throws(() => createCapsuleSession({ ...options, core: bad }), /invalid_prompt_text/);
});

test("upstream empty and diagnostic-only incomplete payloads follow the public contract", () => {
  const empty = payload();
  empty.text = JSON.stringify({ schema: "prompt-capsule.v1", kind: "core", sections: [] });
  Object.assign(empty, { sections: [], complete: false, populated: false, char_count: empty.text.length, prompt_hash: `sha256:${sha256(empty.text)}` });
  assert.throws(() => validateCapsulePayload(empty, { kind: "core" }), /incomplete_capsule/);
  assert.equal(validateCapsulePayload(empty, { kind: "core", allowIncomplete: true }).complete, false);
  const shared = { ...payload(), workspace: "company", team: "synthetic-team", complete: false, invalid_entries: [{ entry_id: "bad", reason: "invalid-tags" }] };
  assert.throws(() => validateCapsulePayload(shared, { kind: "core" }), /incomplete_capsule/);
  assert.equal(validateCapsulePayload(shared, { kind: "core", allowIncomplete: true }).complete, false);
  assert.throws(() => validateCapsulePayload({ ...shared, complete: true }, { kind: "core" }), /invalid_payload/);
});
