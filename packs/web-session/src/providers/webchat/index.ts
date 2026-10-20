/**
 * Cookie web-chat driver registry (P11-J).
 *
 * One driver per site, ported from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, release v3.8.53).
 * ⚠️ Unofficial reverse-engineered protocols — they rot fast and every
 * driver needs the user's own imported browser cookies to verify live.
 */
import { CookieJar } from "../../cookieJar.js";
import type { WebChatDriver, WebChatDriverCtor } from "./types.js";
import { ChatGptWebDriver } from "./chatgpt-web.js";
import { ChatGptWebFreeDriver } from "./chatgpt-web-free.js";
import { ClaudeWebDriver } from "./claude-web.js";
import { ClaudeWebCookieDriver } from "./claude-web-cookie.js";
import { CopilotWebDriver } from "./copilot-web.js";
import { GrokWebDriver } from "./grok-web.js";
import { DuckDuckGoDriver } from "./duckduckgo.js";
import { DeepSeekWebDriver } from "./deepseek-web.js";
import { HuggingChatDriver } from "./huggingchat.js";
import { LmArenaDriver } from "./lmarena.js";
import { PoeWebDriver } from "./poe.js";
import { BlackboxWebDriver } from "./blackbox.js";
import { DeepAiDriver } from "./deepai.js";
import { ManusDriver } from "./manus.js";
import { VeniceWebDriver } from "./venice-web.js";
import { YouComWebDriver } from "./you-com-web.js";

export const WEBCHAT_DRIVERS: Record<string, WebChatDriverCtor> = {
  "chatgpt-web": ChatGptWebDriver,
  "chatgpt-web-free": ChatGptWebFreeDriver,
  "claude-web": ClaudeWebDriver,
  "claude-web-cookie": ClaudeWebCookieDriver,
  "copilot-web": CopilotWebDriver,
  "grok-web": GrokWebDriver,
  duckduckgo: DuckDuckGoDriver,
  "deepseek-web": DeepSeekWebDriver,
  huggingchat: HuggingChatDriver,
  lmarena: LmArenaDriver,
  poe: PoeWebDriver,
  blackbox: BlackboxWebDriver,
  deepai: DeepAiDriver,
  manus: ManusDriver,
  "venice-web": VeniceWebDriver,
  "you-com-web": YouComWebDriver,
};

export const WEBCHAT_DRIVER_IDS = Object.keys(WEBCHAT_DRIVERS);

export function isWebChatProvider(id: string): boolean {
  return id in WEBCHAT_DRIVERS;
}

export function createWebChatDriver(
  id: string,
  jar: CookieJar,
  fetchFn: typeof fetch = fetch,
): WebChatDriver {
  const Ctor = WEBCHAT_DRIVERS[id];
  if (!Ctor) throw new Error(`unknown web-chat provider: ${id}`);
  return new Ctor(jar, fetchFn);
}

/** Cookie import help for a provider (domains + hint), without any session. */
export function webchatCookieInfo(
  id: string,
): { domains: string[]; hint: string } | undefined {
  const Ctor = WEBCHAT_DRIVERS[id];
  if (!Ctor) return undefined;
  const d = new Ctor(new CookieJar());
  return { domains: d.cookieDomains, hint: d.cookieHint };
}
