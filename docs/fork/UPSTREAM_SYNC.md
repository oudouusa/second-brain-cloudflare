# 上流との同期手順

## 監査先

現在の監査先は未releaseの`upstream/release/4.0.0`、監視先は`upstream/main`です。初期基点は`upstream-base-2026-08-23`で、上流commit `99f1c1a2a005d8f835aef93c786cfe07f54780f3`を指します。上流の正式release後は、取り込みと検証を行ってから監査先を切り替えます。

```sh
git remote add upstream https://github.com/rahilp/second-brain-cloudflare.git
git config remote.upstream.pushurl DISABLED
npm run upstream:audit:boundary
npm run upstream:audit
```

upstream remoteが既にある場合は追加を省略し、URLとpushurlを確認してください。公開cloneでは上記の補助タグも取得してください。GitHub CIはtagsを取得します。

`upstream:audit:boundary`は境界をhard gateにし、新着commitとmerge競合を報告します。`upstream:audit`は未統合commitと競合も失敗にします。定期workflowは週1回で、依存更新や本番配備を自動実行しません。

## 同期の進め方

1. 作業ツリー、PR、配備候補を確認し、独立したブランチを作る。
2. 上流履歴をmergeする。privateの運用記録や資格情報を公開用ブランチへ混ぜない。
3. 上流所有21ファイル、依存・lockfile、installerの一致と、新規moduleのallowlistを検査する。
4. 監査が示す移動元・移動先を照合し、下の契約を保つ。
5. 変更に関係する試験を実行し、最終SHAのWorker CIが成功してからmergeする。
6. 各所有者の配備はGit対象外のconfigを明示し、復元地点と確認結果を別の保管場所へ記録する。

## 移動元と保存契約

| 上流の変更箇所 | forkで照合する部分 |
| --- | --- |
| capture・lifecycle・import・履歴 | admission、CAS、before-image、held、削除receipt、pending index、復元のactor/workspace |
| schema・db初期化 | fork write-protection DDLと適用順、旧schemaからのupgrade、FTS guard、entry count |
| 検索・tokenize・reranker | CJK補正、bind上限、LIMIT前の適格性、query cacheのscope、障害時の救済 |
| 生成のpromptと保存 | ChatGPT操作ごとの範囲、JSON検査、引用、完了状態、非fallback、有限の再試行 |
| routes・MCP・HTTP body | 入口の認証、実byte上限、DO内の再認可、有限応答、stream終端とadmissionの解放 |
| scheduled・insight・digest | cronの5本、巡回のSQL予算、保存上限、保守で予算を使った場合の停止 |
| backup・export・restore | 記憶だけの形式、時系列cursor、scope、復元中のwrite lock、資格情報の除外 |

詳細な移動対応は`scripts/audit-upstream-sync.mjs`の`movedImplementationReviews`にあります。候補の提示は意味的な互換性の証明ではないため、関連する回帰試験と照合します。

## 公開用の境界

公開候補は上流commitを親にして、監査済みのfork差分を載せます。上流の履歴を保持し、private mainや私的な枝を親にしません。公開リポジトリへprivate originをmirror pushしません。

上流への[ChatGPT接続の提案](https://github.com/rahilp/second-brain-cloudflare/issues/384)は、既定OFFの所有者限定dashboard回答を初期範囲にしています。このfork全体や他の生成処理の移植を求める提案とは区別します。
