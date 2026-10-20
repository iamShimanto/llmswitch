/**
 * DeepAI driver — HONEST GAP STUB. There is no DeepAI web-chat protocol
 * to port, and this file deliberately does not invent one.
 *
 * Ported / researched from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, release v3.8.53). What
 * OmniRoute v3.8.53 actually contains for "deepai" — the COMPLETE list,
 * verified by grepping all of open-sse/:
 *
 *  - `open-sse/config/providers/registry/deepai/index.ts` — the ONLY
 *    DeepAI-specific file. Registry entry: id/alias "deepai",
 *    format "custom", executor "default" (the generic executor),
 *    baseUrl "https://api.deepai.org", authType "apikey",
 *    authHeader "api-key", and a single model: { id: "text2img",
 *    name: "Text to Image" }. That is an API-KEY, IMAGE-generation
 *    provider — not chat, not cookies.
 *  - `open-sse/config/providers/index.ts` — imports/registers that
 *    entry (nothing else).
 *  - CHANGELOG.md: "feat(providers): add DeepAI as paid API-key image
 *    provider" — OmniRoute itself describes it as paid + API-key + image.
 *
 * What OmniRoute does NOT have for DeepAI (all verified absent):
 *  - no executor (no executors/deepai*.ts; the registry points at the
 *    shared "default" executor),
 *  - no web-chat / cookie protocol of any kind (no chat endpoint, no
 *    SSE/NDJSON wire, no session bootstrap),
 *  - no entry in `open-sse/services/tokenExtractionConfig.ts` (no
 *    cookie name, no login URL, no extraction hint),
 *  - no handler, service, or translator mentioning deepai.
 *
 * Therefore this driver implements ONLY:
 *  - bootstrap(): validates that the user imported SOME deepai.org
 *    cookies (a session-holder check, so the import plumbing works and
 *    a future protocol has a jar to build on). The cookies are never
 *    sent anywhere — OmniRoute defines no endpoint to send them to.
 *  - chat() / chatStream(): throw a WebChatError stating the gap.
 *
 * To use DeepAI through LLMSwitch today, use the official API instead:
 * an API key against https://api.deepai.org (header "api-key"), e.g.
 * the text2img image model — that is the only DeepAI integration
 * OmniRoute ships. A cookie web-chat driver becomes possible only if a
 * real DeepAI web chat protocol is documented — NEEDS LIVE VERIFICATION
 * against deepai.org's web app, which OmniRoute's code does not provide.
 */
import type { CookieJar } from "../../cookieJar.js";
import type { ChatMessage } from "../../cookieChat.js";
import { WebChatError, requireCookieHeader, type WebChatDriver } from "./types.js";

const PROVIDER_ID = "deepai";
const COOKIE_HINT =
  "OmniRoute has no cookie flow for DeepAI (it is an API-key image provider " +
  "there); importing deepai.org cookies only registers a browser session " +
  "with this driver — chat stays unavailable, see the driver header";
const GAP_MESSAGE =
  "deepai: no web chat protocol exists in OmniRoute v3.8.53 — its only " +
  "DeepAI integration is an API-key image provider (registry/deepai: " +
  "baseUrl https://api.deepai.org, authHeader \"api-key\", single model " +
  "\"text2img\"). No chat endpoint, executor, or cookie flow is present " +
  "in the code, so none is implemented here — NEEDS LIVE VERIFICATION " +
  "against a documented DeepAI web chat protocol before chat can work. " +
  "Use DeepAI's official API-key endpoint instead.";

export class DeepAiDriver implements WebChatDriver {
  readonly id = PROVIDER_ID;
  readonly cookieDomains = ["deepai.org"];
  readonly cookieHint = COOKIE_HINT;

  private bootstrapped = false;

  constructor(
    private jar: CookieJar,
    // Accepted for the shared driver contract; never called — OmniRoute
    // defines no DeepAI web endpoint for this driver to fetch.
    private fetchFn: typeof fetch = fetch,
  ) {
    void this.fetchFn;
  }

  /**
   * Session-holder check only: succeeds (idempotently) when any
   * deepai.org cookies were imported. Sends nothing anywhere.
   */
  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    requireCookieHeader(this.jar, "https://deepai.org/", PROVIDER_ID, COOKIE_HINT);
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
