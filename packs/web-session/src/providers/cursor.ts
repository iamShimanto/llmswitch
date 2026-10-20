/**
 * Cursor IDE — deep-control PKCE login + refresh + IDE token import.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `src/lib/oauth/constants/oauth.ts` (CURSOR_CONFIG),
 * `src/lib/oauth/services/cursorLogin.ts` (deep-control PKCE: loginDeepControl
 * + auth/poll), `open-sse/services/tokenRefresh/providers/cursor.ts`
 * (auth/exchange_user_api_key refresh), `src/lib/oauth/providers/cursor.ts`
 * (import_token mapTokens). Attribution retained per MIT.
 *
 * What OmniRoute calls "deep-control" is the official Cursor
 * (loginDeepControl) standalone OAuth flow — no IDE needed. It also supports
 * importing tokens from the Cursor IDE's own SQLite store (`state.vscdb`
 * keys cursorAuth/accessToken, cursorAuth/refreshToken).
 *
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED. Cursor has no public API program;
 * api2.cursor.sh endpoints and the deep-control flow can change without
 * notice. Use your own account and accept the risk.
 */

import { randomBytes, randomUUID, createHash } from "node:crypto";
import { loadSession, saveSession, type SavedSession } from "../sessionStore.js";

/** Endpoints (OmniRoute CURSOR_CONFIG). */
export const CURSOR_API_ENDPOINT = "https://api2.cursor.sh";
export const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
export const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
export const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
/** The protobuf Connect-RPC chat path (OmniRoute registry cursor entry). */
export const CURSOR_CHAT_PATH = "/aiserver.v1.ChatService/StreamUnifiedChatWithTools";

export const CURSOR_SESSION_NAME = "cursor";

/* ------------------------------------------------------------------ *
 * PKCE helpers (OmniRoute `generatePKCE` convention: S256).
 * ------------------------------------------------------------------ */

export interface CursorPkce {
  codeVerifier: string;
  codeChallenge: string;
  uuid: string;
  loginUrl: string;
}

/** Generate PKCE params + the deep-control login URL (challenge only — never the verifier). */
export function generateCursorAuthParams(): CursorPkce {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const uuid = randomUUID();
  const params = new URLSearchParams({
    challenge: codeChallenge,
    uuid,
    mode: "login",
    redirectTarget: "cli",
  });
  return { codeVerifier, codeChallenge, uuid, loginUrl: `${CURSOR_LOGIN_URL}?${params.toString()}` };
}

/* ------------------------------------------------------------------ *
 * Deep-control poll: 404 = still pending, 200 = { accessToken, refreshToken }.
 * Ported from OmniRoute `pollCursorAuthOnce`.
 * ------------------------------------------------------------------ */

export type CursorPollResult =
  | { status: "pending" }
  | { status: "ok"; accessToken: string; refreshToken: string }
  | { status: "error"; message: string };

export async function pollCursorAuthOnce(
  uuid: string,
  verifier: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CursorPollResult> {
  const url = `${CURSOR_POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`;
  let res: Response;
  try {
    res = await fetchFn(url, { signal });
  } catch (err) {
    return { status: "error", message: `cursor auth poll network error: ${(err as Error).message}` };
  }
  if (res.status === 404) return { status: "pending" };
  if (!res.ok) return { status: "error", message: `cursor auth poll failed: HTTP ${res.status}` };
  const data = (await res.json().catch(() => null)) as { accessToken?: string; refreshToken?: string } | null;
  if (!data?.accessToken || !data.refreshToken) {
    return { status: "error", message: "cursor auth response missing tokens" };
  }
  return { status: "ok", accessToken: data.accessToken, refreshToken: data.refreshToken };
}

/* ------------------------------------------------------------------ *
 * Refresh: Bearer <refreshToken> + JSON body {} at exchange_user_api_key
 * (OmniRoute `open-sse/services/tokenRefresh/providers/cursor.ts`).
 * ------------------------------------------------------------------ */

const REFRESH_TIMEOUT_MS = 15_000;
const FALLBACK_TTL_MS = 3_600_000;

function jwtExpiryMs(token: string): number {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return Date.now() + FALLBACK_TTL_MS;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as { exp?: unknown };
    if (typeof payload.exp === "number") return payload.exp * 1000 - 5 * 60_000;
  } catch {
    /* ignore */
  }
  return Date.now() + FALLBACK_TTL_MS;
}

export interface CursorTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export async function refreshCursorToken(
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<CursorTokens> {
  const res = await fetchFn(CURSOR_REFRESH_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${refreshToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`cursor token refresh failed: HTTP ${res.status} — re-run: llmswitch login cursor`);
  const j = (await res.json().catch(() => null)) as {
    accessToken?: string; refreshToken?: string; token?: string;
  } | null;
  // OmniRoute tolerates both `accessToken` and a bare `token` field.
  const accessToken = j?.accessToken ?? j?.token;
  if (!accessToken) throw new Error("cursor token refresh: no access token in response");
  return {
    accessToken,
    refreshToken: j?.refreshToken ?? refreshToken,
    expiresAt: jwtExpiryMs(accessToken),
  };
}

/* ------------------------------------------------------------------ *
 * Session persistence (~/.llmswitch/sessions/cursor.json, 0600)
 * ------------------------------------------------------------------ */

export function saveCursorSession(tokens: {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number;
  machineId?: string;
  email?: string;
  authMethod?: string;
}): string {
  return saveSession({
    name: CURSOR_SESSION_NAME,
    kind: "oauth-refresh",
    provider: "cursor",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? undefined,
    expiresAt: tokens.expiresAt,
    email: tokens.email,
    meta: {
      ...(tokens.machineId ? { machineId: tokens.machineId } : {}),
      authMethod: tokens.authMethod ?? (tokens.refreshToken ? "deep_control" : "imported"),
    },
  });
}

export function cursorSessionMeta(s: SavedSession | null): { machineId?: string; authMethod?: string } {
  const meta = (s?.meta ?? {}) as { machineId?: string; authMethod?: string };
  return { machineId: meta.machineId, authMethod: meta.authMethod };
}

export function loadCursorSession(): SavedSession | null {
  return loadSession(CURSOR_SESSION_NAME);
}

/** Identity helpers (OmniRoute `credentialsFromCursorTokens`): sub/email from JWT. */
export function cursorJwtIdentity(token: string): { accountId?: string; email?: string } {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return {};
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as {
      sub?: unknown; email?: unknown;
    };
    const out: { accountId?: string; email?: string } = {};
    if (typeof payload.sub === "string" && payload.sub) out.accountId = payload.sub;
    if (typeof payload.sub === "number" && Number.isSafeInteger(payload.sub)) out.accountId = String(payload.sub);
    if (typeof payload.email === "string" && payload.email) out.email = payload.email.toLowerCase();
    return out;
  } catch {
    return {};
  }
}

/** A valid access token for the saved session (refreshes when expired). */
export async function getValidCursorAccessToken(
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string; machineId?: string } | null> {
  const s = loadCursorSession();
  if (!s?.accessToken) return null;
  const meta = cursorSessionMeta(s);
  if (!s.expiresAt || s.expiresAt > Date.now() + 60_000) {
    return { accessToken: s.accessToken, machineId: meta.machineId };
  }
  if (!s.refreshToken) return null;
  const fresh = await refreshCursorToken(s.refreshToken, fetchFn);
  saveCursorSession({
    accessToken: fresh.accessToken,
    refreshToken: fresh.refreshToken,
    expiresAt: fresh.expiresAt,
    machineId: meta.machineId,
    email: s.email,
    authMethod: meta.authMethod,
  });
  return { accessToken: fresh.accessToken, machineId: meta.machineId };
}

/**
 * Import tokens the user already holds (e.g. from the Cursor IDE's
 * state.vscdb: keys `cursorAuth/accessToken`, `cursorAuth/refreshToken`,
 * `storage.serviceMachineId`, or pasted from a browser flow).
 */
export async function importCursorTokens(
  accessToken: string,
  refreshToken: string | null | undefined,
  machineId?: string,
  fetchFn: typeof fetch = fetch,
): Promise<SavedSession> {
  if (!accessToken.trim()) throw new Error("cursor import: access token is required");
  const identity = cursorJwtIdentity(accessToken);
  // Best-effort refresh to get a fresh expiry timestamp (non-fatal).
  let expiresAt: number | undefined;
  if (refreshToken) {
    try {
      const fresh = await refreshCursorToken(refreshToken, fetchFn);
      saveCursorSession({
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        expiresAt: fresh.expiresAt,
        machineId,
        email: identity.email,
        authMethod: "imported",
      });
    } catch {
      expiresAt = jwtExpiryMs(accessToken);
      saveCursorSession({ accessToken, refreshToken, expiresAt, machineId, email: identity.email, authMethod: "imported" });
    }
  } else {
    expiresAt = jwtExpiryMs(accessToken);
    saveCursorSession({ accessToken, refreshToken, expiresAt, machineId, email: identity.email, authMethod: "imported" });
  }
  const saved = loadCursorSession();
  if (!saved) throw new Error("cursor import: session save failed");
  return saved;
}

/**
 * Deep-control browser login loop: returns the login URL for the user,
 * then polls until they complete sign-in (or the timeout expires).
 * OmniRoute equivalent: /api/oauth/cursor/login/start → /poll.
 */
export async function loginCursorWithBrowser(opts: {
  onAuthUrl: (url: string) => void;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SavedSession> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const params = generateCursorAuthParams();
  opts.onAuthUrl(params.loginUrl);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error("cursor login: timed out waiting for browser sign-in");
    const result = await pollCursorAuthOnce(params.uuid, params.codeVerifier, fetchFn);
    if (result.status === "ok") {
      const identity = cursorJwtIdentity(result.accessToken);
      saveCursorSession({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: jwtExpiryMs(result.accessToken),
        email: identity.email,
        authMethod: "deep_control",
      });
      const saved = loadCursorSession();
      if (!saved) throw new Error("cursor login: session save failed");
      return saved;
    }
    if (result.status === "error") throw new Error(`cursor login: ${result.message}`);
    await sleep(pollIntervalMs);
  }
}
