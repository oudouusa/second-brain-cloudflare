import { lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// 公開用treeの継続検査。秘密検査と履歴検査の代わりにはしない。
export function publicationProblems(files) {
  const errors = [];
  for (const path of files.keys()) {
    const name = path.split("/").at(-1);
    if (/^(?:\.env|\.dev\.vars)(?:\..*)?$/.test(name)
      && ![".env.example", ".dev.vars.example"].includes(name)) errors.push(`${path}: 秘密設定ファイル`);
    if (/^(?:pending|registration|credentials|private-settings)\.json$/.test(name)
      || /\.cred$/.test(name)) errors.push(`${path}: 資格情報または認証一時ファイル`);
    if (path.startsWith("docs/fork/archive/")) errors.push(`${path}: 個人の運用履歴`);
  }
  let config;
  try { config = JSON.parse(files.get("wrangler.jsonc").replace(/^\s*\/\/.*$/gm, "")); }
  catch { errors.push("wrangler.jsonc: 共通設定を読めません"); return errors; }
  if (config.account_id || (config.d1_databases ?? []).some(row => row.database_id || row.preview_database_id)
    || (config.kv_namespaces ?? []).some(row => row.id || row.preview_id)) errors.push("wrangler.jsonc: 実配備の資産ID");
  const secretNames = [...(config.secrets?.required ?? []), "CHATGPT_CREDENTIAL_KEY"];
  if (secretNames.some(name => Object.hasOwn(config.vars ?? {}, name))) errors.push("wrangler.jsonc: varsに秘密情報");
  if (config.vars?.CHATGPT_OPERATIONS !== "" || config.vars?.CHATGPT_OWNER_WORKSPACE_ID !== "") {
    errors.push("wrangler.jsonc: ChatGPT接続が既定OFFではありません");
  }
  const installer = files.get(".github/workflows/installer-release.yml") ?? "";
  if (!installer.includes("if: ${{ false }}") || /\b(?:tagName|releaseId|releaseDraft):/.test(installer)
    || !/^\s+contents: read$/m.test(installer)) errors.push("installer workflow: 独自配布は未対応です");
  return errors;
}

export function checkPublication(root = process.cwd()) {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Gitの公開対象ファイルを読めません");
  const files = new Map(result.stdout.split("\0").filter(Boolean).map(path => {
    const target = resolve(root, path);
    if (lstatSync(target).isSymbolicLink()) throw new Error(`${path}: 公開対象にsymlinkがあります`);
    return [path, readFileSync(target, "utf8")];
  }));
  const errors = publicationProblems(files);
  if (errors.length) throw new Error(errors.join("\n"));
  return files.size;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(`公開用treeの検査: PASS（${checkPublication()}ファイル）`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
