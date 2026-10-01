import { acquireIntegrationOperation, releaseIntegrationOperation, saveIntegration, withIntegrationOperation,
  type IntegrationRecord } from "../../src/integrations";
import type { Env } from "../../src/env";

/** 接続の世代・操作leaseを維持してfixtureのrecordを更新する。 */
export async function saveIntegrationFixture(env: Env, record: IntegrationRecord) {
  const operation = await acquireIntegrationOperation(env, record.provider, "connect");
  try {
    await saveIntegration(withIntegrationOperation(env, operation), { ...record,
      stateGeneration: operation.stateGeneration, providerGeneration: operation.providerGeneration });
  } finally { await releaseIntegrationOperation(env, operation); }
}
