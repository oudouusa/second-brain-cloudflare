/**
 * The free regex date pass (src/when/heuristic.ts), in the style of
 * src/staleness/heuristic.ts: cheap, pure, and deliberately narrow. It only
 * ever claims a date no reasonable reader would dispute — "Friday", "next
 * week", "end of month" are the model's job (src/when/pass.ts), not this
 * one's.
 */
import { describe, it, expect } from "vitest";
import { extractUnambiguousDate } from "../../src/when/heuristic";

const NOW = Date.UTC(2026, 5, 1); // June 1, 2026, local midnight

describe("extractUnambiguousDate", () => {
  it("finds an ISO date", () => {
    const at = extractUnambiguousDate("Renewal is due 2026-09-30.", NOW);
    expect(at).toBe(Date.UTC(2026, 8, 30));
  });

  it("finds a 'Month D, YYYY' date", () => {
    const at = extractUnambiguousDate("The lease ends September 30, 2026.", NOW);
    expect(at).toBe(Date.UTC(2026, 8, 30));
  });

  it("finds an abbreviated 'Mon D YYYY' date", () => {
    const at = extractUnambiguousDate("Renew by Sep 30 2026", NOW);
    expect(at).toBe(Date.UTC(2026, 8, 30));
  });

  it("finds a bare 'Month D' date and assumes the current year", () => {
    const at = extractUnambiguousDate("Party on September 30", NOW);
    expect(at).toBe(Date.UTC(2026, 8, 30));
  });

  it("finds an m/d/yyyy date", () => {
    const at = extractUnambiguousDate("Filing deadline: 9/30/2026", NOW);
    expect(at).toBe(Date.UTC(2026, 8, 30));
  });

  it("handles an ordinal suffix on the day", () => {
    const at = extractUnambiguousDate("Due September 30th, 2026", NOW);
    expect(at).toBe(Date.UTC(2026, 8, 30));
  });

  it("returns the soonest future date when several appear", () => {
    const at = extractUnambiguousDate(
      "First check-in 2026-07-15, final review 2026-09-30, retro 2026-11-01.",
      NOW,
    );
    expect(at).toBe(Date.UTC(2026, 6, 15));
  });

  it("returns null for content with no date", () => {
    expect(extractUnambiguousDate("Just a regular note about lunch.", NOW)).toBeNull();
  });

  it("returns null for a past ISO date", () => {
    expect(extractUnambiguousDate("Shipped on 2026-01-15.", NOW)).toBeNull();
  });

  it("returns null for a bare month-day that has already passed this year, without rolling to next year", () => {
    // "May 1" is before NOW (June 1, 2026). Rolling it to next year would be
    // exactly the kind of guess this pass is not supposed to make.
    expect(extractUnambiguousDate("We discussed this back on May 1.", NOW)).toBeNull();
  });

  it("does not mistake a version number for a date", () => {
    expect(extractUnambiguousDate("Shipped worker 3.4.0 today.", NOW)).toBeNull();
  });

  it("does not match a past date range like 'July 25-26' from a prior year", () => {
    expect(extractUnambiguousDate("The offsite was July 25-26, 2025.", NOW)).toBeNull();
  });

  it("ignores an invalid calendar date (February 30)", () => {
    expect(extractUnambiguousDate("Due February 30, 2026.", NOW)).toBeNull();
  });

  it("ignores an out-of-range slash date", () => {
    expect(extractUnambiguousDate("Ratio was 14/30/2026 in the report.", NOW)).toBeNull();
  });

  it("does not match a 2-digit year slash date (ambiguous)", () => {
    expect(extractUnambiguousDate("Filed 9/30/26 in the old system.", NOW)).toBeNull();
  });

  it("treats a date exactly at `now` as not future", () => {
    expect(extractUnambiguousDate("Meet at 2026-06-01.", NOW)).toBeNull();
  });

  it("finds a date one day in the future", () => {
    const at = extractUnambiguousDate("Meet at 2026-06-02.", NOW);
    expect(at).toBe(Date.UTC(2026, 5, 2));
  });

  describe("Finding 4 — whitespace-token guard", () => {
    it("does not fire on an ISO-shaped date embedded in a URL path", () => {
      expect(extractUnambiguousDate("See https://example.com/reports/2026-09-30/summary.pdf", NOW)).toBeNull();
    });

    it("does not fire on an ISO-shaped date embedded in a log/build id", () => {
      expect(extractUnambiguousDate("Deploy failed: build_id=2026-09-30-04", NOW)).toBeNull();
    });

    it("still extracts a month-name date immediately followed by terminal punctuation", () => {
      const at = extractUnambiguousDate("Renew by September 23 2026.", NOW);
      expect(at).toBe(Date.UTC(2026, 8, 23));
    });

    it("still extracts an ISO date immediately followed by a period", () => {
      const at = extractUnambiguousDate("It's due 2026-09-30.", NOW);
      expect(at).toBe(Date.UTC(2026, 8, 30));
    });

    it("does not fire when the date abuts a non-terminal character on the right", () => {
      expect(extractUnambiguousDate("Ref 2026-09-30x for the archive", NOW)).toBeNull();
    });

    it("does not fire when the date abuts a non-whitespace character on the left", () => {
      expect(extractUnambiguousDate("id=2026-09-30 in the log", NOW)).toBeNull();
    });
  });

  describe("Finding 6 — ambiguous slash dates", () => {
    it("rejects 9/10/2026 — both fields <= 12 and different, so either could be the month", () => {
      expect(extractUnambiguousDate("Filed on 9/10/2026 in the old system.", NOW)).toBeNull();
    });

    it("still accepts 9/30/2026 — 30 cannot be a month, so only one reading is valid", () => {
      const at = extractUnambiguousDate("Filing deadline: 9/30/2026", NOW);
      expect(at).toBe(Date.UTC(2026, 8, 30));
    });

    it("accepts a slash date where both fields are equal (both readings agree)", () => {
      const at = extractUnambiguousDate("Anniversary is 12/12/2026", NOW);
      expect(at).toBe(Date.UTC(2026, 11, 12));
    });
  });

  describe("timezone anchoring (src/when/timezone.ts)", () => {
    it("anchors an ISO date at midnight in the configured timezone, not UTC", () => {
      const at = extractUnambiguousDate("Renewal is due 2026-09-30.", NOW, "America/New_York");
      expect(at).toBe(Date.UTC(2026, 8, 30, 4)); // EDT, UTC-4
    });

    it("anchors a month-name date at midnight in the configured timezone", () => {
      const at = extractUnambiguousDate("The lease ends September 30, 2026.", NOW, "America/New_York");
      expect(at).toBe(Date.UTC(2026, 8, 30, 4));
    });

    it("anchors a slash date at midnight in the configured timezone", () => {
      const at = extractUnambiguousDate("Filing deadline: 9/30/2026", NOW, "America/New_York");
      expect(at).toBe(Date.UTC(2026, 8, 30, 4));
    });

    it("still rejects an invalid calendar date (February 30) with a timezone configured", () => {
      expect(extractUnambiguousDate("Due February 30, 2026.", NOW, "America/New_York")).toBeNull();
    });
  });
});
