/**
 * Manus driver — HONEST GAP STUB. OmniRoute knows how to EXTRACT a
 * Manus session cookie in the browser, but ships no protocol that could
 * USE it. This file does not invent one.
 *
 * Ported / researched from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, release v3.8.53). What
 * OmniRoute v3.8.53 actually contains for "manus" — the COMPLETE list,
 * verified by grepping all of open-sse/:
 *
 *  - `open-sse/services/tokenExtractionConfig.ts` — a single entry,
 *    filed under the comment "── Missing Provider: Manus ──" (OmniRoute
 *    itself labels Manus MISSING). Entry: id "manus-web", name
 *    "Manus AI", loginUrl https://manus.im/login, appUrl
 *    https://manus.im, extraction targets: cookie `manus_session` on
 *    domain `.manus.im`, plus a localStorage key `auth_token`;
 *    instructions "Log in to Manus at manus.im. The session cookie will
 *    be extracted.", cookieDomain ".manus.im".
 *
 * What OmniRoute does NOT have for Manus (all verified absent):
 *  - no executor (no executors/manus*.ts, no "manus-web" entry in
 *    executors/index.ts),
 *  - no provider registry entry (no registry/manus/),
 *  - no chat endpoint, request/response wire format, SSE handling, or
 *    session bootstrap anywhere in open-sse/,
 *  - no handler or service that consumes `manus_session`.
 *  (The only other "manus" hits in the tree are the Indonesian word for
 *  "human" inside compression style catalogs — unrelated.)
 *
 * Therefore this driver implements ONLY:
 *  - bootstrap(): validates the imported cookies for manus.im AND that
 *    the `manus_session` cookie named by tokenExtractionConfig is among
 *    them. The cookie is never sent anywhere — there is no endpoint in
 *    OmniRoute's code to send it to. (The localStorage `auth_token`
 *    target cannot be held by a cookie jar and is not checked.)
 *  - chat() / chatStream(): throw a WebChatError stating the gap.
 *
 * A real Manus driver needs the manus.im web app's chat protocol
 * documented from a live session — NEEDS LIVE VERIFICATION.
 */
import type { CookieJar } from "../../cookieJar.js";
import type { ChatMessage } from "../../cookieChat.js";
import { WebChatError, requireCookieHeader, type WebChatDriver } from "./types.js";

const PROVIDER_ID = "manus";
const COOKIE_HINT =
  "log in at https://manus.im/login, then export cookies for manus.im — " +
  "the manus_session cookie is the one OmniRoute's extractor looks for";
const GAP_MESSAGE =
  "manus: chat protocol not present in OmniRoute code — " +
  "tokenExtractionConfig lists Manus under \"Missing Provider\" (cookie " +
  "extraction only: manus_session on .manus.im) and open-sse ships no " +
  "executor, registry entry, or chat endpoint for it — NEEDS LIVE " +
  "VERIFICATION against the manus.im web app before chat can work";

export class ManusDriver implements WebChatDriver {
  readonly id = PROVIDER_ID;
  readonly cookieDomains = ["manus.im"];
  readonly cookieHint = COOKIE_HINT;

  private bootstrapped = false;

  constructor(
    private jar: CookieJar,
    // Accepted for the shared driver contract; never called — OmniRoute
    // defines no Manus web endpoint for this driver to fetch.
    private fetchFn: typeof fetch = fetch,
  ) {
    void this.fetchFn;
  }

  /**
   * Cookie check only: succeeds (idempotently) when the jar holds a
   * `manus_session` cookie for manus.im — the exact cookie OmniRoute's
   * tokenExtractionConfig names. Sends nothing anywhere.
   */
  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    const header = requireCookieHeader(this.jar, "https://manus.im/", PROVIDER_ID, COOKIE_HINT);
    if (!/(?:^|;\s*)manus_session=/.test(header)) {
      throw new WebChatError(
        PROVIDER_ID,
        `cookies for manus.im found, but no manus_session cookie — that is ` +
          `the cookie OmniRoute's extractor requires — import a session ` +
          `first: llmswitch cookies ${PROVIDER_ID} (${COOKIE_HINT})`,
      );
    }
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
