# Second Brain Worker — module layout

Incremental split of the former monolithic `index.ts`. Entry point remains `src/index.ts` (Wrangler `main`).

## Layers (import rules)

| Layer | Path | May import from |
|-------|------|-----------------|
| Pure | `memory/`, `text/`, `recall/math.ts`, `recall/rrf.ts` | `constants.ts` only |
| Infra | `env.ts`, `constants.ts`, `lib/`, `db/` | pure, same layer |
| Domain | `capture/`, `recall/`, `graph/`, `compression/`, `integrations/`, `projects/` | infra, pure, domain peers |
| Edge | `routes/`, `mcp/`, `oauth/` | domain, infra |
| Entry | `index.ts` | edge only (+ wiring) |

**Never:** pure/infra → domain/edge; domain → routes/mcp.

## Module map (original `index.ts` sections)

| Section | Module |
|---------|--------|
| Env, SB_VERSION | `env.ts` |
| Thresholds, models, chunk/vectorize/recall constants | `constants.ts` |
| CORS, json, auth | `lib/http.ts` |
| embed, readStreamText, graceMs | `lib/ai.ts` |
| actor label resolution | `lib/actors.ts` |
| initializeDatabase | `db/init.ts` |
| status/kind tags | `memory/status.ts`, `memory/kind.ts` |
| tag LIKE pattern + escaping | `memory/tag-sql.ts` |
| tag vocabulary cache | `tags/vocabulary.ts` |
| compression eligibility | `compression/eligibility.ts` |
| chunk, hashtags, temporal, tokenize | `text/*` |
| cosineSim, rerank, mmr | `recall/math.ts` |
| rrfFuse | `recall/rrf.ts` |
| vectorize health | `vectorize/health.ts` |
| graph edges/traverse/pass | `graph/*` |
| recall search pipeline | `recall/*` |
| FTS match-query builder + KV readiness gate | `recall/fts.ts` |
| FTS write guard + hot-path repair | `db/fts-write-guard.ts`, `db/fts-repair.ts` |
| FTS nightly backfill + integrity self-heal | `db/fts-backfill.ts` |
| capture write path | `capture/*` |
| compression nightly/digest | `compression/*` |
| staleness pass + classifier | `staleness/*` |
| integration mirror | `integrations/mirror.ts` |
| project registry, alias filter expansion, read-side resolution, auto-create | `projects/*` |
| OAuth pages/register/authorize | `oauth/*` |
| MCP server + sanitize | `mcp/*` |
| REST routes | `routes/*` |
| dbReady | `runtime/state.ts` |
| maintenance workspace rotation | `runtime/rotation.ts` |
| nightly summary written to KV for GET /stats/night | `runtime/night-summary.ts` |

## Recall keyword arm (FTS5)

Keyword recall serves its candidates from an FTS5 trigram index ranked by
`bm25(entries_fts)`, so the best matches become candidates instead of the
newest 500. Measured on local D1 through the real recall path: a search for
specific words reads about 66-193 rows whether the brain holds 5,700 or 20,700
memories, while the scan it replaced read the whole brain (20,766-41,541 rows
at 20.7k), roughly 200-300x cheaper at 20k, and the gap widens as the brain
grows. A query mixing a specific word with a very common one is still cheaper
(about 60% of the scan's cost at 20k), though unlike a specific-word search
that cost grows with the brain (1.83x from 5.7k to 20.7k). Saving a memory
writes one extra small row (7 rows instead of 6), flat — that row is the
per-workspace counter below, not the index itself, which was already
counted before.

`keywordSearch` (`recall/search.ts`) routes every query and reports the outcome
in `internal.diagnostics.ftsUsed` and `ftsRoute`:

- **FTS arm** (`keywordSearchFts`): queries the `entries_fts` virtual table.
  A full plan is ordered by `bm25(entries_fts)`; a bounded plan's AND tier is
  ordered newest-first by rowid instead (below). `planFtsMatch`
  (`recall/fts.ts`) builds the MATCH strings: it double-quotes each token
  (internal quotes doubled, so user text cannot inject FTS syntax) and joins
  them with OR, or with a space for the AND tier. (`ftsMatchQuery` in the same
  file builds the single-term counts distillation uses.) The trigram tokenizer
  matches substrings, which keeps the LIKE semantics recall has always had,
  including CJK text and identifier-shaped tokens such as `#149` or `v1.9`.
  The read joins `entries` on both rowid and id, so a row whose rowid-to-id
  mapping has drifted is excluded and duplicate FTS rowids cannot consume the
  LIMIT window.
- **Cost-aware router**: the index serves every query that has at least one
  FTS-eligible token. Tokens under `FTS_MIN_TOKEN_LENGTH` (3 codepoints: `io`,
  `k8`, two-character CJK words) cannot be retrieved through a trigram index, so
  they no longer send the whole query to LIKE (T-0074); they rank instead. The
  bm25 query orders rows carrying them first, evaluated on rows the MATCH
  already read, and fusion still weighs them. Distillation's document
  frequencies, when they cover every eligible term, estimate how many rows bm25
  would have to score. Within `FTS_MATCH_BUDGET` (2,000) the query is one OR
  over every eligible token. Past it (T-0073) the plan is bounded, in two tiers
  merged in this order:
  1. **AND tier**: every eligible token, so only rows carrying every word. Its
     size is bounded by the rarest token's df, not by the budget (words that
     always co-occur match the whole partition), so it runs as
     `ORDER BY entries_fts.rowid DESC LIMIT ?`: a reverse index scan (rowid
     follows insertion, so newest first) that stops at the LIMIT with no sort.
     On workerd at 5k that read 1,111 rows against 2,503 for
     `ORDER BY created_at DESC`, which also needs a temp b-tree over every
     match. Insertion follows time on capture, and `POST /import` sorts a
     payload oldest first before paging (`GET /export` now emits oldest first
     too, but exports taken earlier are newest first), so a restored brain is
     chronological too. The one exception is an older archive merged into a
     brain that already holds newer rows: the archive is inserted after them,
     so when more than the limit rows carry every word this tier prefers the
     archived rows. It still returns rows carrying every word. Ordering by
     `created_at` would fix that at the cost of sorting every match.
     When the OR tier's matches all fit in the candidate limit the AND tier
     adds no candidate (its rows carry every token, so they are among the OR
     tier's) and is left out.
  2. **OR tier**: the rarest tokens whose df sums within `FTS_MATCH_BUDGET`
     (greedy), ranked by bm25, so bm25 scores at most the budget and picks the
     best `KEYWORD_CANDIDATE_LIMIT` of them. The budget is not tied to the
     limit: measured at 500 and 1,000 it cost fewer rows but lost answers that
     carry only a moderately common token (0 of 6 and 3 of 6 guard queries
     reachable, against 6 of 6). A token past the budget cannot join this tier.
  A token whose df is 0 is in no row, so it drops out of both tiers, and a
  query left with no plan goes straight to LIKE without an FTS batch. Common
  words the plan leaves out still weigh in fusion. Both tiers run in the same
  `DB.batch` as the liveness check, so it costs no extra subrequest.
  forkでは単語クエリもdfを計算する。未集計の語がある場合は上流のfull ORへ戻る。
- **Short-token df**: the index cannot count a short token and the exact LIKE
  count reads the whole partition, so distillation estimates its df from the
  newest `FTS_SHORT_TOKEN_SAMPLE` (200) readable rows, Laplace-smoothed
  (`shortTermSampleStmt`). It feeds fusion's all-or-nothing IDF and the
  saturation test that keeps a substring like `io` out of the embedded query.
  The sample sees only recent rows, so it can be wrong about a corpus whose
  recent rows differ from the rest; that is why `rankAndRebuild` lets a short
  token fill only the slots the counted terms leave and never outrank one.
- **LIKE経路**: 通常recallはforkの`keywordSearchLexical`を使う。
  日本語raw／NFKC probe、非bigram単語一致優先、追記の局所passage、縮退時の
  canonical救済とbind予算を保持する。FTS適格性・準備・liveness・SQL失敗時の
  fallbackを共有する。上流の稀語窓helperは単独router試験用の呼出しも維持する。

Two gates decide whether the FTS arm runs at all. `ftsReady` (`recall/fts.ts`)
reads the KV flag `fts:ready` and caches the answer in both directions for
`FTS_READY_CACHE_MS` (5 minutes). Separately, every FTS query carries
`FTS_LIVENESS_SQL` in the same `DB.batch` as the search itself: `entries_fts`
and all three sync triggers must be present with their exact definitions (a
right-named trigger with a drifted body reads as not live), or the arm throws
into the LIKE fallback. Correctness never depends on KV alone.

Term distillation (`recall/distill.ts`) counts through the index too:
`distillViaFts` batches the liveness check, the exact per-workspace total from
`entry_counts` (a trigger-maintained counter table, one row per workspace,
created and seeded in `db/init.ts`), and one capped MATCH count per term. A
term containing accented Latin counts through the LIKE scan instead
(`ftsCountSafeToken`: LIKE folds ASCII case only, trigram folds all of
Unicode, so the two could count differently). If every original term
saturated its cap, the counts are discarded and the LIKE scan counts exactly.

Fusion is unchanged above the keyword arm: `fuseDenseAndKeyword` still sorts by
the JS boundary/IDF weight, with the bm25 order surviving as the tiebreak
within equal weight tiers (`keywordPreRanked`); MMR, the graph, and rerank
heuristics do not change.

Schema (`db/init.ts`, mirrored in `db/schema.sql`): the virtual table
`entries_fts` (`fts5(id UNINDEXED, content, tokenize='trigram')`) plus triggers
`entries_fts_insert`, `entries_fts_update`, `entries_fts_delete`, which mirror
`entries.rowid` into `entries_fts.rowid`. A plain table, not external-content:
`entries` has a TEXT primary key, so the triggers sync by rowid (an O(1) delete
rather than a content-table scan). The update trigger fires only when rowid,
id, or content changes; a `recall_count`-only update writes nothing. Table and
triggers are created together in one batch and never repaired independently; a
missing trigger on an existing table reads as not live.

The write guard (`db/fts-write-guard.ts`, installed at the Worker entry for
every request and the nightly job) patches each statement that writes to
`entries`. It guards two dependencies, `entries_fts` and `entry_counts`: a D1
error naming one of them is checked, and the other (which threw nothing) is
probed live, so a single write that finds both missing repairs both.
`repairFtsIndex` (`db/fts-repair.ts`) deletes the ready flag, resets the
backfill cursor, recreates the table and triggers when the table is missing,
and otherwise drops only the three sync triggers, a non-destructive disabled
state every reader already sees as not live. `repairEntryCounts`
(`db/entry-counts-repair.ts`) recreates the counter table and its three
triggers and reseeds it from a `GROUP BY`, the same shape `applySchema` uses
the first time. The failed statement or batch is then retried exactly once;
a failed D1 statement or batch has no effect, so the retry is safe, and
saves never fail because of either dependency.

Nightly maintenance (`runFtsMaintenance` in `db/fts-backfill.ts`):

- **Not ready:** backfill 2,000 rows per night (`FTS_BACKFILL_BATCH`) behind the
  KV cursor `fts:backfill-cursor`, each batch deleting its rowid range before
  inserting so re-runs are idempotent. The ready flag latches only after exact
  parity in both directions (`entries` vs `entries_fts`, compared on rowid,
  id, and content) passes together with liveness; a single mismatching row
  restarts the backfill instead.
- **Ready:** FTS5's own `integrity-check` statement runs first; a throw there
  rebuilds. Count parity (`entries` vs `entries_fts`), a spot check of the
  newest rows' rowid-to-id mapping, and a rotating 200-row content check
  (`FTS_CONTENT_CHECK_WINDOW`) that compares (rowid, id, content) both ways and
  re-indexes exactly the mismatched rowids in place. `entry_counts` is checked
  separately and per workspace, not as one global total — a global sum can
  stay correct even while one workspace's count has drifted against
  another's — plus its three trigger bodies; either kind of drift drops and
  reseeds it from a fresh `GROUP BY`. Drift that FTS count parity catches
  resets the backfill; the destructive rebuild (`rebuildFtsIndex`: drop
  triggers and table, recreate, restart) runs only in this nightly job, never
  from a request path.

Upgrade is automatic. A brand-new brain latches ready at init (its triggers
cover every row from row one); an existing brain backfills over about N/2,000
nights while recall stays on LIKE until the backfill is complete and
verified, then switches — every server instance notices and starts using it
within `FTS_READY_CACHE_MS` (5 minutes) of the flag going live, since each
instance only checks periodically rather than on every request. No API or
MCP change.

### Candidate rows carry match levels, not text (T-0088)

以下の計数・品質測定は上流BGE corpusの記録であり、forkの本番測定ではない。
forkのFTS経路では本文なしmatch levelsを採用する。LIKE互換経路は局所passageと
日本語の照合に本文を使う。上限は128件、Gemma128固定。詳しい採否は
`docs/fork/UPSTREAM_SYNC.md` の3.7.0節を参照する。


The keyword arm used to select every candidate note in full (up to `KEYWORD_CANDIDATE_LIMIT` = 500 rows) so the Worker could weigh
each query term in it. On a brain with long notes (session logs, transcripts) that is tens of MB per recall, and the Worker's
CPU is spent parsing it, lowercasing it and running a boundary regex over it per term per row. D1 does that work now
(`src/recall/keyword-rows.ts`): each candidate row comes back with `id, created_at, tags, source` and, per query term, one level:

| level | meaning |
|---|---|
| 0 | the term is not in the note |
| 1 | it is, but only inside longer words ("cat" in "concatenate") |
| 2 | it stands as a word of its own: the characters either side are not `[A-Za-z0-9_]` |

Fusion weighs a term `idf` at level 2 and `idf * SUBSTRING_MATCH_WEIGHT` at level 1, exactly as before; the single-word df and
the reranker's keyword evidence read the same levels. Note text is fetched by id only where something renders or scores it (the
final results, the reranker's passages), which was already the case.

What the SQL does not reproduce, and why it was accepted:
- **The first two occurrences decide the boundary.** A note whose first two occurrences of a term sit inside longer words and
  whose third is a word of its own reads as level 1 (the scan read 2). On core-1k this moves 78 of 1,751 rankings (reranker off),
  none in identifier, rare-word or common-word, and no category regresses (gate: overall MRR@10 +0.0002, multi-hop recall@10
  -0.0033 with a bound of 0.0000).
- **Case is folded with SQLite's `lower()`, which is ASCII-only** (as `LIKE` is), so a term with non-ASCII characters is not decided
  in SQL alone. The SQL searches the ASCII-lowered text for the lowercased term, and a 2 from that is exact; a match through an
  upper-case form is not trusted, since ß, ﬁ and a capital Σ do not round-trip through lowercase. Any level below 2 for such a term is settled by `settleWideTerms` (keyword-rows.ts): the text of just those rows is read by id
  (skipping notes `widePrefilter`'s LIKE says no fold of the term can match, in chunks that share D1's 100 bound values with the
  patterns) and the level is worked out in the Worker with the old rule (Unicode `toLowerCase`, the boundary above). An ASCII-only
  query never reads text, except for a note holding U+212A (Kelvin sign) or U+0130 (dotted İ), which the SQL flags with one `instr` each: lowercase turns them into ASCII `k` and `i`, which SQLite's `lower()` never sees, so every term of such a note is settled the same way. The worst case is a non-ASCII query whose candidates are mostly long notes without the term: it reads
  what the old code read for those rows.
- **rows_read rises about 8%** on core-1k (2,494 to 2,696 per recall on workerd): the statement's candidate CTE is materialized and
  read once more to compute the levels. The same rows are scanned; no statement was added.

Each term is bound once and referenced by number (`?N`), so sixteen terms and a scope stay far under D1's 100 bound values.
A row that carries its own text (the `?tag=` path, and test doubles standing in for D1) is scored from that text as before.

Measured worker CPU per recall (local, response parsing included; D1 stand-in time excluded), before to after:

| brain | 3.6.0 | fbe2f1d | after |
|---|---|---|---|
| 3,300 short notes, 2% long (3-8 KB) | 6.5 ms | 6.5 ms | 6.3 ms |
| 15% of notes 10-50 KB, FTS | 36.4 ms | 67.6 ms | 8.3 ms |
| 20% of notes 20-100 KB, FTS | 90.4 ms | 159.1 ms | 10.9 ms |
| 20% of notes 20-100 KB, LIKE | 83.2 ms | 79.9 ms | 8.6 ms |

## Recall cross-encoder reranker

`recall/model-reranker.ts` re-scores a bounded set of already fused candidates
with `@cf/baai/bge-reranker-base` (one nonstreaming `AI.run`, request
`{query, contexts: [{text}], top_k}`, answer `{response: [{id, score}]}` with raw
logits). It sits after `rerankWithTimeDecay` and before `mmrRerank` and graph-root
selection, so dense and keyword candidate generation, fusion, graph expansion,
evidence rescue, rendering and synthesis are untouched.

- **Candidates.** Up to 25 direct parents in heuristic order plus up to 5 extra
  graph-root parents (30 total, one batch). Only parents the scoped
  candidate-signal read returned are eligible. At hops 0 one extra by-id read
  fetches their text (at hops above 0 the text is already in hand); it omits the
  scope clause on purpose, because with it SQLite scans the whole workspace instead
  of doing 30 primary-key lookups. Vectorize and keyword metadata content never
  reach the model. Each passage is `queryRelevantWindow(content, ..., 400)`.
- **Blend.** Model scores become rank percentiles within the batch (ties keep
  baseline order; all-equal is neutral). Only parents the model scored are
  reordered: each has its heuristic score multiplied by
  `max(floor, 1 + w * (2p - 1))` (`w = 1.0`, `floor = 0.25`, so nothing is
  multiplied by zero), and the scored block is scaled, by one factor, just clear of the
  best unscored score. A scored candidate therefore never falls below one the model
  did not see, unscored candidates keep their positions, and the same parent factor
  scales the direct and the root view. `w` and `floor` were chosen on core-1k from
  a grid pre-registered in the commit message before it ran ({0.5, 0.75, 1.0} x
  {0.25, 0.5}; rule: best paraphrase mrr@10 among configs with no regression, cost
  within budget and overall recall@10 not below baseline) and then validated once
  on scale-20k and SciFact. At full weight the model's order dominates.
- **Keyword evidence.** A parent the keyword arm returned that holds every distilled
  query term is always scored (up to five), taking the seat of the lowest-ranked
  fused candidate, and enters the blend at the edge of the fused candidates. A
  single-term query counts only if its df is within the saturation fraction (the
  keyword rows holding the term over one `entry_counts` read, taken only when the
  model is about to be called and an evidence row lies outside the head), so a
  common word takes no seats. At hops 0 the batch is 25 wide, so evidence extras
  evict fused candidates while up to five seats stay empty; that is the
  pre-registered rule, chosen to keep cost flat, and worth revisiting once real
  Workers AI cost is measured.
- **Routing (no AI).** `RERANK_MODE` is `off`, `on` or `auto` (default `auto`;
  an unknown stored value reads as `off`). `on` needs at least three parents;
  `auto` also needs the top two heuristic scores within 15%. A lookup-shaped
  query token always skips: `#` or `_`, a digit next to a letter (`v1.2`,
  `abc123`, `40mg`), a dotted name (`config.yaml`), a multi-dot number
  (`10.0.0.1`). Prose does not: a sentence-final period, a plain hyphenated word,
  a bare year, a plain number or percentage, and a dotted abbreviation of segments
  of two letters or fewer (`U.S.`, `e.g.`). On the expanded core-1k set the
  shipped `auto` mode skips 239 of 1,683 queries as lookups and 810 for a clear
  leader, and calls the model on 634. The rule was fixed after seeing SciFact, so
  SciFact is in-sample for routing and held out for the blend. `off` returns
  before any read of the latch.
- **Readiness.** A model never runs until `reranker:ready:bge-base-v1` says the
  probe passed. `probeReranker` sends a small ranking check (the relevant passage
  must lead two unrelated ones by two logits; scores that all lie in [0,1] are read as sigmoid probabilities and compared in logit space, since Workers AI may return either scale, and a failure logs the raw scores) and then a production-shaped request
  (30 passages of 400 characters, a 256-character query) that must come back
  complete; any rejection, truncation or wrong length latches "0". The first
  recall that would have used the model schedules the probe in `waitUntil` (one per
  isolate at a time; a passing verdict lives a week, a failing one six hours, and
  the isolate remembers the verdict even if the KV write fails), so the contract is
  re-proved lazily at no cost to the nightly cron's statement budget. The probe has
  its own 15 s timeout; a recall allows 1.5 s (a judgment, unverified against
  Workers AI). The probe also latches "0" if its full-batch leg takes longer than a recall may wait. Its Latin filler
  under-probes a token-based size limit by about 4x for CJK text (400 CJK characters are
  roughly 400 tokens, not 100), so the circuit breaker below is the runtime backstop.
- **Circuit breaker.** Three consecutive timeouts or errors in an isolate latch the
  model off for six hours (here and in KV) until the probe re-proves it. Every
  applied, timed-out or failed step logs one JSON line (route, ms, batch size) to
  the Worker's logs, so the first real deploy measures Workers AI latency itself
  (`wrangler tail` or Workers Logs); the same route and latency are in
  `RecallDiagnostics.rerankRoute` and `rerankMs`.
- **Failure.** A thrown error, quota (3036) or capacity (3040) failure, timeout,
  or malformed, truncated or duplicate-id answer returns the un-reranked matches
  exactly. `RecallDiagnostics.rerankRoute` records what happened.
- **Cost.** One AI call, one D1 statement at hops 0 (none above), and one KV read
  for the latch per reranked recall. At the published 283 neurons per million
  input tokens the eval projects about 0.5 neurons per reranked recall on the
  expanded core-1k set (the query is counted once per pair, so this is
  conservative). Averaged over every recall in `auto`, that is about 0.4 extra AI
  calls, 0.2 neurons, 0.4 D1 statements and 18 `rows_read`.

What the persistent losers showed while the blend was tuned, on the original
338-query set (core-1k `q-para-047/043/028/042`, `q-rare-011-c`, `q-long-003`;
scale-20k `q-rare-015`; SciFact 169 and 500). For the short notes
(most of them) the excerpt the model reads is the whole note, so the model simply
disagrees: it ranks generic filler that shares a word with the query above the
right memory, and every score in those batches is a low logit (about -6 to -10),
so the percentile order is close to noise. Two causes are structural rather than
model disagreement: a note longer than the excerpt is read from its head (or a
keyword window), so `q-long-003` and SciFact 169 never show the model the sentence
that answers (it sits about 1,400 characters in); and a keyword-only exact match
that sat at the tail of the fused pool (`q-rare-032`, `q-rare-015`) was never scored,
reached the top 10 without the reranker only through MMR's diversity term, and was
displaced when the scored block was ranked above it (the keyword-evidence rule above
now scores such a match). Anchoring the excerpt at the
dense arm's best chunk was tried for the first and did not move core-1k (paraphrase
mrr@10 +0.097 either way, overall recall@10 +0.012 against +0.015), because the
answer still sits inside a 1,600-character chunk; it was not shipped.

The eval's `rerank` variant forces the mode on through the typed
`variant.rerank` flag (no route can set it); `no-rerank` pins it off,
`baseline` and `rerank-auto` are the shipped `auto`, and `rerank-auto` carries the
pre-registered target category (paraphrase only: multi-hop has no headroom, mrr@10 0.974). The ship decision is
`npm run eval:recall -- --compare no-rerank,rerank-auto --corpus core-1k --d1 workerd`
(no `--target` flag), repeated on `scale-20k` and `scifact` with
`--allow-unmeasured-rows`. On the expanded core-1k set (1,683 queries, 1,475
clusters, `workerd`) the gate passes through the overall path, which the amended
pre-registration on T-0043.6 does not accept as evidence for the reranker: MRR@10
+0.058 [0.049, 0.067], nDCG@10 +0.048 [0.041, 0.055], recall@10 +0.019 [0.012,
0.027], and no category regresses. The pre-registered paraphrase target is not met
(recall@10 +0.023 [0.007, 0.041], MRR@10 +0.005, against a +0.05 bar). The gain is
in ordering: rare-word MRR@10 0.584 to 0.858 and common-word 0.607 to 0.836. Without
the model, near-flat fused scores at the top are reordered by the recency and
importance multipliers (recency alone spans 0.6 to 1.0 for an ordinary memory),
which can move the best match below a newer or more important one; the model's
order undoes that. The reranker ships in `auto` on that basis (the decision is
recorded on T-0041), with scale-20k and SciFact as no-regression checks. A change made on top of the shipped pipeline compares with
`--compare baseline,<variant>`; one made before the reranker with
`--compare no-rerank,<variant>`. The runner fails a query, instead of scoring
the fallback order, whenever the reranker was expected and the step did not end
in a model answer or a legitimate skip, so a replay miss cannot pass as a
result. Graph-root quality with the reranker on is covered two ways: the default suite
(`test/eval/legacy-rerank.test.ts`) checks plumbing only, with a model that agrees
with the heuristic order and a scrambling one, so linked memories keep their slots
and every frozen gate holds; the quality pin against the real model (at least 14
authoritative answers and no fewer than without the reranker, at most one
authority-rank regression where the frozen gate says zero) runs only under
`EVAL_LOCAL_MODELS=1` (`npm run test:eval:local-models`). `prepare` is the only path that runs the model (locally, pinned open
weights). Real Workers AI latency and billing are unmeasured: no account is used.

## Recall eval (developer tooling)

`npm run eval:recall` lets a contributor prove that a retrieval change helps
before it ships, catch a change that quietly hurts some kind of query, and see
what the change costs in D1 statements, rows read, and AI calls. It runs the
real `recallEntries` against a fixed golden query set and ends in a
machine-checked verdict, so a reranker or a new embedding scheme ships on
measured evidence. It lives under `test/eval/` and is never part of the Worker
bundle.

**What it measures.** Real SQLite (the shipped schema, a real `entries_fts`
index, real `entry_counts`), the corpus indexed through the real write path
(`storeEntry`), and the top 10 scored per query: recall@5, recall@10, MRR@10,
and nDCG@10, overall and per category (identifier, CJK, rare word, common word,
short word, paraphrase, multi-hop, long context). Per query it also reports D1
statements, D1 `rows_read`, AI calls, neurons, and wall-clock (reported, never
gated). Neurons are projected from local token counts and the published rates,
not billed. `rows_read` is real only with `--d1 workerd`, which runs wrangler's
local workerd D1; the default `sqlite` backend cannot measure it. recall@5 is
read from the top-10 prefix, which is what production's `topK` 5 returns:
recall ranks from a fixed candidate pool (dense 15, graph seat budgets sized
for `topK` 5), diversified in blocks of five picks with each block ordered by
score, and the linked memories are placed against those blocks (the first in
the fifth place, the second at rank 10 or after the second block), never
against how many of a block's picks could be shown. **What is guaranteed:** for
one query, filters, scope and `hops` over an unchanged brain, the results of a
`topK` are the leading results of every larger `topK`, up to the API maximum
of 20, whether or not some indexed memories are hidden from the caller (an
`auto-*` or deprecated tag, another workspace, a filter, a deleted memory whose
vector is still indexed). A list can be shorter than `topK` when the picks of a
block do not all hydrate, as a `topK` 5 call always could; a larger `topK` then
continues it. When the diversified list runs out before `topK`, the rest comes
from a deeper dense query (50, the most Vectorize returns with values and
metadata), fetched only then and appended after everything else. Each recall
bumps `recall_count` on what it shows, which feeds later rankings, so two calls
made apart are only comparable if nothing was recalled between them (the eval
drops that write). `test/integration/recall-top-k-prefix.test.ts` sweeps this
over seeded corpora.

**Why the numbers can be trusted.** Runs are deterministic and need no network
and no Cloudflare account. Embeddings (and any reranker scores) come from pinned
open-weights models run locally with `@huggingface/transformers` (a dev
dependency): bge-small-en-v1.5, bge-m3, and bge-reranker-base, fetched
anonymously from Hugging Face into `.eval-cache/models/` and verified against
recorded hashes. They are computed once and stored in a content-addressed replay
cache; a cache miss during a run fails instead of computing. The committed
`core-1k` cache (8.16 MiB gzipped, 5,846 entries: chunk vectors plus the reranker's scores, which the baseline now includes, for the union of the variants the default suite replays (`COMMITTED_LAYER_VARIANTS`: LIKE embeds queries the FTS route skips), guarded by `committed-layer.test.ts`, which replays the committed layer alone; a test caps the committed layers at 9 MiB, raised from 8 because of those scores) means a contributor needs neither an account nor a model
download to run that corpus. Every cached row records which model build produced
it, and reports from different producers never compare. Vectorize is an
exact-cosine emulator, the clock is frozen, and `recall_count` writes are
dropped, so one variant on one corpus ranks every query identically on every
run. Recall makes no query-tag LLM call (hashtags and literal tag matches only),
so the `--llm-tags` arms are inert for current code. They stay because a
comparison against a commit that still made the call needs both sides on one arm,
and because any LLM call recall grows again is answered by the stand-in (a
deterministic embedding-nearest pick, agreement with a real model unmeasured) or
fails the query loudly, never silently. `--llm-tags empty` answers as if the call
failed. Both sides of a comparison must use the same arm.

**Corpora** (`npm run eval:recall -- --list` names them). `core-1k`, `scale-5k`,
and `scale-20k` share one authored, fully synthetic set of golden memories and
queries (1,733 memories and 96 long haystack rows, 1,683 queries in 1,475 independent clusters, weighted
to paraphrase, multi-hop, and long-context, because power scales with clusters;
long-context has two constructions, 220 legacy notes and 90 coherent-padding
notes tagged `subset:coherent-padding`, reported apart)
inside a seeded haystack of 656 / 4,656 / 19,656 rows (the needles come on top;
haystack rows carry a seeded importance score skewed to 2-3 and every needle an
authored one); the two larger ones push a common
token past the 500-row keyword window, which is what lets the eval tell the LIKE
and FTS keyword arms apart. `scifact` (about 5,200 abstracts, 693 judged claims)
and `miracl-ja` (about 13,500 Japanese passages, 860 queries) are public sets
for natural-language and CJK realism. `node scripts/eval-fetch-public.mjs
<scifact|miracl-ja>` downloads them into `.eval-cache/public/<id>/`, each file
pinned and verified by sha256 (miracl-ja fetches about 1 GB of shards). They are
local only: never committed, never locked, and always run with the model each
was recorded for (`scifact` with bge-small-en-v1.5, `miracl-ja` with bge-m3;
naming another model is refused). Running one before fetching fails with a
"MANIFEST.json not found" message. Licenses, for local evaluation use only and
nothing redistributed: SciFact claims are CC BY 4.0 and its abstracts ODC-By 1.0
(allenai/scifact upstream; attribution in the header of
`scripts/eval-fetch-public.mjs`); MIRACL annotations and corpus are Apache-2.0,
with passages that are Wikipedia text under CC BY-SA 4.0. There is no private
tier: nothing derived from a real brain is used. `test/eval/privacy.ts` keeps
the guards (ignore rules, an allowlist of the only files that may be tracked
under `test/eval/data/`, a canary scan, and a refusal to write any path git
would pick up) and documents how a private tier could be added without
redesigning them.

**What the golden set measures.** Read a category's number for what it counts.
Multi-hop measures root-finding: each query restates a root memory ("why did we
replace the chairs") and carries `gold = [answer grade 2, root grade 1]`. In the
locked baseline the root is in the top 10 for 150 of 150 queries and the answer
for 7 of 150, so recall@10 0.523 is about 96% "found the note the query
paraphrases" and MRR@10 0.974 leaves 0.026 of headroom against the 0.05 target
margin. Multi-hop is therefore not a valid target category for a reranker (the
`rerank` and `rerank-auto` variants declare paraphrase only), and a graph change
is judged by the answer's rank, not by this recall.

The paraphrase base rate fell when the set grew, in two steps with different
causes. The original 48 paraphrase queries scored recall@10 0.375. After the 4.8x
expansion (0f02eff) the 440 scored 0.182: the new paraphrases are harder (no
content word in common with the gold) and the collection they compete against is
far larger. It fell to 0.109 when the 90 coherent long-context notes were added,
and the cause is not on-topic distractors: a sweep of all 44 displaced queries
found at most two incidental shared words with any coherent note in their new top
ten. The cause is length. Those notes average 5,337 characters against 485 for
every other needle, and a dense retriever ranks long, diffuse text into any short
query's top ten: they held 46.9% of paraphrase top-10 slots and 0% of common-word
slots, so length itself had become a signal that a note was a needle. A
cross-encoder rejects such notes trivially, which would have inflated a
reranker's paraphrase gain. Ninety-six long, coherent haystack rows (`h-long-*`,
3,000 to 7,000 characters, mean 5,013) now balance them. On the integrated code
the long notes hold 63% of paraphrase top-10 slots (coherent needles 38.7%, long
haystack 24.2%, legacy long needles 7.8%; long-context 35.5% / 25.7% / 7.1%),
and the locked paraphrase recall@10 is 0.102. Long haystack rows are still
notes a reranker can reject, so a paraphrase gain should be read next to
`--exclude-needles 'n-lcoh-*,h-long-*'`, which reports it with both families
absent. Long-context moved for its own reasons: the original 24 notes were already
at 0.000 at 0f02eff (the 4.8x expansion, before any coherent note existed); the
220 legacy notes score 0.050 and the 90 coherent ones 0.200. The coherent notes'
answers sit in chunk 2 for 24 of them, chunk 3 for 39 and chunk 4 or later for 27,
counted with the real chunker (1,600 characters with a 200-character overlap); an
earlier report of 27 / 51 / 12 divided offsets by 1,600 and ignored the overlap.
A target gain in paraphrase is therefore measured from a base near 0.10, not
0.375, and the +0.05 target margin is a 50% relative gain.

**The overall improvement path was not evidence for T-0041 or T-0042.** The
0.02 `improvementMargin` was approved when paraphrase was 15% and long-context
7.5% of the non-gap queries. On the expanded set they are 27% and 19%, and the
overall path averages by query, so an overall +0.02 now needs an in-category
gain of about +0.075 in paraphrase and +0.106 in long-context, against +0.133
and +0.265 before: roughly half the bar for the reranker and 40% of it for
contextual embeddings. The amended pre-registration on T-0043.6 (Sep 24 2026,
written before either candidate ran on the expanded set) therefore required
each to pass through its target category (paraphrase for the reranker,
long-context for contextual embeddings) with a bootstrap lower bound above zero
and no regression in any category, and required contextual embeddings to show
no loss and a positive point estimate on the coherent-padding subset. Neither
met its target rule: the reranker shipped on a separate decision (see the
reranker section), and contextual embeddings were not shipped (below). The
candidate-pool diagnostic (gold anywhere in the fused pool, recall@30) is
printed for every category so a target FAIL can be read as "the change did not
help" or "the gold was never a candidate".

**Evaluated, not shipped: contextual chunk embeddings (T-0042).** Long notes
were indexed as smaller chunks, each embedded with a short situating line about
the note it came from, to find an answer buried deep in a long note. An early
+0.21 long-context gain came from legacy notes built of topic-free filler, which
favor such a prefix. On the balanced expanded set it did not clear its bar:
long-context recall@10 +0.029 [0.0065, 0.0548] on core-1k with the reranker on,
under the +0.05 target, and +0.016 [-0.0097, 0.042] on scale-5k (bge-small,
reranker off); the coherent-padding subset was flat. It would also have taken
more index room per long note and a background re-embedding of every existing
brain, so it was removed rather than shipped off. The write-path fixes it
carried stand on their own and remain: neighbor queries on save ask for 20 chunk
hits and keep the 5 nearest distinct notes (`WRITE_PATH_TOPK`), Vectorize
upserts and deletes go in calls of at most 1,000 (`VECTORIZE_UPSERT_BATCH`), and
the hourly cron reads config once. The index-time variant hook (`index` on a
variant, which replaces `storeEntry`) stays for the next such experiment.

**Variants.** A change under test is a variant: query-time flags on
`RecallInternalOptions` (for example `variant.arms`), config overrides, or an
index-time hook that replaces `storeEntry`. Built in: `baseline` (shipped
recall, including the reranker in its shipped `auto` mode), `no-rerank` (the same
with the reranker off), `rerank` (reranker forced on), `like` (keyword arm on the
LIKE fallback), `fts-orderless`, and the ablations `dense-only` and
`keyword-only`, which each must lose somewhere or the golden set is too easy. The
ablations run with the reranker off so each isolates one factor.

**The gate.** `npm run eval:recall -- --compare <reference>,<variant>` (`baseline` for the shipped pipeline, `no-rerank` for the one before the reranker) ends in
PASS, FAIL, or INCONCLUSIVE. Rules, in order: the two reports are comparable;
hard invariants (zero cross-workspace leaks, errors, and degraded queries);
enough queries and clusters to judge (200 and 30); no regression (no headline
metric down 0.01 or more, none significantly down at any size, and no category
down beyond its noise floor); an improvement (recall@10, MRR@10, or nDCG@10 up
0.02 with a paired cluster bootstrap interval above zero, or up 0.05 in a
category declared with `--target`); and cost within budget (at most +2 D1
statements, +25 neurons, and +1 AI call per recall, and `rows_read` within 25%
plus 50 rows). A cost-only win with flat quality FAILs the improvement rule by
design. The report prints the minimum detectable effect (MDE), 2.8 times the
standard error of the same cluster bootstrap that draws the interval, so the two
share one estimator: whole clusters are resampled and each counts by its
queries. After the verdict it prints a `losers:` list of queries
that got worse, which a mean can hide behind a few winners.

A comparison is INCONCLUSIVE, meaning not proven rather than disproven, when:
`rows_read` is unmeasured (any `sqlite` run); the paired deltas are too noisy to
show a gain of the margin's size (the bootstrap MDE exceeds it); a targeted
category or known gap has too few queries or clusters to prove a gain; or the
reports are not comparable (different corpus, model, producer, D1 backend,
isolate mode, LLM tag arm, or golden data; a missing producer or data
fingerprint; a stale runner version). `--hash-embeddings` and `--limit` runs can
never PASS. So a `sqlite` comparison is a fast quality check, and reaching PASS
needs `--d1 workerd`, or `--allow-unmeasured-rows` for a deliberately cost-blind
run that skips only the `rows_read` check.

**Known gaps.** Some queries are tagged `known-gap` (plus `gap:<id>` for the
tracked issue): failures that are documented and measured but not yet fixed. The
headline `overall` row and the category rows exclude them, because a query no
variant can answer only dilutes every delta, and the report prints a `known
gaps:` block and an `all queries` row (so `overall` and `all queries` show different n whenever a gap is tagged;
the core set currently tags none, T-0072, T-0073 and T-0074 having been fixed). Cost and the hard invariants always cover all queries.
A gap is corpus-conditional, so the gate decides by score, not by tag alone: a
gap query the baseline already answers stays in the regression rule. A variant
that claims to fix a gap declares it with `--target-gaps <id>`.

**Router guards.** Fixed gaps stay in the set as untagged guards for the keyword
router. `over-budget` queries (ten `q-budget-*`) cross `FTS_MATCH_BUDGET` on
purpose. One `correlated` query (`q-corr-001`) prices the AND tier: three words
that only co-occur, in about 800 haystack rows at 5k and 20k, with a gold newer
than those rows. Six `subset` queries (`q-sub-*`) have a gold carrying only some
of the query's tokens, each a mid-df one, which is the shape the OR tier exists
for and which the usual all-tokens rule in the audit would hide. Fusion can bury
a gold the keyword arm retrieved, so each result also records `keywordGold`
(whether any gold id was among the arm's candidates); it is a diagnostic for
router changes and is never gated. The corpus inserts rows oldest first so
rowids follow time, as on a real brain. That insertion order is set in
`corpus/build.ts`, which the golden-data fingerprint does not hash, so a change
there does not trip `--accept-data-change`; the lock's `rankedIds` (and
`keywordGold`) comparison is what catches it.

The lock only covers core-1k, where no router guard is over budget, so
`test/eval/router-guards.scale.test.ts` pins `keywordGold` for the guard queries
at scale-5k and scale-20k against `data/baselines/router-guards.json`. It needs
the local scale replay caches, so it is opt-in (`npm run
test:eval:scale-guards`) and CI cannot run it.

**Flags.** `--variant <name>` runs one variant; `--compare <a>,<b>` runs the
gate (either side may be a saved report `.json`); `--corpus <id>` (default
`core-1k`); `--d1 sqlite|workerd` (default `sqlite`); `--isolate warm|cold`
(cold resets the FTS-ready and Vectorize filter memos per query);
`--embedding-model <model>`; `--llm-tags stand-in|empty`; `--json <path>` writes
the report or comparison to a git-ignored path (never under `test/eval/data/`);
`--limit <n>` runs the first n queries and the gate refuses it;
`--hash-embeddings` uses fake vectors, for harness smoke tests only; `--target
<categories>` and `--target-gaps <ids>` (comma-separated) declare what a variant
claims to fix; `--allow-unmeasured-rows`; `--exclude-needles <glob,...>` (comparison only)
reruns both variants with the matching needles removed and prints each category's
delta beside the gate, report only; `--list`.

**Commands.** `prepare --variant <name> [--max-neurons <n>] [--concurrency <n>]`
computes and caches every missing embedding locally in three passes (dry run for
an estimate, record, then a replay pass that proves the cache is complete),
needs no credentials, and refuses to exceed `--max-neurons` (default 4000).
`export-cache` writes the committed `core-1k` replay layer from the local cache.
`stamp-cache --producer-from current|<cache file> --i-recorded-this [--layer
local|committed]` labels legacy rows of a cache with their producer, on the
operator's word alone (rows store only a hash, so it cannot be verified). `lock`
reruns the baseline on a core corpus and rewrites the committed baseline in
`test/eval/data/baselines/`; it refuses if the golden data changed since its
manifest unless `--accept-data-change "<reason>"` records the change in the
manifest history. Exit codes: 0 is PASS (or a healthy single run), 1 is FAIL (or
a single run with errors, leaks, or degraded queries), 3 is INCONCLUSIVE, and 2
is a usage or runtime error (a bad flag, a replay cache miss, a refused write, a
refused `lock`).

**The full eval is opt-in.** Replays of the golden set (`baseline-lock`, `committed-layer`,
`calibration`, `observation-passive`, and the workerd lock) take minutes each and
do not run in the default suite or on pull requests: they are gated behind
`EVAL_FULL=1` (`test/eval/full.ts`), and the workerd ones behind `EVAL_WORKERD=1`.
`npm run test:eval:full` runs everything the gates need (about 40 minutes, most of
it the workerd lock) and is run by hand before merging any ranking change; the CI
`eval-full` job runs the same thing, manual trigger only (Actions > CI > Run
workflow). The default suite keeps the fast harness check `test/eval/smoke.test.ts`
(40 queries on a synthetic corpus, a few seconds) and the privacy scan.

**Baseline lock.** A test (`test/eval/baseline-lock.test.ts`) reruns the
baseline on `core-1k` and fails if any query's ranking differs from the
committed lock, so every change to default recall ranking is deliberate: run the
comparison, run `lock`, and commit the new lock with the gate output. The lock
was recorded on `workerd`, so `test/eval/baseline-lock.workerd.test.ts` also
checks D1 statements (exactly) and `rows_read` (within 2 rows per query); it is
opt-in, run by `npm run test:eval:full` (or `test:eval:workerd` alone) and by the manual `eval-full` CI job. The
locked headline (core-1k, `workerd`, `--llm-tags stand-in`) excludes known gaps;
with no gap tagged, all 1,683 queries are in the headline: recall@5 is 0.496,
recall@10 0.535, MRR@10 0.492, and nDCG@10 0.451.

**Power.** The MDE belongs to a comparison, not to the query set, so growing the
set lowers it only as far as the comparison's own spread allows. Recall@10 MDE
on `core-1k` (1,475 clusters; it was 299), by comparison against baseline:

| comparison | overall | paraphrase | multi-hop | long-context | coherent subset | legacy 220 |
|---|---|---|---|---|---|---|
| like | 0.012 | 0.028 | 0 | 0.029 | 0.082 | 0.026 |
| dense-only | 0.039 | 0.064 | 0.029 | 0.053 | 0.133 | 0.051 |
| keyword-only | 0.014 | 0.041 | 0.023 | 0.032 | 0.090 | 0.025 |
| mild MMR change | 0.009 | 0.013 | 0 | 0.009 | 0.031 | 0 |

The sabotage, mild-recency and mild-tags rows of the table are not reported: with the
reranker in the baseline, a variant that changes candidate order asks for reranker
scores the cache does not hold (they are recorded per candidate list by `prepare
--variant <name>`), the circuit breaker opens, and the row then measures the
fallback order, not the change. Like against baseline is now a delta of -0.019
overall at core-1k rather than a tie, for the same reason.

(before, on 299 clusters: like 0.000, dense-only 0.057, keyword-only 0.049, sabotage
0.051 overall). Like against baseline at the discriminating scales was measured
before the integrated router and reranker (0.027 at `scale-5k`, 0.028 at
`scale-20k`, were 0.057 and 0.059) and has not been re-measured. The target-category rule needs +0.05
with a lower bound above zero, so it needs an MDE of 0.05 or less: a change that
moves part of paraphrase, long-context, or multi-hop clears it, and a whole-arm
ablation of paraphrase does not. The 90-cluster coherent subset cannot prove
+0.05; it is a no-loss check, not a target. `node
scripts/eval-run-ts.mjs test/eval/mde-table.ts` prints the core-1k table (add
`--corpus scale-5k --only like` for a scale row).

**FTS against LIKE at scale.** The one calibration that needs the uncommitted
`scale-5k` and `scale-20k` caches runs only by hand, never in the default suite
or CI: record the caches with `npm run eval:recall -- prepare --variant baseline
--corpus scale-5k` (and `scale-20k`; about 30 minutes each), then `EVAL_SCALE=1
npx vitest run --maxWorkers=2 test/eval/calibration.test.ts`. Measured on 5336d6d, before the
router fix and the reranker landed (re-run it by hand on the integrated code), baseline
(FTS) minus like: paraphrase recall@10 -0.0227 at `scale-5k` and at `scale-20k`,
long-context MRR@10 -0.0122 at `scale-20k`; the regression rule fails on them and
the lexical categories win by 0.05 to 0.6. The test pins exactly that, so a change
that closes the gap forces a deliberate re-record.

**How long it takes.** A `core-1k` comparison takes under a minute on `sqlite`
and several minutes on `workerd` (about 25 on a heavily shared machine), which runs each query against a real local D1.
A cold `prepare` for `scale-20k` takes about 25 minutes locally. `npm run
test:eval:workerd` runs the workerd-backed tests alone (including the workerd lock
tripwire), which the default suite skips; `npm run test:eval:public-download`
and `npm run test:eval:local-models` are the other opt-in checks.

## Tests

Tests import the worker default export only from `src/index`. Functions and types import from domain modules (e.g. `src/capture/entry`, `src/env`).
