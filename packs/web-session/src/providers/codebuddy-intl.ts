/**
 * CodeBuddy International (codebuddy.ai) OAuth.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `src/lib/oauth/providers/codebuddy-intl.ts` and
 * `CODEBUDDY_INTL_CONFIG` in `src/lib/oauth/constants/oauth.ts`.
 * Attribution retained per MIT.
 *
 * Same plugin-auth device flow as codebuddy-cn (see ./tencentPluginAuth.js)
 * but against www.codebuddy.ai with platform=ide and the IDE user agent.
 * Accounts are NOT interchangeable between CN and Intl.
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED — see tencentPluginAuth.ts.
 */
import {
  loginWithTencentDevice,
  loadTencentSession,
  refreshTencentToken,
  type TencentPluginAuthConfig,
} from "./tencentPluginAuth.js";
import type { SavedSession } from "../sessionStore.js";

export const CODEBUDDY_INTL_CONFIG: TencentPluginAuthConfig = {
  id: "codebuddy-intl",
  baseUrl: "https://www.codebuddy.ai",
  stateUrl: "https://www.codebuddy.ai/v2/plugin/auth/state",
  tokenUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
  refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
  platform: "ide",
  headerProfile: "codebuddy",
  userAgent: "IDE/2.108.1 CodeBuddy/2.108.1",
  domain: "www.codebuddy.ai",
  pollIntervalMs: 5000,
  defaultExpiresInSec: 86_400,
};

export function loginCodeBuddyIntl(opts: {
  onAuthUrl: (url: string) => void;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<SavedSession> {
  return loginWithTencentDevice(CODEBUDDY_INTL_CONFIG, opts);
}

export function loadCodeBuddyIntlSession(): SavedSession | null {
  return loadTencentSession(CODEBUDDY_INTL_CONFIG);
}

export function refreshCodeBuddyIntlToken(refreshToken: string, fetchFn?: typeof fetch) {
  return refreshTencentToken(CODEBUDDY_INTL_CONFIG, refreshToken, fetchFn);
}
