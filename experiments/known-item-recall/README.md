# Local known-item recall replay harness

Reproduce rankings of known items in `queries.json` from a D1 snapshot, all Vectorize vectors, saved KV query signals, and settings. Record mode collects signal inputs required by current `src/`; replay mode uses those signals to run `recallEntries()` with `topK=5`, `hops=0`, and `synthesize=false`. Alongside ranks, record fusion, temporal and other reranking, MMR, rendered ID order, SQL-statement counts, and bind counts. This includes no experimental ranking changes.

Execution uses local SQLite and a JSON-backed Vectorize stub. A D1 export without FTS reproduces the LIKE path. It cannot measure actual Vectorize candidate order, FTS-enabled results, Cloudflare CPU, latency, or D1 billed `rows_read`. `d1Statements` counts SQLite-facade statements, not D1 billed rows or subrequests. Fixtures and outputs contain private memories, IDs, queries, and numeric vectors; store them only in restricted directories outside the repository. Do not give AUTH_TOKEN to the harness or an external model.

## Creating fixtures

Create `<fixtures-dir>` outside the repository. These are read-only steps for the owner to perform in their own environment; the harness does not connect remotely.

1. Enumerate target D1 tables and export each with `wrangler d1 export --table` into `<fixtures-dir>/db.sql`. Full-database export fails on FTS5 virtual tables. Exclude `entries_fts*` (virtual and internal tables), `entry_counts`, and `schema_meta`. See [DEPLOYMENT.md](../../docs/fork/DEPLOYMENT.md) for recovery considerations. The enumeration query is:

   ```sql
   SELECT name FROM sqlite_master
   WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
     AND name NOT LIKE 'entries_fts%'
     AND name NOT IN ('entry_counts', 'schema_meta')
   ORDER BY name;
   ```

   ```sh
   npx --yes wrangler@4.126.0 d1 export '<database>' --remote --profile '<profile>' \
     --table '<table-1>' --table '<table-2>' --output '<fixtures-dir>/db.sql'
   ```

   Pass every enumerated target table. The harness rebuilds only missing `entry_counts` from `entries` in in-memory SQLite; it does not create `schema_meta` or FTS. If a snapshot already includes `entry_counts`, compare its count against `entries`.

2. Read every JSON array in `entries.vector_ids`, deduplicate IDs, and retrieve all of them with the Vectorize `get_by_ids` API in batches within its per-request limit. After verifying every ID, save `[{"id":"...","values":[...],"metadata":{...}}]` to `<fixtures-dir>/vectors.json`. Do not silently ignore missing IDs. Retain metadata `workspace_id` and `parentId`.
3. List/read KV `recall:query-signals:v1:*` and save `{"<KV key>": <parsed JSON value>}` to `<fixtures-dir>/query-signal-cache.json`. Save `config:overrides` to `<fixtures-dir>/config-overrides.json`, or JSON `null` when absent. Neither file should contain secret tokens.
4. Create `<fixtures-dir>/queries.json` as `[{"category":"<category>","query":"<query text>","term":"<target term>","target":"<entries.id>"}]`. Run record mode to produce `signals-inputs-<run-id>.json`. Each record's `keyMaterial` has the same field order as the string production `cacheKey()` supplies to HMAC.
5. **The owner locally** computes HMAC-SHA256 of each `keyMaterial` using AUTH_TOKEN, mapping KV values to `canonicalInput` in `signals-by-input.json` in the fixture directory's parent. The short Node.js example below reads the token from an environment variable or systemd-creds `CREDENTIALS_DIRECTORY/AUTH_TOKEN`. Keep both script and token outside the repository. Do not pass the token in command arguments, to the harness, or to external models. Do not invent missing signals; replay reports `missing-signal`.

   ```js
   import { createHmac } from 'node:crypto';
   import { readFileSync, writeFileSync } from 'node:fs';
   import { join } from 'node:path';

   const [inputsPath, cachePath, outputPath] = process.argv.slice(2);
   if (!inputsPath || !cachePath || !outputPath) throw new Error('input, cache, output paths required');
   const token = process.env.AUTH_TOKEN ?? (process.env.CREDENTIALS_DIRECTORY
     ? readFileSync(join(process.env.CREDENTIALS_DIRECTORY, 'AUTH_TOKEN'), 'utf8').trimEnd()
     : '');
   if (!token) throw new Error('AUTH_TOKEN or systemd credential required');
   const records = JSON.parse(readFileSync(inputsPath, 'utf8')).records;
   const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
   const signals = {};
   for (const record of records) {
     const key = 'recall:query-signals:v1:'
       + createHmac('sha256', token).update(record.keyMaterial).digest('hex');
     const raw = cache[key];
     if (raw === undefined) continue;
     const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
     if (value.version !== 1 || !Array.isArray(value.values) || value.values.length !== 128
       || !Array.isArray(value.queryTags)) throw new Error('Invalid cached signal');
     signals[record.canonicalInput] = { values: value.values, queryTags: value.queryTags };
   }
   writeFileSync(outputPath, JSON.stringify(signals, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
   ```

   After computing the mapping, remove `AUTH_TOKEN` from the shell before running the harness.

6. Run replay mode. If saved signals do not match current code inputs, report `missing-signal` without guessing or re-embedding. Workers AI and CLIProxy are stubbed to throw if called.

Select target terms in `queries.json` by scanning readable `entries` with the tokenizer's normalization and choosing terms with document frequency `df=1`. Record queries in their production form and use that unique row's ID as `target`. Include two-character terms, longer words, identifiers, and compounds to expose candidate-generation differences. Do not put actual terms or IDs in the repository.

## Running

```sh
KNOWN_ITEM_FIXTURES='<fixtures-dir>' KNOWN_ITEM_NOW='<ISO-8601-timestamp>' \
KNOWN_ITEM_MODE=record KNOWN_ITEM_RUN_ID='<run-id>' \
npx vitest run --config experiments/known-item-recall/vitest.config.ts \
  experiments/known-item-recall/record-replay.test.ts

KNOWN_ITEM_FIXTURES='<fixtures-dir>' KNOWN_ITEM_NOW='<ISO-8601-timestamp>' \
KNOWN_ITEM_MODE=replay KNOWN_ITEM_RUN_ID='<run-id>' \
npx vitest run --config experiments/known-item-recall/vitest.config.ts \
  experiments/known-item-recall/record-replay.test.ts

npx vitest run --config experiments/known-item-recall/vitest.config.ts \
  experiments/known-item-recall/vectorize-fixture.test.ts
```

`KNOWN_ITEM_NOW` is a required ISO 8601 timestamp with timezone. `KNOWN_ITEM_RUN_ID` distinguishes output names, created with `wx` to prevent overwrites. Record output is `signals-inputs-<run-id>.json` in the fixture parent; replay output is `replay-results-<run-id>.json`. Replay reads the record with the same run ID unless `KNOWN_ITEM_INPUT_RUN_ID=<record-run-id>` selects another. Omitting run ID uses names without a suffix.

The default D1 filename is `db.sql`; use `KNOWN_ITEM_DB_FILE=<filename.sql>` for another snapshot name. Optional `KNOWN_ITEM_PLAN_QUERIES=<query-1>,<query-2>` records SQLite `EXPLAIN QUERY PLAN` for those candidate SELECTs in `candidatePlans`. Plan queries are excluded from recall's `d1Statements`. Queries containing commas cannot be selected with this format.

Replay output includes `diagnostics`, `trace` (`distill`, `fusion`, `rerank`, `mmr`), final `ids` and `renderedIds`, `d1Statements`, `d1CorpusStatements`, and candidate SELECT `candidateBindings`. Traces/outputs contain private queries and IDs; keep them out of Git. Vectorize-stub unit tests require no fixtures or environment variables. Normal `vitest.config.ts` excludes `experiments/**`, and `tsconfig.json` targets `src` and `test`, so this harness is outside normal CI tests/typechecking.

Historical prototypes and measurements are documented in the investigation report `report.md` outside the repository and commit `b2ea5bd` on research branch `investigate/known-item-ranking-20260925`.
