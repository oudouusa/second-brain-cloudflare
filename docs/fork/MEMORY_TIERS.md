# Manual memory tiers

- `warm`: the default for new memories.
- `hot`: explicitly included in Hot context.
- `cold`: organized without removing it from D1 or Vectorize; still included in normal recall.
- `pinned=1`: included in Hot context regardless of tier.

All operations are manual and reversible. Changing a tier or pin alone does not re-embed a memory. Hot context selects `pinned=1 OR memory_tier='hot'`, orders by importance and update time, excludes deprecated memories, and is capped at 12,000 characters. Memories returned by normal recall record `last_recalled_at`.

Following the current [memory policy](../../AI_Instructions/MEMORY_POLICY.md), AI clients use intent-framed `recall` when missing prior context could affect the answer. Use `get_hot_context` afterward when an ongoing project or current goal, priority, or operating constraint needs a small working set. Hot context supplements topic-specific recall. Limit pins to a small set of user-confirmed active goals or operating constraints; prefer a consolidated current-state entry over fragmented summaries for the same project. Unpin and return to warm/cold when work ends or expires.

REST uses `POST /memory/tier`, `POST /memory/pin`, and `GET /hot-context`. MCP uses `set_memory_tier`, `pin_memory`, `unpin_memory`, and `get_hot_context`.

## Current state and history granularity

Pinned memories should include the verification date and current state. When a state changes, such as a PR moving from OPEN to MERGED, use `update` to preserve the previous version in history. Distinguish mutable status from enduring permission constraints; do not extend past approval to unrelated work. Do not merely replace an old memory's date with today's date.

Retain important decisions, constraints, and outcomes according to the user's storage policy and exclusions. Append new facts about the same matter to a known ID; use update for corrections or replacement of current state, and remember for independently retrievable topics. Focus the content on the decision, rationale, verification time, continuing conditions, and references to original sources. Avoid accumulating new memories for long test lists or repeated unchanged checks.

Follow the append rollover recommendation at 8,000 characters and the requirement to roll over before continuing at 10,000 characters. Keep the original cold and continue in a short memory with explicit evidence dates. If only old verification results exist, retain that limitation in the content instead of presenting them as today's production state. Do not reorganize existing cold history based on length alone. Duplicate candidates require review; they are not grounds for deletion. These operating guidelines do not automatically change client-wide instructions.

## Digest topics

`personal`, `work`, `task`, `idea`, `context`, and `codex-response` remain available as general classification tags for storage and search, but are excluded from nightly/direct digest targets and administration summary suggestions. Summarizing a cross-project classification as a single topic would mark unrelated source memories as rolled up.

Search tag inference, auxiliary search, and normal tag display are unchanged. Specific tags, such as project names, remain available. Exclusion uses case-insensitive exact matches and does not exclude other tags such as `work-notes` or `context-menu`. Existing digests and source memories are not automatically changed; review evidence before organizing individual cases.
