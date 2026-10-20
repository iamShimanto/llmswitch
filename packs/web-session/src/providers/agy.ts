/**
 * `agy` — the official Antigravity CLI's OAuth identity.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `src/lib/oauth/providers/agy.ts` (`AGY_CONFIG`) and
 * `open-sse/config/agyModels.ts`. Attribution retained per MIT.
 *
 * OmniRoute's `AGY_CONFIG` confirms `agy` authenticates against the EXACT same
 * Google consumer-OAuth client as the `antigravity` provider (the client_id
 * was verified byte-for-byte identical) and the same Code Assist backend —
 * it is a different CLIENT IDENTITY ("cli" headers) + a CLI-scoped model
 * catalog over the identical backend, not a separate login protocol.
 *
 * So `agy` REUSES the antigravity OAuth functions from ./antigravity.js and
 * stores its session under its own name (`agy.json`) so the two surfaces
 * don't fight over the same refresh token.
 * ⚠️ Same UNOFFICIAL / REVERSE-ENGINEERED warnings as antigravity apply.
 */
import {
  buildAuthUrl,
  completeLoginWithCode,
  fetchAccountEmail,
  refreshAccessToken,
  ensureProjectId,
} from "./antigravity.js";
import { loadSession, saveSession, type SavedSession } from "../sessionStore.js";

export const AGY_SESSION_NAME = "agy";

/** Re-export the shared consent-URL builder (identical client + scopes). */
export { buildAuthUrl as buildAgyAuthUrl };

/** Persist tokens + project under the agy session name. */
export function saveAgySession(tokens: {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  projectId?: string | null;
  email?: string;
}): string {
  return saveSession({
    name: AGY_SESSION_NAME,
    kind: "oauth-refresh",
    provider: "agy",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    projectId: tokens.projectId ?? undefined,
    email: tokens.email,
  });
}

export function loadAgySession(): SavedSession | null {
  return loadSession(AGY_SESSION_NAME);
}

/**
 * Import a refresh token you already hold (same Google OAuth client as
 * antigravity): refresh → bootstrap project → save under `agy`.
 */
export async function loginAgyWithRefreshToken(
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<SavedSession> {
  const fresh = await refreshAccessToken(refreshToken, fetchFn);
  const projectId = await ensureProjectId(fresh.accessToken, fetchFn).catch(() => null);
  const email = await fetchAccountEmail(fresh.accessToken, fetchFn);
  saveAgySession({ accessToken: fresh.accessToken, refreshToken, expiresAt: fresh.expiresAt, projectId, email });
  const saved = loadAgySession();
  if (!saved) throw new Error("agy login: session save failed");
  return saved;
}

/** Complete an `agy` login from an authorization code (loopback flow hands this the code). */
export async function completeAgyLoginWithCode(
  code: string,
  redirectUri: string,
  fetchFn: typeof fetch = fetch,
): Promise<SavedSession> {
  await completeLoginWithCode(code, redirectUri, fetchFn); // completes + saves "antigravity"
  const fromAntigravity = loadSession("antigravity");
  if (!fromAntigravity) throw new Error("agy login: completion failed");
  saveAgySession({
    accessToken: fromAntigravity.accessToken ?? "",
    refreshToken: fromAntigravity.refreshToken,
    expiresAt: fromAntigravity.expiresAt ?? Date.now() + 3_600_000,
    projectId: fromAntigravity.projectId,
    email: fromAntigravity.email,
  });
  const saved = loadAgySession();
  if (!saved) throw new Error("agy login: session save failed");
  return saved;
}

/**
 * Full loopback login: consent URL → wait for Google's redirect with the
 * code → complete. Saves the session under `agy`.
 */
export async function loginAgyWithLoopback(opts: {
  onAuthUrl: (url: string) => void;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<SavedSession> {
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
      if (!code) return reject(new Error(`agy login: Google returned error ${err ?? "no_code"}`));
      completeAgyLoginWithCode(code, redirectUri, opts.fetchFn).then(resolve, reject);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("agy login: timed out waiting for browser sign-in"));
    }, timeoutMs);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      opts.onAuthUrl(buildAuthUrl(`http://127.0.0.1:${address.port}/callback`, state));
    });
    server.on("error", reject);
  });
}

/**
 * A currently-valid access token from the `agy` session: fresh token when
 * available, otherwise refreshes via the stored refresh token using the
 * shared Google refresh path. Null when not logged in.
 */
export async function getValidAgyAccessToken(fetchFn: typeof fetch = fetch): Promise<{
  accessToken: string;
  projectId?: string;
  email?: string;
} | null> {
  const s = loadAgySession();
  if (!s) return null;
  if (s.accessToken && s.expiresAt && s.expiresAt > Date.now() + 60_000) {
    return { accessToken: s.accessToken, projectId: s.projectId, email: s.email };
  }
  if (!s.refreshToken) return null;
  const fresh = await refreshAccessToken(s.refreshToken, fetchFn);
  saveAgySession({
    accessToken: fresh.accessToken,
    refreshToken: s.refreshToken,
    expiresAt: fresh.expiresAt,
    projectId: s.projectId,
    email: s.email,
  });
  return { accessToken: fresh.accessToken, projectId: s.projectId, email: s.email };
}
