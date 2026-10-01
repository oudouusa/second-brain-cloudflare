import {
  CJK_STOPWORDS,
  D1_MAX_LIKE_PATTERN_BYTES,
  KEYWORD_MAX_TOKENS,
  KEYWORD_MIN_TOKEN_LEN,
  KEYWORD_STOPWORDS,
} from "../constants";
import { tokenizeQuery as tokenizeUpstreamQuery } from "./tokenize";

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_ONLY = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;
const PROTECTED = /\b[A-Za-z0-9_]+[%\\][A-Za-z0-9_%\\]+\b|https?:\/\/[^\s]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|@[\p{L}\p{N}._-]+(?:\/[\p{L}\p{N}._-]+)+|\/[\p{L}\p{N}._~!$&'()*+,;=:@%/-]+|#[0-9a-fA-F]{3,8}\b|#\d+\b|\b[\p{L}\p{N}_.-]+=[\p{L}\p{N}_.:/-]+\b|\b[\p{L}\p{N}]+(?:[-_.:/][\p{L}\p{N}]+)+\b|\b[A-Z][A-Z0-9_]{2,}\b|\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b/gu;
const EMBEDDED_ASCII_IDENTIFIER = /[A-Za-z0-9]+(?:[-_.:/][A-Za-z0-9]+)+|[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+/g;
const UTF8 = new TextEncoder();
const LIKE_TOKEN_BYTE_BUDGET = D1_MAX_LIKE_PATTERN_BYTES - 2;
// localeと分割規則だけを再利用する。検索語や利用者の状態は保持しない。
let wordSegmenter: Intl.Segmenter | undefined;
function segmentWords(text: string): Intl.Segments {
  wordSegmenter ??= new Intl.Segmenter("ja", { granularity: "word" });
  return wordSegmenter.segment(text);
}

export type LexicalTokenKind = "protected" | "word" | "cjk-bigram";

/**
 * `value` is the NFKC/lowercase form used for scoring. `probes` are the bounded
 * forms sent to D1's LIKE arm. A compatibility-form surface from the query is
 * retained beside `value` so query-side NFKC does not make an otherwise exact
 * full-width match unreachable before normalized scoring runs.
 */
export interface LexicalToken {
  value: string;
  kind: LexicalTokenKind;
  probes: string[];
}

/** 同じ語の断片を独立した証拠に数えない。不適格な単語のbigram救済は残す。 */
export function withoutContainedCjkBigrams(terms: readonly LexicalToken[]): LexicalToken[] {
  const words = terms.filter(term => term.kind !== "cjk-bigram");
  return terms.filter(term => term.kind !== "cjk-bigram"
    || !words.some(word => word.value !== term.value && word.value.includes(term.value)));
}

interface TokenCandidate {
  token: string;
  index: number;
  priority: number;
  sequence: number;
  kind: LexicalTokenKind;
}

function cleanToken(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}@#/:._-]+|[^\p{L}\p{N}/:._%-]+$/gu, "");
}

function cleanRawProbe(value: string): string {
  return value.replace(/^[^\p{L}\p{N}@#/:._-]+|[^\p{L}\p{N}/:._%-]+$/gu, "");
}

function useful(value: string): boolean {
  return value.length >= KEYWORD_MIN_TOKEN_LEN
    && !KEYWORD_STOPWORDS.has(value)
    && !CJK_STOPWORDS.has(value);
}

function splitForLike(token: string): string[] {
  // 通常の短い語は一括で計数し、文字ごとのescape・UTF-8配列生成を避ける。
  // 上限を超えた語だけ、従来と同じcode point境界で分割する。
  if (token.length <= LIKE_TOKEN_BYTE_BUDGET
    && UTF8.encode(escapeLikeToken(token)).byteLength <= LIKE_TOKEN_BYTE_BUDGET) {
    return token ? [token] : [];
  }
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const char of token) {
    const charBytes = UTF8.encode(escapeLikeToken(char)).byteLength;
    if (chunk && bytes + charBytes > LIKE_TOKEN_BYTE_BUDGET) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += char;
    bytes += charBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function rawCompatibilityProbes(query: string): Map<string, string> {
  const probes = new Map<string, string>();
  if (query.normalize("NFKC") === query) return probes;
  const add = (surface: string) => {
    const value = cleanToken(surface);
    const raw = cleanRawProbe(surface);
    if (!useful(value) || !raw || raw.normalize("NFKC") === raw) return;
    if (splitForLike(value).length !== 1 || splitForLike(raw).length !== 1) return;
    if (!probes.has(value)) probes.set(value, raw);
  };

  // Compatibility punctuation (e.g. ＳＢ－０２４) prevents the raw-surface
  // identifier regex from recognizing the whole token. Admit a whitespace-
  // bounded surface only when its normalized form is one complete protected
  // token. This reuses the existing grammar and byte cap, not another tokenizer.
  for (const surface of query.split(/\s/u)) {
    const normalized = cleanToken(surface);
    if ([...normalized.matchAll(PROTECTED)].some(match => match[0] === normalized)) add(surface);
  }

  const remainder = query.replace(PROTECTED, (match) => {
    const token = cleanToken(match);
    const chunks = splitForLike(token);
    if (useful(token) && chunks.length > 1 && CJK_CHAR.test(token)) return match;
    add(match);
    return " ".repeat(match.length);
  }).replace(/\s/gu, " ");

  for (const segment of segmentWords(remainder)) {
    if (!segment.isWordLike) continue;
    add(segment.segment);
    if (!CJK_ONLY.test(segment.segment)) continue;
    const chars = [...segment.segment];
    for (let i = 0; i + 1 < chars.length; i++) add(`${chars[i]}${chars[i + 1]}`);
  }
  return probes;
}

function pickEvenly<T>(items: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  if (items.length <= count) return [...items];
  if (count === 1) return [items[Math.floor((items.length - 1) / 2)]];
  return Array.from({ length: count }, (_, i) =>
    items[Math.round(i * (items.length - 1) / (count - 1))]
  );
}

function selectCandidates(candidates: TokenCandidate[]): TokenCandidate[] {
  const unique = new Map<string, TokenCandidate>();
  for (const candidate of candidates) {
    const current = unique.get(candidate.token);
    if (!current) {
      unique.set(candidate.token, candidate);
      continue;
    }
    current.index = Math.min(current.index, candidate.index);
    current.sequence = Math.min(current.sequence, candidate.sequence);
    if (candidate.priority < current.priority) {
      current.priority = candidate.priority;
      current.kind = candidate.kind;
    }
  }

  const ordered = [...unique.values()]
    .sort((a, b) => a.index - b.index || a.priority - b.priority || a.sequence - b.sequence);
  if (ordered.length <= KEYWORD_MAX_TOKENS) return ordered;

  const groups = {
    protected: ordered.filter(candidate => candidate.kind === "protected"),
    word: ordered.filter(candidate => candidate.kind === "word"),
    bigram: ordered.filter(candidate => candidate.kind === "cjk-bigram"),
  };
  const bigramSlots = Math.min(groups.bigram.length, Math.floor(KEYWORD_MAX_TOKENS / 4));
  const protectedSlots = Math.min(
    groups.protected.length,
    Math.floor(KEYWORD_MAX_TOKENS / 4),
    KEYWORD_MAX_TOKENS - bigramSlots,
  );
  const wordSlots = Math.min(
    groups.word.length,
    KEYWORD_MAX_TOKENS - protectedSlots - bigramSlots,
  );
  const selected = new Set<TokenCandidate>([
    ...pickEvenly(groups.protected, protectedSlots),
    ...pickEvenly(groups.word, wordSlots),
    ...pickEvenly(groups.bigram, bigramSlots),
  ]);
  const remainingSlots = KEYWORD_MAX_TOKENS - selected.size;
  const remaining = ordered.filter(candidate => !selected.has(candidate));
  pickEvenly(remaining, remainingSlots).forEach(candidate => selected.add(candidate));
  return [...selected]
    .sort((a, b) => a.index - b.index || a.priority - b.priority || a.sequence - b.sequence);
}

/**
 * Recall-specific lexical policy layered on the upstream tokenizer.
 *
 * Upstream owns Unicode segmentation, NFKC normalization, stop words and the
 * ASCII compatibility path. This layer keeps only the fork's D1 constraints:
 * identifier protection, grouped raw probes, bounded LIKE patterns, in-word
 * CJK fallbacks and deterministic selection under the SQL term ceiling.
 */
export function tokenizeQueryDetailed(query: string): LexicalToken[] {
  const normalized = query.normalize("NFKC");
  const candidates: TokenCandidate[] = [];
  let sequence = 0;
  const addCandidate = (
    token: string,
    index: number,
    priority: number,
    kind: LexicalTokenKind,
  ) => {
    for (const chunk of splitForLike(token)) {
      if (useful(chunk)) candidates.push({ token: chunk, index, priority, sequence: sequence++, kind });
    }
  };
  let remainder = normalized.replace(PROTECTED, (match, offset: number) => {
    const token = cleanToken(match);
    const chunks = splitForLike(token);
    if (useful(token) && chunks.length > 1 && CJK_CHAR.test(token)) {
      let masked = match;
      for (const embedded of match.matchAll(EMBEDDED_ASCII_IDENTIFIER)) {
        const embeddedToken = cleanToken(embedded[0]);
        if (useful(embeddedToken)) {
          addCandidate(embeddedToken, offset + (embedded.index ?? 0), 0, "protected");
        }
        const at = embedded.index ?? 0;
        masked = `${masked.slice(0, at)}${" ".repeat(embedded[0].length)}${masked.slice(at + embedded[0].length)}`;
      }
      return masked;
    }
    if (useful(token)) addCandidate(token, offset, 0, "protected");
    return " ".repeat(match.length);
  });

  // Preserve Intl.Segmenter's lexical boundaries before delegation. Upstream's
  // ASCII fast path is intentionally whitespace-based, so passing raw
  // `alpha,beta` would collapse the two words back into one punctuated probe.
  // The delegated result remains the acceptance vocabulary; the original
  // segment surface keeps literal underscores that upstream strips for LIKE.
  // Align Unicode whitespace with upstream's `split(/\s+/)` before asking
  // Segmenter for word boundaries. In particular, some runtimes keep U+FEFF
  // inside one word-like surface even though upstream treats it as a separator.
  remainder = remainder.replace(/\s/gu, " ");
  const segments = [...segmentWords(remainder)].filter(segment => segment.isWordLike);
  const accepted = new Set(tokenizeUpstreamQuery(segments.map(segment => segment.segment).join(" "))
    .map(cleanToken));
  for (const segment of segments) {
    const token = cleanToken(segment.segment);
    // A literal underscore is fork-owned syntax: upstream removes it before
    // applying the length floor, which would erase `_x`, `x_`, and `__x`.
    // Keep the Segmenter surface when it is independently useful; every D1
    // consumer escapes the underscore before binding LIKE.
    const literalUnderscore = token.includes("_") && useful(token);
    if (!accepted.has(token) && !literalUnderscore) continue;
    const index = segment.index;
    addCandidate(token, index, 1, "word");
    if (!CJK_ONLY.test(token)) continue;
    const chars = [...token];
    for (let i = 0; i + 1 < chars.length; i++) {
      const bigram = `${chars[i]}${chars[i + 1]}`;
      if (useful(bigram)) {
        candidates.push({
          token: bigram,
          index: index + i,
          priority: 2,
          sequence: sequence++,
          kind: "cjk-bigram",
        });
      }
    }
  }

  if (!candidates.length) {
    const lone = cleanToken(normalized);
    if (/^\p{Script=Han}$/u.test(lone) && !CJK_STOPWORDS.has(lone)) {
      candidates.push({ token: lone, index: 0, priority: 1, sequence: sequence++, kind: "word" });
    }
  }

  const compatibility = rawCompatibilityProbes(query);
  return selectCandidates(candidates).map(candidate => ({
    value: candidate.token,
    kind: candidate.kind,
    probes: compatibility.has(candidate.token)
      ? [candidate.token, compatibility.get(candidate.token)!]
      : [candidate.token],
  }));
}

export function tokenizeQuery(query: string): string[] {
  return tokenizeQueryDetailed(query).map(token => token.value);
}

export function escapeLikeToken(token: string): string {
  return token.replace(/([%_\\])/g, "\\$1");
}

export function likeContainsPattern(token: string): string {
  const safe = splitForLike(token)[0] ?? "";
  return `%${escapeLikeToken(safe)}%`;
}

export const QUERY_LIKE_ESCAPE = `ESCAPE '\\'`;
