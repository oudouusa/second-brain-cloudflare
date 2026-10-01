# Manual memory tiers

- `warm`: 新規memoryの既定値。
- `hot`: 明示的にHot contextへ含める。
- `cold`: D1とVectorizeに残したまま整理する。通常recallから除外しない。
- `pinned=1`: tierに関係なくHot contextへ含める。

操作はすべて手動かつ可逆で、tier/pin変更だけでは再埋め込みしない。Hot contextは `pinned=1 OR memory_tier='hot'` を重要度、更新時刻の順に並べ、廃止済みmemoryを除外し、12,000文字以内に制限する。通常recallで返したmemoryには `last_recalled_at` を記録する。

AI clientは会話冒頭のintent-framed `recall`を先に実行し、継続中projectやcurrent goal / priority / operating constraintを扱う時だけ、その後に`get_hot_context`を1回呼ぶ。Hot contextはtopic-specific recallを置き換えない。pinはuser-confirmedなactive goalまたはoperating constraintの小さな集合に限定し、同一projectの細切れsummaryより統合したcurrent-state entryを優先する。完了・失効時はunpinしてwarm/coldへ戻す。

RESTは `POST /memory/tier`、`POST /memory/pin`、`GET /hot-context`、MCPは `set_memory_tier`、`pin_memory`、`unpin_memory`、`get_hot_context` を使用する。

## 現在状態と履歴の保存粒度

固定記憶には確認日と現行状態を記載し、PRのOPEN→MERGEDなど状態が置き換わった場合は
`update`で旧版をhistoryへ保持する。可変な状態と恒久的な権限制約を混同せず、過去の承認を
別作業の許可へ拡張しない。古い記憶の日付だけを今日へ書き換えない。

重要な決定・制約・成果はユーザーの保存方針と除外条件に従って残す。同じ案件の新しい事実は
既知IDへappendし、訂正や現行状態の置換はupdate、独立した検索対象はrememberする。
本文は決定・根拠・確認日時・継続条件と原本への参照を中心にまとめる。
長いテスト一覧や変更なし確認を繰り返し新規記憶へ積み上げない。

appendの8,000字でのrollover推奨／10,000字での継続前rollover要求に従い、原文をcoldに保持し、根拠日付を明記した
短い継続記憶へ移る。古い検証結果しかない場合はその限界を本文にも残し、今日の本番状態と
扱わない。既存のcold履歴を文字数だけで再整理しない。duplicate-candidateはレビュー候補であり、
削除根拠ではない。これらの運用説明はクライアント全体の指示を自動変更しない。

## 要約の話題

`personal`・`work`・`task`・`idea`・`context`・`codex-response`は汎用分類タグとして保存・検索に
引き続き使えるが、夜間digest・直接digestの対象や管理画面の要約候補には使わない。
案件横断の分類を一つの話題として要約すると、無関係な原記憶までrolled-upとなるためである。
検索のタグ推定・補助検索と通常のタグ表示は変更しない。案件名などの具体的なタグは従来どおり使う。大文字小文字を無視した完全一致で除外し、
`work-notes`や`context-menu`等の別のタグまで除外しない。
既存digestと元記憶には自動的な変更を加えず、必要な箇所だけ根拠を確認して整理する。
