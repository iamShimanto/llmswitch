/**
 * Trae (ByteDance SOLO) executor — SIMPLIFIED port.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `open-sse/executors/trae.ts`. Attribution retained
 * per MIT.
 *
 * Wire (reverse-engineered from the solo.trae.ai / work.trae.ai web client):
 *   1. POST {base}/chat_sessions → { code: 0, data: { chat_session_id, message_id } }
 *   2. GET  {base}/chat_sessions/{id}/events?reply_to_message_id={message_id}
 *        → SSE. Assistant text streams in `plan_item` events (cumulative
 *          `thought` text per plan-item id); `token_usage` carries usage;
 *          `done` ends the turn; `error` carries upstream errors.
 * Auth: `Authorization: Cloud-IDE-JWT <JWT>` (~14-day lifetime, no
 * refresh — re-import: `llmswitch import-token trae`). Origin/Referer is
 * validated against the JWT session's web origin (OmniRoute #12190):
 * default https://work.trae.ai (env TRAE_WEB_ORIGIN to override).
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

export const TRAE_API_BASE_URL = "https://core-normal.trae.ai/api/remote/v1";
export const TRAE_DEFAULT_WEB_ORIGIN = "https://work.trae.ai";

function sessionPath(env: NodeJS.ProcessEnv): string {
  const dir = env.LLMSWITCH_SESSIONS_DIR ?? (env.DATA_DIR ? join(env.DATA_DIR, "sessions") : join(homedir(), ".llmswitch", "sessions"));
  return join(dir, "trae.json");
}

export interface TraeCreds {
  token: string;
  identity: {
    webId?: string;
    bizUserId?: string;
    userUniqueId?: string;
    scope?: string;
    tenant?: string;
    region?: string;
    aiRegion?: string;
    userTimezone?: string;
  };
}

export function hasTraeCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.TRAE_ACCESS_TOKEN ?? "").trim()) return true;
  if ((env.TRAE_CLOUD_IDE_JWT ?? "").trim()) return true;
  return existsSync(sessionPath(env));
}

export function resolveTraeCreds(env: NodeJS.ProcessEnv = process.env): TraeCreds {
  const envToken = (env.TRAE_ACCESS_TOKEN ?? "").trim() || (env.TRAE_CLOUD_IDE_JWT ?? "").trim();
  if (envToken) return { token: envToken, identity: {} };
  try {
    const p = sessionPath(env);
    if (existsSync(p)) {
      const s = JSON.parse(readFileSync(p, "utf8")) as {
        accessToken?: string;
        expiresAt?: number;
        meta?: TraeCreds["identity"];
      };
      if (s.accessToken) {
        if (s.expiresAt && s.expiresAt <= Date.now()) {
          throw new UpstreamError(
            "auth_error",
            401,
            "trae: Cloud-IDE-JWT expired (~14-day lifetime, no refresh) — re-import: llmswitch import-token trae <jwt>",
          );
        }
        return { token: s.accessToken, identity: s.meta ?? {} };
      }
    }
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    /* fall through to the no-session error */
  }
  throw new UpstreamError("auth_error", 401, "trae: no token — run: llmswitch import-token trae <jwt>");
}

/** Flatten messages into Trae's query format: a JSON-encoded string of typed text blocks (OmniRoute flattenQuery). */
export function flattenTraeQuery(body: ChatCompletionRequest): string {
  const parts: string[] = [];
  for (const m of body.messages ?? []) {
    const content = m.content ?? "";
    if (m.role === "system") parts.push(`[System]\n${content}`);
    else if (m.role === "assistant") parts.push(`[Assistant]\n${content}`);
    else parts.push(content);
  }
  return JSON.stringify([{ type: "text", data: { content: parts.join("\n\n") } }]);
}

/**
 * SOLO session modes: "work" → fast auto agent (no model picker);
 * anything else runs "code" mode with auto/manual model selection.
 * Ported from OmniRoute `resolveMode`.
 */
export function resolveTraeMode(model: string): { mode: "code" | "work"; strategy: "auto" | "manual"; modelName: string } {
  const m = (model || "").trim().toLowerCase();
  if (m === "work" || m === "auto-work" || m === "solo-work") {
    return { mode: "work", strategy: "auto", modelName: "" };
  }
  const auto = !m || m === "auto";
  return { mode: "code", strategy: auto ? "auto" : "manual", modelName: auto ? "" : model };
}

/** The common_params JSON string the SOLO agent requires (OmniRoute commonParams). */
export function buildTraeCommonParams(identity: TraeCreds["identity"], mode: "code" | "work", sessionId?: string): string {
  const cp: Record<string, unknown> = {
    language: "en-us",
    app_language: "en",
    quality: "stable",
    app_version: "1.0.0.1229",
    web_id: identity.webId ?? "",
    user_identity: "Free",
    is_freshman: "0",
    biz_user_id: identity.bizUserId ?? "",
    user_unique_id: identity.userUniqueId ?? "",
    scope: identity.scope ?? "marscode-us",
    tenant: identity.tenant ?? "marscode",
    region: identity.region ?? "US-East",
    aiRegion: identity.aiRegion ?? identity.region ?? "US-East",
    is_privacy_mode: 0,
    privacy_mode: "off",
    solo_chat_mode: mode,
  };
  if (sessionId) cp.biz_session_id = sessionId;
  return JSON.stringify(cp);
}

export function buildTraeHeaders(creds: TraeCreds, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const origin = (env.TRAE_WEB_ORIGIN ?? TRAE_DEFAULT_WEB_ORIGIN).replace(/\/$/, "");
  return {
    authorization: `Cloud-IDE-JWT ${creds.token}`,
    "content-type": "application/json",
    accept: "application/json",
    origin,
    referer: `${origin}/`,
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  };
}

export function buildTraeSessionBody(
  model: string,
  body: ChatCompletionRequest,
  identity: TraeCreds["identity"],
): Record<string, unknown> {
  const { mode, strategy, modelName } = resolveTraeMode(model);
  return {
    mode,
    environment_id: "default",
    initial_message: {
      chat_session_id: "",
      content: [],
      query: flattenTraeQuery(body),
      model_name: modelName,
      agent_type: "solo_agent_remote",
      model_selection_strategy: strategy,
      common_params: buildTraeCommonParams(identity, mode),
    },
    env: "remote",
    auto_create_project: false,
    origin: "web",
  };
}

/* ------------------------------------------------------------------ *
 * Events SSE: plan_item frames carry cumulative `thought` text per
 * plan-item id; token_usage carries usage; done/error end the turn.
 * ------------------------------------------------------------------ */

export interface TraeTurnState {
  /** latest cumulative thought text per plan-item id */
  byPlanItem: Map<string, string>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** Apply one SSE frame to the accumulator; returns the newly-visible delta text. */
export function applyTraeEvent(state: TraeTurnState, eventType: string | null, data: Record<string, unknown>): string {
  const type = eventType ?? (typeof data.type === "string" ? data.type : null);
  if (type === "token_usage") {
    const u = (data.usage ?? data) as Record<string, number>;
    state.usage = {
      prompt_tokens: u.prompt_tokens ?? u.input_tokens ?? state.usage.prompt_tokens,
      completion_tokens: u.completion_tokens ?? u.output_tokens ?? state.usage.completion_tokens,
      total_tokens: u.total_tokens ?? state.usage.total_tokens,
    };
    return "";
  }
  if (type === "plan_item" || type === "message") {
    const item = (data.plan_item ?? data.item ?? data) as Record<string, unknown>;
    const id = String(item.id ?? item.plan_item_id ?? "default");
    const thought = typeof item.thought === "string" ? item.thought : typeof item.content === "string" ? item.content : "";
    const prev = state.byPlanItem.get(id) ?? "";
    state.byPlanItem.set(id, thought);
    return thought.startsWith(prev) ? thought.slice(prev.length) : thought;
  }
  return "";
}

export async function executeTraeChat(
  _provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 300_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExecuteResult> {
  const creds = resolveTraeCreds(env);
  const headers = buildTraeHeaders(creds, env);
  const base = (env.TRAE_BASE_URL ?? TRAE_API_BASE_URL).replace(/\/$/, "");
  const started = Date.now();

  // 1. create the session + submit the first turn
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let createRes: Response;
  try {
    createRes = await fetchFn(`${base}/chat_sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildTraeSessionBody(model, body, creds.identity)),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new UpstreamError("timeout", 0, `trae network error: ${(err as Error).message}`);
  }
  if (!createRes.ok) {
    clearTimeout(timer);
    const text = await createRes.text().catch(() => "");
    throw new UpstreamError(classifyStatus(createRes.status), createRes.status, `trae create session ${createRes.status}: ${text.slice(0, 300)}`);
  }
  const created = (await createRes.json().catch(() => null)) as {
    code?: number;
    data?: { chat_session_id?: string; message_id?: string };
  } | null;
  if (!created || created.code !== 0 || !created.data?.chat_session_id || !created.data?.message_id) {
    clearTimeout(timer);
    throw new UpstreamError("server_error", 502, `trae create session: unexpected response ${JSON.stringify(created).slice(0, 200)}`);
  }
  const sessionId = created.data.chat_session_id;
  const messageId = created.data.message_id;
  const latencyMs = Date.now() - started;

  // 2. consume the events stream
  const consume = async (onDelta: (text: string) => void): Promise<{ usage: TraeTurnState["usage"] }> => {
    const evRes = await fetchFn(`${base}/chat_sessions/${sessionId}/events?reply_to_message_id=${encodeURIComponent(messageId)}`, {
      method: "GET",
      headers: { ...headers, accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    if (!evRes.ok || !evRes.body) {
      throw new UpstreamError(classifyStatus(evRes.status), evRes.status, `trae events ${evRes.status}`);
    }
    const state: TraeTurnState = {
      byPlanItem: new Map(),
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    const reader = evRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let eventType: string | null = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            const t = line.trim();
            if (t.startsWith("event:")) eventType = t.slice(6).trim();
            else if (t.startsWith("data:")) {
              const payload = t.slice(5).trim();
              if (payload === "[DONE]") return { usage: state.usage };
              try {
                const data = JSON.parse(payload) as Record<string, unknown>;
                const type = eventType ?? (typeof data.type === "string" ? data.type : null);
                if (type === "error") {
                  throw new UpstreamError("server_error", 502, `trae stream error: ${JSON.stringify(data).slice(0, 300)}`);
                }
                const delta = applyTraeEvent(state, eventType, data);
                if (delta) onDelta(delta);
                if (type === "done") return { usage: state.usage };
              } catch (err) {
                if (err instanceof UpstreamError) throw err;
                /* ignore malformed frames */
              }
              eventType = null;
            }
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* noop */
      }
    }
    return { usage: state.usage };
  };

  if (body.stream === true) {
    const gen = (async function* () {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      let finished = false;
      let failure: unknown = null;
      const running = consume((text) => {
        queue.push(text);
        wake?.();
      })
        .catch((err) => {
          failure = err;
        })
        .finally(() => {
          finished = true;
          wake?.();
        });
      try {
        for (;;) {
          while (queue.length > 0) {
            yield {
              id: `chatcmpl-${Date.now()}`,
              object: "chat.completion.chunk",
              model,
              choices: [{ index: 0, delta: { role: "assistant", content: queue.shift()! }, finish_reason: null }],
            };
          }
          if (finished) break;
          await new Promise<void>((r) => {
            wake = r;
          });
        }
        if (failure) throw failure;
      } finally {
        clearTimeout(timer);
        await running.catch(() => undefined);
      }
    })();
    return { stream: gen as ExecuteResult["stream"], providerId: "trae", model, latencyMs, quota: null };
  }

  try {
    let full = "";
    const { usage } = await consume((text) => {
      full += text;
    });
    const response: ChatCompletionResponse = {
      id: `chatcmpl-${Date.now()}`,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: full }, finish_reason: "stop" }],
      usage,
    };
    return { response, providerId: "trae", model, latencyMs, quota: null };
  } finally {
    clearTimeout(timer);
  }
}
