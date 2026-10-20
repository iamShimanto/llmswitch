/**
 * GitLab Duo OAuth (Authorization Code + PKCE).
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `src/lib/oauth/providers/gitlab-duo.ts` and
 * `src/lib/oauth/gitlab.ts`. Attribution retained per MIT.
 *
 * ⚠️ OPERATOR-REGISTERED CLIENT: unlike most OAuth providers here, GitLab Duo
 * has NO embedded public client id (OmniRoute requires one too — see the
 * `#3861` comment in the ported module). You must register an OAuth app on
 * GitLab (User Settings → Applications, scopes: `ai_features read_user`) and
 * set GITLAB_DUO_OAUTH_CLIENT_ID (+ optional GITLAB_DUO_OAUTH_CLIENT_SECRET).
 * Self-managed instances: point GITLAB_DUO_BASE_URL / GITLAB_BASE_URL at the
 * host (defaults to https://gitlab.com).
 *
 * After exchange, the user's email is read from /api/v4/user and an optional
 * `direct_access` grant is minted (POST /api/v4/code_suggestions/direct_access)
 * so chat calls can ride the AI-gateway direct path; the direct grant is
 * best-effort at login and retried by the executor later.
 *
 * ⚠️ Live verification needs a real GitLab login with the client id above.
 */

import { generatePkce } from "../oauth2.js";
import { loadSession, saveSession, type SavedSession } from "../sessionStore.js";

export const GITLAB_DUO_SCOPE = "ai_features read_user";
export const GITLAB_DUO_LOOPBACK_PORT = 56124;
export const GITLAB_DUO_CALLBACK_PATH = "/callback";

export function gitlabBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.GITLAB_DUO_BASE_URL || env.GITLAB_BASE_URL || "https://gitlab.com").trim();
  return raw.replace(/\/$/, "");
}

/** Mirror OmniRoute: empty client id → clear "configure it" error instead of an opaque 500. */
export function gitlabClientId(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GITLAB_DUO_OAUTH_CLIENT_ID || env.GITLAB_OAUTH_CLIENT_ID || "").trim();
}

export function gitlabClientSecret(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GITLAB_DUO_OAUTH_CLIENT_SECRET || env.GITLAB_OAUTH_CLIENT_SECRET || "").trim();
}

export function gitlabEndpoints(base?: string) {
  const root = (base ?? gitlabBase()).replace(/\/$/, "");
  return {
    root,
    authorizeUrl: `${root}/oauth/authorize`,
    tokenUrl: `${root}/oauth/token`,
    userUrl: `${root}/api/v4/user`,
    directAccessUrl: `${root}/api/v4/code_suggestions/direct_access`,
    publicCompletionsUrl: `${root}/api/v4/code_suggestions/completions`,
  };
}

export function buildGitLabAuthUrl(redirectUri: string, state: string, codeChallenge: string, env: NodeJS.ProcessEnv = process.env): string {
  const clientId = gitlabClientId(env);
  if (!clientId) throw new Error("gitlab-duo: no OAuth client id — set GITLAB_DUO_OAUTH_CLIENT_ID (register an OAuth app on GitLab with scopes 'ai_features read_user')");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    scope: GITLAB_DUO_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${gitlabEndpoints(gitlabBase(env)).authorizeUrl}?${params.toString()}`;
}

export interface GitLabTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export async function exchangeGitLabCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<GitLabTokens> {
  const body = new URLSearchParams({
    client_id: gitlabClientId(env),
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const secret = gitlabClientSecret(env);
  if (secret) body.set("client_secret", secret);
  const res = await fetchFn(gitlabEndpoints(gitlabBase(env)).tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    throw new Error(`gitlab-duo token exchange failed: HTTP ${res.status}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expiresAt: Date.now() + (typeof data.expires_in === "number" ? data.expires_in : 7200) * 1000,
  };
}

export async function refreshGitLabToken(
  refreshToken: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<GitLabTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: gitlabClientId(env),
  });
  const secret = gitlabClientSecret(env);
  if (secret) body.set("client_secret", secret);
  const res = await fetchFn(gitlabEndpoints(gitlabBase(env)).tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    throw new Error(`gitlab-duo token refresh failed: HTTP ${res.status}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : refreshToken,
    expiresAt: Date.now() + (typeof data.expires_in === "number" ? data.expires_in : 7200) * 1000,
  };
}

export interface GitLabDirectAccess {
  token: string;
  baseUrl: string;
  headers: Record<string, string>;
  expiresAt: string | null;
}

function parseGitLabDirectAccess(payload: unknown, root: string): GitLabDirectAccess | null {
  const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (!data) return null;
  const token = typeof data.token === "string" ? data.token.trim() : "";
  const baseUrl = typeof data.base_url === "string" ? data.base_url.trim() : "";
  if (!token || !baseUrl) return null;
  const headers: Record<string, string> = {};
  const rawHeaders = data.headers && typeof data.headers === "object" ? (data.headers as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (typeof k === "string" && typeof v === "string") headers[k] = v;
  }
  void root;
  return {
    token,
    baseUrl,
    headers,
    expiresAt: typeof data.expires_at === "number" ? new Date(data.expires_at * 1000).toISOString() : null,
  };
}

/** Best-effort post-exchange enrichment: /api/v4/user + optional direct_access grant. */
export async function postExchangeGitLab(
  accessToken: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<{ email?: string; username?: string; directAccess: GitLabDirectAccess | null }> {
  const endpoints = gitlabEndpoints(gitlabBase(env));
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  let email: string | undefined;
  let username: string | undefined;
  try {
    const userRes = await fetchFn(endpoints.userUrl, { headers, signal: AbortSignal.timeout(15_000) });
    if (userRes.ok) {
      const user = (await userRes.json()) as Record<string, unknown>;
      if (typeof user.email === "string" && user.email) email = user.email;
      if (typeof user.username === "string" && user.username) username = user.username;
    }
  } catch {
    /* identity is optional at login */
  }
  let directAccess: GitLabDirectAccess | null = null;
  try {
    const daRes = await fetchFn(endpoints.directAccessUrl, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (daRes.ok) directAccess = parseGitLabDirectAccess(await daRes.json(), endpoints.root);
  } catch {
    /* executor retries later */
  }
  return { email, username, directAccess };
}

export function saveGitLabSession(tokens: GitLabTokens, extra: { email?: string; username?: string; directAccess?: GitLabDirectAccess | null } = {}): SavedSession {
  saveSession({
    name: "gitlab-duo",
    kind: "oauth-refresh",
    provider: "gitlab-duo",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    email: extra.email,
    meta: {
      baseUrl: gitlabBase(),
      gitlabUsername: extra.username,
      ...(extra.directAccess ? { gitlabDirectAccess: extra.directAccess } : {}),
    },
  });
  const saved = loadSession("gitlab-duo");
  if (!saved) throw new Error("gitlab-duo login: session save failed");
  return saved;
}

export function loadGitLabSession(): SavedSession | null {
  return loadSession("gitlab-duo");
}

/** Full loopback login (PKCE S256, fixed local port). Throws early without a client id. */
export async function loginGitLabWithLoopback(opts: {
  onAuthUrl: (url: string) => void;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}): Promise<SavedSession> {
  const env = opts.env ?? process.env;
  const { createServer } = await import("node:http");
  const { randomBytes } = await import("node:crypto");
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const state = randomBytes(16).toString("hex");
  const pkce = generatePkce();
  const redirectUri = `http://127.0.0.1:${GITLAB_DUO_LOOPBACK_PORT}${GITLAB_DUO_CALLBACK_PATH}`;
  const authUrl = buildGitLabAuthUrl(redirectUri, state, pkce.codeChallenge, env); // throws without client id

  return new Promise<SavedSession>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== GITLAB_DUO_CALLBACK_PATH) {
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
      res.end(code ? "LLMSwitch: GitLab sign-in received — you can close this tab." : `LLMSwitch: sign-in failed (${err ?? "no code"}).`);
      server.close();
      clearTimeout(timer);
      if (!code) return reject(new Error(`gitlab-duo login: provider returned error ${err ?? "no_code"}`));
      (async () => {
        const tokens = await exchangeGitLabCode(code, redirectUri, pkce.codeVerifier, env, opts.fetchFn);
        const extra = await postExchangeGitLab(tokens.accessToken, env, opts.fetchFn);
        resolve(saveGitLabSession(tokens, extra));
      })().catch(reject);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("gitlab-duo login: timed out waiting for browser sign-in"));
    }, timeoutMs);
    server.listen(GITLAB_DUO_LOOPBACK_PORT, "127.0.0.1", () => opts.onAuthUrl(authUrl));
    server.on("error", reject);
  });
}
