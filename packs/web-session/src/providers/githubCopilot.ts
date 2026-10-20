/**
 * GitHub Copilot + GitHub Enterprise Copilot — OAuth device-flow login,
 * Copilot token exchange, and refresh.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53):
 *   - `open-sse/config/providers/registry/github/index.ts` and
 *     `.../registry/ghe-copilot/index.ts` (OAuth client ids, models)
 *   - `src/lib/oauth/constants/oauth.ts` (GITHUB_CONFIG / GHE_COPILOT_CONFIG:
 *     device-code/token endpoints, scope "read:user",
 *     copilot_internal/v2/token)
 *   - `src/lib/oauth/providers/github.ts` (device-code request shape,
 *     postExchange copilot token + user info)
 *   - `src/lib/oauth/providers/ghe-copilot.ts` (per-GHE-host derived
 *     endpoints: {host}/login/device/code, {host}/login/oauth/access_token,
 *     {host}/api/v3/copilot_internal/v2/token, {host}/api/v3/user)
 *   - `open-sse/executors/github.ts` (refreshCredentials: refresh Copilot
 *     token with `Authorization: token <github-token>`, fall back to
 *     refresh_token grant with client_id and no secret; 5-min expiry margin)
 *   - `open-sse/config/providerHeaderProfiles.ts`
 *     (getGitHubCopilotChatHeaders / getGitHubCopilotRefreshHeaders —
 *     the @github/copilot CLI 1.0.88 inference header capture)
 *   - `open-sse/utils/publicCreds.ts` (`github_copilot_id` decoded below)
 * Attribution retained per MIT.
 *
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED. This impersonates the @github/copilot
 * CLI's OAuth client and chat headers against GitHub's Copilot API. It is
 * NOT GitHub-supported: GitHub may block the client, revoke tokens, or
 * change the API at any time; it may violate GitHub's Terms of Service.
 * Use your own GitHub account and accept the risk.
 */
import { DeviceFlowClient } from "../deviceFlow.js";
import {
  loadSession,
  saveSession,
  type SavedSession,
} from "../sessionStore.js";

/* ------------------------------------------------------------------ *
 * OAuth client credentials.
 *
 * GitHub Copilot is a PUBLIC device-flow OAuth client: it has a public
 * client_id but NO client_secret (OmniRoute's registry entry documents
 * this — refresh requests carry client_id only). The default is the
 * @github/copilot CLI's own client id, shipped inside its public app
 * (OAuth client credentials for native apps are public by design —
 * they identify the app, not a user). Override with env vars:
 *   GITHUB_OAUTH_CLIENT_ID / GHE_COPILOT_OAUTH_CLIENT_ID
 * ------------------------------------------------------------------ */
export const GITHUB_COPILOT_PUBLIC_CLIENT_ID = "Iv1.b507a08c87ecfe98";

export function githubCopilotClientId(
  env: NodeJS.ProcessEnv = process.env,
  kind: "github" | "ghe" = "github",
): string {
  if (kind === "ghe") {
    return (
      env.GHE_COPILOT_OAUTH_CLIENT_ID?.trim() ||
      env.GITHUB_OAUTH_CLIENT_ID?.trim() ||
      GITHUB_COPILOT_PUBLIC_CLIENT_ID
    );
  }
  return env.GITHUB_OAUTH_CLIENT_ID?.trim() || GITHUB_COPILOT_PUBLIC_CLIENT_ID;
}

/** Device-flow scope (OmniRoute GITHUB_CONFIG / GHE_COPILOT_CONFIG). */
export const GITHUB_COPILOT_SCOPE = "read:user";

/** GitHub OAuth endpoints (OmniRoute OAUTH_ENDPOINTS.github). */
export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_USER_INFO_URL = "https://api.github.com/user";
export const GITHUB_COPILOT_TOKEN_URL =
  "https://api.github.com/copilot_internal/v2/token";

/** Copilot API (OmniRoute github registry baseUrl). */
export const GITHUB_COPILOT_CHAT_BASE_URL = "https://api.githubcopilot.com";

/** Session file names (~/.llmswitch/sessions/<name>.json, 0600). */
export const GITHUB_COPILOT_SESSION_NAME = "github-copilot";
export const GHE_COPILOT_SESSION_NAME = "ghe-copilot";

export type CopilotKind = "github" | "ghe";

export interface CopilotEndpoints {
  deviceCodeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  copilotTokenUrl: string;
}

/**
 * Endpoint set for the Copilot cluster. GitHub.com is static; GHE hosts
 * derive everything from the enterprise host (OmniRoute ghe-copilot provider).
 */
export function copilotEndpoints(kind: CopilotKind, gheHost?: string): CopilotEndpoints {
  if (kind === "github") {
    return {
      deviceCodeUrl: GITHUB_DEVICE_CODE_URL,
      tokenUrl: GITHUB_TOKEN_URL,
      userInfoUrl: GITHUB_USER_INFO_URL,
      copilotTokenUrl: GITHUB_COPILOT_TOKEN_URL,
    };
  }
  const host = (gheHost ?? "").trim().replace(/\/+$/, "");
  if (!host) {
    throw new Error(
      "ghe-copilot: no GitHub Enterprise host — pass --ghe <host> (e.g. llmswitch login copilot --ghe https://ghe.example.com)",
    );
  }
  return {
    deviceCodeUrl: `${host}/login/device/code`,
    tokenUrl: `${host}/login/oauth/access_token`,
    userInfoUrl: `${host}/api/v3/user`,
    copilotTokenUrl: `${host}/api/v3/copilot_internal/v2/token`,
  };
}

/** CLI version pinned to OmniRoute's GITHUB_COPILOT_CLI_VERSION (env override). */
export function copilotCliVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.GITHUB_COPILOT_CLI_VERSION?.trim() || "1.0.91";
}

/** OmniRoute GITHUB_COPILOT_API_VERSION. */
export const COPILOT_API_VERSION = "2026-08-01";

/* ------------------------------------------------------------------ *
 * Client fingerprint — ported from OmniRoute's
 * getGitHubCopilotChatHeaders / getGitHubCopilotRefreshHeaders, which
 * follow a live @github/copilot CLI 1.0.88 inference capture. The
 * copilot-integration-id (copilot-developer-cli) is the catalog-unlock
 * lever; x-client-machine-id is the CLI's per-install device fingerprint.
 * ------------------------------------------------------------------ */
export const COPILOT_INTEGRATION_ID = "copilot-developer-cli";
export const COPILOT_OPENAI_INTENT = "conversation-agent";
export const COPILOT_INTERACTION_TYPE = "conversation-user";
export const COPILOT_HARNESS_ID = "copilot-sdk";

function runtimePlatform(): string {
  return typeof process !== "undefined" ? process.platform : "linux";
}

export function copilotMachineId(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GITHUB_COPILOT_MACHINE_ID?.trim();
  if (override) return override;
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/** Chat/inference headers (the CLI's exact set — OpenAI-wire POSTs). */
export function buildCopilotChatHeaders(
  copilotToken: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { vision?: boolean; initiator?: string } = {},
): Record<string, string> {
  const v = copilotCliVersion(env);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${copilotToken}`,
    "copilot-integration-id": COPILOT_INTEGRATION_ID,
    "editor-version": `copilot/${v}`,
    "user-agent": `copilot/${v} (${runtimePlatform()}) term/unknown`,
    "openai-intent": COPILOT_OPENAI_INTENT,
    "x-interaction-type": COPILOT_INTERACTION_TYPE,
    "copilot-harness-id": COPILOT_HARNESS_ID,
    "x-github-api-version": COPILOT_API_VERSION,
    "x-client-machine-id": copilotMachineId(env),
    "X-Initiator": opts.initiator ?? "user",
    accept: "application/json",
    "content-type": "application/json",
  };
  if (opts.vision) headers["copilot-vision-request"] = "true";
  return headers;
}

/** Token-exchange headers (api.github.com/copilot_internal/v2/token). */
export function buildCopilotRefreshHeaders(
  githubAccessToken: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const v = copilotCliVersion(env);
  return {
    "Authorization": `token ${githubAccessToken}`,
    accept: "application/json",
    "User-Agent": "GithubCopilot/1.0",
    "Editor-Version": `copilot/${v}`,
    "Editor-Plugin-Version": `copilot/${v}`,
  };
}

export interface CopilotToken {
  /** short-lived copilot token (Bearer) */
  token: string;
  /** expiry, epoch ms */
  expiresAt: number;
  /** per-account API host from the exchange (endpoints.api) */
  apiUrl?: string;
  /** proxy host (endpoints.proxy) */
  proxyUrl?: string;
}

/**
 * Exchange a GitHub OAuth token for a short-lived Copilot token
 * (OmniRoute executors/github.ts refreshCopilotToken). Returns null when
 * GitHub rejects the exchange.
 */
export async function exchangeCopilotToken(
  githubAccessToken: string,
  endpoints: CopilotEndpoints,
  fetchFn: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CopilotToken | null> {
  const res = await fetchFn(endpoints.copilotTokenUrl, {
    method: "GET",
    headers: buildCopilotRefreshHeaders(githubAccessToken, env),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    token?: string;
    expires_at?: number;
    endpoints?: { api?: string; proxy?: string };
  };
  if (!j.token) return null;
  // expires_at is unix seconds; treat values already in ms safely.
  const expiresAt =
    typeof j.expires_at === "number" && j.expires_at > 0
      ? (j.expires_at < 1e12 ? j.expires_at * 1000 : j.expires_at)
      : Date.now() + 30 * 60 * 1000;
  return {
    token: j.token,
    expiresAt,
    apiUrl: j.endpoints?.api,
    proxyUrl: j.endpoints?.proxy,
  };
}

/**
 * Refresh the GitHub OAuth token via the refresh_token grant. Copilot is a
 * public client: send the public client_id, and NEVER a missing client_secret
 * (OmniRoute executors/github.ts refreshGitHubToken, port of 9router#442).
 */
export async function refreshGitHubAccessToken(
  refreshToken: string,
  endpoints: CopilotEndpoints,
  fetchFn: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  kind: CopilotKind = "github",
): Promise<{ accessToken: string; refreshToken: string; expiresIn?: number } | null> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: githubCopilotClientId(env, kind),
  });
  params.set("refresh_token", refreshToken);
  const res = await fetchFn(endpoints.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!j.access_token) return null;
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? refreshToken,
    expiresIn: j.expires_in,
  };
}

/** Typed error so callers can point users at the login command. */
export class CopilotLoginRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopilotLoginRequiredError";
  }
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000; // OmniRoute's 5-min expiry margin

/** True when the saved copilot token still has ≥5 minutes of life. */
export function copilotTokenFresh(s: SavedSession, now = Date.now()): boolean {
  return !!s.copilotToken && !!s.copilotTokenExpiresAt && s.copilotTokenExpiresAt - now >= REFRESH_MARGIN_MS;
}

export function sessionNameFor(kind: CopilotKind): string {
  return kind === "ghe" ? GHE_COPILOT_SESSION_NAME : GITHUB_COPILOT_SESSION_NAME;
}

/**
 * OmniRoute refreshCredentials semantics against the pack's session file:
 * try the Copilot exchange with the stored GitHub token; on failure use
 * the refresh_token grant to get a fresh GitHub token and exchange that.
 * Updates the session file in place and returns the usable copilot token.
 */
export async function refreshCopilotToken(
  kind: CopilotKind,
  fetchFn: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CopilotToken & { email?: string; apiUrl?: string }> {
  const name = sessionNameFor(kind);
  const saved = loadSession(name);
  if (!saved) {
    throw new CopilotLoginRequiredError(
      `${name}: no session — run: llmswitch login ${kind === "ghe" ? "ghe-copilot" : "copilot"}`,
    );
  }
  if (copilotTokenFresh(saved)) {
    return {
      token: saved.copilotToken!,
      expiresAt: saved.copilotTokenExpiresAt!,
      email: saved.email,
      apiUrl: saved.copilotApiUrl,
    };
  }
  const endpoints = copilotEndpoints(kind, saved.gheHost);
  let githubToken = saved.accessToken;
  let refreshToken = saved.refreshToken;
  let exchanged = githubToken ? await exchangeCopilotToken(githubToken, endpoints, fetchFn, env) : null;

  if (!exchanged && refreshToken) {
    const fresh = await refreshGitHubAccessToken(refreshToken, endpoints, fetchFn, env, kind);
    if (fresh) {
      githubToken = fresh.accessToken;
      refreshToken = fresh.refreshToken;
      exchanged = await exchangeCopilotToken(githubToken, endpoints, fetchFn, env);
    }
  }
  if (!exchanged || !githubToken) {
    throw new CopilotLoginRequiredError(
      `${name}: tokens expired and could not refresh — re-run: llmswitch login ${kind === "ghe" ? "ghe-copilot" : "copilot"}`,
    );
  }
  saveSession({
    ...saved,
    name,
    kind: saved.kind,
    provider: saved.provider,
    accessToken: githubToken,
    refreshToken,
    expiresAt: saved.expiresAt,
    copilotToken: exchanged.token,
    copilotTokenExpiresAt: exchanged.expiresAt,
    copilotApiUrl: exchanged.apiUrl ?? saved.copilotApiUrl,
    gheHost: saved.gheHost,
    email: saved.email,
  });
  return { ...exchanged, email: saved.email, apiUrl: exchanged.apiUrl ?? saved.copilotApiUrl };
}

/**
 * Fetch the GitHub account for display (OmniRoute postExchange userInfo).
 * Optional — a failing lookup leaves the session usable.
 */
export async function fetchCopilotAccount(
  githubAccessToken: string,
  endpoints: CopilotEndpoints,
  fetchFn: typeof fetch = fetch,
): Promise<{ login?: string; email?: string }> {
  try {
    const res = await fetchFn(endpoints.userInfoUrl, {
      headers: {
        "Authorization": `Bearer ${githubAccessToken}`,
        accept: "application/json",
        "X-GitHub-Api-Version": COPILOT_API_VERSION,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return {};
    const j = (await res.json()) as { login?: string; email?: string };
    return { login: j.login, email: j.email };
  } catch {
    return {};
  }
}

/** Save the post-login session to disk (0600). */
export function saveCopilotSession(opts: {
  kind: CopilotKind;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  copilotToken: string;
  copilotTokenExpiresAt: number;
  copilotApiUrl?: string;
  gheHost?: string;
  email?: string;
  login?: string;
}): SavedSession {
  const name = sessionNameFor(opts.kind);
  const s: Omit<SavedSession, "savedAt"> = {
    name,
    kind: "oauth-device",
    provider: opts.kind === "ghe" ? "ghe-copilot" : "github",
    accessToken: opts.accessToken,
    refreshToken: opts.refreshToken,
    expiresAt: opts.expiresIn ? Date.now() + opts.expiresIn * 1000 : undefined,
    copilotToken: opts.copilotToken,
    copilotTokenExpiresAt: opts.copilotTokenExpiresAt,
    copilotApiUrl: opts.copilotApiUrl,
    gheHost: opts.gheHost,
    email: opts.email,
  };
  const path = saveSession(s);
  void path;
  return { ...s, savedAt: Date.now() };
}

/**
 * Full device-flow login (RFC 8628) — no API key copy-paste needed.
 * The caller shows user_code + verification_uri to the user, then this
 * polls until approval, exchanges the Copilot token, and saves everything.
 */
export async function loginWithDeviceFlow(opts: {
  kind: CopilotKind;
  gheHost?: string;
  onCode: (userCode: string, verificationUri: string) => void;
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): Promise<SavedSession> {
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetchFn ?? fetch;
  const endpoints = copilotEndpoints(opts.kind, opts.gheHost);
  const client = new DeviceFlowClient(
    {
      deviceAuthUrl: endpoints.deviceCodeUrl,
      tokenUrl: endpoints.tokenUrl,
      clientId: githubCopilotClientId(env, opts.kind),
      scope: GITHUB_COPILOT_SCOPE,
    },
    fetchFn,
  );
  const d = await client.start();
  opts.onCode(d.user_code, d.verification_uri_complete ?? d.verification_uri);
  const t = await client.poll(d.device_code, { intervalSec: d.interval });
  const exchanged = await exchangeCopilotToken(t.access_token, endpoints, fetchFn, env);
  if (!exchanged) {
    throw new CopilotLoginRequiredError(
      "copilot token exchange failed — the account may not have an active GitHub Copilot subscription",
    );
  }
  const account = await fetchCopilotAccount(t.access_token, endpoints, fetchFn);
  return saveCopilotSession({
    kind: opts.kind,
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresIn: t.expires_in,
    copilotToken: exchanged.token,
    copilotTokenExpiresAt: exchanged.expiresAt,
    copilotApiUrl: exchanged.apiUrl,
    gheHost: opts.gheHost?.trim().replace(/\/+$/, "") || undefined,
    email: account.email,
    login: account.login,
  });
}
