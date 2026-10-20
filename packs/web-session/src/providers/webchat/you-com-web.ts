/**
 * You.com driver — HONEST GAP STUB. OmniRoute's only You.com integration
 * is an API-key SEARCH endpoint, not a web chat, and this file does not
 * invent a chat protocol.
 *
 * Ported / researched from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, release v3.8.53). What
 * OmniRoute v3.8.53 actually contains for You.com — the COMPLETE list,
 * verified by grepping all of open-sse/:
 *
 *  - `open-sse/config/searchRegistry.ts` — id "youcom-search", name
 *    "You.com Search", baseUrl https://ydc-index.io/v1/search,
 *    method GET, authType "apikey", authHeader "x-api-key". That is a
 *    SEARCH provider, not chat.
 *  - `open-sse/handlers/search.ts` — `buildYouComRequest` (GET the
 *    query endpoint with an `X-API-Key` header; throws if no API key)
 *    and `normalizeYouComResponse` (maps the search `results.web` /
 *    `results.news` sections).
 *  - `open-sse/handlers/search/baseUrl.ts` — mentions "you.com" once,
 *    inside a comment about base-URL injection attacks.
 *
 * What OmniRoute does NOT have for You.com (all verified absent):
 *  - no you.com CHAT integration at all (no chat executor, no chat
 *    registry entry, no message endpoint),
 *  - no cookie / web-session flow for You.com (no entry in
 *    `open-sse/services/tokenExtractionConfig.ts`, no session cookie
 *    named anywhere),
 *  - nothing at you.com's web app — the only You.com endpoint in the
 *    code is the ydc-index.io search API.
 *
 * Therefore this driver implements ONLY:
 *  - bootstrap(): validates that the user imported SOME you.com cookies
 *    (a session-holder check, so the import plumbing works and a future
 *    protocol has a jar to build on). The cookies are never sent
 *    anywhere — OmniRoute defines no You.com web endpoint to send them
 *    to, and you.com SEARCH specifically requires an API key, not
 *    browser cookies.
 *  - chat() / chatStream(): throw a WebChatError stating the gap.
 *
 * A real You.com web-chat driver needs the you.com web app's chat
 * protocol documented from a live session — NEEDS LIVE VERIFICATION.
 */
import type { CookieJar } from "../../cookieJar.js";
import type { ChatMessage } from "../../cookieChat.js";
import { WebChatError, requireCookieHeader, type WebChatDriver } from "./types.js";

const PROVIDER_ID = "you-com-web";
const COOKIE_HINT =
  "OmniRoute has no cookie/chat flow for You.com (its only You.com " +
  "integration is API-key search); importing you.com cookies only " +
  "registers a browser session with this driver — chat stays unavailable, " +
  "see the driver header";
const GAP_MESSAGE =
  "you-com-web: chat protocol not present in OmniRoute code — the only " +
  "You.com integration in open-sse is \"youcom-search\", an API-key web " +
  "search endpoint (https://ydc-index.io/v1/search, X-API-Key header), " +
  "not a web chat; no You.com chat endpoint, executor, or cookie flow is " +
  "present in the code, so none is implemented here — NEEDS LIVE " +
  "VERIFICATION against a documented you.com web chat protocol before " +
  "chat can work";

export class YouComWebDriver implements WebChatDriver {
  readonly id = PROVIDER_ID;
  readonly cookieDomains = ["you.com"];
  readonly cookieHint = COOKIE_HINT;

  private bootstrapped = false;

  constructor(
    private jar: CookieJar,
    // Accepted for the shared driver contract; never called — OmniRoute
    // defines no You.com web endpoint for this driver to fetch.
    private fetchFn: typeof fetch = fetch,
  ) {
    void this.fetchFn;
  }

  /**
   * Session-holder check only: succeeds (idempotently) when any
   * you.com cookies were imported. Sends nothing anywhere.
   */
  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    requireCookieHeader(this.jar, "https://you.com/", PROVIDER_ID, COOKIE_HINT);
    this.bootstrapped = true;
  }

  async chat(_model: string, _messages: ChatMessage[]): Promise<string> {
    await this.bootstrap();
    throw new WebChatError(PROVIDER_ID, GAP_MESSAGE);
  }

  async *chatStream(_model: string, _messages: ChatMessage[]): AsyncGenerator<string> {
    await this.bootstrap();
    throw new WebChatError(PROVIDER_ID, GAP_MESSAGE);
  }
}
