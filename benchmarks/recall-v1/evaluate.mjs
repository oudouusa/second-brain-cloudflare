import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = resolve(HERE, "corpus.json");
const EVIDENCE_MANIFEST = resolve(HERE, "evidence-manifest.json");

export const PROFILES = Object.freeze({
  bge384: Object.freeze({
    profileId: "bge-small-en-v1.5-384-baseline",
    model: "@cf/baai/bge-small-en-v1.5",
    rawDimensions: 384,
    dimensions: 384,
    promptVersion: 0,
    queryInput: query => query,
    documentInput: document => document.text,
  }),
  "embeddinggemma-mrl128-v1": Object.freeze({
    profileId: "embeddinggemma-mrl128-v1",
    model: "@cf/google/embeddinggemma-300m",
    rawDimensions: 768,
    dimensions: 128,
    promptVersion: 1,
    queryInput: query => `task: search result | query: ${query}`,
    // Production entries currently have no title column. The corpus title is
    // an evaluator label, not memory data, so embedding it would measure a
    // richer input than the Worker actually stores.
    documentInput: document => `title: none | text: ${document.text}`,
  }),
});

function fail(message) {
  throw new Error(`recall corpus: ${message}`);
}

export function validateCorpus(corpus) {
  if (corpus?.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!Array.isArray(corpus.documents) || !Array.isArray(corpus.queries)) fail("documents and queries must be arrays");

  const documentIds = new Set();
  for (const document of corpus.documents) {
    if (!document?.id || documentIds.has(document.id)) fail(`duplicate or empty document id: ${document?.id}`);
    if (!["ja", "mixed", "identifier"].includes(document.category)) fail(`invalid document category: ${document.id}`);
    if (typeof document.title !== "string" || typeof document.text !== "string" || !document.text.trim()) fail(`invalid document text: ${document.id}`);
    documentIds.add(document.id);
  }

  const queryIds = new Set();
  for (const query of corpus.queries) {
    if (!query?.id || queryIds.has(query.id)) fail(`duplicate or empty query id: ${query?.id}`);
    if (!["ja", "mixed", "identifier"].includes(query.category)) fail(`invalid query category: ${query.id}`);
    if (typeof query.query !== "string" || !query.query.trim()) fail(`invalid query text: ${query.id}`);
    if (!Array.isArray(query.relevantIds) || !query.relevantIds.length) fail(`missing relevantIds: ${query.id}`);
    for (const id of query.relevantIds) if (!documentIds.has(id)) fail(`unknown relevant document ${id}: ${query.id}`);
    queryIds.add(query.id);
  }

  const counts = Object.fromEntries(["ja", "mixed", "identifier"].map(category => [
    category,
    corpus.queries.filter(query => query.category === category).length,
  ]));
  if (corpus.queries.length !== 60 || counts.ja !== 30 || counts.mixed !== 15 || counts.identifier !== 15) {
    fail(`expected 60 queries (ja=30, mixed=15, identifier=15), got ${JSON.stringify(counts)}`);
  }
  const mustPass = corpus.queries.filter(query => query.mustPass).length;
  if (mustPass < 20) fail(`expected at least 20 must-pass queries, got ${mustPass}`);
  return { documents: corpus.documents.length, queries: corpus.queries.length, categories: counts, mustPass };
}

export function normalizeAndProject(vector, profile) {
  if (!Array.isArray(vector) || vector.length !== profile.rawDimensions) {
    throw new Error(`embedding dimension mismatch for ${profile.profileId}: expected ${profile.rawDimensions}, got ${vector?.length ?? "non-array"}`);
  }
  const projected = vector.slice(0, profile.dimensions);
  let squaredNorm = 0;
  for (const value of projected) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`non-finite embedding value for ${profile.profileId}`);
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm);
  if (!Number.isFinite(norm) || norm <= Number.EPSILON) throw new Error(`zero-norm embedding for ${profile.profileId}`);
  return projected.map(value => value / norm);
}

export function cosineNormalized(a, b) {
  if (a.length !== b.length) throw new Error(`cosine dimension mismatch: ${a.length} != ${b.length}`);
  let score = 0;
  for (let i = 0; i < a.length; i++) score += a[i] * b[i];
  return score;
}

export async function requestEmbeddings(endpoint, texts, profile) {
  const vectors = [];
  for (let offset = 0; offset < texts.length; offset += 16) {
    const batch = texts.slice(offset, offset + 16);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: profile.model, texts: batch }),
    });
    if (!response.ok) throw new Error(`embedding endpoint returned ${response.status}: ${await response.text()}`);
    const body = await response.json();
    if (!Array.isArray(body?.data) || body.data.length !== batch.length) {
      throw new Error(`embedding endpoint returned ${body?.data?.length ?? "invalid"} vectors for a batch of ${batch.length}`);
    }
    vectors.push(...body.data.map(vector => normalizeAndProject(vector, profile)));
  }
  return vectors;
}

function metricSummary(results) {
  if (!results.length) return { queries: 0, recallAt1: 0, recallAt5: 0, mrr: 0 };
  // rank 0 is the no-hit sentinel, not a successful top-k result.
  const sum = results.reduce((acc, result) => ({
    at1: acc.at1 + (result.rank === 1 ? 1 : 0),
    at5: acc.at5 + (result.rank > 0 && result.rank <= 5 ? 1 : 0),
    reciprocalRank: acc.reciprocalRank + (result.rank ? 1 / result.rank : 0),
  }), { at1: 0, at5: 0, reciprocalRank: 0 });
  return {
    queries: results.length,
    recallAt1: Number((sum.at1 / results.length).toFixed(6)),
    recallAt5: Number((sum.at5 / results.length).toFixed(6)),
    mrr: Number((sum.reciprocalRank / results.length).toFixed(6)),
  };
}

export function summarizeResults(results) {
  const categories = Object.fromEntries(["ja", "mixed", "identifier"].map(category => [
    category,
    metricSummary(results.filter(result => result.category === category)),
  ]));
  const mustPassResults = results.filter(result => result.mustPass);
  return {
    overall: metricSummary(results),
    categories,
    mustPass: {
      ...metricSummary(mustPassResults),
      passedTop5: mustPassResults.filter(result => result.rank > 0 && result.rank <= 5).length,
      required: mustPassResults.length,
    },
  };
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function validateCommittedEvidence(corpus, corpusSha256) {
  const manifest = JSON.parse(await readFile(EVIDENCE_MANIFEST, "utf8"));
  const documentIds = new Set(corpus.documents.map(document => document.id));
  if (manifest?.schemaVersion !== 1 || !manifest.files || typeof manifest.files !== "object") {
    fail("invalid evidence-manifest.json");
  }
  for (const [name, expectedSha] of Object.entries(manifest.files)) {
    const actualSha = await sha256File(resolve(HERE, name));
    if (actualSha !== expectedSha) fail(`evidence SHA mismatch: ${name}`);
  }

  for (const [profileName, filename] of [
    ["bge384", "results-bge384.json"],
    ["embeddinggemma-mrl128-v1", "results-embeddinggemma-mrl128-v1.json"],
  ]) {
    const report = JSON.parse(await readFile(resolve(HERE, filename), "utf8"));
    const profile = PROFILES[profileName];
    if (report.corpusSha256 !== corpusSha256 || report.benchmark !== corpus.name) {
      fail(`stale corpus reference: ${filename}`);
    }
    for (const key of ["profileId", "model", "rawDimensions", "dimensions", "promptVersion"]) {
      if (report.profile?.[key] !== profile[key]) fail(`profile mismatch ${key}: ${filename}`);
    }
    if (!Array.isArray(report.results) || report.results.length !== corpus.queries.length) {
      fail(`result count mismatch: ${filename}`);
    }
    const queries = new Map(corpus.queries.map(query => [query.id, query]));
    const resultIds = new Set();
    for (const result of report.results) {
      const query = queries.get(result.id);
      if (!query || resultIds.has(result.id) || result.category !== query.category
        || result.query !== query.query
        || JSON.stringify(result.relevantIds) !== JSON.stringify(query.relevantIds)
        || Boolean(result.mustPass) !== Boolean(query.mustPass)
        || !Number.isInteger(result.rank) || result.rank < 0) {
        fail(`invalid result row ${result.id}: ${filename}`);
      }
      resultIds.add(result.id);
      if (!Array.isArray(result.top5) || result.top5.length > 5
        || new Set(result.top5.map(row => row?.id)).size !== result.top5.length
        || result.top5.some((row, index) => !documentIds.has(row?.id)
          || typeof row.score !== "number" || !Number.isFinite(row.score)
          || (index > 0 && row.score > result.top5[index - 1].score))) {
        fail(`invalid top5 ${result.id}: ${filename}`);
      }
      const firstRelevant = result.top5.findIndex(row => query.relevantIds.includes(row.id));
      if ((result.rank >= 1 && result.rank <= 5 && firstRelevant + 1 !== result.rank)
        || (result.rank === 0 && firstRelevant !== -1)
        || (result.rank > 5 && firstRelevant !== -1)) {
        fail(`rank/top5 mismatch ${result.id}: ${filename}`);
      }
    }
    if (resultIds.size !== queries.size || [...queries.keys()].some(id => !resultIds.has(id))) {
      fail(`result id coverage mismatch: ${filename}`);
    }
    if (JSON.stringify(report.metrics) !== JSON.stringify(summarizeResults(report.results))) {
      fail(`metrics do not recompute from results: ${filename}`);
    }
  }

  const thresholdCorpusSha = await sha256File(resolve(HERE, "threshold-corpus.json"));
  const thresholds = JSON.parse(await readFile(resolve(HERE, "thresholds-embeddinggemma-mrl128-v1.json"), "utf8"));
  if (thresholds.corpusSha256 !== corpusSha256 || thresholds.calibrationSha256 !== thresholdCorpusSha) {
    fail("threshold evidence references stale corpus");
  }
  const inputLimits = JSON.parse(await readFile(resolve(HERE, "input-limits-embeddinggemma-mrl128-v1.json"), "utf8"));
  if (inputLimits.profile?.profileId !== PROFILES["embeddinggemma-mrl128-v1"].profileId
    || !Array.isArray(inputLimits.lengths) || inputLimits.lengths.length === 0) {
    fail("input-limit evidence is invalid");
  }
  return { evidenceFiles: Object.keys(manifest.files).length };
}

export async function evaluate({ corpus, endpoint, profile, corpusSha256 }) {
  const documentVectors = await requestEmbeddings(
    endpoint,
    corpus.documents.map(document => profile.documentInput(document)),
    profile,
  );
  const queryVectors = await requestEmbeddings(
    endpoint,
    corpus.queries.map(query => profile.queryInput(query.query)),
    profile,
  );

  const results = corpus.queries.map((query, queryIndex) => {
    const ranked = corpus.documents
      .map((document, documentIndex) => ({
        id: document.id,
        score: cosineNormalized(queryVectors[queryIndex], documentVectors[documentIndex]),
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const relevant = new Set(query.relevantIds);
    const firstRelevantIndex = ranked.findIndex(item => relevant.has(item.id));
    return {
      id: query.id,
      category: query.category,
      query: query.query,
      relevantIds: query.relevantIds,
      mustPass: Boolean(query.mustPass),
      rank: firstRelevantIndex < 0 ? 0 : firstRelevantIndex + 1,
      top5: ranked.slice(0, 5).map(item => ({ id: item.id, score: Number(item.score.toFixed(6)) })),
    };
  });

  return {
    schemaVersion: 1,
    benchmark: corpus.name,
    corpusSha256,
    generatedAt: new Date().toISOString(),
    profile: {
      profileId: profile.profileId,
      model: profile.model,
      rawDimensions: profile.rawDimensions,
      dimensions: profile.dimensions,
      promptVersion: profile.promptVersion,
    },
    metrics: summarizeResults(results),
    results,
  };
}

function parseArgs(argv) {
  const args = { corpus: DEFAULT_CORPUS, profile: "bge384", validateOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--validate-only") args.validateOnly = true;
    else if (["--corpus", "--profile", "--endpoint", "--output"].includes(value)) args[value.slice(2)] = argv[++i];
    else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpusPath = resolve(args.corpus);
  const raw = await readFile(corpusPath);
  const corpus = JSON.parse(raw.toString("utf8"));
  const summary = validateCorpus(corpus);
  if (args.validateOnly) {
    const evidence = await validateCommittedEvidence(
      corpus,
      createHash("sha256").update(raw).digest("hex"),
    );
    console.log(JSON.stringify({ ...summary, ...evidence }, null, 2));
    return;
  }
  const profile = PROFILES[args.profile];
  if (!profile) throw new Error(`unknown profile: ${args.profile}`);
  if (!args.endpoint) throw new Error("--endpoint is required unless --validate-only is used");
  const report = await evaluate({
    corpus,
    endpoint: args.endpoint,
    profile,
    corpusSha256: createHash("sha256").update(raw).digest("hex"),
  });
  const output = resolve(args.output ?? resolve(HERE, `results-${args.profile}.json`));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, metrics: report.metrics }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
