import assert from "node:assert/strict";
import test from "node:test";
import {
  OperatorCredentialError,
  PROXY_SYSTEMD_CREDENTIAL,
  resolveProxyApiKey,
} from "./operator-credential.mjs";

function stat({ size = 12, file = true } = {}) {
  return {
    size,
    isFile: () => file,
  };
}

test("legacy proxy environment credential remains supported", () => {
  const result = resolveProxyApiKey({
    environment: { PROMPT_CACHE_PROXY_API_KEY: " proxy-secret " },
  });
  assert.deepEqual(result, { value: "proxy-secret", source: "environment" });
});

test("systemd LoadCredential removes the need to export a proxy key", () => {
  let seenPath;
  let seenFlags;
  let closedDescriptor;
  const result = resolveProxyApiKey({
    environment: { CREDENTIALS_DIRECTORY: "/run/credentials/unit.service" },
    openSyncImpl: (path, flags) => {
      seenPath = path;
      seenFlags = flags;
      return 42;
    },
    fstatSyncImpl: descriptor => {
      assert.equal(descriptor, 42);
      return stat();
    },
    readFileSyncImpl: () => "internal-secret\n",
    closeSyncImpl: descriptor => {
      closedDescriptor = descriptor;
    },
  });
  assert.equal(seenPath, `/run/credentials/unit.service/${PROXY_SYSTEMD_CREDENTIAL}`);
  assert.equal(typeof seenFlags, "number");
  assert.equal(closedDescriptor, 42);
  assert.deepEqual(result, { value: "internal-secret", source: "systemd-credential" });
});

test("unsafe credential paths, links, large files, and line breaks fail closed", () => {
  assert.throws(
    () => resolveProxyApiKey({ environment: { CREDENTIALS_DIRECTORY: "relative" } }),
    error => error instanceof OperatorCredentialError && error.code === "proxy_api_key_missing",
  );
  assert.throws(() => resolveProxyApiKey({
    environment: { CREDENTIALS_DIRECTORY: "/run/credentials/unit" },
    openSyncImpl: () => {
      const error = new Error("link refused");
      error.code = "ELOOP";
      throw error;
    },
  }), /proxy_api_key_missing/);
  assert.throws(() => resolveProxyApiKey({
    environment: { CREDENTIALS_DIRECTORY: "/run/credentials/unit" },
    openSyncImpl: () => 42,
    fstatSyncImpl: () => stat({ size: 20 * 1024 }),
    closeSyncImpl: () => {},
  }), /proxy_api_key_invalid/);
  assert.throws(() => resolveProxyApiKey({
    environment: { PROMPT_CACHE_PROXY_API_KEY: "first\nsecond" },
  }), /proxy_api_key_invalid/);
});

test("opened credential descriptors are closed when reading fails", () => {
  let closed = false;
  assert.throws(() => resolveProxyApiKey({
    environment: { CREDENTIALS_DIRECTORY: "/run/credentials/unit" },
    openSyncImpl: () => 42,
    fstatSyncImpl: () => stat(),
    readFileSyncImpl: () => {
      throw new Error("read failed");
    },
    closeSyncImpl: () => {
      closed = true;
    },
  }), /proxy_api_key_unreadable/);
  assert.equal(closed, true);
});
