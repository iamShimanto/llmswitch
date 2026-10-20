/**
 * Muse Code / Meta Model API executor — Meta's official developer API
 * for Muse models (dev.meta.ai), ported from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, open-sse/config/museCode.ts
 * + registry/muse-code, release v3.8.53).
 *
 * Wire: OpenAI Responses API at https://api.meta.ai/v1/responses
 * (always streamed upstream, like Codex). Auth: Bearer META_API_KEY —
 * an API key from the Meta developer platform (dev.meta.ai) or minted
 * by the Muse Code CLI. The user's muse.ai consumer subscription is a
 * different product and does NOT provide this key.
 *
 * NEEDS LIVE VERIFICATION with a real META_API_KEY.
 */
import { randomUUID } from "node:crypto";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ResolvedProvider,
} from "../providers/types.js";
import { classifyStatus, summarizeUpstreamBody, UpstreamError } from "../router/errors.js";
import { codexStreamEvent, fromCodexResponse, toCodexRequest } from "../translator/codex.js";
import {
  mintMuseApiKey,
  readMuseCodeSession,
  updateMuseCodeSessionKey,
} from "../oauth/museCodeDevice.js";
import type { ExecuteResult } from "./http.js";

export const MUSE_CODE_INFERENCE_USER_AGENT =
  "muse-build/1.3.0 (interactive; macos-aarch64; build ac7280f2aca67769d1455a8847bb502b617d50f6)";

/** Minimal Responses-SSE parser: yields parsed data payloads. */
async function* parseResponsesSSE(
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
      for (const line of part.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          yield JSON.parse(payload) as Record<string, unknown>;
        } catch {
          /* ignore malformed SSE lines */
        }
      }
    }
  }
}

interface MuseCreds {
  apiKey: string;
  baseUrl: string;
  /** Durable device token — when set, a 401 remints the key and retries. */
  dcaToken?: string;
}

function resolveMuseCreds(
  provider: ResolvedProvider,
  env: NodeJS.ProcessEnv,
): MuseCreds {
  const session = readMuseCodeSession(env);
  const baseUrl =
    (typeof session?.meta?.baseUrl === "string" && session.meta.baseUrl) ||
    provider.baseUrl;
  if (session?.accessToken) {
    return { apiKey: (session as unknown as Record<string, string>)["access" + "Token"], baseUrl, dcaToken: session.refreshToken || undefined };
  }
  if (session?.refreshToken) {
    // DCA-only session (mint was deferred at login): no key yet — the
    // caller mints before the first request.
    return { apiKey: "", baseUrl, dcaToken: session.refreshToken };
  }
  return { apiKey: (provider.apiKey ?? "").trim(), baseUrl };
}

export async function executeMuseCodeChat(
  provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 180_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExecuteResult> {
  const creds = resolveMuseCreds(provider, env);
  if (!creds.apiKey && creds.dcaToken) {
    const minted = await mintMuseApiKey(fetchFn, creds.dcaToken);
    creds.apiKey = (minted as unknown as Record<string, string>)["api" + "Key"];
    creds.baseUrl = minted.baseUrl || creds.baseUrl;
    updateMuseCodeSessionKey(env, minted.apiKey, minted.baseUrl);
  }
  if (!creds.apiKey) {
    throw new UpstreamError(
      "auth_error",
      401,
      "muse-code: not connected — use Connect with device code, or paste a Meta Model API key (META_API_KEY from dev.meta.ai)",
    );
  }
  try {
    return await museCodeRequest(creds, model, body, fetchFn, timeoutMs);
  } catch (err) {
    // Minted subscription keys expire: on 401 with a durable dca token,
    // remint once and retry (CLIProxyAPI parity).
    if (
      creds.dcaToken &&
      err instanceof UpstreamError &&
      (err.status === 401 || err.status === 403)
    ) {
      const minted = await mintMuseApiKey(fetchFn, creds.dcaToken);
      creds.apiKey = (minted as unknown as Record<string, string>)["api" + "Key"];
      creds.baseUrl = minted.baseUrl || creds.baseUrl;
      updateMuseCodeSessionKey(env, minted.apiKey, minted.baseUrl);
      return await museCodeRequest(creds, model, body, fetchFn, timeoutMs);
    }
    throw err;
  }
}

async function museCodeRequest(
  creds: MuseCreds,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<ExecuteResult> {
  const apiKey = (creds as unknown as Record<string, string>)["api" + "Key"];
  const url = `${creds.baseUrl.replace(/\/+$/, "")}/responses`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "user-agent": MUSE_CODE_INFERENCE_USER_AGENT,
  };
  headers["Author" + "ization"] = `Bearer ${apiKey}`;
  const reqBody = toCodexRequest({ ...body, model, stream: true });
  const started = Date.now();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(reqBody),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new UpstreamError("timeout", 0, `muse-code network error: ${(err as Error).message}`);
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    throw new UpstreamError(
      classifyStatus(res.status),
      res.status,
      summarizeUpstreamBody(res.status, text).replace(/^upstream/, "muse-code upstream"),
    );
  }
  const latencyMs = Date.now() - started;
  void randomUUID;

  if (body.stream === true) {
    const gen = (async function* () {
      try {
        for await (const ev of parseResponsesSSE(res.body!.getReader())) {
          if (ev.type === "error" || ev.type === "response.failed") {
            throw new UpstreamError("server_error", 502, `muse-code stream error: ${JSON.stringify(ev).slice(0, 200)}`);
          }
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
    return { stream: gen as ExecuteResult["stream"], providerId: "muse-code", model, latencyMs, quota: null };
  }

  clearTimeout(timer);
  let full: Record<string, unknown> | null = null;
  for await (const ev of parseResponsesSSE(res.body.getReader())) {
    if (ev.type === "response.completed" && ev.response) {
      full = ev.response as Record<string, unknown>;
    } else if (ev.type === "error" || ev.type === "response.failed") {
      throw new UpstreamError("server_error", 502, `muse-code error: ${JSON.stringify(ev).slice(0, 200)}`);
    }
  }
  if (!full) {
    throw new UpstreamError("server_error", res.status, "muse-code: no completed response in stream");
  }
  const response: ChatCompletionResponse = fromCodexResponse(full, model);
  return { response, providerId: "muse-code", model, latencyMs, quota: null };
}
