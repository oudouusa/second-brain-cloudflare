import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyChanges,
  APPROVED_NEW_SRC_MODULES,
  auditWriteFenceSource,
  evaluateBoundaries,
  FORK_BOUNDARIES,
  INSTALL_LIFECYCLE_KEYS,
  installLifecycleScripts,
  parseDivergence,
  parseArgs,
  parseNameStatus,
  parseNumstat,
  stableStringify,
  UPSTREAM_OWNED_PATHS,
  worktreeCurrentFailure,
  intersectPaths,
  movedImplementationReviews,
} from "../../scripts/audit-upstream-sync.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("upstream sync audit", () => {
  test("夜間移動元の変更に確認先と実在する回帰を対応付ける", () => {
    const reviews = movedImplementationReviews(["README.md", "src/index.ts", "src/index.ts", "src/runtime/night-summary.ts"]);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].sourcePaths).toEqual(["src/index.ts", "src/runtime/night-summary.ts"]);
    expect(reviews[0].targetPaths).toContain("src/runtime/scheduled.ts");
    for (const path of [...reviews[0].targetPaths, ...reviews[0].tests]) {
      expect(readFileSync(resolve(ROOT, path), "utf8").length).toBeGreaterThan(0);
    }
    expect(movedImplementationReviews(["README.md", "src/recall/search.ts"])).toEqual([]);
    expect(movedImplementationReviews([])).toEqual([]);
    expect(movedImplementationReviews(["src/insight/schedule.ts"])).toHaveLength(1);
  });

  test("移動元の比較基準は明示SHAだけを受け付ける", () => {
    const sha = "1d7c66a3a96ea25976846b0ffad1ac95a14f7feb";
    expect(parseArgs([]).reviewFrom).toBeNull();
    expect(parseArgs([`--review-from=${sha}`]).reviewFrom).toBe(sha);
    for (const value of ["", "HEAD", "--help", "a..b", "1d7c66a"]) {
      expect(() => parseArgs([`--review-from=${value}`])).toThrow(/40桁SHA/);
    }
    expect(() => parseArgs([`--review-from=${sha}`, `--review-from=${sha}`])).toThrow(/1回/);
  });

  test("MCPと保存の移動先を夜間とは独立に案内する", () => {
    const cases = [
      ["src/mcp/server.ts", "src/mcp/extended-tools.ts"],
      ["src/capture/store.ts", "src/vectorize/cleanup.ts"],
      ["src/capture/lifecycle.ts", "src/vectorize/cleanup.ts"],
    ];
    for (const [source, target] of cases) {
      const reviews = movedImplementationReviews([source, source]);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].sourcePaths).toEqual([source]);
      expect(reviews[0].targetPaths).toContain(target);
      if (source === "src/capture/store.ts") {
        expect(reviews[0].targetPaths).toContain("src/capture/pending.ts");
        expect(reviews[0].tests).toContain("test/integration/append.test.ts");
      }
      expect(reviews[0].note).toContain("path単位");
      for (const path of [...reviews[0].targetPaths, ...reviews[0].tests]) {
        expect(readFileSync(resolve(ROOT, path), "utf8").length).toBeGreaterThan(0);
      }
    }
    const combined = movedImplementationReviews(["src/capture/store.ts", "src/mcp/server.ts", "src/index.ts"]);
    expect(combined).toHaveLength(3);
    expect(combined.flatMap(review => review.sourcePaths).sort())
      .toEqual(["src/capture/store.ts", "src/index.ts", "src/mcp/server.ts"]);
  });
  test("共通化後の変更元から実在する照合先を案内する", () => {
    const cases = [
      ...["src/recall/distill.ts", "src/recall/insight.ts", "src/compression/digest.ts", "src/insight/reason.ts"].map(source => [source, "src/lib/ai.ts"]),
      ...["src/lib/http.ts", "src/integrations/notion.ts", "src/integrations/calendar.ts"].map(source => [source, "src/lib/body.ts"]),
      ["src/mcp/handler.ts", "src/mcp/executor.ts"],
      ["src/routes/index.ts", "src/migration/write-lock.ts"],
      ["src/text/tokenize.ts", "src/text/lexical-query.ts"],
      ["src/migration/embedding.ts", "src/migration/write-lock.ts"],
    ];
    for (const [source, target] of cases) {
      const reviews = movedImplementationReviews([source, source]);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].sourcePaths).toEqual([source]);
      expect(reviews[0].targetPaths).toContain(target);
      for (const path of [...reviews[0].targetPaths, ...reviews[0].tests]) {
        expect(readFileSync(resolve(ROOT, path), "utf8").length).toBeGreaterThan(0);
      }
    }
  });
  test("fork固有のHTTP運用保護をupstream共通helperへ戻さない", () => {
    const http = readFileSync(resolve(ROOT, "src/lib/http.ts"), "utf8");
    const observability = readFileSync(resolve(ROOT, "src/lib/observability.ts"), "utf8");
    const access = readFileSync(resolve(ROOT, "src/lib/cloudflare-access.ts"), "utf8");

    expect(http).not.toContain("SAFE_LOG_FIELDS");
    expect(http).not.toContain("cloudflareAccessConfig");
    expect(observability).toContain("SAFE_LOG_FIELDS");
    expect(access).toContain("cloudflareAccessConfig");
  });

  test("CJKの基礎tokenizerをactive upstreamのbyte-identical領域として固定する", () => {
    expect(UPSTREAM_OWNED_PATHS).toContain("src/text/tokenize.ts");
    expect(UPSTREAM_OWNED_PATHS).toContain("src/mcp/sanitize.ts");
    for (const path of [
      "src/db/fts-write-guard.ts", "src/db/fts-backfill.ts", "src/db/fts-repair.ts",
      "src/db/entry-counts-repair.ts", "src/recall/fts.ts",
    ]) expect(UPSTREAM_OWNED_PATHS).toContain(path);
    expect(UPSTREAM_OWNED_PATHS).toHaveLength(21);
  });

  test("上流へ委譲した実装をfork新規moduleとして二重所有しない", () => {
    for (const path of ["src/prompt-capsule/build.ts", "src/routes/prompt-capsule.ts", "src/projects/filter.ts", "src/projects/resolve.ts"]) {
      expect(UPSTREAM_OWNED_PATHS).toContain(path);
    }
    expect(UPSTREAM_OWNED_PATHS.every(path => !APPROVED_NEW_SRC_MODULES.has(path))).toBe(true);
    const classification = classifyChanges([{ status: "A", path: "src/prompt-capsule/build.ts" }]);
    expect(evaluateBoundaries(classification, { runtimeEqual: true, developmentEqual: true }).failures)
      .toEqual([expect.stringContaining("未承認の新規 src module")]);
  });

  test("CIと定期監査がpackage.jsonのactive upstream監査を使い分ける", () => {
    const workflow = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));

    for (const name of ["upstream:audit", "upstream:audit:boundary"]) {
      const args = parseArgs(pkg.scripts[name].split(" ").slice(2));
      expect(args).toMatchObject({
        upstreamRef: "upstream/release/4.0.0", watchRefs: ["upstream/main"], fetch: true, checkPushBlock: true,
        requireCurrent: name === "upstream:audit",
        requireMergeable: name === "upstream:audit",
      });
    }
    expect(workflow).toContain("run: npm run upstream:audit:boundary");
    expect(workflow).not.toContain(
      "run: node scripts/audit-upstream-sync.mjs --fetch --require-current --check-push-block",
    );
  });

  test("active upstream branchと追加watch refを安全に解釈する", () => {
    expect(parseArgs([]).upstreamRef).toBe("upstream/main");
    expect(parseArgs([
      "--fetch",
      "--upstream-ref=upstream/feat/v3-team-edition",
      "--watch-ref=upstream/main",
      "--watch-ref=upstream/main",
    ])).toMatchObject({
      fetch: true,
      requireMergeable: false,
      upstreamRef: "upstream/feat/v3-team-edition",
      watchRefs: ["upstream/main"],
    });
    expect(() => parseArgs(["--upstream-ref=origin/main"])).toThrow(/upstream\//);
    expect(() => parseArgs(["--watch-ref=upstream/../main"])).toThrow(/upstream\//);
    expect(parseArgs(["--require-mergeable"]).requireMergeable).toBe(true);
  });

  test("upstream と fork の divergence を読む", () => {
    expect(parseDivergence("2\t21\n")).toEqual({ upstreamOnly: 2, forkOnly: 21 });
  });

  test("name-status から fork 境界に関係する変更を分類する", () => {
    const entries = parseNameStatus(
      [
        "A\tsrc/backup/r2.ts",
        "M\tsrc/env.ts",
        "M\tinstaller/package.json",
        "R100\tsrc/old.ts\tsrc/new.ts",
        "M\tpackage-lock.json",
      ].join("\n"),
    );

    expect(classifyChanges(entries)).toEqual({
      newSrcModules: ["src/backup/r2.ts"],
      modifiedExistingSrcFiles: ["src/env.ts"],
      installerChanges: ["installer/package.json"],
      srcRenameOrDelete: ["src/new.ts"],
      packageLockChanged: true,
    });
  });

  test("object のキー順に依存せず dependency を比較できる", () => {
    expect(stableStringify({ z: "1", a: { y: 2, x: 1 } })).toBe(
      stableStringify({ a: { x: 1, y: 2 }, z: "1" }),
    );
  });

  test.each(INSTALL_LIFECYCLE_KEYS)("npm ci lifecycle hook %s を監査対象にする", (hook) => {
    const upstream = installLifecycleScripts({ scripts: {} });
    const fork = installLifecycleScripts({ scripts: { [hook]: "node unexpected.mjs" } });
    expect(stableStringify(upstream)).not.toBe(stableStringify(fork));
  });

  test("--require-current はdirty worktreeを拒否する", () => {
    expect(worktreeCurrentFailure(" M src/index.ts\0", true)).toContain("未commit変更");
    expect(worktreeCurrentFailure(" M src/index.ts\0", false)).toBeNull();
    expect(worktreeCurrentFailure("", true)).toBeNull();
  });

  test("upstream変更とfork変更のsemantic review hotspotを列挙する", () => {
    expect(intersectPaths(
      ["src/routes/recall.ts", "README.md", "src/routes/recall.ts"],
      ["src/routes/recall.ts", "src/db/init.ts"],
    )).toEqual(["src/routes/recall.ts"]);
  });

  test("numstat を合計し、大幅変更fileを保持する", () => {
    expect(parseNumstat("10\t2\tsrc/a.ts\n1999\t0\tbenchmarks/result.json\n")).toEqual({
      added: 2009,
      deleted: 2,
      files: [
        { path: "src/a.ts", added: 10, deleted: 2 },
        { path: "benchmarks/result.json", added: 1999, deleted: 0 },
      ],
    });
  });

  test("NUL区切りならUnicode・改行pathをquote解除なしで分類する", () => {
    const entries = parseNameStatus("A\0src/悪意.ts\0M\0installer/改行\n名.json\0");
    const classified = classifyChanges(entries);
    expect(classified.newSrcModules).toEqual(["src/悪意.ts"]);
    expect(classified.installerChanges).toEqual(["installer/改行\n名.json"]);
    expect(parseNumstat("3\t1\tsrc/悪意.ts\0" + "2\t0\tinstaller/改行\n名.json\0").added).toBe(5);
  });

  test("承認済みの薄い fork 境界を通す", () => {
    const classification = classifyChanges(
      parseNameStatus([
        "A\tsrc/embedding/profile.ts",
        "A\tsrc/lib/cloudflare-access.ts",
        "A\tsrc/lib/chatgpt.ts",
        "A\tsrc/lib/observability.ts",
        "A\tsrc/memory/rollover-policy.ts",
        "A\tsrc/memory/rollover.ts",
        "M\tsrc/prompt-capsule/build.ts",
        "A\tsrc/recall/query-signal-cache.ts",
        "A\tsrc/routes/rollover.ts",
        "M\tsrc/env.ts",
        "M\tdocs/fork/DECISIONS.md",
      ].join("\n")),
    );
    expect(
      evaluateBoundaries(classification, { runtimeEqual: true, developmentEqual: true }).failures,
    ).toEqual([]);
  });

  test("未承認 module、installer、dependency 差分を拒否する", () => {
    const classification = classifyChanges(
      parseNameStatus("A\tsrc/unapproved.ts\nM\tinstaller/package.json\nM\tpackage-lock.json"),
    );
    const result = evaluateBoundaries(classification, {
      runtimeEqual: false,
      developmentEqual: false,
    });

    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("未承認の新規 src module"),
        expect.stringContaining("installer/"),
        expect.stringContaining("package-lock.json"),
        expect.stringContaining("dependencies"),
        expect.stringContaining("devDependencies"),
      ]),
    );
  });

  test("総追加・削除行数、srcを含む変更file数、patch byte数は制限せず、単一file上限を拒否する", () => {
    const classification = classifyChanges(parseNameStatus("M\tsrc/env.ts"));
    const result = evaluateBoundaries(
      classification,
      { runtimeEqual: true, developmentEqual: true },
      {
        added: 1_000_000,
        deleted: 1_000_000,
        files: [{
          path: "src/env.ts",
          added: FORK_BOUNDARIES.maxSingleFileAddedLines + 1,
          deleted: 1_000_000,
        }],
        changedFiles: 1_000_000,
        patchBytes: Number.MAX_SAFE_INTEGER,
      },
    );
    expect(FORK_BOUNDARIES).not.toHaveProperty("maxChangedFiles");
    expect(FORK_BOUNDARIES).not.toHaveProperty("maxNewSrcModules");
    expect(FORK_BOUNDARIES).not.toHaveProperty("maxModifiedExistingSrcFiles");
    expect(FORK_BOUNDARIES).not.toHaveProperty("maxTotalDeletedLines");
    expect(FORK_BOUNDARIES).not.toHaveProperty("maxPatchBytes");
    expect(result.failures.some(failure => failure.includes("総追加行数"))).toBe(false);
    expect(result.failures.some(failure => failure.includes("変更file数"))).toBe(false);
    expect(result.failures.some(failure => failure.includes("patch byte数"))).toBe(false);
    expect(result.failures.some(failure => failure.includes("総削除行数"))).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining("単一file追加行数"),
    ]));
  });

  test("fenced memory tableのmutationにcapability markerを要求する", () => {
    const valid = auditWriteFenceSource(`
      env.DB.prepare(\`INSERT INTO entries (id, write_marker) VALUES (?, ?)\`);
      env.DB.prepare(\`UPDATE edges SET weight = ?, write_marker = ? WHERE id = ?\`);
      env.DB.batch([
        env.DB.prepare(\`UPDATE insight_candidates SET write_marker = ? WHERE id = ?\`)
          .bind(memoryWriteMarker(env, "delete"), id),
        env.DB.prepare(\`DELETE FROM insight_candidates WHERE id = ?\`),
      ]);
    `, "valid.ts");
    expect(valid).toMatchObject({ mutations: 4, failures: [] });

    const invalid = auditWriteFenceSource(`
      env.DB.prepare(\`INSERT INTO entries (id) VALUES (?)\`);
      env.DB.prepare(\`UPDATE edges SET weight = ? WHERE id = ?\`);
      env.DB.prepare(\`DELETE FROM vector_cleanup_ops WHERE op_id = ?\`);
    `, "fixture.ts");
    expect(invalid.failures).toEqual([
      expect.stringContaining("INSERT INTO entries"),
      expect.stringContaining("UPDATE edges"),
      expect.stringContaining("DELETE FROM vector_cleanup_ops"),
    ]);
  });

  test.each([
    "entries", '"entries"', "`entries`", "[entries]",
    'main."entries"', '"main" . [entries]', 'MAIN.`ENTRIES`',
  ])("引用識別子やschema修飾でも %s の書込みを見落とさない", table => {
    const sql = [
      `INSERT INTO ${table} (id) VALUES (?)`,
      `UPDATE ${table} SET content = ? WHERE id = ?`,
      `UPDATE OR ABORT ${table} SET content = ? WHERE id = ?`,
      `DELETE FROM ${table};`,
    ];
    // JSON.stringifyが作るJS文字列のescapeも、実ソースと同じ入口で検査する。
    const source = sql.map(statement => `env.DB.prepare(${JSON.stringify(statement)});`).join("\n");
    const result = auditWriteFenceSource(source, "quoted.ts");
    expect(result.mutations).toBe(4);
    expect(result.failures).toHaveLength(4);
    expect(result.failures.every(failure => failure.includes("entries"))).toBe(true);
  });

  test.each(['"projects"', '"edges"', "`insight_candidates`", "[vector_cleanup_ops]"])(
    "%s のquoted markerを認め、deleteの権限準備を要求する", table => {
      const staged = `env.DB.prepare(${JSON.stringify(`UPDATE ${table} SET "write_marker" = ? WHERE id = ?`)})
        .bind(memoryWriteMarker(env, "delete"), id);`;
      const deletion = `env.DB.prepare(${JSON.stringify(`DELETE FROM ${table} WHERE id = ?`)});`;
      expect(auditWriteFenceSource(staged + deletion)).toEqual({ mutations: 2, failures: [] });
      expect(auditWriteFenceSource(deletion).failures).toHaveLength(1);
    },
  );

  test("Projectsの作成と更新もmarkerを必須とする", () => {
    expect(auditWriteFenceSource('db.prepare("INSERT INTO projects (id) VALUES (?)"); db.prepare("UPDATE projects SET name = ? WHERE id = ?");').failures).toHaveLength(2);
  });

  test("4.0履歴の親capabilityは明示し、既存tableのdelete保護には使えない", () => {
    for (const table of ["entry_versions", "entries_trash"]) {
      const deletion = `env.DB.prepare('DELETE FROM ${table} WHERE id = ?');`;
      expect(auditWriteFenceSource(deletion).failures).toHaveLength(1);
      expect(auditWriteFenceSource(`// write-fence: parent-capability=entries\n${deletion}`).failures).toEqual([]);
    }
    for (const table of ["entries", "edges", "projects", "recall_log", "insight_candidates", "vector_cleanup_ops"]) {
      const source = `// write-fence: parent-capability=entries\nenv.DB.prepare('DELETE FROM ${table} WHERE id = ?');`;
      expect(auditWriteFenceSource(source).failures).toHaveLength(1);
    }
    expect(auditWriteFenceSource("// write-fence: parent-capability=entry_versions\nenv.DB.prepare('DELETE FROM entries_trash WHERE id = ?');").failures).toHaveLength(1);
  });

  test("quoted capabilityと既存の非対象table・コメントを区別する", () => {
    const source = [
      `env.DB.prepare('INSERT INTO "entries" (id, "write_marker") VALUES (?, ?)');`,
      `env.DB.prepare('UPDATE main.[edges] SET weight = ?, [write_marker] = ? WHERE id = ?');`,
      `env.DB.prepare('UPDATE "entries_archive" SET content = ?');`,
      `// env.DB.prepare('UPDATE "entries" SET content = ?');`,
    ].join("\n");
    expect(auditWriteFenceSource(source)).toEqual({ mutations: 2, failures: [] });
  });
});
