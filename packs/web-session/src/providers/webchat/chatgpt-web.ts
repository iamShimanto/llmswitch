/**
 * chatgpt-web — cookie web-chat driver for chatgpt.com.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — source files:
 *   - open-sse/config/providers/registry/chatgpt-web/index.ts
 *     (id "chatgpt-web", baseUrl https://chatgpt.com, authHeader "cookie",
 *     model catalog)
 *   - open-sse/utils/chatgptWebExecutorAdapter.ts
 *     (`chatGptWebStorageStateFromCookieHeader`: the credential is a Cookie
 *     header that must carry `__Secure-next-auth.session-token`; `buildPrompt`:
 *     how message lists are flattened into one prompt)
 *   - open-sse/utils/chatgptWebFirstParty.ts
 *     (session bootstrap: in-page `fetch("/api/auth/session")` → `accessToken`
 *     sent as `Authorization: Bearer …` on `/backend-api` calls;
 *     `storeConversationDraft`: the `/f/conversation` request body;
 *     `submitConversationRequest`: POST `/backend-api/f/conversation`)
 *   - open-sse/utils/chatgptWebDeltaV1.ts (`delta_encoding: v1` decoder)
 *   - open-sse/utils/chatgptWebBrowserSession.ts
 *     (`parseChatGptWebDirectConversation`, terminal assistant message shape)
 * Attribution retained per MIT.
 *
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED. This protocol ROTS FAST and using it
 * may violate OpenAI's Terms of Service; accounts can be limited or banned.
 * Mock-tested only — see NEEDS LIVE VERIFICATION notes.
 *
 * NEEDS LIVE VERIFICATION:
 *  - Sentinel / chat-requirements: OmniRoute executes the turn INSIDE a real
 *    chatgpt.com page so the site's own JS can mint the anti-abuse tokens
 *    (POST /backend-api/sentinel/chat-requirements/prepare with a
 *    proof-of-work payload, plus turnstile tokens → the
 *    `openai-sentinel-chat-requirements-token` / `-proof-token` /
 *    `-turnstile-token` headers and `x-conduit-token`). A plain fetch client
 *    CANNOT mint those tokens, so this driver omits them. Whether
 *    chatgpt.com accepts a cookie + Bearer conversation request without
 *    Sentinel headers is UNVERIFIED.
 *  - WebSocket handoff: the current first-party flow can hand a turn off to
 *    a WebSocket topic (`resume_conversation_token` / `stream_handoff`
 *    frames, see chatgptWebTransport.ts). This driver only consumes the
 *    direct SSE body; a handoff with no SSE deltas raises an error.
 *  - OmniRoute talks to chatgpt.com from a real browser (TLS + Cloudflare
 *    fingerprint included). Plain Node fetch may be challenged.
 */
import { randomUUID } from "node:crypto";
import { mintSentinelHeaders } from "./chatgptSentinel.js";
import type { CookieJar } from "../../cookieJar.js";
import {
  BROWSER_UA,
  WebChatError,
  harvestCookies,
  requireCookieHeader,
  sseDataLines,
  type ChatMessage,
  type WebChatDriver,
} from "./types.js";

const BASE_URL = "https://chatgpt.com";
const SESSION_URL = `${BASE_URL}/api/auth/session`;
const CONVERSATION_URL = `${BASE_URL}/backend-api/f/conversation`;
const SESSION_TOKEN_RE = /(?:^|;\s*)__Secure-next-auth\.session-token(?:\.\d+)?=/;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flatten messages into the single prompt string, mirroring `buildPrompt`
 * in chatgptWebExecutorAdapter.ts: a lone user message is sent verbatim;
 * anything else becomes `Role:\ntext` blocks joined by blank lines.
 */
function buildPrompt(messages: ChatMessage[], providerId: string): string {
  if (messages.length === 0) {
    throw new WebChatError(providerId, "chatgpt-web requires at least one message");
  }
  const prompt =
    messages.length === 1 && messages[0]!.role === "user"
      ? messages[0]!.content
      : messages
          .map((m) => `${m.role[0]!.toUpperCase()}${m.role.slice(1)}:\n${m.content}`)
          .join("\n\n");
  if (!prompt.trim()) {
    throw new WebChatError(providerId, "chatgpt-web requires a non-empty prompt");
  }
  return prompt;
}

/* ------------------------------------------------------------------ */
/* delta_encoding: v1 decoder — simplified port of                     */
/* open-sse/utils/chatgptWebDeltaV1.ts (same ops, same JSON-Pointer    */
/* semantics; the document is mutated via clone-on-write values).      */
/* ------------------------------------------------------------------ */

const DELTA_OPS = new Set(["add", "append", "patch", "replace"]);
type DeltaOp = "add" | "append" | "patch" | "replace";
const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function pointerSegments(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`invalid ChatGPT Web JSON Pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => {
      const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      if (UNSAFE_SEGMENTS.has(decoded)) throw new Error(`unsafe JSON Pointer segment: ${decoded}`);
      return decoded;
    });
}

function arrayIndex(segment: string, length: number, allowEnd: boolean): number {
  if (allowEnd && segment === "-") return length;
  if (!/^(?:0|[1-9]\d*)$/.test(segment)) throw new Error(`invalid array index: ${segment}`);
  const index = Number(segment);
  if (index < 0 || index > (allowEnd ? length : length - 1)) {
    throw new Error(`array index out of bounds: ${segment}`);
  }
  return index;
}

function appendValue(current: unknown, incoming: unknown): unknown {
  if (current === undefined || current === null) return structuredClone(incoming);
  if (typeof current === "string" && typeof incoming === "string") return current + incoming;
  if (Array.isArray(current)) {
    const result = structuredClone(current) as unknown[];
    if (Array.isArray(incoming)) result.push(...structuredClone(incoming));
    else result.push(structuredClone(incoming));
    return result;
  }
  if (isRecord(current) && isRecord(incoming)) {
    return { ...structuredClone(current), ...structuredClone(incoming) };
  }
  throw new Error("cannot append ChatGPT Web delta values");
}

class DeltaV1Decoder {
  private document: unknown = null;
  private lastPath: string | null = null;
  private lastOp: DeltaOp | null = null;

  reset(): void {
    this.document = null;
    this.lastPath = null;
    this.lastOp = null;
  }

  /** Apply one `delta` event payload ({p, o, v}; p/o may be inherited). */
  apply(delta: JsonRecord): void {
    const path = delta.p === undefined ? this.lastPath : delta.p;
    const op = delta.o === undefined ? this.lastOp : delta.o;
    if (typeof path !== "string" || typeof op !== "string" || !DELTA_OPS.has(op)) {
      throw new Error("ChatGPT Web delta requires a current or inherited path and operation");
    }
    this.lastPath = path;
    this.lastOp = op as DeltaOp;
    this.applyAt(path, op as DeltaOp, delta.v);
  }

  /** Current assistant text in the decoded document, or "" if not there yet. */
  assistantText(): string {
    if (!isRecord(this.document) || !isRecord(this.document.message)) return "";
    const message = this.document.message;
    const author = isRecord(message.author) ? message.author : null;
    const content = isRecord(message.content) ? message.content : null;
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    if (
      author?.role !== "assistant" ||
      content?.content_type !== "text" ||
      !parts.every((part) => typeof part === "string")
    ) {
      return "";
    }
    return (parts as string[]).join("");
  }

  private applyAt(path: string, op: DeltaOp, value: unknown): void {
    const segments = pointerSegments(path);
    if (segments.length === 0) {
      if (op === "add" || op === "replace") {
        this.document = structuredClone(value);
        return;
      }
      if (op === "append") {
        this.document = appendValue(this.document, value);
        return;
      }
      if (!Array.isArray(value)) throw new Error("ChatGPT Web patch value must be an array");
      for (const entry of value) {
        if (!isRecord(entry) || typeof entry.p !== "string" || typeof entry.o !== "string") {
          throw new Error("ChatGPT Web patch entry requires an explicit path and operation");
        }
        this.applyAt(entry.p, entry.o as DeltaOp, entry.v);
      }
      return;
    }
    let parent: unknown = this.document;
    for (const segment of segments.slice(0, -1)) {
      if (Array.isArray(parent)) parent = parent[arrayIndex(segment, parent.length, false)];
      else if (isRecord(parent) && Object.hasOwn(parent, segment)) parent = parent[segment];
      else throw new Error(`ChatGPT Web delta path does not exist: ${path}`);
    }
    const key = segments[segments.length - 1]!;
    if (Array.isArray(parent)) {
      if (op === "patch") throw new Error("nested ChatGPT Web patch is unsupported");
      if (op === "add") {
        parent.splice(arrayIndex(key, parent.length, true), 0, structuredClone(value));
        return;
      }
      const index = arrayIndex(key, parent.length, false);
      parent[index] = op === "append" ? appendValue(parent[index], value) : structuredClone(value);
      return;
    }
    if (!isRecord(parent)) throw new Error(`ChatGPT Web delta path is not mutable: ${path}`);
    if (op === "patch") throw new Error("nested ChatGPT Web patch is unsupported");
    if (op !== "add" && !Object.hasOwn(parent, key)) {
      throw new Error(`ChatGPT Web delta target does not exist: ${key}`);
    }
    parent[key] = op === "append" ? appendValue(parent[key], value) : structuredClone(value);
  }
}

/* ------------------------------------------------------------------ */

export class ChatGptWebDriver implements WebChatDriver {
  readonly id: string = "chatgpt-web";
  readonly cookieDomains: string[] = ["chatgpt.com"];
  readonly cookieHint: string =
    "log in at chatgpt.com, then export cookies for chatgpt.com (must include __Secure-next-auth.session-token)";

  protected accessToken: string | null = null;
  protected bootstrapped = false;

  constructor(
    protected jar: CookieJar,
    protected fetchFn: typeof fetch = fetch,
  ) {}

  /** The logged-in driver requires imported cookies; the free variant overrides this. */
  protected requiresCookie(): boolean {
    return true;
  }

  /**
   * Map a catalog model id to the wire slug + "reason" hint, mirroring
   * `resolveSelection` (chatgptWebExecutorAdapter.ts) and `directModel`
   * (chatgptWebFirstParty.ts): free selections → wire model "auto";
   * Sol/5.5 picker selections → "gpt-5-6" / "gpt-5-5" (Pro → "-pro").
   * Thinking variants set `system_hints: ["reason"]`.
   */
  protected resolveWireModel(model: string): { wireModel: string; reason: boolean } {
    const normalized = model
      .trim()
      .toLowerCase()
      .replace(/^(?:chatgpt-web|cgpt-web)\//, "")
      .replace(/\./g, "-");
    switch (normalized) {
      case "gpt-5-6-luna-free":
        return { wireModel: "auto", reason: false };
      case "gpt-5-6-luna-free-thinking":
        return { wireModel: "auto", reason: true };
      case "gpt-5-6-pro":
        return { wireModel: "gpt-5-6-pro", reason: false };
      case "gpt-5-6":
      case "gpt-5-6-instant":
        return { wireModel: "gpt-5-6", reason: false };
      case "gpt-5-6-thinking":
      case "gpt-5-6-sol":
        return { wireModel: "gpt-5-6", reason: true };
      case "gpt-5-5-pro":
        return { wireModel: "gpt-5-5-pro", reason: false };
      case "gpt-5-5":
      case "gpt-5-5-instant":
        return { wireModel: "gpt-5-5", reason: false };
      case "gpt-5-5-thinking":
        return { wireModel: "gpt-5-5", reason: true };
      default:
        return { wireModel: normalized, reason: normalized.includes("thinking") };
    }
  }

  /**
   * Bootstrap: GET https://chatgpt.com/api/auth/session with the imported
   * cookies and cache the `accessToken` (the browser bridge in
   * chatgptWebFirstParty.ts does the same fetch in-page and sends the token
   * as `Authorization: Bearer …` on every /backend-api call).
   */
  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    let cookie = "";
    if (this.requiresCookie()) {
      cookie = requireCookieHeader(this.jar, SESSION_URL, this.id, this.cookieHint);
      if (!SESSION_TOKEN_RE.test(cookie)) {
        throw new WebChatError(
          this.id,
          `chatgpt.com cookies are missing __Secure-next-auth.session-token — import a logged-in session first: llmswitch cookies ${this.id} (${this.cookieHint})`,
        );
      }
    } else {
      cookie = this.jar.headerFor(SESSION_URL);
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": BROWSER_UA,
    };
    if (cookie) headers.cookie = cookie;

    let res: Response;
    try {
      res = await this.fetchFn(SESSION_URL, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (!this.requiresCookie()) {
        // Anonymous variant: a failed session probe is not fatal.
        this.bootstrapped = true;
        return;
      }
      throw error;
    }
    harvestCookies(this.jar, res, SESSION_URL);
    if (!res.ok) {
      if (!this.requiresCookie()) {
        this.bootstrapped = true;
        return;
      }
      throw new WebChatError(
        this.id,
        `chatgpt.com session bootstrap failed: HTTP ${res.status} — cookies may be expired; re-import: llmswitch cookies ${this.id} (${this.cookieHint})`,
      );
    }
    const session = (await res.json().catch(() => null)) as JsonRecord | null;
    const token = session?.accessToken;
    this.accessToken = typeof token === "string" && token ? token : null;
    if (this.requiresCookie() && !this.accessToken) {
      throw new WebChatError(
        this.id,
        `chatgpt.com session returned no accessToken — the imported cookies are not logged in; re-import: llmswitch cookies ${this.id} (${this.cookieHint})`,
      );
    }
    this.bootstrapped = true;
  }

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    let text = "";
    for await (const snapshot of this.turnSnapshots(model, messages)) text = snapshot;
    return text;
  }

  async *chatStream(model: string, messages: ChatMessage[]): AsyncGenerator<string> {
    let sent = "";
    for await (const snapshot of this.turnSnapshots(model, messages)) {
      if (snapshot.startsWith(sent) && snapshot.length > sent.length) {
        yield snapshot.slice(sent.length);
      }
      sent = snapshot;
    }
  }

  /**
   * Execute the turn through the browser bridge (CHATGPT_BRIDGE_URL):
   * a real headless Chrome on the gateway host runs the turn inside
   * chatgpt.com, where the page's own Sentinel/Turnstile machinery
   * completes invisibly. Verified live: prepare/finalize/req all 200
   * and the assistant answer renders, from the same datacenter IP that
   * the plain-HTTP flow gets Turnstile-walled on.
   */
  protected async turnViaBridge(bridgeUrl: string, prompt: string): Promise<string> {
    const r = await this.turnViaBridgeFull(bridgeUrl, prompt);
    return r.text;
  }

  /**
   * Full bridge turn: text plus, when ChatGPT generated an image during
   * the turn, the image bytes the bridge captured from the page.
   * `wantImage` makes the bridge wait for a still-rendering image
   * instead of finishing at text stability.
   */
  protected async turnViaBridgeFull(
    bridgeUrl: string,
    prompt: string,
    opts?: { wantImage?: boolean },
  ): Promise<{ text: string; image?: { b64: string; mime: string } }> {
    const cookies = this.jar.headerFor(CONVERSATION_URL);
    let res: Response;
    try {
      res = await this.fetchFn(`${bridgeUrl.replace(/\/$/, "")}/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          cookies: cookies || undefined,
          wantImage: opts?.wantImage || undefined,
          timeoutMs: opts?.wantImage ? 140_000 : undefined,
        }),
        signal: AbortSignal.timeout(opts?.wantImage ? 170_000 : 150_000),
      });
    } catch (err) {
      throw new WebChatError(
        this.id,
        `browser bridge unreachable at ${bridgeUrl} (${err instanceof Error ? err.message : String(err)}) — is the browser-bridge service running?`,
      );
    }
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; text?: string; image?: { b64?: string; mime?: string }; error?: string }
      | null;
    if (!data?.ok) {
      throw new WebChatError(this.id, `browser bridge: ${data?.error ?? `HTTP ${res.status}`}`);
    }
    const image = data.image?.b64
      ? { b64: data.image.b64, mime: data.image.mime || "image/png" }
      : undefined;
    const text = typeof data.text === "string" ? data.text : "";
    if (!text && !image) {
      throw new WebChatError(this.id, `browser bridge: ${data?.error ?? `HTTP ${res.status}`}`);
    }
    return { text, image };
  }

  /**
   * Image generation through the browser bridge: the prompt runs as a
   * normal ChatGPT turn and the bridge captures the generated image
   * from the rendered page. Needs a logged-in ChatGPT session for the
   * site to actually generate — anonymously ChatGPT refuses, and that
   * refusal text is surfaced in the error.
   */
  async generateImage(prompt: string): Promise<{ b64: string; mime: string; text?: string }> {
    await this.bootstrap();
    const bridgeUrl = (process.env.CHATGPT_BRIDGE_URL ?? "").trim();
    if (!bridgeUrl) {
      throw new WebChatError(
        this.id,
        "image generation needs the browser bridge (CHATGPT_BRIDGE_URL is not set on the gateway)",
      );
    }
    const r = await this.turnViaBridgeFull(bridgeUrl, prompt, { wantImage: true });
    if (!r.image) {
      throw new WebChatError(
        this.id,
        `chatgpt did not generate an image${r.text ? ` — it replied: ${r.text.slice(0, 240)}` : ""}`,
      );
    }
    return { b64: r.image.b64, mime: r.image.mime, text: r.text || undefined };
  }

  /** Run one conversation turn, yielding cumulative assistant-text snapshots. */
  protected async *turnSnapshots(
    model: string,
    messages: ChatMessage[],
  ): AsyncGenerator<string> {
    await this.bootstrap();
    const { wireModel, reason } = this.resolveWireModel(model);
    const prompt = buildPrompt(messages, this.id);

    // Browser bridge configured → the turn runs in a real browser and
    // the anti-abuse tokens are minted by the page itself.
    const bridgeUrl = (process.env.CHATGPT_BRIDGE_URL ?? "").trim();
    if (bridgeUrl) {
      const r = await this.turnViaBridgeFull(bridgeUrl, prompt);
      let out = r.text;
      if (r.image) {
        // Deliver the image inline as a markdown data URL — chat
        // clients that render markdown show it; API consumers get the
        // bytes either way.
        const md = `![generated image](data:${r.image.mime};base64,${r.image.b64})`;
        out = out ? `${out}\n\n${md}` : md;
      }
      yield out;
      return;
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": BROWSER_UA,
    };
    const cookie = this.jar.headerFor(CONVERSATION_URL);
    if (cookie) headers.cookie = cookie;
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    // Sentinel anti-abuse headers (chatgptSentinel.ts): proof-of-work is
    // solved headlessly; when ChatGPT additionally demands Turnstile the
    // mint throws a clear error (a real browser is required for that
    // token). When the requirements endpoint is unreachable we proceed
    // without headers, exactly as before.
    const sentinel = await mintSentinelHeaders({
      providerId: this.id,
      fetchFn: this.fetchFn,
      userAgent: BROWSER_UA,
      accessToken: this.accessToken ?? undefined,
      cookie,
    });
    if (sentinel) Object.assign(headers, sentinel);

    // Request body shape: `storeConversationDraft` in chatgptWebFirstParty.ts.
    const body = {
      action: "next",
      messages: [
        {
          id: randomUUID(),
          author: { role: "user" },
          create_time: Date.now() / 1000,
          content: { content_type: "text", parts: [prompt] },
          metadata: {
            ...(reason ? { system_hints: ["reason"] } : {}),
            serialization_metadata: { custom_symbol_offsets: [] },
          },
        },
      ],
      parent_message_id: "client-created-root",
      model: wireModel,
      timezone_offset_min: new Date().getTimezoneOffset(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      history_and_training_disabled: true,
      conversation_mode: { kind: "primary_assistant" },
      system_hints: reason ? ["reason"] : [],
      supports_buffering: true,
      supported_encodings: ["v1"],
    };

    const res = await this.fetchFn(CONVERSATION_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    harvestCookies(this.jar, res, CONVERSATION_URL);
    if (!res.ok) {
      // Error detail extraction mirrors `submitConversationRequest`.
      let detail = "";
      try {
        const payload = (await res.json()) as JsonRecord;
        const nested = isRecord(payload.detail)
          ? payload.detail
          : isRecord(payload.error)
            ? payload.error
            : payload;
        const candidate = nested.code ?? nested.message ?? nested.type;
        if (typeof candidate === "string") detail = candidate.slice(0, 160);
      } catch {
        await res.body?.cancel().catch(() => {});
      }
      throw new WebChatError(
        this.id,
        `chatgpt.com conversation failed: HTTP ${res.status}${detail ? ` (${detail})` : ""}`,
      );
    }

    const decoder = new DeltaV1Decoder();
    let sawHandoff = false;
    let lastText = "";
    for await (const data of sseDataLines(res.body)) {
      if (data === "[DONE]") break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (parsed === "v1") {
        // `event: delta_encoding` marker — a fresh v1 document follows.
        decoder.reset();
        continue;
      }
      if (!isRecord(parsed)) continue;
      if (parsed.type === "resume_conversation_token" || parsed.type === "stream_handoff") {
        sawHandoff = true;
        continue;
      }
      if (!("v" in parsed || "p" in parsed || "o" in parsed)) continue;
      decoder.apply(parsed);
      const text = decoder.assistantText();
      if (text !== lastText) {
        lastText = text;
        yield text;
      }
    }
    if (!lastText && sawHandoff) {
      throw new WebChatError(
        this.id,
        "chatgpt.com handed the turn off to a WebSocket topic and sent no SSE deltas — the fetch driver cannot follow the handoff (NEEDS LIVE VERIFICATION)",
      );
    }
  }
}
