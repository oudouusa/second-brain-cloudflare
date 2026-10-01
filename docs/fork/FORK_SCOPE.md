# フォークの所有権と境界

このソースは[rahilp/second-brain-cloudflare](https://github.com/rahilp/second-brain-cloudflare)の履歴を維持した自己配備用フォークです。個人の配備記録や資格情報を公開履歴へ含めません。

## 上流の基点

- 初期基点：`99f1c1a2a005d8f835aef93c786cfe07f54780f3`。
- 初期基点の補助タグ：`upstream-base-2026-08-23`。公開候補にもこの上流commitを指すタグを含めます。
- 現在の監査先：`upstream/release/4.0.0`。現在の取り込みは`d550921a8c0ae25f6788ead3d8209f29fc4df6d6`。
- 監視先：`upstream/main`。上流の正式release後に監査先を更新します。

## 保持する契約

D1は記憶の正本、Vectorizeは派生索引です。固定EmbeddingGemma 128次元、write admission、CAS、before-image履歴、保留行の隔離、削除receipt、workspaceの分離、MCPと夜間処理のCPU境界を保持します。

新しいagent frameworkや検索engineへ置き換えません。上流の有効な実装へ委譲し、forkの安全要件と上流の共通処理を分けます。具体的なmoduleとbindingは[ARCHITECTURE.md](ARCHITECTURE.md)を参照してください。

## 上流に委ねる部分

`scripts/audit-upstream-sync.mjs`の`UPSTREAM_OWNED_PATHS`にある21ファイルは、監査先の上流とbyte単位で一致させます。tokenizer、Prompt Capsule、FTS保守、reranker、projectの解決などを独自に書き換えません。

`installer/`、`package-lock.json`、dependencies、devDependencies、overrides、install lifecycle scriptsも上流と一致させます。公開準備のためにこの監査を弱めません。依存の指摘は[DEPENDENCY_SECURITY.md](DEPENDENCY_SECURITY.md)の手順で確認し、上流と揃った修正を優先します。

## forkが持つ部分

- 固定Gemma128のprofileとVectorize世代、埋込み枯渇時の有限な縮退・再索引。
- CJK・全角識別子の検索補正。通常の上流検索経路を使い、必要な互換経路だけを追加する。
- R2の記憶backup/restore、論理tier、更新履歴と書込み保護。
- Cloudflare Accessと所有者管理操作の認証、MCP/REST/夜間処理の既存DOへの移送。
- 任意のChatGPT Responses接続と、所有者個人のworkspaceへの限定。
- 日本語の週次洞察、原文引用と保存JSONの検証、有限再試行。

ChatGPTは既定OFFです。所有者が有効化した場合も、Team・member・別admin・混在・範囲不明に所有者のプランを使わせません。失敗した選択済み処理からWorkers AIへ自動fallbackしません。VPS、CLIProxy、VPC service bindingは使用しません。

CPUをDOへ移すことは、総CPU、待ち時間、料金の削減を保証するものではありません。既存DOのclass/bindingを維持し、常設購読や別の状態DBを増やしません。

## 更新時の検証

[UPSTREAM_SYNC.md](UPSTREAM_SYNC.md)の境界監査を先に実行します。上流が変更した移動元について、監査が示す移動先と関連テストを照合します。CIは型、scope、coverage、CPU予算、夜間SQL、benchmark、build/startupを維持します。

運用するWorkerへの配備、記憶の更新、GitHubでの公開はそれぞれ対象と権限を明示して実施します。ソースのmergeだけで全利用者へ自動配備される仕組みは設けません。
