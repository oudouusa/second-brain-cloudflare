import { afterAll, beforeAll } from "vitest";
import { EMBEDDING_PROFILE } from "../../src/embedding/profile";
import { NEURON_RATES } from "./ai-replay";

// 合成ハーネスの計数試験専用。Gemmaの公開単価は未登録なので実測費用とは扱わない。
export function syntheticGemmaPricing(): void {
  const previous = NEURON_RATES[EMBEDDING_PROFILE.model];
  beforeAll(() => { NEURON_RATES[EMBEDDING_PROFILE.model] = { inputPerMillionTokens: 1841 }; });
  afterAll(() => {
    if (previous) NEURON_RATES[EMBEDDING_PROFILE.model] = previous;
    else delete NEURON_RATES[EMBEDDING_PROFILE.model];
  });
}
