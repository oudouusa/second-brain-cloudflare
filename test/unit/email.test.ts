import { connect } from "cloudflare:sockets";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  parseEmailToken,
  isNoiseSender,
  looksBulk,
  computeEmailPlan,
  cleanEmailBody,
  buildEmailContent,
  parseHeaders,
  imapDate,
  ImapClient,
} from "../../src/integrations";
import {
  parseBoundedImapLiteralSize,
  ImapLiteralTooLargeError,
  MAX_IMAP_BODY_BYTES,
  MAX_IMAP_SEARCH_UID_SPAN,
  buildUidSearchRangeQuery,
} from "../../src/integrations/imap";
import { runEmailSync } from "../../src/integrations/email";
import type { EmailHeaderInfo } from "../../src/integrations";
import { makeMemoryKV } from "../helpers/make-env";

// ─── looksBulk ──────────────────────────────────────────────────────────────

describe("looksBulk", () => {
  const personToPerson: Record<string, string> = {
    from: "jordan@example.com",
    to: "me@example.com",
    subject: "Hey",
    date: "Mon, 5 Jan 2026 10:00:00 -0500",
    "message-id": "<abc123@example.com>",
  };

  it("returns false for a plain person-to-person header set", () => {
    expect(looksBulk(personToPerson)).toBe(false);
  });

  const bulkKeys = [
    "list-unsubscribe",
    "list-id",
    "list-post",
    "feedback-id",
    "x-feedback-id",
    "x-auto-response-suppress",
    "x-campaign",
    "x-campaignid",
    "campaign-id",
    "errors-to",
  ];

  for (const key of bulkKeys) {
    it(`returns true when '${key}' is present`, () => {
      expect(looksBulk({ ...personToPerson, [key]: "1" })).toBe(true);
    });
  }

  it("treats precedence: bulk/list/junk as bulk", () => {
    expect(looksBulk({ ...personToPerson, precedence: "bulk" })).toBe(true);
    expect(looksBulk({ ...personToPerson, precedence: "list" })).toBe(true);
    expect(looksBulk({ ...personToPerson, precedence: "junk" })).toBe(true);
  });

  it("does not treat other precedence values as bulk by themselves", () => {
    expect(looksBulk({ ...personToPerson, precedence: "something-else" })).toBe(false);
  });

  it("treats any non-'no' auto-submitted value as bulk", () => {
    expect(looksBulk({ ...personToPerson, "auto-submitted": "auto-generated" })).toBe(true);
    expect(looksBulk({ ...personToPerson, "auto-submitted": "auto-replied" })).toBe(true);
  });

  it("does not treat auto-submitted: no as bulk", () => {
    expect(looksBulk({ ...personToPerson, "auto-submitted": "no" })).toBe(false);
  });
});

// ─── isNoiseSender ──────────────────────────────────────────────────────────

describe("isNoiseSender", () => {
  it.each([
    "<no-reply@x.com>",
    "noreply@x.com",
    "notifications@x.com",
    "alerts@x.com",
    "mailer-daemon@x.com",
    "bounce@x.com",
  ])("treats %s as a noise sender", (from) => {
    expect(isNoiseSender(from)).toBe(true);
  });

  it("treats a real person as not a noise sender", () => {
    expect(isNoiseSender('"Jordan Lee" <jordan@gmail.com>')).toBe(false);
  });

  it("handles bare addresses (no angle brackets)", () => {
    expect(isNoiseSender("noreply@x.com")).toBe(true);
    expect(isNoiseSender("jordan@gmail.com")).toBe(false);
  });

  it("handles Name <addr> form", () => {
    expect(isNoiseSender("No Reply <no-reply@x.com>")).toBe(true);
    expect(isNoiseSender("Mailer Daemon <mailer-daemon@x.com>")).toBe(true);
    expect(isNoiseSender("Jordan Lee <jordan@gmail.com>")).toBe(false);
  });

  // Only the local part was inspected, so a sender that puts the machine marker
  // in the domain walked straight past — which is most large senders, because a
  // brand wants its own name in the local part. These are the shapes that were
  // reaching the brain.
  it.each([
    "brand@notification.example.com",
    "brand@notices.example.com",
    "brand@e-notify.example",
    "info@alerts.example.com",
    "team@mailer.example.com",
  ])("treats %s as a noise sender on the domain", (from) => {
    expect(isNoiseSender(from)).toBe(true);
  });

  // The alternation only spelled `noreply` and `no-reply`; the underscore form
  // is just as common and was slipping through.
  it("catches the underscore spelling of no_reply", () => {
    expect(isNoiseSender("no_reply@example.com")).toBe(true);
    expect(isNoiseSender("do_not_reply@example.com")).toBe(true);
  });

  // Over-reach guard. A domain that merely contains one of these as a substring
  // of a longer word is a real company, not a machine: cutting these would drop
  // correspondence from a person.
  it.each([
    "jordan@notifyhealth.example.com",
    "sam@alertsystems.example.com",
    "wendy.lambert@example.com",
    "chris@mailerson.example.com",
  ])("leaves %s alone", (from) => {
    expect(isNoiseSender(from)).toBe(false);
  });
});

// ─── computeEmailPlan ───────────────────────────────────────────────────────

describe("computeEmailPlan", () => {
  const base = (over: Partial<EmailHeaderInfo>): EmailHeaderInfo => ({
    uid: 1,
    messageId: "id-1",
    from: "jordan@example.com",
    subject: "Hi",
    date: "Mon, 5 Jan 2026 10:00:00 -0500",
    bulk: false,
    ...over,
  });

  it("excludes bulk mail, noise senders, and already-ingested messages; keeps genuine mail sorted by uid ascending", () => {
    const headers: EmailHeaderInfo[] = [
      base({ uid: 30, messageId: "m30", from: "jordan@example.com" }), // genuine, keep
      base({ uid: 10, messageId: "m10", from: "newsletter@brand.com", bulk: true }), // bulk, drop
      base({ uid: 20, messageId: "m20", from: "noreply@service.com" }), // noise sender, drop
      base({ uid: 5, messageId: "m5", from: "sam@example.com" }), // already ingested, drop
      base({ uid: 15, messageId: "m15", from: "sam@example.com" }), // genuine, keep
    ];
    const ingestedIds = new Set(["m5"]);

    const plan = computeEmailPlan(headers, ingestedIds);

    expect(plan.map((h) => h.uid)).toEqual([15, 30]);
  });

  it("returns an empty plan when every candidate is filtered out", () => {
    const headers: EmailHeaderInfo[] = [
      base({ uid: 1, messageId: "m1", bulk: true }),
      base({ uid: 2, messageId: "m2", from: "noreply@x.com" }),
      base({ uid: 3, messageId: "m3" }),
    ];
    expect(computeEmailPlan(headers, new Set(["m3"]))).toEqual([]);
  });

  it("deduplicates a message without Message-ID by its stable IMAP UID", () => {
    expect(computeEmailPlan([base({ uid: 42, messageId: "" })], new Set(["uid:42"]))).toEqual([]);
  });
});

describe("IMAP literal admission", () => {
  it("accepts a body exactly at the bounded MIME processing limit", () => {
    expect(parseBoundedImapLiteralSize(String(MAX_IMAP_BODY_BYTES), MAX_IMAP_BODY_BYTES))
      .toBe(MAX_IMAP_BODY_BYTES);
  });

  it.each([String(MAX_IMAP_BODY_BYTES + 1), "999999999999999999999999"])(
    "rejects %s before allocating the literal",
    (declared) => {
      expect(() => parseBoundedImapLiteralSize(declared, MAX_IMAP_BODY_BYTES))
        .toThrow(ImapLiteralTooLargeError);
    },
  );

  it.each([
    ["not-a-number", 100],
    ["101", 100],
  ])("rejects malformed or over-limit literal %s", (declared, max) => {
    expect(() => parseBoundedImapLiteralSize(declared, max)).toThrow(ImapLiteralTooLargeError);
  });
});

describe("bounded email sync cursor", () => {
  afterEach(() => vi.restoreAllMocks());

  const service = {
    id: "email-gmail",
    name: "Gmail",
    host: "imap.gmail.com",
    connectLabel: "Connect",
    connectPlaceholder: "password",
    connectHint: "hint",
  };

  async function harness(config: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    const kv = makeMemoryKV();
    await kv.put("integrations:email-gmail", JSON.stringify({
      provider: "email-gmail",
      authKind: "token",
      credentials: { token: JSON.stringify({ email: "me@example.com", appPassword: "secret" }) },
      config,
      status: "connected",
      workspaceName: "me@example.com",
      lastSyncedAt: null,
      lastSyncError: null,
      itemMap: {},
      createdAt: 1,
      updatedAt: 1,
    }));
    const raw = new TextEncoder().encode([
      "From: Person <person@example.com>",
      "Subject: Hello",
      "Date: Thu, 27 Aug 2026 09:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "A bounded personal message.",
    ].join("\r\n"));
    const client = {
      login: vi.fn(),
      selectInbox: vi.fn().mockResolvedValue({ exists: 1, uidValidity: 2, uidNext: 12 }),
      uidSearchRangeSince: vi.fn().mockResolvedValue([11]),
      uidFetchHeaders: vi.fn().mockResolvedValue([{
        uid: 11,
        size: raw.byteLength,
        headers: { from: "person@example.com", subject: "Hello", date: "today", "message-id": "" },
      }]),
      uidFetchBody: vi.fn().mockResolvedValue(raw),
      close: vi.fn(),
      ...overrides,
    };
    vi.spyOn(ImapClient, "connect").mockResolvedValue(client as any);
    const store = {
      createEntry: vi.fn().mockResolvedValue("entry-1"),
      updateEntry: vi.fn(),
      deleteEntry: vi.fn(),
    };
    const outcome = await runEmailSync({ OAUTH_KV: kv }, store as any, service);
    const saved = JSON.parse((await kv.get("integrations:email-gmail"))!);
    return { outcome, saved, store, client };
  }

  it("creates one message and advances a UID fallback identity", async () => {
    const { outcome, saved, store } = await harness({});
    expect(outcome).toMatchObject({ ok: true, created: 1, remaining: 0 });
    expect(store.createEntry).toHaveBeenCalledTimes(1);
    expect(saved.config).toMatchObject({ uidValidity: 2, scanAfterUid: 11 });
    expect(saved.config.ingestedIds).toContain("uid:11");
  });

  it("drops stale uid identities when UIDVALIDITY changes", async () => {
    const { outcome, saved } = await harness(
      { uidValidity: 1, scanAfterUid: 99, ingestedIds: ["uid:11", "stable-id"] },
      {
        uidSearchRangeSince: vi.fn().mockResolvedValue([12]),
        uidFetchHeaders: vi.fn().mockResolvedValue([{
          uid: 12,
          size: 100,
          headers: { from: "person@example.com", subject: "Hello", date: "today", "message-id": "" },
        }]),
      },
    );
    expect(outcome).toMatchObject({ created: 1 });
    expect(saved.config.ingestedIds).toContain("stable-id");
    expect(saved.config.ingestedIds).toContain("uid:12");
    expect(saved.config.ingestedIds).not.toContain("uid:11");
  });

  it("durably skips one oversized header and leaves later UIDs pending", async () => {
    const { outcome, saved, store } = await harness({}, {
      selectInbox: vi.fn().mockResolvedValue({ exists: 2, uidValidity: 2, uidNext: 13 }),
      uidSearchRangeSince: vi.fn().mockResolvedValue([11, 12]),
      uidFetchHeaders: vi.fn().mockRejectedValue(new ImapLiteralTooLargeError()),
    });
    expect(outcome).toMatchObject({ ok: true, created: 0, remaining: 1 });
    expect(saved.config.scanAfterUid).toBe(11);
    expect(store.createEntry).not.toHaveBeenCalled();
  });
});

// ─── cleanEmailBody ─────────────────────────────────────────────────────────

describe("cleanEmailBody", () => {
  it("cuts a quoted reply chain", () => {
    const raw =
      "Hey, thanks for that!\n\n" +
      "On Mon, Jan 5, 2026 at 10:00 AM, Jordan Lee <jordan@x.com> wrote:\n" +
      "> Previous message text\n" +
      "> more quoted text";

    const result = cleanEmailBody(raw);

    expect(result).toBe("Hey, thanks for that!");
    expect(result).not.toContain("Previous message");
    expect(result).not.toContain("wrote:");
  });

  it("drops a signature after '-- '", () => {
    const raw = "Hello there,\nMain content.\n-- \nJordan\nCEO, Example Inc.";

    const result = cleanEmailBody(raw);

    expect(result).toBe("Hello there,\nMain content.");
    expect(result).not.toContain("Jordan");
    expect(result).not.toContain("CEO");
  });

  it("drops leading '>' quote lines", () => {
    const raw = "Real line one\n> quoted line\nReal line two\n   > indented quoted";

    const result = cleanEmailBody(raw);

    expect(result).toBe("Real line one\nReal line two");
  });

  it("caps the body at the max length and appends an ellipsis", () => {
    const huge = "x".repeat(5000);

    const result = cleanEmailBody(huge);

    expect(result.length).toBe(4002); // 4000 chars + "\n…"
    expect(result.endsWith("\n…")).toBe(true);
    expect(result.startsWith("x".repeat(4000))).toBe(true);
  });

  it("keeps ordinary body text untouched", () => {
    const raw = "Just a normal short message with no quoting or signature.";
    expect(cleanEmailBody(raw)).toBe(raw);
  });

  // Transactional mail is deliberately built NOT to look like bulk mail — it
  // carries no List-Unsubscribe, so `looksBulk` lets it through by design. What
  // arrives is one line of fact wrapped in several thousand characters of
  // templated trailer, and because the trailer is templated it repeats across
  // every sender, which is what makes it dominate retrieval.
  it("drops a bulk-mail trailer that follows the transactional fact", () => {
    const raw = [
      "You sent $40.00 to alex@example.com.",
      "Payment ID: ABC123",
      "",
      "Thanks for choosing Northwind Bank.",
      "Follow Northwind Bank on Instagram",
      "Follow Northwind Bank on X",
      "Download the Northwind Bank Mobile app",
      "This email was sent by: Northwind Bank, 1 Example Plaza",
    ].join("\n");

    const result = cleanEmailBody(raw);

    expect(result).toContain("You sent $40.00 to alex@example.com.");
    expect(result).toContain("Payment ID: ABC123");
    expect(result).not.toContain("Thanks for choosing");
    expect(result).not.toContain("Follow Northwind Bank");
    expect(result).not.toContain("This email was sent by");
  });

  it("drops an unsubscribe trailer", () => {
    const raw = "Your statement is ready.\n\nUnsubscribe | Manage preferences\nView in browser";

    const result = cleanEmailBody(raw);

    expect(result).toBe("Your statement is ready.");
  });

  it("keeps a body that merely mentions choosing something", () => {
    const raw = "We are choosing between two vendors and I wanted your view.";
    expect(cleanEmailBody(raw)).toBe(raw);
  });
});

// ─── buildEmailContent ──────────────────────────────────────────────────────

describe("buildEmailContent", () => {
  it("leads with the subject heading, then a From line with the date, then the body", () => {
    const content = buildEmailContent(
      "Meeting notes",
      "Jordan Lee <jordan@example.com>",
      "Mon, 5 Jan 2026 10:00:00 -0500",
      "Let's meet at 3pm.",
    );
    expect(content).toBe(
      "# Meeting notes\nFrom: Jordan Lee <jordan@example.com>  ·  Mon, 5 Jan 2026 10:00:00 -0500\n\nLet's meet at 3pm.",
    );
  });

  it("falls back to '(no subject)' for an empty subject", () => {
    const content = buildEmailContent("", "a@b.com", "", "Body text");
    expect(content).toBe("# (no subject)\nFrom: a@b.com\n\nBody text");
  });

  it("omits the date separator when date is empty", () => {
    const content = buildEmailContent("Subj", "a@b.com", "", "Body");
    expect(content).toBe("# Subj\nFrom: a@b.com\n\nBody");
  });

  it("omits the body block entirely when body is empty", () => {
    const content = buildEmailContent("Subj", "a@b.com", "Mon, 5 Jan 2026", "");
    expect(content).toBe("# Subj\nFrom: a@b.com  ·  Mon, 5 Jan 2026");
  });
});

// ─── parseEmailToken ────────────────────────────────────────────────────────

describe("parseEmailToken", () => {
  it("parses a valid JSON token and trims the email", () => {
    const token = JSON.stringify({ email: "  test@x.com  ", appPassword: "abcd-1234" });
    expect(parseEmailToken(token)).toEqual({ email: "test@x.com", appPassword: "abcd-1234" });
  });

  it("throws for a non-JSON token", () => {
    expect(() => parseEmailToken("not-json-at-all")).toThrow(
      "This email connection is missing its credentials — please reconnect it.",
    );
  });

  it("throws when the appPassword field is missing", () => {
    const token = JSON.stringify({ email: "test@x.com" });
    expect(() => parseEmailToken(token)).toThrow();
  });

  it("throws when the email field is missing", () => {
    const token = JSON.stringify({ appPassword: "abcd-1234" });
    expect(() => parseEmailToken(token)).toThrow();
  });

  it("throws when the email is empty/whitespace-only", () => {
    const token = JSON.stringify({ email: "   ", appPassword: "abcd-1234" });
    expect(() => parseEmailToken(token)).toThrow();
  });

  it("throws when the appPassword is empty", () => {
    const token = JSON.stringify({ email: "test@x.com", appPassword: "" });
    expect(() => parseEmailToken(token)).toThrow();
  });
});

// ─── parseHeaders ───────────────────────────────────────────────────────────

describe("parseHeaders", () => {
  it("parses Name: value lines into a lowercased-key map, unfolds continuations, and ignores non-header lines", () => {
    const raw = [
      "From: Jordan Lee <jordan@x.com>",
      "Subject: Weekly sync",
      " agenda attached",
      "Date: Mon, 5 Jan 2026 10:00:00 -0500",
      "not a header line without a colon",
      "",
    ].join("\r\n");

    expect(parseHeaders(raw)).toEqual({
      from: "Jordan Lee <jordan@x.com>",
      subject: "Weekly sync agenda attached",
      date: "Mon, 5 Jan 2026 10:00:00 -0500",
    });
  });

  it("unfolds a continuation line indented with a tab", () => {
    const raw = ["X-Custom: first part", "\tsecond part"].join("\r\n");
    expect(parseHeaders(raw)).toEqual({ "x-custom": "first part second part" });
  });
});

// ─── imapDate ───────────────────────────────────────────────────────────────

describe("imapDate", () => {
  it("formats a UTC date as D-Mon-YYYY", () => {
    expect(imapDate(new Date(Date.UTC(2026, 6, 4)))).toBe("4-Jul-2026");
  });

  it("does not zero-pad single-digit days", () => {
    expect(imapDate(new Date(Date.UTC(2026, 0, 1)))).toBe("1-Jan-2026");
  });

  it("formats a two-digit day and December correctly", () => {
    expect(imapDate(new Date(Date.UTC(2025, 11, 25)))).toBe("25-Dec-2025");
  });

  it("formats a bounded UID search cursor without changing date semantics", () => {
    expect(buildUidSearchRangeQuery(new Date(Date.UTC(2026, 7, 27)), 101, 356))
      .toBe("UID SEARCH UID 101:356 SINCE 27-Aug-2026");
  });

  it("rejects an unbounded UID search range before sending the command", () => {
    expect(() => buildUidSearchRangeQuery(
      new Date(Date.UTC(2026, 7, 27)),
      1,
      MAX_IMAP_SEARCH_UID_SPAN + 1,
    )).toThrow(/search range exceeds/);
  });

  it.each([
    [1.5, 2],
    [1, 2.5],
    [0, 1],
    [2, 1],
  ])("rejects invalid UID range %s:%s", (first, last) => {
    expect(() => buildUidSearchRangeQuery(new Date(), first, last)).toThrow(/search range exceeds/);
  });
});


describe("IMAPの接続所有権", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["invalid", "error", "timeout"])("挨拶の%s時に呼出元へ返せない接続を閉じる", async mode => {
    vi.useFakeTimers();
    const failure = new Error("synthetic greeting failure");
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        if (mode === "error") controller.error(failure);
        if (mode === "invalid") controller.enqueue(new TextEncoder().encode("* BYE unavailable\r\n"));
      },
    });
    const writable = new WritableStream();
    const close = vi.fn(async () => { if (mode !== "error") source.close(); });
    vi.mocked(connect).mockReturnValueOnce({ readable, writable, close } as never);
    const connection = ImapClient.connect("synthetic.invalid");
    const rejected = mode === "error" ? expect(connection).rejects.toBe(failure)
      : expect(connection).rejects.toThrow(mode === "timeout" ? "IMAP read timeout" : "unexpected IMAP greeting");
    if (mode === "timeout") await vi.runAllTimersAsync();
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    expect(readable.locked).toBe(false);
    expect(writable.locked).toBe(false);
  });
});
