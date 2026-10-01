/**
 * Second Brain — integration framework.
 *
 * Provider-agnostic machinery for mirroring external sources into memory.
 * Each provider (src/integrations/<provider>.ts) supplies an
 * IntegrationProvider; the registry in src/integrations/index.ts wires them
 * together so the Worker's routes, cron, and settings UI never hardcode a
 * provider.
 *
 * Design notes:
 * - All integration state (token, account info, item↔entry map) lives in
 *   OAUTH_KV under a D1-generation-scoped
 *   `integrations:<provider>:<restore-generation>:<provider-generation>` key.
 *   Pre-generation blobs are read only before the first restore and provider
 *   retirement. KV
 *   is deliberate: the namespace is already provisioned in every deployment,
 *   so shipping a provider is a pure code deploy with no schema migration, and
 *   the access pattern (read once at sync start, write once at the end) is
 *   exactly what KV wants.
 * - Synced items are MIRRORS: the external tool is the source of truth. Every
 *   sync replaces a mirrored entry's content wholesale, dedupe is by external
 *   item id (the itemMap), and an item that disappears upstream deletes its
 *   mirror. Mirrors therefore bypass captureEntry's duplicate/contradiction
 *   pipeline — MirrorStore below is the narrow write surface a sync needs,
 *   implemented by index.ts.
 * - Sync work per call is bounded (Workers subrequest limits, especially on
 *   the free plan). Outcomes report `remaining` so callers loop until it hits
 *   0 — same pattern as POST /vectorize-pending.
 */

import { MemoryWriteLockedError } from "../migration/write-lock";

// SQLite TRIM accepts a character set, not a regex. This is the complete
// ECMAScript String.prototype.trim whitespace/line-terminator set so D1 source
// ownership checks agree with payload validation even for legacy/imported rows.
export const SQLITE_JAVASCRIPT_TRIM_CHARSET = [
  9, 10, 11, 12, 13, 32, 160, 5760,
  8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
  8232, 8233, 8239, 8287, 12288, 65279,
].map(codePoint => `char(${codePoint})`).join(" || ");

export interface IntegrationEnv {
  OAUTH_KV: KVNamespace;
  DB?: D1Database;
  WRITE_ADMISSION_TOKEN?: string;
  INTEGRATION_OPERATION?: IntegrationOperation;
}

export type IntegrationOperationMode = "connect" | "sync" | "disconnect" | "layer" | "move";
export interface IntegrationOperation {
  provider: string;
  owner: string;
  mode: IntegrationOperationMode;
  stateGeneration: string;
  providerGeneration: string;
}

const INTEGRATION_OPERATION_LEASE_MS = 17 * 60 * 1000;

export class IntegrationOperationLockedError extends Error {
  readonly status = 409;
  constructor() {
    super("Another operation for this integration is still running; retry shortly");
    this.name = "IntegrationOperationLockedError";
  }
}

// ─── Provider interface ───────────────────────────────────────────────────────
// The whole contract a new provider must implement. Deliberately thin: how a
// provider lists changes, fetches content, and detects deletions is private to
// it — sync semantics differ too much between APIs (Notion: full listing +
// completeness-gated deletion sweep; cursor-native APIs: incremental exports)
// to abstract further from one data point.

export interface IntegrationProvider {
  id: string;   // registry key, entry `source` value, and URL segment (/integrations/<id>/…)
  name: string; // display name for the settings UI
  // Optional presentational hints for the settings UI (registry-driven cards).
  connectLabel?: string;       // input label, e.g. "Paste your secret iCal URL"
  connectPlaceholder?: string; // input placeholder
  connectHint?: string;        // where to find the secret (may contain safe HTML)
  category?: string;           // settings-UI grouping id: "knowledge" | "calendar" | "email"
  // Validate a pasted token against the provider's API; returns an account /
  // workspace label for the UI's "Connected to …" confirmation. Throws with a
  // user-presentable message when the token is rejected.
  validateToken(token: string): Promise<string>;
  // Run one bounded sync batch against the stored record.
  sync(env: IntegrationEnv, store: MirrorStore): Promise<SyncOutcome>;
}

export type SyncOutcome =
  | { ok: true; created: number; updated: number; deleted: number; failed: number; remaining: number; total: number }
  | { ok: false; error: string };

// ─── Integration record (the KV blob) ─────────────────────────────────────────

export interface ItemMapEntry {
  entryId: string; // the mirrored entry's id in D1
  version: string; // the item's change marker (e.g. Notion's last_edited_time) when mirrored
}

export interface IntegrationRecord {
  provider: string;
  authKind: "token"; // "oauth2" reserved for future providers that require it
  credentials: { token: string };
  config: Record<string, unknown>; // escape hatch for future per-provider options
  status: "connected" | "error";
  workspaceName: string | null;
  lastSyncedAt: number | null;
  lastSyncError: string | null;
  itemMap: Record<string, ItemMapEntry>;
  /**
   * Set while a disconnect purge is paging through the item map; syncs skip the record. Carries
   * the running totals, plus the cursor this page was computed from (`fromCursor`, undefined for
   * the first page) and the cursor it handed back (`nextCursor`, undefined once done): a repeated
   * call whose own cursor matches `fromCursor` is the same page again (its response was lost) and
   * must return this same state rather than reprocessing and double-counting it.
   */
  disconnecting?: { purged: number; skipped: number; fromCursor?: string; nextCursor?: string };
  createdAt: number;
  updatedAt: number;
  /** Strong D1 generation that makes eventually-consistent KV safe to consume. */
  stateGeneration?: string;
  /** Provider-local fence; disconnect rotates it so an older sync cannot reconnect itself. */
  providerGeneration?: string;
}

// The one narrowing rule for a mirror layer, on both the read and write side:
// anything that isn't the exact literal "company" is personal. Extracted so
// every call site agrees by construction rather than by everyone typing the
// same ternary — the divergence the union type otherwise can't catch.
export function narrowMirrorLayer(value: unknown): "company" | "personal" {
  return value === "company" ? "company" : "personal";
}

// Prefixed so integration keys coexist with workers-oauth-provider's own
// token:/grant:/client: keys in the same namespace.
const INTEGRATIONS_KEY_PREFIX = "integrations:";

function integrationKey(provider: string, generation?: string, providerGeneration?: string): string {
  return `${INTEGRATIONS_KEY_PREFIX}${provider}${generation ? `:${generation}` : ""}`
    + `${providerGeneration ? `:${providerGeneration}` : ""}`;
}

type IntegrationGeneration = {
  generation: string;
  restoreCount: number;
  providerGeneration: string;
  providerVersion: number;
};

/**
 * Serialize connect/sync/disconnect for one provider. Disconnect purge marks the row
 * draining between pages; only another disconnect may then acquire it. Side-effecting
 * mirror primitives renew this lease immediately before their D1/Vectorize mutations.
 * A fixed expiry still recovers a crashed isolate; the D1 source sweep performed by
 * disconnect is the compensation path for a mutation that committed before a crash.
 */
export async function acquireIntegrationOperation(
  env: IntegrationEnv,
  provider: string,
  mode: IntegrationOperationMode,
): Promise<IntegrationOperation> {
  if (!env.DB || !env.WRITE_ADMISSION_TOKEN) throw new IntegrationOperationLockedError();
  const current = await currentIntegrationMutationGeneration(env, provider);
  if (!current) throw new IntegrationOperationLockedError();
  const owner = crypto.randomUUID();
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE integration_provider_generation
        SET lease_owner = ?, lease_expires_at = ?
      WHERE provider = ?
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
        AND (? = 'disconnect' OR draining = 0)`,
  ).bind(owner, now + INTEGRATION_OPERATION_LEASE_MS, provider, now, mode).run();
  const changes = Number(result.meta.changes
    ?? (result.meta as D1Result["meta"] & { rows_written?: number }).rows_written
    ?? 0);
  if (changes !== 1) throw new IntegrationOperationLockedError();
  return {
    provider,
    owner,
    mode,
    stateGeneration: current.generation,
    providerGeneration: current.providerGeneration,
  };
}

/** Attach the operation capability without mutating the request-scoped Env object. */
export function withIntegrationOperation<T extends IntegrationEnv>(
  env: T,
  operation: IntegrationOperation,
): T {
  const scoped = Object.create(env) as T;
  Object.defineProperty(scoped, "INTEGRATION_OPERATION", {
    value: operation,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return scoped;
}

/** Renew only the still-owned provider generation immediately before a side effect. */
export async function renewIntegrationOperation(env: IntegrationEnv): Promise<void> {
  const operation = env.INTEGRATION_OPERATION;
  if (!operation || !env.DB) return;
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE integration_provider_generation
        SET lease_expires_at = ?
      WHERE provider = ? AND generation = ? AND lease_owner = ?
        AND lease_expires_at > ?
        AND (? = 'disconnect' OR draining = 0)`,
  ).bind(
    now + INTEGRATION_OPERATION_LEASE_MS,
    operation.provider,
    operation.providerGeneration,
    operation.owner,
    now,
    operation.mode,
  ).run();
  const changes = Number(result.meta.changes
    ?? (result.meta as D1Result["meta"] & { rows_written?: number }).rows_written
    ?? 0);
  if (changes !== 1) throw new IntegrationOperationLockedError();
}

export async function markIntegrationOperationDraining(
  env: IntegrationEnv,
  operation: IntegrationOperation,
): Promise<void> {
  const result = await env.DB!.prepare(
    `UPDATE integration_provider_generation SET draining = 1
      WHERE provider = ? AND generation = ? AND lease_owner = ? AND lease_expires_at > ?`,
  ).bind(
    operation.provider,
    operation.providerGeneration,
    operation.owner,
    Date.now(),
  ).run();
  const changes = Number(result.meta.changes
    ?? (result.meta as D1Result["meta"] & { rows_written?: number }).rows_written
    ?? 0);
  if (changes !== 1) throw new IntegrationOperationLockedError();
}

export async function releaseIntegrationOperation(
  env: IntegrationEnv,
  operation: IntegrationOperation,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await env.DB?.prepare(
        `UPDATE integration_provider_generation
            SET lease_owner = NULL, lease_expires_at = NULL
          WHERE provider = ? AND lease_owner = ?`,
      ).bind(operation.provider, operation.owner).run();
      return;
    } catch {
      // A successful mutation must not become an ambiguous 500 solely because
      // best-effort unlock failed. Retry in-isolate, then let the bounded lease
      // expire fail-closed without logging provider or credential data.
    }
  }
  console.error("Integration operation release failed; lease will expire");
}

async function currentIntegrationGeneration(
  env: IntegrationEnv,
  provider: string,
): Promise<IntegrationGeneration | null> {
  if (!env.DB) return null;
  const read = () => env.DB!.prepare(
    `SELECT i.generation, i.restore_count,
            p.generation AS provider_generation, p.version AS provider_version
       FROM integration_state_generation i
       LEFT JOIN integration_provider_generation p ON p.provider = ?
      WHERE i.id = 'current'`,
  ).bind(provider).first<{
    generation: string;
    restore_count: number;
    provider_generation: string | null;
    provider_version: number | null;
  }>();
  let row = await read();
  if (!row?.generation) {
    // Schema convergence can be interrupted after CREATE TABLE but before its
    // singleton seed. Repair that bounded partial state here and retry once.
    await env.DB.prepare(
      `INSERT INTO integration_state_generation (id, generation, restore_count)
       VALUES ('current', lower(hex(randomblob(16))), 0)
       ON CONFLICT(id) DO NOTHING`,
    ).run();
    row = await read();
  }
  if (!row?.generation) throw new Error("Integration state generation is unavailable");
  if (!row.provider_generation) {
    await env.DB.prepare(
      `INSERT INTO integration_provider_generation (provider, generation, version)
       VALUES (?, lower(hex(randomblob(16))), 0)
       ON CONFLICT(provider) DO NOTHING`,
    ).bind(provider).run();
    row = await read();
  }
  if (!row?.provider_generation) throw new Error("Integration provider generation is unavailable");
  return {
    generation: row.generation,
    restoreCount: Number(row.restore_count ?? 0),
    providerGeneration: row.provider_generation,
    providerVersion: Number(row.provider_version ?? 0),
  };
}

async function currentIntegrationMutationGeneration(
  env: IntegrationEnv,
  provider: string,
): Promise<IntegrationGeneration | null> {
  if (!env.DB) return null;
  if (!env.WRITE_ADMISSION_TOKEN) {
    throw new MemoryWriteLockedError({
      lockedAt: Date.now(), reason: "integration-write-admission-missing", ownerId: "",
    });
  }
  // This is the last D1 read before KV mutation. If restore starts after this
  // point, the captured old generation makes the delayed KV write unreachable;
  // if it already started, the admission/epoch join returns no row.
  const operation = env.INTEGRATION_OPERATION;
  const operationClause = operation
    ? `AND p.generation = ? AND p.lease_owner = ? AND p.lease_expires_at > ?
       AND (? = 'disconnect' OR p.draining = 0)`
    : "";
  const read = () => env.DB!.prepare(
    `SELECT i.generation, i.restore_count,
            p.generation AS provider_generation, p.version AS provider_version
       FROM integration_state_generation i
       JOIN integration_provider_generation p ON p.provider = ?
      WHERE i.id = 'current'
        AND EXISTS (
          SELECT 1 FROM memory_write_admissions a
          JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
          WHERE a.token = ? AND a.expires_at > ?
        )
        ${operationClause}`,
  ).bind(
    provider,
    env.WRITE_ADMISSION_TOKEN,
    Date.now(),
    ...(operation ? [
      operation.providerGeneration,
      operation.owner,
      Date.now(),
      operation.mode,
    ] : []),
  ).first<{
    generation: string;
    restore_count: number;
    provider_generation: string;
    provider_version: number;
  }>();
  let row = await read();
  if (!row?.generation) {
    // The normal hot path is exactly one D1 query. Only an interrupted schema
    // seed takes the bounded repair path; a stale admission still fails below.
    await currentIntegrationGeneration(env, provider);
    row = await read();
  }
  if (!row?.generation) {
    throw new MemoryWriteLockedError({
      lockedAt: Date.now(), reason: "integration-write-admission-expired", ownerId: "",
    });
  }
  return {
    generation: row.generation,
    restoreCount: Number(row.restore_count ?? 0),
    providerGeneration: row.provider_generation,
    providerVersion: Number(row.provider_version ?? 0),
  };
}

function parseIntegrationRecord(raw: string | null): IntegrationRecord | null {
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as any;
    // Migrate pre-registry blobs (first Notion release): pageMap/lastEdited →
    // itemMap/version. Persisted back on the next save; losing the map would
    // duplicate every mirror on the following sync.
    if (record.pageMap && !record.itemMap) {
      record.itemMap = Object.fromEntries(
        Object.entries(record.pageMap as Record<string, any>).map(([id, v]) => [
          id,
          { entryId: v.entryId, version: v.version ?? v.lastEdited ?? "" },
        ])
      );
      delete record.pageMap;
    }
    record.itemMap ??= {};
    return record as IntegrationRecord;
  } catch {
    return null;
  }
}

export async function loadIntegration(env: IntegrationEnv, provider: string): Promise<IntegrationRecord | null> {
  const current = await currentIntegrationGeneration(env, provider);
  if (!current) {
    return parseIntegrationRecord(await env.OAUTH_KV.get(integrationKey(provider)));
  }
  let record = parseIntegrationRecord(
    await env.OAUTH_KV.get(integrationKey(provider, current.generation, current.providerGeneration)),
  );
  if (!record && current.restoreCount === 0 && current.providerVersion === 0) {
    // One-way compatibility before the first restore. Once a generation-scoped
    // record is saved it wins; after restore/provider retirement, legacy keys
    // are never read.
    record = parseIntegrationRecord(
      await env.OAUTH_KV.get(integrationKey(provider, current.generation)),
    ) ?? parseIntegrationRecord(await env.OAUTH_KV.get(integrationKey(provider)));
  }
  if (!record) return null;
  if (record.stateGeneration === undefined && current.restoreCount === 0) {
    // One-way compatibility for records created before generation fencing shipped.
    record.stateGeneration = current.generation;
  } else if (record.stateGeneration !== current.generation) {
    // A completed D1 restore deliberately disconnects every older KV record.
    // Returning null makes status/sync fail closed until the owner reconnects;
    // no credential or cursor is copied into the R2 archive.
    return null;
  }
  if (record.providerGeneration === undefined && current.providerVersion === 0) {
    record.providerGeneration = current.providerGeneration;
  } else if (record.providerGeneration !== current.providerGeneration) {
    return null;
  }
  return record;
}

export async function saveIntegration(env: IntegrationEnv, record: IntegrationRecord): Promise<void> {
  // Extend the still-owned operation immediately before the D1 admission check and
  // eventual KV write. This prevents a slow fetch/validation from reaching KV after
  // its lease was overtaken by a newer connect, sync, or disconnect.
  await renewIntegrationOperation(env);
  const current = await currentIntegrationMutationGeneration(env, record.provider);
  if (current) {
    if (record.stateGeneration === undefined) record.stateGeneration = current.generation;
    if (record.providerGeneration === undefined) record.providerGeneration = current.providerGeneration;
    if (record.stateGeneration !== current.generation) {
      throw new Error("Integration KV generation changed before save");
    }
    if (record.providerGeneration !== current.providerGeneration) {
      throw new Error("Integration provider generation changed before save");
    }
  }
  await env.OAUTH_KV.put(
    integrationKey(record.provider, current?.generation, current?.providerGeneration),
    JSON.stringify(record),
  );
}

// D1 世代・provider lease の検査は saveIntegration に残し、部分更新でも必ず通す。
// The ONLY way to update part of an existing record. Every writer that held a
// record across awaited work and saved it back clobbered whatever landed in
// between — a mid-sync layer change most damagingly (#348). Reading fresh at
// save time shrinks the lost-update window from "the whole sync" to "the gap
// between this read and this put"; KV has no compare-and-swap, so the gap
// cannot be closed entirely, only made vanishingly small.
export async function updateIntegration(
  env: IntegrationEnv,
  provider: string,
  mutate: (record: IntegrationRecord) => void,
): Promise<IntegrationRecord | null> {
  const record = await loadIntegration(env, provider);
  if (!record) return null;
  mutate(record);
  await saveIntegration(env, record);
  return record;
}

// A sync's itemMap writes as deltas over its read snapshot (#348). The persisted
// write is the deltas, applied to a freshly read record; `get` is the sync's
// own working view (snapshot + earlier puts/deletes this run), which later
// iterations need to see just as the old in-place writes let them — a repeated
// key must update the mirror it just created, and a deleted one must not be
// deleted twice. Record only successful operations.
export class ItemMapDeltas {
  // Item ids are arbitrary upstream strings, so nothing here may treat a plain
  // object's inherited members ("constructor", "__proto__", ...) as entries:
  // pending state is Map/Set, and the snapshot is read by own property only.
  private puts = new Map<string, ItemMapEntry>();
  private deletes = new Set<string>();

  constructor(private snapshot: Record<string, ItemMapEntry>) {}

  get(key: string): ItemMapEntry | undefined {
    if (this.deletes.has(key)) return undefined;
    const put = this.puts.get(key);
    if (put) return put;
    return Object.hasOwn(this.snapshot, key) ? this.snapshot[key] : undefined;
  }

  put(key: string, entry: ItemMapEntry): void {
    this.deletes.delete(key);
    this.puts.set(key, entry);
  }

  delete(key: string): void {
    this.puts.delete(key);
    this.deletes.add(key);
  }

  applyTo(itemMap: Record<string, ItemMapEntry>): void {
    // defineProperty, not assignment: `itemMap["__proto__"] = x` would rewire
    // the prototype instead of creating the key.
    for (const [key, entry] of this.puts) {
      Object.defineProperty(itemMap, key, { value: entry, enumerable: true, writable: true, configurable: true });
    }
    for (const key of this.deletes) delete itemMap[key];
  }
}

export async function deleteIntegration(
  env: IntegrationEnv,
  recordOrProvider: IntegrationRecord | string,
  operation?: IntegrationOperation,
): Promise<void> {
  const provider = typeof recordOrProvider === "string" ? recordOrProvider : recordOrProvider.provider;
  const current = await currentIntegrationMutationGeneration(env, provider);
  if (!current) {
    await env.OAUTH_KV.delete(integrationKey(provider));
    return;
  }
  const expectedState = typeof recordOrProvider === "string"
    ? current.generation
    : recordOrProvider.stateGeneration;
  const expectedProvider = typeof recordOrProvider === "string"
    ? current.providerGeneration
    : recordOrProvider.providerGeneration;
  if (expectedState !== current.generation || expectedProvider !== current.providerGeneration) {
    throw new Error("Integration generation changed before disconnect");
  }
  const nextGeneration = crypto.randomUUID();
  const rotated = await env.DB!.prepare(
    `UPDATE integration_provider_generation
        SET generation = ?, version = version + 1, draining = 0
      WHERE provider = ? AND generation = ?
        AND EXISTS (
          SELECT 1 FROM integration_state_generation i
          WHERE i.id = 'current' AND i.generation = ?
        )
        AND EXISTS (
          SELECT 1 FROM memory_write_admissions a
          JOIN memory_write_epoch e ON e.id = 'current' AND e.generation = a.generation
          WHERE a.token = ? AND a.expires_at > ?
        )
        AND (? IS NULL OR (lease_owner = ? AND lease_expires_at > ?))`,
  ).bind(
    nextGeneration,
    provider,
    current.providerGeneration,
    current.generation,
    env.WRITE_ADMISSION_TOKEN,
    Date.now(),
    operation?.owner ?? null,
    operation?.owner ?? null,
    Date.now(),
  ).run();
  const changes = Number(rotated.meta.changes
    ?? (rotated.meta as D1Result["meta"] & { rows_written?: number }).rows_written
    ?? 0);
  if (changes !== 1) {
    throw new MemoryWriteLockedError({
      lockedAt: Date.now(), reason: "integration-generation-changed", ownerId: "",
    });
  }
  await env.OAUTH_KV.delete(
    integrationKey(provider, current.generation, current.providerGeneration),
  );
  if (current.restoreCount === 0 && current.providerVersion === 0) {
    await env.OAUTH_KV.delete(integrationKey(provider, current.generation));
    await env.OAUTH_KV.delete(integrationKey(provider));
  }
}

// Connection status for the settings UI. Never exposes credentials — the token
// is write-only from the dashboard's perspective. Presentational hints pass
// through only when set, so providers that omit them (Notion) are unchanged.
export function integrationStatus(
  provider: Pick<IntegrationProvider, "id" | "name" | "connectLabel" | "connectPlaceholder" | "connectHint" | "category">,
  record: IntegrationRecord | null,
) {
  return {
    provider: provider.id,
    name: provider.name,
    connected: record !== null,
    status: record?.status ?? null,
    workspaceName: record?.workspaceName ?? null,
    lastSyncedAt: record?.lastSyncedAt ?? null,
    lastSyncError: record?.lastSyncError ?? null,
    itemCount: record ? Object.keys(record.itemMap).length : 0,
    // Connection provenance. `mirrorWorkspace` is NARROWED here rather than
    // passed through, exactly as mirrorWriteContext narrows it: `config` is a
    // Record<string, unknown> escape hatch, and anything that is not "company"
    // is personal-by-default on the write path — so the readout has to agree
    // with the writer rather than with the blob.
    mirrorWorkspace: narrowMirrorLayer(record?.config?.mirrorWorkspace),
    // The id, not the name. Resolving it needs D1 and the caller's own team
    // scope, neither of which this module has; the route swaps it for a name
    // and drops the id before the response leaves (src/routes/integrations.ts).
    connectedByUserId: typeof record?.config?.connectedByUserId === "string" ? record.config.connectedByUserId : null,
    connectedAt: record?.createdAt ?? null,
    ...(provider.connectLabel ? { connectLabel: provider.connectLabel } : {}),
    ...(provider.connectPlaceholder ? { connectPlaceholder: provider.connectPlaceholder } : {}),
    ...(provider.connectHint ? { connectHint: provider.connectHint } : {}),
    ...(provider.category ? { category: provider.category } : {}),
  };
}

// ─── Mirror store ─────────────────────────────────────────────────────────────
// The write primitives a sync needs against the memory store. Implemented by
// index.ts (which owns storeEntry/forgetEntry); injected so this module never
// imports from index.ts (no circular dependency).

export interface MirrorStore {
  // Insert a new entry and return its id.
  createEntry(content: string, tags: string[], source: string): Promise<string>;
  // Replace an entry's content wholesale (re-embed): "updated" on success, "not_found" when the
  // entry is genuinely gone (the caller re-creates the mirror), "busy" when the row is still
  // there but every compare-and-set attempt lost the race (round 2 adversary, ADV-8 exhaustion:
  // a caller that read "busy" as "gone" and re-created the mirror duplicated the memory). The
  // caller must leave its item map untouched on "busy" so the next sync retries the same row
  // rather than orphaning it under a second, freshly created copy.
  updateEntry(entryId: string, content: string): Promise<"updated" | "not_found" | "busy">;
  // Permanently delete an entry and its vectors.
  deleteEntry(entryId: string): Promise<void>;
}
