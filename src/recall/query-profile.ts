import type { EdgeType } from "../graph/types";
import { KEYWORD_MAX_TOKENS } from "../constants";
import {
  tokenizeQuery,
  tokenizeQueryDetailed,
  type LexicalToken,
} from "../text/lexical-query";
import type { DistilledQuery } from "./distill";

export type RecallIntent = "causal" | "chronology" | "current" | "direct";
export type GraphQueryDirection = "incoming" | "outgoing" | "either";
export type EmbeddingQueryMode = "distilled" | "semantic" | "hybrid";
export const DEFAULT_EMBEDDING_QUERY_MODE: EmbeddingQueryMode = "semantic";

export interface QueryProfile {
  semanticQuery: string;
  lexicalQuery: string;
  lexicalTokens: string[];
  lexicalTerms: LexicalToken[];
  evidenceTokens: string[];
  evidenceTerms: LexicalToken[];
  retrievalTokens: string[];
  retrievalTerms: LexicalToken[];
  intent: RecallIntent;
  graphDirection: GraphQueryDirection;
}

export function identifierShaped(token: string): boolean {
  return /[\d#._%-]/.test(token);
}

export function deterministicVariants(query: string, tokens: string[]): string[] {
  const variants: string[] = [];
  const add = (value: string) => {
    const normalized = value.toLowerCase().trim();
    if (normalized.length >= 2 && !variants.includes(normalized)) variants.push(normalized);
  };

  for (const token of tokens.filter(value => value.includes("-"))) {
    add(token.replace(/-/g, ""));
    token.split("-").forEach(add);
  }

  const titleRun: string[] = [];
  const flushTitleRun = () => {
    if (titleRun.length >= 2 && titleRun.length <= 4) add(titleRun.map(word => word[0]).join(""));
    titleRun.length = 0;
  };
  for (const raw of query.split(/\s+/)) {
    const word = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (/^[A-Z][A-Za-z0-9]*$/.test(word) && tokenizeQuery(word).length === 1) titleRun.push(word);
    else flushTitleRun();
  }
  flushTitleRun();

  const month = "january|february|march|april|may|june|july|august|september|october|november|december";
  for (const match of query.matchAll(new RegExp(`\\b(?:${month})\\s+\\d{1,2}(?:,?\\s+\\d{4})?\\b`, "gi"))) add(match[0]);

  const stems = [...tokens, ...variants.filter(value => !value.includes(" "))];
  for (const token of stems) {
    if (token.length > 5 && token.endsWith("ies")) add(`${token.slice(0, -3)}y`);
    else if (token.length > 4 && token.endsWith("es")) add(token.slice(0, -2));
    else if (token.length > 3 && token.endsWith("s")) add(token.slice(0, -1));
    if (token.length > 5 && token.endsWith("ing")) add(token.slice(0, -3));
    if (token.length > 4 && token.endsWith("ed")) add(token.slice(0, -2));
  }
  return variants;
}

export function buildRetrievalTokens(
  semanticQuery: string,
  distilled: DistilledQuery,
): string[] {
  const evidence = tokenizeQuery(semanticQuery).slice(0, KEYWORD_MAX_TOKENS);
  const position = new Map(evidence.map((token, index) => [token, index]));
  const distilledTokens = tokenizeQuery(distilled.query);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const append = (token: string) => {
    if (ordered.length >= KEYWORD_MAX_TOKENS || seen.has(token)) return;
    seen.add(token);
    ordered.push(token);
  };

  distilledTokens.forEach(append);
  evidence.filter(identifierShaped).forEach(append);
  evidence
    .filter(token => distilled.df?.has(token))
    .sort((a, b) => (distilled.df!.get(a)! - distilled.df!.get(b)!)
      || ((position.get(a) ?? 0) - (position.get(b) ?? 0)))
    .forEach(append);
  evidence.forEach(append);
  for (const variant of deterministicVariants(semanticQuery, evidence)) {
    // Date variants are intentionally phrase probes ("june 3"). Every other
    // derivative re-enters the ordinary tokenizer so hyphen splitting cannot
    // smuggle stopwords such as "of" and "the" into the candidate window.
    if (/\s/u.test(variant)) append(variant);
    else tokenizeQuery(variant).forEach(append);
  }
  return ordered;
}

const WORD = (items: string[]) => new RegExp(`(?<![\\w-])(?:${items.join("|")})(?![\\w-])`, "i");
const CAUSAL_REASON = WORD(["why", "reason"]);
const CAUSAL_DECISION = WORD(["decide", "decided", "chose", "choice", "changed", "change", "switched"]);
const CHRONOLOGY = WORD(["before", "after", "then", "history", "evolution", "became"]);
const CURRENT = WORD(["current", "now", "still", "latest"]);
const CAUSAL_REASON_JA = /(?:なぜ|どうして|理由|原因)/u;
const CAUSAL_DECISION_JA = /(?:判断|決定|変更|切り替え|切替|採用)/u;
const CHRONOLOGY_JA = /(?:その後|以前|以後|前(?:に|の|で|は|を|が|どう|何|$)|後(?:に|の|で|は|を|が|どう|何|$)|経緯|履歴|変遷|時系列)/u;
const CURRENT_JA = /(?:現時点|現在|現状|最新|直近|今の|今も|まだ)/u;
const AFTER = WORD(["after", "then"]);
const BEFORE = WORD(["before"]);
const AFTER_JA = /(?:その後|以後|後(?:に|の|で|は|を|が|どう|何|$))/u;
const BEFORE_JA = /(?:以前|前(?:に|の|で|は|を|が|どう|何|$))/u;

export function buildQueryProfile(semanticQuery: string, distilled: DistilledQuery): QueryProfile {
  const clean = semanticQuery.trim();
  const evidenceTerms = tokenizeQueryDetailed(clean);
  const lexicalValues = tokenizeQuery(distilled.query);
  const evidenceByValue = new Map(evidenceTerms.map(term => [term.value, term]));
  const lexicalTerms = distilled.terms
    ? [...distilled.terms]
    : lexicalValues.flatMap(value => {
        const term = evidenceByValue.get(value) ?? tokenizeQueryDetailed(value)[0];
        return term ? [term] : [];
      });
  const isCausalReason = CAUSAL_REASON.test(clean) || CAUSAL_REASON_JA.test(clean);
  const isChronology = CHRONOLOGY.test(clean) || CHRONOLOGY_JA.test(clean);
  const isCurrent = CURRENT.test(clean) || CURRENT_JA.test(clean);
  const hasDirectedChronology = AFTER.test(clean) || AFTER_JA.test(clean)
    || BEFORE.test(clean) || BEFORE_JA.test(clean);
  const intent: RecallIntent = isCausalReason
    ? "causal"
    // "current deployment history" names history as the subject while asking
    // for today's state. Keep explicit before/after questions chronological,
    // but do not let a bare history/履歴 token erase an explicit current/現在
    // request — rollover lineage ranking depends on that distinction.
    // Likewise, "latest adoption status" asks what is true now; an adoption or
    // decision word alone is not a request for its cause. Explicit why/reason
    // and directed before/after requests keep precedence.
    : isChronology && (!isCurrent || hasDirectedChronology)
      ? "chronology"
      : isCurrent
        ? "current"
        : CAUSAL_DECISION.test(clean) || CAUSAL_DECISION_JA.test(clean)
          ? "causal"
          : "direct";
  const graphDirection: GraphQueryDirection = AFTER.test(clean) || AFTER_JA.test(clean)
    ? "incoming"
    : BEFORE.test(clean) || BEFORE_JA.test(clean) || isCausalReason
      ? "outgoing"
      : "either";
  const evidenceTokens = evidenceTerms.map(term => term.value).slice(0, KEYWORD_MAX_TOKENS);
  const retrievalTokens = buildRetrievalTokens(clean, distilled);
  const termByValue = new Map([
    ...evidenceTerms.map(term => [term.value, term] as const),
    ...lexicalTerms.map(term => [term.value, term] as const),
  ]);
  // Generated variants are already bounded derivatives of accepted lexical
  // tokens (or short date phrases). Re-tokenizing date phrases and taking [0]
  // loses phrase identity — e.g. "june 3" collapses to "june" because the
  // one-digit segment is below the ordinary token-length floor.
  const retrievalTerms: LexicalToken[] = retrievalTokens.map(value =>
    termByValue.get(value) ?? { value, kind: "protected", probes: [value] }
  );
  return {
    semanticQuery: clean,
    lexicalQuery: distilled.query,
    lexicalTokens: lexicalTerms.map(term => term.value),
    lexicalTerms,
    evidenceTokens,
    evidenceTerms,
    retrievalTokens,
    retrievalTerms,
    intent,
    graphDirection,
  };
}

export function embeddingInput(profile: QueryProfile, mode: EmbeddingQueryMode): string {
  if (mode === "semantic") return profile.semanticQuery;
  if (mode === "hybrid") return profile.semanticQuery === profile.lexicalQuery
    ? profile.semanticQuery
    : `${profile.semanticQuery} ${profile.lexicalQuery}`;
  return profile.lexicalQuery;
}

export function edgeIntentCompatibility(intent: RecallIntent, edgeType: EdgeType): number {
  if (intent === "causal" && ["decided", "caused_by", "supersedes"].includes(edgeType)) return 1;
  if (intent === "chronology" && ["follows", "supersedes"].includes(edgeType)) return 1;
  return 0.5;
}
