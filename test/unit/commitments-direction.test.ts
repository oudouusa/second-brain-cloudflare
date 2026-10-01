import { describe, it, expect, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { openLoopSql } from "../../src/memory/loops";
import {
  OWED_TO_ME_SQL,
  openOutboundSql,
  openInboundSql,
  directionOf,
  counterpartySlug,
  counterpartyName,
  counterpartyOf,
  dueKindOf,
} from "../../src/commitments/direction";

const NOW = Date.now();

let sq: SqliteD1 | null = null;
afterEach(() => {
  sq?.close();
  sq = null;
});

interface Fixture {
  id: string;
  tags: string[];
}

const FIXTURE: Fixture[] = [
  { id: "outbound-open", tags: ["task"] },
  { id: "outbound-open-2", tags: ["task", "counterparty:sam"] },
  { id: "inbound-open", tags: ["task", "owed-to-me", "counterparty:priya"] },
  { id: "inbound-open-no-counterparty", tags: ["task", "owed-to-me"] },
  { id: "outbound-done", tags: ["task", "task:done"] },
  { id: "inbound-done", tags: ["task", "owed-to-me", "task:done"] },
  { id: "deprecated", tags: ["task", "status:deprecated"] },
  { id: "deprecated-inbound", tags: ["task", "owed-to-me", "status:deprecated"] },
  { id: "agent-log", tags: ["task", "claude-response"] },
  { id: "not-a-loop", tags: ["idea"] },
];

async function seeded(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  // schema 9の参照DDLに必要な有効期間列が含まれることを検証する。
  expect(s.columns()).toContain("valid_until");
  FIXTURE.forEach((row, i) => s.seed({ id: row.id, content: "x", createdAt: i, tags: row.tags }));
  return s;
}

async function ids(s: SqliteD1, whereSql: string): Promise<string[]> {
  const { results } = (await s.db.prepare(`SELECT id FROM entries WHERE ${whereSql} ORDER BY id`).all()) as {
    results: { id: string }[];
  };
  return results.map((r) => r.id);
}

describe("OPEN_OUTBOUND_SQL and OPEN_INBOUND_SQL", () => {
  it("partition OPEN_LOOP_SQL exactly: every open row is in exactly one direction, closed rows in neither", async () => {
    sq = await seeded();
    const open = new Set(await ids(sq, openLoopSql(NOW)));
    const outbound = await ids(sq, openOutboundSql(NOW));
    const inbound = await ids(sq, openInboundSql(NOW));

    expect(new Set(outbound).has("outbound-done")).toBe(false);
    expect(new Set(inbound).has("inbound-done")).toBe(false);
    expect(new Set(inbound).has("deprecated-inbound")).toBe(false);
    expect(outbound).not.toContain("agent-log");

    // no overlap between directions
    const overlap = outbound.filter((id) => inbound.includes(id));
    expect(overlap).toEqual([]);

    // union of both directions equals OPEN_LOOP_SQL exactly
    expect(new Set([...outbound, ...inbound])).toEqual(open);
  });

  it("outbound is every open row without the inbound marker; inbound is every open row with it", async () => {
    sq = await seeded();
    const outbound = await ids(sq, openOutboundSql(NOW));
    const inbound = await ids(sq, openInboundSql(NOW));

    expect(outbound).toEqual(expect.arrayContaining(["outbound-open", "outbound-open-2"]));
    expect(inbound).toEqual(expect.arrayContaining(["inbound-open", "inbound-open-no-counterparty"]));
    expect(inbound).not.toContain("outbound-open");
    expect(outbound).not.toContain("inbound-open");
  });

  it("OWED_TO_ME_SQL matches only rows carrying the bare owed-to-me marker", async () => {
    sq = await seeded();
    const owedToMe = await ids(sq, OWED_TO_ME_SQL);
    expect(owedToMe.sort()).toEqual(
      ["deprecated-inbound", "inbound-done", "inbound-open", "inbound-open-no-counterparty"].sort(),
    );
  });
});

describe("directionOf", () => {
  it("is in when tags carry owed-to-me, out otherwise", () => {
    expect(directionOf(["task", "owed-to-me"])).toBe("in");
    expect(directionOf(["task"])).toBe("out");
    expect(directionOf([])).toBe("out");
  });
});

describe("counterpartySlug", () => {
  it("lowercases, turns spaces into hyphens, and strips anything else", () => {
    expect(counterpartySlug("Priya")).toBe("priya");
    expect(counterpartySlug("Dana Smith")).toBe("dana-smith");
    expect(counterpartySlug("  Sam  ")).toBe("sam");
    expect(counterpartySlug("O'Brien!!")).toBe("obrien");
  });

  it("yields an empty slug, and no counterparty tag, for a name with no valid characters", () => {
    expect(counterpartySlug("!!!")).toBe("");
    expect(counterpartySlug("- - -")).toBe("");
    expect(counterpartySlug("")).toBe("");
  });
});

describe("counterpartyName", () => {
  it("title-cases a hyphenated slug back into a display name", () => {
    expect(counterpartyName("dana-smith")).toBe("Dana Smith");
    expect(counterpartyName("priya")).toBe("Priya");
    expect(counterpartyName("sam_jones")).toBe("Sam Jones");
  });
});

describe("counterpartyOf", () => {
  it("reads the counterparty tag's display name", () => {
    expect(counterpartyOf(["task", "counterparty:priya"])).toBe("Priya");
  });

  it("is undefined when no counterparty tag is present", () => {
    expect(counterpartyOf(["task"])).toBeUndefined();
  });
});

describe("dueKindOf", () => {
  it("classifies a decision, inbound, outbound and other", () => {
    expect(dueKindOf(["ledger:decision"])).toBe("decision");
    expect(dueKindOf(["task", "owed-to-me"])).toBe("inbound");
    expect(dueKindOf(["task"])).toBe("outbound");
    expect(dueKindOf(["work"])).toBe("other");
  });

  it("a decision always wins over a task tag", () => {
    expect(dueKindOf(["ledger:decision", "task"])).toBe("decision");
  });
});
