import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseAndExpand,
  buildEventContent,
  stripConferencingBlock,
  computeCalendarPlan,
  computeRetentionPrune,
  validateCalendarUrl,
  makeCalendarProvider,
} from "../../src/integrations";
import type { Occurrence, CalendarMetaEntry, ItemMapEntry, IntegrationRecord } from "../../src/integrations";
import { makeMemoryKV } from "../helpers/make-env";

const DAY_MS = 86_400_000;
const ms = (iso: string) => Date.parse(iso);

// ── ICS fixture helpers ─────────────────────────────────────────────────────
function calendar(...veventBlocks: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN", ...veventBlocks, "END:VCALENDAR"].join(
    "\r\n",
  );
}
function vevent(lines: string[]): string {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
}

describe("parseAndExpand", () => {
  it("rejects an event-heavy feed before ical.js grouping can exhaust Free CPU", () => {
    const events = Array.from({ length: 25 }, (_, i) => vevent([
      `UID:bulk-${i}@test`,
      "DTSTART:20260710T140000Z",
      "DTEND:20260710T150000Z",
    ]));
    expect(() => parseAndExpand(
      calendar(...events),
      ms("2026-07-01T00:00:00Z"),
      ms("2026-07-31T00:00:00Z"),
    )).toThrow(/too many events/);
  });

  it("counts lowercase component names in the pre-parse complexity gate", () => {
    const events = Array.from({ length: 25 }, (_, i) => vevent([
      `UID:lower-${i}@test`,
      "DTSTART:20260710T140000Z",
      "DTEND:20260710T150000Z",
    ]).replace(/BEGIN:VEVENT|END:VEVENT/g, value => value.toLowerCase()));
    expect(() => parseAndExpand(
      calendar(...events),
      ms("2026-07-01T00:00:00Z"),
      ms("2026-07-31T00:00:00Z"),
    )).toThrow(/too many events/);
  });

  it("rejects an ancient high-frequency recurrence without walking from DTSTART", () => {
    const ics = calendar(vevent([
      "UID:ancient-daily@test",
      "DTSTART:20100101T090000Z",
      "DTEND:20100101T100000Z",
      "RRULE:FREQ=DAILY",
    ]));
    expect(() => parseAndExpand(
      ics,
      ms("2026-07-01T00:00:00Z"),
      ms("2026-07-31T00:00:00Z"),
    )).toThrow(/Free-plan CPU budget/);
  });

  it("rejects Cartesian BY* expansion before asking ical.js for an occurrence", () => {
    const allHours = Array.from({ length: 24 }, (_, i) => i).join(",");
    const allMinutes = Array.from({ length: 60 }, (_, i) => i).join(",");
    const allSeconds = Array.from({ length: 60 }, (_, i) => i).join(",");
    const ics = calendar(vevent([
      "UID:cartesian@test",
      "DTSTART:20260827T000000Z",
      "DTEND:20260827T010000Z",
      `RRULE:FREQ=DAILY;BYHOUR=${allHours};BYMINUTE=${allMinutes};BYSECOND=${allSeconds}`,
    ]));

    expect(() => parseAndExpand(
      ics,
      ms("2026-08-27T00:00:00Z"),
      ms("2026-09-26T00:00:00Z"),
    )).toThrow(/recurrence rule.*Free-plan CPU budget/);
  });

  it("rejects a large BYSETPOS list before ical.js parses the recurrence", () => {
    const positions = Array.from({ length: 733 }, (_, index) => (index % 366) + 1).join(",");
    const ics = calendar(vevent([
      "UID:bysetpos@test",
      "DTSTART:20260827T000000Z",
      "DTEND:20260827T010000Z",
      `RRULE:FREQ=DAILY;BYHOUR=0;BYSETPOS=${positions}`,
    ]));
    expect(() => parseAndExpand(
      ics,
      ms("2026-08-27T00:00:00Z"),
      ms("2026-09-26T00:00:00Z"),
    )).toThrow(/recurrence rule exceeds the Free-plan CPU budget/);
  });

  it.each(["SECONDLY", "MINUTELY", "HOURLY"])(
    "rejects %s recurrence before iterator expansion",
    (frequency) => {
      const ics = calendar(vevent([
        `UID:${frequency.toLowerCase()}@test`,
        "DTSTART:20260827T000000Z",
        "DTEND:20260827T000100Z",
        `RRULE:FREQ=${frequency};COUNT=10`,
      ]));

      expect(() => parseAndExpand(
        ics,
        ms("2026-08-27T00:00:00Z"),
        ms("2026-09-26T00:00:00Z"),
      )).toThrow(/frequency exceeds the Free-plan CPU budget/);
    },
  );

  it("bounds and reuses a large folded description across daily occurrences", () => {
    const foldedDescription = Array.from({ length: 400 }, () => "x".repeat(70)).join("\r\n ");
    const ics = calendar(vevent([
      "UID:large-description@test",
      "DTSTART:20260827T000000Z",
      "DTEND:20260827T010000Z",
      "RRULE:FREQ=DAILY;COUNT=24",
      `DESCRIPTION:${foldedDescription}`,
    ]));

    const occurrences = parseAndExpand(
      ics,
      ms("2026-08-27T00:00:00Z"),
      ms("2026-09-20T00:00:00Z"),
    );
    expect(occurrences).toHaveLength(24);
    expect(occurrences.every(occurrence => occurrence.description.length === 4000)).toBe(true);
  });

  it("enforces one recurrence-iterator budget across the whole document", () => {
    const series = Array.from({ length: 10 }, (_, i) => vevent([
      `UID:many-series-${i}@test`,
      "DTSTART:20260330T090000Z",
      "DTEND:20260330T100000Z",
      "RRULE:FREQ=DAILY;COUNT=145",
    ]));
    expect(() => parseAndExpand(
      calendar(...series),
      ms("2026-08-25T00:00:00Z"),
      ms("2026-09-26T00:00:00Z"),
    )).toThrow(/document exceeds the Free-plan CPU budget/);
  });

  it("returns a single timed event inside the window", () => {
    const ics = calendar(
      vevent([
        "UID:single-1@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260710T140000Z",
        "DTEND:20260710T150000Z",
        "SUMMARY:Team Meeting",
      ]),
    );
    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));
    expect(occs).toHaveLength(1);
    const occ = occs[0];
    expect(occ.summary).toBe("Team Meeting");
    expect(occ.uid).toBe("single-1@test");
    expect(occ.key).toBe("single-1@test");
    expect(occ.start).toBe(ms("2026-07-10T14:00:00Z"));
    expect(occ.end).toBe(ms("2026-07-10T15:00:00Z"));
    expect(occ.isRecurring).toBe(false);
    expect(occ.allDay).toBe(false);
  });

  it("marks a DATE-valued DTSTART as an all-day event", () => {
    const ics = calendar(
      vevent([
        "UID:allday-1@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART;VALUE=DATE:20260715",
        "DTEND;VALUE=DATE:20260716",
        "SUMMARY:Company Holiday",
      ]),
    );
    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));
    expect(occs).toHaveLength(1);
    expect(occs[0].allDay).toBe(true);
  });

  it("expands a weekly RRULE to only the in-window instances", () => {
    // Master starts 2026-06-01 (well before the window), weekly on Mondays.
    const ics = calendar(
      vevent([
        "UID:weekly-1@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260601T100000Z",
        "DTEND:20260601T110000Z",
        "RRULE:FREQ=WEEKLY;COUNT=20",
        "SUMMARY:Standup",
      ]),
    );
    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));
    // Mondays in July 2026 within [07-01, 07-31): 07-06, 07-13, 07-20, 07-27.
    expect(occs).toHaveLength(4);
    const starts = occs.map((o) => new Date(o.start).toISOString()).sort();
    expect(starts).toEqual([
      "2026-07-06T10:00:00.000Z",
      "2026-07-13T10:00:00.000Z",
      "2026-07-20T10:00:00.000Z",
      "2026-07-27T10:00:00.000Z",
    ]);
    for (const o of occs) {
      expect(o.isRecurring).toBe(true);
      expect(o.uid).toBe("weekly-1@test");
      expect(o.key).toBe(`weekly-1@test::${new Date(o.start).toISOString()}`);
    }
  });

  it("omits an instance removed by EXDATE", () => {
    const ics = calendar(
      vevent([
        "UID:weekly-2@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260601T100000Z",
        "DTEND:20260601T110000Z",
        "RRULE:FREQ=WEEKLY;COUNT=20",
        "EXDATE:20260713T100000Z",
        "SUMMARY:Standup",
      ]),
    );
    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));
    const starts = occs.map((o) => new Date(o.start).toISOString());
    expect(starts).not.toContain("2026-07-13T10:00:00.000Z");
    expect(starts).toEqual([
      "2026-07-06T10:00:00.000Z",
      "2026-07-20T10:00:00.000Z",
      "2026-07-27T10:00:00.000Z",
    ]);
  });

  it("excludes a single event with STATUS:CANCELLED", () => {
    const ics = calendar(
      vevent([
        "UID:cancelled-1@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260710T140000Z",
        "DTEND:20260710T150000Z",
        "STATUS:CANCELLED",
        "SUMMARY:Cancelled Meeting",
      ]),
    );
    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));
    expect(occs).toEqual([]);
  });

  it("does not let one series' RECURRENCE-ID override contaminate another series (cross-series isolation)", () => {
    const ics = calendar(
      vevent([
        "UID:series-A@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260601T100000Z",
        "DTEND:20260601T110000Z",
        "RRULE:FREQ=WEEKLY;COUNT=10",
        "SUMMARY:Series A",
      ]),
      vevent([
        "UID:series-A@test",
        "RECURRENCE-ID:20260706T100000Z",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260706T120000Z",
        "DTEND:20260706T130000Z",
        "SUMMARY:Series A (moved)",
      ]),
      vevent([
        "UID:series-B@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260601T100000Z",
        "DTEND:20260601T110000Z",
        "RRULE:FREQ=WEEKLY;COUNT=10",
        "SUMMARY:Series B",
      ]),
    );
    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));

    const seriesA = occs.filter((o) => o.uid === "series-A@test");
    const seriesB = occs.filter((o) => o.uid === "series-B@test");
    expect(seriesA).toHaveLength(4);
    expect(seriesB).toHaveLength(4);

    // Series A's July 6th instance is the override: moved to 12:00 with a new summary.
    const overridden = seriesA.find((o) => new Date(o.start).toISOString() === "2026-07-06T12:00:00.000Z");
    expect(overridden?.summary).toBe("Series A (moved)");

    // Series B keeps its own summary at every instance, including the same calendar
    // date — it must NOT pick up series A's override.
    expect(seriesB.every((o) => o.summary === "Series B")).toBe(true);
    const seriesBJuly6 = seriesB.find((o) => new Date(o.start).toISOString() === "2026-07-06T10:00:00.000Z");
    expect(seriesBJuly6?.summary).toBe("Series B");
  });

  it("emits a lone RECURRENCE-ID override with no master as a standalone occurrence, without throwing", () => {
    const ics = calendar(
      vevent([
        "UID:orphan-1@test",
        "RECURRENCE-ID:20260706T100000Z",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260706T120000Z",
        "DTEND:20260706T130000Z",
        "SUMMARY:Orphan Instance",
      ]),
    );
    let occs: Occurrence[] = [];
    expect(() => {
      occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));
    }).not.toThrow();
    expect(occs).toHaveLength(1);
    expect(occs[0]).toMatchObject({
      key: "orphan-1@test",
      uid: "orphan-1@test",
      isRecurring: false,
      summary: "Orphan Instance",
    });
  });

  // Proves the stripper is wired into the parse path, not merely exported and
  // unit-tested. Without this a neutered call site keeps every unit test green.
  it("strips the conferencing block from a parsed event description", () => {
    const ics = calendar(
      vevent([
        "UID:conf-1@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260710T140000Z",
        "DTEND:20260710T150000Z",
        "SUMMARY:Roadmap Review",
        "DESCRIPTION:Agenda: pricing then Q3.\\n\\nJoin Zoom Meeting\\nhttps://example.zoom.us/j/1\\nMeeting ID: 123 456 7890\\nPasscode: 999999",
      ]),
    );

    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));

    expect(occs).toHaveLength(1);
    expect(occs[0].description).toBe("Agenda: pricing then Q3.");
    expect(occs[0].description).not.toContain("Zoom");
    expect(occs[0].description).not.toContain("Passcode");
  });

  it("does not return an event entirely outside the window", () => {
    const ics = calendar(
      vevent([
        "UID:outside-1@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20250101T140000Z",
        "DTEND:20250101T150000Z",
        "SUMMARY:Long Ago",
      ]),
    );
    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));
    expect(occs).toEqual([]);
  });

  // ── The reach bound (#290) ──────────────────────────────────────────────
  // The walk rejects spent occurrences from the iterator's own time so it does
  // not have to build them, which is where the expansion's CPU went. These are
  // the two cases where an occurrence whose recurrence time is BEFORE the
  // window is nonetheless in it — i.e. exactly what a naive start-time skip
  // would silently drop.

  it("keeps a long-running instance that began before the window and is still running", () => {
    const ics = calendar(
      vevent([
        "UID:long-run@test",
        "DTSTAMP:20260101T000000Z",
        // Weekly nine-day event: the instance starting 2026-06-29 runs to 07-08,
        // so it overlaps a window that opens on 07-01 despite starting before it.
        "DTSTART:20260105T090000Z",
        "DTEND:20260114T170000Z",
        "RRULE:FREQ=WEEKLY",
        "SUMMARY:Long Conference",
      ]),
    );
    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-02T00:00:00Z"));
    expect(occs.length).toBeGreaterThan(0);
    expect(occs.every(o => o.summary === "Long Conference")).toBe(true);
    // At least one of them started before the window opened.
    expect(occs.some(o => o.start < ms("2026-07-01T00:00:00Z"))).toBe(true);
  });

  // The bound is measured in absolute milliseconds; ical.js builds occurrences by
  // adding a WALL-CLOCK duration in the event's own zone. These two cases are
  // where those disagree. Both need a constructed calendar — a fuzz run over
  // random windows practically never lands in the affected band.
  const NEW_YORK_VTIMEZONE = [
    "BEGIN:VTIMEZONE",
    "TZID:America/New_York",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:-0500",
    "TZOFFSETTO:-0400",
    "TZNAME:EDT",
    "DTSTART:19700308T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:-0400",
    "TZOFFSETTO:-0500",
    "TZNAME:EST",
    "DTSTART:19701101T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
  ].join("\r\n");

  it("keeps an instance that runs long because it spans a fall-back transition", () => {
    // Weekly Sat 23:00–01:00 New York: two hours on the wall. The instance
    // starting 2024-11-02 23:00 EDT ends at an 01:00 that happens twice, so it
    // runs THREE absolute hours — an hour past where a wall-clock bound lands.
    const ics = calendar(
      NEW_YORK_VTIMEZONE,
      vevent([
        "UID:fallback@test",
        "DTSTAMP:20240101T000000Z",
        "DTSTART;TZID=America/New_York:20241005T230000",
        "DTEND;TZID=America/New_York:20241006T010000",
        "RRULE:FREQ=WEEKLY",
        "SUMMARY:Late Show",
      ]),
    );
    // Window opens 2.5h into that occurrence — inside the hour it is still
    // running but a two-hour bound has already written off.
    const occs = parseAndExpand(ics, ms("2024-11-03T05:30:00Z"), ms("2024-11-03T12:00:00Z"));
    expect(occs.map(o => o.start)).toContain(ms("2024-11-03T03:00:00Z"));
  });

  // The single case above is one point inside one band. This sweeps the whole
  // transition weekend against a reference expansion that cannot skip anything
  // (its window opens a month earlier), which is the property that actually
  // matters: the skip must never change the result, whatever minute the window
  // happens to open on. A bound short by any amount fails here.
  it("stays exact whichever instant the window opens on around a DST transition", () => {
    const ics = calendar(
      NEW_YORK_VTIMEZONE,
      vevent([
        "UID:evening@test", "DTSTAMP:20240101T000000Z",
        "DTSTART;TZID=America/New_York:20240106T230000",
        "DTEND;TZID=America/New_York:20240107T010000",
        "RRULE:FREQ=WEEKLY", "SUMMARY:Late Show",
      ]),
      // Master straddling the spring-forward gap: two hours on the wall, one
      // absolute, so the whole series is bounded off that shorter measurement.
      vevent([
        "UID:gap-master@test", "DTSTAMP:20240101T000000Z",
        "DTSTART;TZID=America/New_York:20240310T013000",
        "DTEND;TZID=America/New_York:20240310T033000",
        "RRULE:FREQ=WEEKLY", "SUMMARY:Sunday Session",
      ]),
      // An hour that lands inside the repeated hour itself.
      vevent([
        "UID:repeated-hour@test", "DTSTAMP:20240101T000000Z",
        "DTSTART;TZID=America/New_York:20240107T013000",
        "DTEND;TZID=America/New_York:20240107T023000",
        "RRULE:FREQ=WEEKLY", "SUMMARY:Small Hours",
      ]),
    );
    const windowEnd = ms("2024-11-10T00:00:00Z");
    const reference = parseAndExpand(ics, ms("2024-10-01T00:00:00Z"), windowEnd);
    expect(reference.length).toBeGreaterThan(0);

    // A skip bound fails only where an occurrence still running at the window's
    // start is written off, so the sharp instants are each occurrence's start
    // and the moment just before and at its end, plus the 06:00Z transition
    // itself. Sweeping every minute between them re-parses the calendar ~180
    // times for no extra coverage.
    const nearTransition = reference.filter(o => o.end >= ms("2024-10-27T00:00:00Z"));
    expect(nearTransition.length).toBeGreaterThan(0);
    const opens = new Set([
      ...nearTransition.flatMap(o => [o.start, o.end - 1, o.end, o.end + 1]),
      ms("2024-11-03T06:00:00Z") - 1, ms("2024-11-03T06:00:00Z"), ms("2024-11-03T06:00:00Z") + 1,
    ]);
    for (const t of opens) {
      // parseAndExpand keeps an occurrence when it has not yet ended at the
      // window's start, so the reference filtered by that rule is the answer.
      const expected = reference.filter(o => o.end >= t).map(o => o.key).sort();
      const actual = parseAndExpand(ics, t, windowEnd).map(o => o.key).sort();
      expect(actual, `window opening ${new Date(t).toISOString()}`).toEqual(expected);
    }
  }, 15_000);

  it("keeps an instance an override moved forward into the window", () => {
    const ics = calendar(
      vevent([
        "UID:moved@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260601T090000Z",
        "DTEND:20260601T100000Z",
        "RRULE:FREQ=WEEKLY",
        "SUMMARY:Standup",
      ]),
      vevent([
        "UID:moved@test",
        // Nominally 2026-06-22, three weeks before the window — but pushed out
        // to 2026-07-10, which is inside it.
        "RECURRENCE-ID:20260622T090000Z",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260710T090000Z",
        "DTEND:20260710T100000Z",
        "SUMMARY:Standup (moved)",
      ]),
    );
    const occs = parseAndExpand(ics, ms("2026-07-09T00:00:00Z"), ms("2026-07-11T00:00:00Z"));
    expect(occs.map(o => o.summary)).toContain("Standup (moved)");
  });
});

describe("computeCalendarPlan", () => {
  function occ(overrides: Partial<Occurrence>): Occurrence {
    return {
      key: "k1",
      uid: "u1",
      isRecurring: false,
      summary: "Event",
      start: ms("2026-07-10T14:00:00Z"),
      end: ms("2026-07-10T15:00:00Z"),
      allDay: false,
      location: "",
      description: "",
      version: "v1",
      ...overrides,
    };
  }
  const itemMap = (entries: Record<string, string>): Record<string, ItemMapEntry> =>
    Object.fromEntries(Object.entries(entries).map(([key, version]) => [key, { entryId: `e-${key}`, version }]));

  it("treats an occurrence unseen in itemMap as changed", () => {
    const plan = computeCalendarPlan([occ({ key: "new-1" })], {}, {}, ms("2026-07-01T00:00:00Z"));
    expect(plan.changed.map((o) => o.key)).toEqual(["new-1"]);
    expect(plan.deletedKeys).toEqual([]);
  });

  it("treats a version mismatch as changed and a matching version as unchanged", () => {
    const map = itemMap({ same: "v1", stale: "v-old" });
    const plan = computeCalendarPlan(
      [occ({ key: "same", version: "v1" }), occ({ key: "stale", version: "v-new" })],
      map,
      {},
      ms("2026-07-01T00:00:00Z"),
    );
    expect(plan.changed.map((o) => o.key)).toEqual(["stale"]);
  });

  it("sorts changed occurrences by start ascending", () => {
    const plan = computeCalendarPlan(
      [
        occ({ key: "later", version: "v1", start: ms("2026-07-20T00:00:00Z") }),
        occ({ key: "earlier", version: "v1", start: ms("2026-07-05T00:00:00Z") }),
      ],
      {},
      {},
      ms("2026-07-01T00:00:00Z"),
    );
    expect(plan.changed.map((o) => o.key)).toEqual(["earlier", "later"]);
  });

  it("deletes an itemMap key missing from occurrences when it was upcoming (cancelled-upcoming)", () => {
    const map = itemMap({ gone: "v1" });
    const meta: Record<string, CalendarMetaEntry> = {
      gone: { start: ms("2026-08-01T00:00:00Z"), end: ms("2026-08-01T01:00:00Z"), isRecurring: false },
    };
    const plan = computeCalendarPlan([], map, meta, ms("2026-07-15T00:00:00Z"));
    expect(plan.deletedKeys).toEqual(["gone"]);
  });

  it("keeps (does not delete) an itemMap key missing from occurrences when it already happened", () => {
    const map = itemMap({ aged: "v1" });
    const meta: Record<string, CalendarMetaEntry> = {
      aged: { start: ms("2026-07-01T00:00:00Z"), end: ms("2026-07-01T01:00:00Z"), isRecurring: false },
    };
    const plan = computeCalendarPlan([], map, meta, ms("2026-07-15T00:00:00Z"));
    expect(plan.deletedKeys).toEqual([]);
  });

  it("treats an occurrence with inherited-name key as changed (new work) and does not delete it", () => {
    const plan = computeCalendarPlan([occ({ key: "constructor" })], {}, {}, ms("2026-07-01T00:00:00Z"));
    expect(plan.changed.map((o) => o.key)).toEqual(["constructor"]);
    expect(plan.deletedKeys).toEqual([]);
  });

  it("a legitimate own-property entry with key 'constructor' and matching version is not marked changed", () => {
    const map = itemMap({ constructor: "v1" });
    const plan = computeCalendarPlan([occ({ key: "constructor", version: "v1" })], map, {}, ms("2026-07-01T00:00:00Z"));
    expect(plan.changed.map((o) => o.key)).toEqual([]);
  });
});

describe("computeRetentionPrune", () => {
  const RETENTION = 180 * DAY_MS;

  it("keeps a one-off that ended within retentionMs and prunes one older than retentionMs", () => {
    const now = ms("2026-07-23T00:00:00Z");
    const meta: Record<string, CalendarMetaEntry> = {
      recent: { start: now - 10 * DAY_MS - 3600_000, end: now - 10 * DAY_MS, isRecurring: false },
      ancient: { start: now - 200 * DAY_MS - 3600_000, end: now - 200 * DAY_MS, isRecurring: false },
    };
    const pruned = computeRetentionPrune(meta, now, { retentionMs: RETENTION, recurringRetentionMs: null });
    expect(pruned).not.toContain("recent");
    expect(pruned).toContain("ancient");
  });

  it("never prunes an entry that hasn't ended yet", () => {
    const now = ms("2026-07-23T00:00:00Z");
    const meta: Record<string, CalendarMetaEntry> = {
      future: { start: now + DAY_MS, end: now + 2 * DAY_MS, isRecurring: false },
    };
    const pruned = computeRetentionPrune(meta, now, { retentionMs: RETENTION, recurringRetentionMs: null });
    expect(pruned).toEqual([]);
  });

  it("with recurringRetentionMs:0, prunes a past recurring instance immediately but keeps a past one-off within retentionMs", () => {
    const now = ms("2026-07-23T00:00:00Z");
    const meta: Record<string, CalendarMetaEntry> = {
      pastRecurring: { start: now - 2 * 3600_000, end: now - 3600_000, isRecurring: true },
      pastOneOff: { start: now - 2 * 3600_000, end: now - 3600_000, isRecurring: false },
    };
    const pruned = computeRetentionPrune(meta, now, { retentionMs: RETENTION, recurringRetentionMs: 0 });
    expect(pruned).toContain("pastRecurring");
    expect(pruned).not.toContain("pastOneOff");
  });

  it("with recurringRetentionMs:null, a past recurring entry uses retentionMs instead", () => {
    const now = ms("2026-07-23T00:00:00Z");
    const meta: Record<string, CalendarMetaEntry> = {
      pastRecurring: { start: now - 2 * 3600_000, end: now - 3600_000, isRecurring: true },
    };
    const pruned = computeRetentionPrune(meta, now, { retentionMs: RETENTION, recurringRetentionMs: null });
    expect(pruned).toEqual([]); // only 1 hour old, well within the 180-day retentionMs horizon
  });
});

// The calendar twin of the email trailer problem. A conferencing block is
// templated, so it repeats on every event from every organiser, and a recurring
// meeting repeats it on every occurrence — the same text embedded dozens of
// times. It is also pure navigation: dial-in numbers and a join URL say nothing
// about what the meeting is for.
describe("stripConferencingBlock", () => {
  it("drops a Zoom join block and keeps the agenda", () => {
    const description = [
      "Agenda: pricing review, then Q3 planning.",
      "",
      "Join Zoom Meeting",
      "https://example.zoom.us/j/1234567890?pwd=abc",
      "",
      "Meeting ID: 123 456 7890",
      "Passcode: 123456",
      "",
      "One tap mobile",
      "+13120000000,,1234567890# US (Chicago)",
      "",
      "Dial by your location",
      "+1 312 000 0000 US (Chicago)",
      "Find your local number: https://example.zoom.us/u/abc",
    ].join("\n");

    expect(stripConferencingBlock(description)).toBe("Agenda: pricing review, then Q3 planning.");
  });

  it("drops a Teams join block", () => {
    const description = [
      "Weekly sync. Bring the migration numbers.",
      "________________________________________________________________________________",
      "Microsoft Teams meeting",
      "Join on your computer, mobile app or room device",
      "Click here to join the meeting",
      "Meeting ID: 123 456 789 012",
      "Passcode: abc123",
      "Learn more | Meeting options",
      "________________________________________________________________________________",
    ].join("\n");

    expect(stripConferencingBlock(description)).toBe("Weekly sync. Bring the migration numbers.");
  });

  it("drops a Google Meet join block", () => {
    const description = [
      "Design review for the new onboarding flow.",
      "",
      "Join with Google Meet: https://meet.example.com/abc-defg-hij",
      "Or dial: (US) +1 234 000 0000 PIN: 123456789#",
      "More phone numbers: https://tel.example.com/abc-defg-hij",
    ].join("\n");

    expect(stripConferencingBlock(description)).toBe("Design review for the new onboarding flow.");
  });

  it("keeps a description with no conferencing block", () => {
    const description = "Bring the Q3 numbers and last month's churn breakdown.";
    expect(stripConferencingBlock(description)).toBe(description);
  });

  it("keeps a description that merely mentions a meeting", () => {
    const description = "We should join the pricing meeting before deciding.";
    expect(stripConferencingBlock(description)).toBe(description);
  });
});

describe("buildEventContent", () => {
  function occ(overrides: Partial<Occurrence>): Occurrence {
    return {
      key: "k1",
      uid: "u1",
      isRecurring: false,
      summary: "Team Sync",
      start: ms("2026-07-10T14:00:00Z"),
      end: ms("2026-07-10T15:00:00Z"),
      allDay: false,
      location: "",
      description: "",
      version: "v1",
      ...overrides,
    };
  }

  it("leads with the summary as a heading", () => {
    const content = buildEventContent(occ({}));
    expect(content.startsWith("# Team Sync\n")).toBe(true);
  });

  it("shows the UTC date/time range for a timed event", () => {
    const content = buildEventContent(occ({}));
    expect(content).toContain("2026-07-10 14:00 UTC–15:00 UTC");
  });

  it("shows (all day) for an all-day event instead of a time range", () => {
    const content = buildEventContent(
      occ({ allDay: true, start: ms("2026-07-15T00:00:00Z"), end: ms("2026-07-16T00:00:00Z") }),
    );
    expect(content).toContain("2026-07-15 (all day)");
    expect(content).not.toContain("UTC–");
  });

  it("includes a location line with a pin marker only when location is present", () => {
    const withLocation = buildEventContent(occ({ location: "Room 5" }));
    expect(withLocation).toContain("📍 Room 5");

    const withoutLocation = buildEventContent(occ({ location: "" }));
    expect(withoutLocation).not.toContain("📍");
  });

  it("appends the description only when present", () => {
    const withDescription = buildEventContent(occ({ description: "Discuss roadmap" }));
    expect(withDescription).toContain("Discuss roadmap");

    const withoutDescription = buildEventContent(occ({ description: "" }));
    expect(withoutDescription.trim().endsWith("Discuss roadmap")).toBe(false);
    expect(withoutDescription).toBe("# Team Sync\n2026-07-10 14:00 UTC–15:00 UTC");
  });
});

describe("validateCalendarUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(
    impl: (
      url: string,
      init?: RequestInit,
    ) => { ok: boolean; status: number; text: () => Promise<string> },
  ) {
    const fn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => impl(url, init));
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  const icsHeaders = expect.objectContaining({
    method: "GET",
    redirect: "follow",
    headers: expect.objectContaining({
      Accept: "text/calendar, text/plain, */*",
      "User-Agent": "CalendarAgent/1.0 SecondBrain/2",
    }),
  });

  it("normalizes webcal:// to https:// and resolves the X-WR-CALNAME as the label", async () => {
    const fetchMock = stubFetch(() => ({
      ok: true,
      status: 200,
      text: async () =>
        ["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:My Cal", "PRODID:-//Test//Test//EN", "END:VCALENDAR"].join(
          "\r\n",
        ),
    }));
    const label = await validateCalendarUrl("webcal://example.com/cal.ics");
    expect(label).toBe("My Cal");
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/cal.ics", icsHeaders);
    // Never probe with HEAD — Apple's published calendars return 400 to HEAD.
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.method).not.toBe("HEAD");
    }
  });

  it("accepts an iCloud published URL without a .ics extension (GET-only + UA)", async () => {
    const fetchMock = stubFetch(() => ({
      ok: true,
      status: 200,
      text: async () =>
        [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "PRODID:-//caldav.icloud.com//CALDAVJ//EN",
          "X-WR-CALNAME:Family",
          "END:VCALENDAR",
        ].join("\r\n"),
    }));
    const label = await validateCalendarUrl("webcal://p12-caldav.icloud.com/published/2/token");
    expect(label).toBe("Family");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://p12-caldav.icloud.com/published/2/token",
      icsHeaders,
    );
  });

  it("retries pNN-caldav.icloud.com on pNN-calendars.icloud.com when the first body is not ICS", async () => {
    const fetchMock = stubFetch((url) => {
      if (url.includes("-caldav.")) {
        return { ok: false, status: 400, text: async () => "" };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          ["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:Retried Cal", "END:VCALENDAR"].join("\r\n"),
      };
    });
    const label = await validateCalendarUrl("https://p55-caldav.icloud.com/published/2/abc");
    expect(label).toBe("Retried Cal");
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "https://p55-caldav.icloud.com/published/2/abc",
      "https://p55-calendars.icloud.com/published/2/abc",
    ]);
  });

  it("retries when caldav returns 200 HTML and calendars returns ICS", async () => {
    stubFetch((url) => {
      if (url.includes("-caldav.")) {
        return { ok: true, status: 200, text: async () => "<html>nope</html>" };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          ["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:From Calendars Host", "END:VCALENDAR"].join("\r\n"),
      };
    });
    await expect(validateCalendarUrl("https://p7-caldav.icloud.com/published/2/tok")).resolves.toBe(
      "From Calendars Host",
    );
  });

  it("strips a leading UTF-8 BOM before validating", async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      text: async () =>
        "\uFEFF" +
        ["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:BOM Cal", "END:VCALENDAR"].join("\r\n"),
    }));
    await expect(validateCalendarUrl("https://example.com/cal.ics")).resolves.toBe("BOM Cal");
  });

  it("falls back to the URL host when there is no X-WR-CALNAME", async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      text: async () => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN", "END:VCALENDAR"].join("\r\n"),
    }));
    const label = await validateCalendarUrl("https://cal.example.org/feed.ics");
    expect(label).toBe("cal.example.org");
  });

  it("rejects with a user-facing error on a non-2xx response", async () => {
    stubFetch(() => ({ ok: false, status: 404, text: async () => "not found" }));
    await expect(validateCalendarUrl("https://example.com/missing.ics")).rejects.toThrow(
      /Couldn't reach that calendar link/,
    );
  });

  it("rejects when the body is not an iCal document", async () => {
    stubFetch(() => ({ ok: true, status: 200, text: async () => "<html><body>not a calendar</body></html>" }));
    await expect(validateCalendarUrl("https://example.com/page.html")).rejects.toThrow(
      /didn't return a calendar/,
    );
  });

  it("uses a distinct error when BEGIN:VCALENDAR is present but still unparseable after sanitization", async () => {
    // Truncated mid-component: looks like ICS but cannot form a closed VCALENDAR.
    stubFetch(() => ({
      ok: true,
      status: 200,
      text: async () => ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "SUMMARY:Broken"].join("\r\n"),
    }));
    await expect(validateCalendarUrl("https://example.com/broken.ics")).rejects.toThrow(
      /couldn't be parsed/i,
    );
  });
});

describe("parseAndExpand Apple ICS quirks", () => {
  it("still emits the event when X-APPLE-STRUCTURED-LOCATION has a non-indented continuation", () => {
    // Real-world Apple bug: address continuation lacks a leading space, which
    // makes strict parsers throw "invalid line (no token ; or :)" and sink the
    // whole feed. Second Brain must strip/ignore that property and keep the event.
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//caldav.icloud.com//CALDAVJ//EN",
      "BEGIN:VEVENT",
      "UID:apple-loc@test",
      "DTSTAMP:20260101T000000Z",
      "DTSTART:20260710T140000Z",
      "DTEND:20260710T150000Z",
      "SUMMARY:Office Dinner",
      'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS="123 Main Street',
      "Seattle WA 98101",
      '";X-TITLE=123 Main Street:geo:47.6,-122.3',
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));
    expect(occs).toHaveLength(1);
    expect(occs[0]).toMatchObject({
      uid: "apple-loc@test",
      summary: "Office Dinner",
    });
  });

  it("still emits the event when a bare orphan line is not attached to X-APPLE-STRUCTURED-LOCATION", () => {
    // ical.js throws "invalid line (no token ; or :)" on a content line with
    // neither delimiter. stripAppleStructuredLocation does not touch this
    // feed, so only dropOrphanIcsLines can recover it.
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//caldav.icloud.com//CALDAVJ//EN",
      "BEGIN:VEVENT",
      "UID:orphan-bare@test",
      "DTSTAMP:20260101T000000Z",
      "DTSTART:20260710T140000Z",
      "DTEND:20260710T150000Z",
      "SUMMARY:Team Sync",
      "Seattle WA 98101",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));
    expect(occs).toHaveLength(1);
    expect(occs[0]).toMatchObject({
      uid: "orphan-bare@test",
      summary: "Team Sync",
    });
  });
});

describe("makeCalendarProvider sync (happy path)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function toIcsUtc(epochMs: number): string {
    return new Date(epochMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  }

  it("creates one mirror entry from a connected feed with one upcoming event", async () => {
    const now = Date.now();
    const start = now + 5 * DAY_MS;
    const end = start + 3600_000;
    const ics = calendar(
      vevent([
        "UID:sync-event-1@test",
        `DTSTAMP:${toIcsUtc(now)}`,
        `DTSTART:${toIcsUtc(start)}`,
        `DTEND:${toIcsUtc(end)}`,
        "SUMMARY:Upcoming Event",
      ]),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => ics }),
    );

    const kv = makeMemoryKV();
    const record: IntegrationRecord = {
      provider: "calendar-google",
      authKind: "token",
      credentials: { token: "https://cal.example/x.ics" },
      config: {},
      status: "connected",
      workspaceName: "My Cal",
      lastSyncedAt: null,
      lastSyncError: null,
      itemMap: {},
      createdAt: 0,
      updatedAt: 0,
    };
    await kv.put("integrations:calendar-google", JSON.stringify(record));

    const created: Array<{ content: string; tags: string[]; source: string }> = [];
    const store = {
      createEntry: vi.fn().mockImplementation(async (content: string, tags: string[], source: string) => {
        created.push({ content, tags, source });
        return "entry-fake-1";
      }),
      updateEntry: vi.fn().mockResolvedValue(true),
      deleteEntry: vi.fn().mockResolvedValue(undefined),
    };

    const provider = makeCalendarProvider({
      id: "calendar-google",
      name: "Google Calendar",
      connectLabel: "",
      connectPlaceholder: "",
      connectHint: "",
    });

    const outcome = await provider.sync({ OAUTH_KV: kv }, store);

    expect(outcome).toMatchObject({ ok: true, created: 1, updated: 0, failed: 0, deleted: 0, total: 1 });
    expect(store.createEntry).toHaveBeenCalledTimes(1);
    expect(created[0].tags).toEqual(["calendar", "calendar-google"]);
    expect(created[0].source).toBe("calendar-google");
    expect(created[0].content).toContain("# Upcoming Event");

    const saved = JSON.parse((await kv.get("integrations:calendar-google")) as string);
    expect(saved.itemMap["sync-event-1@test"]).toMatchObject({ entryId: "entry-fake-1" });
    expect(saved.status).toBe("connected");
    expect(saved.lastSyncedAt).not.toBeNull();
  });
});
