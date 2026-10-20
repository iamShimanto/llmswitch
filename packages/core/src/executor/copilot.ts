/**
 * GitHub Copilot / GitHub Enterprise Copilot executor (OpenAI-wire).
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53): `open-sse/config/providers/registry/github/index.ts`
 * (chat/completions base, device-flow OAuth client) and
 * `open-sse/executors/github.ts` (refreshCopilotToken →
 * https://api.github.com/copilot_internal/v2/token with `token` auth,
 * refreshGitHubToken with client_id and NO client_secret, 5-min expiry
 * margin, chat fingerprint headers).
 *
 * Flow: the gateway holds a long-lived GitHub OAuth token (from
 * `llmswitch login copilot` → ~/.llmswitch/sessions/github-copilot.json).
 * At call time we exchange it for a SHORT-LIVED Copilot token (cached in
 * memory) and POST OpenAI-wire chat/completions with the CLI's header
 * fingerprint. ghe-copilot is streaming-only upstream (OmniRoute
 * forceStream), so non-stream client calls are sent with stream:true and
 * drained back into one JSON response.
 *
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED — see the web-session pack's
 * providers/githubCopilot.ts for the ToS caveats.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ResolvedProvider,
} from "../providers/types.js";
import type { ExecuteResult } from "./http.js";
import { classifyError, classifyStatus, UpstreamError, summarizeUpstreamBody } from "../router/errors.js";
import { parseQuotaHeaders } from "../quota/telemetry.js";

/* ------------------------------------------------------------------ *
 * Fingerprint + exchange constants — ported from OmniRoute's
 * open-sse/config/providerHeaderProfiles.ts (live @github/copilot CLI
 * capture) and executors/github.ts. Kept in core (duplicated from the
 * web-session pack) so the gateway path needs no pack dependency.
 * ------------------------------------------------------------------ */

export const COPILOT_PUBLIC_CLIENT_ID =
  "Iv1.b507a08c87ecfe98"; // public device-flow client (no client_secret)
export const COPILOT_CLI_VERSION = "1.0.91"; // OmniRoute GITHUB_COPILOT_CLI_VERSION
export const COPILOT_API_VERSION = "2026-08-01";
export const GITHUB_COPILOT_CHAT_BASE_URL = "https://api.githubcopilot.com";
export const COPILOT_TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

export function copilotClientId(env: NodeJS.ProcessEnv = process.env): string {
  return env.GITHUB_OAUTH_CLIENT_ID?.trim() || COPILOT_PUBLIC_CLIENT_ID;
}

function cliVersion(env: NodeJS.ProcessEnv): string {
  return env.GITHUB_COPILOT_CLI_VERSION?.trim() || COPILOT_CLI_VERSION;
}

function machineId(env: NodeJS.ProcessEnv): string {
  const override = env.GITHUB_COPILOT_MACHINE_ID?.trim();
  if (override) return override;
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export function buildCopilotChatHeaders(
  copilotToken: string,
  env: NodeJS.ProcessEnv,
  opts: { vision?: boolean; initiator?: string } = {},
): Record<string, string> {
  const v = cliVersion(env);
  const headers: Record<string, string> = {
    authorization: `Bearer ${copilotToken}`,
    "copilot-integration-id": "copilot-developer-cli",
    "editor-version": `copilot/${v}`,
    "user-agent": `copilot/${v} (${process.platform}) term/unknown`,
    "openai-intent": "conversation-agent",
    "x-interaction-type": "conversation-user",
    "copilot-harness-id": "copilot-sdk",
    "x-github-api-version": COPILOT_API_VERSION,
    "x-client-machine-id": machineId(env),
    "X-Initiator": opts.initiator ?? "user",
    accept: "application/json",
    "content-type": "application/json",
  };
  if (opts.vision) headers["copilot-vision-request"] = "true";
  return headers;
}

function buildCopilotExchangeHeaders(githubToken: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const v = cliVersion(env);
  return {
    authorization: `token ${githubToken}`,
    accept: "application/json",
    "User-Agent": "GithubCopilot/1.0",
    "Editor-Version": `copilot/${v}`,
    "Editor-Plugin-Version": `copilot/${v}`,
  };
}

/* ------------------------------------------------------------------ *
 * Credentials
 * ------------------------------------------------------------------ */

export class CopilotAuthError extends UpstreamError {
  constructor(status: number, message: string) {
    super("auth_error", status, message);
    this.name = "CopilotAuthError";
  }
}

const loginHint = (id: string) =>
  id === "ghe-copilot" ? "llmswitch login ghe-copilot (or: llmswitch login copilot --ghe <host>)" : "llmswitch login copilot";

export interface CopilotCreds {
  /** short-lived copilot bearer token */
  copilotToken: string;
  /** chat API base, e.g. https://api.githubcopilot.com or endpoints.api from the exchange */
  apiBaseUrl: string;
  email?: string;
}

function sessionPath(env: NodeJS.ProcessEnv, id: string, accountId?: string | null): string {
  const dir = env.LLMSWITCH_SESSIONS_DIR ?? (env.DATA_DIR ? join(env.DATA_DIR, "sessions") : join(homedir(), ".llmswitch", "sessions"));
  const base = id === "ghe-copilot" ? "ghe-copilot" : "github-copilot";
  return join(dir, accountId ? `${base}--${accountId}.json` : `${base}.json`);
}

/** True when a usable Copilot session/token is configured (sync). */
export function hasCopilotCreds(env: NodeJS.ProcessEnv = process.env, id = "github"): boolean {
  if ((env.COPILOT_OAUTH_TOKEN ?? "").trim()) return true;
  if ((env.COPILOT_OAUTH_REFRESH_TOKEN ?? "").trim()) return true;
  return existsSync(sessionPath(env, id));
}

interface StoredCopilotSession {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  copilotToken?: string;
  copilotTokenExpiresAt?: number;
  copilotApiUrl?: string;
  gheHost?: string;
  email?: string;
}

function readStoredSession(env: NodeJS.ProcessEnv, id: string, accountId?: string | null): StoredCopilotSession | null {
  try {
    const p = sessionPath(env, id, accountId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as StoredCopilotSession;
  } catch {
    return null;
  }
}

/** short-lived copilot token cache (per provider id), in-memory */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function clearCopilotTokenCache(id?: string): void {
  if (id) {
    for (const k of [...tokenCache.keys()]) {
      if (k === id || k.startsWith(`${id}:`)) tokenCache.delete(k);
    }
  } else tokenCache.clear();
}

function gheHost(env: NodeJS.ProcessEnv, id: string, stored: StoredCopilotSession | null): string | null {
  if (id !== "ghe-copilot") return null;
  const h = (env.GHE_COPILOT_HOST ?? "").trim() || (stored?.gheHost ?? "").trim();
  return h ? h.replace(/\/+$/, "") : null;
}

function exchangeEndpoints(kind: string, host: string | null) {
  if (kind === "ghe-copilot") {
    return `${host}/api/v3/copilot_internal/v2/token`;
  }
  return COPILOT_TOKEN_EXCHANGE_URL;
}

async function exchangeCopilotToken(
  githubToken: string,
  exchangeUrl: string,
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
): Promise<{ token: string; expiresAt: number; apiUrl?: string } | null> {
  const res = await fetchFn(exchangeUrl, {
    headers: buildCopilotExchangeHeaders(githubToken, env),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { token?: string; expires_at?: number; endpoints?: { api?: string; proxy?: string } };
  if (!j.token) return null;
  const expiresAt =
    typeof j.expires_at === "number" && j.expires_at > 0
      ? (j.expires_at < 1e12 ? j.expires_at * 1000 : j.expires_at)
      : Date.now() + 30 * 60 * 1000;
  return { token: j.token, expiresAt, apiUrl: j.endpoints?.api };
}

async function refreshGitHubToken(
  refreshToken: string,
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
  id: string,
  host: string | null,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  // Copilot is a public device-flow client: client_id only, never client_secret
  // (OmniRoute executors/github.ts refreshGitHubToken, port of 9router#442).
  const params = new URLSearchParams({ grant_type: "refresh_token", client_id: copilotClientId(env) });
  params.set("refresh_token", refreshToken);
  const tokenUrl = id === "ghe-copilot" ? `${host}/login/oauth/access_token` : GITHUB_TOKEN_URL;
  const res = await fetchFn(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!j.access_token) return null;
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? refreshToken };
}

/**
 * Resolve usable creds for a chat call: fresh in-memory token, else the
 * stored session's copilot token, else exchange (falling back to the
 * refresh_token grant), else a typed auth error with a login hint.
 */
export async function resolveCopilotCreds(
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
  id: string,
  accountId?: string | null,
): Promise<CopilotCreds> {
  const cached = tokenCache.get(`${id}:${accountId ?? ""}`);
  const stored = readStoredSession(env, id, accountId);
  if (cached && cached.expiresAt - Date.now() >= 5 * 60 * 1000) {
    return {
      copilotToken: cached.token,
      apiBaseUrl: stored?.copilotApiUrl?.trim() || (id === "ghe-copilot" ? "" : GITHUB_COPILOT_CHAT_BASE_URL),
      email: stored?.email,
    };
  }
  if (stored?.copilotToken && stored.copilotTokenExpiresAt && stored.copilotTokenExpiresAt - Date.now() >= 5 * 60 * 1000) {
    tokenCache.set(`${id}:${accountId ?? ""}`, { token: stored.copilotToken, expiresAt: stored.copilotTokenExpiresAt });
    return {
      copilotToken: stored.copilotToken,
      apiBaseUrl: stored.copilotApiUrl?.trim() || (id === "ghe-copilot" ? "" : GITHUB_COPILOT_CHAT_BASE_URL),
      email: stored.email,
    };
  }

  const host = gheHost(env, id, stored);
  if (id === "ghe-copilot" && !host) {
    throw new CopilotAuthError(401, `ghe-copilot: no GHE host — set GHE_COPILOT_HOST or run: ${loginHint(id)}`);
  }
  const exchangeUrl = exchangeEndpoints(id, host);
  const githubToken = (env.COPILOT_OAUTH_TOKEN ?? "").trim() || stored?.accessToken;
  let refreshToken = (env.COPILOT_OAUTH_REFRESH_TOKEN ?? "").trim() || stored?.refreshToken;

  if (!githubToken && !refreshToken) {
    throw new CopilotAuthError(401, `${id}: no session — run: ${loginHint(id)}`);
  }
  let token = githubToken;
  let exchanged = token ? await exchangeCopilotToken(token, exchangeUrl, env, fetchFn) : null;
  if (!exchanged && refreshToken) {
    const fresh = await refreshGitHubToken(refreshToken, env, fetchFn, id, host);
    if (fresh) {
      token = fresh.accessToken;
      refreshToken = fresh.refreshToken;
      exchanged = await exchangeCopilotToken(token, exchangeUrl, env, fetchFn);
    }
  }
  if (!exchanged) {
    throw new CopilotAuthError(401, `${id}: tokens expired and could not refresh — re-run: ${loginHint(id)}`);
  }
  tokenCache.set(`${id}:${accountId ?? ""}`, { token: exchanged.token, expiresAt: exchanged.expiresAt });
  const apiBaseUrl = exchanged.apiUrl?.trim() || stored?.copilotApiUrl?.trim() || GITHUB_COPILOT_CHAT_BASE_URL;
  return { copilotToken: exchanged.token, apiBaseUrl, email: stored?.email };
}

/* ------------------------------------------------------------------ *
 * Chat execution (OpenAI-wire)
 * ------------------------------------------------------------------ */

function visionRequested(body: ChatCompletionRequest): boolean {
  try {
    return body.messages.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((c: any) => c?.type === "image_url" || c?.type === "image"),
    );
  } catch {
    return false;
  }
}

interface AccumulatedDelta {
  content: string;
  role?: string;
  toolCalls: Record<number, { id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  finishReason?: string;
  usage?: Record<string, number>;
  id?: string;
  created?: number;
}

/** Drain an SSE chat stream into a single OpenAI-shaped response (GHE force-stream shim). */
async function drainSse(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ChatCompletionResponse> {
  const decoder = new TextDecoder();
  let buf = "";
  const acc: AccumulatedDelta = { content: "", toolCalls: {} };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") continue;
        let d: any;
        try {
          d = JSON.parse(payload);
        } catch {
          continue;
        }
        if (d.id) acc.id = d.id;
        if (d.created) acc.created = d.created;
        const choice = d.choices?.[0];
        if (!choice) {
          if (d.usage) acc.usage = d.usage;
          continue;
        }
        const delta = choice.delta ?? {};
        if (typeof delta.role === "string") acc.role = delta.role;
        if (typeof delta.content === "string") acc.content += delta.content;
        for (const tc of delta.tool_calls ?? []) {
          const slot = (acc.toolCalls[tc.index ?? 0] ??= {});
          if (tc.id) slot.id = tc.id;
          if (tc.type) slot.type = tc.type;
          if (tc.function?.name) slot.function = { ...(slot.function ?? {}), name: tc.function.name };
          if (typeof tc.function?.arguments === "string") {
            slot.function = { ...(slot.function ?? {}), arguments: (slot.function?.arguments ?? "") + tc.function.arguments };
          }
        }
        if (choice.finish_reason) acc.finishReason = choice.finish_reason;
        if (d.usage) acc.usage = d.usage;
      }
    }
  }
  const toolCalls = Object.entries(acc.toolCalls)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([i, tc]) => ({ index: Number(i), id: tc.id, type: tc.type ?? "function", function: tc.function }));
  const message: Record<string, unknown> = {
    role: "assistant",
    content: acc.content,
  };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: acc.id ?? `chatcmpl-${Date.now()}`,
    model: "",
    choices: [{ index: 0, message: message as any, finish_reason: acc.finishReason ?? "stop" }],
    usage: acc.usage as any,
  };
}

/** Gateway path: resolve copilot creds (session + exchange + refresh) then execute. */
export async function executeCopilotChat(
  provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 120_000,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<ExecuteResult> {
  const creds = await resolveCopilotCreds(env, fetchFn, provider.id, accountId);
  if (!creds.apiBaseUrl) {
    throw new CopilotAuthError(401, `${provider.id}: no chat API host resolved — re-run: ${loginHint(provider.id)}`);
  }
  const streamRequested = body.stream === true;
  // GHE rejects stream:false upstream (OmniRoute forceStream): send stream:true
  // and drain back into a single JSON response when the client asked for JSON.
  const upstreamStream = provider.id === "ghe-copilot" ? true : streamRequested;
  const url = `${creds.apiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  const wireBody = { ...body, model, stream: upstreamStream };
  const headers = buildCopilotChatHeaders(creds.copilotToken, env, { vision: visionRequested(body) });

  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(wireBody),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new UpstreamError(classifyError(err), 0, `network error: ${(err as Error).message}`);
  }

  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    throw new UpstreamError(
      classifyStatus(res.status),
      res.status,
      summarizeUpstreamBody(res.status, text),
    );
  }
  const latencyMs = Date.now() - started;
  const quota = parseQuotaHeaders(res.headers);

  if (streamRequested) {
    if (!res.body) {
      clearTimeout(timer);
      throw new UpstreamError("server_error", res.status, "empty stream body");
    }
    const gen = (async function* () {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
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
      } finally {
        clearTimeout(timer);
        try {
          await res.body!.cancel();
        } catch {
          /* noop */
        }
      }
    })();
    return { stream: gen, providerId: provider.id, model, latencyMs, quota };
  }

  if (upstreamStream && !res.body) {
    clearTimeout(timer);
    throw new UpstreamError("server_error", res.status, "empty stream body");
  }
  let response: ChatCompletionResponse;
  if (upstreamStream) {
    response = await drainSse(res.body!.getReader());
    clearTimeout(timer);
  } else {
    clearTimeout(timer);
    const json = (await res.json().catch(() => null)) as any;
    if (!json) throw new UpstreamError("server_error", res.status, "invalid JSON from upstream");
    response = json as ChatCompletionResponse;
  }
  response.model = model;
  return { response, providerId: provider.id, model, latencyMs, quota };
}
