/**
 * Claude OAuth executor — chat via Anthropic Messages API using an OAuth
 * access token (like the Claude Code CLI does).
 *
 * Ported (SIMPLIFIED) from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, release v3.8.53) —
 * `open-sse/config/providers/registry/claude/index.ts` (authType oauth,
 * authHeader x-api-key, baseUrl + ?beta=true urlSuffix),
 * `open-sse/config/anthropicHeaders.ts` (ANTHROPIC_VERSION_HEADER,
 * ANTHROPIC_BETA_CLAUDE_OAUTH) and
 * `open-sse/config/providers/shared.ts` (getClaudeCliHeaders). Attribution
 * retained.
 *
 * The OAuth token goes in the `x-api-key` header (NOT `Authorization`) —
 * that's how Claude Code itself authenticates. The `oauth-2025-04-20` beta
 * flag is required for OAuth tokens; API keys must NOT send it.
 *
 * ⚠️ UNOFFICIAL — see packs/web-session/src/providers/claude.ts for warnings.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { refreshClaudeAccessToken } from "@llmswitch/web-session";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ResolvedProvider,
} from "../providers/types.js";
import { classifyStatus, UpstreamError, summarizeUpstreamBody } from "../router/errors.js";
import { anthropicStreamEvent, fromAnthropicResponse, toAnthropicRequest } from "../translator/anthropic.js";
import type { ExecuteResult } from "./http.js";

/* ------------------------------------------------------------------ *
 * Constants (ported from OmniRoute anthropicHeaders.ts)
 * ------------------------------------------------------------------ */

/** Registry baseUrl + urlSuffix. */
export const CLAUDE_OAUTH_MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true";

export const ANTHROPIC_VERSION_HEADER = "2023-06-01";

/**
 * ANTHROPIC_BETA_CLAUDE_OAUTH verbatim (anthropicHeaders.ts): base betas +
 * fine-grained-tool-streaming-2025-05-14 injected after the first three.
 */
export const ANTHROPIC_BETA_CLAUDE_OAUTH = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
  "advisor-tool-2026-03-01",
  "extended-cache-ttl-2025-04-11",
  "cache-diagnosis-2026-04-07",
  "code-execution-2025-08-25",
].join(",");

/**
 * Claude Code UA. OmniRoute builds this from its pinned client version;
 * approximate here (env-overridable) — it is cosmetic, the auth is the
 * token + beta flags.
 */
export function claudeCodeUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CLI_USER_AGENT?.trim() || "claude-cli/2.1.0 (external, cli)";
}

/** OAuth request headers (OmniRoute getClaudeCliHeaders, essentials). */
export function buildClaudeOAuthHeaders(accessToken: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    "x-api-key": accessToken,
    "anthropic-version": ANTHROPIC_VERSION_HEADER,
    "anthropic-beta": ANTHROPIC_BETA_CLAUDE_OAUTH,
    "anthropic-dangerous-direct-browser-access": "true",
    "user-agent": claudeCodeUserAgent(env),
    "x-app": "cli",
    "content-type": "application/json",
  };
}

/* ------------------------------------------------------------------ *
 * Credentials: env tokens or the login session (~/.llmswitch/sessions/claude.json)
 * ------------------------------------------------------------------ */

export class ClaudeAuthError extends UpstreamError {
  constructor(status: number, message: string) {
    super("auth_error", status, message);
    this.name = "ClaudeAuthError";
  }
}

export interface ClaudeCreds {
  accessToken: string;
}

function sessionPath(env: NodeJS.ProcessEnv): string {
  const dir = env.LLMSWITCH_SESSIONS_DIR ?? (env.DATA_DIR ? join(env.DATA_DIR, "sessions") : join(homedir(), ".llmswitch", "sessions"));
  return join(dir, "claude.json");
}

/** True when a usable Claude session/token is configured (sync). */
export function hasClaudeCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.CLAUDE_ACCESS_TOKEN ?? "").trim()) return true;
  if ((env.CLAUDE_OAUTH_REFRESH_TOKEN ?? "").trim()) return true;
  return existsSync(sessionPath(env));
}

interface StoredClaudeSession {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

function readStoredSession(env: NodeJS.ProcessEnv): StoredClaudeSession | null {
  try {
    const p = sessionPath(env);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as StoredClaudeSession;
  } catch {
    return null;
  }
}

/** Resolve a valid access token, refreshing from the stored refresh token when expired. */
export async function resolveClaudeCreds(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<ClaudeCreds> {
  const envAccess = (env.CLAUDE_ACCESS_TOKEN ?? "").trim();
  if (envAccess) return { accessToken: envAccess };

  const stored = readStoredSession(env);
  const refreshToken = (env.CLAUDE_OAUTH_REFRESH_TOKEN ?? "").trim() || stored?.refreshToken;
  if (stored?.accessToken && stored.expiresAt && stored.expiresAt > Date.now() + 60_000) {
    return { accessToken: stored.accessToken };
  }
  if (!refreshToken) {
    throw new ClaudeAuthError(401, "claude: no session — run: llmswitch login claude");
  }
  const fresh = await refreshClaudeAccessToken(refreshToken, fetchFn);
  return { accessToken: fresh.accessToken };
}

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

/** Minimal Anthropic-SSE parser: yields text events for content_block_delta. */
export async function* parseClaudeSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      let event = "";
      const data: string[] = [];
      for (const line of part.split("\n")) {
        const t = line.trim();
        if (t.startsWith("event:")) event = t.slice(6).trim();
        else if (t.startsWith("data:")) data.push(t.slice(5).trim());
      }
      const payload = data.join("\n");
      if (!payload) continue;
      try {
        yield { _event: event, ...(JSON.parse(payload) as Record<string, unknown>) };
      } catch {
        /* ignore malformed SSE lines */
      }
    }
  }
}

export async function executeClaudeOAuth(
  model: string,
  body: ChatCompletionRequest,
  creds: ClaudeCreds,
  opts: { fetchFn?: typeof fetch; timeoutMs?: number; env?: NodeJS.ProcessEnv; baseUrl?: string } = {},
): Promise<ExecuteResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const env = opts.env ?? process.env;
  const url = opts.baseUrl ?? CLAUDE_OAUTH_MESSAGES_URL;
  const headers = buildClaudeOAuthHeaders(creds.accessToken, env);
  const reqBody = { ...toAnthropicRequest({ ...body, model }), stream: body.stream === true };
  const started = Date.now();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(reqBody), signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new UpstreamError("timeout", 0, `claude network error: ${(err as Error).message}`);
  }

  if (res.status === 401 || res.status === 403) {
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    throw new ClaudeAuthError(
      res.status,
      `claude auth failed (HTTP ${res.status}): ${text.slice(0, 200)} — refresh the session: llmswitch login claude`,
    );
  }
  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    throw new UpstreamError(classifyStatus(res.status), res.status, summarizeUpstreamBody(res.status, text).replace(/^upstream/, "claude upstream"));
  }

  const latencyMs = Date.now() - started;

  if (body.stream === true && res.body) {
    const gen = (async function* () {
      try {
        for await (const ev of parseClaudeSSE(res.body!.getReader())) {
          const chunk = anthropicStreamEvent(ev, model);
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
    return { stream: gen as ExecuteResult["stream"], providerId: "claude", model, latencyMs, quota: null };
  }

  clearTimeout(timer);
  const json = (await res.json().catch(() => null)) as any;
  if (!json) throw new UpstreamError("server_error", res.status, "invalid JSON from claude");
  const response: ChatCompletionResponse = fromAnthropicResponse(json, model);
  return { response, providerId: "claude", model, latencyMs, quota: null };
}

/**
 * Gateway path: resolve creds (session/env + refresh) then execute.
 * Used by the router when provider.id === "claude".
 */
export async function executeClaudeOAuthChat(
  _provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 120_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExecuteResult> {
  const creds = await resolveClaudeCreds(env, fetchFn);
  return executeClaudeOAuth(model, body, creds, { fetchFn, timeoutMs, env });
}
