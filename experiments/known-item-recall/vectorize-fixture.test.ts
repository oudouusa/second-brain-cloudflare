import { expect, it } from "vitest";
import { fixtureVectorize } from "./vectorize-fixture";

it("scores cosine, applies Vectorize metadata filters, and fetches known ids", async () => {
  const vectorize = fixtureVectorize([
    { id: "a", values: [1, 0], metadata: { workspace_id: "own", parentId: "p1" } },
    { id: "b", values: [0, 1], metadata: { workspace_id: "team", parentId: "p2" } },
    { id: "c", values: [1, 1], metadata: { parentId: "p1" } },
  ]);
  const top = await vectorize.query([1, 0], { topK: 2, returnMetadata: "all", returnValues: true });
  expect(top.matches.map(match => match.id)).toEqual(["a", "c"]);
  expect(top.matches[0].score).toBeCloseTo(1);
  const own = await vectorize.query([1, 0], { topK: 3,
    filter: { workspace_id: { $in: ["own"] } }, returnMetadata: "all" });
  expect(own.matches.map(match => match.id)).toEqual(["a"]);
  const parent = await vectorize.query([1, 0], { topK: 3,
    filter: { parentId: { $in: ["p1"] } } });
  expect(parent.matches.map(match => match.id)).toEqual(["a", "c"]);
  expect((await vectorize.getByIds(["c", "missing", "a"])).map(vector => vector.id)).toEqual(["c", "a"]);
});
