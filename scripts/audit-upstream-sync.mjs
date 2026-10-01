#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_UPSTREAM_URL = "https://github.com/rahilp/second-brain-cloudflare.git";
const BASE_TAG = "upstream-base-2026-08-23";
const DEFAULT_UPSTREAM_REF = "upstream/main";

export const APPROVED_NEW_SRC_MODULES = new Set([
  "src/backup/r2.ts",
  // R2履歴chunkの列検証と復元だけを分離する。
  "src/backup/history.ts",
  // Fork control-table, column-migration, and write-fence DDL; init.ts keeps apply order.
  "src/db/write-protection-schema.ts",
  "src/capture/pending.ts",
  "src/embedding/profile.ts",
  "src/entries/export.ts",
  // 公開Responses接続と暗号化したOAuth資格情報。既存DB/binding内で管理する。
  "src/lib/chatgpt.ts",
  "src/lib/chatgpt-session.ts",
  "src/routes/chatgpt.ts",
  "src/lib/cloudflare-access.ts",
  "src/lib/observability.ts",
  // バイト上限とstreamの終了処理のみ。認証・HTTP応答・providerへ依存しない。
  "src/lib/body.ts",
  "src/mcp/dispatch.ts",
  "src/mcp/executor.ts",
  "src/mcp/extended-tools.ts",
  "src/memory/tier.ts",
  "src/memory/history.ts",
  "src/memory/rollover-policy.ts",
  "src/memory/rollover.ts",
  "src/migration/write-lock.ts",
  "src/recall/query-signal-cache.ts",
  "src/routes/backup.ts",
  "src/routes/history.ts",
  "src/routes/rollover.ts",
  "src/text/lexical-query.ts",
  "src/vectorize/cleanup.ts",
  // Invocation-local accounting; no runtime service or new deployment binding.
  "src/runtime/d1-budget.ts",
  // Existing scheduled body shared by Cron and the existing executor namespace.
  "src/runtime/scheduled.ts",
]);

// These files are intentionally delegated back to active upstream byte-for-byte.
// Fork policy belongs in adjacent allowlisted modules, never in these paths.
export const UPSTREAM_OWNED_PATHS = Object.freeze([
  "src/text/tokenize.ts",
  "src/prompt-capsule/build.ts",
  "src/prompt-capsule/cache.ts",
  "src/prompt-capsule/etag.ts",
  "src/prompt-capsule/select.ts",
  "src/prompt-capsule/serialize.ts",
  "src/prompt-capsule/types.ts",
  "src/routes/prompt-capsule.ts",
  "src/projects/filter.ts",
  "src/projects/resolve.ts",
  "src/integrations/index.ts",
  "src/recall/snippet.ts",
  "src/mcp/sanitize.ts",
  "src/db/fts-write-guard.ts",
  "src/db/fts-backfill.ts",
  "src/db/fts-repair.ts",
  "src/db/entry-counts-repair.ts",
  "src/recall/fts.ts",
  "src/recall/model-reranker.ts",
  "src/recall/keyword-rows.ts",
  "public/js/board.js",
]);

// UPSTREAM_SYNC.mdの移動対応表。実行時の登録やdispatchには使わない。
export function movedImplementationReviews(changedPaths) {
  const mappings = [
    {
      sourcePaths: ["db/schema.sql", "src/db/init.ts"],
      targetPaths: ["db/fork-write-protection.sql", "src/db/write-protection-schema.ts", "src/db/init.ts"],
      tests: ["test/unit/write-protection-ddl-parity.test.ts", "test/unit/db-init.test.ts", "test/unit/schema-upgrade-completeness.test.ts"],
      note: "M1 DDLの移動元が変更されています。管理テーブル・marker列・trigger世代と適用順序を照合してください。",
    },
    {
      sourcePaths: ["src/index.ts", "src/insight/schedule.ts", "src/runtime/night-summary.ts"],
      targetPaths: ["src/runtime/scheduled.ts", "src/index.ts", "src/mcp/executor.ts"],
      tests: ["test/unit/cron-triggers.test.ts", "test/unit/cron-subrequest-budget.test.ts", "test/unit/nightly-upstream.test.ts", "test/unit/nightly-cpu-isolation.test.ts", "experiments/nightly-perf/vitest.config.ts"],
      note: "夜間の移動元または関連契約が変更されています。cron・pass・summaryとDO停止境界を照合してください。",
    },
    {
      sourcePaths: ["src/mcp/server.ts"],
      targetPaths: ["src/mcp/server.ts", "src/mcp/extended-tools.ts"],
      tests: ["test/integration/mcp-tools-contract.test.ts", "test/integration/mcp-schema-isolation.test.ts"],
      note: "MCP登録の移動元が変更されています。tool順序・description/schema・workspace・入出力契約を照合してください。",
    },
    {
      sourcePaths: ["src/capture/store.ts", "src/capture/lifecycle.ts"],
      targetPaths: ["src/capture/store.ts", "src/capture/lifecycle.ts", "src/capture/pending.ts", "src/vectorize/cleanup.ts", "src/memory/history.ts"],
      tests: ["test/unit/fork-ownership-contract.test.ts", "test/integration/append.test.ts", "test/integration/vectorize-pending.test.ts", "test/integration/pending-search-continuity.test.ts", "test/integration/history-commit-boundary.test.ts", "test/integration/vector-cleanup-boundary.test.ts", "test/integration/lifecycle-cleanup-boundary.test.ts", "test/integration/migration-write-lock.test.ts"],
      note: "保存処理の移動元が変更されています。CAS・before-image・削除台帳・遠隔受付と更新順序、M7追記待ちpassageとreceipt再試行判定を照合してください。",
    },
    {
      sourcePaths: ["src/recall/distill.ts", "src/recall/insight.ts", "src/compression/digest.ts", "src/insight/reason.ts"],
      targetPaths: ["src/lib/ai.ts", "src/lib/chatgpt.ts"],
      tests: ["test/unit/chatgpt-generation.test.ts"],
      note: "生成処理の変更を共通接続先選択と照合してください。prompt・モデル・上限・失敗時の扱いを保持します。",
    },
    {
      sourcePaths: ["src/lib/http.ts", "src/integrations/notion.ts", "src/integrations/calendar.ts"],
      targetPaths: ["src/lib/body.ts", "src/lib/cloudflare-access.ts", "src/lib/chatgpt.ts"],
      tests: ["test/unit/body-boundary.test.ts", "test/integration/access-mcp-routing.test.ts"],
      note: "本文読取の変更を共通実装と照合してください。byte上限・中止・reader解放・callerの例外変換を保持します。",
    },
    {
      sourcePaths: ["src/mcp/handler.ts", "src/routes/index.ts"],
      targetPaths: ["src/mcp/handler.ts", "src/routes/index.ts", "src/mcp/dispatch.ts", "src/mcp/executor.ts", "src/migration/write-lock.ts"],
      tests: ["test/integration/mcp-handler-http.test.ts", "test/integration/migration-write-lock.test.ts", "test/unit/mcp-cpu-isolation.test.ts", "test/integration/private-post-routes.test.ts", "test/integration/access-mcp-routing.test.ts", "test/integration/mcp-tools-contract.test.ts", "test/unit/fork-ownership-contract.test.ts"],
      note: "M6の分類・admission取得/解放をwrite-lockと照合してください。認証範囲、純読取、未知tool、有限応答、常設購読拒否、CPU隔離を保持します。",
    },
    {
      sourcePaths: ["src/text/tokenize.ts"],
      targetPaths: ["src/text/tokenize.ts", "src/text/lexical-query.ts"],
      tests: ["test/unit/upstream-audit.test.ts", "test/integration/cjk-recall.test.ts"],
      note: "上流tokenizerの変更を利用側のD1検索方針と照合してください。上流同一性だけでは検索の意味的整合を保証しません。",
    },
    {
      sourcePaths: ["src/migration/embedding.ts"],
      targetPaths: ["src/migration/write-lock.ts", "src/tags/vocabulary.ts", "src/insight/candidates.ts"],
      tests: ["test/integration/migration-write-lock.test.ts", "test/integration/tag-vocabulary-cache.test.ts"],
      note: "移行処理の変更を世代番号の移動先と照合してください。世代更新・並行作成・cache無効化を保持します。",
    },
  ];
  return mappings.flatMap(mapping => {
    const sourcePaths = mapping.sourcePaths.filter(path => changedPaths.includes(path));
    return sourcePaths.length ? [{
      ...mapping, sourcePaths,
      note: `${mapping.note}path単位の候補であり意味的な差分判定ではありません。`,
    }] : [];
  });
}

export const FORK_BOUNDARIES = Object.freeze({
  maxInstallerChanges: 0,
  maxSrcRenameOrDelete: 0,
  maxSingleFileAddedLines: 1_500,
  // Source/total file counts, total additions/deletions and patch bytes are intentionally
  // report-only metrics. New modules remain governed by the explicit allowlist,
  // not by an arbitrary numeric ceiling.
});

export function parseDivergence(value) {
  const [upstreamOnly, forkOnly, ...rest] = value.trim().split(/\s+/).map(Number);
  if (rest.length > 0 || !Number.isInteger(upstreamOnly) || !Number.isInteger(forkOnly)) {
    throw new Error(`git rev-list の出力を解釈できません: ${JSON.stringify(value)}`);
  }
  return { upstreamOnly, forkOnly };
}

export function parseNameStatus(value) {
  if (!value.trim()) return [];

  if (value.includes("\0")) {
    const tokens = value.split("\0");
    if (tokens.at(-1) === "") tokens.pop();
    const entries = [];
    for (let i = 0; i < tokens.length;) {
      const status = tokens[i++];
      if (!status) throw new Error("git diff --name-status -z のstatusが空です");
      if (status.startsWith("R") || status.startsWith("C")) {
        const oldPath = tokens[i++];
        const path = tokens[i++];
        if (oldPath === undefined || path === undefined) throw new Error("rename/copy path が不足しています");
        entries.push({ status, path, oldPath });
      } else {
        const path = tokens[i++];
        if (path === undefined) throw new Error("変更pathが不足しています");
        entries.push({ status, path, oldPath: undefined });
      }
    }
    return entries;
  }

  return value.trimEnd().split("\n").map((line) => {
    const [status, firstPath, secondPath] = line.split("\t");
    if (!status || !firstPath) {
      throw new Error(`git diff --name-status の出力を解釈できません: ${JSON.stringify(line)}`);
    }
    return {
      status,
      path: secondPath ?? firstPath,
      oldPath: secondPath ? firstPath : undefined,
    };
  });
}

export function parseNumstat(value) {
  if (!value.trim()) return { added: 0, deleted: 0, files: [] };
  if (value.includes("\0")) {
    const tokens = value.split("\0");
    if (tokens.at(-1) === "") tokens.pop();
    const files = [];
    for (let i = 0; i < tokens.length;) {
      const record = tokens[i++];
      const [addedRaw, deletedRaw, pathInRecord = ""] = record.split("\t");
      const path = pathInRecord || (tokens[i++] ?? "");
      // A rename/copy has an empty path in the first record, then old and new paths.
      const finalPath = pathInRecord ? path : (tokens[i++] ?? "");
      if (!finalPath || !/^\d+$/.test(addedRaw) || !/^\d+$/.test(deletedRaw)) {
        throw new Error(`git diff --numstat -z の出力を解釈できません: ${JSON.stringify(record)}`);
      }
      files.push({ path: finalPath, added: Number(addedRaw), deleted: Number(deletedRaw) });
    }
    return {
      added: files.reduce((sum, file) => sum + file.added, 0),
      deleted: files.reduce((sum, file) => sum + file.deleted, 0),
      files,
    };
  }
  const files = value.trimEnd().split("\n").map((line) => {
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if (!path || !/^\d+$/.test(addedRaw) || !/^\d+$/.test(deletedRaw)) {
      throw new Error(`git diff --numstat の出力を解釈できません: ${JSON.stringify(line)}`);
    }
    return { path, added: Number(addedRaw), deleted: Number(deletedRaw) };
  });
  return {
    added: files.reduce((sum, file) => sum + file.added, 0),
    deleted: files.reduce((sum, file) => sum + file.deleted, 0),
    files,
  };
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const INSTALL_LIFECYCLE_KEYS = Object.freeze([
  "preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare",
]);

export function installLifecycleScripts(pkg) {
  return Object.fromEntries(INSTALL_LIFECYCLE_KEYS.map(key => [key, pkg.scripts?.[key] ?? null]));
}

export function worktreeCurrentFailure(statusPorcelain, requireCurrent) {
  if (!requireCurrent || statusPorcelain.length === 0) return null;
  return "作業treeに未commit変更があります。--require-current はcommit済みHEADだけを監査します";
}

export function intersectPaths(left, right) {
  const rightSet = new Set(right);
  return [...new Set(left)].filter(path => rightSet.has(path)).sort();
}

const FENCED_MEMORY_TABLES = Object.freeze([
  "entries", "edges", "insight_candidates", "vector_cleanup_ops", "projects",
  "entry_versions", "entries_trash", "recall_log",
]);
const FENCED_MEMORY_TABLE_PATTERN = FENCED_MEMORY_TABLES.join("|");

// SQLiteの引用識別子とschema修飾も同じ保護対象として扱う。
// SQLの完全な構文解析ではなく、DB triggerを補助する静的検査である。
function sqlIdentifier(pattern) {
  const name = `(?:${pattern})`;
  return `(?:${name}|"${name}"|\`${name}\`|\\[${name}\\])`;
}
const SQL_SCHEMA_PREFIX = `(?:${sqlIdentifier("[A-Za-z_]\\w*")}\\s*\\.\\s*)?`;
const FENCED_SQL_TARGET = `${SQL_SCHEMA_PREFIX}(${sqlIdentifier(FENCED_MEMORY_TABLE_PATTERN)})`;

function sourceSqlText(value) {
  // JSの引用符と改行のescapeだけを解く。任意の式を評価しない。
  return value.replace(/\\([\\"'`])/g, "$1").replace(/\\[nrt]/g, " ");
}

/**
 * Extract JavaScript/TypeScript string literals while excluding comments. The
 * audit intentionally inspects SQL text, not arbitrary prose mentioning a table.
 * Template substitutions remain as source text; fence columns are literal SQL.
 */
function sourceStringLiterals(source) {
  const literals = [];
  for (let i = 0; i < source.length;) {
    if (source[i] === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i + 2);
      if (i === -1) break;
      continue;
    }
    if (source[i] === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const quote = source[i];
    if (quote !== "\"" && quote !== "'" && quote !== "`") {
      i++;
      continue;
    }
    const start = i++;
    let value = "";
    while (i < source.length) {
      const char = source[i++];
      if (char === "\\") {
        value += char;
        if (i < source.length) value += source[i++];
        continue;
      }
      if (char === quote) break;
      value += char;
    }
    literals.push({ start, value });
  }
  return literals;
}

function sourceLine(source, index) {
  return source.slice(0, index).split("\n").length;
}

/**
 * Static contract for the five trigger-fenced memory tables. INSERT/UPDATE SQL
 * must carry a per-statement capability column. DELETE consumes a capability
 * already written to OLD.write_marker, so the nearby operation must either stage
 * a delete-purpose marker or explicitly use the final-delta privileged marker.
 */
export function auditWriteFenceSource(source, path = "<source>") {
  const findings = [];
  const insert = new RegExp(`\\bINSERT(?:\\s+OR\\s+\\w+)?\\s+INTO\\s+${FENCED_SQL_TARGET}\\s*\\(`, "i");
  const update = new RegExp(`\\bUPDATE(?:\\s+OR\\s+\\w+)?\\s+${FENCED_SQL_TARGET}(?:\\s+(?:AS\\s+)?[A-Za-z_]\\w*)?\\s+SET\\b`, "i");
  const remove = new RegExp(`\\bDELETE\\s+FROM\\s+${FENCED_SQL_TARGET}(?=\\s|;|$)`, "i");
  let mutations = 0;

  for (const literal of sourceStringLiterals(source)) {
    const statement = sourceSqlText(literal.value).trim();
    const insertMatch = statement.match(insert);
    const updateMatch = statement.match(update);
    const deleteMatch = statement.match(remove);
    const match = insertMatch ?? updateMatch ?? deleteMatch;
    if (!match) continue;
    mutations++;
    const table = match[1].replace(/["`\[\]]/g, "").toLowerCase();
    const line = sourceLine(source, literal.start);
    if (deleteMatch) {
      const nearby = sourceSqlText(source.slice(Math.max(0, literal.start - 700), literal.start + literal.value.length + 700));
      const stagesDeleteMarker = new RegExp(
        `UPDATE\\s+${SQL_SCHEMA_PREFIX}${sqlIdentifier(table)}\\s+SET\\s+${sqlIdentifier("write_marker")}`, "i",
      ).test(nearby) && /memoryWriteMarker\s*\([^)]*["']delete["']/s.test(nearby);
      const usesPrivilegedMarker = /privilegedMarker|finalDeltaMarker|migrationMarker/.test(nearby);
      // 4.0の履歴pruneは同一記憶のsnapshot、trash復元は同batchの復元行を
      // triggerで検証する。既存entries/edges等のdelete-purpose契約は緩めない。
      const annotation = source.slice(Math.max(0, literal.start - 450), literal.start)
        .match(/write-fence: parent-capability=(entries|entries_trash|entry_versions)\b/);
      const parentAllowed = annotation && (table === "entry_versions"
        || (table === "entries_trash" && annotation[1] === "entries"));
      if (!stagesDeleteMarker && !usesPrivilegedMarker && !parentAllowed) {
        findings.push(`${path}:${line}: DELETE FROM ${table} にdelete/privileged markerがありません`);
      }
      continue;
    }
    if (!/\bwrite_marker\b/i.test(statement)
      && !/\bmigration_lease_owner\b/i.test(statement)
      && !/\brestore_lease_owner\b/i.test(statement)) {
      findings.push(`${path}:${line}: ${insertMatch ? "INSERT INTO" : "UPDATE"} ${table} にcapability markerがありません`);
    }
  }
  return { mutations, failures: findings };
}

export function classifyChanges(entries) {
  const newSrcModules = [];
  const modifiedExistingSrcFiles = [];
  const installerChanges = [];
  const srcRenameOrDelete = [];
  let packageLockChanged = false;

  for (const entry of entries) {
    const paths = [entry.oldPath, entry.path].filter(Boolean);
    if (paths.some((path) => path.startsWith("installer/"))) installerChanges.push(entry.path);
    if (paths.includes("package-lock.json")) packageLockChanged = true;

    const touchesSrc = paths.some((path) => path.startsWith("src/"));
    if (!touchesSrc) continue;

    if (entry.status === "A") {
      newSrcModules.push(entry.path);
    } else if (entry.status === "D" || entry.status.startsWith("R")) {
      srcRenameOrDelete.push(entry.path);
    } else {
      modifiedExistingSrcFiles.push(entry.path);
    }
  }

  return {
    newSrcModules: [...new Set(newSrcModules)].sort(),
    modifiedExistingSrcFiles: [...new Set(modifiedExistingSrcFiles)].sort(),
    installerChanges: [...new Set(installerChanges)].sort(),
    srcRenameOrDelete: [...new Set(srcRenameOrDelete)].sort(),
    packageLockChanged,
  };
}

/**
 * @param {ReturnType<typeof classifyChanges>} classification
 * @param {{runtimeEqual: boolean, developmentEqual: boolean}} dependencyState
 * @param {{added: number, deleted: number, files: Array<{path: string, added: number, deleted: number}>, changedFiles?: number, patchBytes?: number} | null} [lineChanges]
 */
export function evaluateBoundaries(classification, dependencyState, lineChanges = null) {
  const failures = [];
  const unapprovedNewSrcModules = classification.newSrcModules.filter(
    (path) => !APPROVED_NEW_SRC_MODULES.has(path),
  );

  if (unapprovedNewSrcModules.length > 0) {
    failures.push(`未承認の新規 src module: ${unapprovedNewSrcModules.join(", ")}`);
  }
  if (classification.installerChanges.length > FORK_BOUNDARIES.maxInstallerChanges) {
    failures.push(`installer/ に fork 固有差分があります: ${classification.installerChanges.join(", ")}`);
  }
  if (classification.srcRenameOrDelete.length > FORK_BOUNDARIES.maxSrcRenameOrDelete) {
    failures.push(`src/ に rename または delete があります: ${classification.srcRenameOrDelete.join(", ")}`);
  }
  if (classification.packageLockChanged) {
    failures.push("package-lock.json に fork 固有差分があります");
  }
  if (!dependencyState.runtimeEqual) {
    failures.push("package.json の dependencies に fork 固有差分があります");
  }
  if (!dependencyState.developmentEqual) {
    failures.push("package.json の devDependencies に fork 固有差分があります");
  }
  if (dependencyState.lifecycleEqual === false) {
    failures.push("package.json のinstall lifecycle scriptsにfork固有差分があります");
  }
  if (dependencyState.ancillaryEqual === false) {
    failures.push("package.json のpeer/optionalDependenciesまたはoverridesにfork固有差分があります");
  }
  if (lineChanges) {
    const oversized = lineChanges.files.filter(
      (file) => file.added > FORK_BOUNDARIES.maxSingleFileAddedLines,
    );
    if (oversized.length > 0) {
      failures.push(`単一file追加行数が上限を超えました: ${oversized.map((file) => `${file.path}=${file.added}`).join(", ")}`);
    }
  }

  return { failures, unapprovedNewSrcModules };
}

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout || "詳細なし").trim();
    throw new Error(`git ${args.join(" ")} に失敗しました: ${detail}`);
  }
  return result;
}

function gitText(args) {
  return git(args).stdout.trim();
}

function readPackageAt(ref) {
  const result = git(["show", `${ref}:package.json`]);
  return JSON.parse(result.stdout);
}

function assertAncestor(ancestor, descendant) {
  const result = git(["merge-base", "--is-ancestor", ancestor, descendant], { allowFailure: true });
  return result.status === 0;
}

function validateUpstreamRef(ref, option) {
  if (!/^upstream\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)
    || ref.includes("..")
    || ref.endsWith("/")) {
    throw new Error(`${option} は upstream/ 配下のbranch refで指定してください: ${ref}`);
  }
  return ref;
}

export function parseArgs(argv) {
  const known = new Set(["--fetch", "--require-current", "--require-mergeable", "--check-push-block", "--json"]);
  const upstreamOptions = argv.filter((arg) => arg.startsWith("--upstream-ref="));
  if (upstreamOptions.length > 1) throw new Error("--upstream-ref は1回だけ指定できます");
  const watchOptions = argv.filter((arg) => arg.startsWith("--watch-ref="));
  const reviewOptions = argv.filter((arg) => arg.startsWith("--review-from="));
  if (reviewOptions.length > 1) throw new Error("--review-from は1回だけ指定できます");
  const reviewFrom = reviewOptions[0]?.slice("--review-from=".length) ?? null;
  if (reviewFrom !== null && !/^[a-f0-9]{40}$/.test(reviewFrom)) {
    throw new Error("--review-from は前回確認した上流commitの40桁SHAを指定してください");
  }
  const unknown = argv.filter((arg) => !known.has(arg)
    && !arg.startsWith("--upstream-ref=")
    && !arg.startsWith("--review-from=")
    && !arg.startsWith("--watch-ref="));
  if (unknown.length > 0) throw new Error(`未対応の引数です: ${unknown.join(", ")}`);
  const upstreamRef = validateUpstreamRef(
    upstreamOptions[0]?.slice("--upstream-ref=".length) || DEFAULT_UPSTREAM_REF,
    "--upstream-ref",
  );
  const watchRefs = [...new Set(watchOptions.map((arg) => validateUpstreamRef(
    arg.slice("--watch-ref=".length),
    "--watch-ref",
  )))].filter((ref) => ref !== upstreamRef);
  return {
    fetch: argv.includes("--fetch"),
    requireCurrent: argv.includes("--require-current"),
    requireMergeable: argv.includes("--require-mergeable"),
    checkPushBlock: argv.includes("--check-push-block"),
    json: argv.includes("--json"),
    upstreamRef,
    watchRefs,
    reviewFrom,
  };
}

function printHuman(report) {
  const state = report.failures.length === 0 ? "PASS" : "FAIL";
  console.log(`Upstream sync audit: ${state}`);
  console.log(`  HEAD:             ${report.head}`);
  console.log(`  upstream ref:     ${report.upstreamRef}`);
  console.log(`  upstream commit:  ${report.upstream}`);
  console.log(`  upstream / fork:  ${report.divergence.upstreamOnly} / ${report.divergence.forkOnly}`);
  for (const watched of report.watchedRefs) {
    console.log(`  watch ${watched.ref}: ${watched.unmerged} unmerged`);
  }
  console.log(`  merge rehearsal: ${report.merge.clean ? "clean" : "conflict"}`);
  console.log(`  working tree:    ${report.worktree.clean ? "clean" : "dirty"}`);
  console.log(`  changed files:    ${report.changedFiles} (report only)`);
  console.log(
    `  src new/modified: ${report.classification.newSrcModules.length} / ${report.classification.modifiedExistingSrcFiles.length}`,
  );
  console.log(`  installer changes: ${report.classification.installerChanges.length}`);
  console.log(`  fenced SQL mutations: ${report.mutationAudit.mutations}`);
  console.log(`  upstream hotspots: ${report.upstreamHotspots.length}`);
  console.log(`  upstream-owned drift: ${report.upstreamOwnedPathDrift.length}`);
  console.log(`  moved implementation review: ${report.movedReview.items.length} (${report.movedReview.from}..${report.upstream})`);
  for (const item of report.movedReview.items) {
    console.log(`    ${item.sourcePaths.join(", ")} → ${item.targetPaths.join(", ")}`);
    console.log(`    回帰: ${item.tests.join(", ")}`);
    console.log(`    ${item.note}`);
  }
  console.log(`  lines added/deleted: ${report.lines.added} (report only) / ${report.lines.deleted}`);
  console.log(`  patch bytes:        ${report.lines.patchBytes} (report only)`);
  console.log(`  dependency delta:  ${report.dependencies.equal ? "0" : "あり"}`);
  console.log(`  upstream push:     ${report.remote.pushBlocked ? "DISABLED" : "未遮断"}`);
  if (report.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of report.warnings) console.log(`  - ${warning}`);
  }
  if (report.failures.length > 0) {
    console.error("Failures:");
    for (const failure of report.failures) console.error(`  - ${failure}`);
  }
}

export function runAudit(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const failures = [];
  const warnings = [];

  const worktreeStatus = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
  const worktreeFailure = worktreeCurrentFailure(worktreeStatus, args.requireCurrent);
  if (worktreeFailure) failures.push(worktreeFailure);
  else if (worktreeStatus.length > 0) warnings.push("作業treeはdirtyです。報告値はcommit済みHEADだけを対象にします");

  const fetchUrl = gitText(["remote", "get-url", "upstream"]);
  if (fetchUrl !== EXPECTED_UPSTREAM_URL) {
    failures.push(`upstream URL が契約と異なります: ${fetchUrl}`);
  }

  const pushUrls = git(["config", "--get-all", "remote.upstream.pushurl"], { allowFailure: true })
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const pushBlocked = pushUrls.length === 1 && pushUrls[0] === "DISABLED";
  if (args.checkPushBlock && !pushBlocked) {
    failures.push("upstream push が遮断されていません。git config remote.upstream.pushurl DISABLED を実行してください");
  }

  if (args.fetch) git(["fetch", "--prune", "--tags", "upstream"]);

  const head = gitText(["rev-parse", "HEAD"]);
  const upstream = gitText(["rev-parse", args.upstreamRef]);
  // 未取込時は直近共通祖先以降だけを照合する。統合後の再監査では前回上流SHAを明示できる。
  const reviewFrom = args.reviewFrom ?? gitText(["merge-base", "HEAD", upstream]);
  gitText(["rev-parse", "--verify", `${reviewFrom}^{commit}`]);
  if (!assertAncestor(reviewFrom, upstream)) {
    throw new Error("--review-from は対象upstreamの祖先である必要があります");
  }
  const reviewChangedPaths = gitText(["diff", "--name-only", "-z", `${reviewFrom}..${upstream}`])
    .split("\0").filter(Boolean);
  const movedReview = { from: reviewFrom, to: upstream, items: movedImplementationReviews(reviewChangedPaths) };
  const divergence = parseDivergence(gitText([
    "rev-list", "--left-right", "--count", `${args.upstreamRef}...HEAD`,
  ]));
  if (divergence.upstreamOnly > 0) {
    const message = `${args.upstreamRef} に未取込の commit が ${divergence.upstreamOnly} 件あります`;
    if (args.requireCurrent) failures.push(message);
    else warnings.push(message);
  }
  const watchedRefs = args.watchRefs.map((ref) => ({
    ref,
    commit: gitText(["rev-parse", ref]),
    unmerged: Number(gitText(["rev-list", "--count", `HEAD..${ref}`])),
  }));
  for (const watched of watchedRefs) {
    if (watched.unmerged === 0) continue;
    const message = `${watched.ref} にHEAD未取込の commit が ${watched.unmerged} 件あります`;
    if (args.requireCurrent) failures.push(message);
    else warnings.push(message);
  }

  gitText(["rev-parse", "--verify", `${BASE_TAG}^{commit}`]);
  if (!assertAncestor(BASE_TAG, args.upstreamRef)) {
    failures.push(`${BASE_TAG} が ${args.upstreamRef} の祖先ではありません`);
  }
  if (!assertAncestor(BASE_TAG, "HEAD")) {
    failures.push(`${BASE_TAG} が HEAD の祖先ではありません`);
  }

  const mergeResult = git(["merge-tree", "--write-tree", "--messages", "HEAD", args.upstreamRef], {
    allowFailure: true,
  });
  const mergeLines = mergeResult.stdout.trim().split("\n").filter(Boolean);
  const merge = {
    clean: mergeResult.status === 0,
    tree: mergeLines[0] ?? null,
    messages: mergeLines.slice(1),
  };
  if (!merge.clean) {
    const message = `${args.upstreamRef} の merge rehearsal で競合しました`;
    if (args.requireMergeable) failures.push(message);
    else warnings.push(message);
  }

  const comparison = `${args.upstreamRef}...HEAD`;
  const entries = parseNameStatus(git(["diff", "--name-status", "-z", comparison]).stdout);
  const parsedLines = parseNumstat(git(["diff", "--numstat", "-z", comparison]).stdout);
  const patchBytes = Buffer.byteLength(
    git(["diff", "--no-ext-diff", "--binary", comparison]).stdout,
    "utf8",
  );
  const lineChanges = { ...parsedLines, changedFiles: entries.length, patchBytes };
  const classification = classifyChanges(entries);
  const upstreamPackage = readPackageAt(args.upstreamRef);
  const forkPackage = readPackageAt("HEAD");
  const dependencyState = {
    runtimeEqual: stableStringify(upstreamPackage.dependencies ?? {}) === stableStringify(forkPackage.dependencies ?? {}),
    developmentEqual:
      stableStringify(upstreamPackage.devDependencies ?? {}) === stableStringify(forkPackage.devDependencies ?? {}),
    lifecycleEqual: stableStringify(installLifecycleScripts(upstreamPackage))
      === stableStringify(installLifecycleScripts(forkPackage)),
    ancillaryEqual: stableStringify({
      peerDependencies: upstreamPackage.peerDependencies ?? {},
      optionalDependencies: upstreamPackage.optionalDependencies ?? {},
      overrides: upstreamPackage.overrides ?? {},
    }) === stableStringify({
      peerDependencies: forkPackage.peerDependencies ?? {},
      optionalDependencies: forkPackage.optionalDependencies ?? {},
      overrides: forkPackage.overrides ?? {},
    }),
  };
  const boundary = evaluateBoundaries(classification, dependencyState, lineChanges);
  failures.push(...boundary.failures);
  const auditedSources = gitText(["ls-tree", "-r", "--name-only", "HEAD", "src"])
    .split("\n").filter(path => path.endsWith(".ts"));
  const mutationAudit = { files: auditedSources.length, mutations: 0, failures: [] };
  for (const path of auditedSources) {
    const result = auditWriteFenceSource(git(["show", `HEAD:${path}`]).stdout, path);
    mutationAudit.mutations += result.mutations;
    mutationAudit.failures.push(...result.failures);
  }
  failures.push(...mutationAudit.failures);
  const upstreamChangedSinceBase = gitText(["diff", "--name-only", `${BASE_TAG}..${args.upstreamRef}`])
    .split("\n").filter(Boolean);
  // Compare upstream's movement since the fork baseline with fork-only work.
  // Using BASE_TAG..HEAD here would count upstream commits already merged into
  // the fork as local changes and turn every subsequent audit into noise.
  const forkChangedSinceBase = gitText(["diff", "--name-only", comparison])
    .split("\n").filter(Boolean);
  const upstreamHotspots = intersectPaths(upstreamChangedSinceBase, forkChangedSinceBase);
  if (upstreamHotspots.length > 0) {
    warnings.push(`upstream変更とfork hotspotの交差が${upstreamHotspots.length}件あります: ${upstreamHotspots.join(", ")}`);
  }
  const upstreamOwnedPathDrift = UPSTREAM_OWNED_PATHS.filter((path) => {
    const result = git(["diff", "--quiet", args.upstreamRef, "HEAD", "--", path], { allowFailure: true });
    if (result.status === 0) return false;
    if (result.status === 1) return true;
    const detail = (result.stderr || result.stdout || "詳細なし").trim();
    throw new Error(`upstream-owned pathの比較に失敗しました (${path}): ${detail}`);
  });
  if (upstreamOwnedPathDrift.length > 0) {
    failures.push(`upstream-owned pathにfork差分があります: ${upstreamOwnedPathDrift.join(", ")}`);
  }

  const report = {
    version: 4,
    generatedAt: new Date().toISOString(),
    head,
    upstream,
    upstreamRef: args.upstreamRef,
    watchedRefs,
    baseTag: BASE_TAG,
    divergence,
    merge,
    changedFiles: entries.length,
    lines: lineChanges,
    classification,
    mutationAudit,
    upstreamHotspots,
    upstreamOwnedPathDrift,
    movedReview,
    dependencies: {
      runtimeEqual: dependencyState.runtimeEqual,
      developmentEqual: dependencyState.developmentEqual,
      lifecycleEqual: dependencyState.lifecycleEqual,
      ancillaryEqual: dependencyState.ancillaryEqual,
      equal: dependencyState.runtimeEqual && dependencyState.developmentEqual
        && dependencyState.lifecycleEqual && dependencyState.ancillaryEqual
        && !classification.packageLockChanged,
    },
    remote: { fetchUrl, pushUrls, pushBlocked },
    worktree: { clean: worktreeStatus.length === 0 },
    warnings,
    failures,
  };

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  return report;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const report = runAudit();
    if (report.failures.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`Upstream sync audit: ERROR\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
