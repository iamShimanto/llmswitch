/**
 * Codex OAuth provider — login for the OpenAI Codex CLI's OAuth client.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53):
 *  - `open-sse/config/providers/registry/codex/index.ts` (authType oauth,
 *    authHeader bearer, baseUrl https://chatgpt.com/backend-api/codex/responses,
 *    forceStream, oauth tokenUrl, public client id)
 *  - `open-sse/config/codexClient.ts` (getCodexDefaultHeaders, originator,
 *    Codex client identity)
 *  - `open-sse/utils/publicCreds.ts` (`codex_id` — the Codex CLI's public
 *    OAuth client id; public native-app creds identify the app, not a user)
 *  - `open-sse/config/constants.ts` (OAUTH_ENDPOINTS.openai)
 *  - `open-sse/executors/codex.ts` (chatgpt-account-id workspace binding)
 *
 * ⚠️ UNOFFICIAL. Codex OAuth is intended for the Codex CLI with a ChatGPT
 * subscription; routing other traffic through it may violate OpenAI's Terms
 * of Service — use your own account and accept the risk.
 *
 * ⚠️ LIVE VERIFICATION STILL NEEDED: OmniRoute's code pins the OAuth
 * endpoints and client id, but NOT a scope list — CODEX_SCOPES below is
 * the well-known Codex CLI scope set, env-overridable, and must be
 * confirmed against a real login. Also, OpenAI may restrict the redirect
 * URI for this public client (the official CLI uses a fixed loopback
 * port); if the dashboard's dynamic-port callback is rejected at consent
 * time, use the CLI loopback login instead.
 */

import { generatePkce, OAuth2Client } from "../oauth2.js";
import { loadSession, saveSession, type SavedSession } from "../sessionStore.js";

/* ------------------------------------------------------------------ *
 * OAuth client credentials.
 * ------------------------------------------------------------------ */

/** The Codex CLI's public OAuth client id (OmniRoute publicCreds `codex_id`). */
export const CODEX_PUBLIC_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export function codexClientId(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_OAUTH_CLIENT_ID?.trim() || CODEX_PUBLIC_CLIENT_ID;
}

/** OmniRoute OAUTH_ENDPOINTS.openai (env-overridable). */
export const CODEX_AUTH_URL =
  process.env.CODEX_OAUTH_AUTH_URL?.trim() || "https://auth.openai.com/oauth/authorize";
/** OmniRoute registry codex oauth.tokenUrl (env-overridable). */
export const CODEX_TOKEN_URL =
  process.env.CODEX_OAUTH_TOKEN_URL?.trim() || "https://auth.openai.com/oauth/token";

/**
 * OAuth scopes. OmniRoute does not pin a scope list in the files ported
 * from; this is the well-known Codex CLI scope set.
 * ⚠️ NEEDS LIVE VERIFICATION against a real login.
 */
export const CODEX_SCOPES =
  process.env.CODEX_OAUTH_SCOPES?.trim() || "openid profile email offline_access";

/* ------------------------------------------------------------------ *
 * OAuth: authorization-code + PKCE flow (loopback redirect, installed-app style)
 * ------------------------------------------------------------------ */

/** Build the OpenAI consent URL the user opens to sign in. */
export function buildAuthUrl(redirectUri: string, codeChallenge: string, state?: string): string {
  const params = new URLSearchParams({
    client_id: codexClientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: CODEX_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (state) params.set("state", state);
  return `${CODEX_AUTH_URL}?${params.toString()}`;
}

export interface CodexTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
}

/**
 * Exchange an authorization code for tokens. The public client sends NO
 * client_secret (OmniRoute registry `clientSecretDefault: ""`) — PKCE's
 * code_verifier is the proof instead.
 */
export async function exchangeCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  fetchFn: typeof fetch = fetch,
): Promise<CodexTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: codexClientId(),
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const res = await fetchFn(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`codex code exchange failed: HTTP ${res.status}`);
  const j = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };
  if (!j.access_token) throw new Error("codex code exchange: no access_token in response");
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    idToken: j.id_token,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
  };
}

/** Refresh an access token from a stored refresh token (public client: no secret). */
export async function refreshAccessToken(
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresAt: number }> {
  const client = new OAuth2Client({ tokenUrl: CODEX_TOKEN_URL, clientId: codexClientId(), refreshToken }, fetchFn);
  const accessToken = await client.token();
  return { accessToken, expiresAt: Date.now() + 3600 * 1000 };
}

/**
 * Best-effort extraction of the ChatGPT account id from the id_token
 * claims. The official Codex client binds requests to the account via
 * the `chatgpt-account-id` header (OmniRoute executors/codex.ts). Decoding
 * the JWT payload here is display/binding data only — no verification.
 */
export function extractAccountIdFromIdToken(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  const parts = idToken.split(".");
  if (parts.length < 2) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const id = auth?.["chatgpt_account_id"] ?? claims["chatgpt_account_id"];
    return typeof id === "string" && id.trim() ? id.trim() : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Session persistence (~/.llmswitch/sessions/codex.json, 0600)
 * ------------------------------------------------------------------ */

export const CODEX_SESSION_NAME = "codex";

export function saveCodexSession(tokens: {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  accountId?: string;
}): string {
  return saveSession({
    name: CODEX_SESSION_NAME,
    kind: "oauth-refresh",
    provider: "codex",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    accountId: tokens.accountId,
  });
}

export function loadCodexSession(): SavedSession | null {
  return loadSession(CODEX_SESSION_NAME);
}

/**
 * A currently-valid access token for the saved session: returns the stored
 * token when fresh, otherwise refreshes (and re-saves) via the stored
 * refresh token. Returns null when not logged in.
 */
export async function getValidAccessToken(
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string; accountId?: string } | null> {
  const s = loadCodexSession();
  if (!s) return null;
  if (s.accessToken && s.expiresAt && s.expiresAt > Date.now() + 60_000) {
    return { accessToken: s.accessToken, accountId: s.accountId };
  }
  if (!s.refreshToken) return null;
  const fresh = await refreshAccessToken(s.refreshToken, fetchFn);
  saveCodexSession({
    accessToken: fresh.accessToken,
    refreshToken: s.refreshToken,
    expiresAt: fresh.expiresAt,
    accountId: s.accountId,
  });
  return { accessToken: fresh.accessToken, accountId: s.accountId };
}

/**
 * Complete a login from an authorization code + the PKCE verifier used to
 * build the consent URL.
 */
export async function completeLoginWithCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  fetchFn: typeof fetch = fetch,
): Promise<SavedSession> {
  const tokens = await exchangeCode(code, redirectUri, codeVerifier, fetchFn);
  const accountId = extractAccountIdFromIdToken(tokens.idToken);
  saveCodexSession({ ...tokens, accountId });
  const saved = loadCodexSession();
  if (!saved) throw new Error("codex login: session save failed");
  return saved;
}

/**
 * Complete a login from a refresh token the user already holds (e.g.
 * exported from the Codex CLI): refresh → save.
 */
export async function loginWithRefreshToken(refreshToken: string, fetchFn: typeof fetch = fetch): Promise<SavedSession> {
  const fresh = await refreshAccessToken(refreshToken, fetchFn);
  saveCodexSession({ accessToken: fresh.accessToken, refreshToken, expiresAt: fresh.expiresAt });
  const saved = loadCodexSession();
  if (!saved) throw new Error("codex login: session save failed");
  return saved;
}

/**
 * Full loopback login (installed-app flow): starts a throwaway HTTP server
 * on 127.0.0.1, hands the consent URL (with PKCE challenge) to `onAuthUrl`,
 * waits for OpenAI to redirect back with the code, then completes login.
 */
export async function loginWithLoopback(opts: {
  onAuthUrl: (url: string) => void;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<SavedSession> {
  const { createServer } = await import("node:http");
  const { randomBytes } = await import("node:crypto");
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const state = randomBytes(16).toString("hex");
  const { codeVerifier, codeChallenge } = generatePkce();

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
      res.end(code ? "LLMSwitch: sign-in received — you can close this tab." : `LLMSwitch: sign-in failed (${err ?? "no code"}).`);
      const address = server.address() as { port: number };
      const redirectUri = `http://127.0.0.1:${address.port}/callback`;
      server.close();
      clearTimeout(timer);
      if (!code) return reject(new Error(`codex login: OAuth returned error ${err ?? "no_code"}`));
      completeLoginWithCode(code, redirectUri, codeVerifier, opts.fetchFn).then(resolve, reject);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("codex login: timed out waiting for browser sign-in"));
    }, timeoutMs);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      opts.onAuthUrl(buildAuthUrl(`http://127.0.0.1:${address.port}/callback`, codeChallenge, state));
    });
    server.on("error", reject);
  });
}
