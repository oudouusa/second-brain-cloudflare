# 夜間処理の隔離診断

PR #80 の残る性能受入に向けたローカル診断。実際の `Worker.scheduled()`、
SQLite、write fence、CLIProxy adapterを使い、provider応答とKVを模擬する。
productionの入口・処理・SQLを複製しない。Cloudflareへの通信は行わない。

## 実行

Node 24と既存lockfileの依存を使用する。出力先は新しい空ディレクトリとし、Gitへ追加しない。

```sh
NIGHTLY_PROBE_OUTPUT=/tmp/nightly-candidate \
  npx --no-install vitest run --config experiments/nightly-perf/vitest.config.ts
```

基準mainと候補を別worktreeで実行し、同じprobe、config、`test/helpers/sqlite-d1.ts`、
`test/helpers/make-env.ts`、`vitest.setup.ts`を使う。特に基準mainの旧SQLite補助実装は
`meta.changes`を返さず不要なCAS再試行を作るため、候補の修正済み補助実装を両方で使う。
これは試験adapterの統一であり、基準側のproductionコードを変更する操作ではない。
`src/`、schema、wrangler、packageに未commit差分があればprobeは拒否する。
同じUTC日に実行し、両armの固定時刻・fixture・adapterのhashを必ず照合する。

```sh
node experiments/nightly-perf/summarize.mjs \
  /tmp/nightly-baseline /tmp/nightly-candidate \
  BASELINE_FULL_SHA CANDIDATE_FULL_SHA /tmp/nightly-comparison.json
```

6条件の欠落、SHA/adapter/schema/fixture違い、記憶欠落、対象外workspace変更、
SQL失敗、計数不一致を拒否する。成功しても `remoteAcceptancePassed=false` を維持する。
probeは通常のVitest/coverage対象から除外されたexperimentで、Worker CIの独立stepでも
このコマンドを実行する。基準との比較は両armの証拠を揃えて別に検査する。

## fixtureと計数

- workspace当たり200/1,000/10,000件、それぞれ1または2 workspace。
  2 workspaceの最大DBは**合計20,000件**。各workspaceで77件が有効、残りは処理対象外の合成ノイズ。
- 基準は圧縮とgraph/stalenessの2 invocation、候補は1 invocation。
  SQLのbatch内各文を計数する。EXPLAINは診断用として別に実行し、計数へ加えない。
- 原文・ID・workspaceのhashを確認する。上流仕様のdigest参照追記は、今回生成した
  実在digestへの末尾参照だけを除去して原文保持を判定する。
- 別workspaceはタグ等も含め全行の不変を確認する。
- 生SQL・束縛値は合成データに限定。出力はmode 0600で新規作成する。

SQL数が一定でも走査行数一定とは言えない。EXPLAINのSCANには小さい管理表や
VALUESも含まれるため、全てを問題扱いしない。実CPU、D1課金rows、KV費用、
p95遅延、実モデル品質をこの診断で測ったとは扱わない。
低コスト側では一晩の処理件数も小さい。両armのSQL数から性能改善率を計算しない。

過去の実測結果は運用者の非公開領域に保全します。遠隔測定を行う場合は、隔離した試験用資源、
合成データ、実行予算、資格情報の送信先を事前に確認し、本番の記憶へ接続しません。

## 隔離した遠隔診断

`prepare-remote.mjs 出力ディレクトリ` は新しい空ディレクトリに200件の合成fixture、
schema、hash、試験用秘密値を作り、ローカルSQLiteで投入を検査する。出力はGitへ追加しない。
`remote-worker.ts` を両production版で同一にbundleし、一時D1を別々に接続する。
認証済みの `/run` は実scheduled入口を実行し、`/reset` は試験専用表を確認してから
write admissionを通してfixtureを復元する。通常のwrangler設定からは参照しない。

D1の各result metadataを認証済みレスポンスへ返し、全背景処理の終了を待つ。
既存のログ秘匿は維持し、許可済みの `http_request.operation` と試料IDで
Cloudflare TailのCPUに対応づける。SQL本文や認証秘密はログへ出さない。
生成・Vectorize・KVは模擬、HTTP経由の計測adapterを含むCPUであり、実モデル品質や
通常のcron発火経路を測ったことにはならない。

測定前にsource/bundle/adapter/fixture hash、回数、費用上限、合否条件を私有manifestへ
固定する。配備コード・binding・versionを読み戻し、欠測や失敗を0へ置換しない。
初期化・reset・readbackも予算に含め、証拠保存後は作った一時資源だけを撤去する。

夜間DO候補の試験では同一adapterの `NightlyProbeExecutor` subclassを専用bindingへ
接続する。実productionの `runNightly` を呼び、終了後のD1メタデータを一度だけRPCで
回収する。保持は直近1試料だけのメモリ内で、productionにはこの収集methodを追加しない。
公開WorkerとDOのCPUを別々のTailイベントで照合し、公開側のD1実行0も検査する。
初回・継続の値、診断を継続できる条件、実行先別の合格条件を測定前に固定する。
