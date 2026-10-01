import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { extractToken, requireIdentityForMcp } from "../lib/identity";
import { ensureDbReady } from "../runtime/state";
import { buildMcpServer } from "./server";
import {
  isMcpToolsListRequest,
  sanitizeToolsListResponse,
} from "./sanitize";
import {
  materializeAdmittedResponse,
  mcpPayloadNeedsWriteAdmission,
  mcpRequestNeedsWriteAdmission,
  withRequestWriteAdmission,
} from "../migration/write-lock";
import { boundRequestBody } from "../lib/http";
import type { McpClientProps } from "./client-label";
import { rewriteDailyLimitToolErrors } from "./daily-limit-response";

type McpExecutionContext = ExecutionContext & { props?: { userId?: string } & McpClientProps };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMcpToolsListPayload(payload: unknown): boolean {
  return isRecord(payload) && payload.method === "tools/list";
}

export function createApiHandler() {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      ensureDbReady(ctx, env);
      let parsedBody: unknown;
      let hasParsedBody = false;
      if (request.body) {
        const bounded = await boundRequestBody(request, 1024 * 1024);
        if (!bounded.ok) return bounded.response;
        request = bounded.request;
        if (bounded.bytes.byteLength > 0) {
          try {
            parsedBody = JSON.parse(new TextDecoder().decode(bounded.bytes));
            hasParsedBody = true;
          } catch {
            // Preserve the SDK's protocol-specific parse-error response.
          }
        }
      }
      const props = (ctx as McpExecutionContext).props;
      const clientProps: McpClientProps = { clientId: props?.clientId, clientName: props?.clientName, via: props?.via, requestUrl: request.url };
      const oauthUserId = (ctx as McpExecutionContext).props?.userId;
      const auth = await requireIdentityForMcp(request, env, oauthUserId);
      if (auth instanceof Response) return auth;
      const needsWriteAdmission = hasParsedBody
        ? mcpPayloadNeedsWriteAdmission(parsedBody)
        : await mcpRequestNeedsWriteAdmission(request);
      return withRequestWriteAdmission(env, ctx, needsWriteAdmission, async (routedEnv, routedCtx) => {
        const isToolsList = hasParsedBody
          ? isMcpToolsListPayload(parsedBody)
          : await isMcpToolsListRequest(request);
        const handler = createMcpHandler(
          () => buildMcpServer(routedEnv, routedCtx, auth, clientProps, extractToken(request)),
          // keepAliveMs: 0だけではmodern subscriptions/listenのSSEは閉じない。
          // リクエスト単位のAPIに常時購読を作らせず、DOの無操作時稼働を防ぐ。
          { legacy: "stateless", responseMode: "json", keepAliveMs: 0, maxSubscriptions: 0 },
        );
        const rawResponse = await handler.fetch(
          request,
          hasParsedBody ? { parsedBody } : undefined,
        );
        const response = await rewriteDailyLimitToolErrors(rawResponse);
        return await (isToolsList
          ? sanitizeToolsListResponse(response)
          : materializeAdmittedResponse(response));
      });
    },
  };
}

export const apiHandler = createApiHandler();
