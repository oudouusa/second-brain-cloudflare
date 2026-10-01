import { describe, it, expect } from "vitest";
import {
  extractPageTitle,
  flattenBlocks,
  buildPageContent,
  computeSyncPlan,
  integrationStatus,
  loadIntegration,
  notionProvider,
  getProvider,
} from "../../src/integrations";
import type { NotionPageMeta, ItemMapEntry, IntegrationRecord } from "../../src/integrations";
import { makeMemoryKV } from "../helpers/make-env";

function page(id: string, lastEdited: string, archived = false): NotionPageMeta {
  return { id, lastEdited, title: `Page ${id}`, url: `https://notion.so/${id}`, archived };
}

describe("extractPageTitle", () => {
  it("reads the title property regardless of its name", () => {
    const p = {
      properties: {
        Status: { type: "select", select: { name: "Done" } },
        Name: { type: "title", title: [{ plain_text: "My " }, { plain_text: "Note" }] },
      },
    };
    expect(extractPageTitle(p)).toBe("My Note");
  });

  it("falls back to Untitled when there is no title text", () => {
    expect(extractPageTitle({ properties: { title: { type: "title", title: [] } } })).toBe("Untitled");
    expect(extractPageTitle({})).toBe("Untitled");
    expect(extractPageTitle(null)).toBe("Untitled");
  });
});

describe("flattenBlocks", () => {
  const rt = (text: string) => [{ plain_text: text }];

  it("renders common block types", () => {
    const blocks = [
      { type: "heading_1", heading_1: { rich_text: rt("Title") } },
      { type: "paragraph", paragraph: { rich_text: rt("Hello world") } },
      { type: "bulleted_list_item", bulleted_list_item: { rich_text: rt("item") } },
      { type: "to_do", to_do: { rich_text: rt("task"), checked: true } },
      { type: "quote", quote: { rich_text: rt("wise words") } },
      { type: "divider", divider: {} },
      { type: "child_page", child_page: { title: "Sub" } },
    ];
    expect(flattenBlocks(blocks)).toBe(
      "# Title\nHello world\n- item\n[x] task\n> wise words\n---\n[Sub-page: Sub]"
    );
  });

  it("indents nested children attached as _children", () => {
    const blocks = [
      {
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: rt("parent") },
        _children: [{ type: "bulleted_list_item", bulleted_list_item: { rich_text: rt("child") } }],
      },
    ];
    expect(flattenBlocks(blocks)).toBe("- parent\n  - child");
  });

  it("skips empty blocks and unknown types without rich text", () => {
    const blocks = [
      { type: "paragraph", paragraph: { rich_text: [] } },
      { type: "image", image: { file: { url: "x" } } },
      { type: "paragraph", paragraph: { rich_text: rt("kept") } },
    ];
    expect(flattenBlocks(blocks)).toBe("kept");
  });

  it("stops joining legal maximum rich-text arrays at the page budget", () => {
    const hugeRichText = Array.from({ length: 100 }, (_, index) => ({
      plain_text: `${String(index).padStart(3, "0")}:${"x".repeat(1996)}`,
    }));
    const blocks = Array.from({ length: 100 }, () => ({
      type: "paragraph",
      paragraph: { rich_text: hugeRichText },
    }));

    const text = flattenBlocks(blocks);
    expect(text.length).toBeLessThanOrEqual(8000);
    expect(text).not.toContain("099:");
  });
});

describe("buildPageContent", () => {
  it("leads with title and source URL", () => {
    const content = buildPageContent("My Note", "https://notion.so/abc", "body text");
    expect(content).toBe("# My Note\nhttps://notion.so/abc\n\nbody text");
  });

  it("truncates very long bodies", () => {
    const content = buildPageContent("T", "u", "x".repeat(10000));
    expect(content.length).toBeLessThan(9000);
    expect(content.endsWith("…")).toBe(true);
  });
});

describe("computeSyncPlan", () => {
  const map = (entries: Record<string, string>): Record<string, ItemMapEntry> =>
    Object.fromEntries(Object.entries(entries).map(([id, version]) => [id, { entryId: `e-${id}`, version }]));

  it("treats unseen pages as changed", () => {
    const plan = computeSyncPlan([page("a", "2026-01-01T00:00:00Z")], {}, true);
    expect(plan.changed.map(p => p.id)).toEqual(["a"]);
    expect(plan.deleted).toEqual([]);
  });

  it("treats edited pages as changed and unchanged pages as no-ops", () => {
    const pageMap = map({ a: "2026-01-01T00:00:00Z", b: "2026-01-01T00:00:00Z" });
    const plan = computeSyncPlan(
      [page("a", "2026-01-02T00:00:00Z"), page("b", "2026-01-01T00:00:00Z")],
      pageMap,
      true,
    );
    expect(plan.changed.map(p => p.id)).toEqual(["a"]);
  });

  it("orders changed pages oldest first so partial batches converge", () => {
    const plan = computeSyncPlan(
      [page("new", "2026-03-01T00:00:00Z"), page("old", "2026-01-01T00:00:00Z")],
      {},
      true,
    );
    expect(plan.changed.map(p => p.id)).toEqual(["old", "new"]);
  });

  it("deletes mirrors for pages missing from a COMPLETE listing", () => {
    const plan = computeSyncPlan([], map({ gone: "2026-01-01T00:00:00Z" }), true);
    expect(plan.deleted).toEqual(["gone"]);
  });

  it("never deletes from a truncated listing", () => {
    const plan = computeSyncPlan([], map({ gone: "2026-01-01T00:00:00Z" }), false);
    expect(plan.deleted).toEqual([]);
  });

  it("deletes archived pages even from a truncated listing", () => {
    const plan = computeSyncPlan(
      [page("a", "2026-01-02T00:00:00Z", true)],
      map({ a: "2026-01-01T00:00:00Z" }),
      false,
    );
    expect(plan.deleted).toEqual(["a"]);
    expect(plan.changed).toEqual([]); // archived pages are never re-ingested
  });

  it("archived + inherited-name id must not be scheduled for deletion: nothing is mirrored under it", () => {
    expect(computeSyncPlan([page("constructor", "2026-01-01T00:00:00Z", true)], {}, true).deleted).toEqual([]);
  });

  it("a non-archived inherited-name id is simply new work", () => {
    expect(computeSyncPlan([page("toString", "2026-01-01T00:00:00Z")], {}, true).changed.map(p => p.id)).toEqual(["toString"]);
  });

  it("__proto__ inherited-name id is simply new work when non-archived", () => {
    expect(computeSyncPlan([page("__proto__", "2026-01-01T00:00:00Z")], {}, true).changed.map(p => p.id)).toEqual(["__proto__"]);
  });

  it("a legitimate own-property entry with key 'constructor' is still found and deleted when archived", () => {
    const itemMap = { constructor: { entryId: "e1", version: "v1" } } as unknown as Record<string, ItemMapEntry>;
    const plan = computeSyncPlan([page("constructor", "2026-01-01T00:00:00Z", true)], itemMap, true);
    expect(plan.deleted).toEqual(["constructor"]);
  });

  it("a legitimate own-property entry with key 'constructor' is not marked changed when version matches", () => {
    const itemMap = { constructor: { entryId: "e1", version: "2026-01-01T00:00:00Z" } } as unknown as Record<string, ItemMapEntry>;
    const plan = computeSyncPlan([page("constructor", "2026-01-01T00:00:00Z")], itemMap, true);
    expect(plan.changed.map(p => p.id)).toEqual([]);
  });
});

describe("integrationStatus", () => {
  it("reports a disconnected provider", () => {
    expect(integrationStatus(notionProvider, null)).toEqual({
      provider: "notion",
      name: "Notion",
      connected: false,
      status: null,
      workspaceName: null,
      lastSyncedAt: null,
      lastSyncError: null,
      itemCount: 0,
      category: "knowledge",
      // Provenance, additive: every key above keeps its name and value. A
      // provider nobody has connected has no actor and no connect time, and
      // reads as the personal mirror layer because that is what the write path
      // would do with an absent config.
      mirrorWorkspace: "personal",
      connectedByUserId: null,
      connectedAt: null,
    });
  });

  it("summarizes a connected record without exposing credentials", () => {
    const record: IntegrationRecord = {
      provider: "notion",
      authKind: "token",
      credentials: { token: "ntn_secret" },
      config: {},
      status: "connected",
      workspaceName: "Test Workspace",
      lastSyncedAt: 123,
      lastSyncError: null,
      itemMap: { p1: { entryId: "e1", version: "t" } },
      createdAt: 1,
      updatedAt: 2,
    };
    const status = integrationStatus(notionProvider, record);
    expect(status.connected).toBe(true);
    expect(status.workspaceName).toBe("Test Workspace");
    expect(status.itemCount).toBe(1);
    expect(JSON.stringify(status)).not.toContain("ntn_secret");
  });
});

describe("provider registry", () => {
  it("resolves registered providers and rejects unknown ids", () => {
    expect(getProvider("notion")).toBe(notionProvider);
    expect(getProvider("nope")).toBeNull();
    expect(getProvider("hasOwnProperty")).toBeNull(); // prototype names are not providers
  });
});

describe("loadIntegration legacy migration", () => {
  it("migrates first-release pageMap/lastEdited blobs to itemMap/version", async () => {
    const kv = makeMemoryKV();
    await kv.put("integrations:notion", JSON.stringify({
      provider: "notion",
      authKind: "token",
      credentials: { token: "ntn_x" },
      config: {},
      status: "connected",
      workspaceName: "W",
      lastSyncedAt: 1,
      lastSyncError: null,
      pageMap: { p1: { entryId: "e1", lastEdited: "2026-01-01T00:00:00.000Z" } },
      createdAt: 1,
      updatedAt: 1,
    }));

    const record = await loadIntegration({ OAUTH_KV: kv }, "notion");
    expect(record?.itemMap).toEqual({ p1: { entryId: "e1", version: "2026-01-01T00:00:00.000Z" } });
    expect((record as any).pageMap).toBeUndefined();
  });
});
