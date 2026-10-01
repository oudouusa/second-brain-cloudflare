import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/config";
import {
  QUERY_SIGNAL_CACHE_PREFIX,
  readQuerySignalCache,
  writeQuerySignalCache,
  type QuerySignalCacheInput,
} from "../../src/recall/query-signal-cache";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";

const input = {
  denseInput: "PRIVATE recall question about atlas",
  lexicalQuery: "atlas question",
  embeddingMode: "semantic" as const,
};
const signals = {
  values: new Array(128).fill(0.125),
  queryTags: ["work", "atlas"],
};

describe("recall query-signal cache", () => {
  it("reuses valid derived signals without storing private query text", async () => {
    const kv = makeMemoryKV();
    const env = makeTestEnv(undefined, { OAUTH_KV: kv });

    await writeQuerySignalCache(input, signals, env, DEFAULTS);

    const listed = await kv.list({ prefix: QUERY_SIGNAL_CACHE_PREFIX });
    expect(listed.keys).toHaveLength(1);
    const key = listed.keys[0].name;
    const raw = await kv.get(key);
    expect(key).not.toContain(input.denseInput);
    expect(key).not.toContain(input.lexicalQuery);
    expect(raw).not.toContain(input.denseInput);
    expect(raw).not.toContain(input.lexicalQuery);
    expect(await readQuerySignalCache(input, env, DEFAULTS)).toEqual(signals);
  });

  it("misses after AUTH_TOKEN rotation", async () => {
    const kv = makeMemoryKV();
    const oldEnv = makeTestEnv(undefined, { AUTH_TOKEN: "old-secret", OAUTH_KV: kv });
    const newEnv = makeTestEnv(undefined, { AUTH_TOKEN: "new-secret", OAUTH_KV: kv });
    await writeQuerySignalCache(input, signals, oldEnv, DEFAULTS);

    expect(await readQuerySignalCache(input, newEnv, DEFAULTS)).toBeNull();
  });

  it.each<Partial<QuerySignalCacheInput>>([
    { denseInput: "別の埋込み入力" },
    { lexicalQuery: "別の語彙入力" },
    { tag: "atlas" },
    { embeddingMode: "distilled" },
    { scopeKey: '{"personal":"別workspace","companies":[],"only":null,"team":null}' },
  ])("cacheの入力条件を変えるとmissになる: %j", async changed => {
    const env = makeTestEnv(undefined, { OAUTH_KV: makeMemoryKV() });
    await writeQuerySignalCache(input, signals, env, DEFAULTS);
    expect(await readQuerySignalCache({ ...input, ...changed }, env, DEFAULTS)).toBeNull();
  });

  it("treats malformed or wrong-dimension values as a safe miss", async () => {
    const kv = makeMemoryKV();
    const env = makeTestEnv(undefined, { OAUTH_KV: kv });
    await writeQuerySignalCache(input, signals, env, DEFAULTS);
    const listed = await kv.list({ prefix: QUERY_SIGNAL_CACHE_PREFIX });
    const key = listed.keys[0].name;
    const raw = JSON.parse((await kv.get(key))!);
    raw.values.pop();
    await kv.put(key, JSON.stringify(raw));

    expect(await readQuerySignalCache(input, env, DEFAULTS)).toBeNull();
  });
});
