import { BodyTooLargeError, readBoundedResponseText } from "../lib/body";
/**
 * Second Brain — Calendar provider (iCal .ics).
 *
 * Read-only. Connects each provider's SECRET iCal subscription URL (Gmail's
 * "Secret address in iCal format", Outlook's published ICS link, iCloud's
 * shared webcal URL) — not CalDAV, not OAuth. One HTTPS GET per sync (two for
 * iCloud published feeds when the `caldav` host misses and the `calendars`
 * fallback is used); ical.js expands recurrences; qualifying occurrences
 * mirror into memory. Upcoming events are live-mirrored (cancellations
 * delete); past events freeze into a bounded historical log.
 */

import ICAL from "ical.js";
import type {
  IntegrationEnv,
  IntegrationProvider,
  IntegrationRecord,
  ItemMapEntry,
  MirrorStore,
  SyncOutcome,
} from "./framework";
import { ItemMapDeltas, loadIntegration, updateIntegration } from "./framework";

// ── Tunable constants ──────────────────────────────────────────────────────
const DAY_MS = 86_400_000;
export const FUTURE_WINDOW_MS = 30 * DAY_MS; // how far ahead to mirror
export const PAST_LOOKBACK_MS = 2 * DAY_MS;  // shallow: the log builds forward from connect
export const RETENTION_MS = 180 * DAY_MS;    // hard bound on kept history
// P1: past recurring instances (e.g. a daily standup) age out as soon as they're
// past, so they don't accumulate as low-value memories; one-off past events still
// keep the full RETENTION_MS as historical memory.
export const RECURRING_RETENTION_MS: number | null = 0;
// Create/update ceiling per batch. The budget that binds here is D1's — 50
// queries per Worker invocation on the free plan — not the one outbound fetch
// per sync this used to be justified by, which is how the real cost went
// unnoticed (#290). Durable vector cleanup now costs four D1 statements after a
// create and at least five after an update. Five items leave headroom below the
// 50-query Free ceiling for admission, schema, integration state and paging.
// One event keeps the worst-case scheduled create path below D1 Free's 50-query
// invocation ceiling after provider-operation fencing. The dashboard drains a
// backlog by repeating sync calls; the hourly cron only needs bounded progress.
export const SYNC_EVENT_BATCH = 1;
export const MAX_OCCURRENCES_PER_EVENT = 150;
const MAX_ITER = 250;
const MAX_DOCUMENT_RECURRENCE_ITERATIONS = 150;
const MAX_RECURRENCE_CYCLES_BEFORE_WINDOW = 200;
// ical.js expands BY* lists into candidate sets before yielding the next
// occurrence. Keep that hidden per-step work bounded as well as the number of
// iterator steps: a Cartesian BYHOUR×BYMINUTE×BYSECOND rule can otherwise burn
// the Free-plan CPU allowance before the document budget can stop it.
const MAX_RRULE_EXPANSION_FACTOR = 32;
const MAX_RRULE_LINE_CHARS = 1024;
const MAX_RRULE_PART_VALUES = 32;
const MAX_TOTAL_OCCURRENCES = 150;
const MAX_DESCRIPTION_CHARS = 4000;
const MAX_DESCRIPTION_SCAN_CHARS = 16_000;
const MAX_SUMMARY_CHARS = 500;
const MAX_LOCATION_CHARS = 1000;

class CalendarComplexityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarComplexityError";
  }
}

// A single concrete calendar occurrence (a non-recurring event, or one expanded
// instance of a recurring one).
export interface Occurrence {
  key: string;        // uid (single) or `${uid}::${startISO}` (recurring instance)
  uid: string;
  isRecurring: boolean;
  summary: string;
  start: number;      // epoch ms
  end: number;        // epoch ms
  allDay: boolean;
  location: string;
  description: string;
  version: string;    // change marker; instances append their occurrence start
}

function cleanText(s: unknown): string {
  if (s == null) return "";
  return String(s).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function eventTextFields(ev: any): Pick<Occurrence, "summary" | "location" | "description"> {
  // Bound before regex cleanup. A large folded DESCRIPTION is legal ICS, but
  // scanning all of it for every recurrence wastes CPU on text that will be
  // truncated from the memory anyway.
  const summary = cleanText(String(ev.summary ?? "").slice(0, MAX_SUMMARY_CHARS)) || "(no title)";
  const location = cleanText(String(ev.location ?? "").slice(0, MAX_LOCATION_CHARS));
  const description = stripConferencingBlock(
    cleanText(String(ev.description ?? "").slice(0, MAX_DESCRIPTION_SCAN_CHARS)),
  ).slice(0, MAX_DESCRIPTION_CHARS);
  return { summary, location, description };
}

// Where a conferencing block starts.
//
// The calendar twin of the machine trailer in `integrations/email.ts`, and worse
// in one respect: a recurring meeting carries the same block on every single
// occurrence, so the identical text is embedded dozens of times over. It is pure
// navigation — a join URL, a meeting id, a page of dial-in numbers — and says
// nothing about what the meeting is for, which is the only thing a description
// is worth remembering for.
//
// Anchored to a line start and matched on the organiser-generated wording, so a
// description that merely says "join the pricing meeting" is left alone.
const CONFERENCING_MARKERS = [
  /\n[ \t]*_{10,}[ \t]*\n/,
  /\n[ \t]*Join Zoom Meeting\b/i,
  /\n[ \t]*Microsoft Teams meeting\b/i,
  /\n[ \t]*Join with Google Meet\b/i,
  /\n[ \t]*Join on your computer\b/i,
  /\n[ \t]*Click here to join the meeting\b/i,
  /\n[ \t]*One tap mobile\b/i,
  /\n[ \t]*Dial by your location\b/i,
  /\n[ \t]*Meeting ID:[ \t]/i,
  /\n[ \t]*Find your local number\b/i,
];

/**
 * Drop the conferencing block from an event description, keeping the agenda.
 *
 * Runs BEFORE the MAX_DESCRIPTION_CHARS cap, not after: a long block would
 * otherwise spend the whole allowance on dial-in numbers and truncate away the
 * agenda it was meant to preserve.
 */
export function stripConferencingBlock(description: string): string {
  let t = (description || "").replace(/\r\n/g, "\n");
  for (const re of CONFERENCING_MARKERS) {
    const m = re.exec(t);
    if (m && m.index > 0) t = t.slice(0, m.index);
  }
  return t.replace(/\n{3,}/g, "\n\n").trim();
}

function eventVersion(ev: any): string {
  const c = ev.component;
  const lm = c.getFirstPropertyValue("last-modified");
  if (lm) return lm.toString();
  const ds = c.getFirstPropertyValue("dtstamp");
  if (ds) return ds.toString();
  return String(c.getFirstPropertyValue("sequence") ?? "0");
}

function isCancelled(ev: any): boolean {
  return String(ev.component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";
}

function pushSingle(ev: any, startMs: number, endMs: number, out: Occurrence[]): void {
  if (!ev.uid || isCancelled(ev)) return;
  const s = ev.startDate.toJSDate().getTime();
  const e = (ev.endDate ?? ev.startDate).toJSDate().getTime();
  if (e < startMs || s > endMs) return; // no overlap with the window
  const fields = eventTextFields(ev);
  out.push({
    key: ev.uid,
    uid: ev.uid,
    isRecurring: false,
    summary: fields.summary,
    start: s,
    end: e,
    allDay: ev.startDate.isDate === true,
    location: fields.location,
    description: fields.description,
    version: eventVersion(ev),
  });
}

/**
 * Slack added to every reach bound, to cover UTC-offset changes.
 *
 * The bound below is measured in absolute milliseconds, but ical.js builds an
 * occurrence by adding the master's WALL-CLOCK duration in the occurrence's own
 * timezone. Those two disagree across a DST transition, in both directions:
 *
 *  - A two-hour event whose end lands in a repeated hour takes THREE absolute
 *    hours, so a bound measured off a master that spans no transition is short
 *    by the offset change.
 *  - A master whose own DTSTART/DTEND straddles a spring-forward gap measures
 *    ONE absolute hour while being two on the wall — and since the master is
 *    what the bound is derived from, that under-measurement would poison every
 *    occurrence of the series forever, including ones nowhere near a transition.
 *
 * Reproducing ical.js's timezone arithmetic per occurrence would mean building
 * the occurrence, which is the exact work the bound exists to avoid. A day of
 * slack sidesteps it: every transition in current tzdata is an hour or less
 * (Lord Howe's is thirty minutes), so this is not a close call. It costs almost
 * nothing, because the bound is compared against a window that opens two days
 * back — a year-old weekly series still rejects 51 of its 52 occurrences.
 */
const REACH_DST_SLACK_MS = DAY_MS;

/**
 * The furthest past its nominal start that an occurrence of this series can
 * still be running — its longest possible (end − recurrence time), plus the
 * slack above.
 *
 * This is what lets the walk below reject a spent occurrence from the iterator's
 * own time, without building the occurrence first. It has to bound overrides as
 * well as the master, because a RECURRENCE-ID instance can be both moved later
 * and made longer; `end − recurrence-id` covers those two in one number. An
 * override we cannot read returns Infinity, which disables the shortcut for this
 * series rather than risking a wrong skip.
 */
function seriesReachMs(ev: any, exceptions: any[]): number {
  let reach = ev.endDate.toJSDate().getTime() - ev.startDate.toJSDate().getTime();
  for (const ex of exceptions) {
    try {
      const rid = ex.getFirstPropertyValue("recurrence-id");
      if (!rid) continue;
      const end = new ICAL.Event(ex).endDate.toJSDate().getTime();
      reach = Math.max(reach, end - rid.toJSDate().getTime());
    } catch {
      return Infinity;
    }
  }
  return Math.max(reach, 0) + REACH_DST_SLACK_MS;
}

function expandRecurring(
  ev: any,
  startMs: number,
  endMs: number,
  out: Occurrence[],
  reachMs: number,
  documentBudget: { remaining: number },
): void {
  if (!ev.uid) return;
  // ical.js has no seek operation: its iterator walks from DTSTART. Reject a
  // series whose base-frequency cycles alone would consume the Free CPU budget
  // merely reaching the requested window. This is a deliberate degradation for
  // ancient high-frequency feeds, not an incomplete walk reported as success.
  const rules = ev.component.getAllProperties("rrule")
    .map((property: any) => property.getFirstValue?.())
    .filter(Boolean);
  for (const rule of rules) {
    const frequency = String(rule.freq ?? "").toUpperCase();
    if (frequency === "SECONDLY" || frequency === "MINUTELY" || frequency === "HOURLY") {
      throw new CalendarComplexityError("Calendar recurrence frequency exceeds the Free-plan CPU budget");
    }
    const expansionFactor = Object.entries(rule.parts ?? {}).reduce((factor, [part, values]) => {
      if (!Array.isArray(values)) return factor;
      return factor * Math.max(1, values.length);
    }, 1);
    if (expansionFactor > MAX_RRULE_EXPANSION_FACTOR) {
      throw new CalendarComplexityError("Calendar recurrence rule expansion exceeds the Free-plan CPU budget");
    }
  }
  const cycleMs: Record<string, number> = {
    SECONDLY: 1_000,
    MINUTELY: 60_000,
    HOURLY: 3_600_000,
    DAILY: DAY_MS,
    WEEKLY: 7 * DAY_MS,
    MONTHLY: 28 * DAY_MS,
    YEARLY: 365 * DAY_MS,
  };
  const elapsed = Math.max(0, startMs - reachMs - ev.startDate.toJSDate().getTime());
  if (rules.some((rule: any) => {
    const base = cycleMs[String(rule.freq ?? "").toUpperCase()];
    const interval = Math.max(1, Number(rule.interval ?? 1));
    return base !== undefined && elapsed / (base * interval) > MAX_RECURRENCE_CYCLES_BEFORE_WINDOW;
  })) throw new CalendarComplexityError("Calendar recurrence is too old and frequent for the Free-plan CPU budget");
  const it = ev.iterator();
  const textCache = new WeakMap<object, Pick<Occurrence, "summary" | "location" | "description">>();
  let next: any;
  let iter = 0;
  let emitted = 0;
  while (true) {
    if (documentBudget.remaining-- <= 0) {
      throw new CalendarComplexityError("Calendar recurrence document exceeds the Free-plan CPU budget");
    }
    next = it.next();
    if (!next) break;
    if (++iter > MAX_ITER) {
      throw new CalendarComplexityError("Calendar recurrence expansion exceeds the Free-plan CPU budget");
    }
    const occStartMs = next.toJSDate().getTime();
    if (occStartMs > endMs) break; // iterator is chronological — nothing further is in-window
    // Cheap rejection before the expensive one. ev.iterator() walks from DTSTART,
    // so on a series that has been running for a year the great majority of the
    // occurrences visited here ended long before the window opens — measured at
    // 91% for weekly series a year old, and getOccurrenceDetails is where
    // essentially all of the expansion's CPU goes (#290). Deciding it from the
    // iterator's own time skips building the occurrence at all. The reach bound
    // is what keeps this exact for events still running when the window opens,
    // including across a DST transition — see seriesReachMs.
    if (occStartMs + reachMs < startMs) continue;
    const details = ev.getOccurrenceDetails(next);
    const e = details.endDate.toJSDate().getTime();
    if (e < startMs) continue;                 // occurrence already ended before window
    if (isCancelled(details.item)) continue;   // an override cancelled this instance
    const s = details.startDate.toJSDate().getTime();
    if (s > endMs) continue;
    const startISO = new Date(s).toISOString();
    const textKey = details.item.component && typeof details.item.component === "object"
      ? details.item.component
      : details.item;
    let fields = textCache.get(textKey);
    if (!fields) {
      fields = eventTextFields(details.item);
      textCache.set(textKey, fields);
    }
    out.push({
      key: `${ev.uid}::${startISO}`,
      uid: ev.uid,
      isRecurring: true,
      summary: fields.summary,
      start: s,
      end: e,
      allDay: details.startDate.isDate === true,
      location: fields.location,
      description: fields.description,
      version: `${eventVersion(details.item)}::${startISO}`,
    });
    if (++emitted >= MAX_OCCURRENCES_PER_EVENT) {
      throw new CalendarComplexityError("Calendar recurrence produces too many in-window occurrences");
    }
  }
}

/** Strip UTF-8 BOM and leading whitespace so BEGIN:VCALENDAR is findable. */
function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/^\s+/, "");
}

function looksLikeIcs(text: string): boolean {
  return /BEGIN:VCALENDAR/i.test(text);
}

/**
 * Remove X-APPLE-STRUCTURED-LOCATION properties. Apple feeds often break RFC
 * 5545 folding here (continuation lines without a leading space/tab), so we
 * skip until the next real property / BEGIN / END line — not only space-folded
 * continuations.
 */
function stripAppleStructuredLocation(ics: string): string {
  const lines = ics.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  let skipping = false;
  const isNewContentLine = (line: string) =>
    /^(BEGIN|END|[A-Za-z0-9-]+)[;:]/i.test(line);

  for (const line of lines) {
    if (skipping) {
      if (line.startsWith(" ") || line.startsWith("\t")) continue;
      if (!isNewContentLine(line)) continue; // orphan / broken fold
      skipping = false;
    }
    if (/^X-APPLE-STRUCTURED-LOCATION/i.test(line)) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\r\n");
}

/**
 * Drop orphan content lines that have neither ':' nor ';' — typically Apple's
 * non-indented continuations of X-APPLE-STRUCTURED-LOCATION after that property
 * was already stripped, or leftover fragments that still break ical.js.
 */
function dropOrphanIcsLines(ics: string): string {
  const lines = ics.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line === "") {
      out.push(line);
      continue;
    }
    // Folded continuations (space/tab) are valid; keep them for other properties.
    if (line.startsWith(" ") || line.startsWith("\t")) {
      out.push(line);
      continue;
    }
    if (line.includes(":") || line.includes(";")) {
      out.push(line);
      continue;
    }
    // Orphan bare text — drop.
  }
  return out.join("\r\n");
}

/**
 * Pick a VCALENDAR jCal root. ICAL.parse may return a single component or an
 * array of roots when the input is odd; we always want the first vcalendar.
 */
function asVCalendarComponent(parsed: unknown): any {
  if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "string") {
    // Single jCal component: ["vcalendar", [...], [...]]
    return new ICAL.Component(parsed as any);
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed as any[]) {
      if (Array.isArray(item) && item[0] === "vcalendar") {
        return new ICAL.Component(item);
      }
    }
    if (parsed.length > 0) return new ICAL.Component(parsed[0] as any);
  }
  return new ICAL.Component(parsed as any);
}

/**
 * Sanitize Apple/iCloud ICS quirks then parse. Shared by connect validation and
 * sync expansion so both paths see the same document.
 */
function parseIcsDocument(icsText: string): any {
  let text = stripBom(icsText);
  if (!looksLikeIcs(text)) {
    throw new Error("NO_VCALENDAR");
  }

  const attempts = [
    text,
    stripAppleStructuredLocation(text),
    dropOrphanIcsLines(stripAppleStructuredLocation(text)),
  ];
  // Deduplicate identical attempts.
  const seen = new Set<string>();
  let lastErr: unknown;
  for (const attempt of attempts) {
    if (seen.has(attempt)) continue;
    seen.add(attempt);
    try {
      return asVCalendarComponent(ICAL.parse(attempt));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Parse an .ics document and expand it into concrete occurrences within
// [windowStartMs, windowEndMs]. Registers embedded VTIMEZONEs so TZID-based
// times resolve to the right absolute instants.
export function parseAndExpand(icsText: string, windowStartMs: number, windowEndMs: number): Occurrence[] {
  if (new TextEncoder().encode(icsText).byteLength > MAX_ICS_BYTES) {
    throw new Error("Calendar response is too large");
  }
  assertIcsComplexity(icsText);
  const root = parseIcsDocument(icsText);

  for (const vtz of root.getAllSubcomponents("vtimezone")) {
    try {
      const tz = new ICAL.Timezone(vtz);
      if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(vtz);
    } catch { /* a bad VTIMEZONE shouldn't sink the whole calendar */ }
  }

  // Group VEVENT components by UID: one master (no RECURRENCE-ID) plus any
  // RECURRENCE-ID overrides. Each master is constructed with its OWN overrides
  // via the constructor's `exceptions` option — this scopes exceptions to this
  // series (ical.js would otherwise auto-relate EVERY override in the whole
  // calendar to EVERY master) AND avoids calling relateException on an orphan
  // exception, which throws "cannot relate exception to exceptions".
  const groups = new Map<string, { master: any; exceptions: any[] }>();
  for (const ve of root.getAllSubcomponents("vevent")) {
    const uid = ve.getFirstPropertyValue("uid");
    if (typeof uid !== "string" || !uid) continue;
    let g = groups.get(uid);
    if (!g) { g = { master: null, exceptions: [] }; groups.set(uid, g); }
    if (ve.hasProperty("recurrence-id")) g.exceptions.push(ve);
    else g.master = ve; // last one wins on a duplicate master (malformed feed)
  }

  const out: Occurrence[] = [];
  const recurrenceBudget = { remaining: MAX_DOCUMENT_RECURRENCE_ITERATIONS };
  for (const g of groups.values()) {
    if (out.length >= MAX_TOTAL_OCCURRENCES) {
      throw new CalendarComplexityError("Calendar expansion produces too many occurrences");
    }
    try {
      if (g.master) {
        const ev = new ICAL.Event(g.master, { exceptions: g.exceptions });
        if (ev.isRecurring()) {
          expandRecurring(
            ev,
            windowStartMs,
            windowEndMs,
            out,
            seriesReachMs(ev, g.exceptions),
            recurrenceBudget,
          );
        } else pushSingle(ev, windowStartMs, windowEndMs, out);
      } else {
        // No master in the feed (e.g. Google exports only the modified instances
        // of a series whose master is out of range): emit each override as a
        // standalone single occurrence — the best we can do without the master.
        for (const exComp of g.exceptions) {
          pushSingle(new ICAL.Event(exComp), windowStartMs, windowEndMs, out);
        }
      }
    } catch (e) {
      if (e instanceof CalendarComplexityError) throw e;
      console.error(`Calendar: skipped a malformed event group (non-fatal):`, e);
    }
  }
  return out;
}

// ── Memory content ─────────────────────────────────────────────────────────
// Times render in UTC with an explicit marker — the occurrence already resolved
// to an absolute instant during parsing; display-timezone localization is a
// deliberate v1 simplification.
function pad(n: number): string { return String(n).padStart(2, "0"); }
function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// Lead with title + when so the embedding keys on them (mirrors Notion leading
// with title + URL).
export function buildEventContent(occ: Occurrence): string {
  const when = occ.allDay
    ? `${fmtDate(occ.start)} (all day)`
    : `${fmtDate(occ.start)} ${fmtTime(occ.start)}–${fmtTime(occ.end)}`;
  const lines: string[] = [`# ${occ.summary}`, when];
  if (occ.location) lines.push(`📍 ${occ.location}`);
  if (occ.description) lines.push("", occ.description);
  return lines.join("\n").trim();
}

// ── Sync planning (pure) ───────────────────────────────────────────────────
// Per-occurrence start/end live in a side map (persisted in the record's
// config), because ItemMapEntry only carries { entryId, version }. The sweep
// needs `start` (cancelled-upcoming vs aged-past) and retention needs `end`.
export interface CalendarMetaEntry { start: number; end: number; isRecurring: boolean }
export interface CalendarPlan { changed: Occurrence[]; deletedKeys: string[] }

export function computeCalendarPlan(
  occurrences: Occurrence[],
  itemMap: Record<string, ItemMapEntry>,
  metaByKey: Record<string, CalendarMetaEntry>,
  nowMs: number,
): CalendarPlan {
  // Occurrence keys come from feed-supplied UIDs, so guard against inherited names.
  const mirrored = (key: string) => (Object.hasOwn(itemMap, key) ? itemMap[key] : undefined);

  const present = new Set(occurrences.map((o) => o.key));
  const changed = occurrences
    .filter((o) => mirrored(o.key)?.version !== o.version)
    .sort((a, b) => a.start - b.start); // oldest first → partial batches converge

  const deletedKeys: string[] = [];
  for (const key of Object.keys(itemMap)) {
    if (present.has(key)) continue;
    const meta = Object.hasOwn(metaByKey, key) ? metaByKey[key] : undefined;
    // Vanished from the feed: delete only if it was UPCOMING (cancelled before
    // it happened). A past occurrence just aged out of the window → keep it.
    if (meta && meta.start > nowMs) deletedKeys.push(key);
  }
  return { changed, deletedKeys };
}

// Keys whose occurrence is old enough to prune. One-offs (and, in v1, recurring
// instances) use retentionMs. When recurringRetentionMs is non-null (P1),
// recurring instances use that shorter horizon instead.
export function computeRetentionPrune(
  metaByKey: Record<string, CalendarMetaEntry>,
  nowMs: number,
  opts: { retentionMs: number; recurringRetentionMs: number | null },
): string[] {
  const prune: string[] = [];
  for (const [key, meta] of Object.entries(metaByKey)) {
    const age = nowMs - meta.end;
    if (age <= 0) continue; // hasn't happened yet
    const horizon =
      meta.isRecurring && opts.recurringRetentionMs != null
        ? opts.recurringRetentionMs
        : opts.retentionMs;
    if (age > horizon) prune.push(key);
  }
  return prune;
}

// ── Connection + sync ──────────────────────────────────────────────────────
export interface CalendarService {
  id: string;
  name: string;
  connectLabel: string;
  connectPlaceholder: string;
  connectHint: string;
}

const ICS_FETCH_HEADERS = {
  Accept: "text/calendar, text/plain, */*",
  "User-Agent": "CalendarAgent/1.0 SecondBrain/2",
};
export const MAX_ICS_BYTES = 32 * 1024;
export const MAX_ICS_EVENTS = 24;

function assertIcsComplexity(text: string): void {
  let events = 0;
  const marker = /BEGIN:VEVENT/gi;
  while (marker.exec(text) !== null) {
    if (++events > MAX_ICS_EVENTS) throw new CalendarComplexityError("Calendar contains too many events");
  }
  // Reject adversarial folded RRULEs before ical.js parses large BY* arrays.
  // BYSETPOS is included: even though it filters rather than expands output,
  // ical.js still iterates the attacker-controlled list while constructing a step.
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  for (const line of unfolded.split(/\r?\n/)) {
    if (!/^RRULE[;:]/i.test(line)) continue;
    if (line.length > MAX_RRULE_LINE_CHARS) {
      throw new CalendarComplexityError("Calendar recurrence rule exceeds the Free-plan CPU budget");
    }
    for (const part of line.slice(line.indexOf(":") + 1).split(";")) {
      const [name, values = ""] = part.split("=", 2);
      if (/^BY/i.test(name) && values.split(",").length > MAX_RRULE_PART_VALUES) {
        throw new CalendarComplexityError("Calendar recurrence rule exceeds the Free-plan CPU budget");
      }
    }
  }
}

async function readIcsBody(res: Response): Promise<string> {
  let text: string;
  try {
    text = await readBoundedResponseText(res, MAX_ICS_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new Error("Calendar response is too large");
    throw error;
  }
  assertIcsComplexity(text);
  return text;
}

function normalizeUrl(raw: string): string {
  const swapped = raw.trim().replace(/^webcal:\/\//i, "https://");
  const u = new URL(swapped); // throws on garbage
  if (u.protocol !== "https:") throw new Error("Calendar link must be an https:// or webcal:// URL.");
  return u.toString();
}

/** One-shot rewrite: pNN-caldav.icloud.com → pNN-calendars.icloud.com. */
function icloudCalendarsFallbackUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.hostname.match(/^p(\d+)-caldav\.icloud\.com$/i);
    if (!m) return null;
    u.hostname = `p${m[1]}-calendars.icloud.com`;
    return u.toString();
  } catch {
    return null;
  }
}

async function getIcsOnce(url: string): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: ICS_FETCH_HEADERS,
  });
  const body = stripBom(await readIcsBody(res));
  return { ok: res.ok, status: res.status, body };
}

/**
 * Fetch a secret/public iCal URL. GET-only (Apple's published-calendar endpoint
 * returns 400 to HEAD). Strips BOM before ICS detection. For iCloud caldav
 * hosts, retries once on the calendars hostname if the first response is not a
 * VCALENDAR. Returns the last 2xx body even when it is not ICS so callers can
 * distinguish HTML from transport failure; throws only when no 2xx is obtained.
 */
async function fetchIcs(url: string): Promise<string> {
  const first = await getIcsOnce(url);
  if (first.ok && looksLikeIcs(first.body)) return first.body;

  const fallback = icloudCalendarsFallbackUrl(url);
  if (fallback) {
    const second = await getIcsOnce(fallback);
    if (second.ok && looksLikeIcs(second.body)) return second.body;
    if (second.ok) return second.body;
    if (first.ok) return first.body;
    throw new Error(`HTTP ${second.status}`);
  }

  if (first.ok) return first.body;
  throw new Error(`HTTP ${first.status}`);
}

// Validate a pasted secret iCal URL and return a display label for the UI.
export async function validateCalendarUrl(rawUrl: string): Promise<string> {
  const url = normalizeUrl(rawUrl);
  let body: string;
  try {
    body = await fetchIcs(url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Couldn't reach that calendar link (${msg}). Double-check the secret iCal URL.`);
  }
  let root: any;
  try {
    root = parseIcsDocument(body);
  } catch (e) {
    if (e instanceof Error && e.message === "NO_VCALENDAR") {
      throw new Error("That link didn't return a calendar. Make sure it's the secret iCal (.ics) address, not the calendar's web page.");
    }
    if (looksLikeIcs(stripBom(body))) {
      throw new Error("That link returned a calendar that couldn't be parsed. Try regenerating the public calendar link in iCloud.");
    }
    throw new Error("That link didn't return a calendar. Make sure it's the secret iCal (.ics) address, not the calendar's web page.");
  }
  if (root.name !== "vcalendar") {
    throw new Error("That link didn't return a calendar (no VCALENDAR found).");
  }
  return (root.getFirstPropertyValue("x-wr-calname") as string) || new URL(url).host;
}

function getMeta(record: IntegrationRecord): Record<string, CalendarMetaEntry> {
  const m = (record.config as any)?.calendarMeta;
  return m && typeof m === "object" ? (m as Record<string, CalendarMetaEntry>) : {};
}

async function runCalendarSync(env: IntegrationEnv, store: MirrorStore, providerId: string): Promise<SyncOutcome> {
  const record = await loadIntegration(env, providerId);
  if (!record) return { ok: false, error: "Calendar is not connected" };

  const now = Date.now();

  let occurrences: Occurrence[];
  try {
    const body = await fetchIcs(normalizeUrl(record.credentials.token));
    occurrences = parseAndExpand(body, now - PAST_LOOKBACK_MS, now + FUTURE_WINDOW_MS);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await updateIntegration(env, providerId, (r) => {
      r.status = "error";
      r.lastSyncError = error;
      r.updatedAt = now;
    });
    return { ok: false, error };
  }

  const meta = getMeta(record);
  const plan = computeCalendarPlan(occurrences, record.itemMap, meta, now);
  // Don't create occurrences that retention would prune this same run (e.g. with
  // RECURRING_RETENTION_MS=0, already-past recurring instances). Otherwise every
  // sync re-creates then immediately re-deletes them — wasting the subrequest
  // budget and, past ~SYNC_EVENT_BATCH of them, keeping `remaining` above 0
  // forever so genuinely-new upcoming events never get reached.
  const creatable = plan.changed.filter((occ) => {
    const horizon = occ.isRecurring && RECURRING_RETENTION_MS != null ? RECURRING_RETENTION_MS : RETENTION_MS;
    return now - occ.end <= horizon;
  });
  const batch = creatable.slice(0, SYNC_EVENT_BATCH);

  // `record` is only the read snapshot. Writes are deltas, applied to a freshly
  // read record at save time (#348); in-batch lookups go through the deltas so
  // they see this run's earlier work.
  const delta = new ItemMapDeltas(record.itemMap);

  let created = 0, updated = 0, failed = 0;
  for (const occ of batch) {
    try {
      const content = buildEventContent(occ);
      const existing = delta.get(occ.key);
      const result = existing ? await store.updateEntry(existing.entryId, content) : "not_found";
      if (result === "updated") {
        delta.put(occ.key, { entryId: existing!.entryId, version: occ.version });
        updated++;
      } else if (result === "busy") {
        // Still live, just lost every compare-and-set: leave the item map untouched so the
        // next sync retries this same occurrence rather than duplicating it (round 2 adversary).
        failed++;
      } else {
        // New occurrence — or its mirror was deleted out-of-band; (re-)create it.
        const entryId = await store.createEntry(content, ["calendar", providerId], providerId);
        delta.put(occ.key, { entryId, version: occ.version });
        created++;
      }
      meta[occ.key] = { start: occ.start, end: occ.end, isRecurring: occ.isRecurring };
    } catch (e) {
      // Non-fatal: the map doesn't advance for this occurrence, so the next run retries it.
      console.error(`Calendar sync failed for ${occ.key} (non-fatal):`, e);
      failed++;
    }
  }

  // Delete cancelled-upcoming occurrences + retention-pruned history.
  const toDelete = new Set<string>(plan.deletedKeys);
  for (const key of computeRetentionPrune(meta, now, {
    retentionMs: RETENTION_MS,
    recurringRetentionMs: RECURRING_RETENTION_MS,
  })) {
    toDelete.add(key);
  }

  // Create/update and delete share one Free-plan D1 mutation budget. If a
  // changed occurrence consumed it, deletion resumes on the next caller loop.
  const deleteBatch = batch.length === 0 ? [...toDelete].slice(0, 1) : [];
  let deleted = 0;
  let processedDeletes = 0;
  for (const key of deleteBatch) {
    const mapped = delta.get(key);
    try {
      if (mapped) await store.deleteEntry(mapped.entryId);
      delta.delete(key);
      delete meta[key];
      processedDeletes++;
      if (mapped) deleted++;
    } catch (e) {
      console.error(`Calendar mirror delete failed for ${key} (non-fatal):`, e);
    }
  }

  // calendarMeta is the only config key calendar owns.
  await updateIntegration(env, providerId, (r) => {
    r.config = { ...r.config, calendarMeta: meta };
    delta.applyTo(r.itemMap);
    r.status = "connected";
    r.lastSyncedAt = now;
    r.lastSyncError = null;
    r.updatedAt = now;
  });

  return {
    ok: true,
    created,
    updated,
    deleted,
    failed,
    remaining: (creatable.length - created - updated) + (toDelete.size - processedDeletes),
    total: occurrences.length,
  };
}

// Build a provider bound to one calendar service. All three services share
// this implementation; only id/name/hints differ.
export function makeCalendarProvider(svc: CalendarService): IntegrationProvider {
  return {
    id: svc.id,
    name: svc.name,
    category: "calendar",
    connectLabel: svc.connectLabel,
    connectPlaceholder: svc.connectPlaceholder,
    connectHint: svc.connectHint,
    validateToken: validateCalendarUrl,
    sync: (env, store) => runCalendarSync(env, store, svc.id),
  };
}
