/**
 * Grok CLI (xAI) OAuth.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `src/lib/oauth/providers/grok-cli.ts` (`GROK_CLI_CONFIG`),
 * `open-sse/config/grokBuild.ts` and `src/lib/oauth/utils/grokCliAuthJson.ts`.
 * Attribution retained per MIT.
 *
 * Two ways to connect:
 *   1. Device flow (primary): POST https://auth.x.ai/oauth2/device/code
 *      (client_id + scope + referrer=grok-build, x-grok-client-* headers) →
 *      user approves at the verification URI → poll
 *      https://auth.x.ai/oauth2/token (device_code grant).
 *   2. Import token: paste the entire ~/.grok/auth.json (the official Grok
 *      CLI's own auth file) — see parseGrokAuthJson().
 *
 * The public client_id below is decoded from OmniRoute's
 * `open-sse/utils/publicCreds.ts` (`grok_id`); native-app client ids are
 * public by design. Override with env var GROK_OAUTH_CLIENT_ID.
 *
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED. The chat wire is xAI's Grok Build
 * proxy (cli-chat-proxy.grok.com/v1/responses) with the CLI's own
 * authentication scheme. xAI may change or block this at any time; use
 * your own account. Live verification needs a real xAI login.
 */

import { loadSession, saveSession, type SavedSession } from "../sessionStore.js";

/* Public xAI OAuth client id (OmniRoute publicCreds.ts `grok_id`, XOR-decoded). */
export const GROK_PUBLIC_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

export function grokClientId(env: NodeJS.ProcessEnv = process.env): string {
  return env.GROK_OAUTH_CLIENT_ID?.trim() || GROK_PUBLIC_CLIENT_ID;
}

export const GROK_OAUTH_ISSUER = "https://auth.x.ai";
export const GROK_DEVICE_CODE_URL = `${GROK_OAUTH_ISSUER}/oauth2/device/code`;
export const GROK_TOKEN_URL = `${GROK_OAUTH_ISSUER}/oauth2/token`;
export const GROK_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
  "conversations:read",
  "conversations:write",
].join(" ");
export const GROK_OAUTH_REFERRER = "grok-build";
export const GROK_CLI_CLIENT_VERSION = "1.0.41"; // OmniRoute GROK_BUILD_DEFAULT_CLIENT_VERSION

/** x-grok-* headers the official CLI sends (OmniRoute getGrokBuildOAuthHeaders). */
export function grokOAuthHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    "x-grok-client-version": env.GROK_CLI_CLIENT_VERSION?.trim() || GROK_CLI_CLIENT_VERSION,
    "x-grok-client-surface": "ui",
  };
}

export interface GrokDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresInSec: number;
  intervalSec: number;
}

/** Step 1 of the device flow: request device + user codes. */
export async function requestGrokDeviceCode(fetchFn: typeof fetch = fetch): Promise<GrokDeviceCode> {
  const res = await fetchFn(GROK_DEVICE_CODE_URL, {
    method: "POST",
    headers: grokOAuthHeaders(),
    body: new URLSearchParams({
      client_id: grokClientId(),
      scope: GROK_OAUTH_SCOPES,
      referrer: GROK_OAUTH_REFERRER,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `grok-cli device authorization failed: ${typeof data.error_description === "string" ? data.error_description : `HTTP ${res.status}`}`,
    );
  }
  const { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval } = data;
  if (
    typeof device_code !== "string" ||
    typeof user_code !== "string" ||
    typeof verification_uri !== "string" ||
    !/^[A-Za-z0-9-]+$/.test(user_code)
  ) {
    throw new Error("grok-cli device authorization response is incomplete");
  }
  return {
    deviceCode: device_code,
    userCode: user_code,
    verificationUri: verification_uri,
    verificationUriComplete: typeof verification_uri_complete === "string" ? verification_uri_complete : verification_uri,
    expiresInSec: typeof expires_in === "number" ? expires_in : 1800,
    intervalSec: typeof interval === "number" ? interval : 5,
  };
}

export interface GrokTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email?: string;
}

/** One device poll: POST the device_code grant. Returns null while pending. */
export async function pollGrokTokenOnce(deviceCode: string, fetchFn: typeof fetch = fetch): Promise<GrokTokens | null> {
  const res = await fetchFn(GROK_TOKEN_URL, {
    method: "POST",
    headers: grokOAuthHeaders(),
    body: new URLSearchParams({
      client_id: grokClientId(),
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof data.access_token === "string") {
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      expiresAt: Date.now() + (typeof data.expires_in === "number" ? data.expires_in : 3600) * 1000,
    };
  }
  if (data.error === "authorization_pending") return null;
  if (data.error === "slow_down") throw new Error("slow_down"); // loop backs off +5s
  if (data.error === "access_denied") throw new Error("grok-cli device flow: user denied access");
  if (data.error === "expired_token") throw new Error("grok-cli device flow: device code expired");
  throw new Error(`grok-cli device flow failed: ${typeof data.error === "string" ? data.error : `HTTP ${res.status}`}`);
}

/** Full device login: request codes → onUserCode → poll (bounded) → save session. */
export async function loginWithGrokDevice(opts: {
  onUserCode: (code: GrokDeviceCode) => void;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SavedSession> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dc = await requestGrokDeviceCode(fetchFn);
  opts.onUserCode(dc);
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  let interval = dc.intervalSec;
  for (;;) {
    if (Date.now() > deadline) throw new Error("grok-cli device flow timed out waiting for approval");
    await sleep(interval * 1000);
    try {
      const tokens = await pollGrokTokenOnce(dc.deviceCode, fetchFn);
      if (tokens) return saveGrokSession(tokens);
    } catch (e) {
      // slow_down is reported as a null→retry by the caller; a fresh slow_down
      // throw would mean we mis-parsed — re-map here defensively.
      if (e instanceof Error && e.message.includes("slow_down")) {
        interval += 5;
        continue;
      }
      throw e;
    }
  }
}

/** Standard refresh_token grant at the xAI token endpoint. */
export async function refreshGrokToken(refreshToken: string, fetchFn: typeof fetch = fetch): Promise<GrokTokens> {
  const res = await fetchFn(GROK_TOKEN_URL, {
    method: "POST",
    headers: grokOAuthHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: grokClientId(),
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    throw new Error(`grok-cli token refresh failed: HTTP ${res.status}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : refreshToken,
    expiresAt: Date.now() + (typeof data.expires_in === "number" ? data.expires_in : 3600) * 1000,
  };
}

/**
 * Parse the official Grok CLI's ~/.grok/auth.json (or a raw JWT) into tokens.
 * Mirrors the tolerant extraction of OmniRoute's grokCliAuthJson.ts:
 * top-level access_token/key/token, or a per-client entry object.
 */
export function parseGrokAuthJson(text: string): { accessToken: string; refreshToken?: string; email?: string } {
  const raw = text.trim();
  if (!raw) throw new Error("grok-cli import: empty input");
  // Raw JWT passthrough.
  if (/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/.test(raw) && !raw.startsWith("{")) {
    return { accessToken: raw };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("grok-cli import: not valid JSON and not a JWT");
  }
  const candidates: Record<string, unknown>[] =
    parsed && typeof parsed === "object"
      ? [parsed as Record<string, unknown>, ...Object.values(parsed as Record<string, unknown>).filter((v) => v && typeof v === "object") as Record<string, unknown>[]]
      : [];
  for (const c of candidates) {
    const token =
      typeof c.access_token === "string" ? c.access_token
      : typeof c.key === "string" ? c.key
      : typeof c.token === "string" ? c.token
      : null;
    if (token) {
      return {
        accessToken: token,
        refreshToken: typeof c.refresh_token === "string" ? c.refresh_token : undefined,
        email: typeof c.email === "string" ? c.email : undefined,
      };
    }
  }
  throw new Error("grok-cli import: no access token found in the file");
}

/** Persist tokens (~/.llmswitch/sessions/grok-cli.json, 0600). */
export function saveGrokSession(tokens: GrokTokens, kind: SavedSession["kind"] = "oauth-device"): SavedSession {
  saveSession({
    name: "grok-cli",
    kind,
    provider: "grok-cli",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    email: tokens.email,
  });
  const saved = loadSession("grok-cli");
  if (!saved) throw new Error("grok-cli login: session save failed");
  return saved;
}

/** Import an auth.json blob (paste or --file) into the session store. */
export function importGrokAuthJson(text: string): SavedSession {
  const tokens = parseGrokAuthJson(text);
  return saveGrokSession({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: Date.now() + 86_400_000, email: tokens.email }, "oauth-refresh");
}

export function loadGrokSession(): SavedSession | null {
  return loadSession("grok-cli");
}
