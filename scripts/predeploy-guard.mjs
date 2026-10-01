#!/usr/bin/env node
/**
 * npmのpredeployで、実配備設定がある端末からのbare deployを止める。
 * 共通configは資産IDなし・ChatGPT既定OFFの新規導入用の見本。
 * 実配備へはGit対象外のwrangler.<env>.jsoncを明示する。
 * 明示的な例外: ALLOW_BARE_DEPLOY=1 npm run deploy
 */

import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.ALLOW_BARE_DEPLOY === "1") process.exit(0);

// wrangler.jsonc is the shared config and does NOT match: the pattern requires
// a middle segment, as in wrangler.personal.jsonc.
const overrides = readdirSync(ROOT).filter((f) => /^wrangler\.[A-Za-z0-9_-]+\.jsonc$/.test(f));

if (overrides.length === 0) process.exit(0);

const list = overrides.map((f) => `    ${f}`).join("\n");

console.error(`
環境別の配備設定があるため、共通configでの配備を停止しました。

見つかった設定:
${list}

共通wrangler.jsoncは新規導入用で、実配備の資産IDや所有者設定を持ちません。
対象の設定とCloudflare profileを指定してください:

  npx --yes wrangler@4.146.0 deploy --config wrangler.personal.jsonc --profile YOUR_PROFILE

更新前にWorker versionとD1の復元地点を記録してください。
明示的に共通設定を使う場合だけ ALLOW_BARE_DEPLOY=1 npm run deploy を実行します。
`);

process.exit(1);
