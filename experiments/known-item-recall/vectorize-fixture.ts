/** Read-only Vectorize facade for the exported vectors. No fixture data belongs in git. */
export interface FixtureVector {
  id: string;
  values: number[];
  metadata: Record<string, unknown>;
}

type MetadataFilter = Record<string, string | { $in: string[] }>;

function matchesFilter(metadata: Record<string, unknown>, filter?: MetadataFilter): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([key, expected]) => {
    const actual = metadata[key];
    if (typeof actual !== "string") return false;
    return typeof expected === "string" ? actual === expected : expected.$in.includes(actual);
  });
}

function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length) throw new Error("Vector dimension mismatch");
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export function fixtureVectorize(vectors: FixtureVector[]): Vectorize {
  const byId = new Map(vectors.map(vector => [vector.id, vector]));
  if (byId.size !== vectors.length) throw new Error("Duplicate fixture vector ID");
  return {
    async query(values: number[], options: { topK: number; filter?: MetadataFilter; returnMetadata?: string; returnValues?: boolean }) {
      if (!Number.isInteger(options.topK) || options.topK < 1) throw new Error("Invalid Vectorize topK");
      const matches = vectors
        .filter(vector => matchesFilter(vector.metadata, options.filter))
        .map(vector => ({
          id: vector.id,
          score: cosine(values, vector.values),
          metadata: options.returnMetadata ? vector.metadata : undefined,
          values: options.returnValues ? vector.values : undefined,
        }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, options.topK);
      return { matches };
    },
    async getByIds(ids: string[]) {
      return ids.flatMap(id => {
        const vector = byId.get(id);
        return vector ? [vector] : [];
      });
    },
  } as unknown as Vectorize;
}
