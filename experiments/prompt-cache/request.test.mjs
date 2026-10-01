import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResponsesRequest,
  promptCacheKey,
  requestDescriptor,
  syntheticCapsule,
  transportLabel,
  usageMetrics,
} from "./request.mjs";

const shared = {
  model: "gpt-5.6-luna",
  cacheKey: promptCacheKey({
    workspaceKey: "workspace-hash",
    profile: "agent-v1",
    experimentId: "experiment-1",
    arm: "explicit",
  }),
  coreText: "stable core",
  projectText: "stable project",
  userText: "changing suffix",
};

test("explicit requests place two breakpoints before the changing suffix", () => {
  const request = buildResponsesRequest({ ...shared, arm: "explicit" });
  assert.equal(request.store, false);
  assert.deepEqual(request.prompt_cache_options, { mode: "explicit", ttl: "30m" });
  assert.deepEqual(request.input[1].content[0].prompt_cache_breakpoint, { mode: "explicit" });
  assert.deepEqual(request.input[2].content[0].prompt_cache_breakpoint, { mode: "explicit" });
  assert.equal(request.input[3].content[0].prompt_cache_breakpoint, undefined);
  assert.equal(request.input[1].content[0].text, "stable core");
  assert.equal(request.input[2].content[0].text, "stable project");
  assert.equal(request.input[3].content[0].text, "changing suffix");
});

test("core-only requests keep the user suffix last and use one explicit breakpoint", () => {
  const request = buildResponsesRequest({ ...shared, projectText: null, arm: "explicit" });
  assert.deepEqual(request.input.map(item => item.role), ["developer", "developer", "user"]);
  assert.equal(request.input[1].content[0].text, "stable core");
  assert.equal(request.input[2].content[0].text, "changing suffix");
  assert.equal(requestDescriptor(request).explicit_breakpoints, 1);
  assert.equal(requestDescriptor(request).project_hash, null);
  assert.equal(requestDescriptor(request).project_chars, null);
});

test("implicit requests preserve the same order without explicit fields", () => {
  const request = buildResponsesRequest({ ...shared, arm: "implicit" });
  assert.equal(request.prompt_cache_options, undefined);
  assert.equal(JSON.stringify(request).includes("prompt_cache_breakpoint"), false);
  assert.deepEqual(request.input.map(item => item.role), ["developer", "developer", "developer", "user"]);
});

test("cache routing keys are deterministic, opaque, arm-separated, and within the API limit", () => {
  const a = promptCacheKey({ workspaceKey: "private workspace", profile: "agent-v1", experimentId: "e", arm: "explicit" });
  const b = promptCacheKey({ workspaceKey: "private workspace", profile: "agent-v1", experimentId: "e", arm: "explicit" });
  const control = promptCacheKey({ workspaceKey: "private workspace", profile: "agent-v1", experimentId: "e", arm: "implicit" });
  assert.equal(a, b);
  assert.notEqual(a, control);
  assert.ok(a.length <= 64);
  assert.equal(a.includes("private workspace"), false);
});

test("transport labels bind the exact scheme, port, and base path", () => {
  assert.equal(transportLabel("https://api.openai.com/v1"), "openai-official");
  assert.equal(transportLabel("https://API.OPENAI.COM:443/v1/"), "openai-official");
  assert.notEqual(transportLabel("http://api.openai.com/v1"), "openai-official");
  assert.notEqual(transportLabel("https://api.openai.com:8443/v1"), "openai-official");
  assert.notEqual(transportLabel("https://api.openai.com/compatible/v1"), "openai-official");

  const expected = transportLabel("https://proxy.example.test:8443/openai/v1");
  assert.match(expected, /^custom-[0-9a-f]{12}$/);
  assert.notEqual(expected, transportLabel("http://proxy.example.test:8443/openai/v1"));
  assert.notEqual(expected, transportLabel("https://proxy.example.test:8443/other/v1"));
  assert.notEqual(expected, transportLabel("https://proxy.example.test:9443/openai/v1"));
  assert.notEqual(expected, transportLabel("https://proxy.example.test:8443/openai//v1"));
});

test("transport labels reject ambiguous or secret-bearing URLs", () => {
  assert.throws(() => transportLabel("proxy.example.test/v1"), /absolute URL/);
  assert.throws(() => transportLabel("ftp://proxy.example.test/v1"), /http or https/);
  assert.throws(() => transportLabel("https://user:secret@proxy.example.test/v1"), /must not contain/);
  assert.throws(() => transportLabel("https://proxy.example.test/v1?target=other"), /must not contain/);
  assert.throws(() => transportLabel("https://proxy.example.test/v1#other"), /must not contain/);
});

test("request descriptors contain hashes and lengths, never prompt content", () => {
  const descriptor = requestDescriptor(buildResponsesRequest({ ...shared, arm: "explicit" }));
  const serialized = JSON.stringify(descriptor);
  assert.equal(descriptor.explicit_breakpoints, 2);
  assert.equal(descriptor.mode, "explicit");
  assert.equal(descriptor.core_chars, shared.coreText.length);
  assert.equal(descriptor.project_chars, shared.projectText.length);
  assert.equal(serialized.includes(shared.coreText), false);
  assert.equal(serialized.includes(shared.projectText), false);
  assert.equal(serialized.includes(shared.userText), false);
  assert.equal(serialized.includes(shared.cacheKey), false);
});

test("usage metrics expose cache reads and writes without model output", () => {
  assert.deepEqual(usageMetrics({
    usage: {
      input_tokens: 4000,
      input_tokens_details: { cache_write_tokens: 3000, cached_tokens: 2000 },
      output_tokens: 8,
      total_tokens: 4008,
    },
    output_text: "must not be copied",
  }, 123.7), {
    input_tokens: 4000,
    cache_write_tokens: 3000,
    cached_tokens: 2000,
    output_tokens: 8,
    total_tokens: 4008,
    cache_hit_ratio: 0.5,
    cache_write_ratio: 0.75,
    latency_ms: 124,
  });
});

test("synthetic capsules are stable and large enough for the direct transport experiment", () => {
  const a = syntheticCapsule("core", "fixture", 9000);
  const b = syntheticCapsule("core", "fixture", 9000);
  assert.equal(a, b);
  assert.ok(a.length >= 9000);
  assert.equal(JSON.parse(a).schema, "prompt-capsule.v1");
});

test("invalid request shapes fail before transport", () => {
  assert.throws(() => buildResponsesRequest({ ...shared, arm: "other" }), /arm must/);
  assert.throws(() => buildResponsesRequest({ ...shared, arm: "explicit", cacheKey: "x".repeat(65) }), /at most 64/);
  assert.throws(() => buildResponsesRequest({ ...shared, arm: "explicit", projectText: "" }), /projectText/);
  assert.throws(() => promptCacheKey({ workspaceKey: "", profile: "p", experimentId: "e", arm: "explicit" }), /workspaceKey/);
});

test("model names do not select reasoning or budgets; only explicit caller settings do", () => {
  const requests = ["gpt-6-astra", "gpt-5.6-luna", "future-model"].map(model => {
    const { model: _model, ...request } = buildResponsesRequest({ ...shared, model, arm: "explicit" });
    assert.equal(request.reasoning, undefined);
    return request;
  });
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[1], requests[2]);
  const explicit = buildResponsesRequest({ ...shared, arm: "explicit", effort: "low", maxOutputTokens: 256 });
  assert.deepEqual(explicit.reasoning, { effort: "low" });
  assert.equal(explicit.max_output_tokens, 256);
});
