import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  CLAUDE_PUBLIC_CLIENT_ID,
  CLAUDE_AUTH_URL,
  CLAUDE_TOKEN_URL,
  CLAUDE_SCOPES,
  CLAUDE_SESSION_NAME,
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  completeLoginWithCode,
  loginWithRefreshToken,
  loadClaudeSession,
  saveClaudeSession,
} from "../src/providers/claude.js";
import { generatePkce } from "../src/oauth2.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("claude public OAuth creds (from OmniRoute)", () => {
  it("ships the Claude Code CLI's public client id", () => {
    // Public native-app OAuth cred: identifies the app, not a user.
    expect(CLAUDE_PUBLIC_CLIENT_ID).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  });
  it("uses OmniRoute's Anthropic OAuth endpoints", () => {
    expect(CLAUDE_AUTH_URL).toBe("https://api.anthropic.com/v1/oauth/authorize");
    expect(CLAUDE_TOKEN_URL).toBe("https://api.anthropic.com/v1/oauth/token");
  });
  it("defaults to the Claude Code scope set (needs live verification)", () => {
    expect(CLAUDE_SCOPES).toContain("user:inference");
  });
});

describe("PKCE helper", () => {
  it("produces a valid S256 pair", () => {
    const { codeVerifier, codeChallenge, codeChallengeMethod } = generatePkce();
    expect(codeChallengeMethod).toBe("S256");
    const expected = createHash("sha256").update(codeVerifier).digest("base64url");
    expect(codeChallenge).toBe(expected);
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
  });
  it("is random per call", () => {
    expect(generatePkce().codeVerifier).not.toBe(generatePkce().codeVerifier);
  });
});

describe("claude buildAuthUrl (PKCE)", () => {
  it("includes PKCE params, client_id and scopes", () => {
    const url = buildAuthUrl("http://127.0.0.1:53111/callback", "challenge123", "state123");
    const p = new URLSearchParams(url.split("?")[1]);
    expect(url.startsWith("https://api.anthropic.com/v1/oauth/authorize?")).toBe(true);
    expect(p.get("client_id")).toBe(CLAUDE_PUBLIC_CLIENT_ID);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("code_challenge")).toBe("challenge123");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("state123");
    expect(p.get("scope")).toContain("user:inference");
    // public client: no secret is ever put in the URL
    expect(p.get("client_secret")).toBeNull();
  });
});

describe("claude token exchange + refresh", () => {
  it("exchangeCode posts PKCE authorization_code grant (no client_secret)", async () => {
    let seenUrl = "";
    let form: URLSearchParams | null = null;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      form = new URLSearchParams(init!.body as string);
      return json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 });
    }) as typeof fetch;
    const tokens = await exchangeCode("code123", "http://127.0.0.1:53111/callback", "verifier-abc", fetchFn);
    expect(seenUrl).toBe("https://api.anthropic.com/v1/oauth/token");
    expect(form!.get("grant_type")).toBe("authorization_code");
    expect(form!.get("code")).toBe("code123");
    expect(form!.get("code_verifier")).toBe("verifier-abc");
    expect(form!.get("redirect_uri")).toBe("http://127.0.0.1:53111/callback");
    expect(form!.get("client_secret")).toBeNull();
    expect(tokens.accessToken).toBe("AT");
    expect(tokens.refreshToken).toBe("RT");
  });

  it("refreshAccessToken uses the refresh_token grant without a secret", async () => {
    let form: URLSearchParams | null = null;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      form = new URLSearchParams(init!.body as string);
      return json({ access_token: "AT2", expires_in: 3600 });
    }) as typeof fetch;
    const fresh = await refreshAccessToken("RT", fetchFn);
    expect(form!.get("grant_type")).toBe("refresh_token");
    expect(form!.get("client_secret")).toBeNull();
    expect(fresh.accessToken).toBe("AT2");
  });

  it("completeLoginWithCode saves the session", async () => {
    process.env.LLMSWITCH_SESSIONS_DIR = `/tmp/llmswitch-claude-test-${Date.now()}`;
    const fetchFn = (async (url: string) => {
      if (url.includes("oauth/token")) return json({ access_token: "ATL", refresh_token: "RTL", expires_in: 3600 });
      return new Response("nf", { status: 404 });
    }) as typeof fetch;
    const saved = await completeLoginWithCode("code1", "http://127.0.0.1:1/callback", "verifier", fetchFn);
    expect(saved.provider).toBe("claude");
    expect(saved.accessToken).toBe("ATL");
    expect(loadClaudeSession()?.accessToken).toBe("ATL");
    expect(saved.name).toBe(CLAUDE_SESSION_NAME);
    delete process.env.LLMSWITCH_SESSIONS_DIR;
  });

  it("loginWithRefreshToken refreshes and saves", async () => {
    process.env.LLMSWITCH_SESSIONS_DIR = `/tmp/llmswitch-claude-rt-${Date.now()}`;
    const fetchFn = (async () => json({ access_token: "ATR", expires_in: 3600 })) as typeof fetch;
    const saved = await loginWithRefreshToken("RT-EXPORTED", fetchFn);
    expect(saved.refreshToken).toBe("RT-EXPORTED");
    expect(saved.accessToken).toBe("ATR");
    delete process.env.LLMSWITCH_SESSIONS_DIR;
  });

  it("saveClaudeSession writes a 0600 file", async () => {
    process.env.LLMSWITCH_SESSIONS_DIR = `/tmp/llmswitch-claude-perm-${Date.now()}`;
    const { statSync } = await import("node:fs");
    const p = saveClaudeSession({ accessToken: "X", expiresAt: Date.now() + 1000 });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    delete process.env.LLMSWITCH_SESSIONS_DIR;
  });
});
