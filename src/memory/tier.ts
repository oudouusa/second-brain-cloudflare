import { NOT_HELD_SQL } from "../quarantine/tags";
import { currentValidityAt } from "./validity";
import type { Env } from "../env";
import { assertMemoryWritesAllowed, memoryWriteMarker } from "../migration/write-lock";
import type { Identity } from "../lib/identity";
import { scopeWhere } from "../lib/scope";

export const MEMORY_TIERS = ["hot", "warm", "cold"] as const;
export type MemoryTier = typeof MEMORY_TIERS[number];
export const HOT_CONTEXT_MAX_CHARS = 12_000;

export function isMemoryTier(value: unknown): value is MemoryTier {
  return typeof value === "string" && (MEMORY_TIERS as readonly string[]).includes(value);
}

export async function setMemoryTier(env: Env, id: string, tier: MemoryTier): Promise<boolean> {
  await assertMemoryWritesAllowed(env);
  const result = await env.DB.prepare(
    // versioning: exempt: 検索上の配置・pinのみで本文、タグ、期限は変えない。
    `UPDATE entries SET memory_tier = ?, write_marker = ? WHERE id = ?`,
  ).bind(tier, memoryWriteMarker(env), id).run();
  return Number(result.meta?.changes ?? result.meta?.rows_written ?? 0) > 0;
}

export async function setMemoryPinned(env: Env, id: string, pinned: boolean): Promise<boolean> {
  await assertMemoryWritesAllowed(env);
  const result = await env.DB.prepare(
    // versioning: exempt: 検索上の配置・pinのみで本文、タグ、期限は変えない。
    `UPDATE entries SET pinned = ?, write_marker = ? WHERE id = ?`,
  ).bind(pinned ? 1 : 0, memoryWriteMarker(env), id).run();
  return Number(result.meta?.changes ?? result.meta?.rows_written ?? 0) > 0;
}

export interface HotContextResult {
  text: string;
  entries: number;
  truncated: boolean;
  maxChars: number;
}

/** Pinned memories are always hot context, regardless of their manual tier. */
export async function getHotContext(env: Env, identity?: Identity): Promise<HotContextResult> {
  const scope = identity ? scopeWhere(identity) : null;
  const { results } = await env.DB.prepare(
    // scope-checked: authenticated calls append the resolved identity scope; identity-less calls are the explicit legacy/internal hot-context path
    // validity: current: currentValidityAtで現在のhot・pinned行だけを表示する。
    `SELECT id, content, tags, source, created_at,
            COALESCE(updated_at, created_at) AS last_updated,
            importance_score, memory_tier, pinned
       FROM entries
      WHERE (pinned = 1 OR memory_tier = 'hot')
        AND ${NOT_HELD_SQL} AND ${currentValidityAt("", String(Date.now()))}
        AND tags NOT LIKE '%"status:deprecated"%'
        ${scope ? `AND ${scope.clause}` : ""}
      ORDER BY importance_score DESC, COALESCE(updated_at, created_at) DESC, id ASC
      LIMIT 200`,
  ).bind(...(scope?.bindings ?? [])).all() as { results: Record<string, unknown>[] };

  const blocks: string[] = [];
  let used = 0;
  let truncated = false;
  for (const row of results) {
    const tags = JSON.parse((row.tags as string | undefined) ?? "[]") as string[];
    const header = `[${row.id} · ${row.source} · ${row.memory_tier}${Number(row.pinned) === 1 ? " · pinned" : ""}${tags.length ? ` · ${tags.join(", ")}` : ""}]\n`;
    const separator = blocks.length ? "\n\n" : "";
    const available = HOT_CONTEXT_MAX_CHARS - used - separator.length;
    if (available <= 0) {
      truncated = true;
      break;
    }
    const body = String(row.content ?? "");
    const block = header + body;
    if (block.length <= available) {
      blocks.push(block);
      used += separator.length + block.length;
      continue;
    }
    const marker = "\n[truncated]";
    const clipped = block.slice(0, Math.max(0, available - marker.length)) + marker;
    blocks.push(clipped.slice(0, available));
    used += separator.length + Math.min(clipped.length, available);
    truncated = true;
    break;
  }

  return {
    text: blocks.join("\n\n"),
    entries: blocks.length,
    truncated: truncated || blocks.length < results.length,
    maxChars: HOT_CONTEXT_MAX_CHARS,
  };
}
