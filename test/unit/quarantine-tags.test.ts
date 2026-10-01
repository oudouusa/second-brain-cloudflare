/**
 * Track 4 (self-protecting) contract commit: the quarantine tag namespace,
 * the canonical-edit label, and the config keys both tracks ship "off"
 * (16-t3-t4-trust-spec.md Task 0). Nothing here is wired into a write path
 * yet -- this pins the pure helpers' own contract so Track 4's later tasks
 * build on constants that already behave exactly as designed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { installI18n } from "../ui/_i18n-harness";
import { applyTagReplacement, isWorkerOwnedTag, normalizeTagList } from "../../src/tags/system";
import { isReservedTag, isTopicTag } from "../../src/compression/eligibility";
import { getStatus } from "../../src/memory/status";
import {
  EDITED_CANONICAL_TAG_PREFIX,
  NOT_HELD_SQL,
  QUARANTINE_TAG_PREFIX,
  editedCanonicalAt,
  heldReason,
  isHeld,
  withEditedCanonical,
  withHold,
} from "../../src/quarantine/tags";
import { DEFAULTS, RULES } from "../../src/config";

const ROOT = resolve(import.meta.dirname, "../..");

describe("isWorkerOwnedTag protects quarantine:* and edited-canonical:*", () => {
  it("is true for both namespaces, case-insensitively", () => {
    expect(isWorkerOwnedTag(`${QUARANTINE_TAG_PREFIX}instruction`)).toBe(true);
    expect(isWorkerOwnedTag("QUARANTINE:BURST")).toBe(true);
    expect(isWorkerOwnedTag(`${EDITED_CANONICAL_TAG_PREFIX}2026-09-26`)).toBe(true);
    expect(isWorkerOwnedTag("Edited-Canonical:2026-09-26")).toBe(true);
  });
});

describe("applyTagReplacement keeps a quarantine tag an update tries to drop", () => {
  it("survives a replacement that omits it", () => {
    const existing = [`${QUARANTINE_TAG_PREFIX}hidden`, "status:draft", "old-topic"];
    expect(applyTagReplacement(existing, ["new-topic"])).toEqual([`${QUARANTINE_TAG_PREFIX}hidden`, "status:draft", "new-topic"]);
  });
});

describe("neither prefix is a topic tag for digests", () => {
  it("isReservedTag and isTopicTag agree", () => {
    for (const tag of [`${QUARANTINE_TAG_PREFIX}instruction`, `${EDITED_CANONICAL_TAG_PREFIX}2026-09-26`]) {
      expect(isReservedTag(tag), tag).toBe(true);
      expect(isTopicTag(tag), tag).toBe(false);
    }
  });
});

describe("public/utils.js hides both prefixes", () => {
  function loadUtils(): any {
    const ctx: any = { console };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    installI18n(ctx, "en");
    vm.runInContext(readFileSync(resolve(ROOT, "public/utils.js"), "utf8"), ctx);
    return ctx;
  }

  it("isSystemTag is true for both", () => {
    const { isSystemTag } = loadUtils();
    expect(isSystemTag(`${QUARANTINE_TAG_PREFIX}instruction`)).toBe(true);
    expect(isSystemTag(`${EDITED_CANONICAL_TAG_PREFIX}2026-09-26`)).toBe(true);
  });
});

describe("NOT_HELD_SQL excludes a row only for the five exact reasons this Worker writes", () => {
  const REASONS = ["instruction", "hidden", "burst", "capsule", "too_long"];

  it("matches the exact literal: one exact-format NOT LIKE clause per HoldReason, ANDed, ESCAPEd", () => {
    expect(NOT_HELD_SQL).toBe(
      REASONS.map(r => `tags NOT LIKE '%"${QUARANTINE_TAG_PREFIX}${r.replace("_", "\\_")}"%' ESCAPE '\\'`).join(" AND "),
    );
  });

  it("carries no bound placeholder", () => {
    expect(NOT_HELD_SQL).not.toContain("?");
  });

  it("carries exactly two percent signs per clause, the leading and trailing wildcards", () => {
    expect(NOT_HELD_SQL.match(/%/g)?.length).toBe(REASONS.length * 2);
  });

  it("escapes too_long's underscore, so it can't act as LIKE's single-character wildcard", () => {
    const tooLongClause = NOT_HELD_SQL.split(" AND ").find(c => c.includes("too"));
    expect(tooLongClause).toContain("too\\_long");
    expect(tooLongClause).toContain("ESCAPE '\\'");
  });

  // NOT_HELD_SQL's LIKE pattern is an EXACT literal match against the stored JSON array element --
  // it has no way to trim whitespace itself, unlike heldReason/isHeld's own `.trim()` in JS. The
  // two only agree because every write boundary trims a tag before it is ever stored.
  it("a tag trims before it is ever stored, so the SQL's untrimmed exact match and the JS's trimmed one never disagree", () => {
    const stored = normalizeTagList([" work ", ` ${QUARANTINE_TAG_PREFIX}instruction `, "\tstatus:canonical\n"]);
    expect(stored).toEqual(["work", `${QUARANTINE_TAG_PREFIX}instruction`, "status:canonical"]);
    const asStored = JSON.stringify(stored);
    expect(asStored).toContain(`"${QUARANTINE_TAG_PREFIX}instruction"`);
    expect(isHeld(stored)).toBe(true);
  });
});

describe("isHeld / heldReason / withHold", () => {
  it("isHeld is true for a recognized reason unconditionally, whatever its other tags (a recognized reason is never coincidental, director follow-up: simplified, no status:draft pairing)", () => {
    expect(isHeld(["work", "status:canonical"])).toBe(false);
    expect(isHeld(["work", `${QUARANTINE_TAG_PREFIX}instruction`])).toBe(true);
    expect(isHeld(["work", `${QUARANTINE_TAG_PREFIX}instruction`, "status:canonical"])).toBe(true);
    expect(isHeld(["work", `${QUARANTINE_TAG_PREFIX}instruction`, "status:draft"])).toBe(true);
  });

  it("isHeld is false for an unrecognized reason, status:draft alongside it or not", () => {
    // Director follow-up: an unrecognized reason is never held, even paired with status:draft --
    // the earlier "defense in depth" version of this rule (this suite's own prior iteration) was
    // itself a cloud-review MAJOR: it let a 3.7 row that happened to carry BOTH a quarantine:-
    // prefixed tag and an unrelated status:draft (a capsule-defining row, for one) become
    // permanently held. Simpler and correct: exactly the five reasons, nothing else, ever.
    expect(isHeld([`${QUARANTINE_TAG_PREFIX}some-future-reason`, "status:draft"])).toBe(false);
    expect(isHeld([`${QUARANTINE_TAG_PREFIX}some-future-reason`])).toBe(false);
    expect(heldReason([`${QUARANTINE_TAG_PREFIX}some-future-reason`, "status:draft"])).toBeNull();
  });

  it("a 3.7 legacy tag that merely shares the quarantine: prefix is not held, status:draft alongside it or not", () => {
    expect(isHeld(["quarantine:2020", "outcome:won"])).toBe(false);
    expect(isHeld(["quarantine:review"])).toBe(false);
    expect(isHeld(["quarantine:review", "status:draft"])).toBe(false);
  });

  it("heldReason reads the recognized reason and is null otherwise", () => {
    expect(heldReason([`${QUARANTINE_TAG_PREFIX}instruction`])).toBe("instruction");
    expect(heldReason([`${QUARANTINE_TAG_PREFIX}hidden`])).toBe("hidden");
    expect(heldReason([`${QUARANTINE_TAG_PREFIX}burst`])).toBe("burst");
    expect(heldReason([`${QUARANTINE_TAG_PREFIX}capsule`])).toBe("capsule");
    expect(heldReason([`${QUARANTINE_TAG_PREFIX}too_long`])).toBe("too_long");
    expect(heldReason([`${QUARANTINE_TAG_PREFIX}bogus`])).toBeNull();
    expect(heldReason(["work"])).toBeNull();
  });

  it("withHold adds the hold tag and sets status:draft, replacing any earlier hold", () => {
    const next = withHold(["work", `${QUARANTINE_TAG_PREFIX}hidden`, "status:canonical"], "instruction");
    expect(next).toContain(`${QUARANTINE_TAG_PREFIX}instruction`);
    expect(next).not.toContain(`${QUARANTINE_TAG_PREFIX}hidden`);
    expect(getStatus(next)).toBe("draft");
    expect(next).toContain("work");
  });

  it("withHold never strips a 3.7 tag that merely shares the quarantine: prefix (director follow-up)", () => {
    const next = withHold(["quarantine:2020", "work"], "instruction");
    expect(next).toContain(`${QUARANTINE_TAG_PREFIX}instruction`);
    expect(next).toContain("quarantine:2020");
    expect(next).toContain("work");
  });
});

describe("editedCanonicalAt and withEditedCanonical round-trip and replace an older label", () => {
  it("round-trips a fresh label", () => {
    const now = Date.UTC(2026, 8, 26, 12, 0, 0); // 2026-09-26
    const tags = withEditedCanonical(["work"], now);
    expect(editedCanonicalAt(tags)).toBe("2026-09-26");
  });

  it("replaces an older label rather than accumulating one", () => {
    const first = withEditedCanonical(["work"], Date.UTC(2026, 8, 1));
    const second = withEditedCanonical(first, Date.UTC(2026, 8, 26));
    expect(second.filter(t => t.startsWith(EDITED_CANONICAL_TAG_PREFIX))).toEqual([`${EDITED_CANONICAL_TAG_PREFIX}2026-09-26`]);
  });

  it("returns null when the row carries no label", () => {
    expect(editedCanonicalAt(["work", "status:canonical"])).toBeNull();
  });
});

describe("every new config key has a RULES entry, and the defaults are the off values", () => {
  const KEYS = [
    "SOURCE_WEIGHT_MIRROR",
    "SOURCE_WEIGHT_TRANSCRIPT",
    "SOURCE_WEIGHT_SYSTEM",
    "MIRROR_MAX_SHARE",
    "NOTICE_COLLAPSE",
    "QUARANTINE_THRESHOLD",
    "QUARANTINE_WRITE_BURST",
    "QUARANTINE_STATUS_BURST",
  ] as const;

  it("every key is declared with a rule", () => {
    for (const key of KEYS) expect(RULES, key).toHaveProperty(key);
  });

  it("the Track 3 weights and cap default to neutral (1.0, no-op)", () => {
    expect(DEFAULTS.SOURCE_WEIGHT_MIRROR).toBe(1.0);
    expect(DEFAULTS.SOURCE_WEIGHT_TRANSCRIPT).toBe(1.0);
    expect(DEFAULTS.SOURCE_WEIGHT_SYSTEM).toBe(1.0);
    expect(DEFAULTS.MIRROR_MAX_SHARE).toBe(1.0);
  });

  it("the near-duplicate collapse defaults to off", () => {
    expect(DEFAULTS.NOTICE_COLLAPSE).toBe("off");
  });

  it("every default satisfies its own rule", () => {
    for (const key of KEYS) {
      const rule = RULES[key];
      const value = DEFAULTS[key] as number | string;
      if (rule.kind === "fixed") {
        expect(value, key).toBe(rule.value);
      } else if (rule.kind === "string") {
        expect(typeof value, key).toBe("string");
      } else {
        expect(typeof value, key).toBe("number");
        expect(value as number, key).toBeGreaterThanOrEqual(rule.min);
        expect(value as number, key).toBeLessThanOrEqual(rule.max);
      }
    }
  });
});
