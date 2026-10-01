# Workers observability

## 方針

`wrangler.jsonc` でWorkers Logsを有効にし、Workerが明示的に出す構造化JSONだけを保存する。自動invocation logsは完全なrequest URLへrecall queryが含まれ得るため無効にする。traceもv1では有効化しない。

保存するeventは次のとおり。

| event | fields |
|---|---|
| `http_request` | 固定分類したoperation、method、status、outcome、duration_ms、失敗時のerror_name |
| `recall_complete` | outcome、duration_ms、返却candidate_count、fallback_used、graph_hops／seed／expanded／eligible／selectedの件数、失敗時のerror_name |
| `scheduled_job` | 固定job名、outcome、duration_ms、失敗時のerror_name |
| `internal_log` | `severity`のみ。既存・依存コードの任意console出力を内容なしで縮退したことを示す |

query string、request/response body、memory本文、tag、token、Authorization header、動的entry ID、backup IDは記録しない。例外はmessageやstackではなくerror class名だけを記録する。

Worker module初期化時にconsole境界を一度installする。上表のallowlistどおりの単一JSON文字列だけをそのまま出力し、それ以外の文字列、object、Error、複数引数は内容を破棄して`internal_log`へ置き換える。top-level fetch例外は`error_name`だけを記録して、本文を含まないHTTP 500へ変換するため、uncaught exceptionのmessage/stackをWorkers Logsへ渡さない。未完了restore中のscheduled jobは実処理を開始せず、`outcome=blocked`として記録する。

## 確認

Real-time Logs（`wrangler tail`を含む）は`invocation_logs = false`とは別経路で、Workerが出すevent以外にrequest URLやheaderを表示し得る。したがって、認証付きsmoke、OAuth callback、query/bodyを伴うprivate APIの実行中はraw tailを開始しない。tail出力をファイルへ保存しない。

tailを使う場合は、Authorization、Cookie、query、bodyを一切持たない合成requestだけを対象にし、先にDashboardのフィルターでそのrequestへ限定する。Cloudflare dashboardでは Workers & Pages → `second-brain-cf` → Observability → Logs から、保存済みのallowlist eventを確認する。検索内容、本文、credential、完全なprivate URLが表示された場合は安全違反としてdeployを止める。
