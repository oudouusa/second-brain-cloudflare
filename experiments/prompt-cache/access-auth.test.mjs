import assert from "node:assert/strict";
import test from "node:test";
import {
  CapsuleAccessError,
  accessApplicationUrl,
  resolveCloudflareAccessToken,
} from "./access-auth.mjs";

const JWT = `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(32)}`;

test("Access application defaults to the dashboard on the Worker origin", () => {
  assert.equal(accessApplicationUrl({
    workerUrl: "https://brain.example/base",
  }).toString(), "https://brain.example/dashboard");
  assert.equal(accessApplicationUrl({
    workerUrl: "https://brain.example",
    accessAppUrl: "https://brain.example/dashboard/admin",
  }).pathname, "/dashboard/admin");
});

test("Access application cannot send a login token to another origin", () => {
  assert.throws(() => accessApplicationUrl({
    workerUrl: "https://brain.example",
    accessAppUrl: "https://attacker.example/dashboard",
  }), /same origin/);
  assert.throws(() => accessApplicationUrl({
    workerUrl: "https://brain.example",
    accessAppUrl: "https://brain.example/dashboard?token=unsafe",
  }), /query/);
});

test("cloudflared is invoked without a shell and only the compact JWT is returned", () => {
  let invocation;
  const token = resolveCloudflareAccessToken({
    workerUrl: "https://brain.example",
    environment: { PATH: "/usr/bin", CLOUDFLARED_BIN: "/opt/bin/cloudflared" },
    execFileSyncImpl: (file, args, options) => {
      invocation = { file, args, options };
      return `${JWT}\n`;
    },
  });
  assert.equal(token, JWT);
  assert.equal(invocation.file, "/opt/bin/cloudflared");
  assert.deepEqual(invocation.args, ["access", "token", "--app", "https://brain.example/dashboard"]);
  assert.equal(invocation.options.shell, undefined);
  assert.deepEqual(invocation.options.stdio, ["ignore", "pipe", "ignore"]);
});

test("cloudflared failures and malformed output fail closed without copying secrets", () => {
  assert.throws(() => resolveCloudflareAccessToken({
    workerUrl: "https://brain.example",
    execFileSyncImpl: () => { throw new Error(`failed with ${JWT}`); },
  }), error => error instanceof CapsuleAccessError
    && error.code === "access_token_unavailable"
    && !error.message.includes(JWT));

  assert.throws(() => resolveCloudflareAccessToken({
    workerUrl: "https://brain.example",
    execFileSyncImpl: () => "not-a-jwt",
  }), error => error instanceof CapsuleAccessError && error.code === "invalid_access_token");
});
