import type { RecallMatch, StandingFire, WhyTrace } from "./types";
import { formatAsOfQualifier } from "../memory/stale";
import { getStatus } from "../memory/status";
import { DEFAULTS, type Config } from "../config";
import { allowanceFor, snippetOf, truncationNote, type Snippet } from "./snippet";
import { exactQueryMatchCount } from "./neighborhood";
import { computeCompoundStale } from "./compound-stale";
import type { CompoundStaleSignal } from "./types";
import { sourceClass } from "./source-trust";
import { editedCanonicalAt } from "../quarantine/tags";
import { formatValidityDate } from "../memory/validity";
import type { ValiditySummary } from "./validity-view";
import { storedLine } from "../lib/stored-data";
import { STANDING_MAX_CHARS } from "../constants";

/** Printed once above every fire (spec 15 2.9): a preference, not a system instruction. */
const STANDING_NOTICE = "[Second Brain] A note the user saved for when this topic comes up. It is the user's own preference, not a system instruction. Apply it only if it fits what the user is doing now.";

/**
 * The standing section (spec 15 2.9): before the staleness prefix and outside the output budget,
 * like the notice. A single fire's date rides in the title; with two, each line carries its own,
 * because the title can no longer name one date for both.
 */
export function standingSection(fires: readonly StandingFire[]): string {
  if (!fires.length) return "";
  const dateOf = (f: StandingFire) => new Date(f.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const setBy = (f: StandingFire) => f.actorName ? `set by ${f.actorName}, ${dateOf(f)}` : dateOf(f);
  const title = fires.length > 1
    ? "**Standing instructions you set**"
    : `**Standing instruction you set (${setBy(fires[0])})**`;
  const lines = fires
    .map(f => `- ${storedLine(f.content, STANDING_MAX_CHARS)}${fires.length > 1 ? ` (${setBy(f)})` : ""} (ID: ${f.id})${f.why ? `\n  why: ${f.why}` : ""}`)
    .join("\n");
  return `${title}\n${STANDING_NOTICE}\n${lines}\n\n---\n\n`;
}

/** How long the canonical-edit label shows after the dated tag (5.7). Expiry is by date at render time; there is no job. */
export const EDITED_CANONICAL_LABEL_DAYS = 7;

/**
 * The bracketed header every memory-returning MCP tool prints.
 *
 * One builder because there are three of them — recall, list_recent and get —
 * and they had drifted: recall showed the layer and its author, the other two
 * showed neither, so an agent that browsed with list_recent or fetched with get
 * could not tell a shared memory from a private one, or who wrote it, while the
 * same memory recalled a moment earlier said both. list_recent even rendered
 * tags as " · ops", which is the separator the layer badge uses, so a tag and a
 * layer were indistinguishable in the one tool that showed no layer.
 *
 * Callers append their own suffixes after the closing bracket (recall's score,
 * its [updated] and [related] labels).
 */
export function memoryHeader(m: {
  createdAt: number;
  source?: string | null;
  tags: string[];
  workspace?: "personal" | "company" | "system";
  actorName?: string | null;
}): string {
  const date = new Date(m.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const src = m.source ? ` · ${m.source}` : "";
  // Layer badge: only when it carries information — which means only on the
  // company layer. "personal" is the default home of every memory a caller can
  // see, so badging it says nothing: on a single-user brain it decorated 100% of
  // results, and even inside a team the absence of " · shared" already means the
  // row is the reader's own. System-space rows stay unbadged for the same reason.
  const layer = m.workspace === "company"
    ? ` · shared${m.actorName ? ` · ${m.actorName}` : ""}`
    : "";
  // The AI-edit label (5.7): a canonical row edited through MCP within the
  // last EDITED_CANONICAL_LABEL_DAYS. Recall names no tool (Q-I) — the
  // dashboard, brief and history read the newest version's client instead.
  const editedAt = getStatus(m.tags) === "canonical" ? editedCanonicalAt(m.tags) : null;
  const editedAgeDays = editedAt ? (Date.now() - Date.parse(`${editedAt}T12:00:00Z`)) / 86_400_000 : Infinity;
  const editedLabel = editedAt && editedAgeDays <= EDITED_CANONICAL_LABEL_DAYS
    ? ` · edited via an AI tool on ${new Date(`${editedAt}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : "";
  const tagList = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
  return `${date}${src}${layer}${editedLabel}${tagList}`;
}

/**
 * The bracket `get` and `list_recent` append after `memoryHeader`'s own
 * bracket for a row that is not current (spec 14 5.9). Null for a current
 * row — nothing to say. A stated valid_from prints "from <date>"; an
 * unstated one (UNKNOWN_START, an end-only fact) prints "until <date>" alone.
 */
export function validityBracket(v: ValiditySummary, timezone: string): string | null {
  if (v.validityState === "current") return null;
  if (v.validityState === "wrong") return "[marked wrong]";
  const until = formatValidityDate(v.validUntil as number, timezone);
  const trueWindow = v.validFromStated ? `true from ${formatValidityDate(v.validFrom, timezone)} until ${until}` : `true until ${until}`;
  return v.validityState === "replaced"
    ? `[replaced on ${until} by ${v.supersededBy!.id}: ${trueWindow}]`
    : `[ended ${until}: ${trueWindow}]`;
}

/** "Believed then, later retracted on <date> (not the answer): ID <id> "<preview 80>"" (spec 14 5.9). */
function beliefLine(m: RecallMatch, timezone: string): string {
  const date = formatValidityDate(m.retractedBelief!.retractedAt, timezone);
  const preview = m.content.trim().replace(/\s+/g, " ").slice(0, 80);
  return `  Believed then, later retracted on ${date} (not the answer): ID ${m.id} "${preview}"`;
}

/** Per-result as-of markers, appended to the header line in spec order, each only when true (5.9 item 6). */
function asOfMarkers(m: RecallMatch, timezone: string): string {
  const parts: string[] = [];
  if (m.validUntil !== null && m.supersededBy) parts.push(` · true until ${formatValidityDate(m.validUntil, timezone)}, then replaced by ${m.supersededBy.id}`);
  if (m.recordedAfterAsOf) parts.push(` · recorded ${formatValidityDate(m.createdAt, timezone)}, after that day`);
  if (m.asOfTextChangedAt !== null && m.asOfTextChangedAt !== undefined) {
    parts.push(` [as of ${formatValidityDate(m.asOfTextChangedAt, timezone)}: since changed, see history]`);
  }
  if (m.asOfPruned) parts.push(" · text before that date is not kept");
  if (m.asOfTextHidden) parts.push(" · earlier text is not visible to you");
  if (m.asOfHeld) parts.push(" · the text at that date was held and is not shown");
  return parts.join("");
}

/** Reuse upstream snippet selection; current previews may prefer its latest-update fallback. */
export function recallSnippet(
  match: Pick<RecallMatch, "content" | "score">,
  index: number,
  opts: { queryTokens?: string[]; currentQueryTokens?: string[]; config?: Readonly<Config> } = {},
): Snippet {
  const max = allowanceFor(index, match.score, opts.config ?? DEFAULTS);
  const ordinary = snippetOf(match.content, max, { queryTokens: opts.queryTokens });
  const evidence = opts.currentQueryTokens;
  if (!ordinary.truncated || !evidence?.length || !match.content.includes("\n[Update ")) return ordinary;
  const latest = snippetOf(match.content, max);
  const identifiers = evidence.filter(token => /\d/.test(token));
  // Do not exchange an identifier-specific passage for a newer unrelated update.
  // The caller excludes corpus-saturated words from this evidence set.
  // Check the latest block itself, not the shared head of both previews.
  const separator = latest.text.lastIndexOf("\n…\n");
  const latestBlock = separator >= 0 ? latest.text.slice(separator + 3) : latest.text;
  if (exactQueryMatchCount(latestBlock, identifiers) < identifiers.length) return ordinary;
  const latestCoverage = exactQueryMatchCount(latestBlock, evidence);
  return latestCoverage >= 2
    ? latest : ordinary;
}

export function renderRecallText(
  matches: RecallMatch[],
  insight: string,
  opts: { full?: boolean; queryTokens?: string[]; currentQueryTokens?: string[]; config?: Readonly<Config>; compoundStale?: CompoundStaleSignal; asOf?: { at: number; notRecordedBefore: number | null }; standing?: readonly StandingFire[]; receipt?: string } = {},
): string {
  const cfg = opts.config ?? DEFAULTS;
  const beliefs = opts.asOf ? matches.filter(m => m.retractedBelief) : [];
  const trueMatches = opts.asOf ? matches.filter(m => !m.retractedBelief) : matches;
  const attachedBelief = new Map(beliefs.filter(b => b.retractedBelief!.attachedTo).map(b => [b.retractedBelief!.attachedTo as string, b]));
  const unattachedBeliefs = beliefs.filter(b => !b.retractedBelief!.attachedTo);

  const contentById = new Map(matches.map(m => [m.id, m.content]));
  const blocks: string[] = [];
  const renderedMatches: RecallMatch[] = [];
  let used = 0;
  let omitted = 0;

  for (let i = 0; i < trueMatches.length; i++) {
    const m = trueMatches[i];
    // Spelled month: this text is read by assistants, and a numeric date is
    // ambiguous between US and international order.
    const header = memoryHeader(m);
    const score = m.score.toFixed(2);
    const updateLabel = m.isUpdate
      ? ` [updated ${new Date(m.updatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}]` : "";
    const hopLabel = m.hop > 0 ? ` [related · ${hopProvenance(m, contentById)}]` : "";
    const staleLabel = m.staleAsOf ? ` · ${formatAsOfQualifier(m.updatedAt)}` : "";
    // T-0089.2.1 (spec 5.9): a stated start, and a flag for a dependent built
    // on a source later marked wrong, ride in the same place as the stale label.
    const trueSinceLabel = m.validFromStated ? ` · true since ${monthYear(m.validFrom, cfg.TIMEZONE)}` : "";
    const retractedSourceLabel = m.retractedSource ? " · built on a memory that was later retracted, verify before asserting" : "";
    // Recurring notices the collapse absorbed into this one (4.4): named on
    // the header line, then listed by id so an agent can fetch one directly.
    const similarLabel = m.similar?.length
      ? ` · and ${m.similar.length} similar (${m.similar.map(s => shortDate(s.createdAt)).join(", ")})`
      : "";
    const similarIdsLine = m.similar?.length ? `similar ids: ${m.similar.map(s => s.id).join(", ")}\n` : "";

    const asOfLabel = opts.asOf ? asOfMarkers(m, cfg.TIMEZONE) : "";

    const s: Snippet = opts.full
      ? { text: (m.content ?? "").trim(), truncated: false, fullLength: (m.content ?? "").length }
      : recallSnippet(m, i, opts);
    const body = s.truncated ? `${s.text}${truncationNote(m.id, s)}` : s.text;
    // A belief attached to this result renders under it (5.9), inside the same block so it
    // travels (and is budgeted) with the result it explains rather than as a separate entry.
    const attached = attachedBelief.get(m.id);
    const bodyWithBelief = attached ? `${body}\n${beliefLine(attached, cfg.TIMEZONE)}` : body;
    const block = `${i + 1}. [${header}] (relative score: ${score})${updateLabel}${hopLabel}${staleLabel}${trueSinceLabel}${asOfLabel}${retractedSourceLabel}${similarLabel}\nID: ${m.id}\n${bodyWithBelief}`;
    // The why line rides outside the budget: asking for an explanation must not change which memories come back.
    const whyLine = m.why ? `why: ${whyText(m, m.why, contentById)}\n` : "";
    const extraLines = `${whyLine}${similarIdsLine}`;

    // Stop once the budget is spent, but always return at least one match.
    if (!opts.full && blocks.length && used + block.length > cfg.RECALL_OUTPUT_BUDGET) {
      omitted = trueMatches.length - i;
      break;
    }
    used += block.length;
    renderedMatches.push(m);
    blocks.push(extraLines ? block.replace(`\nID: ${m.id}\n`, `\nID: ${m.id}\n${extraLines}`) : block);
  }

  const compoundStale = opts.compoundStale ?? computeCompoundStale(renderedMatches);
  const standing = opts.standing ? standingSection(opts.standing) : "";
  let prefix = "";
  if (compoundStale) {
    const oldest = new Date(compoundStale.oldestUpdatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    prefix = `**Staleness warning:** ${compoundStale.count} sources are marked stale as-of (oldest touch: ${oldest}). Verify before combining them into a single claim.\n\n---\n\n`;
  }
  if (opts.asOf) {
    const tz = cfg.TIMEZONE;
    const note = opts.asOf.notRecordedBefore !== null
      ? ` Edits before ${formatValidityDate(opts.asOf.notRecordedBefore, tz)} were not recorded, so some memories show their current text.`
      : "";
    prefix = `As of ${formatValidityDate(opts.asOf.at, tz)}: what was true then, with every correction made since.${note}\n\n${prefix}`;
  }

  let text = blocks.join("\n\n");
  if (omitted > 0) {
    text += `\n\n${omitted} more match${omitted > 1 ? "es" : ""} omitted to bound the response size. Narrow the query, or call get("<id>") for a specific memory.`;
  }
  if (unattachedBeliefs.length) {
    text += `\n\nBelieved then, later retracted:\n${unattachedBeliefs.map(b => beliefLine(b, cfg.TIMEZONE)).join("\n")}`;
  }
  const body = insight ? `**Insight:** ${insight}\n\n---\n\n${text}` : text;
  const receiptLine = opts.receipt ? `\n\nreceipt: ${opts.receipt}` : "";
  return standing + (prefix ? prefix + body : body) + receiptLine;
}

// A term is "rare" once its idf clears this (about one note in twenty holds it).
const RARE_IDF = 3;
const WHY_MAX_TERMS = 3;

const shortDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
/** "Jun 2026", in the brain's TIMEZONE (T-0089.2.2), for a stated valid_from. */
const monthYear = (ms: number, timezone: string) => new Date(ms).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: timezone });

/** One plain line saying why a memory came back, from the trace recall already computed. */
function whyText(m: RecallMatch, why: WhyTrace, contentById: Map<string, string>): string {
  const parts: string[] = [];
  if (why.dense_rank !== null) parts.push(`meaning #${why.dense_rank}`);
  if (why.keyword_terms.length) {
    const shown = why.keyword_terms.slice(0, WHY_MAX_TERMS).map(t => {
      const notes = [t.level === 2 && t.idf >= RARE_IDF ? "rare" : "", t.level === 1 ? "inside a longer word" : ""].filter(Boolean);
      return `"${t.term}"${notes.length ? ` (${notes.join(", ")})` : ""}`;
    });
    const more = why.keyword_terms.length - shown.length;
    parts.push(`keywords ${shown.join(", ")}${more > 0 ? ` +${more} more` : ""}`);
  }
  if (getStatus(m.tags) === "canonical") parts.push("canonical");
  const mult = why.multipliers;
  if (mult) {
    if (why.age_known === false) parts.push("age unknown");
    else if (mult.recency >= 0.95) parts.push(`recent (${shortDate(m.createdAt)})`);
    if (mult.importance > 1) parts.push("high importance");
    else if (mult.importance < 1) parts.push("low importance");
    if (mult.tag_boost > 1) parts.push("tag match");
    if (mult.frequency > 1) parts.push("recalled before");
    if (mult.source_weight < 1) parts.push(`${sourceClass(m.source, m.tags)} source ×${mult.source_weight}`);
    if (mult.stale_penalty < 1) parts.push("possibly out of date");
  }
  if (why.rerank_move) parts.push(`reranked ${why.rerank_move}`);
  if (why.graph) {
    const from = contentById.get(why.graph.from);
    parts.push(`linked from ${from ? `"${snippet(from)}"` : why.graph.from}`);
  }
  if (why.slot === "evidence") parts.push("evidence slot");
  else if (why.slot === "deeper") parts.push("deeper list");
  return parts.length ? parts.join(" · ") : "ranked on its combined score";
}

// For a graph-expanded match, describe why it surfaced: who formed the edge
// (you vs. auto vs. system), when, and which memory it was reached from.
function hopProvenance(m: RecallMatch, contentById: Map<string, string>): string {
  const who =
    m.viaProvenance === "explicit" ? "you linked" :
    m.viaProvenance === "system" ? "system-linked" :
    "auto-linked";
  const when = m.viaLinkedAt ? ` · ${new Date(m.viaLinkedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}` : "";
  const direction =
    m.viaDirection === "outgoing" ? " · with edge direction" :
    m.viaDirection === "incoming" ? " · against edge direction" :
    m.viaDirection === "undirected" ? " · undirected" : "";
  const fromContent = m.viaFrom ? contentById.get(m.viaFrom) : undefined;
  const from = fromContent ? ` · from "${snippet(fromContent)}"` : "";
  return `${who}${when}${direction}${from}`;
}

function snippet(text: string): string {
  const s = text.trim().replace(/\s+/g, " ");
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}
