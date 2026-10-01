import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CapsuleSourceError,
  PROMPT_CAPSULE_MIME,
  capsuleEndpoint,
  fetchPromptCapsule,
  readCapsuleFile,
  sha256,
  validateCapsulePayload,
} from "./capsule-source.mjs";

function promptText(kind, content = "stable content") {
  return JSON.stringify({
    schema: "prompt-capsule.v1",
    kind,
    sections: [{ slot: kind === "core" ? "principles" : "current-state", content }],
  }, null, 2);
}

function responsePayload(kind, options = {}) {
  const text = promptText(kind, options.content);
  return {
    ok: true,
    schema: "prompt-capsule.v1",
    kind,
    ...(kind === "project" ? { project_id: options.projectId ?? "p-7f3a" } : {}),
    workspace: options.workspace ?? "personal",
    team: options.team ?? null,
    prompt_hash: `sha256:${sha256(text)}`,
    text,
    sections: [],
    omitted_slots: options.complete === false ? ["principles"] : [],
    complete: options.complete ?? true,
    char_count: text.length,
    max_chars: 12_000,
  };
}

test("capsule endpoints keep tokens out of URLs and encode only bounded targets", () => {
  const core = capsuleEndpoint({
    workerUrl: "https://brain.example/base/",
    kind: "core",
    workspace: "personal",
  });
  assert.equal(core.toString(), "https://brain.example/base/prompt-capsules/core?workspace=personal");
  assert.equal(core.username, "");
  assert.equal(core.password, "");

  const project = capsuleEndpoint({
    workerUrl: "https://brain.example",
    kind: "project",
    projectId: "p-7f3a",
    workspace: "company",
    team: "ws-123",
  });
  assert.equal(project.pathname, "/prompt-capsules/projects/p-7f3a");
  assert.equal(project.searchParams.get("workspace"), "company");
  assert.equal(project.searchParams.get("team"), "ws-123");

  const access = capsuleEndpoint({
    workerUrl: "https://brain.example/base/",
    kind: "core",
    authMode: "access",
  });
  assert.equal(access.toString(), "https://brain.example/base/dashboard/api/prompt-capsules/core?workspace=personal");
});

test("capsule endpoints reject unsafe transport and ambiguous targets", () => {
  assert.throws(() => capsuleEndpoint({ workerUrl: "http://brain.example", kind: "core" }), /HTTPS/);
  assert.throws(() => capsuleEndpoint({ workerUrl: "https://token@brain.example", kind: "core" }), /credentials/);
  assert.throws(() => capsuleEndpoint({ workerUrl: "https://brain.example?token=secret", kind: "core" }), /query/);
  assert.throws(() => capsuleEndpoint({ workerUrl: "https://brain.example", kind: "project", projectId: "Private Name" }), /projectId/);
  assert.throws(() => capsuleEndpoint({ workerUrl: "https://brain.example", kind: "core", team: "ws-1" }), /company/);
  assert.doesNotThrow(() => capsuleEndpoint({ workerUrl: "http://127.0.0.1:8787", kind: "core" }));
});

test("payload validation binds kind, scope, length, and SHA-256", () => {
  const payload = responsePayload("project", { projectId: "p-7f3a", workspace: "company", team: "ws-123" });
  const result = validateCapsulePayload(payload, {
    kind: "project",
    projectId: "p-7f3a",
    workspace: "company",
    team: "ws-123",
  });
  assert.equal(result.text, payload.text);
  assert.equal(result.promptHash, payload.prompt_hash);

  assert.throws(
    () => validateCapsulePayload({ ...payload, prompt_hash: `sha256:${"0".repeat(64)}` }, { kind: "project", projectId: "p-7f3a" }),
    error => error instanceof CapsuleSourceError && error.code === "hash_mismatch",
  );
  assert.throws(
    () => validateCapsulePayload(payload, { kind: "project", projectId: "another" }),
    error => error instanceof CapsuleSourceError && error.code === "target_mismatch",
  );
});

test("response metadata is structurally valid even when a file does not pin one project id", () => {
  const project = responsePayload("project", { projectId: "p-file" });
  assert.equal(validateCapsulePayload(project, { kind: "project" }).text, project.text);

  const { project_id: _missing, ...withoutProjectId } = project;
  assert.throws(
    () => validateCapsulePayload(withoutProjectId, { kind: "project" }),
    error => error instanceof CapsuleSourceError && error.code === "invalid_payload",
  );
  assert.throws(
    () => validateCapsulePayload({ ...responsePayload("core"), project_id: "p-extra" }, { kind: "core" }),
    error => error instanceof CapsuleSourceError && error.code === "invalid_payload",
  );
  assert.throws(
    () => validateCapsulePayload({ ...responsePayload("core"), workspace: "company", team: null }, { kind: "core" }),
    error => error instanceof CapsuleSourceError && error.code === "invalid_payload",
  );
});

test("incomplete live capsules fail closed unless explicitly allowed", () => {
  const payload = responsePayload("core", { complete: false });
  assert.throws(
    () => validateCapsulePayload(payload, { kind: "core" }),
    error => error instanceof CapsuleSourceError && error.code === "incomplete_capsule",
  );
  assert.equal(validateCapsulePayload(payload, { kind: "core", allowIncomplete: true }).complete, false);
});

test("live fetch uses a bearer header, validates MIME and returns only sanitized metadata", async () => {
  const payload = responsePayload("core");
  let seenUrl;
  let seenInit;
  const result = await fetchPromptCapsule({
    workerUrl: "https://brain.example",
    kind: "core",
    authToken: "top-secret-token",
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "Content-Type": `${PROMPT_CAPSULE_MIME}; charset=utf-8`,
          ETag: '"pcv1-fixture"',
        },
      });
    },
  });

  assert.equal(seenUrl.searchParams.has("token"), false);
  assert.equal(seenInit.headers.Authorization, "Bearer top-secret-token");
  assert.equal(seenInit.headers["X-Second-Brain-Dashboard"], undefined);
  assert.equal(seenInit.redirect, "error");
  assert.equal(result.text, payload.text);
  assert.equal(result.source, "worker");
  assert.equal(JSON.stringify(result).includes("top-secret-token"), false);
  assert.match(result.endpointHash, /^[0-9a-f]{64}$/);
  assert.match(result.etagHash, /^[0-9a-f]{64}$/);
});

test("Access fetch uses the protected dashboard route and never mixes credentials", async () => {
  const payload = responsePayload("core");
  let seenUrl;
  let seenHeaders;
  const result = await fetchPromptCapsule({
    workerUrl: "https://brain.example",
    kind: "core",
    authMode: "access",
    accessToken: "header.payload.signature",
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenHeaders = new Headers(init.headers);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "Content-Type": PROMPT_CAPSULE_MIME,
          ETag: '"pcv1-access"',
        },
      });
    },
  });

  assert.equal(seenUrl.pathname, "/dashboard/api/prompt-capsules/core");
  assert.equal(seenHeaders.get("Cf-Access-Token"), "header.payload.signature");
  assert.equal(seenHeaders.get("X-Second-Brain-Dashboard"), "1");
  assert.equal(seenHeaders.get("Authorization"), null);
  assert.equal(result.source, "worker-access");
  assert.equal(JSON.stringify(result).includes("header.payload.signature"), false);

  await assert.rejects(fetchPromptCapsule({
    workerUrl: "https://brain.example",
    kind: "core",
    authMode: "access",
    authToken: "bearer",
    accessToken: "header.payload.signature",
  }), error => error instanceof CapsuleSourceError && error.code === "ambiguous_authentication");
});

test("live fetch never includes an upstream error body in its exception", async () => {
  await assert.rejects(
    fetchPromptCapsule({
      workerUrl: "https://brain.example",
      kind: "core",
      authToken: "token",
      fetchImpl: async () => new Response("private memory from an upstream error", { status: 409 }),
    }),
    error => {
      assert.equal(error.code, "upstream_http");
      assert.equal(error.status, 409);
      assert.equal(error.message.includes("private memory"), false);
      return true;
    },
  );
});

test("capsule files accept core and project response JSON, serialized JSON, and plain text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sbcf-capsule-source-"));
  try {
    const coreResponseFile = join(dir, "core-response.json");
    const projectResponseFile = join(dir, "project-response.json");
    const promptFile = join(dir, "prompt.json");
    const textFile = join(dir, "prompt.txt");
    const corePayload = responsePayload("core");
    const projectPayload = responsePayload("project", { projectId: "p-file" });
    await writeFile(coreResponseFile, JSON.stringify(corePayload));
    await writeFile(projectResponseFile, JSON.stringify(projectPayload));
    await writeFile(promptFile, corePayload.text);
    await writeFile(textFile, "stable plain text");

    assert.equal((await readCapsuleFile(coreResponseFile, "core")).text, corePayload.text);
    assert.equal((await readCapsuleFile(projectResponseFile, "project")).text, projectPayload.text);
    assert.equal((await readCapsuleFile(promptFile, "core")).text, corePayload.text);
    assert.equal((await readCapsuleFile(textFile, "core")).text, "stable plain text");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("live fetch rejects missing credentials, oversized responses, and weak ETags", async () => {
  await assert.rejects(
    fetchPromptCapsule({ workerUrl: "https://brain.example", kind: "core", authMode: "access", accessToken: "" }),
    error => error instanceof CapsuleSourceError && error.code === "access_token_missing",
  );

  await assert.rejects(
    fetchPromptCapsule({ workerUrl: "https://brain.example", kind: "core", authToken: "" }),
    error => error instanceof CapsuleSourceError && error.code === "auth_token_missing",
  );

  await assert.rejects(
    fetchPromptCapsule({
      workerUrl: "https://brain.example",
      kind: "core",
      authToken: "token",
      fetchImpl: async () => new Response("{}", {
        status: 200,
        headers: {
          "Content-Type": PROMPT_CAPSULE_MIME,
          "Content-Length": String(65 * 1024),
          ETag: '"pcv1-fixture"',
        },
      }),
    }),
    error => error instanceof CapsuleSourceError && error.code === "response_too_large",
  );

  const payload = responsePayload("core");
  await assert.rejects(
    fetchPromptCapsule({
      workerUrl: "https://brain.example",
      kind: "core",
      authToken: "token",
      fetchImpl: async () => new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "Content-Type": PROMPT_CAPSULE_MIME,
          ETag: 'W/"pcv1-fixture"',
        },
      }),
    }),
    error => error instanceof CapsuleSourceError && error.code === "invalid_etag",
  );
});

test("serialized capsule files cannot be relabelled as another kind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sbcf-capsule-kind-"));
  try {
    const path = join(dir, "project.json");
    await writeFile(path, promptText("project"));
    await assert.rejects(
      readCapsuleFile(path, "core"),
      error => error instanceof CapsuleSourceError && error.code === "invalid_prompt_text",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
