/**
 * OAuth/token-import session credentials for the P11-I providers
 * (codebuddy-cn, codebuddy-intl, workbuddy, grok-cli, openference,
 * gitlab-duo, agy, devin-desktop).
 *
 * Mirrors the convention the web-session pack writes:
 * ~/.llmswitch/sessions/<id>.json (0600), plus per-provider env overrides
 * (<ID>_ACCESS_TOKEN). Tokens are resolved at call time; stale tokens are
 * refreshed via each protocol's refresh endpoint before the call.
 *
 * Refresh shapes were ported from OmniRoute (MIT, release v3.8.53) — exact
 * field names carry a NEEDS LIVE VERIFICATION note where OmniRoute's code
 * did not show them.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const P11I_PROVIDER_IDS = [
  "codebuddy-cn",
  "codebuddy-intl",
  "workbuddy",
  "grok-cli",
  "openference",
  "gitlab-duo",
  "agy",
  "devin-desktop",
] as const;

export type P11IProviderId = (typeof P11I_PROVIDER_IDS)[number];

function envPrefix(id: string): string {
  return id.replace(/[^a-z0-9]/gi, "_").toUpperCase();
}

export function sessionFilePath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.LLMSWITCH_SESSIONS_DIR ?? (env.DATA_DIR ? join(env.DATA_DIR, "sessions") : join(homedir(), ".llmswitch", "sessions"));
  return join(dir, `${id}.json`);
}

/**
 * Session file for one ACCOUNT of a provider (multi-account).
 * No accountId -> the default account file (`<id>.json`); with one ->
 * `<id>--<accountId>.json` alongside it.
 */
/**
 * On-disk session file base name for a provider — usually the provider
 * id, except GitHub Copilot whose executor predates the id convention.
 */
export function sessionBaseName(providerId: string): string {
  if (providerId === "github") return "github-copilot";
  return providerId;
}

/**
 * Run a login completion that persists to the provider's DEFAULT session
 * file, but adopt the result as a NEW DB account instead: any existing
 * default session is stashed first and restored afterwards, so adding an
 * account never clobbers the default one.
 */
export async function completeAsAccount<T>(
  store: { addAccount: (input: { providerId: string; label: string; kind: "api_key" | "session" }) => { id: string } },
  providerId: string,
  sessionName: string,
  label: string,
  doComplete: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ result: T; accountId: string | null }> {
  const { renameSync } = await import("node:fs");
  const defFile = sessionFilePath(sessionName, env);
  const stash = `${defFile}.stash-${Math.random().toString(36).slice(2, 8)}`;
  const hadDefault = existsSync(defFile);
  if (hadDefault) renameSync(defFile, stash);
  try {
    const result = await doComplete();
    let accountId: string | null = null;
    if (existsSync(defFile)) {
      const acct = store.addAccount({ providerId, label, kind: "session" });
      renameSync(defFile, accountSessionFilePath(sessionName, acct.id, env));
      accountId = acct.id;
    }
    return { result, accountId };
  } finally {
    if (hadDefault && existsSync(stash)) {
      try {
        renameSync(stash, defFile);
      } catch {
        /* best effort */
      }
    }
  }
}

export function accountSessionFilePath(
  id: string,
  accountId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = env.LLMSWITCH_SESSIONS_DIR ?? (env.DATA_DIR ? join(env.DATA_DIR, "sessions") : join(homedir(), ".llmswitch", "sessions"));
  return join(dir, accountId ? `${id}--${accountId}.json` : `${id}.json`);
}

interface StoredSession {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  meta?: Record<string, unknown>;
  email?: string;
}

export function readStoredSession(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): StoredSession | null {
  try {
    const p = accountId ? accountSessionFilePath(id, accountId, env) : sessionFilePath(id, env);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as StoredSession;
  } catch {
    return null;
  }
}

/** True when an env token or a login session exists (sync). */
export function hasProviderSession(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): boolean {
  if (!accountId && (env[`${envPrefix(id)}_ACCESS_TOKEN`] ?? "").trim()) return true;
  return existsSync(accountId ? accountSessionFilePath(id, accountId, env) : sessionFilePath(id, env));
}

export function hasCodebuddyCnCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasProviderSession("codebuddy-cn", env);
}
export function hasCodebuddyIntlCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasProviderSession("codebuddy-intl", env);
}
export function hasWorkbuddyCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasProviderSession("workbuddy", env);
}
export function hasGrokCliCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasProviderSession("grok-cli", env);
}
export function hasOpenferenceCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasProviderSession("openference", env);
}
export function hasGitlabDuoCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasProviderSession("gitlab-duo", env);
}
export function hasAgyCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasProviderSession("agy", env);
}
export function hasDevinDesktopCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasProviderSession("devin-desktop", env);
}

export interface ResolvedOAuthCreds {
  accessToken: string;
  refreshToken?: string;
  meta?: Record<string, unknown>;
  email?: string;
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, fetchFn: typeof fetch, id: string) {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${id} token refresh failed: HTTP ${res.status}`);
  return { res, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/**
 * Refresh a stored refresh token. ⚠️ NEEDS LIVE VERIFICATION for the exact
 * request-body field names on the Tencent plugin-auth endpoints.
 */
export async function refreshProviderToken(
  id: P11IProviderId,
  refreshToken: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; meta?: Record<string, unknown> }> {
  const form = (url: string, params: Record<string, string>) =>
    fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000),
    });

  switch (id) {
    case "codebuddy-cn":
    case "codebuddy-intl":
    case "workbuddy": {
      const base = id === "codebuddy-cn" ? "https://copilot.tencent.com" : id === "codebuddy-intl" ? "https://www.codebuddy.ai" : "https://www.workbuddy.ai";
      const { res, json } = await postJson(
        `${base}/v2/plugin/auth/token/refresh`,
        { refreshToken, refresh_token: refreshToken },
        { "X-Product": "SaaS" },
        fetchFn,
        id,
      );
      const data = (json?.data ?? json) as Record<string, unknown> | null;
      const accessToken =
        res.headers.get("x-refresh-token") ||
        (typeof data?.accessToken === "string" ? data.accessToken : null) ||
        (typeof data?.access_token === "string" ? data.access_token : null) ||
        (typeof data?.token === "string" ? data.token : null);
      if (!accessToken) throw new Error(`${id} token refresh: no token in response`);
      const rt = typeof data?.refreshToken === "string" ? data.refreshToken : refreshToken;
      const exp = typeof data?.expiresIn === "number" ? data.expiresIn : id === "workbuddy" ? 31_104_000 : 86_400;
      return { accessToken, refreshToken: rt, expiresAt: Date.now() + exp * 1000 };
    }
    case "grok-cli": {
      const res = await form("https://auth.x.ai/oauth2/token", {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: (env.GROK_OAUTH_CLIENT_ID ?? "").trim() || "b1a00492-073a-47ea-816f-4c329264a828",
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || typeof j.access_token !== "string") throw new Error(`grok-cli token refresh failed: HTTP ${res.status}`);
      return {
        accessToken: j.access_token,
        refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : refreshToken,
        expiresAt: Date.now() + (typeof j.expires_in === "number" ? j.expires_in : 3600) * 1000,
      };
    }
    case "openference": {
      const res = await form("https://openference.com/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: (env.OPENFERENCE_OAUTH_CLIENT_ID ?? "").trim() || "omniroute",
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || typeof j.access_token !== "string") throw new Error(`openference token refresh failed: HTTP ${res.status}`);
      return {
        accessToken: j.access_token,
        refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : refreshToken,
        expiresAt: Date.now() + (typeof j.expires_in === "number" ? j.expires_in : 3600) * 1000,
      };
    }
    case "gitlab-duo": {
      const base = (env.GITLAB_DUO_BASE_URL || env.GITLAB_BASE_URL || "https://gitlab.com").trim().replace(/\/$/, "");
      const res = await form(`${base}/oauth/token`, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: (env.GITLAB_DUO_OAUTH_CLIENT_ID || env.GITLAB_OAUTH_CLIENT_ID || "").trim(),
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || typeof j.access_token !== "string") throw new Error(`gitlab-duo token refresh failed: HTTP ${res.status}`);
      return {
        accessToken: j.access_token,
        refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : refreshToken,
        expiresAt: Date.now() + (typeof j.expires_in === "number" ? j.expires_in : 7200) * 1000,
      };
    }
    case "agy":
    case "devin-desktop": {
      // agy: same Google refresh as antigravity; devin-desktop tokens are
      // long-lived imports with no refresh flow — refreshed here is a no-op
      // marker. agy is handled through the antigravity executor's own refresh
      // (see executor/antigravity.ts); this branch is unreachable in practice.
      throw new Error(`${id} has no refresh flow in core`);
    }
  }
}

/** Persist refreshed tokens back to the session file (0600, best-effort). */
export function persistRefreshedSession(id: string, creds: ResolvedOAuthCreds, env: NodeJS.ProcessEnv = process.env, accountId?: string | null): void {
  try {
    const existing = readStoredSession(id, env, accountId) ?? {};
    const file = accountId ? accountSessionFilePath(id, accountId, env) : sessionFilePath(id, env);
    writeFileSync(
      file,
      JSON.stringify({ ...existing, accessToken: creds.accessToken, refreshToken: creds.refreshToken }, null, 2),
    );
    chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
}

/** Resolve a usable access token: env first, then session (fresh or refreshed). */
export async function resolveProviderToken(
  id: P11IProviderId,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
  accountId?: string | null,
): Promise<ResolvedOAuthCreds> {
  const envToken = (env[`${envPrefix(id)}_ACCESS_TOKEN`] ?? "").trim();
  if (envToken && !accountId) return { accessToken: envToken };
  const stored = readStoredSession(id, env, accountId);
  if (stored?.accessToken && stored.expiresAt && stored.expiresAt > Date.now() + 60_000) {
    return { accessToken: stored.accessToken, refreshToken: stored.refreshToken, meta: stored.meta, email: stored.email };
  }
  if (!stored?.refreshToken) {
    throw new Error(`${id}: no session — run: llmswitch login ${id}`);
  }
  const fresh = await refreshProviderToken(id, stored.refreshToken, env, fetchFn);
  const creds: ResolvedOAuthCreds = { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, meta: stored.meta, email: stored.email };
  persistRefreshedSession(id, creds, env, accountId);
  return creds;
}
