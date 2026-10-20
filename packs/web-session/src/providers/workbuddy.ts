/**
 * WorkBuddy (Tencent — www.workbuddy.ai) OAuth.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `src/lib/oauth/providers/workbuddy.ts`.
 * Attribution retained per MIT.
 *
 * Separate Tencent product from CodeBuddy CN: own host, own account system —
 * credentials are NOT interchangeable. Same plugin-auth protocol shape
 * (implemented in ./tencentPluginAuth.js with headerProfile "minimal"):
 * only `X-Product: SaaS` on the auth routes. The gateway issues a long-lived
 * token (~361 days). The token is one-shot: the first successful poll
 * consumes it. Non-stream chat requests are rejected with code 11101.
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED — see tencentPluginAuth.ts.
 */
import {
  loginWithTencentDevice,
  loadTencentSession,
  refreshTencentToken,
  type TencentPluginAuthConfig,
} from "./tencentPluginAuth.js";
import type { SavedSession } from "../sessionStore.js";

export const WORKBUDDY_CONFIG: TencentPluginAuthConfig = {
  id: "workbuddy",
  baseUrl: "https://www.workbuddy.ai",
  stateUrl: "https://www.workbuddy.ai/v2/plugin/auth/state",
  tokenUrl: "https://www.workbuddy.ai/v2/plugin/auth/token",
  refreshUrl: "https://www.workbuddy.ai/v2/plugin/auth/token/refresh",
  platform: "CLI",
  headerProfile: "minimal",
  pollIntervalMs: 5000,
  defaultExpiresInSec: 31_104_000,
};

export function loginWorkBuddy(opts: {
  onAuthUrl: (url: string) => void;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<SavedSession> {
  return loginWithTencentDevice(WORKBUDDY_CONFIG, opts);
}

export function loadWorkBuddySession(): SavedSession | null {
  return loadTencentSession(WORKBUDDY_CONFIG);
}

export function refreshWorkBuddyToken(refreshToken: string, fetchFn?: typeof fetch) {
  return refreshTencentToken(WORKBUDDY_CONFIG, refreshToken, fetchFn);
}
