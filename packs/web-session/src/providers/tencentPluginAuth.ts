/**
 * Tencent "plugin-auth" device flow — shared by CodeBuddy CN, CodeBuddy
 * International and WorkBuddy.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `src/lib/oauth/providers/codebuddyDeviceAuth.ts`,
 * `src/lib/oauth/providers/workbuddy.ts` and `src/lib/oauth/constants/oauth.ts`.
 * Attribution retained per MIT.
 *
 * Protocol (verified against OmniRoute's code, live-verified by them
 * 2026-09-19 for WorkBuddy):
 *   1. POST {stateUrl}?platform=<platform>  -> { code: 0, data: { state, authUrl } }
 *   2. User opens authUrl in a browser and signs in.
 *   3. GET  {tokenUrl}?state=<state>        -> code 0 + data.accessToken when done;
 *      any other code (11217 = "login in progress" on WorkBuddy) means keep polling.
 *      The token is one-shot: the first successful poll consumes it.
 *   4. POST {refreshUrl} rotates the token (WorkBuddy returns the new token in
 *      the `X-Refresh-Token` response header).
 *
 * There is NO client_id/secret: the upstream CLIs ship none.
 *
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED. These flows impersonate Tencent's own
 * CLI/IDE clients. Tencent may change or block them at any time; use your own
 * account and accept the risk. End-to-end verification needs a real Tencent
 * account login — unit tests only cover request shapes against mocks.
 */

import { loadSession, saveSession, type SavedSession } from "../sessionStore.js";

export interface TencentPluginAuthConfig {
  /** session file name / provider id, e.g. "codebuddy-cn" */
  id: string;
  baseUrl: string;
  stateUrl: string;
  tokenUrl: string;
  refreshUrl: string;
  /** sent as ?platform= and in the JSON body */
  platform: string;
  /** "codebuddy" sends the full X-* header family; "minimal" (WorkBuddy) only X-Product */
  headerProfile: "codebuddy" | "minimal";
  userAgent?: string;
  domain?: string;
  pollIntervalMs?: number;
  /** expires_in fallback when the gateway doesn't report one */
  defaultExpiresInSec: number;
}

function authHeaders(config: TencentPluginAuthConfig, forPoll = false): Record<string, string> {
  if (config.headerProfile === "minimal") {
    // WorkBuddy: gateway documents only X-Product (OmniRoute workbuddy.ts).
    return { Accept: "application/json", "X-Product": "SaaS" };
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "X-Domain": config.domain ?? new URL(config.baseUrl).host,
    "X-No-Authorization": "true",
    "X-No-User-Id": "true",
    "X-Product": "SaaS",
  };
  if (config.userAgent) headers["User-Agent"] = config.userAgent;
  if (forPoll) {
    headers["X-No-Enterprise-Id"] = "true";
    headers["X-No-Department-Info"] = "true";
  }
  return headers;
}

export interface TencentDeviceCode {
  state: string;
  authUrl: string;
  intervalSec: number;
  expiresInSec: number;
}

interface TencentEnvelope<T> {
  code?: number;
  data?: T;
  msg?: string;
}

/** Step 1: request a login state + the browser URL the user must open. */
export async function requestTencentDeviceCode(
  config: TencentPluginAuthConfig,
  fetchFn: typeof fetch = fetch,
): Promise<TencentDeviceCode> {
  const url = `${config.stateUrl}?platform=${encodeURIComponent(config.platform)}`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(config) },
    body: JSON.stringify({ platform: config.platform }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${config.id} state request failed: HTTP ${res.status}`);
  const json = (await res.json()) as TencentEnvelope<{ state?: string | number; authUrl?: string; url?: string }>;
  if (json.code !== 0 || json.data?.state == null) {
    throw new Error(`${config.id} state error: ${json.msg || "no state in response"}`);
  }
  return {
    state: String(json.data.state),
    authUrl: String(json.data.authUrl || json.data.url || ""),
    intervalSec: Math.max(1, Math.floor((config.pollIntervalMs ?? 5000) / 1000)),
    expiresInSec: 600,
  };
}

export interface TencentTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

/** One poll attempt. Returns null while the user hasn't finished signing in. */
export async function pollTencentTokenOnce(
  config: TencentPluginAuthConfig,
  state: string,
  fetchFn: typeof fetch = fetch,
): Promise<TencentTokens | null> {
  const res = await fetchFn(`${config.tokenUrl}?state=${encodeURIComponent(state)}`, {
    method: "GET",
    headers: authHeaders(config, true),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as TencentEnvelope<{
    accessToken?: string;
    refreshToken?: string;
    tokenType?: string;
    expiresIn?: number;
  }> | null;
  if (data?.code === 0 && data.data?.accessToken) {
    return {
      accessToken: data.data.accessToken,
      refreshToken: data.data.refreshToken,
      expiresAt: Date.now() + (data.data.expiresIn ?? config.defaultExpiresInSec) * 1000,
    };
  }
  return null;
}

/** Poll until the user signs in (bounded). The token is one-shot — saved immediately. */
export async function pollTencentToken(
  config: TencentPluginAuthConfig,
  state: string,
  opts: { fetchFn?: typeof fetch; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TencentTokens> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  const intervalMs = config.pollIntervalMs ?? 5000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`${config.id} login timed out waiting for browser sign-in`);
    const tokens = await pollTencentTokenOnce(config, state, fetchFn);
    if (tokens) return tokens;
    await sleep(intervalMs);
  }
}

/** Persist tokens to ~/.llmswitch/sessions/<id>.json (0600). */
export function saveTencentSession(config: TencentPluginAuthConfig, tokens: TencentTokens): string {
  return saveSession({
    name: config.id,
    kind: "oauth-device",
    provider: config.id,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  });
}

export function loadTencentSession(config: TencentPluginAuthConfig): SavedSession | null {
  return loadSession(config.id);
}

/**
 * Full device login: request state → hand the auth URL to `onAuthUrl` →
 * poll → save session.
 */
export async function loginWithTencentDevice(
  config: TencentPluginAuthConfig,
  opts: {
    onAuthUrl: (url: string) => void;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<SavedSession> {
  const dc = await requestTencentDeviceCode(config, opts.fetchFn);
  opts.onAuthUrl(dc.authUrl);
  const tokens = await pollTencentToken(config, dc.state, opts);
  saveTencentSession(config, tokens);
  const saved = loadTencentSession(config);
  if (!saved) throw new Error(`${config.id} login: session save failed`);
  return saved;
}

/**
 * Refresh via {refreshUrl}. WorkBuddy returns the fresh token in the
 * `X-Refresh-Token` response header; CodeBuddy answers with the standard
 * envelope body. Both shapes are accepted.
 * ⚠️ NEEDS LIVE VERIFICATION for the exact request body field name.
 */
export async function refreshTencentToken(
  config: TencentPluginAuthConfig,
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<TencentTokens> {
  const res = await fetchFn(config.refreshUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(config) },
    body: JSON.stringify({ refreshToken, refresh_token: refreshToken }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${config.id} token refresh failed: HTTP ${res.status}`);
  const headerToken = res.headers.get("x-refresh-token");
  const body = (await res.json().catch(() => null)) as TencentEnvelope<{
    accessToken?: string;
    access_token?: string;
    token?: string;
    refreshToken?: string;
    expiresIn?: number;
  }> | null;
  const accessToken = headerToken || body?.data?.accessToken || body?.data?.access_token || body?.data?.token;
  if (!accessToken) throw new Error(`${config.id} token refresh: no token in response`);
  return {
    accessToken,
    refreshToken: body?.data?.refreshToken ?? refreshToken,
    expiresAt: Date.now() + (body?.data?.expiresIn ?? config.defaultExpiresInSec) * 1000,
  };
}
