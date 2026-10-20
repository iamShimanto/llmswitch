/**
 * Kiro AI (AWS) — device-code OAuth login + refresh + token import.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `src/lib/oauth/constants/oauth.ts` (KIRO_CONFIG),
 * `src/lib/oauth/providers/kiro.ts` (AWS SSO OIDC device flow),
 * `src/app/api/oauth/kiro/social-authorize/route.ts` (social device flow),
 * `open-sse/config/providers/registry/kiro/index.ts` (social refresh URL),
 * `open-sse/services/kiroExternalIdp.ts` (auth-method notes). Attribution
 * retained per MIT.
 *
 * Auth methods (OmniRoute KIRO_CONFIG.authMethods):
 *   1. builder-id — AWS SSO OIDC device flow: register a public client at
 *      https://oidc.us-east-1.amazonaws.com/client/register, request a
 *      device code at /device_authorization, poll /token. Refresh uses the
 *      same /token endpoint with grant_type=refresh_token + registered
 *      clientId/clientSecret.
 *   2. google / github (social) — device flow against Kiro's own auth
 *      service (prod.us-east-1.auth.desktop.kiro.dev): POST
 *      /oauth/device/authorization {clientId, loginProvider} →
 *      verificationUriComplete + deviceCode, poll /oauth/device/poll.
 *      Refresh: POST {socialAuthEndpoint}/refreshToken {refreshToken}.
 *   3. import — paste a refresh token from the Kiro IDE
 *      (~/.aws/sso/cache/kiro-auth-token.json).
 *
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED. Kiro's ToS prohibits third-party
 * proxy use (OmniRoute flags this on the provider). Accounts can be
 * limited or banned. Use your own account and accept the risk.
 */

import { loadSession, saveSession, type SavedSession } from "../sessionStore.js";

/** Endpoints (OmniRoute KIRO_CONFIG). */
export const KIRO_SSO_OIDC_ENDPOINT = "https://oidc.us-east-1.amazonaws.com";
export const KIRO_REGISTER_CLIENT_URL = "https://oidc.us-east-1.amazonaws.com/client/register";
export const KIRO_DEVICE_AUTH_URL = "https://oidc.us-east-1.amazonaws.com/device_authorization";
export const KIRO_TOKEN_URL = "https://oidc.us-east-1.amazonaws.com/token";
export const KIRO_BUILDER_ID_START_URL = "https://view.awsapps.com/start";
export const KIRO_CLIENT_NAME = "kiro-oauth-client";
export const KIRO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
] as const;
export const KIRO_GRANT_TYPES = [
  "urn:ietf:params:oauth:grant-type:device_code",
  "refresh_token",
] as const;
export const KIRO_ISSUER_URL = "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6";

/** Social (Google/GitHub) auth service — OmniRoute KIRO_CONFIG.social*. */
export const KIRO_SOCIAL_AUTH_ENDPOINT = "https://prod.us-east-1.auth.desktop.kiro.dev";
export const KIRO_SOCIAL_DEVICE_AUTHORIZE_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/device/authorization";
export const KIRO_SOCIAL_DEVICE_POLL_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/device/poll";
export const KIRO_SOCIAL_REFRESH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
/** Public CLI identifier — the Kiro device endpoint treats it like a User-Agent, not a secret (OmniRoute note). Env override: KIRO_OAUTH_CLIENT_ID. */
export function kiroSocialClientId(env: NodeJS.ProcessEnv = process.env): string {
  return env.KIRO_OAUTH_CLIENT_ID?.trim() || "kiro-cli";
}

export const KIRO_SESSION_NAME = "kiro";
export type KiroAuthMethod = "builder-id" | "google" | "github" | "import";

export interface KiroSessionMeta {
  authMethod?: string;
  clientId?: string;
  clientSecret?: string;
  profileArn?: string;
  region?: string;
}

export function kiroSessionMeta(s: SavedSession | null): KiroSessionMeta {
  return (s?.meta ?? {}) as KiroSessionMeta;
}

/* ------------------------------------------------------------------ *
 * AWS SSO OIDC device flow (Builder ID)
 * ------------------------------------------------------------------ */

export interface KiroDeviceSession {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalMs: number;
  clientId: string;
  clientSecret: string;
}

/** Step 1+2: register a public OIDC client, then request a device code. */
export async function startKiroDeviceFlow(
  fetchFn: typeof fetch = fetch,
  opts: { startUrl?: string } = {},
): Promise<KiroDeviceSession> {
  const registerRes = await fetchFn(KIRO_REGISTER_CLIENT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      clientName: KIRO_CLIENT_NAME,
      clientType: "public",
      scopes: [...KIRO_SCOPES],
      grantTypes: [...KIRO_GRANT_TYPES],
      issuerUrl: KIRO_ISSUER_URL,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!registerRes.ok) {
    throw new Error(`kiro client registration failed: HTTP ${registerRes.status} ${await safeText(registerRes)}`);
  }
  const client = (await registerRes.json()) as { clientId?: string; clientSecret?: string };
  if (!client.clientId || !client.clientSecret) {
    throw new Error("kiro client registration: missing clientId/clientSecret");
  }

  const deviceRes = await fetchFn(KIRO_DEVICE_AUTH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      startUrl: opts.startUrl ?? KIRO_BUILDER_ID_START_URL,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!deviceRes.ok) {
    throw new Error(`kiro device authorization failed: HTTP ${deviceRes.status} ${await safeText(deviceRes)}`);
  }
  const device = (await deviceRes.json()) as {
    deviceCode?: string; userCode?: string; verificationUri?: string;
    verificationUriComplete?: string; expiresIn?: number; interval?: number;
  };
  if (!device.deviceCode) throw new Error("kiro device authorization: missing deviceCode");
  return {
    deviceCode: device.deviceCode,
    userCode: device.userCode ?? "",
    verificationUri: device.verificationUri ?? KIRO_BUILDER_ID_START_URL,
    verificationUriComplete: device.verificationUriComplete,
    expiresAt: Date.now() + (device.expiresIn ?? 600) * 1000,
    intervalMs: (device.interval ?? 5) * 1000,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
  };
}

export interface KiroTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

type PollOutcome = { kind: "pending" } | { kind: "tokens"; tokens: KiroTokens } | { kind: "error"; message: string };

/** One poll of the SSO OIDC /token endpoint for the device-code grant. */
export async function pollKiroDeviceTokenOnce(
  session: KiroDeviceSession,
  fetchFn: typeof fetch = fetch,
): Promise<PollOutcome> {
  const res = await fetchFn(KIRO_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      clientId: session.clientId,
      clientSecret: session.clientSecret,
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
      deviceCode: session.deviceCode,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => null)) as {
    accessToken?: string; refreshToken?: string; expiresIn?: number; error?: string;
  } | null;
  if (res.ok && j?.accessToken) {
    return {
      kind: "tokens",
      tokens: {
        accessToken: j.accessToken,
        refreshToken: j.refreshToken,
        expiresAt: Date.now() + (j.expiresIn ?? 3600) * 1000,
      },
    };
  }
  const err = j?.error ?? "";
  if (err === "authorization_pending" || err === "slow_down") return { kind: "pending" };
  return { kind: "error", message: `kiro device token poll failed: ${err || `HTTP ${res.status}`}` };
}

/** Refresh (Builder ID / imported SSO tokens) via the SSO OIDC /token endpoint. */
export async function refreshKiroSsoToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  fetchFn: typeof fetch = fetch,
): Promise<KiroTokens> {
  const res = await fetchFn(KIRO_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      clientId,
      clientSecret,
      grantType: "refresh_token",
      refreshToken,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`kiro token refresh failed: HTTP ${res.status} — re-run: llmswitch login kiro`);
  const j = (await res.json()) as { accessToken?: string; refreshToken?: string; expiresIn?: number };
  if (!j.accessToken) throw new Error("kiro token refresh: no accessToken in response");
  return {
    accessToken: j.accessToken,
    refreshToken: j.refreshToken ?? refreshToken,
    expiresAt: Date.now() + (j.expiresIn ?? 3600) * 1000,
  };
}

/* ------------------------------------------------------------------ *
 * Social device flow (Google / GitHub) via the Kiro auth service
 * ------------------------------------------------------------------ */

export interface KiroSocialDeviceSession {
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  expiresAt: number;
  intervalMs: number;
  provider: "google" | "github";
}

export async function startKiroSocialDeviceFlow(
  provider: "google" | "github",
  fetchFn: typeof fetch = fetch,
): Promise<KiroSocialDeviceSession> {
  const res = await fetchFn(KIRO_SOCIAL_DEVICE_AUTHORIZE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      clientId: kiroSocialClientId(),
      loginProvider: provider === "google" ? "Google" : "Github",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`kiro social device authorization failed: HTTP ${res.status} ${await safeText(res)}`);
  const data = (await res.json()) as {
    verificationUriComplete?: string; deviceCode?: string; userCode?: string;
    expiresInMilliseconds?: number; intervalInMilliseconds?: number;
  };
  if (!data.deviceCode || !data.verificationUriComplete) {
    throw new Error("kiro social device authorization: missing deviceCode/verificationUriComplete");
  }
  return {
    deviceCode: data.deviceCode,
    userCode: data.userCode ?? "",
    verificationUriComplete: data.verificationUriComplete,
    expiresAt: Date.now() + (data.expiresInMilliseconds ?? 300_000),
    intervalMs: data.intervalInMilliseconds ?? 5_000,
    provider,
  };
}

export async function pollKiroSocialDeviceOnce(
  session: KiroSocialDeviceSession,
  fetchFn: typeof fetch = fetch,
): Promise<PollOutcome> {
  const res = await fetchFn(KIRO_SOCIAL_DEVICE_POLL_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ clientId: kiroSocialClientId(), deviceCode: session.deviceCode }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => null)) as {
    accessToken?: string; refreshToken?: string; expiresIn?: number;
    status?: string; error?: string;
  } | null;
  if (res.ok && j?.accessToken) {
    return {
      kind: "tokens",
      tokens: {
        accessToken: j.accessToken,
        refreshToken: j.refreshToken,
        expiresAt: Date.now() + (j.expiresIn ?? 3600) * 1000,
      },
    };
  }
  const status = (j?.status ?? j?.error ?? "").toLowerCase();
  if (!res.ok && res.status !== 202 && status !== "pending" && status !== "authorization_pending") {
    return { kind: "error", message: `kiro social poll failed: ${j?.error || `HTTP ${res.status}`}` };
  }
  return { kind: "pending" };
}

/** Refresh social tokens via the Kiro auth service (OmniRoute registry kiro.oauth.tokenUrl). */
export async function refreshKiroSocialToken(
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<KiroTokens> {
  const res = await fetchFn(KIRO_SOCIAL_REFRESH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ refreshToken }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`kiro social token refresh failed: HTTP ${res.status} — re-run: llmswitch login kiro`);
  const j = (await res.json()) as { accessToken?: string; refreshToken?: string; expiresIn?: number };
  if (!j.accessToken) throw new Error("kiro social token refresh: no accessToken in response");
  return {
    accessToken: j.accessToken,
    refreshToken: j.refreshToken ?? refreshToken,
    expiresAt: Date.now() + (j.expiresIn ?? 3600) * 1000,
  };
}

/* ------------------------------------------------------------------ *
 * Session persistence (~/.llmswitch/sessions/kiro.json, 0600)
 * ------------------------------------------------------------------ */

function saveKiroSession(tokens: KiroTokens, meta: KiroSessionMeta): string {
  return saveSession({
    name: KIRO_SESSION_NAME,
    kind: "oauth-device",
    provider: "kiro",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    meta: { ...meta },
  });
}

export function loadKiroSession(): SavedSession | null {
  return loadSession(KIRO_SESSION_NAME);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Full Builder-ID device login: register → show URL → poll → save. */
export async function loginKiroBuilderId(opts: {
  onAuthUrl: (url: string, userCode: string) => void;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SavedSession> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? sleepDefault;
  const session = await startKiroDeviceFlow(fetchFn);
  opts.onAuthUrl(session.verificationUriComplete ?? session.verificationUri, session.userCode);
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  for (;;) {
    if (Date.now() > deadline || Date.now() > session.expiresAt) {
      throw new Error("kiro login: device code expired — re-run: llmswitch login kiro");
    }
    const outcome = await pollKiroDeviceTokenOnce(session, fetchFn);
    if (outcome.kind === "tokens") {
      saveKiroSession(outcome.tokens, {
        authMethod: "builder-id",
        clientId: session.clientId,
        clientSecret: session.clientSecret,
      });
      const saved = loadKiroSession();
      if (!saved) throw new Error("kiro login: session save failed");
      return saved;
    }
    if (outcome.kind === "error") throw new Error(outcome.message);
    await sleep(session.intervalMs);
  }
}

/** Full social (Google/GitHub) device login. */
export async function loginKiroSocial(
  provider: "google" | "github",
  opts: {
    onAuthUrl: (url: string, userCode: string) => void;
    timeoutMs?: number;
    fetchFn?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<SavedSession> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? sleepDefault;
  const session = await startKiroSocialDeviceFlow(provider, fetchFn);
  opts.onAuthUrl(session.verificationUriComplete, session.userCode);
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  for (;;) {
    if (Date.now() > deadline || Date.now() > session.expiresAt) {
      throw new Error("kiro login: device code expired — re-run: llmswitch login kiro");
    }
    const outcome = await pollKiroSocialDeviceOnce(session, fetchFn);
    if (outcome.kind === "tokens") {
      saveKiroSession(outcome.tokens, { authMethod: provider });
      const saved = loadKiroSession();
      if (!saved) throw new Error("kiro login: session save failed");
      return saved;
    }
    if (outcome.kind === "error") throw new Error(outcome.message);
    await sleep(session.intervalMs);
  }
}

/**
 * Import a refresh token from the Kiro IDE (~/.aws/sso/cache/kiro-auth-token.json).
 * The file carries accessToken/refreshToken (+profileArn for some accounts).
 * We store it as-is; refresh of imported SSO tokens needs the registered
 * client creds from the login flow, so imported sessions work until the
 * access token expires unless they came with client registration data.
 */
export async function importKiroToken(input: {
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  profileArn?: string;
}): Promise<SavedSession> {
  if (!input.refreshToken && !input.accessToken) {
    throw new Error("kiro import: a refreshToken (or accessToken) is required");
  }
  saveSession({
    name: KIRO_SESSION_NAME,
    kind: "oauth-refresh",
    provider: "kiro",
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    meta: { authMethod: "import", profileArn: input.profileArn },
  });
  const saved = loadKiroSession();
  if (!saved) throw new Error("kiro import: session save failed");
  return saved;
}

/** Valid access token for the saved session (refreshes per auth method). */
export async function getValidKiroAccessToken(
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string; profileArn?: string } | null> {
  const s = loadKiroSession();
  if (!s) return null;
  const meta = kiroSessionMeta(s);
  if (s.accessToken && s.expiresAt && s.expiresAt > Date.now() + 60_000) {
    return { accessToken: s.accessToken, profileArn: meta.profileArn };
  }
  if (!s.refreshToken) return s.accessToken ? { accessToken: s.accessToken, profileArn: meta.profileArn } : null;
  let fresh: KiroTokens;
  if (meta.authMethod === "google" || meta.authMethod === "github") {
    fresh = await refreshKiroSocialToken(s.refreshToken, fetchFn);
  } else if (meta.clientId && meta.clientSecret) {
    fresh = await refreshKiroSsoToken(s.refreshToken, meta.clientId, meta.clientSecret, fetchFn);
  } else {
    // Imported token without client registration: cannot refresh.
    return s.accessToken ? { accessToken: s.accessToken, profileArn: meta.profileArn } : null;
  }
  saveKiroSession(fresh, meta);
  return { accessToken: fresh.accessToken, profileArn: meta.profileArn };
}
