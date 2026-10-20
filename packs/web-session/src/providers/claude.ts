/**
 * Claude OAuth provider — login for the Anthropic Claude Code OAuth client.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53):
 *  - `open-sse/config/providers/registry/claude/index.ts` (authType oauth,
 *    authHeader x-api-key, baseUrl https://api.anthropic.com/v1/messages,
 *    urlSuffix ?beta=true, oauth tokenUrl, public client id)
 *  - `open-sse/config/anthropicHeaders.ts` (ANTHROPIC_VERSION_HEADER,
 *    ANTHROPIC_BETA_CLAUDE_OAUTH)
 *  - `open-sse/utils/publicCreds.ts` (`claude_id` — the Claude Code CLI's
 *    public OAuth client id; public native-app creds identify the app, not
 *    a user)
 *  - `open-sse/config/constants.ts` (OAUTH_ENDPOINTS.anthropic)
 *
 * ⚠️ UNOFFICIAL. Claude's OAuth is intended for the Claude Code CLI with a
 * subscription account; routing other traffic through it may violate
 * Anthropic's Terms of Service — use your own account and accept the risk.
 * Flow is auth code + PKCE against Anthropic's OAuth endpoints; tokens are
 * sent to api.anthropic.com in the `x-api-key` header (like the CLI) with
 * the oauth beta flags, NOT a console API key.
 *
 * ⚠️ LIVE VERIFICATION STILL NEEDED: OmniRoute's code pins the OAuth
 * endpoints and client id, but NOT a scope list — CLAUDE_SCOPES below is
 * the well-known Claude Code scope set, env-overridable, and must be
 * confirmed against a real login.
 */

import { generatePkce, OAuth2Client } from "../oauth2.js";
import { loadSession, saveSession, type SavedSession } from "../sessionStore.js";

/* ------------------------------------------------------------------ *
 * OAuth client credentials.
 * ------------------------------------------------------------------ */

/** The Claude Code CLI's public OAuth client id (OmniRoute publicCreds `claude_id`). */
export const CLAUDE_PUBLIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export function claudeClientId(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_OAUTH_CLIENT_ID?.trim() || CLAUDE_PUBLIC_CLIENT_ID;
}

/** Consent page host (env-overridable). NOTE: the authorize page lives on
 * claude.ai — api.anthropic.com/v1/oauth/authorize returns Anthropic's
 * 404 not_found_error (verified live 2026-10-20 from a user report). Only
 * the token endpoint lives on api.anthropic.com. */
export const CLAUDE_AUTH_URL =
  process.env.CLAUDE_OAUTH_AUTH_URL?.trim() || "https://claude.ai/oauth/authorize";
/** OmniRoute registry claude oauth.tokenUrl (env-overridable). */
export const CLAUDE_TOKEN_URL =
  process.env.CLAUDE_OAUTH_TOKEN_URL?.trim() || "https://api.anthropic.com/v1/oauth/token";

/**
 * OAuth scopes. OmniRoute does not pin a scope list in the files ported
 * from; this is the well-known Claude Code scope set.
 * ⚠️ NEEDS LIVE VERIFICATION against a real login.
 */
export const CLAUDE_SCOPES =
  process.env.CLAUDE_OAUTH_SCOPES?.trim() || "org:create_api_key user:profile user:inference";

/* ------------------------------------------------------------------ *
 * OAuth: authorization-code + PKCE flow (loopback redirect, installed-app style)
 * ------------------------------------------------------------------ */

/** Build the Anthropic consent URL the user opens to sign in. */
export function buildAuthUrl(redirectUri: string, codeChallenge: string, state?: string): string {
  const params = new URLSearchParams({
    client_id: claudeClientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: CLAUDE_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (state) params.set("state", state);
  return `${CLAUDE_AUTH_URL}?${params.toString()}`;
}

export interface ClaudeTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

/**
 * Exchange an authorization code for tokens. The public client has no
 * client_secret — PKCE's code_verifier is the proof instead.
 */
export async function exchangeCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  fetchFn: typeof fetch = fetch,
): Promise<ClaudeTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: claudeClientId(),
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const res = await fetchFn(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`claude code exchange failed: HTTP ${res.status}`);
  const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("claude code exchange: no access_token in response");
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
  };
}

/** Refresh an access token from a stored refresh token (public client: no secret). */
export async function refreshAccessToken(
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresAt: number }> {
  const client = new OAuth2Client({ tokenUrl: CLAUDE_TOKEN_URL, clientId: claudeClientId(), refreshToken }, fetchFn);
  const accessToken = await client.token();
  return { accessToken, expiresAt: Date.now() + 3600 * 1000 };
}

/* ------------------------------------------------------------------ *
 * Session persistence (~/.llmswitch/sessions/claude.json, 0600)
 * ------------------------------------------------------------------ */

export const CLAUDE_SESSION_NAME = "claude";

export function saveClaudeSession(tokens: {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email?: string;
}): string {
  return saveSession({
    name: CLAUDE_SESSION_NAME,
    kind: "oauth-refresh",
    provider: "claude",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    email: tokens.email,
  });
}

export function loadClaudeSession(): SavedSession | null {
  return loadSession(CLAUDE_SESSION_NAME);
}

/** Best-effort email lookup from the userinfo endpoint (display only). */
export async function fetchAccountEmail(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchFn("https://api.anthropic.com/v1/oauth/userinfo", {
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

/**
 * A currently-valid access token for the saved session: returns the stored
 * token when fresh, otherwise refreshes (and re-saves) via the stored
 * refresh token. Returns null when not logged in.
 */
export async function getValidAccessToken(
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string; email?: string } | null> {
  const s = loadClaudeSession();
  if (!s) return null;
  if (s.accessToken && s.expiresAt && s.expiresAt > Date.now() + 60_000) {
    return { accessToken: s.accessToken, email: s.email };
  }
  if (!s.refreshToken) return null;
  const fresh = await refreshAccessToken(s.refreshToken, fetchFn);
  saveClaudeSession({ accessToken: fresh.accessToken, refreshToken: s.refreshToken, expiresAt: fresh.expiresAt, email: s.email });
  return { accessToken: fresh.accessToken, email: s.email };
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
  const email = await fetchAccountEmail(tokens.accessToken, fetchFn);
  saveClaudeSession({ ...tokens, email });
  const saved = loadClaudeSession();
  if (!saved) throw new Error("claude login: session save failed");
  return saved;
}

/**
 * Complete a login from a refresh token the user already holds (e.g.
 * exported from Claude Code's local credentials): refresh → save.
 */
export async function loginWithRefreshToken(refreshToken: string, fetchFn: typeof fetch = fetch): Promise<SavedSession> {
  const fresh = await refreshAccessToken(refreshToken, fetchFn);
  const email = await fetchAccountEmail(fresh.accessToken, fetchFn);
  saveClaudeSession({ accessToken: fresh.accessToken, refreshToken, expiresAt: fresh.expiresAt, email });
  const saved = loadClaudeSession();
  if (!saved) throw new Error("claude login: session save failed");
  return saved;
}

/**
 * Full loopback login (installed-app flow): starts a throwaway HTTP server
 * on 127.0.0.1, hands the consent URL (with PKCE challenge) to `onAuthUrl`,
 * waits for Anthropic to redirect back with the code, then completes login.
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
      if (!code) return reject(new Error(`claude login: OAuth returned error ${err ?? "no_code"}`));
      completeLoginWithCode(code, redirectUri, codeVerifier, opts.fetchFn).then(resolve, reject);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("claude login: timed out waiting for browser sign-in"));
    }, timeoutMs);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      opts.onAuthUrl(buildAuthUrl(`http://127.0.0.1:${address.port}/callback`, codeChallenge, state));
    });
    server.on("error", reject);
  });
}
