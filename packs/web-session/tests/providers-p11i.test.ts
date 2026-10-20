/**
 * P11-I OAuth providers (pack side): Tencent plugin-auth device flow
 * (codebuddy-cn / codebuddy-intl / workbuddy), grok-cli device + import,
 * openference PKCE, gitlab-duo, agy sessions, devin-desktop import.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requestTencentDeviceCode,
  pollTencentTokenOnce,
  pollTencentToken,
  refreshTencentToken,
} from "../src/providers/tencentPluginAuth.js";
import { CODEBUDDY_CN_CONFIG, loadCodeBuddyCnSession } from "../src/providers/codebuddy-cn.js";
import { WORKBUDDY_CONFIG, loadWorkBuddySession } from "../src/providers/workbuddy.js";
import {
  requestGrokDeviceCode,
  pollGrokTokenOnce,
  parseGrokAuthJson,
  importGrokAuthJson,
  loadGrokSession,
} from "../src/providers/grok-cli.js";
import {
  buildOpenferenceAuthUrl,
  exchangeOpenferenceCode,
  decodeOpenferenceIdTokenIdentity,
  saveOpenferenceSession,
} from "../src/providers/openference.js";
import {
  buildGitLabAuthUrl,
  exchangeGitLabCode,
  postExchangeGitLab,
  saveGitLabSession,
} from "../src/providers/gitlab-duo.js";
import { saveAgySession, loadAgySession } from "../src/providers/agy.js";
import { validateImportToken as validateDevinDesktopToken, saveDevinDesktopToken, loadDevinDesktopSession } from "../src/providers/devin-desktop.js";
import { loadSession } from "../src/sessionStore.js";

function jsonResponse(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
}

let dir = "";
beforeEach(() => {
  dir = join(tmpdir(), `llmswitch-p11i-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  process.env.LLMSWITCH_SESSIONS_DIR = dir;
});
afterEach(() => {
  delete process.env.LLMSWITCH_SESSIONS_DIR;
  vi.unstubAllEnvs();
});

describe("tencent plugin-auth device flow", () => {
  it("requests state with the codebuddy-cn header family", async () => {
    let seen: Record<string, string> = {};
    let body: unknown = null;
    const fetchFn = (async (url: URL | Request, init?: RequestInit) => {
      seen = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
      body = JSON.parse(String(init?.body));
      return jsonResponse({ code: 0, data: { state: "st123", authUrl: "https://auth.example.com" } });
    }) as typeof fetch;
    const dc = await requestTencentDeviceCode(CODEBUDDY_CN_CONFIG, fetchFn);
    expect(dc.state).toBe("st123");
    expect(dc.authUrl).toContain("auth.example.com");
    expect(seen["user-agent"]).toBe("CLI/2.108.1 CodeBuddy/2.108.1");
    expect(seen["x-product"]).toBe("SaaS");
    expect(seen["x-no-authorization"]).toBe("true");
    expect((body as { platform: string }).platform).toBe("CLI");
  });

  it("workbuddy sends the minimal header profile (no X-No-Authorization)", async () => {
    let seen: Record<string, string> = {};
    const fetchFn = (async (url: URL | Request, init?: RequestInit) => {
      seen = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
      return jsonResponse({ code: 0, data: { state: "st1", authUrl: "https://a.b" } });
    }) as typeof fetch;
    await requestTencentDeviceCode(WORKBUDDY_CONFIG, fetchFn);
    expect(seen["x-product"]).toBe("SaaS");
    expect(seen["x-no-authorization"]).toBeUndefined();
    expect(seen["user-agent"]).toBeUndefined();
  });

  it("polls until code 0, then returns tokens", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls < 3) return jsonResponse({ code: 11217, msg: "login in progress" });
      return jsonResponse({ code: 0, data: { accessToken: "at", refreshToken: "rt" } });
    }) as typeof fetch;
    const tokens = await pollTencentToken(CODEBUDDY_CN_CONFIG, "st123", {
      fetchFn,
      sleep: async () => {},
    });
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(calls).toBe(3);
  });

  it("one poll attempt returns null while pending", async () => {
    const fetchFn = (async () => jsonResponse({ code: 0, data: null })) as typeof fetch;
    const r = await pollTencentTokenOnce(WORKBUDDY_CONFIG, "st1", fetchFn);
    expect(r).toBeNull();
  });

  it("refresh accepts the X-Refresh-Token header variant (WorkBuddy)", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ code: 0 }), {
        status: 200,
        headers: { "content-type": "application/json", "x-refresh-token": "newtok" },
      })) as typeof fetch;
    const r = await refreshTencentToken(WORKBUDDY_CONFIG, "oldrt", fetchFn);
    expect(r.accessToken).toBe("newtok");
  });

  it("login session saves with kind oauth-device", async () => {
    const { loginWithTencentDevice } = await import("../src/providers/tencentPluginAuth.js");
    const calls: string[] = [];
    const fetchFn = (async (url: URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).includes("/state")) return jsonResponse({ code: 0, data: { state: "s", authUrl: "https://a.b" } });
      return jsonResponse({ code: 0, data: { accessToken: "at", refreshToken: "rt" } });
    }) as typeof fetch;
    const s = await loginWithTencentDevice(WORKBUDDY_CONFIG, {
      onAuthUrl: () => {},
      fetchFn,
      sleep: async () => {},
    });
    expect(s.kind).toBe("oauth-device");
    expect(loadWorkBuddySession()?.accessToken).toBe("at");
    expect(loadCodeBuddyCnSession()).toBeNull();
    expect(loadSession("workbuddy")).not.toBeNull();
  });
});

describe("grok-cli", () => {
  it("device request posts form fields + x-grok headers", async () => {
    let headers: Record<string, string> = {};
    let body = "";
    const fetchFn = (async (url: URL | Request, init?: RequestInit) => {
      headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
      body = String(init?.body);
      return jsonResponse({
        device_code: "dc1",
        user_code: "USER-CODE",
        verification_uri: "https://x.ai/activate",
      });
    }) as typeof fetch;
    const dc = await requestGrokDeviceCode(fetchFn);
    expect(dc.deviceCode).toBe("dc1");
    expect(dc.userCode).toBe("USER-CODE");
    expect(headers["x-grok-client-surface"]).toBe("ui");
    expect(headers["x-grok-client-version"]).toBeTruthy();
    expect(body).toContain("referrer=grok-build");
    expect(body).toContain("client_id=");
  });

  it("poll returns null while pending, tokens when approved", async () => {
    const pending = (async () => jsonResponse({ error: "authorization_pending" })) as typeof fetch;
    expect(await pollGrokTokenOnce("dc1", pending)).toBeNull();
    const done = (async () => jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 })) as typeof fetch;
    const t = await pollGrokTokenOnce("dc1", done);
    expect(t?.accessToken).toBe("at");
  });

  it("slow_down raises a backoff marker", async () => {
    const f = (async () => jsonResponse({ error: "slow_down" })) as typeof fetch;
    await expect(pollGrokTokenOnce("dc1", f)).rejects.toThrow("slow_down");
  });

  it("parses auth.json shapes (top-level + nested + raw JWT)", () => {
    expect(parseGrokAuthJson('{"access_token":"AT","email":"e@x.ai"}').accessToken).toBe("AT");
    expect(parseGrokAuthJson('{"default":{"key":"KEY2"}}').accessToken).toBe("KEY2");
    expect(parseGrokAuthJson("header.payload.sig").accessToken).toBe("header.payload.sig");
    expect(() => parseGrokAuthJson('{"nope":1}')).toThrow("no access token");
  });

  it("importGrokAuthJson saves a session", () => {
    const s = importGrokAuthJson('{"access_token":"AT","refresh_token":"RT"}');
    expect(s.kind).toBe("oauth-refresh");
    expect(loadGrokSession()?.accessToken).toBe("AT");
  });
});

describe("openference", () => {
  it("builds a PKCE auth URL", () => {
    const url = buildOpenferenceAuthUrl("http://127.0.0.1:56123/callback", "st", "challenge");
    expect(url).toContain("openference.com/app/oauth/authorize");
    expect(url).toContain("code_challenge=challenge");
    expect(url).toContain("code_challenge_method=S256");
  });

  it("exchanges a code", async () => {
    const fetchFn = (async () => jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 })) as typeof fetch;
    const t = await exchangeOpenferenceCode("code1", "http://127.0.0.1:56123/callback", "verifier", fetchFn);
    expect(t.accessToken).toBe("at");
    expect(t.refreshToken).toBe("rt");
  });

  it("decodes id_token identity", () => {
    const payload = Buffer.from(JSON.stringify({ email: "e@x.io", name: "E" })).toString("base64url");
    expect(decodeOpenferenceIdTokenIdentity(`h.${payload}.s`).email).toBe("e@x.io");
    expect(decodeOpenferenceIdTokenIdentity("bad").email).toBeNull();
  });

  it("saves a session", async () => {
    const s = saveOpenferenceSession({ accessToken: "at", expiresAt: Date.now() + 1000, email: "e@x.io" });
    expect(s.provider).toBe("openference");
  });
});

describe("gitlab-duo", () => {
  it("refuses to build an auth URL without a client id", () => {
    delete process.env.GITLAB_DUO_OAUTH_CLIENT_ID;
    delete process.env.GITLAB_OAUTH_CLIENT_ID;
    expect(() => buildGitLabAuthUrl("http://x/cb", "st", "ch")).toThrow("GITLAB_DUO_OAUTH_CLIENT_ID");
  });

  it("exchanges with PKCE and reads optional direct_access", async () => {
    process.env.GITLAB_DUO_OAUTH_CLIENT_ID = "cid";
    const fetchFn = (async (url: URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/oauth/token")) return jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 7200 });
      if (u.endsWith("/api/v4/user")) return jsonResponse({ email: "e@gl.io", username: "u1" });
      if (u.includes("direct_access"))
        return jsonResponse({ token: "dat", base_url: "https://da.gitlab.com", headers: { "X-DA": "1" }, expires_at: Math.floor(Date.now() / 1000) + 3600 });
      throw new Error(`unexpected ${u}`);
    }) as typeof fetch;
    const t = await exchangeGitLabCode("code", "http://127.0.0.1:56124/callback", "v", process.env, fetchFn);
    expect(t.accessToken).toBe("at");
    const extra = await postExchangeGitLab("at", process.env, fetchFn);
    expect(extra.email).toBe("e@gl.io");
    expect(extra.directAccess?.token).toBe("dat");
    const s = saveGitLabSession(t, extra);
    expect(s.meta?.baseUrl).toContain("gitlab.com");
    expect((s.meta?.gitlabDirectAccess as { token: string }).token).toBe("dat");
  });
});

describe("agy + devin-desktop sessions", () => {
  it("agy saves under its own session name", () => {
    const expiresAt = Date.now() + 3_600_000;
    saveAgySession({ accessToken: "at", refreshToken: "rt", expiresAt, projectId: "p1", email: "e@g.io" });
    const s = loadAgySession();
    expect(s?.provider).toBe("agy");
    expect(s?.projectId).toBe("p1");
  });

  it("devin-desktop import validates and saves", () => {
    expect(validateDevinDesktopToken("").valid).toBe(false);
    expect(validateDevinDesktopToken("short").valid).toBe(false);
    expect(validateDevinDesktopToken("a".repeat(32)).valid).toBe(true);
    expect(() => saveDevinDesktopToken("short")).toThrow("too short");
    saveDevinDesktopToken("a".repeat(32));
    expect(loadDevinDesktopSession()?.accessToken).toBe("a".repeat(32));
  });
});
