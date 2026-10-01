import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROFILES, cosineNormalized, normalizeAndProject } from "./evaluate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = PROFILES["embeddinggemma-mrl128-v1"];

function repeatTo(text, length) {
  return text.repeat(Math.ceil(length / text.length)).slice(0, length);
}

const LENGTH_CASES = [
  ["ja-320", repeatTo("記憶検索の入力長を確認する。", 320)],
  ["ja-400", repeatTo("記憶検索の入力長を確認する。", 400)],
  ["ja-450", repeatTo("記憶検索の入力長を確認する。", 450)],
  ["ja-480", repeatTo("記憶検索の入力長を確認する。", 480)],
  ["ja-500", repeatTo("記憶検索の入力長を確認する。", 500)],
  ["ja-1000", repeatTo("記憶検索の入力長を確認する。", 1000)],
  ["ja-1600", repeatTo("記憶検索の入力長を確認する。", 1600)],
  ["en-1600", repeatTo("Cloudflare embedding input length probe. ", 1600)],
  ["code-1600", repeatTo("interface MemoryTier { value: hot | warm | cold; }\n", 1600)],
];

const SENSITIVITY_CASES = [
  ["ja-500", "共通の記憶本文。", "末尾アルファ。", "末尾ベータ。", 400, 100],
  ["ja-1000", "共通の記憶本文。", "末尾アルファ。", "末尾ベータ。", 500, 500],
  ["ja-1600", "共通の記憶本文。", "末尾アルファ。", "末尾ベータ。", 1000, 600],
  ["en-1600", "Shared memory prefix for embedding. ", "Alpha suffix content. ", "Beta suffix content. ", 1200, 400],
  ["code-1600", "const sharedMemoryValue = 42;\n", "const alphaSuffix = true;\n", "const betaSuffix = false;\n", 1200, 400],
];

async function embed(endpoint, texts) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: PROFILE.model, texts: texts.map(text => `title: none | text: ${text}`) }),
  });
  const body = await response.json();
  if (!response.ok || !Array.isArray(body?.data)) {
    return { ok: false, status: response.status, error: body?.error, codes: body?.codes };
  }
  return { ok: true, status: response.status, vectors: body.data };
}

export async function probe(endpoint) {
  const lengths = [];
  for (const [id, value] of LENGTH_CASES) {
    const result = await embed(endpoint, [value]);
    lengths.push(result.ok
      ? { id, chars: value.length, status: result.status, dimensions: result.vectors[0]?.length }
      : { id, chars: value.length, status: result.status, error: result.error, codes: result.codes });
  }

  const suffixSensitivity = [];
  for (const [id, prefixUnit, suffixAUnit, suffixBUnit, prefixChars, suffixChars] of SENSITIVITY_CASES) {
    const prefix = repeatTo(prefixUnit, prefixChars);
    const result = await embed(endpoint, [
      prefix + repeatTo(suffixAUnit, suffixChars),
      prefix + repeatTo(suffixBUnit, suffixChars),
    ]);
    if (!result.ok) {
      suffixSensitivity.push({ id, chars: prefixChars + suffixChars, status: result.status, error: result.error, codes: result.codes });
      continue;
    }
    const a = normalizeAndProject(result.vectors[0], PROFILE);
    const b = normalizeAndProject(result.vectors[1], PROFILE);
    suffixSensitivity.push({
      id,
      chars: prefixChars + suffixChars,
      status: result.status,
      cosine128: Number(cosineNormalized(a, b).toFixed(9)),
      suffixInfluencedEmbedding: a.some((value, index) => Math.abs(value - b[index]) > 1e-9),
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profile: {
      profileId: PROFILE.profileId,
      model: PROFILE.model,
      rawDimensions: PROFILE.rawDimensions,
      dimensions: PROFILE.dimensions,
      promptVersion: PROFILE.promptVersion,
    },
    lengths,
    suffixSensitivity,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (["--endpoint", "--output"].includes(value)) args[value.slice(2)] = argv[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.endpoint) throw new Error("--endpoint is required");
  const report = await probe(args.endpoint);
  const output = resolve(args.output ?? resolve(HERE, "input-limits-embeddinggemma-mrl128-v1.json"));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, lengths: report.lengths, suffixSensitivity: report.suffixSensitivity }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
