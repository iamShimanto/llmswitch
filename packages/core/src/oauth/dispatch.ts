/**
 * Dispatch for the P11-I OAuth/token-import providers.
 *
 * - codebuddy-cn / codebuddy-intl / workbuddy / openference: standard
 *   OpenAI chat-completions wire through the generic executor; the access
 *   token is resolved at call time (env → session → refresh) and the
 *   providers' client-fingerprint headers are merged in. The Tencent
 *   gateways (codebuddy-cn/intl, workbuddy) reject non-stream requests with
 *   code 11101, so a non-stream caller is served by streaming upstream and
 *   accumulating back into a single response (OmniRoute's forceStream).
 * - grok-cli: xAI Grok Build proxy speaks the OpenAI Responses API
 *   (https://cli-chat-proxy.grok.com/v1/responses) — dedicated executor.
 * - gitlab-duo: GitLab AI Gateway code_suggestions completions — dedicated
 *   executor (flattened transcript → current_file probe body).
 * - agy: same Google Cloud Code backend as antigravity, "cli" identity —
 *   reuses the antigravity executor with the agy session name.
 * - devin-desktop: token-import works, but the Connect-protobuf transport
 *   (Windsurf backend) is NOT ported — typed not_implemented error.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — wire semantics mirror
 * `open-sse/executors/codebuddy/shared.ts`, `open-sse/executors/grok-cli.ts`
 * and `open-sse/executors/gitlab.ts`. Attribution retained per MIT.
 */
import { executeAntigravityChat } from "../executor/antigravity.js";
import { executeProvider, type ExecuteResult } from "../executor/http.js";
import { UpstreamError } from "../router/errors.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ResolvedProvider,
} from "../providers/types.js";
import { resolveProviderToken, type P11IProviderId } from "./sessions.js";

/** Router dispatch hook: providers served by executeOAuthProvider below. */
export const P11I_OAUTH_IDS = new Set([
  "codebuddy-cn",
  "codebuddy-intl",
  "workbuddy",
  "grok-cli",
  "openference",
  "gitlab-duo",
  "agy",
  "devin-desktop",
]);

/** Providers that reject non-stream chat requests (Tencent gateways). */
const FORCE_STREAM_IDS = new Set(["codebuddy-cn", "codebuddy-intl", "workbuddy"]);

function flattenMessages(messages: ChatCompletionRequest["messages"]): string {
  return messages
    .map((m) => {
      const content = Array.isArray(m.content)
        ? m.content.map((p) => (typeof p === "object" && p !== null && "text" in p ? String((p as { text: unknown }).text) : "")).join("")
        : String(m.content ?? "");
      return `${m.role}: ${content}`;
    })
    .join("\n");
}

function lastUserMessage(messages: ChatCompletionRequest["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") {
      const content = m.content;
      return Array.isArray(content)
        ? content.map((p) => (typeof p === "object" && p !== null && "text" in p ? String((p as { text: unknown }).text) : "")).join("")
        : String(content ?? "");
    }
  }
  return "";
}

/** Accumulate a streaming ExecuteResult back into a single chat completion. */
async function accumulateStream(
  result: ExecuteResult,
  model: string,
  providerId: string,
): Promise<ExecuteResult> {
  if (!result.stream) return result;
  let text = "";
  for await (const chunk of result.stream) {
    const choice = (chunk as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0];
    if (typeof choice?.delta?.content === "string") text += choice.delta.content;
  }
  const response: ChatCompletionResponse = {
    id: `llmswitch-${Date.now()}`,
    model,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  };
  return { response, providerId, model, latencyMs: result.latencyMs, quota: result.quota ?? null };
}

function fetchJson(url: string, init: RequestInit, fetchFn: typeof fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  return fetchFn(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

/** Grok Build executor: OpenAI Responses API at cli-chat-proxy.grok.com. */
export async function executeGrokCliChat(
  provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch,
  env: NodeJS.ProcessEnv,
  accountId?: string | null,
): Promise<ExecuteResult> {
  const started = Date.now();
  const creds = await resolveProviderToken("grok-cli", env, fetchFn, accountId);
  const version = (env.GROK_CLI_CLIENT_VERSION ?? "").trim() || "1.0.41";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${creds.accessToken}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": version,
    "x-grok-client-surface": "headless",
    "user-agent": `grok-shell/${version}`,
  };
  const input = body.messages.map((m) => ({
    role: m.role,
    content: [
      {
        type: "input_text",
        text: Array.isArray(m.content)
          ? m.content.map((p) => (typeof p === "object" && p !== null && "text" in p ? String((p as { text: unknown }).text) : "")).join("")
          : String(m.content ?? ""),
      },
    ],
  }));
  const url = "https://cli-chat-proxy.grok.com/v1/responses";
  if (body.stream === true) {
    const res = await fetchJson(url, { method: "POST", headers, body: JSON.stringify({ model, input, stream: true }) }, fetchFn);
    if (!res.ok) throw new UpstreamError("server_error", res.status, `grok-cli: HTTP ${res.status}`);
    const bodyReader = res.body?.getReader();
    if (!bodyReader) throw new UpstreamError("server_error", res.status, "grok-cli: no response body");
    const reader: ReadableStreamDefaultReader<Uint8Array> = bodyReader;
    async function* gen(): AsyncGenerator<Record<string, unknown>> {
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
                const ev = JSON.parse(payload) as { type?: string; delta?: string; text?: string; output?: unknown };
                const delta = typeof ev.delta === "string" ? ev.delta : typeof ev.text === "string" && ev.type?.includes("delta") ? ev.text : "";
                if (delta) yield { choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] };
              } catch {
                /* ignore */
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    return { stream: gen(), providerId: provider.id, model, latencyMs: Date.now() - started };
  }
  const res = await fetchJson(url, { method: "POST", headers, body: JSON.stringify({ model, input, stream: false }) }, fetchFn);
  if (!res.ok) throw new UpstreamError("server_error", res.status, `grok-cli: HTTP ${res.status}`);
  const j = (await res.json()) as { output?: unknown };
  let text = "";
  if (Array.isArray(j.output)) {
    for (const item of j.output) {
      const it = item as { content?: Array<{ type?: string; text?: string }> };
      if (Array.isArray(it.content)) {
        for (const part of it.content) {
          if (typeof part.text === "string") text += part.text;
        }
      }
    }
  }
  const response: ChatCompletionResponse = {
    id: `grok-cli-${Date.now()}`,
    model,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  };
  return { response, providerId: provider.id, model, latencyMs: Date.now() - started };
}

/** GitLab Duo executor: code_suggestions completions (mirrors OmniRoute gitlab.ts). */
export async function executeGitLabDuoChat(
  provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch,
  env: NodeJS.ProcessEnv,
  accountId?: string | null,
): Promise<ExecuteResult> {
  const started = Date.now();
  const creds = await resolveProviderToken("gitlab-duo", env, fetchFn, accountId);
  const base = (env.GITLAB_DUO_BASE_URL || env.GITLAB_BASE_URL || "https://gitlab.com").trim().replace(/\/$/, "");
  const meta = creds.meta ?? {};
  const direct = meta.gitlabDirectAccess as { token?: string; headers?: Record<string, string>; expiresAt?: string } | undefined;
  const directValid =
    direct?.token && (!direct.expiresAt || new Date(direct.expiresAt).getTime() > Date.now() + 60_000);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${directValid && direct.token ? direct.token : creds.accessToken}`,
    ...(directValid && direct.headers ? direct.headers : {}),
  };
  const prompt = flattenMessages(body.messages);
  const reqBody = {
    current_file: { file_name: "snippet.txt", content_above_cursor: prompt, content_below_cursor: "" },
    intent: "generation",
    generation_type: "small_file",
    stream: false,
    user_instruction: lastUserMessage(body.messages) || prompt,
  };
  const res = await fetchJson(`${base}/api/v4/code_suggestions/completions`, { method: "POST", headers, body: JSON.stringify(reqBody) }, fetchFn);
  if (!res.ok) throw new UpstreamError("auth_error", res.status, `gitlab-duo: HTTP ${res.status} — re-run: llmswitch login gitlab-duo`);
  const j = (await res.json().catch(() => ({}))) as { choices?: Array<{ text?: string; message?: { content?: string } }> };
  const text = j.choices?.[0]?.text ?? j.choices?.[0]?.message?.content ?? "";
  const response: ChatCompletionResponse = {
    id: `gitlab-duo-${Date.now()}`,
    model,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  };
  return { response, providerId: provider.id, model, latencyMs: Date.now() - started };
}

/** Router entry point for the P11-I OAuth/token-import providers. */
export async function executeOAuthProvider(
  provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<ExecuteResult> {
  switch (provider.id) {
    case "agy": {
      // Same Google Cloud Code backend as antigravity; agy session file.
      const r = await executeAntigravityChat(provider, model, body, fetchFn, timeoutMs, env, "agy", accountId);
      return { ...r, providerId: "agy" }; // executor hard-codes "antigravity"; re-tag for accounting
    }
    case "grok-cli":
      return executeGrokCliChat(provider, model, body, fetchFn, env, accountId);
    case "gitlab-duo":
      return executeGitLabDuoChat(provider, model, body, fetchFn, env, accountId);
    case "devin-desktop":
      throw new UpstreamError(
        "bad_request",
        501,
        "devin-desktop: chat transport not ported (Windsurf Connect-protobuf RPC) — token import works; see BUILD_STATUS.md P11-I",
      );
    case "codebuddy-cn":
    case "codebuddy-intl":
    case "workbuddy":
    case "openference": {
      const creds = await resolveProviderToken(provider.id as P11IProviderId, env, fetchFn, accountId);
      const keyed = { ...provider, apiKey: creds.accessToken, allKeys: [creds.accessToken] };
      const stream = body.stream === true || FORCE_STREAM_IDS.has(provider.id);
      const result = await executeProvider(keyed, model, { ...body, stream }, fetchFn, timeoutMs);
      if (FORCE_STREAM_IDS.has(provider.id) && body.stream !== true) {
        return accumulateStream(result, model, provider.id);
      }
      return result;
    }
    default:
      throw new UpstreamError("bad_request", 501, `${provider.id}: no OAuth dispatch implemented`);
  }
}
