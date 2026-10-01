# 既知項目 recall のローカル再現 harness

`queries.json` に指定した既知項目の順位を、D1 snapshot、Vectorize の全ベクトル、KV に保存済みの query signal と設定から再現する。記録モードは現行 `src/` が必要とする signal 入力を採取し、再生モードはその signal を使って `recallEntries()`（`topK=5`、`hops=0`、`synthesize=false`）を実行する。順位に加え、fusion、時間等による rerank、MMR、描画後の ID 順、SQL 文数と bind 数を記録する。試作のランキング変更は含まない。

実行先はローカル SQLite と JSON の Vectorize stub である。FTS を除いた D1 export では LIKE 経路を再現する。実 Vectorize の候補順、FTS 有効時の結果、Cloudflare 上の CPU、待ち時間、D1 課金 `rows_read` は測れない。`d1Statements` は SQLite facade の文数であり、D1 の課金行数や subrequest 数ではない。fixture と出力には私的な記憶、ID、検索語、数値ベクトルが入るため、repo の外の権限を絞ったディレクトリだけに置く。AUTH_TOKEN を harness や外部モデルへ渡さない。

## fixture の作成

`<fixtures-dir>` を repo の外に作る。以下は所有者が自分の環境で行う読み取り手順であり、この harness はリモートへ接続しない。

1. D1 の対象テーブルを列挙し、`wrangler d1 export` の `--table` を対象ごとに指定して `<fixtures-dir>/db.sql` へ書き出す。全 DB export は FTS5 仮想テーブルで失敗する。`entries_fts*`（仮想表と内部表）、`entry_counts`、`schema_meta` は除く。後二者を除く復元上の理由は [DEPLOYMENT.md](../../docs/fork/DEPLOYMENT.md) にある。対象を列挙する SQL は次のとおり。

   ```sql
   SELECT name FROM sqlite_master
   WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
     AND name NOT LIKE 'entries_fts%'
     AND name NOT IN ('entry_counts', 'schema_meta')
   ORDER BY name;
   ```

   ```sh
   npx --yes wrangler@4.126.0 d1 export '<database>' --remote --profile '<profile>' \
     --table '<table-1>' --table '<table-2>' --output '<fixtures-dir>/db.sql'
   ```

   実際は列挙されたすべての対象テーブルを渡す。harness は、export にない `entry_counts` だけをメモリ内の SQLite で `entries` から再構築する。`schema_meta` と FTS は作らない。既存 snapshot に `entry_counts` があれば、その件数と `entries` の件数を照合する。

2. `entries.vector_ids` の JSON 配列を全行から読み、重複を除いた全 ID を Vectorize の `get_by_ids` API で取得する。API の 1 回あたりの上限に合わせて分割し、全 ID を照合してから、`[{"id":"...","values":[...],"metadata":{...}}]` を `<fixtures-dir>/vectors.json` に保存する。欠けた ID を黙って無視しない。metadata の `workspace_id` と `parentId` も保持する。
3. KV の `recall:query-signals:v1:*` を一覧取得して各値を読み、`{"<KV key>": <parsed JSON value>}` を `<fixtures-dir>/query-signal-cache.json` に保存する。`config:overrides` の値も `<fixtures-dir>/config-overrides.json` に保存し、キーが無ければ JSON の `null` とする。秘密の token はどちらにも入れない。
4. `<fixtures-dir>/queries.json` に `[{"category":"<分類>","query":"<検索文>","term":"<対象語>","target":"<entries.id>"}]` を置く。記録モードで `signals-inputs-<run-id>.json` を作る。各 record の `keyMaterial` は本番の `cacheKey()` が HMAC に渡す文字列と同じフィールド順である。
5. **所有者が手元で** AUTH_TOKEN を使い、各 `keyMaterial` の HMAC-SHA256 を計算して、KV 値を `canonicalInput` に対応付けた `signals-by-input.json` を fixture の親ディレクトリに作る。以下は短い Node.js 例で、token は環境変数または systemd-creds の `CREDENTIALS_DIRECTORY/AUTH_TOKEN` から読む。スクリプトも token も repo に置かず、token をコマンド引数、harness、外部モデルへ渡さない。欠けた signal は作らず、再生時に `missing-signal` とする。

   ```js
   import { createHmac } from 'node:crypto';
   import { readFileSync, writeFileSync } from 'node:fs';
   import { join } from 'node:path';

   const [inputsPath, cachePath, outputPath] = process.argv.slice(2);
   if (!inputsPath || !cachePath || !outputPath) throw new Error('input, cache, output paths required');
   const token = process.env.AUTH_TOKEN ?? (process.env.CREDENTIALS_DIRECTORY
     ? readFileSync(join(process.env.CREDENTIALS_DIRECTORY, 'AUTH_TOKEN'), 'utf8').trimEnd()
     : '');
   if (!token) throw new Error('AUTH_TOKEN or systemd credential required');
   const records = JSON.parse(readFileSync(inputsPath, 'utf8')).records;
   const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
   const signals = {};
   for (const record of records) {
     const key = 'recall:query-signals:v1:'
       + createHmac('sha256', token).update(record.keyMaterial).digest('hex');
     const raw = cache[key];
     if (raw === undefined) continue;
     const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
     if (value.version !== 1 || !Array.isArray(value.values) || value.values.length !== 128
       || !Array.isArray(value.queryTags)) throw new Error('Invalid cached signal');
     signals[record.canonicalInput] = { values: value.values, queryTags: value.queryTags };
   }
   writeFileSync(outputPath, JSON.stringify(signals, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
   ```

   計算後はシェルから `AUTH_TOKEN` を外してから harness を実行する。

6. 再生モードを実行する。保存済み signal と現行コードの入力が一致しない場合、推測や再埋め込みはせず `missing-signal` とする。Workers AI と CLIProxy は呼ばれるとエラーになる stub にしている。

`queries.json` の対象語は、読取スコープの `entries` を token と同じ正規化で調べ、文書頻度 `df=1` の語から選ぶ。検索文を本番と同じ形で記録し、`target` はその唯一の行の ID にする。2 文字語、長い語、識別子、複合語を含めると候補生成の違いが見やすい。具体的な語や ID は repo に書かない。

## 実行

```sh
KNOWN_ITEM_FIXTURES='<fixtures-dir>' KNOWN_ITEM_NOW='<ISO-8601-timestamp>' \
KNOWN_ITEM_MODE=record KNOWN_ITEM_RUN_ID='<run-id>' \
npx vitest run --config experiments/known-item-recall/vitest.config.ts \
  experiments/known-item-recall/record-replay.test.ts

KNOWN_ITEM_FIXTURES='<fixtures-dir>' KNOWN_ITEM_NOW='<ISO-8601-timestamp>' \
KNOWN_ITEM_MODE=replay KNOWN_ITEM_RUN_ID='<run-id>' \
npx vitest run --config experiments/known-item-recall/vitest.config.ts \
  experiments/known-item-recall/record-replay.test.ts

npx vitest run --config experiments/known-item-recall/vitest.config.ts \
  experiments/known-item-recall/vectorize-fixture.test.ts
```

`KNOWN_ITEM_NOW` はタイムゾーン付き ISO 8601 時刻で、必須。`KNOWN_ITEM_RUN_ID` は出力名を区別し、出力は `wx` で新規作成するため既存ファイルを上書きしない。記録出力は fixture の親の `signals-inputs-<run-id>.json`、再生出力は `replay-results-<run-id>.json`。再生時は同じ run ID の記録を読む。別名の記録を使う場合は `KNOWN_ITEM_INPUT_RUN_ID=<record-run-id>` を指定する。run ID を省略すると接尾辞なしの名前を使う。

D1 ファイル名は既定で `db.sql`。既存の別名の snapshot には `KNOWN_ITEM_DB_FILE=<filename.sql>` を使う。任意の `KNOWN_ITEM_PLAN_QUERIES=<query-1>,<query-2>` を指定すると、その検索文の候補 SELECT に対する SQLite の `EXPLAIN QUERY PLAN` を `candidatePlans` に記録する。計画取得は recall の `d1Statements` に含めない。カンマを含む検索文はこの指定形式では選べない。

再生出力には `diagnostics`、`trace`（`distill`、`fusion`、`rerank`、`mmr`）、最終 `ids` と `renderedIds`、`d1Statements`、`d1CorpusStatements`、候補 SELECT の `candidateBindings` がある。trace と出力には私的なクエリ・ID が含まれるので repo に入れない。Vectorize stub の単体試験は fixture も環境変数も不要。通常の `vitest.config.ts` は `experiments/**` を除外し、`tsconfig.json` は `src` と `test` を対象にするため、この harness は通常の CI 試験・型検査の対象外である。

過去の試作と測定の履歴は repo 外の調査報告書 `report.md` と、調査 branch `investigate/known-item-ranking-20260925` の commit `b2ea5bd` を参照する。
