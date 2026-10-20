/**
 * Trae (ByteDance SOLO) — Cloud-IDE-JWT token IMPORT. There is no OAuth flow.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `src/lib/oauth/constants/oauth.ts` (TRAE_CONFIG),
 * `src/lib/oauth/providers/trae.ts` (flowType: "import_token"),
 * `src/shared/constants/providers/oauth.ts` (authHint), and
 * `open-sse/executors/trae.ts` (wire). Attribution retained per MIT.
 *
 * OmniRoute is explicit about this provider: "ByteDance has not published
 * a public OAuth client_id/secret or a device-code flow for third-party
 * integrations." The credential is the **Cloud-IDE-JWT** the Trae web
 * client sends as `Authorization: Cloud-IDE-JWT <token>` (RS256, ~14-day
 * lifetime), captured by signing in at solo.trae.ai / work.trae.ai and
 * copying the token, then pasting it here. There is NO refresh — when it
 * expires (~14 days) the user re-pastes a fresh one.
 *
 * Identity fields the SOLO remote agent expects (web_id / biz_user_id /
 * user_unique_id / scope / tenant / region) ride along in session meta.
 */

import { loadSession, saveSession, type SavedSession } from "../sessionStore.js";

/** Upstream (OmniRoute TRAE_CONFIG.soloApiEndpoint / registry baseUrl). */
export const TRAE_API_BASE_URL = "https://core-normal.trae.ai/api/remote/v1";
export const TRAE_AUTH_SCHEME = "Cloud-IDE-JWT";
export const TRAE_TOKEN_LIFETIME_DAYS = 14;
/** OmniRoute executor default web origin (Referer/Origin for API calls). */
export const TRAE_DEFAULT_WEB_ORIGIN = "https://work.trae.ai";

export const TRAE_SESSION_NAME = "trae";

export interface TraeIdentity {
  webId?: string;
  bizUserId?: string;
  userUniqueId?: string;
  scope?: string;
  tenant?: string;
  region?: string;
  aiRegion?: string;
  userTimezone?: string;
}

export function traeSessionMeta(s: SavedSession | null): TraeIdentity & { authMethod?: string } {
  return (s?.meta ?? {}) as TraeIdentity & { authMethod?: string };
}

/** Decode a JWT's exp (seconds) → ms epoch; null when not a decodable JWT. */
export function traeJwtExpiryMs(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Import a pasted Cloud-IDE-JWT (+ optional identity fields from the same
 * browser session). Expiry defaults to the JWT exp claim, else the
 * observed ~14-day lifetime (OmniRoute TRAE_CONFIG.tokenLifetimeDays).
 */
export async function importTraeToken(input: {
  accessToken: string;
  identity?: TraeIdentity;
  expiresAt?: number;
}): Promise<SavedSession> {
  const token = (input.accessToken ?? "").trim();
  if (!token) throw new Error("trae import: a Cloud-IDE-JWT token is required");
  const expiresAt =
    input.expiresAt ??
    traeJwtExpiryMs(token) ??
    Date.now() + TRAE_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000;
  saveSession({
    name: TRAE_SESSION_NAME,
    kind: "token-import",
    provider: "trae",
    accessToken: token,
    expiresAt,
    meta: {
      authMethod: "import",
      // OmniRoute mapTokens defaults (src/lib/oauth/providers/trae.ts).
      scope: input.identity?.scope ?? "marscode-us",
      tenant: input.identity?.tenant ?? "marscode",
      region: input.identity?.region ?? "US-East",
      aiRegion: input.identity?.aiRegion ?? input.identity?.region ?? "US-East",
      ...(input.identity?.webId ? { webId: input.identity.webId } : {}),
      ...(input.identity?.bizUserId ? { bizUserId: input.identity.bizUserId } : {}),
      ...(input.identity?.userUniqueId ? { userUniqueId: input.identity.userUniqueId } : {}),
      ...(input.identity?.userTimezone ? { userTimezone: input.identity.userTimezone } : {}),
    },
  });
  const saved = loadTraeSession();
  if (!saved) throw new Error("trae import: session save failed");
  return saved;
}

export function loadTraeSession(): SavedSession | null {
  return loadSession(TRAE_SESSION_NAME);
}

/** The saved JWT if present and unexpired (no refresh exists for Trae). */
export function getTraeToken(): { token: string; identity: TraeIdentity } | null {
  const s = loadTraeSession();
  if (!s?.accessToken) return null;
  if (s.expiresAt && s.expiresAt <= Date.now()) return null;
  return { token: s.accessToken, identity: traeSessionMeta(s) };
}
