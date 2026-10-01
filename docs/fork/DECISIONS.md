# 採用した設計と理由

## D1を正本にする

本文と関係をVectorizeの成否から切り離します。CAS、before-image、削除receiptとwrite admissionで並行更新と復元を保護し、VectorizeはD1から再生成します。R2 backupは記憶の復旧用で、通常保存とのdual-writeにはしません。

## 埋込みを固定する

EmbeddingGemmaの出力を128次元へ縮約・正規化する既存profileを維持します。モデル・次元・世代の違うvectorを同じindexへ混ぜません。新規indexは最初の書込み前に`parent_id`と`workspace_id`のmetadata indexを作ります。既存の異なるprofileからの移行には別indexと再索引が必要です。

## 上流の検索を使う

上流のtokenizer、FTS、reranker、Prompt Capsule、project解決を維持します。CJK・全角識別子と埋込み障害時に必要な補正は利用側へ限定し、scopeとLIMIT前の回答適格性を保持します。合成fixtureの改善を、実記憶での品質や課金行数の改善と同一視しません。

## 生成を任意にする

通常構成はWorkers AIです。ChatGPT直接接続は、所有者が本人のプラン利用を許可し、対象処理と個人workspaceを明示した場合だけ選択します。暗号化資格情報、Workerに属するstable host、refreshの競合保護を使います。選択済みproviderの失敗で別providerへ自動的に送らず、保存処理は構造化出力・完了状態を検査します。

## 既存DOへ処理を移す

MCP、回答、REST検索、管理probe、夜間処理を既存McpExecutorへ送ります。入口で認証・本文上限を確認し、内側でもscopeと管理操作の権限を確認します。レスポンスのstreamとwrite admissionを終了まで保持します。移送は無料枠や総CPUの保証ではありません。

## 運用情報と公開ソースを分ける

共通configへ実資産ID・個人workspace・資格情報を入れません。実配備にはGit対象外の設定を明示し、配備version、D1復元地点、バックアップ、実測は所有者の保管場所へ保存します。公開候補は上流の履歴と整理済みのfork差分で構成し、私的な枝・PR・Actions履歴を運びません。

## 上流との依存境界を維持する

上流所有21ファイル、依存定義とlockfile、installerの一致を機械的に検査します。脆弱性監査の検出を隠しません。指摘の利用条件と到達性を確認し、依存を変える修正は上流の修正と同期して検証します。
