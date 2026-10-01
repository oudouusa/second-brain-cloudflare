import { describe, expect, it } from "vitest";
import { measureD1 } from "../../experiments/recall-remote/d1-metrics.mjs";
import { stagingEndpoint, rpcReply } from "../../experiments/recall-remote/protocol.mjs";

describe("remote D1 measurement", () => {
  const setup = (meta: object = { rows_read: 700, rows_written: 2 }) => {
    const calls: string[] = [];
    const raw = { bind: (..._: unknown[]) => raw,
      all: async () => ({ results: [{ value: 3 }], meta }),
      run: async () => ({ results: [], meta }) };
    const metrics = { statements: 0, rowsRead: 0 as number | null, rowsWritten: 0 as number | null };
    const db = measureD1({ prepare: () => raw, batch: async (statements: object[]) => {
      expect(statements.every(s => s === raw)).toBe(true); calls.push("batch");
      return statements.map(() => ({ results: [{ value: 3 }], meta }));
    } }, () => metrics);
    return { db, metrics, calls };
  };
  it("counts actual scanned rows, preserving first and batch behavior", async () => {
    const { db, metrics, calls } = setup();
    expect(await db.prepare("SELECT").bind(1).first("value")).toBe(3);
    expect(await db.prepare("SELECT").first()).toEqual({ value: 3 });
    await db.batch([db.prepare("A"), db.prepare("B").bind(2)]);
    expect(calls).toEqual(["batch"]);
    expect(metrics).toEqual({ statements: 4, rowsRead: 2800, rowsWritten: 8 });
  });
  it("keeps missing metadata unknown", async () => {
    const { db, metrics } = setup({ changes: 1 });
    await db.prepare("A").run();
    expect(metrics.rowsRead).toBeNull(); expect(metrics.rowsWritten).toBeNull();
  });
  it("rejects unsupported or foreign statements instead of dropping measurements", async () => {
    const { db } = setup();
    await expect(db.batch([{}])).rejects.toThrow("Foreign");
    expect(() => db.prepare("A").raw()).toThrow("Uninstrumented");
    expect(() => db.exec()).toThrow("Initialize");
    await expect(db.prepare("A").first("absent")).rejects.toThrow("D1_COLUMN_NOTFOUND");
  });
});

it("restricts bearer-token destinations to local and dedicated staging endpoints", () => {
  expect(stagingEndpoint("http://127.0.0.1:8796").port).toBe("8796");
  expect(stagingEndpoint("https://sb54-baseline-20260907.staging-example.workers.dev").protocol).toBe("https:");
  for (const url of ["https://sb54-baseline-20260906.production-example.workers.dev", "https://second-brain-cf.production-example.workers.dev",
    "https://sb54-baseline-20260906.other.workers.dev",
    "http://sb54-baseline-20260907.staging-example.workers.dev", "https://user:pass@localhost",
    "https://localhost?token=secret", "https://example.com"]) {
    expect(() => stagingEndpoint(url)).toThrow();
  }
});

it("reads the matching JSON or SSE reply and rejects absent or duplicated replies", () => {
  const reply = { jsonrpc: "2.0", id: "sample", result: { content: [] } };
  const raw = JSON.stringify(reply);
  expect(rpcReply(raw, "sample")).toEqual(reply);
  const sse = `event: message\r\ndata: ${raw}\r\n\r\n`;
  expect(rpcReply(sse, "sample")).toEqual(reply);
  expect(() => rpcReply(sse + sse, "sample")).toThrow("duplicate");
  expect(() => rpcReply(raw, "another")).toThrow("Missing");
  expect(() => rpcReply("invalid", "sample")).toThrow();
});
