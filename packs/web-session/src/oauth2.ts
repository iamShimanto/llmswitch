/** Generic OAuth2 client (refresh_token grant) for OAuth-based packs. */

import { createHash, randomBytes } from "node:crypto";

/* ------------------------------------------------------------------ *
 * PKCE (RFC 7636) — used by the public native-app OAuth clients
 * (Anthropic Claude Code, OpenAI Codex) whose flows exchange an
 * authorization code + code_verifier instead of a client_secret.
 * ------------------------------------------------------------------ */

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  /** always "S256" for these clients */
  codeChallengeMethod: "S256";
}

export function generatePkce(): PkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge, codeChallengeMethod: "S256" };
}

export interface OAuth2Config {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  scope?: string;
}

export class OAuth2Client {
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(
    private config: OAuth2Config,
    private fetchFn: typeof fetch = fetch,
  ) {}

  /** Valid access token, refreshing when expired (60s skew). */
  async token(now = Date.now()): Promise<string> {
    if (this.accessToken && now < this.expiresAt - 60_000) return this.accessToken;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.config.refreshToken,
      client_id: this.config.clientId,
    });
    if (this.config.clientSecret) body.set("client_secret", this.config.clientSecret);
    if (this.config.scope) body.set("scope", this.config.scope);

    const res = await this.fetchFn(this.config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`OAuth2 refresh failed: HTTP ${res.status}`);
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error("OAuth2 refresh: no access_token in response");
    this.accessToken = j.access_token;
    this.expiresAt = now + (j.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  authHeader(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }
}
