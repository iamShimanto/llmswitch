/**
 * Zed Hosted Models — native-app RSA-keypair sign-in.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `open-sse/shared/zedAuth.ts` (createZedNativeAuthData,
 * parseZedCallbackPayload, decryptZedAccessToken, fetchZedAuthenticatedUser,
 * fetchZedLlmToken), `src/lib/oauth/constants/oauth.ts` (ZED_HOSTED_CONFIG),
 * `src/lib/oauth/providers/zed-hosted.ts`. Attribution retained per MIT.
 *
 * Zed's cloud aggregator (cloud.zed.dev) does NOT use a registered OAuth
 * client_id/secret. The flow is:
 *   1. Generate an ephemeral RSA keypair (fresh per login attempt).
 *   2. Open `https://zed.dev/native_app_signin?native_app_port=<p>&native_app_public_key=<b64>&system_id=<uuid>`
 *      in the browser; sign in with the Zed account (Zed brokers GitHub/Google).
 *   3. Zed redirects the browser to `http://127.0.0.1:<p>/?user_id=...&access_token=<redacted>
 *      where access_token is RSA-encrypted against the public key from step 1.
 *   4. Decrypt locally with the private key (never leaves the machine).
 *   5. Fetch the user profile (cloud.zed.dev/client/users/me) and a short-lived
 *      LLM token (POST /client/llm_tokens, user auth header "userId accessToken").
 *
 * The private key is held in memory for the login attempt; the session file
 * stores only userId + the (long-lived) access token.
 *
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED. Zed has no public API program for this;
 * the flow can change without notice. Use your own account and accept the risk.
 */

import { createServer } from "node:http";
import { generateKeyPairSync, privateDecrypt, randomUUID, constants } from "node:crypto";
import { loadSession, saveSession, type SavedSession } from "../sessionStore.js";

/** Endpoints (OmniRoute ZED_HOSTED_CONFIG). */
export const ZED_WEB_BASE_URL = "https://zed.dev";
export const ZED_CLOUD_BASE_URL = "https://cloud.zed.dev";
export const ZED_NATIVE_SIGNIN_PATH = "/native_app_signin";
export const ZED_USER_INFO_URL = "https://cloud.zed.dev/client/users/me";
export const ZED_LLM_TOKEN_URL = "https://cloud.zed.dev/client/llm_tokens";
export const ZED_MODELS_URL = "https://cloud.zed.dev/models";
export const ZED_COMPLETIONS_URL = "https://cloud.zed.dev/completions";
/** Default native-app port when the browser callback can't loop back to us. */
export const ZED_DEFAULT_NATIVE_APP_PORT = 58443;

export const ZED_HOSTED_SESSION_NAME = "zed-hosted";

/** Zed-specific headers the cloud aggregator understands (OmniRoute ZED_HEADERS). */
export const ZED_HEADERS = {
  clientSupportsStatus: "x-zed-client-supports-status-messages",
  clientSupportsStreamEnded: "x-zed-client-supports-stream-ended-request-completion-status",
  systemId: "x-zed-system-id",
  clientSupportsXai: "x-zed-client-supports-x-ai",
} as const;

export interface ZedNativeAuthData {
  authUrl: string;
  privateKeyPem: string;
  nativeAppPort: number;
  systemId: string;
}

/**
 * Generate a fresh RSA keypair + the zed.dev native_app_signin URL for it.
 * Ported from OmniRoute `createZedNativeAuthData`.
 */
export function createZedNativeAuthData(opts: {
  nativeAppPort?: number;
  systemId?: string;
} = {}): ZedNativeAuthData {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "der" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const nativeAppPort = Number(opts.nativeAppPort || ZED_DEFAULT_NATIVE_APP_PORT);
  const systemId = opts.systemId || randomUUID();
  const publicKeyB64 = (publicKey as unknown as Buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  const signInUrl = new URL(`${ZED_WEB_BASE_URL}${ZED_NATIVE_SIGNIN_PATH}`);
  signInUrl.searchParams.set("native_app_port", String(nativeAppPort));
  signInUrl.searchParams.set("native_app_public_key", publicKeyB64);
  signInUrl.searchParams.set("system_id", systemId);
  return {
    authUrl: signInUrl.toString(),
    privateKeyPem: privateKey as unknown as string,
    nativeAppPort,
    systemId,
  };
}

/**
 * Decrypt the RSA-encrypted access token from Zed's callback using the
 * login attempt's private key. Ported from OmniRoute
 * `decryptZedAccessToken` (OAEP-SHA256 first, PKCS1 fallback).
 */
export function decryptZedAccessToken(encryptedAccessToken: string, privateKeyPem: string): string {
  const encrypted = Buffer.from(encryptedAccessToken, "base64url");
  try {
    return privateDecrypt(
      { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      encrypted,
    ).toString("utf8");
  } catch (oaepError) {
    try {
      return privateDecrypt({ key: privateKeyPem, padding: constants.RSA_PKCS1_PADDING }, encrypted).toString("utf8");
    } catch {
      throw new Error(`zed: failed to decrypt access token: ${(oaepError as Error).message}`);
    }
  }
}

export interface ZedCallbackPayload {
  userId: string;
  encryptedAccessToken: string;
}

/**
 * Parse a pasted native-app callback (full URL, query string, or JSON).
 * Ported from OmniRoute `parseZedCallbackPayload`.
 */
export function parseZedCallbackPayload(input: string): ZedCallbackPayload {
  const raw = input.trim();
  if (!raw) throw new Error("zed: missing callback URL");
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      try {
        url = new URL(`http://127.0.0.1/?${raw.replace(/^\?/, "")}`);
      } catch {
        throw new Error("zed: invalid callback URL");
      }
    }
    url.searchParams.forEach((value, key) => {
      data[key] = value;
    });
  }
  const userId = data.user_id ?? data.userId;
  const encryptedAccessToken = data.access_token ?? data.accessToken ?? data.token;
  if (!userId || !encryptedAccessToken) {
    throw new Error("zed: callback must include user_id and access_token");
  }
  return { userId: String(userId), encryptedAccessToken: String(encryptedAccessToken) };
}

/** Fetch the authenticated user profile (for display + identity). */
export async function fetchZedUser(
  userId: string,
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ id: string; email?: string; name?: string } | null> {
  const res = await fetchFn(ZED_USER_INFO_URL, {
    headers: {
      authorization: `${userId} ${accessToken}`,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!j) return null;
  return {
    id: String(j.id ?? userId),
    email: typeof j.email === "string" ? j.email : undefined,
    name: typeof j.name === "string" ? j.name : undefined,
  };
}

/**
 * Exchange a user access token for a short-lived LLM bearer <redacted>
 * (OmniRoute zedAuth `fetchZedLlmToken`: POST /client/llm_tokens with the
 * "<userId> <accessToken>" user auth header).
 */
export async function fetchZedLlmToken(
  userId: string,
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchFn(ZED_LLM_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `${userId} ${accessToken}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`zed: LLM token exchange failed: HTTP ${res.status}`);
  const j = (await res.json().catch(() => null)) as { token?: string; llm_token?: string } | null;
  const token = j?.token ?? j?.llm_token;
  if (!token) throw new Error("zed: LLM token exchange returned no token");
  return token;
}

/* ------------------------------------------------------------------ *
 * Session persistence (~/.llmswitch/sessions/zed-hosted.json, 0600)
 * ------------------------------------------------------------------ */

export function saveZedHostedSession(tokens: {
  userId: string;
  accessToken: string;
  systemId?: string;
  email?: string;
  name?: string;
}): string {
  return saveSession({
    name: ZED_HOSTED_SESSION_NAME,
    kind: "oauth-refresh",
    provider: "zed-hosted",
    accessToken: tokens.accessToken,
    email: tokens.email,
    meta: { userId: tokens.userId, systemId: tokens.systemId, name: tokens.name, authMethod: "native_app_signin" },
  });
}

export function loadZedHostedSession(): SavedSession | null {
  return loadSession(ZED_HOSTED_SESSION_NAME);
}

export function zedSessionMeta(s: SavedSession | null): { userId?: string; systemId?: string; name?: string } {
  return (s?.meta ?? {}) as { userId?: string; systemId?: string; name?: string };
}

/**
 * Complete login from a pasted native-app callback URL using the private
 * key from this attempt's `createZedNativeAuthData`.
 */
export async function completeZedLogin(
  callbackInput: string,
  authData: ZedNativeAuthData,
  fetchFn: typeof fetch = fetch,
): Promise<SavedSession> {
  const { userId, encryptedAccessToken } = parseZedCallbackPayload(callbackInput);
  const accessToken = decryptZedAccessToken(encryptedAccessToken, authData.privateKeyPem);
  if (!accessToken) throw new Error("zed: decrypted token is empty");
  const user = await fetchZedUser(userId, accessToken, fetchFn);
  saveZedHostedSession({
    userId,
    accessToken,
    systemId: authData.systemId,
    email: user?.email,
    name: user?.name,
  });
  const saved = loadZedHostedSession();
  if (!saved) throw new Error("zed: session save failed");
  return saved;
}

/**
 * Browser loopback login: start a throwaway HTTP server on the native-app
 * port (OmniRoute "dead default port" fallback when that fails: paste).
 * Returns { authUrl, waitForCallback() } so the CLI can print the URL and
 * either await the browser callback or fall back to manual paste.
 */
export async function startZedLogin(opts: {
  nativeAppPort?: number;
  timeoutMs?: number;
}): Promise<{
  authUrl: string;
  authData: ZedNativeAuthData;
  waitForCallback: () => Promise<{ userId: string; encryptedAccessToken: string }>;
  cancel: () => void;
}> {
  const authData = createZedNativeAuthData({ nativeAppPort: opts.nativeAppPort });
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  let settle: (p: { userId: string; encryptedAccessToken: string }) => void = () => {};
  let rejectIt: (e: Error) => void = () => {};
  const done = new Promise<{ userId: string; encryptedAccessToken: string }>((resolve, reject) => {
    settle = resolve;
    rejectIt = reject;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const userId = url.searchParams.get("user_id") ?? url.searchParams.get("userId");
    const encryptedAccessToken =
      url.searchParams.get("access_token") ?? url.searchParams.get("accessToken") ?? url.searchParams.get("token");
    if (!userId || !encryptedAccessToken) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("LLMSwitch: callback missing user_id/access_token");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("LLMSwitch: Zed sign-in received — you can close this tab.");
    clearTimeout(timer);
    server.close();
    settle({ userId, encryptedAccessToken });
  });
  const timer = setTimeout(() => {
    server.close();
    rejectIt(new Error("zed: timed out waiting for browser callback — paste the callback URL instead"));
  }, timeoutMs);
  server.on("error", (err) => {
    clearTimeout(timer);
    rejectIt(err);
  });
  server.listen(authData.nativeAppPort, "127.0.0.1");
  return {
    authUrl: authData.authUrl,
    authData,
    waitForCallback: () => done,
    cancel: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}

/**
 * Paste-flow login: user opens authUrl in their browser, copies the
 * resulting `http://127.0.0.1:<port>/?user_id=...&access_token=<redacted> URL, and pastes it back.
 * Ported from OmniRoute's zed-hosted OAuthModal headless/paste fallback.
 */
export async function loginZedWithPastedCallback(
  callbackInput: string,
  authData: ZedNativeAuthData,
  fetchFn: typeof fetch = fetch,
): Promise<SavedSession> {
  return completeZedLogin(callbackInput, authData, fetchFn);
}
