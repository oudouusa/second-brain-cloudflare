import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { observeRecallEnv } from "../../src/recall/diagnostics";
import type { RecallDiagnostics } from "../../src/recall/types";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";

describe("observeRecallEnv", () => {
  it("preserves unobserved host bindings without enumerating the source env", () => {
    const assets = { fetch: vi.fn(), connect: vi.fn() } as unknown as Fetcher;
    const source = makeTestEnv(makeTestDb(), { ASSETS: assets });
    const ownKeys = vi.fn(() => { throw new Error("host bindings must not be enumerated"); });
    const hostEnv = new Proxy(source, { ownKeys }) as Env;
    const diagnostics = {} as RecallDiagnostics;

    const observed = observeRecallEnv(hostEnv, diagnostics);

    expect(observed.ASSETS).toBe(assets);
    expect(observed.AI).not.toBe(source.AI);
    expect(ownKeys).not.toHaveBeenCalled();
  });
});
