import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { isAuthorized, isValidAuthToken } from "../../src/lib/http";

function envWithToken(token: unknown): Env {
  return { AUTH_TOKEN: token } as Env;
}

describe("AUTH_TOKEN fail-closed behavior", () => {
  it.each([undefined, null, ""])("rejects every credential when the binding is %s", async (configured) => {
    const env = envWithToken(configured);

    await expect(isValidAuthToken(undefined, env)).resolves.toBe(false);
    await expect(isValidAuthToken(null, env)).resolves.toBe(false);
    await expect(isValidAuthToken("", env)).resolves.toBe(false);
    await expect(isValidAuthToken("undefined", env)).resolves.toBe(false);
    await expect(isAuthorized(new Request("https://brain.example/?token=undefined"), env)).resolves.toBe(false);
    await expect(isAuthorized(new Request("https://brain.example/", {
      headers: { Authorization: "Bearer undefined" },
    }), env)).resolves.toBe(false);
  });

  it("accepts only an exact configured token in the Bearer header", async () => {
    const env = envWithToken("secret-token");

    await expect(isValidAuthToken("secret-token", env)).resolves.toBe(true);
    await expect(isValidAuthToken("secret-token ", env)).resolves.toBe(false);
    await expect(isAuthorized(new Request("https://brain.example/?token=secret-token"), env)).resolves.toBe(false);
    await expect(isAuthorized(new Request("https://brain.example/", {
      headers: { Authorization: "Bearer secret-token" },
    }), env)).resolves.toBe(true);
    await expect(isAuthorized(new Request("https://brain.example/", {
      headers: { Authorization: "bearer secret-token" },
    }), env)).resolves.toBe(true);
  });
});
