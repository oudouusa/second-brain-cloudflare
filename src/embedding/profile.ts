import type { Config } from "../config";

export const EMBEDDING_PROFILE = Object.freeze({
  profileId: "embeddinggemma-mrl128-v1",
  model: "@cf/google/embeddinggemma-300m",
  rawDimensions: 768,
  dimensions: 128,
  promptVersion: 1,
} as const);

export type EmbeddingPurpose = "query" | "document";

export class EmbeddingProfileMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingProfileMismatchError";
  }
}

export function assertEmbeddingConfig(config: Readonly<Config>): typeof EMBEDDING_PROFILE {
  if (config.EMBEDDING_MODEL !== EMBEDDING_PROFILE.model) {
    throw new EmbeddingProfileMismatchError(
      `unsupported embedding model ${config.EMBEDDING_MODEL}; expected profile ${EMBEDDING_PROFILE.profileId}`,
    );
  }
  return EMBEDDING_PROFILE;
}

export function embeddingInput(text: string, purpose: EmbeddingPurpose, title?: string): string {
  if (purpose === "query") return `task: search result | query: ${text}`;
  return `title: ${title?.trim() || "none"} | text: ${text}`;
}

export function projectEmbedding(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length !== EMBEDDING_PROFILE.rawDimensions) {
    throw new EmbeddingProfileMismatchError(
      `embedding dimension mismatch: expected ${EMBEDDING_PROFILE.rawDimensions}, got ${Array.isArray(raw) ? raw.length : "non-array"}`,
    );
  }

  const projected = raw.slice(0, EMBEDDING_PROFILE.dimensions) as unknown[];
  let squaredNorm = 0;
  for (const value of projected) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new EmbeddingProfileMismatchError("embedding contains a non-finite value");
    }
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm);
  if (!Number.isFinite(norm) || norm <= Number.EPSILON) {
    throw new EmbeddingProfileMismatchError("embedding has zero norm");
  }
  return (projected as number[]).map(value => value / norm);
}

export function embeddingMetadata(): { embeddingProfileId: string; embeddingDimensions: number; embeddingPromptVersion: number } {
  return {
    embeddingProfileId: EMBEDDING_PROFILE.profileId,
    embeddingDimensions: EMBEDDING_PROFILE.dimensions,
    embeddingPromptVersion: EMBEDDING_PROFILE.promptVersion,
  };
}

export function assertVectorProfiles(matches: readonly { id: string; metadata?: unknown }[]): void {
  for (const match of matches) {
    const metadata = match.metadata as Record<string, unknown> | undefined;
    if (metadata?.embeddingProfileId !== EMBEDDING_PROFILE.profileId
      || metadata?.embeddingDimensions !== EMBEDDING_PROFILE.dimensions
      || metadata?.embeddingPromptVersion !== EMBEDDING_PROFILE.promptVersion) {
      throw new EmbeddingProfileMismatchError(
        `vector ${match.id} does not belong to ${EMBEDDING_PROFILE.profileId}`,
      );
    }
  }
}
