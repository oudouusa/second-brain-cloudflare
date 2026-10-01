# Prompt Capsule consumer contract: fork pilot

Status: implemented in the fork; provider behavior and performance are not yet
qualified by live requests. Sources were reviewed on 2026-09-13.

## Problem and intended behavior

An authenticated, deterministic Capsule is useful background, but it does not
define which facts a task needs, authorize actions, or specify how a client
should update an ongoing conversation. Replacing an earlier Capsule message can
also invalidate the prefix and the provider's preserved reasoning state.

This pilot adds an in-memory consumer to the existing gateway experiment. It
validates the initial snapshots, preserves the conversation, and appends changed
snapshots without editing earlier messages. The Worker continues to emit exactly
the upstream `prompt-capsule.v1` representation.

**Model-independent behavior is a requirement.** Model identifiers are opaque
strings. They do not select prompts, memory slots, retrieval rules, budgets,
reasoning effort, or lifecycle behavior. The same short background-data policy
is used for every model. The caller explicitly selects `responses` or `messages`
to encode the corresponding API format; this is not inferred from a model name.
Unspecified reasoning effort is omitted. Explicit settings are passed through;
the caller remains responsible for their support on its actual endpoint.

This preserves the producer/consumer separation accepted in
[upstream issue #329](https://github.com/rahilp/second-brain-cloudflare/issues/329)
and [merged PR #330](https://github.com/rahilp/second-brain-cloudflare/pull/330).

## Implemented contract

| Concern | Behavior |
| --- | --- |
| Source integrity | Recheck the validated source's exact text hash, character count, kind, schema, slot order, uniqueness, and nonempty content. No reserialization or slot reordering. |
| Completeness | Require a complete, populated Capsule. `requiredSlots` is an additional consumer requirement; `complete: true` does not imply all possible slots exist. |
| Meaning and authority | Capsule JSON is background data. Application instructions remain separate. Current user corrections supersede conflicting remembered facts. Memory does not authorize actions. |
| Initial placement | Fixed application policy, then a user message containing the exact Core and optional Project text blocks, then the current task. Explicit cache markers end the initial Capsule blocks. |
| Updates | Compare prompt hashes and append only changed snapshots. An unchanged hash, including metadata-only refreshes, adds no message. |
| Continuation | Preserve all Responses output items, or the complete Messages assistant content array, including opaque reasoning/signatures and tool calls. Tool results precede a simultaneous background update. |
| Configuration | Model, API encoding, tools, policy, effort and cache settings are fixed for one session. Returned request objects are defensive copies. |
| Scope | Bind one session to a host-supplied `scopeKey`. A changed key closes and clears the session, including pending work. |
| Removal | Removing a Capsule or a previously present slot requires a new session. A failed source update closes the session instead of reusing known-invalid context. |
| Resource bounds | Keep the upstream 12,000-character per-Capsule ceiling. A configurable serialized-request byte limit rejects whole requests. Optional token admission requires an explicit counting function. Nothing is truncated or padded. |
| Transport failure | One turn may be in flight. `retryRequest()` returns the exact pending request; it does not append another user turn or call a provider. |
| Evidence | `descriptor()` returns state and hashes, excluding raw memory, prompts, signatures and the scope key. |

The byte limit is not a tokenizer estimate. For `maxInputTokens`, supply a
synchronous counter appropriate to the actual request format and model, including
tools and history. Without a counter, the pilot makes no token-budget claim.

The source validator now follows the current upstream completeness calculation:
an empty projection, omitted slots, invalid entries, or duplicate slots make it
incomplete. Older response files may omit the newer diagnostic fields. The
legacy `allowIncomplete` source option still exists, but this session consumer
requires complete inputs even when the transport was allowed to read a partial
response. See the pinned [upstream payload builder][upstream-builder].

## Run the fork example

Node 22 or later, using the repository's installed dependencies:

```bash
node experiments/prompt-cache/session-example.mjs --api responses
node experiments/prompt-cache/session-example.mjs --api messages
```

Each command executes two synthetic turns, appends a Project update, checks the
unchanged prefix, and prints sanitized JSON. `external_requests: 0` and
`cache_hit_measured: false` are deliberate. The example does not require an API
key, contact a Worker, register OAuth clients, or change stored memories.

`--model ID` only changes the request's model field. The tests also use unfamiliar
model names to verify that no behavior is selected by identifier. A structurally
valid request is not a claim that a provider offers that model on that API.

## Integrate with the existing authenticated source

The session accepts the validated `{ core, project }` returned by
`fetchPromptCapsulesViaMcp`. Keep the existing host-local Managed OAuth credential
and provide the actual authenticated scope from the surrounding application.
Neither the Capsule hash nor an HTTP ETag is an authorization credential.

```js
import { fetchPromptCapsulesViaMcp } from "./mcp-capsule-source.mjs";
import { createCapsuleSession } from "./capsule-session.mjs";

// sourceOptions pins workerUrl, credentialFile, workspace, team and projectId.
// scopeKey identifies that target AND the authenticated caller/credential epoch.
// api, model and sendRequest come from the host's explicit transport configuration.
const initial = await fetchPromptCapsulesViaMcp(sourceOptions);
const session = createCapsuleSession({
  api, model, scopeKey, ...initial,
  requiredSlots: { core: ["constraints"] }, // This application's requirement.
  maxRequestBytes: 128 * 1024,
  maxOutputTokens: 4096,
});

async function runUserTurn(userText, currentScopeKey) {
  if (currentScopeKey !== scopeKey) {
    session.close();
    throw new Error("scope_changed");
  }
  let refreshed;
  try {
    refreshed = await fetchPromptCapsulesViaMcp(sourceOptions);
  } catch (error) {
    session.close(); // Do not continue on cached authorization or stale context.
    throw error;
  }
  const request = session.beginTurn({
    scopeKey: currentScopeKey, userText, ...refreshed,
  });
  const response = await sendRequest(request);
  session.completeTurn(response);
  return response; // Normal application output, not sanitized evidence.
}
```

The host serializes calls, checks authorization, selects the endpoint, sends
requests, and handles errors. No new HTTP proxy, agent loop, provider SDK,
background refresh timer, or Durable Object is introduced. Native function-tool
results can be supplied as `beginTurn({ scopeKey, input: [...] })`; the caller
provides the API's user/tool-result items rather than modifying saved history.

On a transport error, retry only when the host judges it appropriate, using
`retryRequest()` and the same pending turn. On sign-out, principal/workspace
change, access revocation, explicit memory deletion, or privacy-driven removal,
close the session and discard previously returned request copies as well. A
changed slot's text alone cannot reveal whether a change was a privacy deletion.
The host must propagate that event. Closing this local object cannot erase
content already sent to a provider.

Append-only updates grow history. When the budget is reached, prepare a fresh
conversation or use the host's supported compaction flow. Do not splice old
Capsule blocks out while retaining reasoning bound to the old conversation.
Compaction is outside this pilot; there is no silent truncation fallback.

## Existing experiment compatibility

`ab.mjs` and `dev-effect.mjs` no longer force `reasoning.effort: none`. Both expose
`--effort` and `--max-output-tokens`; their common output ceiling defaults to 4096.
No model lookup changes these values. To reproduce an older run, explicitly
supply its original settings where the chosen endpoint supports them. The old
A/B default was `none` with 32 output tokens; the development-decision default
was `none` with 300 output tokens. Existing recorded evidence is preserved.

Changing these settings changes the experiment conditions. Do not compare new
quality, latency or cache results to the September 3 Luna measurements as if the
requests were identical. No historical result qualifies another model or a new
transport. The legacy A/B builder remains available for its existing experiment;
the background-data placement and append-only behavior described here belong to
the new session consumer.

## Design decisions for a future upstream PR

1. **Keep producer bytes stable.** Current Project order is `current-state`,
   `decisions`, `open-questions`. Changing the first slot can shorten the reusable
   prefix. The pilot retains [the upstream slot contract][upstream-types] and
   [serializer][upstream-serialize]. A future ordering change needs evidence and
   an explicit compatibility decision.
2. **Select useful context.** Keep durable preferences and decisions concise;
   use existing recall/hot-context tools for relevant changing facts. Repository
   procedures belong in their maintained AGENTS.md/skills. This is an authoring
   recommendation, not automatic memory migration or a change to client-global
   instructions. [Codex guidance][codex-practices] and [Astra guidance][astra-blog]
   support reviewing oversized, overlapping instructions.
3. **Apply one lifecycle contract.** History preservation is useful across
   providers and is required for compatible preserved reasoning. The
   [OpenAI reasoning guide][openai-reasoning] and [Anthropic thinking guide][claude-thinking]
   motivate the common append-only policy. Neither causes a model-name branch.
4. **Expose configuration instead of choosing a model profile.** Official
   [Astra][astra-model] and [Fable][fable-prompting] documents demonstrate that
   accepted settings and defaults vary. This consumer leaves the choice to the
   caller, without silently substituting a different effort or model.
5. **Keep cache claims separate.** [OpenAI][openai-cache] and
   [Anthropic][claude-cache] define different wire controls and minimum lengths.
   Only encoding differs here. Actual cache eligibility, counters, latency and
   billing require measurement on the intended route, including any proxy.

The upstream candidate is the provider-neutral consumer contract, its rationale,
and reproducible examples. The fork's API request assembler can remain in the
gateway experiment unless upstream wants client-side code. This change adds no
Worker source delta, schema, dependencies, bindings, cron jobs, memory writes,
or automatic model-specific prompting.

## Validation and remaining evidence

2026-09-13のローカル実行では、prompt-cacheの110件の試験と二つの合成例が通りました。
実装ファイルのhash、初回のfixture・環境の失敗、その後の成功を記録した証拠は、
運用者の非公開領域に保全しています。この過去の記録を現在のSHAの検証結果として扱いません。

```bash
node --test experiments/prompt-cache/*.test.mjs
node experiments/prompt-cache/session-example.mjs --api responses
node experiments/prompt-cache/session-example.mjs --api messages
```

Focused regressions cover immutable history, opaque output replay, tool-result
ordering, unchanged refreshes, required slots, scope invalidation, pending-turn
protection, budget rejection, and identical behavior when only model names change.
Current upstream empty and diagnostic-only incomplete responses are covered.
The existing Worker CI also runs the session examples without external calls.

Local environments with `umask 077` must run the existing OAuth-permission fixture
under a test-process `umask 022`; otherwise its deliberately permissive 0644 file
is created as 0600. This is fixture setup, not a relaxation of credential loading.
Actual OAuth stores remain 0600. No authentication guard or test assertion changed.

The first full CI run also exposed an existing date-dependent nightly-budget
assertion: Sunday's graph sweep adds two SQL statements, but the test always
expected the ordinary 23. The fixture now pins Saturday (23) and Sunday (25),
with the 50-statement ceiling asserted in both cases. Production scheduling and
budget enforcement are unchanged. This is a test determinism fix discovered by
the pilot's required CI, separate from the Capsule consumer behavior.

These are synthetic/local integration checks. Live source acquisition with this
consumer, provider acceptance, task quality, cache-read/write counters, and
end-to-end latency remain unmeasured. Begin live evaluation with a bounded set of
representative correction, freshness and continuation cases; preserve unsuccessful
results alongside successful ones. Do not pad private memory to meet a cache
threshold or label a structural check as cache verification.

## Primary sources

- [Upstream proposal #329](https://github.com/rahilp/second-brain-cloudflare/issues/329) and [merged implementation #330](https://github.com/rahilp/second-brain-cloudflare/pull/330).
- [Pinned upstream types][upstream-types], [serializer][upstream-serialize], and [payload builder][upstream-builder], revision `1d7c66a3a96ea25976846b0ffad1ac95a14f7feb`.
- [OpenAI: Rethinking skills and prompts for GPT-6 Astra, September 11, 2026][astra-blog].
- [Codex best practices][codex-practices] and [OpenAI instruction/context guidance][openai-prompting].
- [OpenAI: using Astra][astra-model], [reasoning continuity][openai-reasoning], and [prompt caching][openai-cache].
- [Anthropic: Fable 5.1 prompting][fable-prompting], [thinking continuity][claude-thinking], and [prompt caching][claude-cache].

[upstream-types]: https://github.com/rahilp/second-brain-cloudflare/blob/1d7c66a3a96ea25976846b0ffad1ac95a14f7feb/src/prompt-capsule/types.ts
[upstream-serialize]: https://github.com/rahilp/second-brain-cloudflare/blob/1d7c66a3a96ea25976846b0ffad1ac95a14f7feb/src/prompt-capsule/serialize.ts
[upstream-builder]: https://github.com/rahilp/second-brain-cloudflare/blob/1d7c66a3a96ea25976846b0ffad1ac95a14f7feb/src/prompt-capsule/build.ts
[astra-blog]: https://learn.chatgpt.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra
[codex-practices]: https://learn.chatgpt.com/guides/best-practices
[openai-prompting]: https://developers.openai.com/api/docs/guides/prompt-engineering
[astra-model]: https://developers.openai.com/api/docs/guides/latest-model
[openai-reasoning]: https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-across-calls
[openai-cache]: https://developers.openai.com/api/docs/guides/prompt-caching
[fable-prompting]: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1
[claude-thinking]: https://platform.claude.com/docs/en/build-with-claude/thinking
[claude-cache]: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
