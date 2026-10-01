# 依存関係のセキュリティ監査

対象はrootのWorker用 `package.json` / `package-lock.json`。installer、OS、外部CLI proxyや
実環境の設定は対象外。上流とdependencyを揃える既存の境界を維持し、監査のために
package/lock、override、runtime、bindingや本番配備を変更しない。

## 実行と証拠

Node 22とnpmがあるcheckoutで実行する。node_modulesのinstallは不要。

```bash
node --test experiments/dependency-audit/*.test.mjs
node scripts/audit-dependencies.mjs --output /tmp/second-brain-dependency-audit
```

既定の終了コードは、完全な報告で検出0件なら0、検出ありなら1、監査未完了なら2。
`--report-only` は検出ありの終了コードだけを0にする。通信失敗、タイムアウト、未対応のJSON、
件数不整合、依存ファイルの変更は2のまま。`clean` はその時点のnpm監査で検出0件という意味で、
未知の脆弱性がないことや本番で安全に実行できることの証明ではない。

全依存と `--omit=dev` の本番依存を、固定のnpm registryへ順番に問い合わせる。
監査対象を変える旧npm設定 `production`・`also`・`dev` も呼出ごとにCLIで固定する。
環境変数やプロジェクト・利用者・グローバルの `.npmrc` に `production=false` 等があっても、
本番側に開発依存を混ぜず、全依存側は開発依存を含める。optional・peerは両側に含める。
既存のnpm設定ファイルや通信・認証設定は書き換えない。
`--package-lock-only --ignore-scripts` を指定し、install/fix/forceは一切実行しない。
各呼出は60秒・出力2 MiBで制限し、registry要求の再試行はしない。
registryへは通常のnpm auditと同じく依存名・バージョン情報が送られる。
前後のpackage/lockのSHA-256を比較し、変化を検出しても勝手に元へ書き戻さない。

出力は `audit.json` と `audit.md`。取得時刻、両依存ファイルのSHA-256、全依存/本番依存の
重大度別件数、パッケージ名、実際のlockfile内バージョン・path、直接/間接依存、advisoryと
npmが報告した修正候補を保持する。npmのstderrや例外本文は認証情報を含み得るため出力しない。
JSONをログへ出す際は単一行とし、Markdown中のadvisory文字列もエスケープする。

## 読み方と対処

件数は **影響するパッケージのグループ数** であり、独立したadvisory数ではない。
同じadvisoryが間接依存の複数グループに現れることがある。
`production-graph` は本番依存の監査に含まれたlockfile pathを示す。パッケージ名だけで判定せず、
同名パッケージの開発用コピーは `full-graph-only` と分ける。これはWorkerのbundleに実際に
含まれること、脆弱な関数に到達できること、攻撃可能な入力が存在することの証明ではない。
逆に `full-graph-only` も「無視してよい」の意味ではない。CIや開発端末の処理も確認する。

対応時は、advisoryの条件と利用箇所、固定済みバージョンを確認し、上流での修正状況と照合する。
上流と同じ依存へ同期できる更新を優先する。`fixAvailable` はnpmの提案であり、更新が本番で
互換性を持つ保証ではない。とくにmajor更新や `npm audit fix --force` を自動採用しない。
個別の保留理由・確認日・上流の追跡先は該当PR/Issueへ記録し、未確認を安全性の認定にしない。

## 公開候補での評価（2026-10-02）

上流4.0.0取り込み先`d550921a8c0ae25f6788ead3d8209f29fc4df6d6`と同じlockfileを維持しています。
この時点のnpm監査は、全依存でhigh 4・moderate 6、本番依存でmoderate 4を検出しました。
未解決の指摘があり、依存全体を`clean`と評価しません。

| 指摘のある依存 | 実行範囲と確認結果 | 当面の対処 |
|---|---|---|
| fast-uri 3.1.7、hono 4.13.0、ip-address 10.4.0、qs 6.15.2 | lockfileの本番依存。ただしWrangler 4.146.0のdry-runで生成したWorkerのmetafileには、これらの入力ファイルは0件 | 本番bundleへの混入と上流の更新を追跡する。Node用SDK等へ利用範囲を広げる前に再評価する |
| undici 7.29.0、sharp 0.35.2、miniflare 4.20260722.0、wrangler 4.114.0 | 上流lockfileに残る開発用CLIの依存。Worker bundleには含まれない | 配備・起動・開発用のCLIは固定した`npx --yes wrangler@4.146.0`を使用する。古い裸の`wrangler`や`npx --no-install wrangler`を使わない |
| vitest 4.1.10、@vitest/mocker 4.1.10 | ローカル・CIの試験用。Worker bundleには含まれない。対象advisoryはbrowser modeのredirect mockによるファイル読取 | 現在の試験設定でbrowser modeを使わない。公開ネットワークへ試験サーバーを開かず、未確認コードを実資格情報のある端末で動かさない。上流と同じ修正版への更新を追跡する |

新しいWranglerはrootのlockfileとは別のnpm実行領域に取得します。この4.146.0の依存領域も
同じ監査スクリプトで確認し、全依存・本番依存とも検出0件でした。rootに残る指摘を
新しいCLIの結果で消し込むことはしません。rootのVitest・Miniflareによる試験は引き続き
上流lockfileを使うため、開発環境の残存リスクとして扱います。

bundlingの確認は次で再現できます。出力はGitへ追加せず、対象SHAと生成時刻を運用者が記録します。

```sh
npx --yes wrangler@4.146.0 deploy --dry-run --metafile /tmp/second-brain-worker-metafile.json
python3 - <<'PY_BUNDLE'
import json
inputs = json.load(open('/tmp/second-brain-worker-metafile.json'))['inputs']
for name in ['fast-uri', 'hono', 'ip-address', 'qs', 'undici', 'sharp', 'miniflare', 'wrangler', 'vitest', '@vitest/mocker']:
    matches = [path for path in inputs if '/node_modules/' + name + '/' in '/' + path.replace('\\', '/')]
    print(name, len(matches))
PY_BUNDLE
```

根拠となるadvisoryはnpm監査出力に全件保持します。代表的な一次情報は
[fast-uri](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj)、
[Hono](https://github.com/advisories/GHSA-g6gw-c38x-mqfc)、
[ip-address](https://github.com/advisories/GHSA-j6r3-76f7-8jcv)、
[qs](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g)、
[sharp](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)、
[Undici](https://github.com/advisories/GHSA-w293-vg96-wgc3)、
[Vitest](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)です。
この評価は現在のbundle・試験設定に限定します。依存・import・設定を変えた場合や
新しいadvisoryが出た場合は再評価し、上流の修正に合わせてlockfileごと更新します。

## CIでの扱い

既存Worker CIの必須 `worker` に外部通信なしの監査回帰試験を追加する。
既存のfork境界、型、scope、coverage、benchmark、build/startupのgateは維持する。
別job `Dependency audit (report only)` が実registryを読み、Job SummaryとJSONログへ保存する。
このjobは `contents: read` のみで、checkoutの資格情報を保持しない。新しいcronは追加しない。

既存の脆弱性を件数だけで一括更新・例外登録しないため、導入時は検出ありをreport-onlyにする。
**このjobが緑でも `status: findings` は未解決である。** 監査サービス等の障害は赤になり、
既存worker jobの実行は妨げない。branch保護やrequired checksをこの変更から操作しない。
毎回の結果は動的なregistryに依存するため、過去CIの件数を新しいSHAの証拠として使わない。

npm audit仕様: https://docs.npmjs.com/cli/v10/commands/npm-audit/
