import { describe, expect, it } from "vitest";
import {
  CODEX_PUBLIC_CLIENT_ID,
  CODEX_AUTH_URL,
  CODEX_TOKEN_URL,
  CODEX_SCOPES,
  CODEX_SESSION_NAME,
  buildAuthUrl,
  exchangeCode,
  extractAccountIdFromIdToken,
  refreshAccessToken,
  completeLoginWithCode,
  loadCodexSession,
  getValidAccessToken,
} from "../src/providers/codex.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeIdToken(claims: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "none" })}.${seg(claims)}.sig`;
}

describe("codex public OAuth creds (from OmniRoute)", () => {
  it("ships the Codex CLI's public client id", () => {
    // Public native-app OAuth cred: identifies the app, not a user.
    expect(CODEX_PUBLIC_CLIENT_ID).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
  });
  it("uses OmniRoute's OpenAI OAuth endpoints", () => {
    expect(CODEX_AUTH_URL).toBe("https://auth.openai.com/oauth/authorize");
    expect(CODEX_TOKEN_URL).toBe("https://auth.openai.com/oauth/token");
  });
  it("defaults to the Codex scope set (needs live verification)", () => {
    expect(CODEX_SCOPES).toContain("openid");
    expect(CODEX_SCOPES).toContain("offline_access");
  });
});

describe("codex buildAuthUrl (PKCE)", () => {
  it("includes PKCE params and scopes", () => {
    const url = buildAuthUrl("http://localhost:6000/api/oauth/codex/callback", "chal", "st");
    const p = new URLSearchParams(url.split("?")[1]);
    expect(url.startsWith("https://auth.openai.com/oauth/authorize?")).toBe(true);
    expect(p.get("client_id")).toBe(CODEX_PUBLIC_CLIENT_ID);
    expect(p.get("code_challenge")).toBe("chal");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("client_secret")).toBeNull();
  });
});

describe("codex account id extraction", () => {
  it("reads chatgpt_account_id from the auth claim", () => {
    const tok = fakeIdToken({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-42" } });
    expect(extractAccountIdFromIdToken(tok)).toBe("acct-42");
  });
  it("handles missing/garbage tokens", () => {
    expect(extractAccountIdFromIdToken(undefined)).toBeUndefined();
    expect(extractAccountIdFromIdToken("not-a-jwt")).toBeUndefined();
    expect(extractAccountIdFromIdToken(fakeIdToken({ sub: "x" }))).toBeUndefined();
  });
});

describe("codex token exchange + refresh", () => {
  it("exchangeCode posts PKCE grant without a client_secret (registry clientSecretDefault '')", async () => {
    let seenUrl = "";
    let form: URLSearchParams | null = null;
    const idTok = fakeIdToken({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-7" } });
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      form = new URLSearchParams(init!.body as string);
      return json({ access_token: "AT", refresh_token: "RT", id_token: idTok, expires_in: 3600 });
    }) as typeof fetch;
    const tokens = await exchangeCode("cd", "http://localhost:6000/api/oauth/codex/callback", "ver", fetchFn);
    expect(seenUrl).toBe("https://auth.openai.com/oauth/token");
    expect(form!.get("grant_type")).toBe("authorization_code");
    expect(form!.get("code_verifier")).toBe("ver");
    expect(form!.get("client_secret")).toBeNull();
    expect(tokens.idToken).toBe(idTok);
  });

  it("completeLoginWithCode saves the session with the account id", async () => {
    process.env.LLMSWITCH_SESSIONS_DIR = `/tmp/llmswitch-codex-test-${Date.now()}`;
    const idTok = fakeIdToken({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-9" } });
    const fetchFn = (async () => json({ access_token: "AT", refresh_token: "RT", id_token: idTok, expires_in: 3600 })) as typeof fetch;
    const saved = await completeLoginWithCode("cd", "http://localhost:6000/api/oauth/codex/callback", "ver", fetchFn);
    expect(saved.provider).toBe("codex");
    expect(saved.name).toBe(CODEX_SESSION_NAME);
    expect(saved.accountId).toBe("acct-9");
    expect(loadCodexSession()?.accountId).toBe("acct-9");
    delete process.env.LLMSWITCH_SESSIONS_DIR;
  });

  it("getValidAccessToken refreshes an expired token and re-saves", async () => {
    process.env.LLMSWITCH_SESSIONS_DIR = `/tmp/llmswitch-codex-valid-${Date.now()}`;
    const { saveCodexSession } = await import("../src/providers/codex.js");
    saveCodexSession({ accessToken: "OLD", refreshToken: "RT", expiresAt: Date.now() - 1000, accountId: "acct-1" });
    let form: URLSearchParams | null = null;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      form = new URLSearchParams(init!.body as string);
      return json({ access_token: "NEW", expires_in: 3600 });
    }) as typeof fetch;
    const valid = await getValidAccessToken(fetchFn);
    expect(form!.get("grant_type")).toBe("refresh_token");
    expect(valid?.accessToken).toBe("NEW");
    expect(valid?.accountId).toBe("acct-1");
    expect(loadCodexSession()?.accessToken).toBe("NEW");
    delete process.env.LLMSWITCH_SESSIONS_DIR;
  });
});
