/**
 * GrokWebDriver — Grok web chat driven over grok.com's internal NDJSON API,
 * using the user's imported `sso` cookie.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53):
 *   - open-sse/config/providers/registry/grok-web/index.ts
 *     (baseUrl https://grok.com/rest/app-chat/conversations/new)
 *   - open-sse/executors/grok-web.ts (payload, headers, NDJSON stream parsing)
 *   - open-sse/executors/grok-web/types.ts (stream event shapes)
 *   - open-sse/services/tokenExtractionConfig.ts (cookie: `sso` on .grok.com)
 *
 * Protocol (from OmniRoute's executor):
 *   POST https://grok.com/rest/app-chat/conversations/new with a JSON payload
 *   (temporary:true, modeId:<mode>, message:<flattened conversation>, plus a
 *   fixed block of UI flags) and headers including a randomized
 *   `x-statsig-id`. The response is newline-delimited JSON (NOT SSE); each
 *   line is { result: { response: { token, isThinking, modelResponse? } } }.
 *   Streamed content arrives as response.token deltas; a final
 *   response.modelResponse.message carries the complete message.
 *
 * ⚠️ Reverse-engineered protocol — it rots. Mock-tested only.
 * NEEDS LIVE VERIFICATION: OmniRoute talks to grok.com through a
 * TLS-impersonating client (wreq-js) because Cloudflare Enterprise rejects
 * Node's native TLS fingerprint even with a valid sso+sso-rw cookie. This
 * driver uses plain fetch, which a datacenter IP will likely be challenged
 * on; a residential connection or the official xAI API may be the only
 * working routes. The flattened-message format is also a simplification of
 * OmniRoute's buildGrokMessage().
 */
import { randomUUID, randomBytes } from "node:crypto";
import type { CookieJar } from "../../cookieJar.js";
import type { ChatMessage } from "../../cookieChat.js";
import {
  BROWSER_UA,
  WebChatError,
  harvestCookies,
  requireCookieHeader,
  type WebChatDriver,
} from "./types.js";

const GROK_CHAT_API = "https://grok.com/rest/app-chat/conversations/new";
const GROK_LEGACY_UA = BROWSER_UA;

interface GrokModelInfo {
  modeId: string;
  isThinking: boolean;
}

/** OmniRoute MODEL_MAP: OmniRoute model id -> grok modeId (subset + legacy aliases). */
const MODEL_MAP: Record<string, GrokModelInfo> = {
  fast: { modeId: "fast", isThinking: false },
  expert: { modeId: "expert", isThinking: true },
  heavy: { modeId: "heavy", isThinking: true },
  "grok-420-computer-use-sa": { modeId: "grok-420-computer-use-sa", isThinking: true },
  "grok-4": { modeId: "fast", isThinking: false },
  "grok-4.1-fast": { modeId: "fast", isThinking: false },
  "grok-4.1-expert": { modeId: "expert", isThinking: true },
  "grok-4-heavy": { modeId: "heavy", isThinking: true },
  "grok-4.20": { modeId: "expert", isThinking: true },
  "grok-4.20-heavy": { modeId: "heavy", isThinking: true },
  "grok-4.3": { modeId: "grok-420-computer-use-sa", isThinking: true },
};

/** OmniRoute generateStatsigId(): base64 of a plausible client TypeError. */
function generateStatsigId(): string {
  const rand = (n: number, alnum = false) => {
    const chars = alnum ? "abcdefghijklmnopqrstuvwxyz0123456789" : "abcdefghijklmnopqrstuvwxyz";
    let out = "";
    for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  };
  const msg =
    Math.random() < 0.5
      ? `x1:TypeError: Cannot read properties of null (reading 'children["${rand(5, true)}"]')`
      : `x1:TypeError: Cannot read properties of undefined (reading '${rand(10)}')`;
  return Buffer.from(msg, "utf8").toString("base64");
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** Flatten a chat history into the single message string grok-web accepts. */
function flattenMessages(messages: ChatMessage[]): string {
  if (messages.length === 1) return messages[0]!.content;
  return messages
    .map((m) =>
      m.role === "system"
        ? m.content
        : `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`,
    )
    .join("\n\n");
}

interface GrokStreamResponse {
  token?: string;
  isThinking?: boolean;
  modelResponse?: { message?: string };
}
interface GrokStreamEvent {
  result?: { response?: GrokStreamResponse };
  error?: { message?: string; code?: string };
}

async function* ndjsonLines(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) yield line;
    }
  }
  const tail = buf.trim();
  if (tail) yield tail;
}

export class GrokWebDriver implements WebChatDriver {
  readonly id = "grok-web";
  readonly cookieDomains = ["grok.com"];
  readonly cookieHint =
    "sign in at grok.com in your browser and import the `sso` cookie for .grok.com";

  private cookie = "";

  constructor(
    private jar: CookieJar,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async bootstrap(): Promise<void> {
    // Idempotent: (re)read the cookie header. Grok's protocol has no separate
    // session-exchange step in OmniRoute — the sso cookie IS the session.
    this.cookie = requireCookieHeader(this.jar, GROK_CHAT_API, this.id, this.cookieHint);
  }

  async *chatStream(model: string, messages: ChatMessage[]): AsyncGenerator<string> {
    await this.bootstrap();
    const info = MODEL_MAP[model] ?? { modeId: "fast", isThinking: false };
    const message = flattenMessages(messages);
    if (!message.trim()) throw new WebChatError(this.id, "no message provided");

    // Payload shape ported 1:1 from OmniRoute's executor.
    const payload: Record<string, unknown> = {
      temporary: true,
      modeId: info.modeId,
      message,
      fileAttachments: [],
      imageAttachments: [],
      disableSearch: false,
      enableImageGeneration: false,
      returnImageBytes: false,
      returnRawGrokInXaiRequest: false,
      enableImageStreaming: false,
      imageGenerationCount: 0,
      forceConcise: false,
      toolOverrides: {},
      enableSideBySide: true,
      sendFinalMetadata: true,
      isReasoning: false,
      disableTextFollowUps: false,
      disableMemory: true,
      forceSideBySide: false,
      isAsyncChat: false,
      disableSelfHarmShortCircuit: false,
      deviceEnvInfo: {
        darkModeEnabled: false,
        devicePixelRatio: 2,
        screenWidth: 2056,
        screenHeight: 1329,
        viewportWidth: 2056,
        viewportHeight: 1083,
      },
    };

    const headers: Record<string, string> = {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      "content-type": "application/json",
      origin: "https://grok.com",
      referer: "https://grok.com/",
      "user-agent": GROK_LEGACY_UA,
      "x-statsig-id": generateStatsigId(),
      "x-xai-request-id": randomUUID(),
      traceparent: `00-${randomHex(16)}-${randomHex(8)}-00`,
      cookie: this.cookie,
    };

    const res = await this.fetchFn(GROK_CHAT_API, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
    harvestCookies(this.jar, res, GROK_CHAT_API);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new WebChatError(
          this.id,
          `Grok auth failed (HTTP ${res.status}) — the sso cookie may be expired; re-import it (${this.cookieHint})`,
        );
      }
      if (res.status === 429) {
        throw new WebChatError(this.id, "Grok rate limited (HTTP 429) — wait and retry");
      }
      throw new WebChatError(this.id, `Grok returned HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    let emitted = false;
    for await (const line of ndjsonLines(res.body)) {
      let ev: GrokStreamEvent;
      try {
        ev = JSON.parse(line) as GrokStreamEvent;
      } catch {
        continue; // skip non-JSON lines
      }
      if (ev.error) {
        throw new WebChatError(
          this.id,
          `Grok stream error: ${ev.error.message ?? ev.error.code ?? "unknown"}`,
        );
      }
      const resp = ev.result?.response;
      if (!resp) continue;
      if (resp.modelResponse?.message) {
        // Final complete message. Only use it if no token deltas arrived
        // (otherwise it would duplicate the streamed text).
        if (!emitted) {
          emitted = true;
          yield resp.modelResponse.message;
        }
        continue;
      }
      if (typeof resp.token === "string" && resp.token) {
        if (resp.isThinking) continue; // thinking tokens are not content
        emitted = true;
        yield resp.token;
      }
    }
  }

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    let text = "";
    for await (const delta of this.chatStream(model, messages)) text += delta;
    return text;
  }
}
