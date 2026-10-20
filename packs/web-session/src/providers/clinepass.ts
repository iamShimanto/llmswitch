/**
 * ClinePass (Cline's $9.99/mo gateway at cline.bot) — OAuth via Cline's own
 * auth API + direct BYOK API-key import (dual auth).
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `src/lib/oauth/providers/cline.ts` (authorization_code
 * flow: buildAuthUrl + exchangeToken), `open-sse/services/tokenRefresh/providers/cline.ts`
 * (refresh shape), `open-sse/config/providers/registry/clinepass/index.ts`
 * (endpoints, models, forceStream, extra headers), `src/shared/constants/providers/oauth.ts`
 * (clinepass authHint). Attribution retained per MIT.
 *
 * Flow: authorize at `https://api.cline.bot/api/v1/auth/authorize` with
 * `client_type=extension&callback_url=<uri>&redirect_uri=<uri>`. After the
 * user signs in with their Cline account, the "code" that comes back is
 * base64-encoded JSON already containing the tokens (no server round-trip
 * needed) — OmniRoute falls back to POST /api/v1/auth/token when the
 * code is a real authorization code. Refresh: POST /api/v1/auth/refresh
 * `{refreshToken, grantType: "refresh_token", clientType: "extension"}`.
 *
 * BYOK: users can also paste a direct API key instead of OAuth.
 *
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED. Cline can change the auth API without
 * notice. Use your own account and accept the risk.
 */

import { loadSession, saveSession, type SavedSession } from "../sessionStore.js";

/** Endpoints (OmniRoute registry clinepass.oauth + clinepassModels). */
export const CLINEPASS_AUTHORIZE_URL = "https://api.cline.bot/api/v1/auth/authorize";
export const CLINEPASS_TOKEN_URL = "https://api.cline.bot/api/v1/auth/token";
export const CLINEPASS_REFRESH_URL = "https://api.cline.bot/api/v1/auth/refresh";
export const CLINEPASS_CHAT_URL = "https://api.cline.bot/api/v1/chat/completions";
export const CLINEPASS_MODELS_URL = "https://api.cline.bot/api/v1/models";
/** Extra headers OmniRoute sends on chat calls (registry extraHeaders). */
export const CLINEPASS_EXTRA_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://cline.bot",
  "X-Title": "Cline",
};

export const CLINEPASS_SESSION_NAME = "clinepass";

export interface ClinePassTokens {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number;
  email?: string;
  name?: string;
}

/** Build the Cline authorize URL (OmniRoute `buildAuthUrl`: client_type=extension). */
export function buildClinePassAuthUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    client_type: "extension",
    callback_url: redirectUri,
    redirect_uri: redirectUri,
  });
  return `${CLINEPASS_AUTHORIZE_URL}?${params.toString()}`;
}

interface DecodedClineCode {
  access_token?: string; accessToken?: string;
  refresh_token?: string; refreshToken?: string;
  email?: string; firstName?: string; lastName?: string;
  expiresAt?: string; expires_at?: string;
}

/**
 * Try to decode Cline's "code" as base64-encoded JSON containing tokens.
 * OmniRoute: the code is the token payload; the last `}` in the decoded
 * string bounds the JSON (callback wrappers may append garbage).
 * Returns null when the code is a real authorization code instead.
 */
export function decodeClinePassCode(code: string): DecodedClineCode | null {
  let base64 = code;
  try {
    base64 = decodeURIComponent(base64);
  } catch {
    /* already decoded */
  }
  try {
    const padding = 4 - (base64.length % 4);
    if (padding !== 4) base64 += "=".repeat(padding);
    const decoded = Buffer.from(base64, "base64").toString("utf-8");
    const lastBrace = decoded.lastIndexOf("}");
    if (lastBrace === -1) return null;
    const jsonStr = decoded.substring(0, lastBrace + 1);
    const tokenData = JSON.parse(jsonStr) as DecodedClineCode;
    if (tokenData.access_token || tokenData.accessToken) return tokenData;
    return null;
  } catch {
    return null;
  }
}

/** Exchange an authorization code (decode first, else POST token exchange). */
export async function exchangeClinePassCode(
  code: string,
  redirectUri: string,
  fetchFn: typeof fetch = fetch,
): Promise<ClinePassTokens> {
  const decoded = decodeClinePassCode(code);
  if (decoded) {
    return {
      accessToken: (decoded.access_token ?? decoded.accessToken)!,
      refreshToken: decoded.refresh_token ?? decoded.refreshToken,
      expiresAt: decoded.expiresAt ? Date.parse(decoded.expiresAt) : decoded.expires_at ? Date.parse(decoded.expires_at) : undefined,
      email: decoded.email,
      name: [decoded.firstName, decoded.lastName].filter(Boolean).join(" ") || undefined,
    };
  }
  const res = await fetchFn(CLINEPASS_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_type: "extension",
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`clinepass token exchange failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    access_token?: string; accessToken?: string; refresh_token?: string; refreshToken?: string;
    expires_at?: string; expiresAt?: string; data?: { userInfo?: { email?: string } };
  };
  const inner = (data as Record<string, unknown>).data as Record<string, unknown> | undefined;
  const accessToken = data.access_token ?? data.accessToken;
  if (!accessToken) throw new Error("clinepass token exchange: no access token in response");
  return {
    accessToken,
    refreshToken: data.refresh_token ?? data.refreshToken,
    expiresAt: (data.expires_at ?? data.expiresAt) ? Date.parse(String(data.expires_at ?? data.expiresAt)) : undefined,
    email: (inner?.userInfo as { email?: string } | undefined)?.email,
  };
}

/** Refresh: POST {refreshToken, grantType: "refresh_token", clientType: "extension"} (OmniRoute refreshClineToken). */
export async function refreshClinePassToken(
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<ClinePassTokens> {
  const res = await fetchFn(CLINEPASS_REFRESH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ refreshToken, grantType: "refresh_token", clientType: "extension" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`clinepass token refresh failed: HTTP ${res.status} — re-run: llmswitch login clinepass`);
  const payload = (await res.json()) as Record<string, unknown>;
  const data = ((payload?.data as Record<string, unknown>) || payload) as {
    accessToken?: string; access_token?: string; refreshToken?: string; refresh_token?: string;
    expiresAt?: string; expires_at?: string; userInfo?: { email?: string };
  };
  const accessToken = data.accessToken ?? data.access_token;
  if (!accessToken) throw new Error("clinepass token refresh: no access token in response");
  return {
    accessToken,
    refreshToken: data.refreshToken ?? data.refresh_token ?? refreshToken,
    expiresAt: data.expiresAt ? Date.parse(data.expiresAt) : data.expires_at ? Date.parse(data.expires_at) : undefined,
    email: data.userInfo?.email,
  };
}

/* ------------------------------------------------------------------ *
 * Session persistence (~/.llmswitch/sessions/clinepass.json, 0600)
 * ------------------------------------------------------------------ */

export function saveClinePassSession(tokens: ClinePassTokens, byok = false): string {
  return saveSession({
    name: CLINEPASS_SESSION_NAME,
    kind: byok ? "token-import" : "oauth-refresh",
    provider: "clinepass",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? undefined,
    expiresAt: tokens.expiresAt,
    email: tokens.email,
    meta: {
      authMethod: byok ? "byok" : "oauth",
      ...(tokens.name ? { name: tokens.name } : {}),
    },
  });
}

export function loadClinePassSession(): SavedSession | null {
  return loadSession(CLINEPASS_SESSION_NAME);
}

export function isClinePassByok(s: SavedSession | null): boolean {
  return (s?.meta as { authMethod?: string } | undefined)?.authMethod === "byok";
}

/** Import a direct BYOK API key (dual-auth path from the registry comment). */
export async function importClinePassKey(apiKey: string): Promise<SavedSession> {
  if (!apiKey.trim()) throw new Error("clinepass import: an API key is required");
  saveClinePassSession({ accessToken: apiKey.trim() }, true);
  const saved = loadClinePassSession();
  if (!saved) throw new Error("clinepass import: session save failed");
  return saved;
}

/** Valid access token (OAuth refresh when possible; BYOK tokens don't refresh). */
export async function getValidClinePassAccessToken(
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string } | null> {
  const s = loadClinePassSession();
  if (!s?.accessToken) return null;
  if (isClinePassByok(s)) return { accessToken: s.accessToken };
  if (!s.expiresAt || s.expiresAt > Date.now() + 60_000) return { accessToken: s.accessToken };
  if (!s.refreshToken) return { accessToken: s.accessToken };
  const fresh = await refreshClinePassToken(s.refreshToken, fetchFn);
  saveClinePassSession({ ...fresh, email: fresh.email ?? s.email });
  return { accessToken: fresh.accessToken };
}

/**
 * Browser loopback login: starts a throwaway HTTP server, hands the
 * authorize URL to onAuthUrl, waits for Cline's callback with the code.
 */
export async function loginClinePassWithBrowser(opts: {
  onAuthUrl: (url: string) => void;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<SavedSession> {
  const { createServer } = await import("node:http");
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const fetchFn = opts.fetchFn ?? fetch;

  return new Promise<SavedSession>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const code = url.searchParams.get("code") ?? url.searchParams.get("token");
      const err = url.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(code ? "LLMSwitch: Cline sign-in received — you can close this tab." : `LLMSwitch: sign-in failed (${err ?? "no code"}).`);
      const address = server.address() as { port: number };
      const redirectUri = `http://127.0.0.1:${address.port}/callback`;
      server.close();
      clearTimeout(timer);
      if (!code) return reject(new Error(`clinepass login: callback returned error ${err ?? "no_code"}`));
      exchangeClinePassCode(code, redirectUri, fetchFn)
        .then((tokens) => {
          saveClinePassSession(tokens);
          const saved = loadClinePassSession();
          if (!saved) throw new Error("clinepass login: session save failed");
          resolve(saved);
        })
        .catch(reject);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("clinepass login: timed out waiting for browser sign-in"));
    }, timeoutMs);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      opts.onAuthUrl(buildClinePassAuthUrl(`http://127.0.0.1:${address.port}/callback`));
    });
    server.on("error", reject);
  });
}
