/**
 * HuggingChatDriver — HuggingChat (huggingface.co/chat) cookie web chat.
 *
 * Ported from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, release v3.8.53).
 * Source paths in OmniRoute:
 *   open-sse/executors/huggingchat.ts
 *   open-sse/executors/huggingchat/jsonlStream.ts
 *   open-sse/config/providers/registry/huggingchat/index.ts
 *   open-sse/services/tokenExtractionConfig.ts (cookie: `hf-chat`)
 *
 * Protocol (as coded upstream):
 *   1. POST https://huggingface.co/chat/conversation  { model, preprompt? }
 *      -> { conversationId }
 *   2. GET  https://huggingface.co/chat/api/v2/conversations/{id}
 *      -> { rootMessageId } (possibly superjson-wrapped as { json: {...} })
 *   3. POST https://huggingface.co/chat/conversation/{id}
 *      multipart/form-data with a single `data` field holding JSON
 *      { inputs, is_retry, is_continue, generationId, selectedMcpServerNames,
 *        selectedMcpServers, timezone, id: <rootMessageId> }
 *      -> JSONL (NDJSON) stream of MessageUpdate objects:
 *         { type: "stream", token }        text token, \0-padded — stripped
 *         { type: "finalAnswer", text }    complete response
 *         { type: "status", status }       started / keepAlive / finished /
 *                                          error (with `message`)
 *         { type: "reasoning", ... }       thinking tokens — not answer text
 *
 * ⚠️ NEEDS LIVE VERIFICATION: mock-tested only. The exact multipart payload
 * and the v2 conversations endpoint shape rot with HuggingChat frontend
 * deploys; verify with real imported `hf-chat` cookies before relying on it.
 */
import type { CookieJar } from "../../cookieJar.js";
import {
  BROWSER_UA,
  WebChatError,
  harvestCookies,
  requireCookieHeader,
  type ChatMessage,
  type WebChatDriver,
} from "./types.js";

const BASE = "https://huggingface.co";
const CONVERSATION_URL = `${BASE}/chat/conversation`;
const API_CONVERSATIONS_URL = `${BASE}/chat/api/v2/conversations`;
const DEFAULT_MODEL = "baidu/ERNIE-4.5-VL-424B-A47B-Base-PT";

/** Flatten ChatMessages into HuggingChat's single `inputs` prompt (upstream). */
function buildConversationPrompt(messages: ChatMessage[]): {
  inputs: string;
  systemPrompt: string | null;
} {
  const systemParts: string[] = [];
  const conversationParts: Array<{ role: string; content: string }> = [];

  for (const msg of messages) {
    const text = (msg.content ?? "").trim();
    if (!text) continue;
    if (msg.role === "system") systemParts.push(text);
    else conversationParts.push({ role: msg.role, content: text });
  }

  if (conversationParts.length === 0) {
    return { inputs: systemParts.join("\n\n"), systemPrompt: null };
  }
  if (conversationParts.length === 1 && conversationParts[0]!.role === "user") {
    return {
      inputs: conversationParts[0]!.content,
      systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : null,
    };
  }

  const lines = conversationParts.map(
    (p) => `${p.role === "user" ? "User" : "Assistant"}: ${p.content}`,
  );
  lines.push("Assistant:");
  return {
    inputs: lines.join("\n\n"),
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : null,
  };
}

function unwrapSuperjsonPayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return record.json && typeof record.json === "object" ? record.json : value;
}

function extractInitialParentMessageId(value: unknown): string | null {
  const payload = unwrapSuperjsonPayload(value);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.rootMessageId === "string" && record.rootMessageId.trim()) {
    return record.rootMessageId;
  }
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const last = messages.at(-1);
  if (last && typeof last === "object") {
    const id = (last as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim()) return id;
  }
  return null;
}

interface JsonlEvent {
  token?: string;
  text?: string;
  done?: boolean;
  error?: string;
}

/** Parse one HuggingChat JSONL line (port of upstream parseJsonlLine). */
function parseJsonlLine(line: string): JsonlEvent {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === "stream" && typeof event.token === "string") {
      const token = event.token.replace(/\0/g, "");
      if (token) return { token };
    }
    if (event.type === "finalAnswer" && typeof event.text === "string") {
      return { text: event.text, done: true };
    }
    if (event.type === "status") {
      if (event.status === "error") {
        return {
          error:
            typeof event.message === "string"
              ? event.message
              : "HuggingChat generation error",
        };
      }
      if (event.status === "finished") return { done: true };
    }
  } catch {
    // Skip non-JSON lines (upstream behavior).
  }
  return {};
}

/** Yield raw lines from a response body (JSONL is newline-delimited). */
async function* bodyLines(
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
      yield buf.slice(0, idx);
      buf = buf.slice(idx + 1);
    }
  }
  if (buf) yield buf;
}

export class HuggingChatDriver implements WebChatDriver {
  readonly id = "huggingchat";
  readonly cookieDomains = ["huggingface.co"];
  readonly cookieHint =
    "log in at huggingface.co/chat and import its cookies (needs the hf-chat session cookie)";

  private bootstrapped = false;

  constructor(
    private jar: CookieJar,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    requireCookieHeader(this.jar, CONVERSATION_URL, this.id, this.cookieHint);
    this.bootstrapped = true;
  }

  private headers(): Record<string, string> {
    return {
      cookie: requireCookieHeader(this.jar, CONVERSATION_URL, this.id, this.cookieHint),
      "user-agent": BROWSER_UA,
      origin: BASE,
      referer: `${BASE}/chat/`,
    };
  }

  /** Steps 1–3: create conversation, find root message id, POST the message. */
  private async sendMessage(
    model: string,
    messages: ChatMessage[],
  ): Promise<Response> {
    await this.bootstrap();
    const resolvedModel = model || DEFAULT_MODEL;
    const { inputs, systemPrompt } = buildConversationPrompt(messages);
    if (!inputs.trim()) {
      throw new WebChatError(this.id, "empty prompt after processing messages");
    }
    const headers = this.headers();

    // Step 1: create conversation.
    const createBody: Record<string, unknown> = { model: resolvedModel };
    if (systemPrompt) createBody.preprompt = systemPrompt;
    const createRes = await this.fetchFn(CONVERSATION_URL, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(createBody),
      signal: AbortSignal.timeout(60_000),
    });
    harvestCookies(this.jar, createRes, CONVERSATION_URL);
    if (!createRes.ok) {
      const text = await createRes.text().catch(() => "");
      if (createRes.status === 401 || createRes.status === 403) {
        throw new WebChatError(
          this.id,
          `HuggingChat auth failed (HTTP ${createRes.status}) — hf-chat session cookie may be missing or expired: ${this.cookieHint}`,
        );
      }
      throw new WebChatError(
        this.id,
        `HuggingChat conversation creation failed (HTTP ${createRes.status}): ${text.slice(0, 200)}`,
      );
    }
    const createData = (await createRes.json()) as Record<string, unknown>;
    const conversationId = createData.conversationId as string | undefined;
    if (!conversationId) {
      throw new WebChatError(this.id, "HuggingChat did not return a conversationId");
    }

    // Step 2: initial parent (root) message id.
    const parentMessageId = await this.fetchInitialParentMessageId(
      conversationId,
      headers,
    );
    if (!parentMessageId) {
      throw new WebChatError(
        this.id,
        "HuggingChat did not return an initial parent message id",
      );
    }

    // Step 3: POST the message as multipart form data; response is JSONL.
    const payload = {
      inputs,
      is_retry: false,
      is_continue: false,
      generationId: crypto.randomUUID(),
      selectedMcpServerNames: [] as string[],
      selectedMcpServers: [] as string[],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      id: parentMessageId,
    };
    const formData = new FormData();
    formData.append("data", JSON.stringify(payload));
    const res = await this.fetchFn(`${CONVERSATION_URL}/${conversationId}`, {
      method: "POST",
      headers,
      body: formData,
      signal: AbortSignal.timeout(120_000),
    });
    harvestCookies(this.jar, res, CONVERSATION_URL);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new WebChatError(
          this.id,
          `HuggingChat auth failed (HTTP ${res.status}) — session cookie may be expired`,
        );
      }
      if (res.status === 404) {
        throw new WebChatError(
          this.id,
          `HuggingChat model not found: ${resolvedModel}. Check the model ID.`,
        );
      }
      throw new WebChatError(
        this.id,
        `HuggingChat returned HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    if (!res.body) throw new WebChatError(this.id, "HuggingChat returned empty response body");
    return res;
  }

  private async fetchInitialParentMessageId(
    conversationId: string,
    headers: Record<string, string>,
  ): Promise<string | null> {
    const res = await this.fetchFn(`${API_CONVERSATIONS_URL}/${conversationId}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const text = await res.text().catch(() => "");
    if (!text) return null;
    try {
      return extractInitialParentMessageId(JSON.parse(text));
    } catch {
      return null;
    }
  }

  async *chatStream(
    model: string,
    messages: ChatMessage[],
  ): AsyncGenerator<string> {
    const res = await this.sendMessage(model, messages);
    let emitted = "";
    for await (const line of bodyLines(res.body)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseJsonlLine(trimmed);
      if (parsed.error) throw new WebChatError(this.id, parsed.error);
      if (parsed.token) {
        emitted += parsed.token;
        yield parsed.token;
      }
      if (parsed.text !== undefined) {
        const remaining = parsed.text.slice(emitted.length);
        if (remaining) yield remaining;
        return;
      }
      if (parsed.done) return;
    }
  }

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    let out = "";
    for await (const delta of this.chatStream(model, messages)) out += delta;
    return out;
  }
}
