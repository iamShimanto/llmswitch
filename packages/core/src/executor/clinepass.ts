/**
 * ClinePass executor — OpenAI-compatible SSE at api.cline.bot.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `open-sse/config/providers/registry/clinepass/index.ts`.
 * Attribution retained per MIT.
 *
 * Wire notes (from the registry entry):
 *   - ClinePass is streaming-only upstream; a non-streaming request returns
 *     "generateText is not implemented" / an empty body. So this executor
 *     always sends stream:true upstream (forceStream) and accumulates the
 *     SSE back into a JSON completion when the client asked non-streaming.
 *   - Extra headers HTTP-Referer: https://cline.bot + X-Title: Cline.
 *   - Auth: Bearer — the OAuth access token or a pasted BYOK API key.
 * Credential resolution mirrors the web-session pack session file
 * (~/.llmswitch/sessions/clinepass.json) + env overrides, with OAuth
 * refresh inline (same split as antigravity).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ResolvedProvider,
} from "../providers/types.js";
import { classifyStatus, UpstreamError } from "../router/errors.js";
import type { ExecuteResult } from "./http.js";

export const CLINEPASS_CHAT_URL = "https://api.cline.bot/api/v1/chat/completions";
export const CLINEPASS_REFRESH_URL = "https://api.cline.bot/api/v1/auth/refresh";
export const CLINEPASS_EXTRA_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://cline.bot",
  "X-Title": "Cline",
};

function sessionPath(env: NodeJS.ProcessEnv): string {
  const dir = env.LLMSWITCH_SESSIONS_DIR ?? join(homedir(), ".llmswitch", "sessions");
  return join(dir, "clinepass.json");
}

export interface ClinePassCreds {
  accessToken: string;
  byok: boolean;
}

export function hasClinepassCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.CLINEPASS_API_KEY ?? "").trim()) return true;
  if ((env.CLINEPASS_ACCESS_TOKEN ?? "").trim()) return true;
  return existsSync(sessionPath(env));
}

interface StoredClinePassSession {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  meta?: { authMethod?: string };
}

function readStoredSession(env: NodeJS.ProcessEnv): StoredClinePassSession | null {
  try {
    const p = sessionPath(env);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as StoredClinePassSession;
  } catch {
    return null;
  }
}

export async function resolveClinepassCreds(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<ClinePassCreds> {
  const envKey = (env.CLINEPASS_API_KEY ?? "").trim();
  if (envKey) return { accessToken: envKey, byok: true };
  const envToken = (env.CLINEPASS_ACCESS_TOKEN ?? "").trim();
  if (envToken) return { accessToken: envToken, byok: false };

  const stored = readStoredSession(env);
  if (!stored?.accessToken) {
    throw new UpstreamError(
      "auth_error",
      401,
      "clinepass: no session — run: llmswitch login clinepass (or llmswitch import-token clinepass <api-key>)",
    );
  }
  const byok = stored.meta?.authMethod === "byok";
  if (byok || !stored.expiresAt || stored.expiresAt > Date.now() + 60_000) {
    return { accessToken: stored.accessToken, byok };
  }
  if (!stored.refreshToken) return { accessToken: stored.accessToken, byok };
  const res = await fetchFn(CLINEPASS_REFRESH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ refreshToken: stored.refreshToken, grantType: "refresh_token", clientType: "extension" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new UpstreamError("auth_error", 401, `clinepass token refresh failed: HTTP ${res.status} — re-run: llmswitch login clinepass`);
  }
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const data = ((payload?.data as Record<string, unknown>) || payload || {}) as { accessToken?: string };
  if (!data.accessToken) {
    throw new UpstreamError("auth_error", 401, "clinepass token refresh: no access token in response");
  }
  return { accessToken: data.accessToken, byok: false };
}

export function buildClinepassHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    ...CLINEPASS_EXTRA_HEADERS,
  };
}

/** Execute — always streams upstream (forceStream); accumulates for non-stream clients. */
export async function executeClinepassChat(
  _provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 120_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExecuteResult> {
  const creds = await resolveClinepassCreds(env, fetchFn);
  const url = (env.CLINEPASS_BASE_URL ?? "").trim()
    ? `${(env.CLINEPASS_BASE_URL as string).replace(/\/$/, "")}/chat/completions`
    : CLINEPASS_CHAT_URL;
  const upstreamBody = { ...body, model, stream: true };
  const started = Date.now();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: buildClinepassHeaders(creds.accessToken),
      body: JSON.stringify(upstreamBody),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new UpstreamError("timeout", 0, `clinepass network error: ${(err as Error).message}`);
  }
  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    // Tolerate OmniRoute's legacy {success, data} envelope error shape.
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string }; message?: string };
      message = j?.error?.message ?? j?.message ?? message;
    } catch {
      /* keep raw text */
    }
    throw new UpstreamError(classifyStatus(res.status), res.status, `clinepass upstream ${res.status}: ${message}`);
  }
  if (!res.body) {
    clearTimeout(timer);
    throw new UpstreamError("server_error", res.status, "clinepass: empty response body");
  }
  const latencyMs = Date.now() - started;

  async function* chunks(): AsyncGenerator<{ chunk: Record<string, unknown> }> {
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
              yield { chunk: JSON.parse(payload) as Record<string, unknown> };
            } catch {
              /* ignore malformed SSE lines */
            }
          }
        }
      }
    } finally {
      clearTimeout(timer);
      try {
        await reader.cancel();
      } catch {
        /* noop */
      }
    }
  }

  if (body.stream === true) {
    const gen = (async function* () {
      for await (const { chunk } of chunks()) yield chunk;
    })();
    return { stream: gen as ExecuteResult["stream"], providerId: "clinepass", model, latencyMs, quota: null };
  }

  let full = "";
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let finishReason = "stop";
  for await (const { chunk } of chunks()) {
    const c = chunk as {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const choice = c.choices?.[0];
    if (choice?.delta?.content) full += choice.delta.content;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (c.usage) {
      usage = {
        prompt_tokens: c.usage.prompt_tokens ?? 0,
        completion_tokens: c.usage.completion_tokens ?? 0,
        total_tokens: c.usage.total_tokens ?? 0,
      };
    }
  }
  const response: ChatCompletionResponse = {
    id: `chatcmpl-${Date.now()}`,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: full }, finish_reason: finishReason }],
    usage,
  };
  return { response, providerId: "clinepass", model, latencyMs, quota: null };
}
