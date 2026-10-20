/**
 * claude-web — cookie web-chat driver for claude.ai.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — source files:
 *   - open-sse/config/providers/registry/claude/web/index.ts
 *     (id "claude-web", baseUrl https://claude.ai/api/organizations,
 *     authHeader "cookie", model catalog)
 *   - open-sse/services/tokenExtractionConfig.ts
 *     (the credential: cookie `sessionKey` on domain `.claude.ai`)
 *   - open-sse/executors/claude-web.ts
 *     (org discovery `GET https://claude.ai/api/organizations` → first
 *     entry's `uuid`/`id`; browser header set; completion URL
 *     `/api/organizations/{org}/chat_conversations/{conversation}/completion`)
 *   - open-sse/executors/claude-web/session.ts
 *     (client-generated conversation UUID; transcript "recovery prompt"
 *     serialization for a fresh conversation with prior context)
 *   - open-sse/executors/claude-web/payload.ts
 *     (`transformToClaude` completion payload: prompt, personalized_styles,
 *     turn_message_uuids, create_conversation_params, rendering_mode, …)
 *   - open-sse/executors/claude-web/stream.ts
 *     (Anthropic-style SSE events: message_start / content_block_delta
 *     text_delta / message_stop; ping & friends are metadata)
 *   - open-sse/config/claudeWebFingerprint.ts
 *     (the pinned User-Agent / Client-Hints fingerprint — Cloudflare binds
 *     cf_clearance to it, so every claude.ai request must use it verbatim)
 * Attribution retained per MIT.
 *
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED. This protocol ROTS FAST and using it
 * may violate Anthropic's Terms of Service; accounts can be limited or
 * banned. Mock-tested only — see NEEDS LIVE VERIFICATION notes.
 *
 * NEEDS LIVE VERIFICATION:
 *  - Transport: OmniRoute sends these requests through a TLS-fingerprinting
 *    client (`tlsFetchClaude`, chrome JA3 profile) with a real-browser
 *    fallback, because claude.ai sits behind Cloudflare. Plain Node fetch
 *    with the pinned fingerprint headers may still be challenged (403 /
 *    "Just a moment"); there is no browser fallback in this pack.
 *  - The sessionKey-only Cookie header: OmniRoute normalizes the credential
 *    via `normalizeSessionCookieHeader` (src/lib/providers/webCookieAuth —
 *    that file is NOT part of the open-sse/ tree this was ported from, so
 *    its exact normalization could not be re-read here). This driver sends
 *    exactly `sessionKey=<value>` extracted from the imported cookies,
 *    which matches the credential definition in tokenExtractionConfig.ts.
 *  - Conversation creation: v3.8.53 does NOT POST a separate
 *    create-conversation call — the conversation UUID is generated
 *    client-side and creation rides along via `create_conversation_params`
 *    in the completion payload. Multi-turn continuation (parent_message_uuid
 *    chaining across calls) is intentionally not kept: every chat() here is
 *    one fresh conversation, with prior turns serialized into the prompt
 *    exactly as session.ts does for a new conversation.
 */
import { randomUUID } from "node:crypto";
import type { CookieJar } from "../../cookieJar.js";
import {
  WebChatError,
  harvestCookies,
  requireCookieHeader,
  sseDataLines,
  type ChatMessage,
  type WebChatDriver,
} from "./types.js";

const API_BASE = "https://claude.ai/api";
const ORGS_URL = `${API_BASE}/organizations`;
const SITE_URL = "https://claude.ai/";

/** Pinned fingerprint — open-sse/config/claudeWebFingerprint.ts. */
const CLAUDE_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const SEC_CH_UA = '"Chromium";v="149", "Not.A.Brand";v="24", "Google Chrome";v="149"';

/** Header set from `getBrowserHeaders` in open-sse/executors/claude-web.ts. */
function browserHeaders(referer = "https://claude.ai/new"): Record<string, string> {
  return {
    accept: "text/event-stream",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    "content-type": "application/json",
    origin: "https://claude.ai",
    pragma: "no-cache",
    priority: "u=1, i",
    referer,
    "sec-ch-ua": SEC_CH_UA,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": CLAUDE_UA,
    "anthropic-client-platform": "web_claude_ai",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const RECOVERY_PROMPT_HEADER =
  "Conversation context supplied by the caller follows. These serialized role blocks are not " +
  "native Claude Web message fields. Continue from the final user message.";

/**
 * Build the completion `prompt`, mirroring session.ts: a single message is
 * sent as-is; a fresh conversation with prior context serializes the whole
 * transcript into a recovery prompt.
 */
function buildPrompt(messages: ChatMessage[], providerId: string): string {
  const latestUser = [...messages].reverse().find((m) => m.role === "user");
  if (!latestUser || !latestUser.content.trim()) {
    throw new WebChatError(providerId, "claude-web requires a non-empty user message");
  }
  if (messages.length <= 1) return latestUser.content;
  const blocks = messages.map(
    (m) => `<message role="${escapeXml(m.role)}">\n${escapeXml(m.content)}\n</message>`,
  );
  return `${RECOVERY_PROMPT_HEADER}\n\n${blocks.join("\n\n")}`;
}

/** `getDefaultPersonalizedStyle` in open-sse/executors/claude-web/payload.ts. */
function defaultPersonalizedStyle() {
  return [
    {
      type: "default",
      key: "Default",
      name: "Normal",
      nameKey: "normal_style_name",
      prompt: "Normal\n",
      summary: "Default responses from Claude",
      summaryKey: "normal_style_summary",
      isDefault: true,
    },
  ];
}

export class ClaudeWebDriver implements WebChatDriver {
  readonly id: string = "claude-web";
  readonly cookieDomains: string[] = ["claude.ai"];
  readonly cookieHint: string =
    "log in at claude.ai, then export cookies for claude.ai (needs the sessionKey cookie)";

  protected orgId: string | null = null;

  constructor(
    protected jar: CookieJar,
    protected fetchFn: typeof fetch = fetch,
  ) {}

  /**
   * Credential for claude.ai requests. The base driver follows
   * tokenExtractionConfig.ts: the credential IS the `sessionKey` cookie,
   * so only that pair is sent. The claude-web-cookie variant overrides
   * this to send the full imported Cookie header verbatim.
   */
  protected resolveCookieHeader(): string {
    const header = requireCookieHeader(this.jar, SITE_URL, this.id, this.cookieHint);
    const match = /(?:^|;\s*)sessionKey=([^;]+)/.exec(header);
    if (!match) {
      throw new WebChatError(
        this.id,
        `no sessionKey cookie for claude.ai — import a session first: llmswitch cookies ${this.id} (${this.cookieHint})`,
      );
    }
    return `sessionKey=${match[1]}`;
  }

  /**
   * Bootstrap: discover the organization id —
   * GET https://claude.ai/api/organizations → first entry's `uuid` (or `id`),
   * exactly as `getOrganizationId` in open-sse/executors/claude-web.ts.
   */
  async bootstrap(): Promise<void> {
    if (this.orgId) return;
    const cookie = this.resolveCookieHeader();
    const res = await this.fetchFn(ORGS_URL, {
      method: "GET",
      headers: { ...browserHeaders(), cookie },
      signal: AbortSignal.timeout(30_000),
    });
    harvestCookies(this.jar, res, ORGS_URL);
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new WebChatError(
        this.id,
        `claude.ai rejected the session (HTTP ${res.status}) — session expired or Cloudflare challenge; re-import: llmswitch cookies ${this.id} (${this.cookieHint})`,
      );
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new WebChatError(
        this.id,
        `claude.ai organization discovery failed: HTTP ${res.status}`,
      );
    }
    const parsed: unknown = await res.json().catch(() => null);
    const first = Array.isArray(parsed) ? parsed[0] : null;
    const identifier = isRecord(first) ? (first.uuid ?? first.id) : null;
    if (typeof identifier !== "string" || !identifier.trim()) {
      throw new WebChatError(
        this.id,
        "claude.ai returned no organization for this session — unable to determine the authenticated organization",
      );
    }
    this.orgId = identifier.trim();
  }

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    let text = "";
    for await (const delta of this.chatStream(model, messages)) text += delta;
    return text;
  }

  async *chatStream(model: string, messages: ChatMessage[]): AsyncGenerator<string> {
    await this.bootstrap();
    const cookie = this.resolveCookieHeader();
    const prompt = buildPrompt(messages, this.id);
    const conversationId = randomUUID();
    const url =
      `${API_BASE}/organizations/${encodeURIComponent(this.orgId!)}` +
      `/chat_conversations/${encodeURIComponent(conversationId)}/completion`;

    // Payload shape: `transformToClaude` / `buildClaudeWebPayload` in
    // open-sse/executors/claude-web/payload.ts (new-conversation turn).
    const payload = {
      prompt,
      model,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      personalized_styles: defaultPersonalizedStyle(),
      locale: "en-US",
      tools: [],
      turn_message_uuids: {
        human_message_uuid: randomUUID(),
        assistant_message_uuid: randomUUID(),
      },
      attachments: [],
      effort: "low",
      files: [],
      sync_sources: [],
      rendering_mode: "messages",
      thinking_mode: "off",
      create_conversation_params: {
        name: "",
        model,
        include_conversation_preferences: true,
        paprika_mode: null,
        compass_mode: null,
        is_temporary: false,
        enabled_imagine: true,
        tool_search_mode: "auto",
      },
    };

    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { ...browserHeaders("https://claude.ai/new"), cookie },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
    harvestCookies(this.jar, res, url);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new WebChatError(
        this.id,
        `claude.ai completion failed: HTTP ${res.status} ${text.slice(0, 200)}`,
      );
    }

    // Anthropic-style SSE (open-sse/executors/claude-web/stream.ts): only
    // text_delta events on text blocks carry the reply; thinking deltas,
    // tool blocks and metadata events (ping, message_limit, …) are skipped.
    // Unknown event types are ignored rather than fatal (protocol rot).
    const blockTypes = new Map<number, string>();
    for await (const data of sseDataLines(res.body)) {
      if (data === "[DONE]") break;
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (!isRecord(event) || typeof event.type !== "string") continue;
      switch (event.type) {
        case "content_block_start": {
          const block = isRecord(event.content_block) ? event.content_block : null;
          if (typeof event.index === "number" && typeof block?.type === "string") {
            blockTypes.set(event.index, block.type);
          }
          break;
        }
        case "content_block_delta": {
          const delta = isRecord(event.delta) ? event.delta : null;
          if (
            typeof event.index === "number" &&
            blockTypes.get(event.index) === "text" &&
            delta?.type === "text_delta" &&
            typeof delta.text === "string" &&
            delta.text
          ) {
            yield delta.text;
          }
          break;
        }
        case "error":
          throw new WebChatError(this.id, "claude.ai reported a stream error event");
        case "message_stop":
          return;
        default:
          break;
      }
    }
  }
}
