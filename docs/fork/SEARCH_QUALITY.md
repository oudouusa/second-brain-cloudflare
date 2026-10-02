# Search quality and threshold calibration

## Measurement conditions

- Run date: 2026-08-26 JST
- Cloudflare account/profile: `second-brain-cf`
- Corpus: 60 synthetic queries (30 Japanese, 15 mixed Japanese/English, 15 identifiers), including 20 must-pass cases
- baseline: `@cf/baai/bge-small-en-v1.5` 384 dimensions
- Candidate: `@cf/google/embeddinggemma-300m`, truncated to the first 128 dimensions and L2-renormalized
- Gemma query prompt: `task: search result | query: ...`
- Gemma document prompt: `title: none | text: ...`

Corpus `title` is an evaluation label and is excluded from embeddings because current production entries have no title column. Measurements used the Workers AI REST API through a dedicated account, without saving or printing OAuth tokens, vector values, or private memory content. Per-query rank, Top 5, and scores are in `benchmarks/recall-v1/results-*.json`.

## Recall results

| Profile / category | Recall@1 | Recall@5 | MRR |
|---|---:|---:|---:|
| BGE overall | 86.67% | 96.67% | 0.910758 |
| Gemma 128 overall | 100% | 100% | 1.000000 |
| BGE Japanese | 73.33% | 93.33% | 0.821516 |
| Gemma 128 Japanese | 100% | 100% | 1.000000 |
| BGE mixed | 100% | 100% | 1.000000 |
| Gemma 128 mixed | 100% | 100% | 1.000000 |
| BGE identifier | 100% | 100% | 1.000000 |
| Gemma 128 identifier | 100% | 100% | 1.000000 |

Gemma placed all 20/20 must-pass cases in the Top 5. Japanese Recall@5 improved by 6.67 percentage points, with no decline for mixed or identifier queries, satisfying the M3 quality gate. Correct Top-1 Gemma scores ranged from 0.519723 to 0.853190; 3/60 were below 0.60.

## Threshold corpus

Separately from search queries, 40 fixed document pairs cover ten each of exact duplicates, near duplicates, related-but-distinct pairs, and unrelated pairs. Results are in `benchmarks/recall-v1/thresholds-embeddinggemma-mrl128-v1.json`.

| Class | min | median | max |
|---|---:|---:|---:|
| exact duplicate | 1.000000 | 1.000000 | 1.000000 |
| near duplicate | 0.826514 | 0.910752 | 0.959032 |
| related | 0.329240 | 0.453827 | 0.594439 |
| unrelated | 0.155909 | 0.228434 | 0.378484 |

## Adopted thresholds

| Purpose | Previous | Adopted | Observed behavior |
|---|---:|---:|---|
| duplicate block | 0.95 | 0.98 | Blocks 10/10 exact pairs without falsely blocking near duplicates |
| duplicate flag | 0.85 | 0.80 | Flags 10/10 near pairs; 0/20 false flags for related/unrelated pairs |
| recall widen | 0.85 | 0.60 | Expands only the weak tail of 3/60 rather than every query |
| graph auto-link | 0.78 | 0.42 (shared specific topic tag) / 0.70 (no shared tag or no tags) | 0.42 is the calibrated floor: 8/10 related hits, 0/10 unrelated false positives. See the production consistency gate below. |
| insight candidate | 0.80 | 0.82 | 10/10 evolving-thought-like near pairs; 0/20 broadly related/unrelated pairs |

Insight candidates prefilter changes within the same topic at least 30 days apart for LLM judgment, rather than broad topical relationships. Calibration therefore conservatively treats near duplicates as positives. Unit tests pin the rounded adopted thresholds to measured JSON.

## Production graph reassessment (2026-08-28)

An 83-edge snapshot aggregated only semantic classifications, without saving private text: 56 clearly useful, 22 clearly incorrect, and five weakly related. Of these, 81 were inferred and two explicit; most incorrect links connected semantically similar but different projects. All 31 inferred edges at or above `0.70` were valid, but a clear incorrect link existed at `0.6891`. Raising the threshold alone would also lose useful same-project edges in the `0.42–0.69` band.

Use shared specific topic tags as evidence of project consistency alongside raw scores. Generic instruction-assigned tags `personal`, `work`, `task`, `idea`, `context`, `claude-response`, and `codex-response` do not count; system lifecycle/pipeline tags are excluded too. Apply the calibrated `0.42` floor with a shared topic, otherwise the production clean-band threshold of `0.70`. Record policy `embeddinggemma-mrl128-v2` in edge metadata so nightly passes can gradually recompute old-policy edges.

A production read-only SQL dry run that day classified 96 inferred `relates_to` edges: 36 at or above `0.70`, 29 in `0.42–0.69` sharing a specific topic, 31 in that band without one, and zero below `0.42`. That gave 31 initial nightly-prune candidates and 65 retain candidates. SQL metadata reported `changed_db=false`, `rows_written=0`; no content, tag values, or entry IDs were printed.

After 2.5.0 deployment, six bounded nightly passes completed the gradual migration. Initial convergence showed 61 current-policy inferred edges (59 shared-topic-tag, two high-similarity), zero legacy-policy, six explicit, and zero dangling. After 2.5.1 deployment, the 2026-08-28 17:38 JST check following normal recomputation showed 43 entries, 64 edges, 58 current-policy inferred, zero legacy, six explicit, and zero dangling. Inferred counts vary with entry updates and nightly recomputation without returning to the old policy. Explicit edges remained excluded from recomputation and pruning.

## Graph contribution during reads

For requests explicitly specifying hops, `recall` returns `seedCount`, `expandedCount`, `eligibleCount`, and `selectedCount`. Expanded counts edge-traversal candidates, eligible counts those passing query-evidence gates, and selected counts graph-derived memories retained in final results. Workers Logs store only these counts, not queries or IDs.

`connections` filters edge types inside source/target index scans, not after node deduplication. It retains multiple types for the same pair; directed edges return stored source/target and direction relative to the requested entry. Cursor paging defaults to 20, caps at 100, and limits offset to 10,000, preventing unlimited scans. Keep `DEFAULT_HOPS=0` to avoid false positives and extra D1 reads; clients select 1–2 for why/how, causal, or chronological questions.

In 2.5.1, edges between top candidates selected as graph roots also contribute one-hop evidence. Previously, premarking all roots visited prevented a direct-search result ranked sixth or lower from using a strong edge to a higher root for reranking. Final direct and related slots are deduplicated by ID; protected top direct results are not displaced.

Intent classification also recognizes Japanese signals such as `なぜ／理由／原因` (why/reason/cause), `前／後／経緯／履歴` (before/after/background/history), and `現時点／現在／最新` (current/latest). Explicit or system-derived `caused_by`, `follows`, and `supersedes` edges qualify as structural evidence only when causal/chronology intent, stored direction, question direction, one-hop distance, and weight ≥0.5 all align. Inferred edges cannot use this exception; they retain content rare-term precision and evidence-gain gates.

## Hosted input lengths

Japanese inputs of 320/400/450/480/500/1000/1600 characters, English at 1600, and code at 1600 all returned HTTP 200 and raw 768-dimensional vectors using the production document prompt. Comparisons with a shared prefix and different suffixes at 500/1000/1600 characters also differed in the first 128 dimensions. This shows that suffix changes affected embeddings, beyond mere input acceptance, supporting retention of `CHUNK_MAX_CHARS=1600`. Measurements are in `benchmarks/recall-v1/input-limits-embeddinggemma-mrl128-v1.json`.

## Reproduction

In another terminal, start the AI-binding Worker described in the benchmark README at `127.0.0.1:8791`, then run:

```bash
npm run benchmark:bge
npm run benchmark:gemma
npm run benchmark:thresholds
npm run benchmark:input-limits
```

Use `npm run benchmark:validate` to validate the corpus without Cloudflare access. Result files contain corpus and threshold-corpus SHA-256 hashes; generation timestamps vary between runs.

## Tagged current-state retrieval (2026-09-13)

A focused fork improvement addresses status evidence lost during fusion. A
Japanese request such as “最新の採用状況” was classified as causal because
“採用” preceded the explicit current-state signal. “直近” was not recognized.
Current intent now takes precedence over a bare decision word; explicit reasons
and directed before/after questions retain their original precedence.

For a **tagged current-state query with strong dense evidence**, reuse the
existing lexical-arm normalization: scale the largest keyword RRF weight to one
while retaining the IDF ordering within that arm. Previously, rare generic words
could accumulate several votes and bury relevant status records. The existing
`RECALL_WIDEN_THRESHOLD` remains the gate. Other tagged intents, weak/degraded
retrieval and the existing untagged calibration condition remain unchanged.
There is no new model branch, dependency, ranking service, endpoint or setting.

### Evidence and limits

The diagnostic replay used a read-only production snapshot of 832 entries and
1,996 stored vectors, eight previously selected Japanese questions, and one
fixed batch of eight query embeddings from the unchanged Gemma model. The new
evaluation-summary memory and its incident edges were excluded before comparison
to prevent the assessment itself from supplying the answers. Production
`recallEntries` ran against the existing SQLite test facade with stored vectors
returned by `getByIds`, the same personal workspace, fixed clock, topK=5, hops=0,
and default MMR. No live memory write or candidate deployment was performed.
Raw content, IDs, embeddings and the private replay helper remain outside Git.
Only anonymous regression fixtures are committed.

| Previously missed question | Baseline | Candidate |
|---|---|---|
| Latest production rollout | No sufficient source in top five | Current journal at rank 2 contains the rollout/version and remaining validation limits |
| Adoption of a particular upstream PR | Old review/open-state records dominated | Current journal at rank 2 and integration journal at rank 4 contain the merged/adopted state |
| Six other questions | Existing results | Identical ordered result IDs |

This measures **answer-bearing source availability**, not an automatic correct
answer. The current journal is long and its newest facts require `get`; rank 1
is still not the correct answer to either failing question. The two originally
chosen standalone target IDs still miss the top five. Do not count alternate
journals as exact-target recovery, claim general Recall@5/precision, or interpret
“100% match” as confidence. These eight cases are selected, self-assessed,
already inspected during development, and have no held-out set. Untagged live
quality, generated-answer accuracy, Fable behavior, CPU and billing remain
unmeasured by this replay.

Normalizing every tagged query was rejected after it displaced an answer to a
historical question. Replacing direct lexical fusion with the full graph-root
term set was also rejected. The final change is restricted to explicit current
intent and reuses the existing fusion calculation.

The two changed cases retained one embedding call and 17 bounded Vectorize
`getByIds` calls each, with no Vectorize query. D1 statements changed from 10 to
11 because current intent activates the existing rollover-lineage read. Local
SQLite does not reproduce Cloudflare billed rows; no free-tier guarantee follows.

### Reproducible checks and primary implementation references

- Anonymous fusion regression: `test/integration/keyword-recall-quality.test.ts`
  covers strong current intent, ordinary/causal intent, and weak dense evidence.
  It disables MMR only in this fixture to isolate the fusion outcome.
- Intent and lineage regressions: `test/unit/recall-query-profile.test.ts` and
  `test/integration/recall-rollover-lineage.test.ts`.
- Implementation: [query profile](../../src/recall/query-profile.ts),
  [fusion and search](../../src/recall/search.ts),
  [RRF](../../src/recall/rrf.ts), and
  [fixed embedding profile](../../src/embedding/profile.ts).
- The snapshot uses Cloudflare's read-only
  [get-vectors API](https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/get_by_ids/).
  Query embeddings use the documented
  [EmbeddingGemma model](https://developers.cloudflare.com/workers-ai/models/embeddinggemma-300m/)
  with the existing query prefix, first-128 projection and L2 normalization.

This is fork evidence for a future upstream discussion, not a public submission
or a production release. Before proposing the normalization upstream, validate
its own embedding calibration rather than copying this fork's threshold.

### Follow-up: evidence visible in the preview

The next inspection separates ranking from what a client can actually read.
On the same frozen snapshot, the previous candidate already displayed the latest
production version, but its query-selected excerpt cut off the subsequent
qualification: real-memory quality and one model remained unverified. A source
being retrieved does not mean its important qualification reached the client.

The fork now shares a small `recallSnippet` selector between MCP and REST, while
keeping the upstream-owned `snippet.ts` byte-identical. For current intent with
no explicit or parsed time bounds, search passes full-query evidence excluding
corpus-saturated words using the existing DF calculation and saturation limit.
Numeric identifiers remain mandatory anchors even when absent from that corpus.
For an oversized append journal only, the selector may use upstream's existing
head-plus-latest-update preview when the **visible latest excerpt** matches at
least two evidence terms and every numeric identifier. Otherwise it retains the
ordinary query-relevant excerpt. The full source length, truncation marker,
`get` affordance, full-output behavior and existing character allowances remain.
`現状` and `今の` are also recognized as current intent. Reasons and directed
history retain precedence; `今後` does not become current intent.

MCP labels the normalized score as `relative score: 1.00` instead of `100% match`,
and prints the source update date when present. Neither source creation nor
update dates certify when a real-world event happened. REST's numeric score
contract is unchanged. The MCP tool description changes accordingly, so the
pinned `tools/list` digest is deliberately updated; tool schemas and registration
order are unchanged. Clients caching tool descriptions must refresh that catalog.

The same eight-case replay retained every ordered result ID and every observed
AI/Vectorize/D1/KV operation count from the preceding candidate. The production
preview now includes the previously omitted quality/model qualification. The
six non-current cases keep their prior excerpt selection. The original exact-ID
misses and incorrect rank-1 answers remain unresolved; this is a presentation
improvement, not a second ranking win. No further remote embeddings were needed.

Anonymous checks cover current wording and historical/future wording, explicit
date bounds, unrelated final updates, a different issue number (`#14` versus
`#149`), an identifier outside the visible excerpt, and preserved truncation and
source length. These are controlled regressions, not a held-out live quality
benchmark. Matching two words is still a lexical heuristic: same-topic but
different-subject updates and alternate identifier spellings can remain hard.
Do not treat the latest excerpt as a substitute for `get` when omitted context
could change the answer.

The initial trial required the latest preview to retain at least as many query
words as the ordinary preview. It kept an older passage that happened to contain
one extra generic word while hiding the new qualification. The accepted gate
uses bounded, non-saturated evidence in the visible update instead. Blindly
preferring the newest entry or globally changing RRF/MMR remains unjustified;
the snapshot shows that the missing standalone answers are already candidates,
and stored-vector similarity alone does not put them first. More freshness
weight would not establish that an entry actually records completion.

Primary implementation references are [upstream-compatible snippet selection](../../src/recall/snippet.ts),
[the shared preview selector](../../src/recall/render.ts),
[existing corpus DF distillation](../../src/recall/distill.ts), and
[the MCP contract](../../src/mcp/server.ts). The rationale and limitations above
are local observations and design judgments, not claims made by the external
Cloudflare documentation. Additional local string processing is not included in
the remote CPU/billing evidence; no production or free-tier certification is
implied by unchanged operation counts.


### Follow-up: preserve subjects within the rare-term budget

Distillation can discard the subject before lexical fusion: three rarer generic
words can displace an explicit issue number. The fork's CJK fallback also lets a
whole word and its substrings consume separate slots. These are term-selection
problems, independent of the embedding model or current-state intent.

The existing `distillToRareTerms` now removes a fallback bigram from selection
when an eligible whole query word contains it. If that whole word did not survive
the existing corpus filter, partial matching remains available. It then reserves
at most one of the existing three slots for the rarest eligible structured
identifier, using the tokenizer's existing provenance and punctuation/digits.
Acronyms alone do not qualify. Absent or corpus-saturated identifiers receive no
reserved slot, including the all-common fallback. Remaining slots retain DF
ordering and the result retains query order. This does not expand all query terms
into direct fusion, change the SQL scan, or add calls, settings or dependencies.
The upstream-owned tokenizer and snippet implementation remain unchanged.

The frozen eight-question replay against the preceding candidate retained all
five result IDs for every question. Seven kept their complete order; the team
policy question exchanged ranks 3 and 4. Observed AI, Vectorize, D1 statement and
KV operation counts were unchanged for all eight questions; local string work and
remote billed rows are not measured by those counts. The guidance query replaced the redundant
`キル` fragment of `スキル` with `個人`; the overdesign query gained `助言` instead
of a substring. These are improvements in term coverage, not new recovered
answers. In particular, the production question still distills to `直近 たい 残り`
and the two original standalone target misses remain unresolved.

Four anonymous SQLite retrieval cases exercise English/Japanese wording with and
without an explicit tag. Each has an issue's archive, unrelated background notes,
and two state records using the same generic wording but different issue numbers.
With embeddings deliberately unavailable, the preceding implementation discards
the queried issue number; the candidate preserves it and ranks the matching state
record first. Separate unit cases cover absent/common identifiers, multiple IDs,
acronyms, duplicate CJK fragments and partial-match fallback. These are controlled
regressions added during development, not independent or blind accuracy evidence.

A trial where the matching state record omitted a rare generic query word still
ranked the other issue first. Reserving an identifier is not a hard match filter
or a guarantee of correct ranking; this limitation remains. Alternate spellings
such as `PR #730` / `PR730`, repository identity for equal issue numbers, questions
without explicit identifiers, and inferred completion remain separate problems.
There is no new claim of live accuracy, latency, billed rows or free-tier safety.

Primary implementation references: the upstream
[rare-term selection](https://github.com/rahilp/second-brain-cloudflare/blob/1d7c66a3a96ea25976846b0ffad1ac95a14f7feb/src/recall/distill.ts),
[its Unicode tokenizer](https://github.com/rahilp/second-brain-cloudflare/blob/1d7c66a3a96ea25976846b0ffad1ac95a14f7feb/src/text/tokenize.ts),
the fork's [bounded selection](../../src/recall/distill.ts) and
[existing token provenance](../../src/text/lexical-query.ts).
The identifier reservation is a candidate for a small upstream proposal after
validation against upstream's own retrieval behavior; the bigram deduplication
addresses the fork's fallback layer and is not claimed as an upstream defect.

## Candidate admission, independent preview evidence, and synthesis context (2026-09-13)

A static review identified three remaining seams. They are addressed in the
fork-owned callers and lexical helper, without changing the upstream-owned
tokenizer/snippet, embedding profile, provider selection, or deployment bindings.

- **Direct candidate admission:** with `hops=0`, the ordinary keyword OR query
  now reuses `recallEligibilitySql(kind)` before its existing LIMIT. Previously,
  newer deprecated or wrong-kind rows could fill that window and hide an older
  usable result even though MMR correctly rejected the fetched ineligible rows.
  The OR alternatives remain grouped under the workspace and eligibility
  predicates. Tagged direct retrieval also applies eligibility and the existing
  `created_at` bounds before collecting vector IDs, without a new recency LIMIT.
  With graph traversal enabled, the existing candidate population remains:
  a readable event outside the answer's kind/time filters can still lead to an
  eligible answer. Final hydration and pre-MMR checks remain in both modes.
- **Independent current-preview terms:** reuse the distillation helper that
  removes a CJK bigram contained in an eligible whole word. Apply it after DF
  admission to the current-preview evidence, retaining the original token kind.
  `スキル`, `スキ`, and `キル` no longer satisfy the two-term preview threshold
  through one word. A bigram remains available when its whole word is absent
  from the admitted set. Ordinary fusion and graph scoring keep their evidence.
- **Synthesis context:** pass the original request query, including time phrases,
  to `synthesizeInsight`. The distilled query remains the lexical search input
  and reported `query_used`. REST's synthesis default and MCP's explicit
  `synthesize:false` are unchanged. This preserves the question; it does not
  establish generated-answer accuracy or guarantee fewer input tokens.

Focused regression fixtures use the existing SQLite facade and mocked AI and
Vectorize. They cover candidate-window occupancy, direct tag overfetch versus
graph roots, the full recall-to-preview path, and the actual synthesis prompt.
These are local regression evidence, not a held-out production quality study or
a measurement of CPU, billed D1 rows, daily usage, or full-tag scalability.

The existing upstream mechanisms remain the starting point: [keyword retrieval
and synthesis caller](https://github.com/rahilp/second-brain-cloudflare/blob/1d7c66a3a96ea25976846b0ffad1ac95a14f7feb/src/recall/search.ts),
[query distillation](https://github.com/rahilp/second-brain-cloudflare/blob/1d7c66a3a96ea25976846b0ffad1ac95a14f7feb/src/recall/distill.ts),
and [snippet selection](https://github.com/rahilp/second-brain-cloudflare/blob/1d7c66a3a96ea25976846b0ffad1ac95a14f7feb/src/recall/snippet.ts).
