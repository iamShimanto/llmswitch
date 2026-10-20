import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ResolvedProvider,
} from "../providers/types.js";
import {
  anthropicHeaders,
  anthropicStreamEvent,
  fromAnthropicResponse,
  toAnthropicRequest,
} from "../translator/anthropic.js";
import {
  fromGeminiResponse,
  geminiStreamEvent,
  geminiUrl,
  toGeminiRequest,
} from "../translator/gemini.js";
import { classifyError, classifyStatus, UpstreamError, summarizeUpstreamBody } from "../router/errors.js";
import { parseQuotaHeaders, type QuotaInfo } from "../quota/telemetry.js";

export interface ExecuteResult {
  response?: ChatCompletionResponse;
  /** Async generator of OpenAI-format SSE chunks (when stream=true). */
  stream?: AsyncGenerator<Record<string, unknown>>;
  providerId: string;
  model: string;
  latencyMs: number;
  /** true when served from prompt cache (no upstream call) */
  cached?: boolean;
  /** live quota info parsed from upstream rate-limit headers */
  quota?: QuotaInfo | null;
}

interface WireCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  toOpenAI: (json: any) => ChatCompletionResponse;
  streamEvent: ((data: any) => Record<string, unknown> | null) | null;
}

/** Build the wire-level request for a provider. */
function buildWireCall(
  provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
): WireCall {
  const stream = body.stream === true;
  switch (provider.wireFormat) {
    case "anthropic":
      return {
        url: `${provider.baseUrl}/v1/messages`,
        headers: anthropicHeaders(provider.apiKey),
        body: { ...toAnthropicRequest({ ...body, model }), stream },
        toOpenAI: (json) => fromAnthropicResponse(json, model),
        streamEvent: stream ? (d) => anthropicStreamEvent(d, model) : null,
      };
    case "gemini":
      return {
        url: geminiUrl(provider.baseUrl, model, stream, provider.apiKey),
        headers: { "content-type": "application/json" },
        body: toGeminiRequest({ ...body, model }),
        toOpenAI: (json) => fromGeminiResponse(json, model),
        streamEvent: stream ? (d) => geminiStreamEvent(d, model) : null,
      };
    case "openai":
    default:
      return {
        url: `${provider.baseUrl}${provider.chatPath ?? "/chat/completions"}`,
        headers: {
          // Keyless providers (authType "none" with no key configured) must
          // send NO Authorization header at all — several upstreams treat a
          // malformed/empty Bearer as a *bad* key and 403 instead of
          // serving the anonymous tier (OmniRoute makes the same point for
          // OVHcloud). Only attach it when a real credential exists.
          ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
          "content-type": "application/json",
          // OAuth providers with client-fingerprint headers (e.g. CodeBuddy,
          // WorkBuddy) carry them on the provider def.
          ...(provider.extraHeaders ?? {}),
        },
        body: { ...body, model, stream },
        toOpenAI: (json) => json as ChatCompletionResponse,
        streamEvent: null, // OpenAI wire is already OpenAI-shaped
      };
  }
}

async function* sseToOpenAI(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  convert: (data: any) => Record<string, unknown> | null,
  passthrough: boolean,
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
          const data = JSON.parse(payload);
          const chunk = passthrough ? data : convert(data);
          if (chunk) yield chunk;
        } catch {
          /* ignore malformed SSE lines */
        }
      }
    }
  }
}

/**
 * Execute one chat-completion against one provider.
 * `fetchFn` is injectable for tests.
 */
export async function executeProvider(
  provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 120_000,
): Promise<ExecuteResult> {
  const started = Date.now();
  const wire = buildWireCall(provider, model, body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchFn(wire.url, {
      method: "POST",
      headers: wire.headers,
      body: JSON.stringify(wire.body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new UpstreamError(classifyError(err), 0, `network error: ${(err as Error).message}`);
  } finally {
    // keep timer until body consumed for streams; cleared below for non-stream
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

  if (body.stream === true) {
    if (!res.body) {
      clearTimeout(timer);
      throw new UpstreamError("server_error", res.status, "empty stream body");
    }
    const passthrough = wire.streamEvent === null;
    const convert = wire.streamEvent ?? ((d: any) => d);
    const gen = (async function* () {
      try {
        yield* sseToOpenAI(res.body!.getReader(), convert, passthrough);
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

  clearTimeout(timer);
  const json = (await res.json().catch(() => null)) as any;
  if (!json) throw new UpstreamError("server_error", res.status, "invalid JSON from upstream");
  return { response: wire.toOpenAI(json), providerId: provider.id, model, latencyMs, quota };
}
