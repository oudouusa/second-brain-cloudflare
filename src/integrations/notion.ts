import { BodyTooLargeError, readBoundedResponseText } from "../lib/body";
/**
 * Second Brain — Notion provider.
 *
 * Mirrors every page shared with the user's internal Notion connection into
 * memory. Notion's sharing model IS the selection mechanism: users share pages
 * (and their subtrees) with the connection in Notion, and the search listing
 * returns exactly that set.
 */

import type { IntegrationEnv, IntegrationProvider, ItemMapEntry, MirrorStore, SyncOutcome } from "./framework";
import { ItemMapDeltas, loadIntegration, updateIntegration } from "./framework";

// ─── API client ───────────────────────────────────────────────────────────────

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// D1, not outbound fetch count, is the binding Free-plan budget after durable
// vector cleanup and provider-operation fencing. Callers loop on `remaining`.
const SEARCH_PAGE_SIZE = 10;
const MAX_TRACKED_PAGES = 500;
export const SYNC_PAGE_BATCH = 1;
const BLOCK_PAGE_SIZE = 20;
const ROOT_BLOCK_REQUESTS = 2;     // ≤ 40 top-level blocks per page
const NESTED_BLOCK_REQUESTS = 4;   // one level of children for the first 4 nested blocks
const MAX_PAGE_CONTENT_CHARS = 8000;
export const MAX_NOTION_RESPONSE_BYTES = 128 * 1024;

class NotionResponseTooLargeError extends Error {
  constructor() {
    super("Notion response exceeds the safe processing limit");
    this.name = "NotionResponseTooLargeError";
  }
}

class NotionApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "NotionApiError";
  }
}

async function readNotionJson(res: Response): Promise<any> {
  let text: string;
  try {
    text = await readBoundedResponseText(res, MAX_NOTION_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new NotionResponseTooLargeError();
    throw error;
  }
  return JSON.parse(text);
}

async function notionFetch(token: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    let message = `Notion API error (${res.status})`;
    try {
      const body = await readNotionJson(res);
      if (body?.message) message = `Notion: ${body.message}`;
    } catch { /* non-JSON error body — keep the status message */ }
    throw new NotionApiError(res.status, message);
  }
  return readNotionJson(res);
}

// Validate an internal-connection token and return the workspace name for the
// settings UI's "Connected to …" confirmation.
export async function notionValidateToken(token: string): Promise<string> {
  const me = await notionFetch(token, "/users/me");
  return me?.bot?.workspace_name ?? me?.name ?? "Notion workspace";
}

export interface NotionPageMeta {
  id: string;
  lastEdited: string;
  title: string;
  url: string;
  archived: boolean;
}

// List every page the connection can access.
export async function notionListPages(
  token: string,
  startCursor?: string,
): Promise<{ pages: NotionPageMeta[]; complete: boolean; nextCursor?: string }> {
  const pages: NotionPageMeta[] = [];
  const body: Record<string, unknown> = {
    filter: { property: "object", value: "page" },
    page_size: SEARCH_PAGE_SIZE,
    sort: { direction: "ascending", timestamp: "last_edited_time" },
  };
  if (startCursor) body.start_cursor = startCursor;
  const data = await notionFetch(token, "/search", { method: "POST", body: JSON.stringify(body) });
  for (const p of (data.results ?? []) as any[]) {
    if (p?.object !== "page") continue;
    pages.push({
      id: String(p.id ?? "").slice(0, 128),
      lastEdited: String(p.last_edited_time ?? "").slice(0, 64),
      title: extractPageTitle(p),
      url: String(p.url ?? "").slice(0, 2048),
      archived: p.archived === true || p.in_trash === true,
    });
  }
  const complete = data.has_more !== true;
  const nextCursor = complete ? undefined : String(data.next_cursor ?? "").slice(0, 1024);
  if (!complete && !nextCursor) throw new Error("Notion listing did not provide a continuation cursor");
  return { pages, complete, nextCursor };
}

// A page's title lives in whichever property has type "title" (name varies by
// parent database; standalone pages use "title").
export function extractPageTitle(page: any): string {
  const props = page?.properties ?? {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop?.type === "title" && Array.isArray(prop.title)) {
      const text = boundedRichText(prop.title, 500).trim();
      if (text) return text;
    }
  }
  return "Untitled";
}

function boundedRichText(rich: any[], maxChars: number): string {
  let text = "";
  for (const item of rich) {
    if (text.length >= maxChars) break;
    text += String(item?.plain_text ?? "").slice(0, maxChars - text.length);
  }
  return text;
}

function blockText(block: any, maxChars: number): string {
  const data = block?.[block?.type];
  const rich = data?.rich_text;
  if (!Array.isArray(rich)) return "";
  return boundedRichText(rich, maxChars);
}

// Flatten Notion blocks to plain text for embedding. Nested children (attached
// as `_children` by notionFetchPageText) indent one level per depth.
export function flattenBlocks(blocks: any[], depth = 0): string {
  return flattenBlocksWithinBudget(blocks, depth, { remaining: MAX_PAGE_CONTENT_CHARS });
}

function flattenBlocksWithinBudget(blocks: any[], depth: number, budget: { remaining: number }): string {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  for (const block of blocks ?? []) {
    if (budget.remaining <= 0) break;
    const text = blockText(block, budget.remaining);
    let line = "";
    switch (block?.type) {
      case "heading_1": line = `# ${text}`; break;
      case "heading_2": line = `## ${text}`; break;
      case "heading_3": line = `### ${text}`; break;
      case "bulleted_list_item":
      case "numbered_list_item": line = `- ${text}`; break;
      case "to_do": line = `[${block.to_do?.checked ? "x" : " "}] ${text}`; break;
      case "quote":
      case "callout": line = `> ${text}`; break;
      case "code": line = "```" + String(block.code?.language ?? "").slice(0, 40) + "\n" + text + "\n```"; break;
      case "divider": line = "---"; break;
      // Child pages sync as their own entries when shared — reference, don't inline.
      case "child_page": line = `[Sub-page: ${String(block.child_page?.title ?? "Untitled").slice(0, 500)}]`; break;
      case "child_database": line = `[Database: ${String(block.child_database?.title ?? "Untitled").slice(0, 500)}]`; break;
      case "bookmark": line = String(block.bookmark?.url ?? "").slice(0, 2048); break;
      default: line = text; // paragraph, toggle, and anything else with rich_text
    }
    if (line.trim()) {
      const boundedLine = (indent + line).slice(0, budget.remaining);
      lines.push(boundedLine);
      budget.remaining -= boundedLine.length + 1;
    }
    if (budget.remaining > 0 && Array.isArray(block?._children) && block._children.length) {
      const childText = flattenBlocksWithinBudget(block._children, depth + 1, budget);
      if (childText) lines.push(childText);
    }
  }
  return lines.join("\n");
}

async function notionListChildren(token: string, blockId: string, maxRequests: number): Promise<any[]> {
  const blocks: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxRequests; i++) {
    const qs = new URLSearchParams({ page_size: String(BLOCK_PAGE_SIZE) });
    if (cursor) qs.set("start_cursor", cursor);
    const data = await notionFetch(token, `/blocks/${blockId}/children?${qs}`);
    blocks.push(...((data.results ?? []) as any[]));
    if (!data.has_more) break;
    cursor = data.next_cursor as string;
  }
  return blocks;
}

// Fetch a page's content as flattened text. One level of nesting only
// (indented bullets, toggle bodies) under a bounded request budget — deep
// trees truncate rather than risk the Worker's subrequest limit.
export async function notionFetchPageText(token: string, pageId: string): Promise<string> {
  const blocks = await notionListChildren(token, pageId, ROOT_BLOCK_REQUESTS);
  const rootText = flattenBlocks(blocks);
  if (rootText.length >= MAX_PAGE_CONTENT_CHARS) return rootText;
  let nestedBudget = NESTED_BLOCK_REQUESTS;
  for (const block of blocks) {
    if (nestedBudget <= 0) break;
    if (block?.has_children && block.type !== "child_page" && block.type !== "child_database") {
      nestedBudget--;
      try {
        block._children = await notionListChildren(token, block.id, 1);
        if (flattenBlocks(blocks).length >= MAX_PAGE_CONTENT_CHARS) break;
      } catch (e) {
        console.error(`Notion nested block fetch failed for ${block.id} (non-fatal):`, e);
      }
    }
  }
  return flattenBlocks(blocks);
}

// Title + source URL lead the content: the title sharpens embedding quality,
// and the URL lets recall results link back to the live page.
export function buildPageContent(title: string, url: string, text: string): string {
  const body = text.length > MAX_PAGE_CONTENT_CHARS ? `${text.slice(0, MAX_PAGE_CONTENT_CHARS)}\n…` : text;
  return [`# ${title}`, url, "", body].join("\n").trim();
}

// ─── Sync planning ────────────────────────────────────────────────────────────
// Per-page version comparison against the itemMap (not a global cursor):
// robust to Notion's minute-granularity timestamps, and a partially-processed
// batch simply leaves the unprocessed pages "changed" for the next run.

export interface SyncPlan {
  changed: NotionPageMeta[]; // new or edited, oldest first so partial batches converge
  deleted: string[];         // page ids whose mirrors should be removed
}

export function computeSyncPlan(
  pages: NotionPageMeta[],
  itemMap: Record<string, ItemMapEntry>,
  listingComplete: boolean,
): SyncPlan {
  // Item ids are arbitrary external strings, so a plain bracket read can hit an
  // inherited name ("constructor", "__proto__") and report a mirror that is not there.
  const mirrored = (id: string) => (Object.hasOwn(itemMap, id) ? itemMap[id] : undefined);

  const changed = pages
    .filter(p => !p.archived && mirrored(p.id)?.version !== p.lastEdited)
    .sort((a, b) => (a.lastEdited < b.lastEdited ? -1 : 1));

  const deleted: string[] = [];
  // Archived/trashed pages are an explicit delete signal even on a truncated listing.
  for (const p of pages) {
    if (p.archived && mirrored(p.id)) deleted.push(p.id);
  }
  // Silent disappearance (page unshared or connection access revoked) is only
  // trustworthy when the listing was complete — a truncated listing must never
  // trigger deletions.
  if (listingComplete) {
    const listed = new Set(pages.map(p => p.id));
    for (const id of Object.keys(itemMap)) {
      if (!listed.has(id)) deleted.push(id);
    }
  }
  return { changed, deleted };
}

// ─── Sync loop ────────────────────────────────────────────────────────────────

async function runNotionSync(env: IntegrationEnv, store: MirrorStore): Promise<SyncOutcome> {
  const record = await loadIntegration(env, notionProvider.id);
  if (!record) return { ok: false, error: "Notion is not connected" };

  const delta = new ItemMapDeltas(record.itemMap);
  const config = record.config && typeof record.config === "object" ? record.config as any : {};
  const pendingDeletes: string[] = Array.isArray(config.pendingDeletePageIds)
    ? config.pendingDeletePageIds.filter((id: unknown): id is string => typeof id === "string").slice(0, MAX_TRACKED_PAGES)
    : [];
  if (pendingDeletes.length > 0) {
    const pageId = pendingDeletes[0];
    const mapped = delta.get(pageId);
    let deleted = 0;
    let failed = 0;
    try {
      let pageMissing = false;
      try {
        await notionFetch(record.credentials.token, `/pages/${encodeURIComponent(pageId)}`);
      } catch (error) {
        if (error instanceof NotionApiError && error.status === 404) pageMissing = true;
        else throw error;
      }
      // A cross-invocation listing is not a snapshot. Revalidate every silent
      // disappearance and delete only when Notion itself now says 404.
      if (pageMissing && mapped) {
        await store.deleteEntry(mapped.entryId);
        delta.delete(pageId);
        deleted = 1;
      }
      pendingDeletes.shift();
    } catch (error) {
      console.error(`Notion mirror delete failed for page ${pageId} (non-fatal):`, error);
      failed = 1;
    }
    delta.applyTo(record.itemMap);
    config.pendingDeletePageIds = pendingDeletes;
    record.config = config;
    record.status = "connected";
    record.lastSyncedAt = Date.now();
    record.lastSyncError = null;
    record.updatedAt = Date.now();
    await updateIntegration(env, notionProvider.id, (r) => {
      delta.applyTo(r.itemMap);
      r.config = { ...r.config, pendingDeletePageIds: pendingDeletes };
      r.status = record.status;
      r.lastSyncedAt = record.lastSyncedAt;
      r.lastSyncError = record.lastSyncError;
      r.updatedAt = record.updatedAt;
    });
    return {
      ok: true,
      created: 0,
      updated: 0,
      deleted,
      failed,
      remaining: pendingDeletes.length,
      total: Object.keys(record.itemMap).length,
    };
  }

  let pages: NotionPageMeta[];
  let complete: boolean;
  let nextCursor: string | undefined;
  const listingCursor = typeof config.listingCursor === "string" ? config.listingCursor : undefined;
  try {
    ({ pages, complete, nextCursor } = await notionListPages(record.credentials.token, listingCursor));
  } catch (e) {
    if (listingCursor && e instanceof NotionApiError && e.status === 400) {
      // Notion cursors are opaque and may expire. Restart the non-authoritative
      // scan instead of permanently pinning the provider to an invalid cursor.
      config.listingCursor = undefined;
      config.listingSeenPageIds = [];
      record.config = config;
      record.status = "connected";
      record.lastSyncError = null;
      record.updatedAt = Date.now();
      await updateIntegration(env, notionProvider.id, (r) => {
        r.config = { ...r.config, listingCursor: undefined, listingSeenPageIds: [] };
        r.status = record.status;
        r.lastSyncError = record.lastSyncError;
        r.updatedAt = record.updatedAt;
      });
      return { ok: true, created: 0, updated: 0, deleted: 0, failed: 0, remaining: 1, total: 0 };
    }
    record.status = "error";
    record.lastSyncError = e instanceof Error ? e.message : String(e);
    record.updatedAt = Date.now();
    await updateIntegration(env, notionProvider.id, (r) => {
      r.status = record.status;
      r.lastSyncError = record.lastSyncError;
      r.updatedAt = record.updatedAt;
    });
    return { ok: false, error: record.lastSyncError };
  }

  const seenIds = new Set<string>(Array.isArray(config.listingSeenPageIds)
    ? config.listingSeenPageIds.filter((id: unknown): id is string => typeof id === "string")
    : []);
  for (const page of pages) seenIds.add(page.id);
  if (seenIds.size > MAX_TRACKED_PAGES) {
    record.status = "error";
    record.lastSyncError = "Notion listing exceeds the supported 500-page safety limit";
    record.updatedAt = Date.now();
    await updateIntegration(env, notionProvider.id, (r) => {
      r.status = record.status;
      r.lastSyncError = record.lastSyncError;
      r.updatedAt = record.updatedAt;
    });
    return { ok: false, error: record.lastSyncError };
  }

  // Missing-page deletion becomes authoritative only after a complete paged
  // scan. The current page still provides explicit archived signals.
  const plan = computeSyncPlan(pages, record.itemMap, false);
  const storedSkipped = config.skippedPageVersions;
  const skippedVersions: Record<string, string> = storedSkipped && typeof storedSkipped === "object"
    && !Array.isArray(storedSkipped) ? { ...storedSkipped } : {};
  const changed = plan.changed.filter(page => skippedVersions[page.id] !== page.lastEdited);
  const batch = changed.slice(0, SYNC_PAGE_BATCH);

  let created = 0, updated = 0, failed = 0, skipped = 0;
  for (const page of batch) {
    try {
      const text = await notionFetchPageText(record.credentials.token, page.id);
      const content = buildPageContent(page.title, page.url, text);
      const existing = delta.get(page.id);
      const result = existing ? await store.updateEntry(existing.entryId, content) : "not_found";
      if (result === "updated") {
        delta.put(page.id, { entryId: existing!.entryId, version: page.lastEdited });
        updated++;
      } else if (result === "busy") {
        // Still live, just lost every compare-and-set: leave the item map untouched so the
        // next sync retries this same page rather than duplicating it (round 2 adversary).
        failed++;
      } else {
        // New page — or its mirror was deleted out-of-band; (re-)create it.
        const entryId = await store.createEntry(content, [notionProvider.id], notionProvider.id);
        delta.put(page.id, { entryId, version: page.lastEdited });
        created++;
      }
      delete skippedVersions[page.id];
    } catch (e) {
      // Per-page failure is non-fatal: the itemMap doesn't advance for this
      // page, so the next sync retries it.
      console.error(`Notion sync failed for page ${page.id} (non-fatal):`, e);
      failed++;
      if (e instanceof NotionResponseTooLargeError) {
        skippedVersions[page.id] = page.lastEdited;
        skipped++;
      }
    }
  }

  // One mirror mutation per invocation is the measured Free-plan D1 budget.
  // Changed pages take priority; deletions resume on the next call through the
  // unchanged itemMap cursor and are included in `remaining` below.
  const deleteBatch = batch.length === 0 ? plan.deleted.slice(0, 1) : [];
  let deleted = 0;
  for (const pageId of deleteBatch) {
    const mapped = delta.get(pageId);
    if (!mapped) continue;
    try {
      await store.deleteEntry(mapped.entryId);
      delta.delete(pageId);
      deleted++;
    } catch (e) {
      console.error(`Notion mirror delete failed for page ${pageId} (non-fatal):`, e);
    }
  }

  delta.applyTo(record.itemMap);
  record.status = "connected";
  config.skippedPageVersions = skippedVersions;
  const currentPageRemaining = (changed.length - created - updated - skipped)
    + (plan.deleted.length - deleted);
  if (currentPageRemaining === 0) {
    if (complete) {
      config.pendingDeletePageIds = Object.keys(record.itemMap)
        .filter(pageId => !seenIds.has(pageId))
        .slice(0, MAX_TRACKED_PAGES);
      config.listingCursor = undefined;
      config.listingSeenPageIds = [];
    } else {
      config.listingCursor = nextCursor;
      config.listingSeenPageIds = [...seenIds];
    }
  }
  record.config = config;
  record.lastSyncedAt = Date.now();
  record.lastSyncError = null;
  record.updatedAt = Date.now();
  await updateIntegration(env, notionProvider.id, (r) => {
    delta.applyTo(r.itemMap);
    r.config = {
      ...r.config,
      skippedPageVersions: config.skippedPageVersions,
      pendingDeletePageIds: config.pendingDeletePageIds,
      listingCursor: config.listingCursor,
      listingSeenPageIds: config.listingSeenPageIds,
    };
    r.status = record.status;
    r.lastSyncedAt = record.lastSyncedAt;
    r.lastSyncError = record.lastSyncError;
    r.updatedAt = record.updatedAt;
  });

  return {
    ok: true,
    created,
    updated,
    deleted,
    failed,
    remaining: currentPageRemaining
      + (currentPageRemaining === 0 && (!complete || config.pendingDeletePageIds?.length > 0) ? 1 : 0),
    total: pages.filter(p => !p.archived).length,
  };
}

export const notionProvider: IntegrationProvider = {
  id: "notion",
  name: "Notion",
  category: "knowledge",
  validateToken: notionValidateToken,
  sync: runNotionSync,
};
