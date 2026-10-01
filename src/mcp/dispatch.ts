import type { Env } from "../env";
import { withFtsWriteGuard } from "../db/fts-write-guard";
import { recordD1BaseEnv } from "../runtime/d1-budget";

/**
 * Keep the public Free-plan Worker inside its 10 ms CPU envelope by forwarding
 * MCP protocol work to a Durable Object invocation with an independent CPU
 * budget. The local fallback keeps Node tests and unbound development usable;
 * the production config contract requires MCP_EXECUTOR.
 */
export async function fetchMcpApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (env.MCP_EXECUTOR) {
    const oauthUserId = (ctx as ExecutionContext & { props?: { userId?: string } }).props?.userId;
    return env.MCP_EXECUTOR.getByName("mcp-v1").handleMcp(request, oauthUserId);
  }
  const { apiHandler } = await import("./handler");
  return apiHandler.fetch(request, withFtsWriteGuard(recordD1BaseEnv(env)), ctx);
}
