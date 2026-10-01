import { describe, it, expect, vi, afterEach } from "vitest";
import { notionProvider, loadIntegration } from "../../src/integrations";
import type { IntegrationRecord } from "../../src/integrations";
import { makeMemoryKV } from "../helpers/make-env";

// #348: a sync holds its loaded record across the whole upstream round trip.
// A layer change (POST /layer) landing in that window must survive the sync's
// final save. The upstream fetch stub below is where the concurrent write lands.

function seedRecord(): IntegrationRecord {
  return {
    provider: "notion",
    authKind: "token",
    credentials: { token: "secret" },
    config: { mirrorWorkspace: "personal" },
    status: "connected",
    workspaceName: "ws",
    lastSyncedAt: null,
    lastSyncError: null,
    itemMap: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

const stubStore = {
  createEntry: vi.fn().mockResolvedValue("entry-1"),
  updateEntry: vi.fn().mockResolvedValue(true),
  deleteEntry: vi.fn().mockResolvedValue(undefined),
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

// Rewrites the KV record's layer to "company" — what POST /layer does — then
// hands back whatever the upstream call would have.
async function flipLayerToCompany(kv: KVNamespace) {
  const rec = JSON.parse((await kv.get("integrations:notion")) as string);
  rec.config.mirrorWorkspace = "company";
  await kv.put("integrations:notion", JSON.stringify(rec));
}

afterEach(() => vi.unstubAllGlobals());

describe("Notion sync vs a concurrent layer change", () => {
  it("a layer change landing mid-sync survives the sync's final save", async () => {
    const kv = makeMemoryKV();
    await kv.put("integrations:notion", JSON.stringify(seedRecord()));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/search")) {
        await flipLayerToCompany(kv);
        return json({
          has_more: false,
          results: [{
            object: "page",
            id: "page-1",
            last_edited_time: "2026-01-01T00:00:00Z",
            url: "https://notion.so/page-1",
            archived: false,
            properties: { title: { type: "title", title: [{ plain_text: "Page One" }] } },
          }],
        });
      }
      // block-children listing
      return json({ has_more: false, results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "body" }] } }] });
    }));

    const out = await notionProvider.sync({ OAUTH_KV: kv }, stubStore);

    expect(out).toMatchObject({ ok: true, created: 1 });
    const rec = await loadIntegration({ OAUTH_KV: kv }, "notion");
    expect(rec!.config.mirrorWorkspace).toBe("company"); // not reverted
    expect(Object.keys(rec!.itemMap)).toHaveLength(1);    // and the sync's own work kept
    expect(rec!.status).toBe("connected");
  });

  it("the error path preserves a concurrent config write too", async () => {
    const kv = makeMemoryKV();
    await kv.put("integrations:notion", JSON.stringify(seedRecord()));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/search")) {
        await flipLayerToCompany(kv);
        return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
      }
      return json({ has_more: false, results: [] });
    }));

    const out = await notionProvider.sync({ OAUTH_KV: kv }, stubStore);

    const rec = await loadIntegration({ OAUTH_KV: kv }, "notion");
    expect(out.ok).toBe(false);
    expect(rec!.config.mirrorWorkspace).toBe("company");
    expect(rec!.status).toBe("error");
    expect(rec!.lastSyncError).toBe("Notion: boom");
  });
});
