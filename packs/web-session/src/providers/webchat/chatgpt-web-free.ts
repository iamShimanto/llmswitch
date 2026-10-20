/**
 * chatgpt-web-free — anonymous / no-login variant of the chatgpt-web driver.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — see the attribution header in ./chatgpt-web.ts for the
 * full source list (registry, executor adapter, first-party bridge, delta
 * decoder). Attribution retained per MIT.
 *
 * HONEST SCOPE: OmniRoute v3.8.53 has NO separate "chatgpt-web-free"
 * provider, registry entry, or anonymous endpoint — `grep` for
 * "chatgpt-web-free" and "backend-anon" over open-sse/ finds nothing. What
 * DOES exist is a "free" selection inside chatgpt-web:
 * `resolveSelection` (open-sse/utils/chatgptWebExecutorAdapter.ts) maps the
 * catalog models `gpt-5-6-luna-free` / `gpt-5-6-luna-free-thinking` to
 * `{ kind: "free" }`, and `directModel` (open-sse/utils/chatgptWebFirstParty.ts)
 * turns a free selection into wire model `"auto"` (with the "reason" hint
 * when thinking is enabled).
 *
 * This driver is therefore implemented as the ANONYMOUS variant of
 * chatgpt-web: the identical /backend-api/f/conversation protocol and
 * delta-v1 SSE parsing, but no cookies are required and the wire model is
 * always "auto". If the user HAS imported chatgpt.com cookies they are
 * still sent (a logged-in free-tier account is the case OmniRoute's free
 * selection actually describes).
 *
 * NEEDS LIVE VERIFICATION: whether chatgpt.com accepts a conversation POST
 * with NO cookies / no session at all is UNVERIFIED — historically the
 * logged-out flow lived on a separate anonymous surface that does not
 * appear anywhere in OmniRoute v3.8.53's code. The Sentinel-header gap
 * documented in ./chatgpt-web.ts applies here too, only more so.
 */
import { ChatGptWebDriver } from "./chatgpt-web.js";

export class ChatGptWebFreeDriver extends ChatGptWebDriver {
  readonly id = "chatgpt-web-free";
  readonly cookieDomains: string[] = [];
  readonly cookieHint =
    "no login required — runs anonymously (wire model \"auto\"); importing chatgpt.com cookies is optional";

  /** Anonymous variant: cookies are optional, never required. */
  protected override requiresCookie(): boolean {
    return false;
  }

  /** Free selection always resolves to wire model "auto" (see header). */
  protected override resolveWireModel(model: string): {
    wireModel: string;
    reason: boolean;
  } {
    return { wireModel: "auto", reason: model.toLowerCase().includes("thinking") };
  }
}
