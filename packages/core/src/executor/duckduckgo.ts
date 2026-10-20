/**
 * DuckDuckGo AI Chat (duck.ai) — anonymous, keyless executor.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * open-sse/executors/duckduckgo-web.ts @ release/v3.8.53) — attribution retained.
 * This is a deliberately MINIMAL port of their flow:
 *
 *   1. GET  {base}/duckchat/v1/status   → session tokens in `x-vqd-4` /
 *      `x-vqd-hash-1` RESPONSE headers (with `x-vqd-accept: 1` on the request)
 *   2. POST {base}/duckchat/v1/chat     → SSE stream of `data:` lines whose
 *      JSON payloads carry incremental `message` (or `content`) fragments.
 *
 * What OmniRoute has that this port does NOT: the JavaScript anti-bot
 * challenge solver (vm-evaluated proof-of-work + fe-signals), the browser
 * fingerprints session pool, and a Playwright browser-backed fallback.
 *
 * ⚠️ HONEST LIMITATION: Duck.ai gates anonymous chat behind that challenge.
 * Probed from a datacenter IP during the original P9 research, it answers
 * HTTP 418 `ERR_CHALLENGE` — so from servers/cloud VMs this executor will
 * typically surface an anti-bot error, while from residential IPs (or when
 * the challenge is not triggered) the plain flow above works. Treat it as
 * experimental; the router's fallback chain just moves on to the next
 * provider when it fails. No cookies/account are involved either way.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ResolvedProvider,
} from "../providers/types.js";
import { UpstreamError } from "../router/errors.js";
import type { ExecuteResult } from "./http.js";

/** Browser-ish headers Duck.ai expects (mirrors OmniRoute's FAKE_HEADERS). */
const BROWSER_HEADERS: Record<string, string> = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  origin: "https://duck.ai",
  referer: "https://duck.ai/",
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
};

/**
 * Duck.ai rejects `system`/`tool` roles — chat accepts user/assistant only.
 * System prompts are folded into a leading user turn (OmniRoute's
 * normalizeSystemRole does the equivalent).
 */
function normalizeMessages(messages: ChatMessage[]): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  let systemText = "";
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) systemText += (systemText ? "\n" : "") + m.content;
      continue;
    }
    if (m.role === "tool") continue; // no tool channel in the anonymous chat
    out.push({ role: m.role, content: m.content ?? "" });
  }
  if (systemText) {
    const firstUser = out.find((m) => m.role === "user");
    if (firstUser) firstUser.content = `${systemText}\n\n${firstUser.content}`;
    else out.unshift({ role: "user", content: systemText });
  }
  return out;
}

/** Extract text from one Duck.ai SSE payload (`message` or `content` field). */
function fragmentText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const rec = data as Record<string, unknown>;
  if (typeof rec.message === "string") return rec.message;
  if (typeof rec.content === "string") return rec.content;
  return "";
}

/** The durable-stream block of the chat payload (fresh RSA public key, as upstream). */
function durableStream(): Record<string, unknown> {
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const jwk = publicKey.export({ format: "jwk" }) as unknown as Record<string, unknown>;
  return {
    messageId: randomUUID(),
    conversationId: randomUUID(),
    publicKey: { ...jwk, alg: "RSA-OAEP-256", ext: true, key_ops: ["encrypt"], use: "enc" },
  };
}

/** Friendlier message for Duck.ai error bodies ({type: "ERR_CHALLENGE", ...}). */
function ddgErrorMessage(status: number, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as { type?: unknown };
    if (parsed.type === "ERR_CHALLENGE" || parsed.type === "ERR_BN_LIMIT") {
      return (
        `DuckDuckGo AI Chat anti-bot challenge (${String(parsed.type)}): anonymous chat ` +
        "is gated behind a JavaScript challenge this client does not solve. It typically " +
        "triggers on datacenter IPs (HTTP 418) — retry later or from a residential IP."
      );
    }
    if (typeof parsed.type === "string") return `DuckDuckGo AI Chat error: ${parsed.type}`;
  } catch {
    /* not JSON — fall through */
  }
  if (status === 418) {
    return "DuckDuckGo AI Chat answered HTTP 418 (anti-bot challenge) — anonymous access is blocked from this IP.";
  }
  return `DuckDuckGo AI Chat upstream ${status}: ${bodyText.slice(0, 200)}`;
}

/**
 * Execute one chat against Duck.ai's anonymous endpoint.
 * `fetchFn` is injectable for tests, mirroring executeProvider.
 */
export async function executeDuckDuckGoChat(
  provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 120_000,
): Promise<ExecuteResult> {
  const started = Date.now();
  const base = provider.baseUrl.replace(/\/$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // 1) session tokens
    const statusRes = await fetchFn(`${base}/duckchat/v1/status`, {
      method: "GET",
      headers: { ...BROWSER_HEADERS, "x-vqd-accept": "1", "cache-control": "no-store" },
      signal: ctrl.signal,
    });
    if (!statusRes.ok) {
      const text = await statusRes.text().catch(() => "");
      throw new UpstreamError(
        statusRes.status === 429 || statusRes.status === 418 ? "rate_limited" : "server_error",
        statusRes.status,
        ddgErrorMessage(statusRes.status, text),
      );
    }
    const vqd4 = statusRes.headers.get("x-vqd-4");
    const vqdHash1 = statusRes.headers.get("x-vqd-hash-1");
    if (!vqd4 && !vqdHash1) {
      throw new UpstreamError(
        "server_error",
        statusRes.status,
        "DuckDuckGo AI Chat status response carried no VQD session token — anonymous session refused (anti-bot?).",
      );
    }

    // 2) chat
    const payload = {
      model,
      metadata: {
        toolChoice: { NewsSearch: false, VideosSearch: false, LocalSearch: false, WeatherForecast: false },
      },
      messages: normalizeMessages(body.messages),
      canUseTools: false,
      canUseApproxLocation: null,
      canDelegateImageGeneration: null,
      durableStream: durableStream(),
    };
    const chatRes = await fetchFn(`${base}/duckchat/v1/chat`, {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        accept: "text/event-stream",
        "content-type": "application/json",
        ...(vqd4 ? { "x-vqd-4": vqd4 } : {}),
        ...(vqdHash1 ? { "x-vqd-hash-1": vqdHash1 } : {}),
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!chatRes.ok) {
      const text = await chatRes.text().catch(() => "");
      throw new UpstreamError(
        chatRes.status === 429 || chatRes.status === 418 ? "rate_limited" : "server_error",
        chatRes.status,
        ddgErrorMessage(chatRes.status, text),
      );
    }

    const raw = await chatRes.text();
    const fragments: string[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const frag = fragmentText(JSON.parse(data));
        if (frag) fragments.push(frag);
      } catch {
        /* ignore malformed SSE lines */
      }
    }
    const latencyMs = Date.now() - started;
    const fullText = fragments.join("");

    if (body.stream === true) {
      const gen = (async function* () {
        for (const frag of fragments) {
          yield {
            id: "chatcmpl-ddg",
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta: { content: frag }, finish_reason: null }],
          };
        }
        yield {
          id: "chatcmpl-ddg",
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
      })();
      return { stream: gen, providerId: provider.id, model, latencyMs, quota: null };
    }

    const response: ChatCompletionResponse = {
      id: "chatcmpl-ddg",
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    return { response, providerId: provider.id, model, latencyMs, quota: null };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError("server_error", 0, `duckduckgo network error: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
