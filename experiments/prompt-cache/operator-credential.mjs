import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

export const PROXY_API_KEY_ENV = "PROMPT_CACHE_PROXY_API_KEY";
export const PROXY_SYSTEMD_CREDENTIAL = "prompt-cache-proxy-api-key";

const MAX_CREDENTIAL_BYTES = 16 * 1024;

export class OperatorCredentialError extends Error {
  constructor(code) {
    super(`Prompt-cache operator credential failed: ${code}`);
    this.name = "OperatorCredentialError";
    this.code = code;
  }
}

function validatedCredential(value) {
  if (typeof value !== "string") throw new OperatorCredentialError("proxy_api_key_missing");
  const credential = value.trim();
  if (!credential
    || Buffer.byteLength(credential, "utf8") > MAX_CREDENTIAL_BYTES
    || /[\r\n\0]/.test(credential)) {
    throw new OperatorCredentialError("proxy_api_key_invalid");
  }
  return credential;
}

/**
 * 後方互換のため従来の環境変数を優先する。未設定なら systemd の
 * LoadCredential が作成した固定名ファイルを読む。パスは CLI 引数から
 * 受け取らないため、オペレーターが誤って認証情報を表示しにくい。
 */
export function resolveProxyApiKey({
  environment = process.env,
  openSyncImpl = openSync,
  fstatSyncImpl = fstatSync,
  readFileSyncImpl = readFileSync,
  closeSyncImpl = closeSync,
} = {}) {
  if (typeof environment[PROXY_API_KEY_ENV] === "string" && environment[PROXY_API_KEY_ENV].trim()) {
    return {
      value: validatedCredential(environment[PROXY_API_KEY_ENV]),
      source: "environment",
    };
  }

  const directory = environment.CREDENTIALS_DIRECTORY;
  if (typeof directory !== "string"
    || !directory
    || !isAbsolute(directory)
    || /[\r\n\0]/.test(directory)) {
    throw new OperatorCredentialError("proxy_api_key_missing");
  }
  const path = join(directory, PROXY_SYSTEMD_CREDENTIAL);
  let descriptor;
  try {
    descriptor = openSyncImpl(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new OperatorCredentialError("proxy_api_key_missing");
  }

  try {
    const stat = fstatSyncImpl(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CREDENTIAL_BYTES) {
      throw new OperatorCredentialError("proxy_api_key_invalid");
    }
    const value = readFileSyncImpl(descriptor, "utf8");
    return {
      value: validatedCredential(value),
      source: "systemd-credential",
    };
  } catch (error) {
    if (error instanceof OperatorCredentialError) throw error;
    throw new OperatorCredentialError("proxy_api_key_unreadable");
  } finally {
    try {
      closeSyncImpl(descriptor);
    } catch {
      // 認証情報の内容やパスを公開せず、読み込み結果の判定を維持する。
    }
  }
}
