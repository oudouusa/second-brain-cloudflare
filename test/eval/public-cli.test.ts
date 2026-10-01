// The CLI wired to the public corpora, on neutral fixtures: no download, no network.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanTemp } from "../helpers/tmp";
import { DEFAULTS } from "../../src/config";

// 公開corpusのBGE固定契約は、実行時Gemma128固定のforkでは満たせない。
// parser・privacy・cacheの検証は残し、モデルを実行する3試験だけを除外する。
const incompatiblePublicModel = String(DEFAULTS.EMBEDDING_MODEL).includes("embeddinggemma");

afterAll(cleanTemp);

// Local inference is replaced by a stub: no model is downloaded or run here.
vi.mock("./local-ai", async orig => ({
  ...(await orig<typeof import("./local-ai")>()),
  makeLocalAi: () => ({
    run: async (_model: string, input: unknown) => {
      const { text } = input as { text: string[] };
      return { shape: [text.length, 384], data: text.map(() => Array.from({ length: 384 }, (_, i) => (i % 7) / 7)), usage: { prompt_tokens: 4, total_tokens: 4 } };
    },
    producer: () => ({ kind: "local-transformers-js", library: "@huggingface/transformers", libraryVersion: "0", onnxRuntime: "onnxruntime-node@0", repo: "stub/stub", revision: "0", dtype: "fp32" }),
  }),
}));

const REAL_REPO = resolve(import.meta.dirname, "../..");
let root: string;
let cli: typeof import("./cli");
let corpora: typeof import("./corpora");

/** Neutral layout as the fetch script writes it, including MANIFEST.json. */
function fixture(id: string, docs = 30) {
  const dir = join(root, ".eval-cache", "public", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "corpus.jsonl"), Array.from({ length: docs }, (_, i) => JSON.stringify({ id: `d${i}`, text: `document ${i} about topic ${i % 5}` })).join("\n"));
  writeFileSync(join(dir, "queries.jsonl"), ["q1", "q2"].map(q => JSON.stringify({ id: q, text: `question about ${q}` })).join("\n"));
  writeFileSync(join(dir, "qrels.tsv"), "query-id\tcorpus-id\tscore\nq1\td3\t1\nq2\td4\t1\n");
  const derived = Object.fromEntries(["corpus.jsonl", "queries.jsonl", "qrels.tsv"].map(f => [f, createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")]));
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ derived }));
  return derived;
}

const capture = () => {
  const out: string[] = [], err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...a) => { err.push(a.join(" ")); });
  return { out, err, restore: () => { log.mockRestore(); error.mockRestore(); } };
};
const scratch = () => join(mkdtempSync(join(tmpdir(), "public-cli-")), "r.json");

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "public-root-"));
  mkdirSync(join(root, "test/eval/data/core"), { recursive: true });
  mkdirSync(join(root, "db"), { recursive: true });
  copyFileSync(join(REAL_REPO, "db/schema.sql"), join(root, "db/schema.sql")); // the sqlite backend reads the schema under SB_EVAL_ROOT
  copyFileSync(join(REAL_REPO, "db/fork-write-protection.sql"), join(root, "db/fork-write-protection.sql"));
  fixture("scifact");
  vi.stubEnv("SB_EVAL_ROOT", root);
  vi.resetModules();
  corpora = await import("./corpora");
  cli = await import("./cli");
});
afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("public corpora in the registry", () => {
  it("--list names them", async () => {
    const c = capture();
    try { expect(await cli.main(["--list"])).toBe(0); } finally { c.restore(); }
    expect(c.out.join("\n")).toMatch(/corpora: .*scifact.*miracl-ja/);
  });

  it("resolves a fetched corpus and carries the derived-manifest hashes as its fingerprint", async () => {
    const spec = await corpora.resolveCorpus("scifact");
    expect(spec.intent).toBe("discriminate");
    expect(spec.dataFingerprint).toEqual(fixture("scifact"));
  });
});

describe("embedding model defaults", () => {
  it("defaults from the corpus and leaves core corpora on the shipped model", async () => {
    const { DEFAULTS } = await import("../../src/config");
    expect(cli.parseCli(["--variant", "baseline", "--corpus", "scifact"])).toMatchObject({ model: "@cf/baai/bge-small-en-v1.5" });
    expect(cli.parseCli(["--variant", "baseline", "--corpus", "miracl-ja"])).toMatchObject({ model: "@cf/baai/bge-m3" });
    expect(cli.parseCli(["prepare", "--variant", "baseline", "--corpus", "miracl-ja"])).toMatchObject({ model: "@cf/baai/bge-m3" });
    expect(cli.parseCli(["--variant", "baseline", "--corpus", "core-1k"])).toMatchObject({ model: DEFAULTS.EMBEDDING_MODEL });
  });

  it("accepts the matching model spelled out and refuses any other one, even explicit", () => {
    expect(cli.parseCli(["--variant", "baseline", "--corpus", "miracl-ja", "--embedding-model", "@cf/baai/bge-m3"])).toMatchObject({ model: "@cf/baai/bge-m3" });
    expect(() => cli.parseCli(["--variant", "baseline", "--corpus", "miracl-ja", "--embedding-model", "@cf/baai/bge-small-en-v1.5"])).toThrow(/miracl-ja.*bge-m3/);
    expect(() => cli.parseCli(["prepare", "--variant", "baseline", "--corpus", "scifact", "--embedding-model", "@cf/baai/bge-m3"])).toThrow(cli.UsageError);
  });
});

describe("running public corpora", () => {
  it.skipIf(incompatiblePublicModel)("hash-smoke run reports the corpus, its fingerprint, and never claims a real model", async () => {
    const out = scratch();
    const c = capture();
    try { expect(await cli.main(["--variant", "baseline", "--corpus", "scifact", "--hash-embeddings", "--json", out]), c.err.join("\n")).toBe(0); } finally { c.restore(); }
    const r = JSON.parse(readFileSync(out, "utf8"));
    expect(r).toMatchObject({ corpus: "scifact", embeddingModel: "hash-smoke" });
    expect(r.dataFingerprint).toEqual(fixture("scifact"));
    expect(Object.keys(r.dataFingerprint)).not.toContain("needles.jsonl");
  });

  it.skipIf(incompatiblePublicModel)("runs miracl-ja with its own model (bge-m3 dimensions) in a hash smoke", async () => {
    fixture("miracl-ja");
    const c = capture();
    try { expect(await cli.main(["--variant", "baseline", "--corpus", "miracl-ja", "--hash-embeddings", "--limit", "1"]), c.err.join("\n")).toBe(0); } finally { c.restore(); }
    expect(c.out.join("\n")).toMatch(/corpus miracl-ja/);
    expect(c.out.join("\n")).toMatch(/LIMITED to 1/);
    rmSync(join(root, ".eval-cache/public/miracl-ja"), { recursive: true }); // the next test needs it absent
  });

  it("points a missing download at the fetch script", async () => {
    const c = capture();
    try { expect(await cli.main(["--variant", "baseline", "--corpus", "miracl-ja", "--hash-embeddings"])).toBe(2); } finally { c.restore(); }
    expect(c.err.join("\n")).toMatch(/node scripts\/eval-fetch-public\.mjs miracl-ja/);
  });

  it("can never be locked, says so before it tries to load the corpus, and writes nothing", async () => {
    const c = capture();
    try {
      // miracl-ja is not downloaded in this fixture: the refusal must not be a fetch hint
      expect(await cli.main(["lock", "--corpus", "miracl-ja"])).toBe(2);
      expect(await cli.main(["lock", "--corpus", "scifact"])).toBe(2);
    } finally { c.restore(); }
    expect(c.err.join("\n")).toMatch(/public corpora are local-only and never locked/);
    expect(c.err.join("\n")).not.toMatch(/eval-fetch-public/);
    expect(existsSync(join(root, "test/eval/data/baselines"))).toBe(false);
    expect(readdirSync(join(root, "test/eval/data/core"))).toEqual([]);
  });
});

describe("replay caches for public corpora", () => {
  const MODEL = "@cf/baai/bge-small-en-v1.5";

  it("get their own file under .eval-cache and never read or write the committed core cache", () => {
    const pub = corpora.replayPaths(MODEL, "scifact");
    expect(pub.write).toBe(join(root, ".eval-cache/replay/scifact.bge-small-en-v1.5.jsonl"));
    expect(pub.write).not.toContain("test/eval/data");
    const core = corpora.replayPaths(MODEL, "core-1k");
    expect(core.write).toBe(join(root, ".eval-cache/replay/bge-small-en-v1.5.jsonl"));
    // a committed core cache would be a read layer for core only
    mkdirSync(join(root, "test/eval/data/core"), { recursive: true });
    const committed = join(root, "test/eval/data/core/replay.bge-small-en-v1.5.jsonl.gz");
    writeFileSync(committed, "");
    try {
      expect(corpora.replayPaths(MODEL, "core-1k").read).toContain(committed);
      expect(corpora.replayPaths(MODEL, "scifact").read).not.toContain(committed);
    } finally { rmSync(committed, { force: true }); }
  });

  it.skipIf(incompatiblePublicModel)("prepare records into the per-corpus .eval-cache file only, through a stubbed local model (no download, no account)", async () => {
    const fetchStub = vi.spyOn(globalThis, "fetch");
    const c = capture();
    try {
      expect(await cli.main(["prepare", "--variant", "baseline", "--corpus", "scifact"]), c.err.join("\n")).toBe(0);
      expect(fetchStub).not.toHaveBeenCalled();
    } finally { c.restore(); fetchStub.mockRestore(); }
    expect(existsSync(join(root, ".eval-cache/replay/scifact.bge-small-en-v1.5.jsonl"))).toBe(true);
    expect(existsSync(join(root, ".eval-cache/replay/bge-small-en-v1.5.jsonl"))).toBe(false);
    expect(readdirSync(join(root, "test/eval/data/core")).filter(f => f.startsWith("replay"))).toEqual([]);
  });
});

describe("privacy guard on every CLI write", () => {
  it("guardWrite refuses a path git would pick up and passes ignored and out-of-repo paths", () => {
    expect(() => cli.guardWrite(join(REAL_REPO, "package.json"))).toThrow(cli.UsageError);
    expect(() => cli.guardWrite(join(REAL_REPO, "some-report.json"))).toThrow(/not git-ignored/);
    expect(() => cli.guardWrite(join(REAL_REPO, ".eval-cache/replay/x.jsonl"))).not.toThrow();
    expect(() => cli.guardWrite(join(tmpdir(), "r.json"))).not.toThrow();
  });

  it("guardWrite follows symlinks, dangling ones included, to where the write would land", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-link-"));
    symlinkSync(join(REAL_REPO, "eval-dangling-target.json"), join(dir, "dangling.json")); // target does not exist yet
    symlinkSync(join(REAL_REPO, "test/eval"), join(dir, "dirlink"));
    expect(() => cli.guardWrite(join(dir, "dangling.json"))).toThrow(cli.UsageError);
    expect(() => cli.guardWrite(join(dir, "dirlink/new-report.json"))).toThrow(cli.UsageError);
  });

  it("prepare asks the privacy guard about its cache path before any live call", async () => {
    const assertIgnored = vi.fn((_path: string) => { throw new Error("refusing to write: not git-ignored"); });
    vi.doMock("./privacy", async orig => ({ ...(await orig<typeof import("./privacy")>()), assertIgnored }));
    vi.resetModules();
    const fresh = await import("./cli");
    const fetchStub = vi.spyOn(globalThis, "fetch");
    const c = capture();
    try {
      expect(await fresh.main(["prepare", "--variant", "baseline", "--corpus", "scifact"])).toBe(2);
      expect(fetchStub).not.toHaveBeenCalled();
      expect(String(assertIgnored.mock.calls[0]?.[0])).toContain("scifact.bge-small-en-v1.5.jsonl");
    } finally {
      c.restore(); fetchStub.mockRestore(); vi.doUnmock("./privacy");
    }
  });

  it("--json into a tracked or unignored repo path is refused with one usage error, before the run, and writes nothing", async () => {
    for (const rel of ["test/eval/data/baselines/x.json", "eval-report-should-not-exist.json", "package.json"]) {
      const target = join(REAL_REPO, rel);
      const before = existsSync(target) ? readFileSync(target, "utf8") : null;
      const c = capture();
      try { expect(await cli.main(["--variant", "baseline", "--corpus", "scifact", "--hash-embeddings", "--json", target]), rel).toBe(2); } finally { c.restore(); }
      expect(c.err.filter(l => l.startsWith("usage:")), rel).toHaveLength(1);
      expect(c.out, `${rel}: nothing ran`).toEqual([]);
      expect(existsSync(target) ? readFileSync(target, "utf8") : null, rel).toBe(before);
    }
  });
});
