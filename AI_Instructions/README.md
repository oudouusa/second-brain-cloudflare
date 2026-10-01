# 指示の責任分担と更新

`../AGENTS.md` はこのリポジトリの開発用。目的・安全境界・検証・完了条件を扱う。
ここにある client instructions は Second Brain 利用時の記憶方針であり、開発ルールではない。
モデル名・段階ごとの固定手順・過去の進捗を常時指示へ積み上げない。

## 記憶方針の正本

`MEMORY_POLICY.md` を編集し、`node scripts/render-ai-instructions.mjs --write` で
4つの `*_INSTRUCTIONS.md` と `.cursor/rules/second-brain-memory.mdc` を更新する。
これらはコピー先から別ファイルを開けなくても機能する自己完結した配布物。
共通部分の手編集は避け、`--check`（引数なしでも同じ）でずれを検出する。
既存Vitestが同じ検査を行うため、workflow・依存・runtime moduleは増やさない。

毎会話・毎提案の一律recallをやめ、不足する過去情報が答えを左右する場合に検索する。
保存は既存の許可範囲内で、確定した決定・約束・再利用できる成果へ絞る。
依頼された未確定案は提案として区別し、現在の訂正や検証済み記録を古い記憶より優先する。
許可済み保存のたびに確認を挟む方式へ戻す変更ではない。

会社への保存・共有には許可が必要で、未指定をサーバーの共有defaultへ任せず、通常は
明示的personalとする。これはclientの判断方針の変更であり、サーバーの認可・default設定は
変更しない。team数は固定せず実際のlist_teamsで判断する。除外・秘密情報・削除指示・
履歴・tier・遅延tool discovery・不確かな書き込みの再送防止も各配布物に含める。

## MCPが配布する説明との整合

clientファイルとは別に、`src/mcp/server.ts` の `recall` / `remember` の説明も条件付き利用へ
揃える。毎会話/3〜4発言ごとの呼び出し、許可を前提にしない自動保存をここに残さない。
ツール名・順序・入力schema・handlerは変更せず、説明2件だけを変更する。
`tools/list` 全体のhashは意図的に更新する。説明2件を除いた全payloadには、変更前から
固定した別hashを検査し、他のツールや引数まで変えていないことを確認する。
この変更で旧tool-prefix cacheの再利用を保証しない。既存のcache判定に任せ、古い証拠を
新しいhashの検証結果へ読み替えない。サーバーから新説明を受け取るには別途配備が必要。

## 既存クライアントへの適用は別の明示操作

PR作成やmainへのmergeだけでは、すでに貼り付けたglobal指示は更新されない。
Cursorがこのcheckoutのruleを読み込む場合は、そのruleの変更が適用され得る。
`alwaysApply: true` は維持するが、本文は条件付き利用であり毎回のMCP呼び出しを要求しない。

**既存 `connect-ai-clients.sh/.ps1` は上流のraw URLから指示を取得する。**
認証登録まで行うこれらのスクリプトを、フォーク方針だけの更新には使わない。
この変更では接続スクリプト・`installer/`・OAuth設定を改造しない。

適用する場合は、承認済みのこのprivate cloneのrevisionを確認し、対象globalファイルを
先にbackupする。既存 `scripts/instruction-block.mjs` を使えばローカル本文だけを更新できる。
以下は手動実行例で、このPRの検証では実ホームを変更していない。

```sh
# リポジトリrootから。既存ファイルは実行前に自分のbackup先へ保存する。
mkdir -p "$HOME/.codex" "$HOME/.claude"
node scripts/instruction-block.mjs "$HOME/.codex/AGENTS.md" < AI_Instructions/CODEX_INSTRUCTIONS.md
node scripts/instruction-block.mjs "$HOME/.claude/CLAUDE.md" < AI_Instructions/CLAUDE_INSTRUCTIONS.md
```

PowerShellでも既存helperにUTF-8本文を渡せる。UTF-8を指定し、適用後の内容を確認する。
ChatGPTには `CHATGPT_INSTRUCTIONS.md` の全文を設定画面へ手動で貼り付ける。
Cursorはglobal ruleかproject ruleのどちらを使うか決め、古い二重指示を残さず、確認した
`.cursor/rules/second-brain-memory.mdc` の全文を配置する。上流URLを案内先に使わない。

marker付きの旧blockは置換され、周囲の個人設定は残る。未マークの旧指示は終端を安全に
識別できないと `appended-legacy-kept` になり、古い指示も残る。その場合は自動削除をせず、
backupと差分を確認して手動整理する。`updated-legacy` でも取り残しがないか確認する。
rootの開発用AGENTS.mdをglobalへコピーしない。権限・除外・認証設定を変更する作業ではない。

## 検証の解釈

テストは共通方針の配布一致、必要な安全境界の記載、古い強制指示の混入、既存helperの
更新互換性を検査する。文章内の語句の検査でLLMの行動を証明したとは扱わない。
検索回数・保存量・品質・token利用量の改善率は未測定であり、文字数削減とは区別する。

採用後に合成会話で確認する例（期待動作。モデル評価は未実行）:

| 場面 | 期待する判断 |
| --- | --- |
| 挨拶、与えた文章の言い換え | 不要なrecallやrememberをしない |
| 続きの作業で以前の決定が不足 | 意図を含めてrecall、結果を再利用 |
| 現在の訂正と古いメモリが矛盾 | 古い記憶を盲信せず訂正と出典を確認 |
| アシスタントが案を提案しただけ | 自動で確定事項として保存しない |
| 保存許可済みのプロジェクトで決定が確定 | 簡潔に保存し、毎回同意を聞かない |
| off the record、対象project除外、credential | 他のwrite経路にも流さない |
| 許可のないcompany保存、複数teamで曖昧 | 個人情報を共有せず必要な範囲を確認 |
| 保存応答が不明、MCPの遅延読み込み | 二重書き込み・架空の成功・無限再試行をしない |

## 合成会話の実行記録を検査する

上の8場面を `experiments/memory-policy/scenarios.json` に固定した。実際に検証する際は、
モデルへ方針とconversationだけを渡し、ツールにはtoolResultsの合成応答を返す。
allowed/required/review等の期待値はモデルの入力に混ぜない。実メモリ・本番MCPを接続しない。

```sh
node experiments/memory-policy/verify.mjs --template > /tmp/memory-policy-trace.json
# 別途採取した実行記録を雛形へ正規化してから検査する。
node experiments/memory-policy/verify.mjs --input /tmp/memory-policy-trace.json
```

空の雛形は合格しない。各recordにid、実際に観測したcalls、finalTextを記録する。
callは `{ "tool": "get", "arguments": { "id": "maple-backup" }, "outcome": "ok" }` の形式。
outcomeはok/error/unknownを区別し、結果不明を成功へ変換しない。ツールの実行試行を
省略せず、拒否された呼び出しも記録する。クライアント固有discoveryの記録は別途保持し、
このmemory-tool用配列へ架空のMCP名として混ぜない。

検査器はNode標準機能だけでファイルを読み、network・model・MCP・設定更新を実行しない。
8場面の欠落・重複、不要な呼び出し、無許可のwrite、personal未指定、二重write、必要な
成功結果の欠落を検出する。必要な成功結果がない場合は場面が完了していないという判定で、
それだけでモデルの不服従やサービス側の原因まで断定しない。方針とシナリオのSHA-256が
一致しない古い記録は拒否し、失敗や未完了は終了コード1にする。

`evidenceKind: synthetic` は検査器の動作確認、`observed` は採取者による申告でmodel名も必須。
ラベルを変えても出典を認証したことにはならず、provenanceVerifiedは常にfalse。
toolChecksPassedは機械的な呼び出し条件だけで、answerQualityEvaluatedも常にfalse。
回答内容・訂正の採用・提案と決定の区別・質問の必要性は、出力されたhumanReviewに沿って
別に確認する。実行記録を作っただけでモデルの行動評価が完了したとは扱わない。
出力は引数や回答本文を再掲載しないが、入力ファイルは引き続き非公開として扱う。
今回は合成fixtureによる検査器テストまでで、実モデルの実行結果・費用削減は未測定。

設計参考（2026-09-05確認。引用ではなく、このfork向けの適用判断）:
- OpenAI Codex best practices: https://developers.openai.com/codex/learn/best-practices
- AGENTS.md guidance: https://developers.openai.com/codex/guides/agents-md
短い開発指示とタスクの完了条件という考え方を採用。新しいSkills群や実行基盤は追加しない。
