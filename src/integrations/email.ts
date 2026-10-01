/**
 * Second Brain — Email (IMAP) provider.
 *
 * Connects Gmail / iCloud via an app password over IMAP (see ./imap), fetches
 * new INBOX messages incrementally, filters out noise, and ingests the cleaned
 * body as a permanent memory. Read-only, append-only capture (NOT a live
 * mirror): emails don't vanish or cancel, so there is no delete/retention sweep
 * — new qualifying messages are captured once (deduped by Message-ID) and kept.
 */
import PostalMime from "postal-mime";
import {
  ImapClient,
  ImapLiteralTooLargeError,
  MAX_IMAP_BODY_BYTES,
  MAX_IMAP_SEARCH_UID_SPAN,
} from "./imap";
import type { IntegrationEnv, IntegrationProvider, IntegrationRecord, MirrorStore, SyncOutcome } from "./framework";
import { loadIntegration, updateIntegration } from "./framework";

const DAY_MS = 86_400_000;
export const FIRST_SYNC_LOOKBACK_MS = 7 * DAY_MS;  // first sync: up to 7 days within the newest bounded UID span
const OVERLAP_MS = 2 * DAY_MS;                      // re-scan window each sync (dedup covers repeats)
export const EMAIL_FETCH_BATCH = 1;                // one fenced mirror write per Free-plan invocation
export const EMAIL_HEADER_PAGE_SIZE = 1;           // an oversized header can be skipped without stranding later UIDs
const INITIAL_UID_LOOKBACK_SPAN = 2048;             // first sync: newest bounded UID window within seven days
const MAX_EMAIL_CHARS = 4000;
const MAX_INGESTED_IDS = 500;                       // bound the dedupe set kept in the record
export const MAX_EMAIL_BYTES = MAX_IMAP_BODY_BYTES; // checked at header, literal and received-byte boundaries

const HEADER_FIELDS = [
  "MESSAGE-ID", "FROM", "SUBJECT", "DATE",
  // Bulk / automated / list markers — presence of any means "not a person
  // writing to me". Genuine person-to-person mail carries none of these.
  "LIST-UNSUBSCRIBE", "LIST-ID", "LIST-POST",
  "PRECEDENCE", "AUTO-SUBMITTED", "FEEDBACK-ID", "X-FEEDBACK-ID",
  "X-AUTO-RESPONSE-SUPPRESS", "X-CAMPAIGN", "X-CAMPAIGNID", "CAMPAIGN-ID", "ERRORS-TO",
];

export interface EmailService {
  id: string;   // e.g. "email-gmail"
  name: string; // e.g. "Gmail"
  host: string; // IMAP host, e.g. "imap.gmail.com"
  connectLabel: string;
  connectPlaceholder: string;
  connectHint: string;
}

export interface EmailCreds { email: string; appPassword: string; }

// Email credentials are two fields packed as JSON into the framework's single
// `credentials.token` slot (the token is opaque to the framework; each provider
// owns its format).
export function parseEmailToken(token: string): EmailCreds {
  try {
    const o = JSON.parse(token);
    if (o && typeof o.email === "string" && typeof o.appPassword === "string" && o.email.trim() && o.appPassword) {
      return { email: o.email.trim(), appPassword: o.appPassword };
    }
  } catch { /* not JSON */ }
  throw new Error("This email connection is missing its credentials — please reconnect it.");
}

// ─── Filtering (pure) ───────────────────────────────────────────────────────

export interface EmailHeaderInfo {
  uid: number;
  size?: number;
  messageId: string;
  from: string;
  subject: string;
  date: string;
  bulk: boolean;
}

// A machine label, matched against ONE whole dot-separated piece of the domain.
//
// Whole-piece rather than substring on purpose: `notifyhealth.example.com` is a
// company and `alertsystems.example.com` is a company, and matching a substring
// would drop a person's mail to keep a receipt out. The optional short prefix
// covers the `e-notify` / `em-alerts` convention large senders use for their
// outbound subdomain.
const MACHINE_DOMAIN_LABEL =
  /^(?:[a-z0-9]{1,3}-)?(no[-_]?reply|do[-_]?not[-_]?reply|donotreply|notifications?|notify|notices?|alerts?|mailer|mailer-daemon|postmaster|bounces?|newsletters?|updates)$/;

// Automated senders (broadened): the local part OR the domain signals a machine,
// not a person.
//
// The local part alone was not enough. A large sender wants its own brand in the
// local part and puts the machine marker in the domain instead
// (`brand@notification.example.com`), so transactional mail walked past this
// check even though it is as automated as anything the header filter catches.
export function isNoiseSender(from: string): boolean {
  const addr = (/<([^>]+)>/.exec(from)?.[1] ?? from).toLowerCase();
  const local = (addr.split("@")[0] ?? "").trim();
  if (/(^|[._+-])(no[-_]?reply|do[-_]?not[-_]?reply|donotreply|noreply|notification|notifications|notify|alert|alerts|mailer-daemon|mailer|postmaster|bounce|bounces|newsletter|updates)([._+-]|$)/.test(local)) {
    return true;
  }
  const domain = (addr.split("@")[1] ?? "").trim();
  return domain.split(".").some(label => MACHINE_DOMAIN_LABEL.test(label));
}

// Header markers that reliably indicate bulk / automated / list mail. This is
// the primary noise filter and is fully generic — no per-sender rules: List-*
// (marketing + mailing lists), Precedence: bulk/list/junk, Auto-Submitted
// (RFC 3834 automated mail), Feedback-ID (which large senders attach), and
// common campaign headers. Person-to-person mail carries none of these, so this
// catches newsletters, marketing, receipts, statements, and alerts alike.
export function looksBulk(headers: Record<string, string>): boolean {
  const present = (k: string) => headers[k] != null;
  if (
    present("list-unsubscribe") || present("list-id") || present("list-post") ||
    present("feedback-id") || present("x-feedback-id") ||
    present("x-auto-response-suppress") ||
    present("x-campaign") || present("x-campaignid") || present("campaign-id") ||
    present("errors-to")
  ) return true;
  const prec = (headers["precedence"] || "").toLowerCase().trim();
  if (prec === "bulk" || prec === "list" || prec === "junk") return true;
  const auto = (headers["auto-submitted"] || "").toLowerCase().trim();
  if (auto && auto !== "no") return true;
  return false;
}

// Candidates = not a newsletter/marketing (List-Unsubscribe), not an automated
// sender, and not already ingested. Oldest-first so partial batches converge.
export function computeEmailPlan(headers: EmailHeaderInfo[], ingestedIds: Set<string>): EmailHeaderInfo[] {
  return headers
    .filter((h) => !h.bulk && !isNoiseSender(h.from) && !ingestedIds.has(emailIdentity(h)))
    .sort((a, b) => a.uid - b.uid);
}

function emailIdentity(header: Pick<EmailHeaderInfo, "messageId" | "uid">): string {
  return header.messageId || `uid:${header.uid}`;
}

// ─── Body extraction + cleaning ─────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|br|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Where a machine-generated trailer starts.
//
// `looksBulk` filters newsletters and marketing by their headers, but TRANSACTIONAL
// mail — a payment confirmation, a statement notice — is deliberately built not to
// look bulk: no List-Unsubscribe (it is not marketing), no Precedence: bulk, and a
// brand name rather than `noreply` in the local part. So it is ingested by design,
// and what arrives is one line of fact followed by a few thousand characters of
// trailer.
//
// That trailer is the expensive part, and not because it is long. It is TEMPLATED,
// so the same sentences repeat across every message from every sender, and once
// `chunkText` splits a message the trailer gets vectors of its own. A query sharing
// one ordinary word with it ("choosing") then matches a block of text that carries
// no information at all. Cutting it costs nothing: everything below these markers
// is navigation, legal and social boilerplate.
//
// Anchored to a line start so prose that merely contains the words survives — an
// email reading "we are choosing between two vendors" is a fact, not a trailer.
const TRAILER_MARKERS = [
  /\n[ \t]*Thank(s|[ \t]+you)[ \t]+for[ \t]+choosing\b/i,
  /\n[ \t]*Unsubscribe\b/i,
  /\n[ \t]*Manage[ \t]+(your[ \t]+)?(email[ \t]+)?preferences\b/i,
  /\n[ \t]*View[ \t]+(this[ \t]+email[ \t]+)?in[ \t]+(your[ \t]+)?browser\b/i,
  /\n[ \t]*This[ \t]+(email|message)[ \t]+was[ \t]+sent[ \t]+(by|to)\b/i,
  /\n[ \t]*This[ \t]+is[ \t]+an[ \t]+automated[ \t]+message\b/i,
  /\n[ \t]*Follow[ \t]+.{0,40}?[ \t]+on[ \t]+(Instagram|X|Twitter|Facebook|LinkedIn|YouTube)\b/i,
  /\n[ \t]*Download[ \t]+the[ \t]+.{0,40}?[ \t]+app\b/i,
  /\n[ \t]*(©|\(c\)|Copyright)[ \t]*\d{4}\b/i,
];

// Strip quoted reply chains, forwarded headers, signatures and machine trailers;
// cap length.
export function cleanEmailBody(text: string): string {
  let t = (text || "").replace(/\r\n/g, "\n");
  const cuts = [
    /\n>?[ \t]*On .+ wrote:[ \t]*\n/i,
    /\n-{2,}[ \t]*Original Message[ \t]*-{2,}/i,
    /\n_{5,}\n/,
    /\nFrom:[ \t].+\n(Sent|Date):[ \t].+/i,
    /\n-{3,}[ \t]*Forwarded message[ \t]*-{3,}/i,
    ...TRAILER_MARKERS,
  ];
  for (const re of cuts) {
    const m = re.exec(t);
    if (m && m.index > 0) t = t.slice(0, m.index);
  }
  const sig = t.search(/\n-- \n/);
  if (sig >= 0) t = t.slice(0, sig);
  t = t.split("\n").filter((l) => !/^[ \t]*>/.test(l)).join("\n");
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t.length > MAX_EMAIL_CHARS ? `${t.slice(0, MAX_EMAIL_CHARS)}\n…` : t;
}

// Lead with subject + sender + date so the embedding keys on them.
export function buildEmailContent(subject: string, from: string, date: string, body: string): string {
  const lines = [`# ${subject || "(no subject)"}`, `From: ${from}${date ? `  ·  ${date}` : ""}`];
  if (body) lines.push("", body);
  return lines.join("\n").trim();
}

interface ParsedEmail { text: string; subject: string; from: string; date: string; }

async function extractEmail(raw: Uint8Array): Promise<ParsedEmail> {
  const parsed: any = await PostalMime.parse(raw);
  const fromObj = parsed.from;
  const from = fromObj ? `${fromObj.name ? `${fromObj.name} ` : ""}<${fromObj.address ?? ""}>`.trim() : "";
  let text: string = parsed.text || "";
  if (!text && parsed.html) text = htmlToText(parsed.html);
  return { text, subject: parsed.subject || "", from, date: parsed.date || "" };
}

// ─── Connection validation + sync ───────────────────────────────────────────

export async function validateEmailToken(token: string, host: string): Promise<string> {
  const { email, appPassword } = parseEmailToken(token);
  const client = await ImapClient.connect(host);
  try {
    await client.login(email, appPassword);
    await client.selectInbox();
    return email;
  } finally {
    await client.close().catch(() => {});
  }
}

function getConfig(record: IntegrationRecord): {
  checkpoint?: number;
  ingestedIds?: string[];
  scanAfterUid?: number;
  uidValidity?: number;
} {
  const c = record.config as any;
  return c && typeof c === "object" ? c : {};
}

export async function runEmailSync(env: IntegrationEnv, store: MirrorStore, svc: EmailService): Promise<SyncOutcome> {
  const record = await loadIntegration(env, svc.id);
  if (!record) return { ok: false, error: `${svc.name} is not connected` };

  let creds: EmailCreds;
  try {
    creds = parseEmailToken(record.credentials.token);
  } catch (e) {
    const error = errMsg(e);
    await updateIntegration(env, svc.id, (r) => {
      r.status = "error";
      r.lastSyncError = error;
      r.updatedAt = Date.now();
    });
    return { ok: false, error };
  }

  const now = Date.now();
  const cfg = getConfig(record);
  const ingestedIds = new Set<string>(Array.isArray(cfg.ingestedIds) ? cfg.ingestedIds : []);
  const searchSince = new Date(typeof cfg.checkpoint === "number" ? cfg.checkpoint : now - FIRST_SYNC_LOOKBACK_MS);

  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect(svc.host);
    await client.login(creds.email, creds.appPassword);
    const mailbox = await client.selectInbox();
    if (mailbox.uidValidity !== undefined && cfg.uidValidity !== mailbox.uidValidity) {
      // UIDs are scoped to UIDVALIDITY. A mailbox rebuild may reuse low UIDs;
      // retaining the old cursor would silently skip new messages.
      cfg.scanAfterUid = undefined;
      cfg.uidValidity = mailbox.uidValidity;
      for (const identity of ingestedIds) {
        if (identity.startsWith("uid:")) ingestedIds.delete(identity);
      }
    }

    if (mailbox.uidNext === undefined) throw new Error("IMAP server did not provide UIDNEXT");
    const mailboxMaxUid = mailbox.uidNext - 1;
    const initialFloor = Math.max(1, mailboxMaxUid - INITIAL_UID_LOOKBACK_SPAN + 1);
    const firstUid = (cfg.scanAfterUid ?? (initialFloor - 1)) + 1;
    const lastUid = Math.min(firstUid + MAX_IMAP_SEARCH_UID_SPAN - 1, mailboxMaxUid);
    const uids = firstUid <= lastUid
      ? await client.uidSearchRangeSince(searchSince, firstUid, lastUid)
      : [];
    const pageUids = uids.slice(0, EMAIL_HEADER_PAGE_SIZE);
    let headerMsgs;
    try {
      headerMsgs = await client.uidFetchHeaders(pageUids, HEADER_FIELDS);
    } catch (error) {
      if (!(error instanceof ImapLiteralTooLargeError) || pageUids.length !== 1) throw error;
      // The connection was closed before allocating the declared literal. With
      // one UID per header page we can durably skip exactly that message and
      // continue from the following UID on the next invocation.
      cfg.scanAfterUid = pageUids[0];
      ingestedIds.add(`uid:${pageUids[0]}`);
      cfg.ingestedIds = [...ingestedIds].slice(-MAX_INGESTED_IDS);
      (record.config as any) = cfg;
      record.status = "connected";
      record.lastSyncedAt = now;
      record.lastSyncError = null;
      record.updatedAt = now;
      await updateIntegration(env, svc.id, (r) => {
        r.config = { ...r.config, scanAfterUid: cfg.scanAfterUid, uidValidity: cfg.uidValidity, ingestedIds: cfg.ingestedIds };
        r.status = record.status;
        r.lastSyncedAt = record.lastSyncedAt;
        r.lastSyncError = record.lastSyncError;
        r.updatedAt = record.updatedAt;
      });
      return {
        ok: true,
        created: 0,
        updated: 0,
        deleted: 0,
        failed: 0,
        remaining: pageUids[0] < mailboxMaxUid ? 1 : 0,
        total: 1,
      };
    }
    const headers: EmailHeaderInfo[] = headerMsgs.map((m) => ({
      uid: m.uid,
      size: m.size,
      messageId: (m.headers["message-id"] || "").trim(),
      from: m.headers["from"] || "",
      subject: m.headers["subject"] || "",
      date: m.headers["date"] || "",
      bulk: looksBulk(m.headers),
    }));

    const plan = computeEmailPlan(headers, ingestedIds);
    const batch = plan.slice(0, EMAIL_FETCH_BATCH);

    let created = 0, failed = 0, processed = 0;
    for (const h of batch) {
      try {
        const identity = emailIdentity(h);
        if (h.size !== undefined && h.size > MAX_EMAIL_BYTES) {
          // Skip large messages (usually big attachments): fetching them risks
          // timeouts/OOM. Mark seen so they don't linger in the candidate set.
          ingestedIds.add(identity);
          processed++;
          continue;
        }
        const raw = await client.uidFetchBody(h.uid);
        if (!raw) { failed++; continue; }
        // Defense in depth for a missing/incorrect RFC822.SIZE and custom IMAP
        // implementations. Never hand an oversized payload to PostalMime.
        if (raw.byteLength > MAX_EMAIL_BYTES) {
          ingestedIds.add(identity);
          processed++;
          continue;
        }
        const parsed = await extractEmail(raw);
        const body = cleanEmailBody(parsed.text);
        const content = buildEmailContent(parsed.subject || h.subject, parsed.from || h.from, parsed.date || h.date, body);
        await store.createEntry(content, ["email", svc.id], svc.id);
        created++;
        processed++;
        ingestedIds.add(identity);
      } catch (e) {
        if (e instanceof ImapLiteralTooLargeError) {
          ingestedIds.add(emailIdentity(h));
          processed++;
          continue;
        }
        console.error(`Email ingest failed for uid ${h.uid} (non-fatal):`, e);
        failed++;
      }
    }

    const remainingCandidates = plan.length - processed;
    const pageDrained = remainingCandidates === 0;
    const lastPageUid = pageUids.at(-1);
    if (pageDrained) cfg.scanAfterUid = lastPageUid ?? lastUid;
    const hasUnscannedUids = (cfg.scanAfterUid ?? 0) < mailboxMaxUid;
    const remaining = remainingCandidates + (hasUnscannedUids ? 1 : 0);
    // Advance the date checkpoint only after every UID returned for this scan is
    // classified. Keep the UID cursor across overlap scans; newly delivered mail
    // always receives a higher UID, including mail with an older Date header.
    if (remaining === 0) cfg.checkpoint = now - OVERLAP_MS;
    cfg.ingestedIds = [...ingestedIds].slice(-MAX_INGESTED_IDS);
    // 同期カーソルだけを最新レコードへ反映し、保存先設定を巻き戻さない。
    await updateIntegration(env, svc.id, (r) => {
      r.config = {
        ...r.config,
        ingestedIds: cfg.ingestedIds,
        checkpoint: cfg.checkpoint,
        scanAfterUid: cfg.scanAfterUid,
        uidValidity: cfg.uidValidity,
      };
      r.status = "connected";
      r.lastSyncedAt = now;
      r.lastSyncError = null;
      r.updatedAt = now;
    });

    return { ok: true, created, updated: 0, deleted: 0, failed, remaining, total: headers.length };
  } catch (e) {
    const error = errMsg(e);
    await updateIntegration(env, svc.id, (r) => {
      r.status = "error";
      r.lastSyncError = error;
      r.updatedAt = now;
    });
    return { ok: false, error };
  } finally {
    try { await client?.close(); } catch { /* noop */ }
  }
}

export function makeEmailProvider(svc: EmailService): IntegrationProvider {
  return {
    id: svc.id,
    name: svc.name,
    category: "email",
    connectLabel: svc.connectLabel,
    connectPlaceholder: svc.connectPlaceholder,
    connectHint: svc.connectHint,
    validateToken: (token: string) => validateEmailToken(token, svc.host),
    sync: (env, store) => runEmailSync(env, store, svc),
  };
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
