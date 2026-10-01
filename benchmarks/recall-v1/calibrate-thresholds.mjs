import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PROFILES,
  cosineNormalized,
  requestEmbeddings,
  validateCorpus,
} from "./evaluate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LABELS = ["exact_duplicate", "near_duplicate", "related", "unrelated"];

export function validateThresholdCorpus(calibration, documents) {
  if (calibration?.schemaVersion !== 1 || !Array.isArray(calibration.cases)) {
    throw new Error("threshold corpus schemaVersion must be 1 and cases must be an array");
  }
  const documentIds = new Set(documents.map(document => document.id));
  const ids = new Set();
  for (const item of calibration.cases) {
    if (!item?.id || ids.has(item.id)) throw new Error(`duplicate or empty threshold case id: ${item?.id}`);
    if (!LABELS.includes(item.label)) throw new Error(`invalid threshold label: ${item.id}`);
    for (const side of ["left", "right"]) {
      const id = item[`${side}Id`];
      const candidateText = item[`${side}Text`];
      if ((typeof id === "string") === (typeof candidateText === "string")) {
        throw new Error(`${item.id} must have exactly one of ${side}Id or ${side}Text`);
      }
      if (id && !documentIds.has(id)) throw new Error(`unknown ${side}Id ${id}: ${item.id}`);
      if (typeof candidateText === "string" && !candidateText.trim()) throw new Error(`empty ${side}Text: ${item.id}`);
    }
    ids.add(item.id);
  }
  const counts = Object.fromEntries(LABELS.map(label => [label, calibration.cases.filter(item => item.label === label).length]));
  if (calibration.cases.length !== 40 || Object.values(counts).some(count => count !== 10)) {
    throw new Error(`expected 10 cases per label, got ${JSON.stringify(counts)}`);
  }
  return { cases: calibration.cases.length, labels: counts };
}

function quantile(sorted, fraction) {
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: Number(quantile(sorted, 0).toFixed(6)),
    p25: Number(quantile(sorted, 0.25).toFixed(6)),
    median: Number(quantile(sorted, 0.5).toFixed(6)),
    p75: Number(quantile(sorted, 0.75).toFixed(6)),
    max: Number(quantile(sorted, 1).toFixed(6)),
  };
}

function bestThreshold(positive, negative) {
  const scores = [...new Set([...positive, ...negative])].sort((a, b) => a - b);
  const candidates = [0, ...scores.map((score, index) => index === scores.length - 1 ? score : (score + scores[index + 1]) / 2), 1];
  let best;
  for (const threshold of candidates) {
    const truePositive = positive.filter(score => score >= threshold).length;
    const falseNegative = positive.length - truePositive;
    const falsePositive = negative.filter(score => score >= threshold).length;
    const trueNegative = negative.length - falsePositive;
    const balancedAccuracy = ((truePositive / positive.length) + (trueNegative / negative.length)) / 2;
    const candidate = { threshold, balancedAccuracy, truePositive, falseNegative, falsePositive, trueNegative };
    if (!best || candidate.balancedAccuracy > best.balancedAccuracy
      || (candidate.balancedAccuracy === best.balancedAccuracy && candidate.falsePositive < best.falsePositive)
      || (candidate.balancedAccuracy === best.balancedAccuracy && candidate.falsePositive === best.falsePositive && candidate.threshold > best.threshold)) {
      best = candidate;
    }
  }
  return {
    threshold: Number(best.threshold.toFixed(6)),
    balancedAccuracy: Number(best.balancedAccuracy.toFixed(6)),
    confusion: {
      truePositive: best.truePositive,
      falseNegative: best.falseNegative,
      falsePositive: best.falsePositive,
      trueNegative: best.trueNegative,
    },
  };
}

export async function calibrate({ corpus, calibration, endpoint, profile, corpusSha256, calibrationSha256 }) {
  const documents = new Map(corpus.documents.map(document => [document.id, document.text]));
  const textOf = (item, side) => item[`${side}Text`] ?? documents.get(item[`${side}Id`]);
  const inputs = [...new Set(calibration.cases.flatMap(item => [textOf(item, "left"), textOf(item, "right")]))];
  const vectors = await requestEmbeddings(endpoint, inputs.map(value => `title: none | text: ${value}`), profile);
  const vectorByText = new Map(inputs.map((value, index) => [value, vectors[index]]));
  const cases = calibration.cases.map(item => ({
    id: item.id,
    label: item.label,
    score: Number(cosineNormalized(vectorByText.get(textOf(item, "left")), vectorByText.get(textOf(item, "right"))).toFixed(6)),
  }));
  const scores = Object.fromEntries(LABELS.map(label => [label, cases.filter(item => item.label === label).map(item => item.score)]));
  return {
    schemaVersion: 1,
    benchmark: calibration.name,
    corpusSha256,
    calibrationSha256,
    generatedAt: new Date().toISOString(),
    profile: {
      profileId: profile.profileId,
      model: profile.model,
      rawDimensions: profile.rawDimensions,
      dimensions: profile.dimensions,
      promptVersion: profile.promptVersion,
    },
    distributions: Object.fromEntries(LABELS.map(label => [label, distribution(scores[label])])),
    recommendations: {
      duplicateBlock: bestThreshold(scores.exact_duplicate, [...scores.near_duplicate, ...scores.related, ...scores.unrelated]),
      duplicateFlag: bestThreshold([...scores.exact_duplicate, ...scores.near_duplicate], [...scores.related, ...scores.unrelated]),
      graphRelated: bestThreshold([...scores.exact_duplicate, ...scores.near_duplicate, ...scores.related], scores.unrelated),
      insightEvolution: bestThreshold(scores.near_duplicate, [...scores.related, ...scores.unrelated]),
    },
    cases,
  };
}

function parseArgs(argv) {
  const args = {
    corpus: resolve(HERE, "corpus.json"),
    calibration: resolve(HERE, "threshold-corpus.json"),
    profile: "embeddinggemma-mrl128-v1",
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (["--corpus", "--calibration", "--profile", "--endpoint", "--output"].includes(value)) args[value.slice(2)] = argv[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.endpoint) throw new Error("--endpoint is required");
  const [corpusRaw, calibrationRaw] = await Promise.all([readFile(resolve(args.corpus)), readFile(resolve(args.calibration))]);
  const corpus = JSON.parse(corpusRaw.toString("utf8"));
  const calibration = JSON.parse(calibrationRaw.toString("utf8"));
  validateCorpus(corpus);
  validateThresholdCorpus(calibration, corpus.documents);
  const profile = PROFILES[args.profile];
  if (!profile) throw new Error(`unknown profile: ${args.profile}`);
  const report = await calibrate({
    corpus,
    calibration,
    endpoint: args.endpoint,
    profile,
    corpusSha256: createHash("sha256").update(corpusRaw).digest("hex"),
    calibrationSha256: createHash("sha256").update(calibrationRaw).digest("hex"),
  });
  const output = resolve(args.output ?? resolve(HERE, `thresholds-${args.profile}.json`));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, distributions: report.distributions, recommendations: report.recommendations }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
