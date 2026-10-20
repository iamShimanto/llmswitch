/**
 * claude-web-cookie — claude.ai web chat driven by a raw Cookie header.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — the wire protocol is claude-web's; see the attribution
 * header in ./claude-web.ts for the full source list. Attribution retained
 * per MIT.
 *
 * HONEST SCOPE: OmniRoute v3.8.53 has NO separate "claude-web-cookie"
 * provider or registry entry — `grep` for "claude-web-cookie" over
 * open-sse/ finds nothing, and its single claude-web executor accepts the
 * credential from either a `cookie` field or an `apiKey` field
 * (`readClaudeWebCookie` in open-sse/executors/claude-web.ts) and normalizes
 * it around the `sessionKey` cookie. So on the wire there is NO protocol
 * difference to port.
 *
 * The difference in this pack is purely which credential the user imports:
 *  - claude-web        → the `sessionKey` cookie alone is extracted and
 *                        sent (`sessionKey=…`), per tokenExtractionConfig.ts.
 *  - claude-web-cookie → the FULL Cookie header imported for claude.ai is
 *                        sent verbatim — every cookie, including
 *                        `cf_clearance` and the other Cloudflare / session
 *                        cookies a browser export carries. That matters in
 *                        practice because claude.ai's Cloudflare layer
 *                        binds clearance to the rest of the cookie set.
 *
 * Everything else — org discovery, completion URL, payload, SSE parsing,
 * fingerprint headers — is inherited unchanged from ClaudeWebDriver.
 *
 * NEEDS LIVE VERIFICATION: same transport caveats as ./claude-web.ts
 * (plain fetch vs OmniRoute's TLS-fingerprinted client / browser pool).
 */
import { requireCookieHeader } from "./types.js";
import { ClaudeWebDriver } from "./claude-web.js";

export class ClaudeWebCookieDriver extends ClaudeWebDriver {
  readonly id = "claude-web-cookie";
  readonly cookieHint =
    "log in at claude.ai, then export the FULL Cookie header for claude.ai (all cookies, incl. sessionKey and cf_clearance)";

  /** Send the imported Cookie header for claude.ai verbatim — no extraction. */
  protected override resolveCookieHeader(): string {
    return requireCookieHeader(this.jar, "https://claude.ai/", this.id, this.cookieHint);
  }
}
