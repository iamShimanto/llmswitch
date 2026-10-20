/**
 * Tests for the 5 IDE OAuth providers (mock fetch, temp session dir).
 * No live OAuth / no real IDE accounts touched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import {
  generateCursorAuthParams,
  pollCursorAuthOnce,
  refreshCursorToken,
  importCursorTokens,
  loadCursorSession,
  getValidCursorAccessToken,
  cursorJwtIdentity,
  CURSOR_SESSION_NAME,
} from "../src/providers/cursor.js";
import {
  startKiroDeviceFlow,
  pollKiroDeviceTokenOnce,
  startKiroSocialDeviceFlow,
  pollKiroSocialDeviceOnce,
  refreshKiroSocialToken,
  importKiroToken,
  loadKiroSession,
  getValidKiroAccessToken,
  KIRO_SESSION_NAME,
} from "../src/providers/kiro.js";
import {
  importTraeToken,
  loadTraeSession,
  getTraeToken,
  traeJwtExpiryMs,
  TRAE_SESSION_NAME,
} from "../src/providers/trae.js";
import {
  createZedNativeAuthData,
  decryptZedAccessToken,
  parseZedCallbackPayload,
  completeZedLogin,
  loadZedHostedSession,
  ZED_HOSTED_SESSION_NAME,
} from "../src/providers/zedHosted.js";
import {
  buildClinePassAuthUrl,
  decodeClinePassCode,
  exchangeClinePassCode,
  refreshClinePassToken,
  importClinePassKey,
  loadClinePassSession,
  getValidClinePassAccessToken,
  CLINEPASS_SESSION_NAME,
} from "../src/providers/clinepass.js";
import { deleteSession, listSessions } from "../src/sessionStore.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeJwt(payload: Record<string, unknown>): string {
  const b = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `h.${b}.s`;
}

let tmp: string;
beforeEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = mkdtempSync(join(tmpdir(), "llmui-"));
  process.env.LLMSWITCH_SESSIONS_DIR = tmp;
});

/* ------------------------------ cursor ------------------------------ */

describe("cursor deep-control PKCE login", () => {
  it("generates a loginDeepControl URL with challenge+uuid, no verifier in URL", () => {
    const p = generateCursorAuthParams();
    expect(p.loginUrl).toContain("https://cursor.com/loginDeepControl");
    expect(p.loginUrl).toContain("challenge=");
    expect(p.loginUrl).toContain("uuid=");
    expect(p.loginUrl).toContain("redirectTarget=cli");
    expect(p.loginUrl).not.toContain(p.codeVerifier);
    expect(p.codeVerifier).toHaveLength(43);
  });

  it("poll: 404 -> pending, 200 -> tokens, other -> error", async () => {
    const pending = await pollCursorAuthOnce("u", "v", async () => new Response(null, { status: 404 }));
    expect(pending).toEqual({ status: "pending" });
    const ok = await pollCursorAuthOnce(
      "u", "v",
      async () => json({ accessToken: "a", refreshToken: "r" }),
    );
    expect(ok).toEqual({ status: "ok", accessToken: "a", refreshToken: "r" });
    const err = await pollCursorAuthOnce("u", "v", async () => new Response(null, { status: 500 }));
    expect(err.status).toBe("error");
  });

  it("refresh posts Bearer <refreshToken> to exchange_user_api_key", async () => {
    let url = "", auth = "";
    const t = await refreshCursorToken("rt1", async (u, init) => {
      url = String(u);
      auth = ((init?.headers ?? {}) as Record<string, string>).authorization;
      return json({ accessToken: fakeJwt({ exp: Date.now() / 1000 + 3600 }), refreshToken: "rt2" });
    });
    expect(url).toContain("exchange_user_api_key");
    expect(auth).toBe("Bearer rt1");
    expect(t.accessToken).toBeTruthy();
    expect(t.refreshToken).toBe("rt2");
  });

  it("import saves a session with authMethod=imported and JWT identity", async () => {
    const s = await importCursorTokens(
      fakeJwt({ sub: "42", email: "Me@x.io" }),
      null,
      "machine-1",
      async () => new Response(null, { status: 500 }), // refresh fails -> falls back to JWT expiry
    );
    expect(s.email).toBe("me@x.io");
    expect((s.meta as Record<string, unknown>).machineId).toBe("machine-1");
    expect((s.meta as Record<string, unknown>).authMethod).toBe("imported");
  });

  it("getValidCursorAccessToken returns the stored token when fresh", async () => {
    await importCursorTokens(fakeJwt({ exp: Date.now() / 1000 + 7200 }), "rt", undefined, async () =>
      json({ accessToken: fakeJwt({ exp: Date.now() / 1000 + 7200 }) }));
    const t = await getValidCursorAccessToken();
    expect(t?.accessToken).toBeTruthy();
  });

  it("cursorJwtIdentity decodes sub/email", () => {
    expect(cursorJwtIdentity(fakeJwt({ sub: "123", email: "A@B.c" }))).toEqual({ accountId: "123", email: "a@b.c" });
    expect(cursorJwtIdentity("not-a-jwt")).toEqual({});
  });

  it("session file name is cursor.json", async () => {
    expect(CURSOR_SESSION_NAME).toBe("cursor");
    await importCursorTokens(fakeJwt({ exp: Date.now() / 1000 + 3600 }), null, undefined, async () =>
      new Response(null, { status: 500 }),
    );
    expect(listSessions()).toContain("cursor");
    expect(loadCursorSession()?.name).toBe("cursor");
  });
});

/* ------------------------------ kiro ------------------------------ */

describe("kiro device flows", () => {
  it("startKiroDeviceFlow registers client then requests device code", async () => {
    const calls: string[] = [];
    const s = await startKiroDeviceFlow(async (u, init) => {
      calls.push(String(u));
      if (String(u).includes("client/register")) return json({ clientId: "cid", clientSecret: "csec" });
      return json({ deviceCode: "dc", userCode: "uc", verificationUri: "https://v", verificationUriComplete: "https://v#c" });
    });
    expect(calls[0]).toContain("client/register");
    expect(calls[1]).toContain("device_authorization");
    expect(s.clientId).toBe("cid");
    expect(s.userCode).toBe("uc");
    expect(s.verificationUriComplete).toBe("https://v#c");
  });

  it("poll: authorization_pending -> pending, tokens -> tokens", async () => {
    const session = await startKiroDeviceFlow(async (u) =>
      String(u).includes("client/register") ? json({ clientId: "c", clientSecret: "s" }) : json({ deviceCode: "dc" }),
    );
    const pending = await pollKiroDeviceTokenOnce(session, async () => json({ error: "authorization_pending" }, 400));
    expect(pending.kind).toBe("pending");
    const ok = await pollKiroDeviceTokenOnce(session, async () =>
      json({ accessToken: "at", refreshToken: "rt", expiresIn: 3600 }));
    expect(ok.kind).toBe("tokens");
    expect((ok as { tokens: { accessToken: string } }).tokens.accessToken).toBe("at");
  });

  it("social device flow: authorize then poll", async () => {
    const s = await startKiroSocialDeviceFlow("google", async (u, init) => {
      expect(String(u)).toContain("device/authorization");
      expect(String(init?.body)).toContain('"loginProvider":"Google"');
      return json({ deviceCode: "dc", userCode: "uc", verificationUriComplete: "https://k/login" });
    });
    expect(s.verificationUriComplete).toBe("https://k/login");
    const ok = await pollKiroSocialDeviceOnce(s, async (u, init) => {
      expect(String(u)).toContain("device/poll");
      return json({ accessToken: "sat", refreshToken: "srt" });
    });
    expect(ok.kind).toBe("tokens");
  });

  it("refreshKiroSocialToken posts refreshToken to the kiro refresh endpoint", async () => {
    let url = "";
    const t = await refreshKiroSocialToken("srt", async (u, init) => {
      url = String(u);
      expect(String(init?.body)).toContain("srt");
      return json({ accessToken: "sat2", refreshToken: "srt2" });
    });
    expect(url).toContain("prod.us-east-1.auth.desktop.kiro.dev/refreshToken");
    expect(t.accessToken).toBe("sat2");
  });

  it("import stores refresh token; getValid returns it without client-registration refresh", async () => {
    await importKiroToken({ refreshToken: "imp-rt", accessToken: "imp-at", profileArn: "arn:aws:abc" });
    const s = loadKiroSession();
    expect(s?.refreshToken).toBe("imp-rt");
    expect((s?.meta as Record<string, unknown>).authMethod).toBe("import");
    const t = await getValidKiroAccessToken(async () => {
      throw new Error("should not fetch");
    });
    expect(t?.accessToken).toBe("imp-at");
    expect(t?.profileArn).toBe("arn:aws:abc");
  });

  it("session file name is kiro.json", () => {
    expect(KIRO_SESSION_NAME).toBe("kiro");
  });
});

/* ------------------------------ trae ------------------------------ */

describe("trae token import", () => {
  it("imports a JWT with default identity fields and 14-day default expiry", async () => {
    const s = await importTraeToken({ accessToken: "jwt-like-token" });
    expect(s.accessToken).toBe("jwt-like-token");
    expect(s.kind).toBe("token-import");
    const meta = s.meta as Record<string, unknown>;
    expect(meta.scope).toBe("marscode-us");
    expect(meta.tenant).toBe("marscode");
    expect(meta.region).toBe("US-East");
    expect(s.expiresAt).toBeGreaterThan(Date.now() + 13 * 24 * 3600_000);
  });

  it("prefers JWT exp claim over the default lifetime", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const jwt = `h.${Buffer.from(JSON.stringify({ exp: future })).toString("base64url")}.s`;
    await importTraeToken({ accessToken: jwt });
    const t = getTraeToken();
    expect(t?.token).toBe(jwt);
    expect(t?.identity.scope).toBe("marscode-us");
  });

  it("getTraeToken returns null when expired", async () => {
    await importTraeToken({ accessToken: "t", expiresAt: Date.now() - 1000 });
    expect(getTraeToken()).toBeNull();
  });

  it("traeJwtExpiryMs decodes exp", () => {
    const future = Math.floor(Date.now() / 1000) + 5000;
    const jwt = `h.${Buffer.from(JSON.stringify({ exp: future })).toString("base64url")}.s`;
    expect(traeJwtExpiryMs(jwt)).toBe(future * 1000);
    expect(traeJwtExpiryMs("opaque")).toBeNull();
  });

  it("session file name is trae.json", () => {
    expect(TRAE_SESSION_NAME).toBe("trae");
  });
});

/* ------------------------------ zed-hosted ------------------------------ */

describe("zed-hosted native-app sign-in", () => {
  it("createZedNativeAuthData builds a native_app_signin URL with public key", () => {
    const d = createZedNativeAuthData({ nativeAppPort: 58443 });
    expect(d.authUrl).toContain("https://zed.dev/native_app_signin");
    expect(d.authUrl).toContain("native_app_port=58443");
    expect(d.authUrl).toContain("native_app_public_key=");
    expect(d.authUrl).toContain("system_id=");
    expect(d.privateKeyPem).toContain("PRIVATE KEY");
  });

  it("RSA round-trip: encrypt with the attempt's public key, decrypt with private key", async () => {
    const { createPublicKey, publicEncrypt, constants } = await import("node:crypto");
    const d = createZedNativeAuthData({});
    const url = new URL(d.authUrl);
    const pubDer = Buffer.from(
      url.searchParams.get("native_app_public_key")!.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
    const pub = createPublicKey({ key: pubDer, format: "der", type: "pkcs1" });
    const encrypted = publicEncrypt(
      { key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from("my-access-token"),
    ).toString("base64url");
    expect(decryptZedAccessToken(encrypted, d.privateKeyPem)).toBe("my-access-token");
  });

  it("decrypt rejects garbage deterministically", () => {
    const d = createZedNativeAuthData({});
    expect(() => decryptZedAccessToken("!!!", d.privateKeyPem)).toThrow(/decrypt access token/);
  });

  it("parseZedCallbackPayload accepts URL, query-string, and JSON forms", () => {
    const url = "http://127.0.0.1:58443/?user_id=u1&access_token=ZW5j";
    expect(parseZedCallbackPayload(url)).toEqual({ userId: "u1", encryptedAccessToken: "ZW5j" });
    expect(parseZedCallbackPayload("?user_id=u2&access_token=abc")).toEqual({ userId: "u2", encryptedAccessToken: "abc" });
    expect(parseZedCallbackPayload(JSON.stringify({ userId: "u3", access_token: "xyz" }))).toEqual({
      userId: "u3", encryptedAccessToken: "xyz",
    });
    expect(() => parseZedCallbackPayload("http://127.0.0.1:58443/")).toThrow(/user_id and access_token/);
  });

  it("completeZedLogin decrypts + saves session (mock encrypted token)", async () => {
    const d = createZedNativeAuthData({});
    // Encrypt "final-access-token" against this attempt's public key via its DER form.
    const { createPublicKey, publicEncrypt, constants } = await import("node:crypto");
    const url = new URL(d.authUrl);
    const pubDer = Buffer.from(
      url.searchParams.get("native_app_public_key")!.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
    const pub = createPublicKey({ key: pubDer, format: "der", type: "pkcs1" });
    const encrypted = publicEncrypt(
      { key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from("final-access-token"),
    ).toString("base64url");
    const s = await completeZedLogin(
      `http://127.0.0.1:58443/?user_id=zed-user-1&access_token=${encrypted}`,
      d,
      async () => json({ id: "zed-user-1", email: "z@x.io" }),
    );
    expect(s.accessToken).toBe("final-access-token");
    expect(s.email).toBe("z@x.io");
    expect((s.meta as Record<string, unknown>).userId).toBe("zed-user-1");
    expect(loadZedHostedSession()?.accessToken).toBe("final-access-token");
  });

  it("session file name is zed-hosted.json", () => {
    expect(ZED_HOSTED_SESSION_NAME).toBe("zed-hosted");
  });
});

/* ------------------------------ clinepass ------------------------------ */

describe("clinepass oauth + byok", () => {
  it("buildClinePassAuthUrl uses client_type=extension + redirect_uri", () => {
    const u = buildClinePassAuthUrl("http://127.0.0.1:9/callback");
    expect(u).toContain("https://api.cline.bot/api/v1/auth/authorize");
    expect(u).toContain("client_type=extension");
    expect(u).toContain(encodeURIComponent("http://127.0.0.1:9/callback"));
  });

  it("decodeClinePassCode extracts base64-JSON tokens", () => {
    const code = Buffer.from(JSON.stringify({ access_token: "at", refresh_token: "rt", email: "e@x.io" })).toString("base64");
    const d = decodeClinePassCode(code);
    expect(d?.access_token).toBe("at");
    expect(d?.refresh_token).toBe("rt");
    expect(decodeClinePassCode("definitely-not-base64-json")).toBeNull();
  });

  it("exchangeClinePassCode prefers the decoded path", async () => {
    const code = Buffer.from(JSON.stringify({ accessToken: "sat", refreshToken: "srt", email: "e@x.io" })).toString("base64");
    const t = await exchangeClinePassCode(code, "http://127.0.0.1:1/callback", async () => {
      throw new Error("should not fetch");
    });
    expect(t.accessToken).toBe("sat");
    expect(t.refreshToken).toBe("srt");
  });

  it("exchangeClinePassCode falls back to POST when the code is opaque", async () => {
    const t = await exchangeClinePassCode("opaque-code", "http://127.0.0.1:1/callback", async (u, init) => {
      expect(String(u)).toContain("/api/v1/auth/token");
      expect(String(init?.body)).toContain("authorization_code");
      return json({ access_token: "pat", refresh_token: "prt" });
    });
    expect(t.accessToken).toBe("pat");
  });

  it("refreshClinePassToken posts refreshToken + grantType to /auth/refresh", async () => {
    let url = "";
    const t = await refreshClinePassToken("old-rt", async (u, init) => {
      url = String(u);
      expect(String(init?.body)).toContain('"grantType":"refresh_token"');
      return json({ data: { accessToken: "nat", refreshToken: "nrt" } });
    });
    expect(url).toContain("/api/v1/auth/refresh");
    expect(t.accessToken).toBe("nat");
  });

  it("importClinePassKey saves BYOK; getValid returns it without refresh", async () => {
    await importClinePassKey("sk-cline-123");
    const s = loadClinePassSession();
    expect(s?.kind).toBe("token-import");
    expect((s?.meta as Record<string, unknown>).authMethod).toBe("byok");
    const t = await getValidClinePassAccessToken(async () => {
      throw new Error("should not fetch");
    });
    expect(t?.accessToken).toBe("sk-cline-123");
  });

  it("session file name is clinepass.json", () => {
    expect(CLINEPASS_SESSION_NAME).toBe("clinepass");
  });
});
