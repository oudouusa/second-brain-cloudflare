import assert from "node:assert/strict";
import test from "node:test";
import {
  PROMPT_CAPSULE_MIME,
  CapsuleSourceError,
  sha256,
} from "./capsule-source.mjs";
import {
  capsuleRefreshDescriptor,
  createPromptCapsuleRevalidator,
} from "./capsule-revalidate.mjs";

function promptText(content) {
  return JSON.stringify({
    schema: "prompt-capsule.v1",
    kind: "core",
    sections: [{ slot: "principles", content }],
  }, null, 2);
}

function payload(content = "stable capsule") {
  const text = promptText(content);
  return {
    ok: true,
    schema: "prompt-capsule.v1",
    kind: "core",
    workspace: "personal",
    team: null,
    prompt_hash: `sha256:${sha256(text)}`,
    text,
    sections: [{ slot: "principles", source_entry_id: "mem-fixture" }],
    omitted_slots: [],
    complete: true,
    char_count: text.length,
    max_chars: 12_000,
  };
}

function capsuleResponse(value, etag) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "Content-Type": `${PROMPT_CAPSULE_MIME}; charset=utf-8`,
      ETag: etag,
    },
  });
}

function revalidator(fetchImpl) {
  return createPromptCapsuleRevalidator({
    workerUrl: "https://brain.example",
    kind: "core",
    authToken: "top-secret-token",
    fetchImpl,
  });
}

test("an initial 200 is revalidated with If-None-Match and a 304 reuses exact text", async () => {
  const value = payload();
  const etag = '"pcv1-fixture"';
  const seen = [];
  const client = revalidator(async (_url, init) => {
    const validator = new Headers(init.headers).get("If-None-Match");
    seen.push(validator);
    if (seen.length === 1) return capsuleResponse(value, etag);
    return new Response(null, { status: 304, headers: { ETag: etag } });
  });

  const first = await client.refresh();
  const second = await client.refresh();

  assert.deepEqual(seen, [null, etag]);
  assert.equal(first.revalidation, "initial");
  assert.equal(first.httpStatus, 200);
  assert.equal(first.generation, 1);
  assert.equal(second.revalidation, "not-modified");
  assert.equal(second.httpStatus, 304);
  assert.equal(second.generation, 1);
  assert.equal(second.text, first.text);
  assert.equal(second.promptHash, first.promptHash);
});

test("a 304 without a validated snapshot fails closed", async () => {
  const client = revalidator(async () => new Response(null, {
    status: 304,
    headers: { ETag: '"pcv1-fixture"' },
  }));

  await assert.rejects(
    client.refresh(),
    error => error instanceof CapsuleSourceError
      && error.code === "not_modified_without_snapshot",
  );
});

test("a 304 must repeat the exact strong ETag selected by the request", async () => {
  let calls = 0;
  const client = revalidator(async () => {
    calls += 1;
    if (calls === 1) return capsuleResponse(payload(), '"pcv1-one"');
    return new Response(null, { status: 304, headers: { ETag: '"pcv1-other"' } });
  });

  await client.refresh();
  await assert.rejects(
    client.refresh(),
    error => error instanceof CapsuleSourceError
      && error.code === "not_modified_etag_mismatch",
  );
});

test("a weak validator on 304 is rejected even when its opaque value matches", async () => {
  let calls = 0;
  const client = revalidator(async () => {
    calls += 1;
    if (calls === 1) return capsuleResponse(payload(), '"pcv1-one"');
    return new Response(null, { status: 304, headers: { ETag: 'W/"pcv1-one"' } });
  });

  await client.refresh();
  await assert.rejects(
    client.refresh(),
    error => error instanceof CapsuleSourceError
      && error.code === "not_modified_etag_mismatch",
  );
});

test("a changed 200 response replaces the snapshot and advances its generation", async () => {
  let calls = 0;
  const client = revalidator(async (_url, init) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(new Headers(init.headers).get("If-None-Match"), null);
      return capsuleResponse(payload("version one"), '"pcv1-one"');
    }
    assert.equal(new Headers(init.headers).get("If-None-Match"), '"pcv1-one"');
    return capsuleResponse(payload("version two"), '"pcv1-two"');
  });

  const first = await client.refresh();
  const second = await client.refresh();
  assert.equal(first.revalidation, "initial");
  assert.equal(second.revalidation, "modified");
  assert.equal(second.generation, 2);
  assert.notEqual(second.promptHash, first.promptHash);
});

test("clear removes both the validator and cached representation", async () => {
  const seen = [];
  const client = revalidator(async (_url, init) => {
    seen.push(new Headers(init.headers).get("If-None-Match"));
    return capsuleResponse(payload(), '"pcv1-stable"');
  });

  await client.refresh();
  assert.equal(client.hasSnapshot, true);
  client.clear();
  assert.equal(client.hasSnapshot, false);
  const next = await client.refresh();
  assert.equal(next.revalidation, "initial");
  assert.equal(next.generation, 1);
  assert.deepEqual(seen, [null, null]);
});

test("clear invalidates a refresh that was already in flight", async () => {
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const responseReady = new Promise(resolve => { release = resolve; });
  const client = revalidator(async () => {
    markStarted();
    return responseReady;
  });
  const pending = client.refresh();

  await started;
  client.clear();
  release(capsuleResponse(payload(), '"pcv1-late"'));
  await assert.rejects(
    pending,
    error => error instanceof CapsuleSourceError && error.code === "revalidation_cleared",
  );
  assert.equal(client.hasSnapshot, false);
});

test("concurrent refresh calls are serialized before selecting a snapshot", async () => {
  const releases = [];
  const seenValidators = [];
  const client = revalidator(async (_url, init) => {
    seenValidators.push(new Headers(init.headers).get("If-None-Match"));
    return new Promise(resolve => releases.push(resolve));
  });

  const firstPending = client.refresh();
  const secondPending = client.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 1);

  releases[0](capsuleResponse(payload("first"), '"pcv1-first"'));
  const first = await firstPending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 2);
  assert.deepEqual(seenValidators, [null, '"pcv1-first"']);

  releases[1](new Response(null, { status: 304, headers: { ETag: '"pcv1-first"' } }));
  const second = await secondPending;
  assert.equal(second.revalidation, "not-modified");
  assert.equal(second.promptHash, first.promptHash);
});

test("a failed replacement cannot poison the previously validated snapshot", async () => {
  let calls = 0;
  const originalEtag = '"pcv1-original"';
  const client = revalidator(async (_url, init) => {
    calls += 1;
    if (calls === 1) return capsuleResponse(payload("original"), originalEtag);
    assert.equal(new Headers(init.headers).get("If-None-Match"), originalEtag);
    if (calls === 2) {
      return capsuleResponse({
        ...payload("tampered"),
        prompt_hash: `sha256:${"0".repeat(64)}`,
      }, '"pcv1-tampered"');
    }
    return new Response(null, { status: 304, headers: { ETag: originalEtag } });
  });

  const first = await client.refresh();
  await assert.rejects(
    client.refresh(),
    error => error instanceof CapsuleSourceError && error.code === "hash_mismatch",
  );
  const third = await client.refresh();
  assert.equal(third.revalidation, "not-modified");
  assert.equal(third.generation, 1);
  assert.equal(third.promptHash, first.promptHash);
});

test("the revalidation wrapper enforces its response limit before validation", async () => {
  const client = revalidator(async () => new Response("{}", {
    status: 200,
    headers: {
      "Content-Type": PROMPT_CAPSULE_MIME,
      "Content-Length": String(65 * 1024),
      ETag: '"pcv1-large"',
    },
  }));
  await assert.rejects(
    client.refresh(),
    error => error instanceof CapsuleSourceError && error.code === "response_too_large",
  );
  assert.equal(client.hasSnapshot, false);
});

test("the log descriptor never contains Capsule text, bearer credentials, or raw ETags", async () => {
  const secret = "top-secret-token";
  const rawEtag = '"pcv1-sensitive-validator"';
  const privateText = "private capsule sentence";
  const client = createPromptCapsuleRevalidator({
    workerUrl: "https://brain.example",
    kind: "core",
    authToken: secret,
    fetchImpl: async () => capsuleResponse(payload(privateText), rawEtag),
  });

  const descriptor = capsuleRefreshDescriptor(await client.refresh());
  const serialized = JSON.stringify(descriptor);
  assert.equal(serialized.includes(privateText), false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(rawEtag), false);
  assert.match(descriptor.endpoint_hash, /^[0-9a-f]{64}$/);
  assert.match(descriptor.etag_hash, /^[0-9a-f]{64}$/);
  assert.match(descriptor.prompt_hash, /^sha256:[0-9a-f]{64}$/);
});

test("Access revalidation stays on the dashboard route and omits bearer auth", async () => {
  const seen = [];
  const accessJwt = "header.payload.signature";
  const client = createPromptCapsuleRevalidator({
    workerUrl: "https://brain.example",
    kind: "core",
    authMode: "access",
    accessToken: accessJwt,
    fetchImpl: async (url, init) => {
      const headers = new Headers(init.headers);
      seen.push({
        pathname: url.pathname,
        access: headers.get("Cf-Access-Token"),
        dashboard: headers.get("X-Second-Brain-Dashboard"),
        bearer: headers.get("Authorization"),
        validator: headers.get("If-None-Match"),
      });
      if (seen.length === 1) return capsuleResponse(payload(), '"pcv1-access"');
      return new Response(null, { status: 304, headers: { ETag: '"pcv1-access"' } });
    },
  });

  const first = await client.refresh();
  const second = await client.refresh();
  assert.deepEqual(seen, [
    {
      pathname: "/dashboard/api/prompt-capsules/core",
      access: accessJwt,
      dashboard: "1",
      bearer: null,
      validator: null,
    },
    {
      pathname: "/dashboard/api/prompt-capsules/core",
      access: accessJwt,
      dashboard: "1",
      bearer: null,
      validator: '"pcv1-access"',
    },
  ]);
  assert.equal(first.source, "worker-access");
  assert.equal(second.revalidation, "not-modified");
  assert.equal(JSON.stringify(capsuleRefreshDescriptor(second)).includes(accessJwt), false);
});
