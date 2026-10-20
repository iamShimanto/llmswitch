/**
 * Openference OAuth (Authorization Code + PKCE, loopback redirect).
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `src/lib/oauth/providers/openference.ts` and
 * `OPENFERENCE_CONFIG` in `src/lib/oauth/constants/oauth.ts`.
 * Attribution retained per MIT.
 *
 * Public PKCE client (no secret). The client_id is decoded from OmniRoute's
 * `open-sse/utils/publicCreds.ts` (`openference_id`) — literally the string
 * "omniroute", which is what OmniRoute embeds; override via env var
 * OPENFERENCE_OAUTH_CLIENT_ID if your deployment registered its own client.
 *
 * Inference endpoint: https://api.openference.com/v1 (OpenAI-compatible);
 * access tokens are ES256 JWTs accepted as Bearer.
 * ⚠️ Live verification needs a real Openference account login.
 */

import { generatePkce } from "../oauth2.js";
import { loadSession, saveSession, type SavedSession } from "../sessionStore.js";

/* Public PKCE client id (OmniRoute publicCreds.ts `openference_id`, XOR-decoded). */
export const OPENFERENCE_PUBLIC_CLIENT_ID = "omniroute";

export function openferenceClientId(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENFERENCE_OAUTH_CLIENT_ID?.trim() || OPENFERENCE_PUBLIC_CLIENT_ID;
}

export const OPENFERENCE_AUTHORIZE_URL = "https://openference.com/app/oauth/authorize";
export const OPENFERENCE_TOKEN_URL = "https://openference.com/oauth/token";
export const OPENFERENCE_USERINFO_URL = "https://openference.com/oauth/userinfo";
export const OPENFERENCE_SCOPE = "openid profile email model:invoke offline_access";
export const OPENFERENCE_LOOPBACK_PORT = 56123;
export const OPENFERENCE_CALLBACK_PATH = "/callback";

export function buildOpenferenceAuthUrl(redirectUri: string, state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: openferenceClientId(),
    redirect_uri: redirectUri,
    scope: OPENFERENCE_SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${OPENFERENCE_AUTHORIZE_URL}?${params.toString()}`;
}

export interface OpenferenceTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
}

export async function exchangeOpenferenceCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  fetchFn: typeof fetch = fetch,
): Promise<OpenferenceTokens> {
  const res = await fetchFn(OPENFERENCE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: openferenceClientId(),
      code_verifier: codeVerifier,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    throw new Error(`openference code exchange failed: HTTP ${res.status}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    idToken: typeof data.id_token === "string" ? data.id_token : undefined,
    expiresAt: Date.now() + (typeof data.expires_in === "number" ? data.expires_in : 3600) * 1000,
  };
}

export async function refreshOpenferenceToken(refreshToken: string, fetchFn: typeof fetch = fetch): Promise<OpenferenceTokens> {
  const res = await fetchFn(OPENFERENCE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: openferenceClientId(),
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    throw new Error(`openference token refresh failed: HTTP ${res.status}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : refreshToken,
    idToken: typeof data.id_token === "string" ? data.id_token : undefined,
    expiresAt: Date.now() + (typeof data.expires_in === "number" ? data.expires_in : 3600) * 1000,
  };
}

/** Extract display identity from an id_token JWT payload (OmniRoute decodeOpenferenceIdTokenIdentity). */
export function decodeOpenferenceIdTokenIdentity(idToken: unknown): { email: string | null; name: string | null } {
  if (typeof idToken !== "string") return { email: null, name: null };
  const parts = idToken.split(".");
  if (parts.length !== 3) return { email: null, name: null };
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const email = typeof payload.email === "string" ? payload.email : typeof payload.preferred_username === "string" ? payload.preferred_username : null;
    const name = typeof payload.name === "string" ? payload.name : null;
    return { email, name };
  } catch {
    return { email: null, name: null };
  }
}

export function saveOpenferenceSession(tokens: OpenferenceTokens & { email?: string }): SavedSession {
  saveSession({
    name: "openference",
    kind: "oauth-refresh",
    provider: "openference",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    email: tokens.email ?? decodeOpenferenceIdTokenIdentity(tokens.idToken).email ?? undefined,
  });
  const saved = loadSession("openference");
  if (!saved) throw new Error("openference login: session save failed");
  return saved;
}

export function loadOpenferenceSession(): SavedSession | null {
  return loadSession("openference");
}

/**
 * Full loopback login (installed-app flow): fixed port 56123 /callback on
 * 127.0.0.1 (the redirect the public client was registered with, per
 * OmniRoute), PKCE S256.
 */
export async function loginOpenferenceWithLoopback(opts: {
  onAuthUrl: (url: string) => void;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<SavedSession> {
  const { createServer } = await import("node:http");
  const { randomBytes } = await import("node:crypto");
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const state = randomBytes(16).toString("hex");
  const pkce = generatePkce();
  const redirectUri = `http://127.0.0.1:${OPENFERENCE_LOOPBACK_PORT}${OPENFERENCE_CALLBACK_PATH}`;

  return new Promise<SavedSession>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== OPENFERENCE_CALLBACK_PATH) {
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
      res.end(code ? "LLMSwitch: Openference sign-in received — you can close this tab." : `LLMSwitch: sign-in failed (${err ?? "no code"}).`);
      server.close();
      clearTimeout(timer);
      if (!code) return reject(new Error(`openference login: provider returned error ${err ?? "no_code"}`));
      exchangeOpenferenceCode(code, redirectUri, pkce.codeVerifier, opts.fetchFn)
        .then((tokens) => resolve(saveOpenferenceSession(tokens)))
        .catch(reject);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("openference login: timed out waiting for browser sign-in"));
    }, timeoutMs);
    server.listen(OPENFERENCE_LOOPBACK_PORT, "127.0.0.1", () => {
      opts.onAuthUrl(buildOpenferenceAuthUrl(redirectUri, state, pkce.codeChallenge));
    });
    server.on("error", reject);
  });
}
