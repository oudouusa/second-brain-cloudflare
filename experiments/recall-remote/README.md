# 合成記憶による遠隔検索計測

このツールはsynthetic fixtureだけで検索のCPU・D1 metadataを観測します。実記憶の投入と本番の測定は行いません。個人の過去の配備・測定記録は公開ソースへ含めません。

公開版のリモートhostnameは例示です。初期状態ではlocalhostで使い、遠隔測定を行う場合は`protocol.mjs`の2ホスト固定allowlistを自身の専用検証先へ変更してから、安全性の回帰試験を実行します。実行の前に、隔離環境、対象版、予算、credentialの送信先を明示して承認します。

```sh
npx --no-install vitest run test/unit/remote-d1-metrics.test.ts test/unit/remote-measurement-safety.test.ts
```

ローカル時間・SQL文数・合成fixtureの順位は、CloudflareでのCPU、課金行数、実記憶での品質の証拠とは分けます。実測結果には対象版、fixture hash、サンプル数、未完了の条件を記録してください。

## 準備と予算

Use Node 24+ and an empty private output directory:

```sh
node experiments/recall-remote/prepare.mjs /tmp/sb54-fixture
```

The script validates the entire reference schema and synthetic seed in SQLite,
then exclusively creates `seed.sql`, `fixture-manifest.json` and a mode-0600
`private-settings.json`. It does not call any remote service. The SQL includes
token hashes, never bearer tokens. Keep all three files outside Git. Existing
files are not overwritten. The seed is only for newly created, empty staging
databases; it must never be imported into an existing or production database.

There are 24 private workspaces: 200/1,000/10,000 entries × English/Japanese ×
ordinary noise, excluded priority rows, equal-authority overflow, and no answer.
Each database contains 89,600 synthetic entries in total. The workspace corpus
sizes must not be misreported as total database sizes. Each workspace has a
separate member token; returned IDs from another workspace fail the runner.
The recipe mirrors `recall-load`, with workspace-qualified IDs and real tenancy.

The schema retains all write-fence triggers. A temporary seed admission is
removed before the experiment. `/reset` uses production write admission to reset
only a selected synthetic workspace's recall counters between requests; it
requires the temporary owner bearer token and is never a production route.

## Explicitly authorized temporary resources

Before resource creation, record approval, the exact account, baseline/candidate
commits, names, hashes, maximum requests/time and cleanup. For the 2026-09-06 plan:

資源を作る場合は、本番とは別の空の検証環境を用意します。固定Gemma128、metadata index、既存DO migrationと秘密情報の設定は[自己配備手順](../../docs/fork/DEPLOYMENT.md)を参照してください。計測対象のprofile、資源名・ID、Worker versionは各実施者が非公開で記録します。

## Collect and evaluate

Start a private JSON `wrangler tail` capture for each temporary Worker before the
first sample. After importing the identical seed into both new databases:

```sh
node experiments/recall-remote/run.mjs /tmp/sb54-fixture \
  https://sb54-candidate-20260907.staging-example.workers.dev /tmp/candidate.jsonl smoke /tmp/candidate-budget.json
```

The runner only accepts localhost or the two explicit staging Worker names. Use
`smoke` for the first fixture. Full mode has four provider modes, one warm-up and
three measured repetitions per condition: 384 recalls plus 384 resets per arm.
Run at most one call at a time per arm, two arms concurrently. The two-arm budget
is 1,536 calls plus setup/smoke, below 2,000 total and 60 minutes. Stop on errors;
do not silently omit failures, retry them into successes or exceed the budget.

The output manifest records source-tree, adapter/metrics/runner and fixture
hashes. Dirty source and source-tree changes during execution are rejected. Also
pin and record the **running deployment's** bundle/version; a local Git hash
alone does not prove the remote endpoint is running that code. The runner's
summary checks expected recall/empty results but always leaves
`remoteGatePassed=false`. It is not a remote CPU/cost acceptance checker.

For each sample, join the `sb54` and `sb54-d1` records in the public and DO
invocations separately. Header counters are joined by the same sample id. `sb54-d1` records use actual result metadata and include
background statements after the response; check contiguous sequence numbers.
旧ログは参考記録とし、修正版では完了マーカー付きのpublic/DOヘッダーを使用する。 Unknown
metadata stays null. The `first()` adapter uses the same SELECT via `all()` to
obtain metadata. Batches unwrap their original statements and execute once.

Read CPU/wall time, exceptions, outcome, version and sample association from the
Cloudflare invocation records. Missing/duplicate invocations, missing CPU or
truncated statement logs leave the gate incomplete. Local Miniflare timing and
metadata are not Cloudflare billing evidence. Preserve initialization and warm-up
separately; report per-condition p50/p95/max and sample count (three-repeat p95 is
the maximum), not only a mixed global percentile.

Predeclared staging gates, recorded before remote collection:

- All required expected hits/empty results pass; no baseline hit is lost,
  including a hit in a known-limit condition. No foreign-workspace result.
- No HTTP/MCP error, 1102, 5xx or uncaught exception; all required metrics present.
- Warm public Worker p95 CPU ≤10 ms.
- Candidate per-condition DO p95 CPU ≤max(1.25×baseline, baseline+20 ms).
- Candidate end-to-end p95 latency ≤max(1.25×baseline, baseline+200 ms).
- Candidate D1 rows_read ≤max(1.25×baseline, baseline+1,000 rows).

Failure requires diagnosis, not threshold relaxation. Equal-authority overflow
is an explicitly bounded-search limitation: 32 priority slots cannot guarantee
one arbitrary answer among more than 32 otherwise indistinguishable matches.
Report its misses separately; do not claim universal recall or label a lost
baseline hit acceptable. These measurements do not authorize production rollout.

After exporting synthetic evidence, delete both temporary Workers, DO namespaces
and D1 databases, and verify their absence. Do not close #54 merely because a
local command or this runner exits successfully.

Metric semantics: [D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/),
[Worker invocation logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
and [observability query fields](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/).

## 保存済みsmokeの自動監査

HTTP200と検索結果だけでは、今回発見したresetのDO canceledを検知できない。
`audit-smoke.mjs` は1 fixture・4 provider modes・warmupと本試行の計8件を要求し、
明示された配備versionとsample hashでpublic/do/resetログを一意に照合する。
欠落・重複・canceled・例外・truncated・CPU/D1不明値は失敗にする。
生のrequest headersや例外本文をレポートへコピーしない。

```sh
node experiments/recall-remote/audit-smoke.mjs \
  /PRIVATE/samples.jsonl /PRIVATE/tail.jsonl DEPLOYMENT_VERSION /PRIVATE/audit.json
```

成功時の `telemetryPassed=true` は計測経路の健全性だけを示す。
検索品質・baseline比較・全fixture・p95/D1閾値の受入を代替せず、
`remoteGatePassed=false` を維持する。入力ファイルのSHA-256を結果へ記録し、
既存結果ファイルは上書きしない。保存済み証拠の監査はCloudflareへ接続しない。
