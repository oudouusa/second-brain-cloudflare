import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync,
  renameSync, statSync, truncateSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { producerKey, type EmbeddingProducer, type NeuronSource } from "./types";
import { QueryScopes } from "./query-scope";
import { STAND_IN_EMBEDDING_MODEL, STAND_IN_MAX_TAGS, STAND_IN_TAG_THRESHOLD, formatTags, parseTagPrompt, pickTags } from "./tag-standin";
import { hashVector } from "./vectors";

/** Short stable id of a producer record; stored in every row so a row names the exact producer that made it. */
export const producerId = (p: EmbeddingProducer): string => createHash("sha256").update(producerKey(p)).digest("hex").slice(0, 16);

export type ReplayMode = "replay" | "record" | "dry";

export class ReplayMissError extends Error {
  constructor(readonly model: string, readonly key: string, preview: string) {
    super(`replay cache miss for ${model} (sha256 ${key}): "${preview}". Record it with: npm run eval:recall -- prepare --variant <name> --corpus <id>`);
  }
}

/** Replay inputs must be plain JSON: anything else (Date, Map, ...) has a wire form JSON.stringify would silently collapse. */
export function stableStringify(v: unknown): string {
  return stringify(v, "$", []);
}

function stringify(v: unknown, path: string, ancestors: object[]): string {
  const bad = (what: string): never => {
    throw new TypeError(`replay inputs must be plain JSON values: ${what} at ${path}`);
  };
  if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") return Number.isFinite(v) ? JSON.stringify(v) : bad(`non-finite number ${v}`);
  if (typeof v !== "object") return bad(typeof v);
  if (ancestors.includes(v)) throw new TypeError(`replay inputs must be plain JSON values: cycle at ${path}`);
  const next = [...ancestors, v];
  if (Array.isArray(v)) return `[${v.map((x, i) => stringify(x, `${path}[${i}]`, next)).join(",")}]`;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return bad(`${v.constructor?.name ?? "non-plain object"}`);
  const o = v as Record<string, unknown>;
  // JSON.stringify drops undefined properties, so the wire body (and key) match the object without them.
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stringify(o[k], `${path}.${k}`, next)}`).join(",")}}`;
}

export const replayKey = (model: string, input: unknown): string =>
  createHash("sha256").update(model).update("\0").update(stableStringify(input)).digest("hex");

// Neurons per million tokens. Verified 2026-09-23 against
// https://developers.cloudflare.com/workers-ai/platform/pricing/
// An unknown model throws instead of costing 0.
export const NEURON_RATES: Record<string, { inputPerMillionTokens: number; outputPerMillionTokens?: number }> = {
  "@cf/baai/bge-small-en-v1.5": { inputPerMillionTokens: 1841 },
  "@cf/baai/bge-base-en-v1.5": { inputPerMillionTokens: 6058 },
  "@cf/baai/bge-large-en-v1.5": { inputPerMillionTokens: 18582 },
  "@cf/baai/bge-m3": { inputPerMillionTokens: 1075 },
  "@cf/baai/bge-reranker-base": { inputPerMillionTokens: 283 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { inputPerMillionTokens: 24545, outputPerMillionTokens: 77273 },
};

export const EMBEDDING_DIMS: Record<string, number> = {
  "@cf/google/embeddinggemma-300m": 768,
  "@cf/baai/bge-small-en-v1.5": 384,
  "@cf/baai/bge-base-en-v1.5": 768,
  "@cf/baai/bge-large-en-v1.5": 1024,
  "@cf/baai/bge-m3": 1024,
};

/**
 * Conservative upper bound on tokens, for budget enforcement: one token per UTF-8 byte.
 * Every token consumes at least one input byte (byte-level BPE) or code point (WordPiece, [UNK]
 * included), so bytes can never under-count, whatever the script. Emoji (4 bytes) and CJK (3 bytes)
 * are covered, at the price of overstating plain Latin text by about 4x.
 */
export const estimateTokens = (text: string): number => Buffer.byteLength(text, "utf8");

export function estimateNeurons(model: string, inputText: string, outputText = ""): number {
  const rate = NEURON_RATES[model];
  if (!rate) throw new Error(`no neuron rate for ${model}: add it to NEURON_RATES (test/eval/ai-replay.ts) before running this variant`);
  return (estimateTokens(inputText) * rate.inputPerMillionTokens + estimateTokens(outputText) * (rate.outputPerMillionTokens ?? 0)) / 1_000_000;
}

/** Provider counts, when the /ai/run result includes usage (LLM responses do; embeddings may not). */
type TokenUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
type Stored = ({ f32: string[] } | { text: string } | { json: unknown }) & { usage?: TokenUsage };

const CJK = /[぀-ヿ㐀-鿿가-힯]/u;

/** Typical tokens for reporting when the provider omits usage; never used to reserve a budget. */
function reportedTokens(text: string): number {
  let latin = 0, cjk = 0, emoji = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else if ((ch.codePointAt(0) ?? 0) > 0xffff) emoji += 2;
    else latin++;
  }
  return Math.ceil(latin / 4 + cjk + emoji);
}

function validTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function providerUsage(result: unknown): TokenUsage | undefined {
  if (!result || typeof result !== "object" || !("usage" in result)) return;
  const raw = (result as { usage?: unknown }).usage;
  if (!raw || typeof raw !== "object") return;
  const usage = raw as Record<string, unknown>;
  const out: TokenUsage = {};
  if (validTokens(usage.prompt_tokens)) out.prompt_tokens = usage.prompt_tokens;
  if (validTokens(usage.completion_tokens)) out.completion_tokens = usage.completion_tokens;
  if (validTokens(usage.total_tokens)) out.total_tokens = usage.total_tokens;
  return Object.keys(out).length ? out : undefined;
}

const toBase64 = (row: number[]) => Buffer.from(new Float32Array(row).buffer).toString("base64");
function fromBase64(b64: string): number[] {
  const bytes = Buffer.from(b64, "base64");
  const copy = new ArrayBuffer(bytes.length); // aligned copy: a pooled Buffer's offset may not be 4-byte aligned
  new Uint8Array(copy).set(bytes);
  return Array.from(new Float32Array(copy));
}

// SB_EVAL_ROOT moves the whole eval (data, corpora, caches) together; corpora.ts and build.ts read it too.
const REPO_ROOT = process.env.SB_EVAL_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Working caches live here (gitignored); nothing under it is ever committed. */
const CACHE_DIR = ".eval-cache";
/** The only committed location an export may target: the synthetic core cache (`replay.<model>.jsonl.gz`). */
const COMMITTED_DIR = "test/eval/data/core";
const COMMITTED_FILE = /^replay\..+\.jsonl\.gz$/;
const DEFAULT_LOCK_STALE_MS = 120_000;
const LOCK_POLL_MS = 25;
/** How many stale windows a contender waits on a lock that keeps being renewed before giving up. */
const LOCK_WAIT_WINDOWS = 5;

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code;

/** Symlink-resolved location of a path that may not exist yet: realpath of the deepest existing ancestor plus the rest. */
function realTarget(path: string): string {
  const rest: string[] = [];
  for (let cur = resolve(path); ; cur = dirname(cur)) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e;
    }
    try {
      lstatSync(cur);
      throw new Error(`${cur} is a dangling symlink`);
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e;
    }
    rest.push(basename(cur));
  }
}

/** Puts a lock we moved aside back without ever clobbering a lock another contender created meanwhile. */
function restoreLock(aside: string, lock: string): void {
  try {
    linkSync(aside, lock);
    return;
  } catch (e) {
    if (errCode(e) === "EEXIST") return; // another contender already took the slot
  }
  // No hardlinks on this filesystem: exclusive-create a copy instead (never rename, which would overwrite).
  try {
    const fd = openSync(lock, "wx");
    try { writeSync(fd, readFileSync(aside)); } finally { closeSync(fd); }
  } catch { /* slot taken, or aside already gone: nothing safe left to do */ }
}

const isInside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** One cache file's own producer records. Rows are validated per layer, never against another file's records. */
interface Layer { producers: Map<string, string> }

export interface ReplayStoreOptions {
  /** Repo root that .eval-cache/ and the committed data directory hang off; tests point this at a temp dir. */
  root?: string;
  /** A lockfile older than this is treated as abandoned by a dead process. */
  lockStaleMs?: number;
}

/**
 * Append-only JSONL, optionally gzipped for committed read-only layers. Working files must resolve
 * (symlinks included) inside <root>/.eval-cache; read layers may also come from the committed core directory.
 */
export class ReplayStore {
  /** Each row with the model and producer id it was recorded under (absent on legacy rows, which are unverified). */
  private readonly map = new Map<string, { v: Stored; m?: string; p?: string }>();
  /** The write file's own producer records (model to producer id): rows appended there are validated against these. */
  private readonly writeLayer: Layer = { producers: new Map() };
  /** Who produced each model's vectors, from `{"producer": {...}}` meta lines. One producer per model per cache. */
  private readonly producers = new Map<string, EmbeddingProducer>();
  private readonly cacheDir: string;
  private readonly committedDir: string;
  private readonly lockStaleMs: number;
  private readonly inflight = new Map<string, Promise<{ stored: Stored; live: boolean }>>();
  private readonly writeFile?: string;
  /** Bytes of the write file already read into the map (complete lines only). */
  private offset = 0;

  constructor(readPaths: readonly string[], writePath?: string, opts: ReplayStoreOptions = {}) {
    const realRoot = realpathSync(opts.root ?? REPO_ROOT);
    this.cacheDir = join(realRoot, CACHE_DIR);
    this.committedDir = join(realRoot, COMMITTED_DIR);
    this.lockStaleMs = opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    const inside = (path: string, dirs: string[]) => {
      const abs = resolve(path);
      if (!dirs.some(d => isInside(realTarget(abs), d))) {
        throw new Error(`replay cache path ${path} must resolve inside ${dirs.join(" or ")}`);
      }
      return abs;
    };
    const reads = readPaths.map(p => inside(p, [this.cacheDir, this.committedDir]));
    if (writePath) this.writeFile = inside(writePath, [this.cacheDir]);
    for (const p of reads) if (p !== this.writeFile) this.load(p, false);
    if (this.writeFile) this.load(this.writeFile, true);
  }

  private apply(path: string, lineNo: number, line: string, layer: Layer) {
    try {
      const rec = JSON.parse(line) as { k?: unknown; v?: unknown; m?: unknown; p?: unknown; stamped?: unknown; producer?: { model?: unknown } & Partial<EmbeddingProducer> };
      if (rec.stamped !== undefined) return; // audit line written by stamp-cache
      if (rec.producer !== undefined) {
        const { model, ...producer } = rec.producer;
        if (typeof model !== "string" || typeof producer.repo !== "string") throw new Error("expected {producer: {model, ...}}");
        this.adoptProducer(model, producer as EmbeddingProducer);
        layer.producers.set(model, producerId(producer as EmbeddingProducer));
        return;
      }
      if (typeof rec.k !== "string" || !rec.v || typeof rec.v !== "object") throw new Error("expected {k: string, v: object}");
      if ((rec.m === undefined) !== (rec.p === undefined) || (rec.m !== undefined && (typeof rec.m !== "string" || typeof rec.p !== "string"))) throw new Error("model and producer id must both be strings, or both absent");
      const m = rec.m as string | undefined, p = rec.p as string | undefined;
      if (m !== undefined && layer.producers.get(m) !== p) {
        throw new Error(`row says model ${m} producer ${p}, but this file's producer record for ${m} is ${layer.producers.get(m) ?? "missing"}`);
      }
      const known = this.map.get(rec.k);
      if (known?.p !== undefined && known.p !== p) {
        throw new Error(`refusing to override a row of producer ${known.p} with ${p === undefined ? "an unlabeled row" : `one of producer ${p}`}`);
      }
      this.map.set(rec.k, { v: rec.v as Stored, ...(m !== undefined && { m, p }) });
    } catch (e) {
      throw new Error(`${path}:${lineNo}: corrupt or unverifiable replay record (${(e as Error).message})`);
    }
  }

  private adoptProducer(model: string, producer: EmbeddingProducer): boolean {
    const known = this.producers.get(model);
    if (!known) { this.producers.set(model, producer); return true; }
    this.checkProducer(model, known, producer);
    return false;
  }

  private checkProducer(model: string, known: EmbeddingProducer, producer: EmbeddingProducer): void {
    if (producerKey(known) !== producerKey(producer)) {
      throw new Error(`replay cache mixes producers for ${model}: ${producerKey(known)} and ${producerKey(producer)}. Delete the older cache (or record into a fresh one) rather than mixing vectors`);
    }
  }

  /** Rows with no producer record anywhere: their origin is unknown, so nothing may be attributed to them. */
  private unlabeled(): boolean { return this.map.size > 0 && this.producers.size === 0; }

  private unlabeledError(model: string): Error {
    return new Error(`the replay cache has rows but no producer record, so who produced the ${model} vectors is unknown. Re-record into a fresh cache (delete the file), or stamp it deliberately with a migration; the eval will not guess`);
  }

  /** Throws unless this cache can serve a run whose producer for `model` is `expected`: labeled, and the same producer. */
  assertProducer(model: string, expected: EmbeddingProducer): void {
    this.refresh();
    if (this.unlabeled()) throw this.unlabeledError(model);
    const known = this.producers.get(model);
    if (known) this.checkProducer(model, known, expected);
  }

  producerOf(model: string): EmbeddingProducer | undefined { return this.producers.get(model); }

  /** Registers (and, in a writable store, persists) who produces `model`. Throws if the cache already has a different producer. */
  recordProducer(model: string, producer: EmbeddingProducer): void {
    this.refresh();
    if (this.unlabeled()) throw this.unlabeledError(model);
    const fresh = this.adoptProducer(model, producer);
    const path = this.writeFile;
    if (!path) { if (fresh) this.producers.delete(model); throw new Error("replay store is read-only"); }
    if (this.writeLayer.producers.has(model)) return;
    // Rows appended here are validated against THIS file's records, so the record must live here even if a read layer has it.
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const buf = readFileSync(path);
      if (buf.length > 0 && buf[buf.length - 1] !== 10) truncateSync(path, buf.lastIndexOf(10) + 1);
    }
    appendFileSync(path, `${JSON.stringify({ producer: { model, ...producer } })}\n`);
    this.writeLayer.producers.set(model, producerId(producer));
  }

  /** Reads every complete line; returns the bytes consumed. A torn final line is skipped, anything else corrupt throws. */
  private ingest(path: string, buf: Buffer, layer: Layer): number {
    const complete = buf.lastIndexOf(10) + 1;
    let pos = 0;
    let lineNo = 0;
    while (pos < complete) {
      const nl = buf.indexOf(10, pos);
      lineNo++;
      const line = buf.toString("utf8", pos, nl);
      if (line) this.apply(path, lineNo, line, layer);
      pos = nl + 1;
    }
    if (complete === buf.length) return complete;
    try {
      this.apply(path, lineNo + 1, buf.toString("utf8", complete), layer);
      return buf.length; // intact record that only lacks its newline
    } catch {
      console.warn(`${path}: ignoring incomplete final record (${buf.length - complete} bytes, likely a torn write)`);
      return complete;
    }
  }

  private load(path: string, writable: boolean) {
    if (!existsSync(path)) return;
    const raw = readFileSync(path);
    const buf = path.endsWith(".gz") ? gunzipSync(raw) : raw;
    const consumed = this.ingest(path, buf, writable ? this.writeLayer : { producers: new Map() });
    if (!writable) return;
    // Repair now so the next append cannot concatenate onto the torn tail.
    if (consumed < buf.length) truncateSync(path, consumed);
    else if (buf.length > 0 && buf[buf.length - 1] !== 10) appendFileSync(path, "\n");
    this.offset = statSync(path).size;
  }

  /** Picks up rows other processes appended to the write file since we last looked. */
  private refresh() {
    const path = this.writeFile;
    if (!path || !existsSync(path)) return;
    const size = statSync(path).size;
    if (size <= this.offset) return;
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      const complete = buf.subarray(0, buf.lastIndexOf(10) + 1);
      this.ingest(path, complete, this.writeLayer);
      this.offset += complete.length;
    } finally {
      closeSync(fd);
    }
  }

  /** Keys served since construction; lets a run export exactly the slice it needed. */
  readonly used = new Set<string>();
  get(key: string): Stored | undefined {
    const entry = this.map.get(key);
    if (entry) this.used.add(key);
    return entry?.v;
  }

  /** Which model and producer id recorded this row; undefined for a legacy row (origin unverified). */
  provenance(key: string): { model: string; producer: string } | undefined {
    const e = this.map.get(key);
    return e?.m !== undefined && e.p !== undefined ? { model: e.m, producer: e.p } : undefined;
  }

  /**
   * Writes only the keys this run used to a gzipped JSONL file, via a temp file and rename so a crash
   * never leaves a half-written cache. Allowed targets: inside .eval-cache, or `replay.*.jsonl.gz`
   * in the committed core data directory (the synthetic core cache).
   */
  exportUsed(path: string): number {
    const abs = resolve(path);
    const real = realTarget(abs);
    const allowed = isInside(real, this.cacheDir) || (isInside(real, this.committedDir) && COMMITTED_FILE.test(basename(real)));
    if (!allowed) {
      throw new Error(`exportUsed may write only inside ${this.cacheDir} or ${join(this.committedDir, "replay.<model>.jsonl.gz")}, not ${path}`);
    }
    const rows = [...this.used].sort().map(k => ({ k, e: this.map.get(k)! }));
    // LLM rows carry no producer; every embedding or reranker row must, or the exported layer would be unverifiable.
    const bare = rows.filter(r => r.e.p === undefined && !("text" in r.e.v));
    if (bare.length) throw new Error(`${bare.length} exported row(s) have no producer provenance (legacy rows); stamp the cache first: npm run eval:recall -- stamp-cache --model <id> --producer-from current --i-recorded-this`);
    const models = new Set(rows.flatMap(r => (r.e.m !== undefined ? [r.e.m] : [])));
    const meta = [...this.producers].filter(([m]) => models.has(m)).sort(([a], [b]) => a.localeCompare(b)).map(([model, p]) => JSON.stringify({ producer: { model, ...p } }));
    const lines = [...meta, ...rows.map(({ k, e }) => JSON.stringify({ k, v: e.v, ...(e.m !== undefined && { m: e.m, p: e.p }) }))];
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, gzipSync(`${lines.join("\n")}\n`));
      renameSync(tmp, abs);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* temp may not exist */ }
      throw e;
    }
    return this.used.size;
  }

  put(key: string, value: Stored, prov?: { model: string; producer: EmbeddingProducer }): void {
    const path = this.writeFile;
    if (!path) throw new Error("replay store is read-only");
    const id = prov && producerId(prov.producer);
    if (prov && this.writeLayer.producers.get(prov.model) !== id) throw new Error(`the write file has no producer record for ${prov.model}; record the producer before its rows`);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const buf = readFileSync(path);
      if (buf.length > 0 && buf[buf.length - 1] !== 10) truncateSync(path, buf.lastIndexOf(10) + 1); // a crashed writer's torn tail
    }
    appendFileSync(path, `${JSON.stringify({ k: key, v: value, ...(prov && { m: prov.model, p: id }) })}\n`);
    this.map.set(key, { v: value, ...(prov && { m: prov.model, p: id }) });
  }

  /**
   * When the lock was last renewed: its `t`, or the file's mtime if `t` is missing or not a number. A time
   * more than one stale window in the future (clock stepped back, skewed mount) counts as 0, i.e. stale,
   * so it cannot block every run until the clock catches up.
   */
  private lockTime(lock: string): number {
    const bounded = (ts: number) => (ts > Date.now() + this.lockStaleMs ? 0 : ts);
    try {
      const t = (JSON.parse(readFileSync(lock, "utf8")) as { t?: unknown }).t;
      if (typeof t === "number" && Number.isFinite(t)) return bounded(t);
    } catch (e) {
      if (errCode(e) === "ENOENT") throw e;
    }
    return bounded(statSync(lock).mtimeMs); // unreadable, half-written, or malformed lock: age on disk
  }

  /** Stale-lock takeover: move the lock aside atomically, so only one contender wins, then confirm it really was stale. */
  private breakIfStale(lock: string): boolean {
    try {
      if (Date.now() - this.lockTime(lock) <= this.lockStaleMs) return false;
    } catch (e) {
      if (errCode(e) === "ENOENT") return true;
      throw e;
    }
    const aside = `${lock}.${randomBytes(4).toString("hex")}.stale`;
    try {
      renameSync(lock, aside);
    } catch (e) {
      if (errCode(e) === "ENOENT") return true;
      throw e;
    }
    try {
      if (Date.now() - this.lockTime(aside) > this.lockStaleMs) return true;
      restoreLock(aside, lock); // we moved a fresh lock: put it back
      return false;
    } finally {
      try { unlinkSync(aside); } catch { /* already gone */ }
    }
  }

  /**
   * Cross-process advisory lock: exclusive-create lockfile next to the write file, one per key. It is a
   * lease: the holder renews the timestamp every third of the stale window while `fn` runs, so a slow
   * live call is never mistaken for a dead process. `fn` gets a fence that re-reads the lock and says
   * whether this holder's token is still on it; check it right before writing. The fence is advisory: a
   * sub-50µs window between check and append, after a stall longer than the stale window, can yield one
   * duplicate line for a key (last write wins on load).
   */
  private async withLock<T>(key: string, fn: (stillOwner: () => boolean) => Promise<T>): Promise<T> {
    const lock = `${this.writeFile}.${key}.lock`;
    const token = randomBytes(8).toString("hex");
    const body = () => JSON.stringify({ pid: process.pid, t: Date.now(), token });
    const stillOwner = () => {
      try { return (JSON.parse(readFileSync(lock, "utf8")) as { token?: string }).token === token; } catch { return false; }
    };
    mkdirSync(dirname(lock), { recursive: true }); // clean checkout: the contained .eval-cache/ may not exist yet
    const giveUpAt = Date.now() + LOCK_WAIT_WINDOWS * this.lockStaleMs;
    for (;;) {
      try {
        const fd = openSync(lock, "wx");
        try { writeSync(fd, body()); } finally { closeSync(fd); }
        break;
      } catch (e) {
        if (errCode(e) !== "EEXIST") throw e;
        if (Date.now() > giveUpAt) {
          throw new Error(`timed out after ${LOCK_WAIT_WINDOWS * this.lockStaleMs}ms waiting for replay lock ${lock}, which is still being renewed. If no other eval run is active, delete it and rerun`);
        }
        if (!this.breakIfStale(lock)) await sleep(LOCK_POLL_MS);
      }
    }
    const renew = setInterval(() => {
      try { if (stillOwner()) writeFileSync(lock, body()); } catch { /* the fence catches a lost lock */ }
    }, Math.max(5, this.lockStaleMs / 3));
    renew.unref();
    try {
      return await fn(stillOwner);
    } finally {
      clearInterval(renew);
      if (stillOwner()) try { unlinkSync(lock); } catch { /* already gone */ } // never remove a lock a takeover replaced
    }
  }

  /**
   * Makes `produce` run at most once per key: concurrent callers in this process share the one call, and
   * across processes the lockfile lease serializes contenders, with a cache recheck after acquiring it.
   * `live` is true only for the caller whose `produce` ran. If the lease was lost during `produce`, nothing
   * is appended: the winner's row is returned, waiting up to one stale window for it to land, or this throws if none does. `what` names the
   * request in that error.
   */
  async fill(key: string, produce: () => Promise<Stored>, what = "request", prov?: { model: string; producer: EmbeddingProducer }): Promise<{ stored: Stored; live: boolean }> {
    const running = this.inflight.get(key);
    if (running) return { stored: (await running).stored, live: false };
    const flight = this.withLock(key, async stillOwner => {
      this.refresh();
      const cached = this.get(key);
      if (cached) return { stored: cached, live: false };
      const stored = await produce();
      if (!stillOwner()) {
        for (const deadline = Date.now() + this.lockStaleMs; ; await sleep(LOCK_POLL_MS)) {
          this.refresh();
          const winner = this.get(key);
          if (winner) return { stored: winner, live: false };
          if (Date.now() >= deadline) break;
        }
        throw new Error(`replay lock for ${what} (sha256 ${key}) was taken over during a live call and no result was recorded in ${this.writeFile}. Rerun to retry: npm run eval:recall -- prepare --variant <name> --corpus <id>`);
      }
      this.put(key, stored, prov);
      return { stored, live: true };
    });
    this.inflight.set(key, flight);
    try {
      return await flight;
    } finally {
      this.inflight.delete(key);
    }
  }
  get size() { return this.map.size; }
}

export interface LiveAi {
  run(model: string, input: unknown): Promise<unknown>;
  /** Who produces this model's outputs; the store records it beside the rows and refuses to mix producers. */
  producer?(model: string): EmbeddingProducer;
}

export class NeuronBudget {
  spent = 0;
  constructor(readonly limit: number) {}
  charge(n: number) {
    if (this.spent + n > this.limit) throw new Error(`neuron budget exceeded: ${(this.spent + n).toFixed(1)} > ${this.limit}. Raise --max-neurons deliberately.`);
    this.spent += n;
  }
  /** Returns a reservation that was never spent (the live call failed). */
  refund(n: number) { this.spent = Math.max(0, this.spent - n); }
  /** Replaces a reservation with the actual spend; may end above the limit, since the money is already gone. */
  settle(reserved: number, actual: number) { this.spent = Math.max(0, this.spent - reserved + actual); }
}

/** Output tokens reserved against the budget before a live LLM call, unless the caller sets max_tokens or maxOutputTokens. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/** Worst-case cost to reserve before a live call: the input plus a full-length output. */
function reserveNeurons(model: string, inputText: string, outputTokens: number): number {
  const rate = NEURON_RATES[model];
  if (!rate) return estimateNeurons(model, inputText); // throws the standard unknown-model error
  return (estimateTokens(inputText) * rate.inputPerMillionTokens + outputTokens * (rate.outputPerMillionTokens ?? 0)) / 1_000_000;
}

type AiKind = "embedding" | "llm" | "other";

/** Billed-token report. A cache without usage remains replayable, with its estimate labeled. */
function reportedNeurons(model: string, kind: AiKind, inputText: string, stored?: Stored): { neurons: number; estimated: boolean } {
  const rate = NEURON_RATES[model];
  if (!rate) throw new Error(`no neuron rate for ${model}: add it to NEURON_RATES (test/eval/ai-replay.ts) before running this variant`);
  const usage = stored?.usage;
  const prompt = usage?.prompt_tokens ?? (kind === "llm" ? undefined : usage?.total_tokens);
  const completion = kind === "llm"
    ? usage?.completion_tokens ?? (prompt !== undefined && usage?.total_tokens !== undefined && usage.total_tokens >= prompt
      ? usage.total_tokens - prompt : undefined)
    : 0;
  if (prompt !== undefined && completion !== undefined) {
    return { neurons: (prompt * rate.inputPerMillionTokens + completion * (rate.outputPerMillionTokens ?? 0)) / 1_000_000, estimated: false };
  }
  const output = stored && "text" in stored ? stored.text : "";
  return {
    neurons: (reportedTokens(inputText) * rate.inputPerMillionTokens + reportedTokens(output) * (rate.outputPerMillionTokens ?? 0)) / 1_000_000,
    estimated: true,
  };
}

export interface AiCall {
  model: string;
  kind: AiKind;
  neurons: number;
  /** True when the provider omitted complete usage; the reported cost is an approximation. */
  neuronsEstimated: boolean;
  source: "replay" | "live" | "stub" | "stand-in" | "dry";
}
/** How an unrecorded LLM call (recall makes none now; query-tag inference did) is answered: a deterministic embedding-nearest stand-in, or an empty reply. */
export type LlmTagsArm = "stand-in" | "empty";
export const LLM_TAGS_ARMS: readonly LlmTagsArm[] = ["stand-in", "empty"];

export interface ReplayAi {
  ai: Ai;
  /** The arm that answers unrecorded LLM calls; reports record it and the gate refuses to compare different arms. */
  llmTags: LlmTagsArm;
  /** Calls since the last drain; the runner drains once per query. */
  drainCalls(): AiCall[];
  /**
   * Stand-in failures recorded under `scope` since its last drain ("" when a call ran outside any scope). A caller that
   * swallows the LLM call's error would silently turn the stand-in into the empty arm, so the failure is also
   * recorded here and the runner turns it into that query's error.
   */
  drainErrors(scope?: string): string[];
  /** Runs `fn` with every AI call it starts, awaited or not, attributed to `scope` (one query). */
  scope<T>(scope: string, fn: () => Promise<T>): Promise<T>;
  /** Resolves once everything started under `scope` has finished (throws if it never does), so a stand-in failure is on record before the query is closed. */
  settle(scope: string): Promise<void>;
  /** Producer of every non-LLM model this ai was asked for (corpus load and queries), as the cache records it. */
  producers(): Record<string, EmbeddingProducer>;
  /** Where the neuron figures of the calls served so far come from; undefined when no call had verified provenance. */
  neuronSource(): NeuronSource | undefined;
  /** Cache misses seen in dry mode, keyed by replay key. */
  misses: Map<string, { model: string; preview: string; neurons: number }>;
}

type AiInput = { text?: string[]; messages?: { content: string }[]; stream?: boolean };
const kindOf = (input: AiInput): AiCall["kind"] => Array.isArray(input.text) ? "embedding" : Array.isArray(input.messages) ? "llm" : "other";
const inputText = (kind: AiCall["kind"], input: AiInput) =>
  kind === "embedding" ? input.text!.join("\n") : kind === "llm" ? input.messages!.map(m => m.content).join("\n") : stableStringify(input);

function sseStream(text: string): ReadableStream {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      if (text) c.enqueue(enc.encode(`data: ${JSON.stringify({ response: text })}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

function respond(input: AiInput, stored: Stored): unknown {
  if ("f32" in stored) return { data: stored.f32.map(fromBase64) };
  if ("text" in stored) return input.stream ? sseStream(stored.text) : { response: stored.text };
  return stored.json;
}

function encode(kind: AiCall["kind"], result: any): Stored {
  const usage = providerUsage(result);
  if (kind === "embedding") return { f32: (result.data as number[][]).map(toBase64), ...(usage && { usage }) };
  if (kind === "llm") return { text: String(result?.response ?? result?.choices?.[0]?.message?.content ?? ""), ...(usage && { usage }) };
  return { json: result, ...(usage && { usage }) };
}

export function makeReplayAi(opts: {
  store: ReplayStore;
  mode: ReplayMode;
  live?: LiveAi;
  budget?: NeuronBudget;
  /** The producer this run expects for a model (replay and dry runs that must not read foreign vectors). Defaults to the live provider's. */
  expectProducer?: (model: string) => EmbeddingProducer | undefined;
  /** Record LLM calls too; off by default because it spends neurons on non-embedding work. */
  recordLlm?: boolean;
  /** Output tokens to reserve against the budget before a live LLM call (reporting always prices the actual output). */
  maxOutputTokens?: number;
  /** Answer for LLM calls with no recorded reply. Defaults to the deterministic stand-in. */
  llmTags?: LlmTagsArm;
  /** Dry-mode answer for non-embedding, non-LLM calls (a rerank variant supplies its own). */
  dryOther?: (model: string, input: unknown) => unknown;
}): ReplayAi {
  const calls: AiCall[] = [];
  const scopes = new QueryScopes();
  const errors = new Map<string, string[]>();
  const misses: ReplayAi["misses"] = new Map();
  /** Models with at least one call served from (or recorded with) verified provenance. */
  const verifiedModels = new Set<string>();
  /** Fails closed unless the row under `key` was recorded for `model` by the producer the store declares for it. */
  const requireVerified = (key: string, model: string) => {
    const prov = opts.store.provenance(key), producer = opts.store.producerOf(model);
    if (!prov || !producer || prov.model !== model || prov.producer !== producerId(producer)) {
      throw new Error(`replay row for ${model} (sha256 ${key}) has unverified provenance: ${prov ? `it was recorded for ${prov.model}` : "it predates provenance (legacy row)"}. Re-record it, or stamp a cache you recorded yourself: npm run eval:recall -- stamp-cache --model ${model} --producer-from current --i-recorded-this`);
    }
  };
  const arm: LlmTagsArm = opts.llmTags ?? "stand-in";
  // `quiet` keeps the stand-in's own embedding lookups out of the per-query call list: production pays for the LLM call, not these.
  const execOne = async (model: string, input: AiInput, quiet = false): Promise<unknown> => {
    const record = (call: AiCall) => { if (!quiet) calls.push(call); };
    const kind = kindOf(input);
    if (kind !== "llm") {
      // A run with a declared producer only reads (or extends) a cache that is labeled with that same producer.
      const expected = opts.expectProducer?.(model) ?? opts.live?.producer?.(model);
      if (expected) opts.store.assertProducer(model, expected);
    }
    const key = replayKey(model, input);
    const text = inputText(kind, input);
    const price = (stored?: Stored) => reportedNeurons(model, kind, text, stored);
    const hit = opts.store.get(key);
    if (hit) {
      if (kind !== "llm") {
        requireVerified(key, model);
        verifiedModels.add(model);
      }
      const cost = price(hit);
      record({ model, kind, neurons: cost.neurons, neuronsEstimated: cost.estimated, source: "replay" });
      return respond(input, hit);
    }
    const preview = text.slice(0, 60).replace(/\s+/g, " ");
    if (kind === "llm" && (opts.mode === "replay" || !opts.recordLlm)) {
      // The output is priced at the published rate whatever produced it, so an answered call is not free.
      const answered = (answer: string) => {
        const cost = reportedNeurons(model, kind, text, { text: answer });
        record({ model, kind, neurons: cost.neurons, neuronsEstimated: true, source: arm === "stand-in" ? "stand-in" : "stub" });
        return input.stream ? sseStream(answer) : { response: answer };
      };
      if (arm === "empty") return answered("");
      // The whole stand-in path is one recorded unit: whatever throws (parse, embed, select, price, format) reaches
      // the caller, which may swallow it, and is also on record for the runner under its query's scope.
      const scope = scopes.id() ?? "";
      return (async () => {
        try {
          const { tags, query } = parseTagPrompt(input as Parameters<typeof parseTagPrompt>[0]);
          const embed = async (t: string) => ((await exec(STAND_IN_EMBEDDING_MODEL, { text: [t] }, true)) as { data: number[][] }).data[0];
          const vectors = new Map<string, number[]>();
          for (const t of tags) vectors.set(t, await embed(t));
          return answered(formatTags(pickTags(await embed(query), tags, vectors, STAND_IN_TAG_THRESHOLD, STAND_IN_MAX_TAGS)));
        } catch (e) {
          errors.set(scope, [...(errors.get(scope) ?? []), e instanceof Error ? e.message : String(e)]);
          throw e;
        }
      })();
    }
    if (opts.mode === "dry") {
      const neurons = estimateNeurons(model, text);
      misses.set(key, { model, preview, neurons });
      const cost = price();
      record({ model, kind, neurons: cost.neurons, neuronsEstimated: true, source: "dry" });
      // Codex review, T-0102 F3: storeEntry now always batchEmbeds (one AI call per chunk batch,
      // not per chunk), so a dry-mode embedding call can carry more than one text; one vector per
      // text, like every sibling mock in this eval suite (runner.test.ts, prepare.test.ts)
      // already does, not one vector for the whole (cache-key-only) joined string.
      if (kind === "embedding") return { data: input.text!.map(t => hashVector(t, EMBEDDING_DIMS[model] ?? 384)) };
      if (kind === "llm") return input.stream ? sseStream("") : { response: "" };
      if (opts.dryOther) return opts.dryOther(model, input);
      throw new ReplayMissError(model, key, preview);
    }
    if (opts.mode === "replay" || !opts.live) throw new ReplayMissError(model, key, preview);
    const live = opts.live;
    if (live.producer) opts.store.recordProducer(model, live.producer(model));
    const { stored, live: ranLive } = await opts.store.fill(key, async () => {
      const maxOut = typeof (input as { max_tokens?: unknown }).max_tokens === "number"
        ? (input as { max_tokens: number }).max_tokens : opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
      const reserved = reserveNeurons(model, text, kind === "llm" ? maxOut : 0);
      opts.budget?.charge(reserved);
      let fresh: Stored;
      try {
        fresh = encode(kind, await live.run(model, kind === "llm" ? { ...input, stream: false } : input));
      } catch (e) {
        opts.budget?.refund(reserved);
        throw e;
      }
      opts.budget?.settle(reserved, price(fresh).neurons);
      return fresh;
    }, `${model} "${preview}"`, live.producer && kind !== "llm" ? { model, producer: live.producer(model) } : undefined);
    if (live.producer && kind !== "llm") {
      // fill() may hand back a row another process wrote while we waited for the lock: check that row, not just our own write.
      requireVerified(key, model);
      if (opts.store.provenance(key)?.producer !== producerId(live.producer(model))) throw new Error(`replay row for ${model} (sha256 ${key}) was recorded by a different producer than this run's`);
      verifiedModels.add(model);
    }
    const cost = price(stored);
    record({ model, kind, neurons: cost.neurons, neuronsEstimated: cost.estimated, source: ranLive ? "live" : "replay" });
    return respond(input, stored);
  };
  /**
   * storeEntry now always batchEmbeds (T-0102 F3): a production embedding call can carry more than
   * one text in one env.AI.run. The replay store keys and records every embedding call it has ever
   * seen one text at a time (embedMany's own pre-batching shape, and still every non-embedding call
   * today) -- a batched call's own joined-array key never matches any of those single-text rows, so
   * batching alone turned every replay of a committed fixture into a cache miss.
   *
   * Splitting here, at the one entry point every call (batched or not) goes through, means a
   * batched embedding call looks up and records each of its texts on its own -- exactly the rows a
   * single-text call already reads and writes -- so the committed fixture, recorded before batching
   * existed, keeps serving replays without being touched, whatever a caller's own batch size is.
   */
  const exec = async (model: string, input: AiInput, quiet = false): Promise<unknown> => {
    if (kindOf(input) !== "embedding" || (input.text?.length ?? 0) <= 1) return execOne(model, input, quiet);
    const vectors = await Promise.all(
      input.text!.map(async t => ((await execOne(model, { ...input, text: [t] }, quiet)) as { data: number[][] }).data[0]),
    );
    return { data: vectors };
  };
  const run = (model: string, input: AiInput) => exec(model, input);
  return {
    ai: { run } as unknown as Ai,
    llmTags: arm,
    drainCalls: () => calls.splice(0),
    drainErrors: (scope = "") => { const out = errors.get(scope) ?? []; errors.delete(scope); return out; },
    scope: (scope, fn) => scopes.run(scope, fn),
    settle: scope => scopes.settle(scope),
    producers: () => Object.fromEntries([...verifiedModels].flatMap(m => { const p = opts.store.producerOf(m); return p ? [[m, p]] : []; })),
    neuronSource: () => {
      const kinds = [...verifiedModels].flatMap(m => { const p = opts.store.producerOf(m); return p ? [p.kind] : []; });
      return kinds.length ? (kinds.every(k => k.startsWith("local-")) ? "projected" : "provider") : undefined;
    },
    misses,
  };
}
