/**
 * Zed Hosted Models executor — SIMPLIFIED port.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `open-sse/executors/zed-hosted.ts` (thread envelope,
 * NDJSON stream), `open-sse/shared/zedAuth.ts` (LLM-token exchange,
 * model-catalog, provider spellings). Attribution retained per MIT.
 *
 * Wire:
 *   1. LLM token: POST https://cloud.zed.dev/client/llm_tokens with the
 *      user auth header "<userId> <accessToken>" → { token } (short-lived;
 *      cached in memory for 45 min).
 *   2. Completions: POST https://cloud.zed.dev/completions
 *      { thread_id, prompt_id?, provider, model, provider_request }
 *      where provider ∈ {anthropic, open_ai, google, x_ai} and
 *      provider_request is the provider-native request body (translated
 *      from the OpenAI chat request with LLMSwitch's own translators).
 *   3. Response: NDJSON lines `{"event": <provider-shaped-chunk>}` /
 *      `{"status": ...}` / `[DONE]` — each event is translated back to an
 *      OpenAI chunk with the matching translator.
 *
 * What this port drops: live /models catalog resolution (provider is
 * inferred from the model id — anthropic/claude, google/gemini, openai/gpt,
 * x_ai/grok prefixes; overridden by env ZED_PROVIDER_OVERRIDES JSON or
 * per-call model prefix), the Anthropic think-close marker policy, and
 * trial_blocked-specific messaging beyond the upstream message.
 *
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED — see packs/web-session for warnings.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ResolvedProvider,
} from "../providers/types.js";
import { classifyStatus, UpstreamError } from "../router/errors.js";
import { toAnthropicRequest, fromAnthropicResponse, anthropicStreamEvent } from "../translator/anthropic.js";
import { toGeminiRequest, fromGeminiResponse, geminiStreamEvent } from "../translator/gemini.js";
import type { ExecuteResult } from "./http.js";

export const ZED_CLOUD_BASE_URL = "https://cloud.zed.dev";
export const ZED_LLM_TOKEN_PATH = "/client/llm_tokens";
export const ZED_COMPLETIONS_PATH = "/completions";

/** Wire values for the /completions `provider` field (exact spellings from Zed's GET /models catalog). */
export const ZED_PROVIDERS = {
  anthropic: "anthropic",
  open_ai: "open_ai",
  google: "google",
  x_ai: "x_ai",
} as const;
export type ZedWireProvider = (typeof ZED_PROVIDERS)[keyof typeof ZED_PROVIDERS];

function sessionPath(env: NodeJS.ProcessEnv): string {
  const dir = env.LLMSWITCH_SESSIONS_DIR ?? join(homedir(), ".llmswitch", "sessions");
  return join(dir, "zed-hosted.json");
}

export interface ZedHostedCreds {
  userId: string;
  accessToken: string;
  systemId?: string;
}

export function hasZedHostedCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.ZED_HOSTED_ACCESS_TOKEN ?? "").trim()) return true;
  return existsSync(sessionPath(env));
}

interface StoredZedSession {
  accessToken?: string;
  meta?: { userId?: string; systemId?: string };
}

export function resolveZedHostedCreds(env: NodeJS.ProcessEnv = process.env): ZedHostedCreds {
  const envToken = (env.ZED_HOSTED_ACCESS_TOKEN ?? "").trim();
  const envUser = (env.ZED_HOSTED_USER_ID ?? "").trim();
  if (envToken && envUser) return { userId: envUser, accessToken: envToken };
  const p = sessionPath(env);
  if (existsSync(p)) {
    try {
      const s = JSON.parse(readFileSync(p, "utf8")) as StoredZedSession;
      if (s.accessToken && s.meta?.userId) {
        return { userId: s.meta.userId, accessToken: s.accessToken, systemId: s.meta.systemId };
      }
    } catch {
      /* fall through */
    }
  }
  throw new UpstreamError("auth_error", 401, "zed-hosted: no session — run: llmswitch login zed-hosted");
}

/** The user auth header Zed expects: "<userId> <accessToken>" (OmniRoute buildZedUserAuthHeader). */
export function buildZedUserAuthHeader(creds: ZedHostedCreds): string {
  return `${creds.userId} ${creds.accessToken}`;
}

/* ------------------------------------------------------------------ *
 * LLM-token exchange (OmniRoute zedAuth `fetchZedLlmToken`), cached
 * in-memory for 45 minutes (OmniRoute LLM_TOKEN_TTL_MS = 50 min).
 * ------------------------------------------------------------------ */

const llmTokenCache = new Map<string, { token: string; expiresAt: number }>();
const LLM_TOKEN_TTL_MS = 45 * 60_000;

export function clearZedLlmTokenCache(): void {
  llmTokenCache.clear();
}

export async function fetchZedLlmToken(
  creds: ZedHostedCreds,
  fetchFn: typeof fetch = fetch,
  baseUrl: string = ZED_CLOUD_BASE_URL,
): Promise<string> {
  const key = `${creds.userId}`;
  const cached = llmTokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const res = await fetchFn(`${baseUrl}${ZED_LLM_TOKEN_PATH}`, {
    method: "POST",
    headers: {
      authorization: buildZedUserAuthHeader(creds),
      accept: "application/json",
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new UpstreamError("auth_error", res.status, `zed-hosted: LLM token exchange failed: HTTP ${res.status} — re-run: llmswitch login zed-hosted`);
  }
  const j = (await res.json().catch(() => null)) as { token?: string; llm_token?: string } | null;
  const token = j?.token ?? j?.llm_token;
  if (!token) throw new UpstreamError("auth_error", res.status, "zed-hosted: LLM token exchange returned no token");
  llmTokenCache.set(key, { token, expiresAt: Date.now() + LLM_TOKEN_TTL_MS });
  return token;
}

/* ------------------------------------------------------------------ *
 * Provider inference + request translation (simplified OmniRoute
 * `normalizeZedProvider` + `buildProviderRequest`).
 * ------------------------------------------------------------------ */

/** Infer the wire provider from the model id; catalog override via env ZED_PROVIDER_OVERRIDES={"model-id":"google"}. */
export function inferZedWireProvider(model: string, env: NodeJS.ProcessEnv = process.env): ZedWireProvider {
  try {
    const overrides = JSON.parse(env.ZED_PROVIDER_OVERRIDES ?? "{}") as Record<string, string>;
    const o = overrides[model];
    if (o && Object.values(ZED_PROVIDERS).includes(o as ZedWireProvider)) return o as ZedWireProvider;
  } catch {
    /* ignore */
  }
  const m = model.toLowerCase();
  if (m.includes("claude")) return ZED_PROVIDERS.anthropic;
  if (m.includes("gemini")) return ZED_PROVIDERS.google;
  if (m.includes("grok") || m.includes("xai")) return ZED_PROVIDERS.x_ai;
  return ZED_PROVIDERS.open_ai;
}

export function buildZedProviderRequest(
  provider: ZedWireProvider,
  model: string,
  body: ChatCompletionRequest,
  stream: boolean,
): Record<string, unknown> {
  if (provider === ZED_PROVIDERS.anthropic) {
    return { ...toAnthropicRequest({ ...body, model }), stream };
  }
  if (provider === ZED_PROVIDERS.google) {
    return { ...toGeminiRequest({ ...body, model }), stream };
  }
  // open_ai / x_ai (OpenAI-shaped upstream): pass through.
  return { ...body, model, stream };
}

export function buildZedPayload(
  provider: ZedWireProvider,
  model: string,
  providerRequest: Record<string, unknown>,
  threadId?: string,
): Record<string, unknown> {
  return {
    thread_id: threadId ?? randomUUID(),
    provider,
    model,
    provider_request: providerRequest,
  };
}

/* ------------------------------------------------------------------ *
 * NDJSON response parsing → OpenAI text.
 * ------------------------------------------------------------------ */

/** Extract assistant text from one provider-shaped NDJSON event. */
export function textFromZedEvent(provider: ZedWireProvider, event: unknown, model: string): string {
  try {
    if (provider === ZED_PROVIDERS.anthropic) {
      const chunk = anthropicStreamEvent(event, model);
      const content = (chunk?.choices as Array<{ delta?: { content?: string } }> | undefined)?.[0]?.delta?.content;
      return content ?? "";
    }
    if (provider === ZED_PROVIDERS.google) {
      const chunk = geminiStreamEvent(event, model);
      const content = (chunk?.choices as Array<{ delta?: { content?: string } }> | undefined)?.[0]?.delta?.content;
      return content ?? "";
    }
    const chunk = event as { choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }> };
    return chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? "";
  } catch {
    return "";
  }
}

export async function executeZedHostedChat(
  _provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 120_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExecuteResult> {
  const creds = resolveZedHostedCreds(env);
  const llmToken = await fetchZedLlmToken(creds, fetchFn);
  const wireProvider = inferZedWireProvider(model, env);
  const stream = body.stream === true;
  const providerRequest = buildZedProviderRequest(wireProvider, model, body, stream);
  const threadId = (body as unknown as Record<string, unknown>).thread_id;
  const payload = buildZedPayload(
    wireProvider,
    model,
    providerRequest,
    typeof threadId === "string" ? threadId : undefined,
  );
  const started = Date.now();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(`${ZED_CLOUD_BASE_URL}${ZED_COMPLETIONS_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${llmToken}`,
        "content-type": "application/json",
        accept: "application/x-ndjson, text/event-stream, */*",
        "x-zed-client-supports-status-messages": "true",
        "x-zed-client-supports-stream-ended-request-completion-status": "true",
        ...(creds.systemId ? { "x-zed-system-id": creds.systemId } : {}),
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new UpstreamError("timeout", 0, `zed-hosted network error: ${(err as Error).message}`);
  }
  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { message?: string; code?: string };
      message = `${j.code ? `zed ${j.code}: ` : ""}${j.message ?? message}`;
    } catch {
      /* keep raw text */
    }
    throw new UpstreamError(classifyStatus(res.status), res.status, `zed-hosted upstream ${res.status}: ${message}`);
  }
  if (!res.body) {
    clearTimeout(timer);
    throw new UpstreamError("server_error", res.status, "zed-hosted: empty response body");
  }
  const latencyMs = Date.now() - started;

  async function* lines(): AsyncGenerator<{ kind: "event"; event: unknown } | { kind: "status"; status: unknown }> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          if (line === "[DONE]") return;
          try {
            const j = JSON.parse(line) as Record<string, unknown>;
            if (j.event !== undefined) yield { kind: "event", event: j.event };
            else if (j.status !== undefined) yield { kind: "status", status: j.status };
          } catch {
            /* ignore malformed lines */
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

  if (stream) {
    const gen = (async function* () {
      for await (const item of lines()) {
        if (item.kind !== "event") continue;
        const text = textFromZedEvent(wireProvider, item.event, model);
        if (text) {
          yield {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
          };
        }
      }
    })();
    return { stream: gen as ExecuteResult["stream"], providerId: "zed-hosted", model, latencyMs, quota: null };
  }

  let full = "";
  for await (const item of lines()) {
    if (item.kind !== "event") continue;
    full += textFromZedEvent(wireProvider, item.event, model);
  }
  const response: ChatCompletionResponse = {
    id: `chatcmpl-${Date.now()}`,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: full }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  return { response, providerId: "zed-hosted", model, latencyMs, quota: null };
}
