import { z } from "zod";
import { resolveConfig } from "../config";
import { MemoryInputError } from "../capture/store";
import type { Env } from "../env";
import { assertCanEditContent, assertCanMutateEntry, getReadableEntry } from "../lib/entry-access";
import type { Identity } from "../lib/identity";
import { isManagedMirror, mirrorEditError } from "../integrations/mirror";
import {
  rolloverEntry,
  RolloverAlreadyExistsError,
  RolloverNotNeededError,
  RolloverOperationConflictError,
  RolloverSourceChangedError,
} from "../memory/rollover";
import { MEMORY_ROLLOVER_SNAPSHOT_MAX_CHARS } from "../memory/rollover-policy";
import {
  getHotContext,
  MEMORY_TIERS,
  setMemoryPinned,
  setMemoryTier,
  type MemoryTier,
} from "../memory/tier";
import type { Volatility } from "../memory/volatility";
import { buildPromptCapsule } from "../prompt-capsule/build";
import { PROMPT_CAPSULE_MCP_SCHEMA } from "../prompt-capsule/types";

const ROLLOVER_DESCRIPTION =
  "Create a bounded current-state continuation for an append-grown memory. Use this only after append reports "
  + "that rollover is recommended or required. Supply a concise current-state snapshot, not a copy "
  + "of the full history. The old entry is preserved as a cold journal; the new entry inherits its workspace and "
  + "useful tags and is linked back with follows and drawn_from relationships. Semantic indexing runs after the "
  + "source write, so an indexing outage cannot lose the snapshot. Generate a fresh operation_id and reuse it "
  + "only when retrying exactly the same rollover.";

// 入力制約は利用者やリクエストに依存しない。各MCPサーバーで同じスキーマを再利用する。
// env・認証・write admission・callbackは従来どおりリクエストごとに作成する。
const INPUT_SCHEMAS = {
  setMemoryTier: z.object({
    id: z.string().describe("Entry ID from recall or list_recent"),
    tier: z.enum([...MEMORY_TIERS] as [string, ...string[]]).describe("hot | warm | cold"),
  }),
  pinMemory: z.object({ id: z.string().describe("Entry ID from recall or list_recent") }),
  unpinMemory: z.object({ id: z.string().describe("Entry ID from recall or list_recent") }),
  promptCapsule: z.object({
    kind: z.enum(["core", "project"]).describe("Capsule kind"),
    project_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional()
      .describe("Required for project; omitted for core"),
    workspace: z.enum(["personal", "company"]).default("personal")
      .describe("Read exactly one private or shared workspace layer"),
    team: z.string().max(128).optional()
      .describe("Company workspace id from list_teams; required when company membership is ambiguous"),
  }),
  hotContext: z.object({}),

};

/**
 * Build the fork-owned MCP tool contracts without registering them.
 *
 * Registration intentionally remains in server.ts so tool order and the SDK's
 * single registration boundary stay byte-stable for prompt caching.
 */
export function createExtendedMcpTools<VolatilitySchema extends z.ZodTypeAny>(
  env: Env,
  ctx: ExecutionContext,
  identity: Identity | undefined,
  volatilityParam: VolatilitySchema,
) {
  const pinTool = (pinned: boolean) => async ({ id }: { id: string }) => {
    const row = await getReadableEntry(env, identity, id);
    if (!row) return { content: [{ type: "text" as const, text: `No entry found with ID: ${id}` }] };
    const denied = assertCanMutateEntry(identity, row);
    if (denied) return { content: [{ type: "text" as const, text: denied.message }] };
    const ok = await setMemoryPinned(env, id, pinned);
    if (!ok) return { content: [{ type: "text" as const, text: `No entry found with ID: ${id}` }] };
    return {
      content: [{
        type: "text" as const,
        text: pinned ? `Entry ${id} pinned to hot context.` : `Entry ${id} unpinned.`,
      }],
    };
  };

  return {
    rollover: {
      config: {
        description: ROLLOVER_DESCRIPTION,
        inputSchema: {
          id: z.string().describe("Append-grown source entry ID from recall, get, or append"),
          snapshot: z.string().max(MEMORY_ROLLOVER_SNAPSHOT_MAX_CHARS).describe("Concise current-state snapshot for the new continuation; do not copy the full append history"),
          operation_id: z.string().min(1).max(128).describe("Caller-generated idempotency key. Generate a fresh UUID for a new rollover and reuse it only when retrying exactly the same rollover"),
          volatility: volatilityParam,
        },
      },
      callback: async ({ id, snapshot, operation_id, volatility }: {
        id: string;
        snapshot: string;
        operation_id: string;
        volatility?: z.output<VolatilitySchema>;
      }) => {
        const row = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id, source");
        if (!row) return { content: [{ type: "text" as const, text: `No entry found with ID: ${id}` }] };
        const denied = assertCanEditContent(identity, row);
        if (denied) return { content: [{ type: "text" as const, text: denied.message }] };
        if (await isManagedMirror(row.source as string, env)) {
          return { content: [{ type: "text" as const, text: mirrorEditError(row.source as string) }] };
        }

        try {
          const result = await rolloverEntry(
            env,
            id,
            snapshot,
            ctx,
            await resolveConfig(env),
            {
              operationId: operation_id,
              volatility: volatility as Volatility | undefined,
              writeContext: {
                workspaceId: String(row.workspace_id ?? ""),
                actorId: identity?.userId ?? String(row.actor_id ?? ""),
              },
            },
          );
          return {
            content: [{
              type: "text" as const,
              text: result.replayed
                ? `Rollover operation was already applied. Continue with entry ${result.id}; no duplicate was created.`
                : `Created continuation ${result.id} from ${id}. The original journal is preserved in the cold tier; append future updates to the new entry. Semantic indexing is scheduled.`,
            }],
          };
        } catch (error) {
          if (error instanceof RolloverAlreadyExistsError
            || error instanceof RolloverOperationConflictError
            || error instanceof RolloverNotNeededError
            || error instanceof RolloverSourceChangedError
            || error instanceof MemoryInputError) {
            return { content: [{ type: "text" as const, text: `Rollover was not applied: ${error.message}.` }] };
          }
          return { content: [{ type: "text" as const, text: `Rollover failed: ${(error as Error).message}` }] };
        }
      },
    },
    setMemoryTier: {
      config: {
        description: "Set a memory's manual retention tier. Use hot for a small current working set, warm for ordinary active knowledge, and cold for completed journals or low-frequency context. Cold remains searchable and every tier change is reversible.",
        inputSchema: INPUT_SCHEMAS.setMemoryTier,
      },
      callback: async ({ id, tier }: { id: string; tier: string }) => {
        const row = await getReadableEntry(env, identity, id);
        if (!row) return { content: [{ type: "text" as const, text: `No entry found with ID: ${id}` }] };
        const denied = assertCanMutateEntry(identity, row);
        if (denied) return { content: [{ type: "text" as const, text: denied.message }] };
        const ok = await setMemoryTier(env, id, tier as MemoryTier);
        if (!ok) return { content: [{ type: "text" as const, text: `No entry found with ID: ${id}` }] };
        return { content: [{ type: "text" as const, text: `Entry ${id} moved to the ${tier} tier.` }] };
      },
    },
    pinMemory: {
      config: {
        description: "Pin a user-confirmed active goal or operating constraint so it appears across sessions, without changing its tier. Keep the pinned set small and prefer one consolidated current-state entry over many response summaries.",
        inputSchema: INPUT_SCHEMAS.pinMemory,
      },
      callback: pinTool(true),
    },
    unpinMemory: {
      config: {
        description: "Remove a memory's hot-context pin when the work is complete or the constraint is no longer current. Its manual tier is unchanged.",
        inputSchema: INPUT_SCHEMAS.unpinMemory,
      },
      callback: pinTool(false),
    },
    promptCapsule: {
      config: {
        description: "Return one deterministic Prompt Capsule and its strong ETag. This read-only tool is for gateways that construct stable prompt prefixes; use recall for query-specific context. Only entries with canonical status are included: give the entry canonical status in its tags at remember time, or call set_status canonical afterwards. To re-slot an entry, use update with tags containing the complete capsule: and capsule-slot: definition.",
        inputSchema: INPUT_SCHEMAS.promptCapsule,
      },
      callback: async ({ kind, project_id, workspace, team }: {
        kind: "core" | "project";
        project_id?: string;
        workspace: "personal" | "company";
        team?: string;
      }) => {
        if (!identity) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify({
              ok: false,
              schema: PROMPT_CAPSULE_MCP_SCHEMA,
              code: "unauthenticated",
              status: 401,
              error: "Prompt Capsule retrieval requires an authenticated identity.",
            }) }],
          };
        }
        try {
          const built = await buildPromptCapsule(env, identity, {
            kind,
            projectId: project_id,
            workspace,
            team,
          });
          if (!built.ok) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: JSON.stringify({
                schema: PROMPT_CAPSULE_MCP_SCHEMA,
                status: built.status,
                ...built.body,
              }) }],
            };
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              ok: true,
              schema: PROMPT_CAPSULE_MCP_SCHEMA,
              etag: built.etag,
              capsule: built.payload,
            }, null, 2) }],
          };
        } catch {
          console.error("Prompt Capsule retrieval failed");
          return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({
            ok: false, schema: PROMPT_CAPSULE_MCP_SCHEMA, code: "internal_error", status: 500,
            error: "Prompt Capsule retrieval failed. Please try again later.",
          }) }] };
        }
      },
    },
    hotContext: {
      config: {
        description: "Return the manually hot or pinned working set, ordered by importance and recency and bounded to 12,000 characters. Call after the required intent-framed opening recall when resuming ongoing work; never use this instead of topic-specific recall.",
        inputSchema: INPUT_SCHEMAS.hotContext,
      },
      callback: async () => {
        const hot = await getHotContext(env, identity);
        return {
          content: [{
            type: "text" as const,
            text: hot.text || "No hot or pinned memories.",
          }],
        };
      },
    },
  };
}
