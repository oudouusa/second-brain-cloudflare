// Bindings come from the generated Cloudflare.Env (see `wrangler types`);
// VECTORIZE_GRACE_MS is widened from its generated literal default so tests
// and per-deploy vars can override it.
type OptionalWorkerBindings = "VECTORIZE" | "VECTORIZE_GRACE_MS" | "ARCHIVE"
  | "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD" | "DASHBOARD_ACCESS_AUD" | "ACCESS_ALLOWED_EMAIL" | "ASSETS"
  | "CHATGPT_MODEL"
  | "NIGHTLY_D1_EXECUTION_PROFILE" | "MCP_EXECUTOR"
  | "CHATGPT_CREDENTIAL_KEY" | "CHATGPT_OPERATIONS" | "CHATGPT_OWNER_WORKSPACE_ID";
export interface Env extends Omit<Cloudflare.Env, OptionalWorkerBindings> {
  /** This binding targets a V2 index; Wrangler currently generates the legacy type. */
  VECTORIZE: Vectorize;
  VECTORIZE_GRACE_MS?: string;
  ARCHIVE?: R2Bucket;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  DASHBOARD_ACCESS_AUD?: string;
  ACCESS_ALLOWED_EMAIL?: string;
  ASSETS?: Fetcher;
  CHATGPT_MODEL?: string;
  /** ChatGPT接続資格情報だけを暗号化する32バイトのbase64鍵。 */
  CHATGPT_CREDENTIAL_KEY?: string;
  /** 明示的に選んだ処理だけを公開Responses APIへ送る。 */
  CHATGPT_OPERATIONS?: string;
  /** 接続後に明示した配備所有者の個人workspace。資格情報側の束縛も検証する。 */
  CHATGPT_OWNER_WORKSPACE_ID?: string;
  /** 呼出元が実際の読取・書込範囲から渡す内部値。bindingや要求本文では設定しない。 */
  CHATGPT_WORKSPACE_ID?: string;
  /** Explicitly enables the published Workers Paid D1 per-invocation ceiling. Defaults safely to Free. */
  NIGHTLY_D1_EXECUTION_PROFILE?: string;
  /** Production-only CPU isolation for the MCP protocol and tool execution. */
  MCP_EXECUTOR?: DurableObjectNamespace<import("./mcp/executor").McpExecutor>;
  /** Internal per-invocation capability. Never configured as a Worker binding. */
  WRITE_ADMISSION_TOKEN?: string;
}

// Worker version, echoed by GET /health. The desktop app compares this against
// the version it bundles to offer a one-click "update your Second Brain".
// Bump (semver) when the Worker changes; see installer/README "Worker versioning".
export const SB_VERSION = "4.0.0";
