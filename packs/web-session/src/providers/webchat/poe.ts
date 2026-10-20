/**
 * PoeWebDriver — Poe (poe.com) cookie web chat.
 *
 * Ported from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, release v3.8.53).
 * Source paths in OmniRoute:
 *   open-sse/executors/poe-web.ts            (the WEB protocol — this driver)
 *   open-sse/services/tokenExtractionConfig.ts (cookie: `p-b` on .poe.com)
 * NOTE: open-sse/config/providers/registry/poe/index.ts is Poe's paid API
 * (api.poe.com) — deliberately NOT used here.
 *
 * Protocol (as coded upstream):
 *   POST https://www.poe.com/api/gql_POST
 *   Cookie: p-b=<value>
 *   JSON body (GraphQL):
 *     { operationName: "ChatViewQuery",
 *       query: "query ChatViewQuery($bot: String!, $query: String!) {
 *                 chatWithBot(bot: $bot, query: $query) {
 *                   messageId text state } }",
 *       variables: { bot: <Poe bot name>, query: <last user message> } }
 *   Response JSON: { data: { chatWithBot: { messageId, text, state } } }
 *   The reply is a single JSON document (not SSE), so chatStream emits the
 *   full text as one chunk, exactly as upstream does.
 *   Only the LAST user message is sent as `query` (upstream behavior);
 *   earlier turns are not forwarded.
 *
 * ⚠️ NEEDS LIVE VERIFICATION: mock-tested only. Upstream's executor is a
 * deliberately simplified GraphQL call — real poe.com normally also expects
 * a formkey / poe-tag-id style signing that upstream does not perform, so
 * whether this succeeds against the live site with only the `p-b` cookie is
 * unverified.
 */
import type { CookieJar } from "../../cookieJar.js";
import {
  BROWSER_UA,
  WebChatError,
  harvestCookies,
  requireCookieHeader,
  singleChunkStream,
  type ChatMessage,
  type WebChatDriver,
} from "./types.js";

const BASE_URL = "https://www.poe.com";
const GQL_URL = `${BASE_URL}/api/gql_POST`;

/** OmniRoute model id -> Poe bot name (upstream MODEL_MAP). */
const MODEL_MAP: Record<string, string> = {
  "gpt-4o": "GPT-4o",
  "gpt-4-turbo": "GPT-4-Turbo",
  "claude-3.5-sonnet": "Claude-3.5-Sonnet",
  "claude-3-opus": "Claude-3-Opus",
  "gemini-2.0-flash": "Gemini-2.0-Flash",
  "llama-3-70b": "Llama-3-70B",
  "mixtral-8x22b": "Mixtral-8x22B",
  "poe-default": "Assistant",
};

const GQL_QUERY = `query ChatViewQuery($bot: String!, $query: String!) {
        chatWithBot(bot: $bot, query: $query) {
          messageId
          text
          state
        }
      }`;

export class PoeWebDriver implements WebChatDriver {
  readonly id = "poe";
  readonly cookieDomains = [".poe.com", "poe.com"];
  readonly cookieHint =
    "log in at poe.com and import its cookies (needs the p-b session cookie)";

  private pbCookie: string | null = null;

  constructor(
    private jar: CookieJar,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async bootstrap(): Promise<void> {
    if (this.pbCookie) return;
    const header = requireCookieHeader(
      this.jar,
      `${BASE_URL}/`,
      this.id,
      this.cookieHint,
    );
    const match = header.match(/(?:^|;\s*)p-b=([^;]+)/);
    if (!match?.[1]) {
      throw new WebChatError(
        this.id,
        `poe.com cookies found but no p-b cookie among them — import a session first: llmswitch cookies ${this.id} (${this.cookieHint})`,
      );
    }
    this.pbCookie = match[1];
  }

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    await this.bootstrap();
    const requestedModel = model || "poe-default";
    const botName = MODEL_MAP[requestedModel] ?? requestedModel;
    const lastUserMsg = messages.filter((m) => m.role === "user").pop();
    const prompt = lastUserMsg?.content ?? "";

    const gqlBody = {
      operationName: "ChatViewQuery",
      query: GQL_QUERY,
      variables: { bot: botName, query: prompt },
    };

    const res = await this.fetchFn(GQL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": BROWSER_UA,
        accept: "application/json",
        referer: `${BASE_URL}/`,
        origin: BASE_URL,
        cookie: `p-b=${this.pbCookie}`,
      },
      body: JSON.stringify(gqlBody),
      signal: AbortSignal.timeout(60_000),
    });
    harvestCookies(this.jar, res, GQL_URL);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new WebChatError(
        this.id,
        `Poe error (HTTP ${res.status}): ${text.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as Record<string, unknown>;
    const errors = data.errors as Array<{ message?: string }> | undefined;
    if (Array.isArray(errors) && errors.length > 0) {
      throw new WebChatError(
        this.id,
        `Poe GraphQL error: ${errors[0]?.message ?? "unknown error"}`,
      );
    }
    const inner = (data.data ?? {}) as Record<string, unknown>;
    const chatData = (inner.chatWithBot ?? {}) as Record<string, unknown>;
    const text = chatData.text;
    if (typeof text !== "string") {
      throw new WebChatError(this.id, "Poe reply missing data.chatWithBot.text");
    }
    return text;
  }

  async *chatStream(
    model: string,
    messages: ChatMessage[],
  ): AsyncGenerator<string> {
    // Poe's web reply is one JSON document — single chunk (upstream behavior).
    yield* singleChunkStream(await this.chat(model, messages));
  }
}
