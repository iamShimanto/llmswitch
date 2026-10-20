/**
 * CodeBuddy CN (Tencent — copilot.tencent.com) OAuth.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `src/lib/oauth/providers/codebuddy-cn.ts` and
 * `CODEBUDDY_CN_CONFIG` in `src/lib/oauth/constants/oauth.ts`.
 * Attribution retained per MIT.
 *
 * Custom plugin-auth device flow (no client_id/secret); the shared
 * implementation lives in ./tencentPluginAuth.js. Streaming is forced on
 * the chat gateway: non-stream requests are rejected with code 11101.
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED — see tencentPluginAuth.ts.
 */
import {
  loginWithTencentDevice,
  loadTencentSession,
  refreshTencentToken,
  type TencentPluginAuthConfig,
} from "./tencentPluginAuth.js";
import type { SavedSession } from "../sessionStore.js";

export const CODEBUDDY_CN_CONFIG: TencentPluginAuthConfig = {
  id: "codebuddy-cn",
  baseUrl: "https://copilot.tencent.com",
  stateUrl: "https://copilot.tencent.com/v2/plugin/auth/state",
  tokenUrl: "https://copilot.tencent.com/v2/plugin/auth/token",
  refreshUrl: "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
  platform: "CLI",
  headerProfile: "codebuddy",
  userAgent: "CLI/2.108.1 CodeBuddy/2.108.1",
  domain: "copilot.tencent.com",
  pollIntervalMs: 5000,
  defaultExpiresInSec: 86_400,
};

export function loginCodeBuddyCn(opts: {
  onAuthUrl: (url: string) => void;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<SavedSession> {
  return loginWithTencentDevice(CODEBUDDY_CN_CONFIG, opts);
}

export function loadCodeBuddyCnSession(): SavedSession | null {
  return loadTencentSession(CODEBUDDY_CN_CONFIG);
}

export function refreshCodeBuddyCnToken(refreshToken: string, fetchFn?: typeof fetch) {
  return refreshTencentToken(CODEBUDDY_CN_CONFIG, refreshToken, fetchFn);
}
