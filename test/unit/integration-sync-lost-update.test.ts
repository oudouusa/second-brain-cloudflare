import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { makeMemoryKV } from "../helpers/make-env";
import { loadIntegration, makeCalendarProvider, makeEmailProvider } from "../../src/integrations";
import type { IntegrationRecord } from "../../src/integrations";

// #348 for the calendar and email providers. Same shape as
// notion-sync-lost-update.test.ts: a layer change (POST /layer) lands in KV
// from inside the stubbed upstream call, while the sync holds its loaded
// record, and must survive the sync's save. The sync's OWN keys must land too.

// The IMAP client opens a TLS socket, so the email cases stub the class. Each
// test points `imapHooks.onSearch` at the concurrent write it wants to land.
const imapHooks = vi.hoisted(() => ({
  onSearch: async (): Promise<void> => {},
  fail: false,
}));
vi.mock("../../src/integrations/imap", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/integrations/imap")>(),
  ImapClient: {
    connect: async () => ({
      login: async () => {},
      selectInbox: async () => ({ exists: 1, uidNext: 8, uidValidity: 1 }),
      uidSearchRangeSince: async () => {
        await imapHooks.onSearch();
        if (imapHooks.fail) throw new Error("imap search exploded");
        return [7];
      },
      uidFetchHeaders: async () => [{
        uid: 7,
        size: 400,
        headers: { "message-id": "<msg-7@example.com>", from: "Alice <alice@example.com>", subject: "Hello", date: "Mon, 1 Jan 2026 10:00:00 +0000" },
      }],
      uidFetchBody: async () => new TextEncoder().encode(
        "From: Alice <alice@example.com>\r\nSubject: Hello\r\nMessage-ID: <msg-7@example.com>\r\nContent-Type: text/plain\r\n\r\nHi there, body text.\r\n",
      ),
      close: async () => {},
    }),
  },
}));

const DAY_MS = 86_400_000;

function seed(provider: string, config: Record<string, unknown>): IntegrationRecord {
  return {
    provider,
    authKind: "token",
    credentials: { token: provider === "email-gmail" ? JSON.stringify({ email: "me@example.com", appPassword: "pw" }) : "https://cal.example/x.ics" },
    config,
    status: "connected",
    workspaceName: "ws",
    lastSyncedAt: null,
    lastSyncError: null,
    itemMap: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

// What POST /layer does to the KV blob, from another request.
async function flipLayerToCompany(kv: KVNamespace, provider: string) {
  const rec = JSON.parse((await kv.get(`integrations:${provider}`)) as string);
  rec.config.mirrorWorkspace = "company";
  await kv.put(`integrations:${provider}`, JSON.stringify(rec));
}

const store = () => ({
  createEntry: vi.fn().mockResolvedValue("entry-1"),
  updateEntry: vi.fn().mockResolvedValue(true),
  deleteEntry: vi.fn().mockResolvedValue(undefined),
});

afterEach(() => vi.unstubAllGlobals());

describe("calendar sync vs a concurrent layer change", () => {
  const calId = "calendar-google";
  const provider = makeCalendarProvider({ id: calId, name: "Google Calendar", connectLabel: "", connectPlaceholder: "", connectHint: "" });

  function icsWithOneUpcomingEvent(): string {
    const now = Date.now();
    const fmt = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    return [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN",
      "BEGIN:VEVENT", "UID:evt-1@test", `DTSTAMP:${fmt(now)}`,
      `DTSTART:${fmt(now + 5 * DAY_MS)}`, `DTEND:${fmt(now + 5 * DAY_MS + 3600_000)}`, "SUMMARY:Upcoming",
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
  }

  it("a layer change landing mid-sync survives, and the sync's own calendarMeta + itemMap land", async () => {
    const kv = makeMemoryKV();
    await kv.put(`integrations:${calId}`, JSON.stringify(seed(calId, { mirrorWorkspace: "personal", connectedByUserId: "u1" })));
    const ics = icsWithOneUpcomingEvent();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      await flipLayerToCompany(kv, calId);
      return { ok: true, status: 200, text: async () => ics };
    }));

    const out = await provider.sync({ OAUTH_KV: kv }, store());

    expect(out).toMatchObject({ ok: true, created: 1 });
    const rec = (await loadIntegration({ OAUTH_KV: kv }, calId))!;
    expect(rec.config.mirrorWorkspace).toBe("company"); // not reverted
    expect(rec.config.connectedByUserId).toBe("u1");    // untouched keys stay
    expect(Object.keys(rec.itemMap)).toHaveLength(1);   // the sync's own itemMap delta
    expect(Object.keys(rec.config.calendarMeta as object)).toHaveLength(1); // and its own config key
    expect(rec.status).toBe("connected");
  });

  it("the error path preserves a concurrent config write too", async () => {
    const kv = makeMemoryKV();
    await kv.put(`integrations:${calId}`, JSON.stringify(seed(calId, { mirrorWorkspace: "personal" })));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      await flipLayerToCompany(kv, calId);
      throw new Error("feed unreachable");
    }));

    const out = await provider.sync({ OAUTH_KV: kv }, store());

    const rec = (await loadIntegration({ OAUTH_KV: kv }, calId))!;
    expect(out.ok).toBe(false);
    expect(rec.config.mirrorWorkspace).toBe("company");
    expect(rec.status).toBe("error");
    expect(rec.lastSyncError).toContain("feed unreachable");
  });
});

describe("email sync vs a concurrent layer change", () => {
  const svc = { id: "email-gmail", name: "Gmail", host: "imap.gmail.com", connectLabel: "", connectPlaceholder: "", connectHint: "" };
  const provider = makeEmailProvider(svc);

  beforeEach(() => {
    imapHooks.fail = false;
    imapHooks.onSearch = async () => {};
  });

  it("a layer change landing mid-sync survives, and only the email-owned keys (checkpoint, ingestedIds) are written", async () => {
    const kv = makeMemoryKV();
    await kv.put("integrations:email-gmail", JSON.stringify(seed("email-gmail", { mirrorWorkspace: "personal", connectedByUserId: "u1" })));
    imapHooks.onSearch = () => flipLayerToCompany(kv, "email-gmail");

    const out = await provider.sync({ OAUTH_KV: kv }, store());

    expect(out).toMatchObject({ ok: true, created: 1, remaining: 0 });
    const rec = (await loadIntegration({ OAUTH_KV: kv }, "email-gmail"))!;
    expect(rec.config.mirrorWorkspace).toBe("company"); // not reverted by a wholesale config write
    expect(rec.config.connectedByUserId).toBe("u1");
    expect(rec.config.ingestedIds).toEqual(["<msg-7@example.com>"]); // the sync's own keys landed
    expect(typeof rec.config.checkpoint).toBe("number");
    expect(rec.status).toBe("connected");
  });

  it("a config key that appears mid-sync (not just the layer) survives the success save", async () => {
    const kv = makeMemoryKV();
    await kv.put("integrations:email-gmail", JSON.stringify(seed("email-gmail", { mirrorWorkspace: "personal" })));
    imapHooks.onSearch = async () => {
      const rec = JSON.parse((await kv.get("integrations:email-gmail")) as string);
      rec.config.someFutureKey = "kept";
      await kv.put("integrations:email-gmail", JSON.stringify(rec));
    };

    await provider.sync({ OAUTH_KV: kv }, store());

    const rec = (await loadIntegration({ OAUTH_KV: kv }, "email-gmail"))!;
    expect(rec.config.someFutureKey).toBe("kept");
  });

  it("the IMAP error path preserves a concurrent config write too", async () => {
    const kv = makeMemoryKV();
    await kv.put("integrations:email-gmail", JSON.stringify(seed("email-gmail", { mirrorWorkspace: "personal" })));
    imapHooks.onSearch = () => flipLayerToCompany(kv, "email-gmail");
    imapHooks.fail = true;

    const out = await provider.sync({ OAUTH_KV: kv }, store());

    const rec = (await loadIntegration({ OAUTH_KV: kv }, "email-gmail"))!;
    expect(out.ok).toBe(false);
    expect(rec.config.mirrorWorkspace).toBe("company");
    expect(rec.status).toBe("error");
    expect(rec.lastSyncError).toContain("imap search exploded");
  });

  it("the bad-credentials error path is a mutator too", async () => {
    const kv = makeMemoryKV();
    const rec = seed("email-gmail", { mirrorWorkspace: "company", extra: 1 });
    rec.credentials = { token: "not json" };
    await kv.put("integrations:email-gmail", JSON.stringify(rec));

    const out = await provider.sync({ OAUTH_KV: kv }, store());

    const after = (await loadIntegration({ OAUTH_KV: kv }, "email-gmail"))!;
    expect(out.ok).toBe(false);
    expect(after.status).toBe("error");
    expect(after.config).toEqual({ mirrorWorkspace: "company", extra: 1 });
  });
});
