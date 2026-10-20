/**
 * Google Antigravity provider — OAuth login + Cloud Code project bootstrap.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `open-sse/config/antigravityUpstream.ts`,
 * `open-sse/services/antigravityHeaders.ts`,
 * `open-sse/services/antigravityProjectBootstrap.ts` and
 * `open-sse/utils/publicCreds.ts`. Attribution retained per MIT.
 *
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED. This flow impersonates the Antigravity
 * desktop client against Google's internal Cloud Code API
 * (`cloudcode-pa.googleapis.com`, the `/v1internal:*` surface). It is NOT a
 * Google-supported integration:
 *   - Google may block the OAuth client, revoke tokens, or change the
 *     internal API at any time without notice.
 *   - Using it may violate Google's / Antigravity's Terms of Service;
 *     accounts can be limited or banned. Use your own Google account and
 *     accept the risk. Prefer official API providers for anything important.
 *   - The end-to-end flow needs a real Google account login to verify; the
 *     unit tests here only cover request shapes against mocks.
 */

import { OAuth2Client } from "../oauth2.js";
import { loadSession, saveSession, type SavedSession } from "../sessionStore.js";

/* ------------------------------------------------------------------ *
 * OAuth client credentials.
 *
 * The defaults are the Antigravity desktop app's own public OAuth client
 * id/secret, shipped inside its public binary. OAuth client credentials
 * for native/installed apps are public by design (they identify the app,
 * not a user) — OmniRoute embeds the same values (XOR-masked, decoded
 * here to plaintext) in `open-sse/utils/publicCreds.ts`
 * (`antigravity_id` / `antigravity_alt`). Override with env vars:
 *   ANTIGRAVITY_OAUTH_CLIENT_ID / ANTIGRAVITY_OAUTH_CLIENT_SECRET
 * ------------------------------------------------------------------ */
export const ANTIGRAVITY_PUBLIC_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const ANTIGRAVITY_PUBLIC_CLIENT_SECRET = "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";

export function antigravityClientId(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTIGRAVITY_OAUTH_CLIENT_ID?.trim() || ANTIGRAVITY_PUBLIC_CLIENT_ID;
}

export function antigravityClientSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() || ANTIGRAVITY_PUBLIC_CLIENT_SECRET;
}

/** Google OAuth endpoints (same values OmniRoute uses in OAUTH_ENDPOINTS.google). */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * OAuth scopes. NOTE: OmniRoute's code does not pin an antigravity scope
 * list in the files this was ported from, so this uses the standard
 * Cloud Code scope set (cloud-platform + openid/email/profile).
 * ⚠️ NEEDS LIVE VERIFICATION against a real Google login.
 */
export const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

/** Cloud Code upstream bases (OmniRoute `ANTIGRAVITY_RUNTIME_BASE_URLS` / `ANTIGRAVITY_BOOTSTRAP_BASE_URLS`). */
export const ANTIGRAVITY_RUNTIME_BASE_URLS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
] as const;
export const ANTIGRAVITY_BOOTSTRAP_BASE_URL = "https://cloudcode-pa.googleapis.com";
export const LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist";
export const ONBOARD_USER_PATH = "/v1internal:onboardUser";

/* ------------------------------------------------------------------ *
 * IDE client fingerprint — ported from OmniRoute
 * `open-sse/services/antigravityHeaders.ts`. The loadCodeAssist /
 * onboardUser `metadata` body is protobuf-JSON shaped: ideType and
 * pluginType are int32 enums on the wire (not strings) and platform is
 * required. OmniRoute's live comparison showed an incomplete client
 * identity gets 403 from Google's backend.
 * ------------------------------------------------------------------ */
export const ANTIGRAVITY_IDE_TYPE_ENUM = 9;
export const ANTIGRAVITY_PLUGIN_TYPE_GEMINI_ENUM = 2;
export const ANTIGRAVITY_PLATFORM_ENUM = {
  UNSPECIFIED: 0,
  DARWIN_AMD64: 1,
  DARWIN_ARM64: 2,
  LINUX_AMD64: 3,
  LINUX_ARM64: 4,
  WINDOWS_AMD64: 5,
} as const;

export function resolveAntigravityPlatformEnum(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): number {
  if (platform === "darwin") {
    return arch === "arm64" ? ANTIGRAVITY_PLATFORM_ENUM.DARWIN_ARM64 : ANTIGRAVITY_PLATFORM_ENUM.DARWIN_AMD64;
  }
  if (platform === "linux") {
    return arch === "arm64" ? ANTIGRAVITY_PLATFORM_ENUM.LINUX_ARM64 : ANTIGRAVITY_PLATFORM_ENUM.LINUX_AMD64;
  }
  if (platform === "win32") return ANTIGRAVITY_PLATFORM_ENUM.WINDOWS_AMD64;
  return ANTIGRAVITY_PLATFORM_ENUM.UNSPECIFIED;
}

/** Body `metadata` for loadCodeAssist / onboardUser (OmniRoute `getAntigravityLoadCodeAssistMetadata`). */
export function buildIdeMetadata(): Record<string, number> {
  return {
    ideType: ANTIGRAVITY_IDE_TYPE_ENUM,
    platform: resolveAntigravityPlatformEnum(),
    pluginType: ANTIGRAVITY_PLUGIN_TYPE_GEMINI_ENUM,
  };
}

/** Fallback IDE version (OmniRoute `ANTIGRAVITY_IDE_FALLBACK_VERSION`). */
export const ANTIGRAVITY_IDE_VERSION = "2.5.5";

/**
 * Content headers for Cloud Code calls (OmniRoute `getAntigravityContentHeaders`,
 * IDE profile). The OS/arch token is pinned to darwin/arm64 regardless of host —
 * the upstream backend expects the native Mac desktop client fingerprint
 * (OmniRoute #8098).
 */
export function buildFingerprintHeaders(accessToken?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} darwin/arm64`,
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

/* ------------------------------------------------------------------ *
 * OAuth: authorization-code flow (loopback redirect, installed-app style)
 * ------------------------------------------------------------------ */

/** Build the Google consent URL the user opens to sign in. */
export function buildAuthUrl(redirectUri: string, state?: string): string {
  const params = new URLSearchParams({
    client_id: antigravityClientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: ANTIGRAVITY_SCOPES,
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // ensure a refresh token is actually issued
  });
  if (state) params.set("state", state);
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface AntigravityTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

/** Exchange an authorization code for tokens at Google's token endpoint. */
export async function exchangeCode(
  code: string,
  redirectUri: string,
  fetchFn: typeof fetch = fetch,
): Promise<AntigravityTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: antigravityClientId(),
    client_secret: antigravityClientSecret(),
  });
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`antigravity code exchange failed: HTTP ${res.status}`);
  const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("antigravity code exchange: no access_token in response");
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
  };
}

/** Refresh an access token from a stored refresh token (wraps OAuth2Client). */
export async function refreshAccessToken(
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresAt: number }> {
  const client = new OAuth2Client(
    {
      tokenUrl: GOOGLE_TOKEN_URL,
      clientId: antigravityClientId(),
      clientSecret: antigravityClientSecret(),
      refreshToken,
    },
    fetchFn,
  );
  const accessToken = await client.token();
  // OAuth2Client caches internally; a fresh instance doesn't expose expiry,
  // so re-derive a conservative expiry (Google access tokens last ~1h).
  return { accessToken, expiresAt: Date.now() + 3600 * 1000 };
}

/* ------------------------------------------------------------------ *
 * Cloud Code bootstrap: loadCodeAssist → onboardUser.
 * Ported (simplified) from OmniRoute
 * `open-sse/services/antigravityProjectBootstrap.ts`: the API requires a
 * project context assigned to the OAuth token before chat calls work.
 * ------------------------------------------------------------------ */

export function extractProjectId(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) return null;
  const nested = (data.response as Record<string, unknown> | undefined)?.cloudaicompanionProject;
  const project = nested ?? data.cloudaicompanionProject;
  if (typeof project === "string") return project.trim() || null;
  if (project && typeof project === "object") {
    const id = (project as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
}

export interface LoadCodeAssistResult {
  projectId: string | null;
  tierId: string;
}

const DEFAULT_TIER_ID = "legacy-tier";

/** POST /v1internal:loadCodeAssist — returns the account's project + tier when already onboarded. */
export async function loadCodeAssist(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
  baseUrl: string = ANTIGRAVITY_BOOTSTRAP_BASE_URL,
): Promise<LoadCodeAssistResult> {
  const res = await fetchFn(`${baseUrl}${LOAD_CODE_ASSIST_PATH}`, {
    method: "POST",
    headers: buildFingerprintHeaders(accessToken),
    body: JSON.stringify({ metadata: buildIdeMetadata() }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`antigravity loadCodeAssist failed: HTTP ${res.status}`);
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const currentTier = (data?.currentTier as Record<string, unknown> | undefined)?.id;
  const tierId = typeof currentTier === "string" && currentTier ? currentTier : DEFAULT_TIER_ID;
  return { projectId: extractProjectId(data), tierId };
}

/** Body sent to onboardUser (exported for tests). */
export function buildOnboardPayload(tierId: string): Record<string, unknown> {
  return { tier_id: tierId, metadata: buildIdeMetadata() };
}

const ONBOARD_POLL_MAX_ATTEMPTS = 5;
const ONBOARD_POLL_INTERVAL_MS = 2_000;

/**
 * POST /v1internal:onboardUser — creates the Cloud Code project for a
 * never-onboarded account. onboardUser is a Long-Running Operation: a
 * `{done:false}` answer means "poll again", so the same request is
 * re-sent (bounded). Returns the project id, or null when Google expects
 * a user-supplied GCP project (BYOP — standard-tier personal accounts).
 */
export async function onboardUser(
  accessToken: string,
  tierId: string = DEFAULT_TIER_ID,
  fetchFn: typeof fetch = fetch,
  opts: { sleep?: (ms: number) => Promise<void>; baseUrl?: string } = {},
): Promise<string | null> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${opts.baseUrl ?? ANTIGRAVITY_BOOTSTRAP_BASE_URL}${ONBOARD_USER_PATH}`;
  const body = JSON.stringify(buildOnboardPayload(tierId));
  for (let attempt = 1; attempt <= ONBOARD_POLL_MAX_ATTEMPTS; attempt++) {
    const res = await fetchFn(url, {
      method: "POST",
      headers: buildFingerprintHeaders(accessToken),
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`antigravity onboardUser failed: HTTP ${res.status}`);
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (data?.done === false) {
      if (attempt < ONBOARD_POLL_MAX_ATTEMPTS) {
        await sleep(ONBOARD_POLL_INTERVAL_MS);
        continue;
      }
      throw new Error("antigravity onboardUser: operation did not settle in time");
    }
    return extractProjectId(data);
  }
  return null;
}

/** loadCodeAssist, falling back to onboardUser when the account has no project yet. */
export async function ensureProjectId(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const { projectId, tierId } = await loadCodeAssist(accessToken, fetchFn);
  if (projectId) return projectId;
  return onboardUser(accessToken, tierId, fetchFn);
}

/* ------------------------------------------------------------------ *
 * Session persistence (~/.llmswitch/sessions/antigravity.json, 0600)
 * ------------------------------------------------------------------ */

export const ANTIGRAVITY_SESSION_NAME = "antigravity";

export type AntigravitySession = SavedSession;

/** Best-effort email lookup (userinfo endpoint) — used for display/session derivation only. */
export async function fetchAccountEmail(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchFn("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { email?: string };
    return j.email;
  } catch {
    return undefined;
  }
}

/** Persist tokens + project after a successful login/bootstrap. */
export function saveAntigravitySession(tokens: {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  projectId?: string | null;
  email?: string;
}): string {
  return saveSession({
    name: ANTIGRAVITY_SESSION_NAME,
    kind: "oauth-refresh",
    provider: "antigravity",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    projectId: tokens.projectId ?? undefined,
    email: tokens.email,
  });
}

export function loadAntigravitySession(): SavedSession | null {
  return loadSession(ANTIGRAVITY_SESSION_NAME);
}

/**
 * A currently-valid access token for the saved session: returns the stored
 * token when fresh, otherwise refreshes it (and re-saves) via the stored
 * refresh token. Returns null when not logged in.
 */
export async function getValidAccessToken(fetchFn: typeof fetch = fetch): Promise<{
  accessToken: string;
  projectId?: string;
  email?: string;
} | null> {
  const s = loadAntigravitySession();
  if (!s) return null;
  if (s.accessToken && s.expiresAt && s.expiresAt > Date.now() + 60_000) {
    return { accessToken: s.accessToken, projectId: s.projectId, email: s.email };
  }
  if (!s.refreshToken) return null;
  const fresh = await refreshAccessToken(s.refreshToken, fetchFn);
  saveAntigravitySession({
    accessToken: fresh.accessToken,
    refreshToken: s.refreshToken,
    expiresAt: fresh.expiresAt,
    projectId: s.projectId,
    email: s.email,
  });
  return { accessToken: fresh.accessToken, projectId: s.projectId, email: s.email };
}

/**
 * Complete a login from a refresh token the user already holds (e.g.
 * exported from the Antigravity app): refresh → bootstrap project → save.
 */
export async function loginWithRefreshToken(
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<SavedSession> {
  const fresh = await refreshAccessToken(refreshToken, fetchFn);
  const projectId = await ensureProjectId(fresh.accessToken, fetchFn).catch(() => null);
  const email = await fetchAccountEmail(fresh.accessToken, fetchFn);
  saveAntigravitySession({
    accessToken: fresh.accessToken,
    refreshToken,
    expiresAt: fresh.expiresAt,
    projectId,
    email,
  });
  const saved = loadAntigravitySession();
  if (!saved) throw new Error("antigravity login: session save failed");
  return saved;
}

/**
 * Complete a login from an authorization code: exchange → bootstrap
 * project → save session.
 */
export async function completeLoginWithCode(
  code: string,
  redirectUri: string,
  fetchFn: typeof fetch = fetch,
): Promise<SavedSession> {
  const tokens = await exchangeCode(code, redirectUri, fetchFn);
  const projectId = await ensureProjectId(tokens.accessToken, fetchFn).catch(() => null);
  const email = await fetchAccountEmail(tokens.accessToken, fetchFn);
  saveAntigravitySession({ ...tokens, projectId, email });
  const saved = loadAntigravitySession();
  if (!saved) throw new Error("antigravity login: session save failed");
  return saved;
}

/**
 * Full loopback login (installed-app flow): starts a throwaway HTTP server
 * on 127.0.0.1, hands the consent URL to `onAuthUrl` (the CLI prints it),
 * waits for Google to redirect back with the code, then completes login.
 * The server only accepts the single expected callback.
 */
export async function loginWithLoopback(
  opts: { onAuthUrl: (url: string) => void; timeoutMs?: number; fetchFn?: typeof fetch } ,
): Promise<SavedSession> {
  const { createServer } = await import("node:http");
  const { randomBytes } = await import("node:crypto");
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const state = randomBytes(16).toString("hex");

  return new Promise<SavedSession>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const code = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400).end("state mismatch");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(code ? "LLMSwitch: Google sign-in received — you can close this tab." : `LLMSwitch: sign-in failed (${err ?? "no code"}).`);
      const address = server.address() as { port: number };
      const redirectUri = `http://127.0.0.1:${address.port}/callback`;
      server.close();
      clearTimeout(timer);
      if (!code) return reject(new Error(`antigravity login: Google returned error ${err ?? "no_code"}`));
      completeLoginWithCode(code, redirectUri, opts.fetchFn).then(resolve, reject);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("antigravity login: timed out waiting for browser sign-in"));
    }, timeoutMs);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      opts.onAuthUrl(buildAuthUrl(`http://127.0.0.1:${address.port}/callback`, state));
    });
    server.on("error", reject);
  });
}
