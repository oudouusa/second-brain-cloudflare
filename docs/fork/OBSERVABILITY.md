# Workers observability

## Policy

Enable Workers Logs in `wrangler.jsonc` and store only explicitly emitted structured JSON. Disable automatic invocation logs because full request URLs can contain recall queries. Traces are not enabled in v1.

The following events are retained:

| Event | Fields |
| --- | --- |
| `http_request` | Fixed operation category, method, status, outcome, duration_ms, error_name on failure |
| `recall_complete` | Outcome, duration_ms, returned candidate_count, fallback_used, graph_hops/seed/expanded/eligible/selected counts, error_name on failure |
| `scheduled_job` | Fixed job name, outcome, duration_ms, error_name on failure |
| `internal_log` | `severity` only; indicates that arbitrary console output from existing or dependency code was reduced without preserving content |

Do not record query strings, request/response bodies, memory content, tags, tokens, Authorization headers, dynamic entry IDs, or backup IDs. Record only the exception class name, not its message or stack.

Install the console boundary once during Worker module initialization. Only a single JSON string matching the allowlist above passes through. Other strings, objects, Errors, and multiple arguments have their content discarded and are replaced with `internal_log`. Top-level fetch exceptions record only `error_name` and become an HTTP 500 without content, keeping uncaught exception messages and stacks out of Workers Logs. Scheduled work during an incomplete restore does not start; it records `outcome=blocked`.

## Verification

Real-time Logs, including `wrangler tail`, use a separate path from `invocation_logs = false` and may expose request URLs and headers in addition to Worker events. Do not start raw tail during authenticated smoke tests, OAuth callbacks, or private API calls with queries or bodies. Do not save tail output to files.

When using tail, restrict it to synthetic requests with no Authorization, Cookie, query, or body, and first filter to those requests in the Dashboard. In the Cloudflare dashboard, inspect saved allowlisted events under Workers & Pages → `second-brain-cf` → Observability → Logs. If search content, memory text, credentials, or complete private URLs appear, stop deployment and treat it as a safety failure.
