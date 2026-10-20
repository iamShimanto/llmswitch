/**
 * Codex OAuth executor — chat via the ChatGPT backend Responses API using
 * an OAuth access token (like the Codex CLI does).
 *
 * Ported (SIMPLIFIED) from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, release v3.8.53) —
 * `open-sse/config/providers/registry/codex/index.ts` (authType oauth,
 * authHeader bearer, baseUrl https://chatgpt.com/backend-api/codex/responses,
 * forceStream), `open-sse/config/codexClient.ts` (getCodexDefaultHeaders,
 * originator identity) and `open-sse/executors/codex.ts`
 * (chatgpt-account-id workspace binding, session_id cache affinity).
 * Attribution retained.
 *
 * What this port keeps: upstream base, Responses API wire (via the existing
 * codex translator), always-SSE upstream (forceStream), originator/Version/
 * User-Agent headers, chatgpt-account-id binding, session_id. What it drops:
 * quota-header parsing, credits retry, model fallback chains, compact
 * endpoint routing.
 *
 * ⚠️ UNOFFICIAL — see packs/web-session/src/providers/codex.ts for warnings.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { refreshCodexAccessToken } from "@llmswitch/web-session";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ResolvedProvider,
} from "../providers/types.js";
import { classifyStatus, UpstreamError, summarizeUpstreamBody } from "../router/errors.js";
import { codexStreamEvent, fromCodexResponse, toCodexRequest } from "../translator/codex.js";
import type { ExecuteResult } from "./http.js";

/* ------------------------------------------------------------------ *
 * Constants (ported from OmniRoute)
 * ------------------------------------------------------------------ */

/** Registry baseUrl. The Responses endpoint (not /chat/completions). */
export const CODEX_OAUTH_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

/** OmniRoute shared/constants/codexClient: CODEX_CLI_RS_ORIGINATOR = "codex_cli_rs". */
export const CODEX_ORIGINATOR = "codex_cli_rs";

/** OmniRoute getCodexDefaultHeaders: `Openai-Beta: responses_websockets=2026-02-06`. */
export const CODEX_OPENAI_BETA = "responses_websockets=2026-02-06";

/**
 * Client identity. OmniRoute forwards the caller's Codex client version; here
 * it is env-overridable (CODEX_CLIENT_VERSION / CODEX_USER_AGENT) with a
 * plain default — cosmetic, the auth is the OAuth token.
 */
export function codexClientVersion(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CODEX_CLIENT_VERSION ?? "").trim() || "0.50.0";
}
export function codexUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CODEX_USER_AGENT ?? "").trim() || `codex_cli_rs/${codexClientVersion(env)} (llmswitch)`;
}

/**
 * Inference-face headers (OmniRoute executors/codex.ts buildHeaders):
 * originator identifies the client type to the backend; session_id enables
 * prompt-cache affinity; chatgpt-account-id binds to the workspace account.
 */
export function buildCodexOAuthHeaders(
  accessToken: string,
  opts: { accountId?: string; sessionId?: string; env?: NodeJS.ProcessEnv } = {},
): Record<string, string> {
  const env = opts.env ?? process.env;
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    originator: CODEX_ORIGINATOR,
    "openai-beta": CODEX_OPENAI_BETA,
    "user-agent": codexUserAgent(env),
    version: codexClientVersion(env),
    "content-type": "application/json",
  };
  if (opts.sessionId) headers["session_id"] = opts.sessionId;
  if (opts.accountId) headers["chatgpt-account-id"] = opts.accountId;
  return headers;
}

/* ------------------------------------------------------------------ *
 * Credentials: env tokens or the login session (~/.llmswitch/sessions/codex.json)
 * ------------------------------------------------------------------ */

export class CodexAuthError extends UpstreamError {
  constructor(status: number, message: string) {
    super("auth_error", status, message);
    this.name = "CodexAuthError";
  }
}

export interface CodexCreds {
  accessToken: string;
  accountId?: string;
}

function sessionPath(env: NodeJS.ProcessEnv): string {
  const dir = env.LLMSWITCH_SESSIONS_DIR ?? (env.DATA_DIR ? join(env.DATA_DIR, "sessions") : join(homedir(), ".llmswitch", "sessions"));
  return join(dir, "codex.json");
}

/** True when a usable Codex session/token is configured (sync). */
export function hasCodexCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.CODEX_ACCESS_TOKEN ?? "").trim()) return true;
  if ((env.CODEX_OAUTH_REFRESH_TOKEN ?? "").trim()) return true;
  return existsSync(sessionPath(env));
}

interface StoredCodexSession {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
}

function readStoredSession(env: NodeJS.ProcessEnv): StoredCodexSession | null {
  try {
    const p = sessionPath(env);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as StoredCodexSession;
  } catch {
    return null;
  }
}

/** Resolve a valid access token, refreshing from the stored refresh token when expired. */
export async function resolveCodexCreds(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<CodexCreds> {
  const envAccess = (env.CODEX_ACCESS_TOKEN ?? "").trim();
  const envAccountId = (env.CODEX_ACCOUNT_ID ?? "").trim() || undefined;
  if (envAccess) return { accessToken: envAccess, accountId: envAccountId };

  const stored = readStoredSession(env);
  const refreshToken = (env.CODEX_OAUTH_REFRESH_TOKEN ?? "").trim() || stored?.refreshToken;
  if (stored?.accessToken && stored.expiresAt && stored.expiresAt > Date.now() + 60_000) {
    return { accessToken: stored.accessToken, accountId: stored.accountId ?? envAccountId };
  }
  if (!refreshToken) {
    throw new CodexAuthError(401, "codex: no session — run: llmswitch login codex");
  }
  const fresh = await refreshCodexAccessToken(refreshToken, fetchFn);
  return { accessToken: fresh.accessToken, accountId: stored?.accountId ?? envAccountId };
}

/* ------------------------------------------------------------------ *
 * Execution — upstream is always SSE (OmniRoute registry forceStream)
 * ------------------------------------------------------------------ */

/** Minimal Responses-SSE parser: yields parsed data payloads. */
async function* parseCodexSSE(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          yield JSON.parse(payload);
        } catch {
          /* ignore malformed SSE lines */
        }
      }
    }
  }
}

export async function executeCodexOAuth(
  model: string,
  body: ChatCompletionRequest,
  creds: CodexCreds,
  opts: { fetchFn?: typeof fetch; timeoutMs?: number; env?: NodeJS.ProcessEnv; baseUrl?: string; sessionId?: string } = {},
): Promise<ExecuteResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 180_000; // Codex reasoning can be slow
  const env = opts.env ?? process.env;
  const url = opts.baseUrl ?? CODEX_OAUTH_RESPONSES_URL;
  const sessionId = opts.sessionId ?? randomUUID();
  const headers = buildCodexOAuthHeaders(creds.accessToken, { accountId: creds.accountId, sessionId, env });
  // OmniRoute registry: forceStream — always request event-stream from upstream.
  const reqBody = toCodexRequest({ ...body, model, stream: true });
  const started = Date.now();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(reqBody), signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new UpstreamError("timeout", 0, `codex network error: ${(err as Error).message}`);
  }

  if (res.status === 401 || res.status === 403) {
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    throw new CodexAuthError(
      res.status,
      `codex auth failed (HTTP ${res.status}): ${text.slice(0, 200)} — refresh the session: llmswitch login codex`,
    );
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    throw new UpstreamError(classifyStatus(res.status), res.status, summarizeUpstreamBody(res.status, text).replace(/^upstream/, "codex upstream"));
  }

  const latencyMs = Date.now() - started;

  if (body.stream === true) {
    const gen = (async function* () {
      try {
        for await (const ev of parseCodexSSE(res.body!.getReader())) {
          const chunk = codexStreamEvent(ev, model);
          if (chunk) yield chunk;
        }
      } finally {
        clearTimeout(timer);
        try {
          await res.body!.cancel();
        } catch {
          /* noop */
        }
      }
    })();
    return { stream: gen as ExecuteResult["stream"], providerId: "codex", model, latencyMs, quota: null };
  }

  // Non-stream: drain SSE; response.completed carries the full response object.
  clearTimeout(timer);
  let full: any = null;
  for await (const ev of parseCodexSSE(res.body.getReader())) {
    if (ev.type === "response.completed" && ev.response) full = ev.response;
  }
  if (!full) throw new UpstreamError("server_error", res.status, "codex: no completed response in stream");
  const response: ChatCompletionResponse = fromCodexResponse(full, model);
  return { response, providerId: "codex", model, latencyMs, quota: null };
}

/**
 * Gateway path: resolve creds (session/env + refresh) then execute.
 * Used by the router when provider.id === "codex".
 */
export async function executeCodexOAuthChat(
  _provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 180_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExecuteResult> {
  const creds = await resolveCodexCreds(env, fetchFn);
  return executeCodexOAuth(model, body, creds, { fetchFn, timeoutMs, env });
}
