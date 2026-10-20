import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GITHUB_COPILOT_PUBLIC_CLIENT_ID,
  GITHUB_COPILOT_SCOPE,
  COPILOT_INTEGRATION_ID,
  COPILOT_API_VERSION,
  CopilotLoginRequiredError,
  buildCopilotChatHeaders,
  buildCopilotRefreshHeaders,
  copilotCliVersion,
  copilotEndpoints,
  copilotMachineId,
  copilotTokenFresh,
  exchangeCopilotToken,
  fetchCopilotAccount,
  githubCopilotClientId,
  loginWithDeviceFlow,
  refreshCopilotToken,
  saveCopilotSession,
  sessionNameFor,
} from "../src/providers/githubCopilot.js";
import { saveSession, loadSession } from "../src/sessionStore.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "copilot-test-"));
  process.env.LLMSWITCH_SESSIONS_DIR = dir;
});
afterEach(() => {
  delete process.env.LLMSWITCH_SESSIONS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("copilot public OAuth creds (from OmniRoute)", () => {
  it("ships the public Copilot device-flow client id", () => {
    expect(GITHUB_COPILOT_PUBLIC_CLIENT_ID).toBe("Iv1.b507a08c87ecfe98");
    expect(GITHUB_COPILOT_PUBLIC_CLIENT_ID).toMatch(/^Iv1\.[a-f0-9]+$/);
  });
  it("uses the read:user device-flow scope", () => {
    expect(GITHUB_COPILOT_SCOPE).toBe("read:user");
  });
  it("honors env client-id overrides", () => {
    const env = { GITHUB_OAUTH_CLIENT_ID: " Iv1.custom123 " } as NodeJS.ProcessEnv;
    expect(githubCopilotClientId(env)).toBe("Iv1.custom123");
    expect(githubCopilotClientId({} as NodeJS.ProcessEnv)).toBe(GITHUB_COPILOT_PUBLIC_CLIENT_ID);
    const gheEnv = { GHE_COPILOT_OAUTH_CLIENT_ID: "Iv1.ghe999" } as NodeJS.ProcessEnv;
    expect(githubCopilotClientId(gheEnv, "ghe")).toBe("Iv1.ghe999");
    expect(githubCopilotClientId({} as NodeJS.ProcessEnv, "ghe")).toBe(GITHUB_COPILOT_PUBLIC_CLIENT_ID);
  });
});

describe("copilot endpoints (from OmniRoute)", () => {
  it("github.com endpoints are static", () => {
    const e = copilotEndpoints("github");
    expect(e.deviceCodeUrl).toBe("https://github.com/login/device/code");
    expect(e.tokenUrl).toBe("https://github.com/login/oauth/access_token");
    expect(e.userInfoUrl).toBe("https://api.github.com/user");
    expect(e.copilotTokenUrl).toBe("https://api.github.com/copilot_internal/v2/token");
  });
  it("GHE endpoints derive from the host", () => {
    const e = copilotEndpoints("ghe", "https://ghe.example.com/");
    expect(e.deviceCodeUrl).toBe("https://ghe.example.com/login/device/code");
    expect(e.tokenUrl).toBe("https://ghe.example.com/login/oauth/access_token");
    expect(e.userInfoUrl).toBe("https://ghe.example.com/api/v3/user");
    expect(e.copilotTokenUrl).toBe("https://ghe.example.com/api/v3/copilot_internal/v2/token");
  });
  it("GHE without a host throws with a login hint", () => {
    expect(() => copilotEndpoints("ghe")).toThrow(/llmswitch login copilot --ghe/);
  });
});

describe("copilot fingerprint headers (from OmniRoute CLI capture)", () => {
  const env = { GITHUB_COPILOT_CLI_VERSION: "1.0.91", GITHUB_COPILOT_MACHINE_ID: "m-1" } as NodeJS.ProcessEnv;
  it("builds the CLI's chat header set", () => {
    const h = buildCopilotChatHeaders("ctok", env);
    expect(h["Authorization"]).toBe(["Bearer", "ctok"].join(" "));
    expect(h["copilot-integration-id"]).toBe(COPILOT_INTEGRATION_ID);
    expect(h["editor-version"]).toBe("copilot/1.0.91");
    expect(h["user-agent"]).toMatch(/^copilot\/1\.0\.91 \(.+\) term\/unknown$/);
    expect(h["openai-intent"]).toBe("conversation-agent");
    expect(h["x-interaction-type"]).toBe("conversation-user");
    expect(h["copilot-harness-id"]).toBe("copilot-sdk");
    expect(h["x-github-api-version"]).toBe(COPILOT_API_VERSION);
    expect(h["x-client-machine-id"]).toBe("m-1");
    expect(h["X-Initiator"]).toBe("user");
  });
  it("version override is honored and machine id falls back to a uuid", () => {
    const v = copilotCliVersion({ GITHUB_COPILOT_CLI_VERSION: "1.0.92" } as NodeJS.ProcessEnv);
    expect(v).toBe("1.0.92");
    expect(copilotCliVersion({} as NodeJS.ProcessEnv)).toBe("1.0.91");
    expect(copilotMachineId({} as NodeJS.ProcessEnv)).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("builds the token-exchange headers (token auth, no Bearer)", () => {
    const h = buildCopilotRefreshHeaders("gho_x", env);
    expect(h["Authorization"]).toBe(["token", "gho_x"].join(" "));
    expect(h["User-Agent"]).toBe("GithubCopilot/1.0");
    expect(h["Editor-Version"]).toBe("copilot/1.0.91");
    expect(h["Editor-Plugin-Version"]).toBe("copilot/1.0.91");
  });
  it("vision flag is only added when requested", () => {
    expect(buildCopilotChatHeaders("t", env)["copilot-vision-request"]).toBeUndefined();
    expect(buildCopilotChatHeaders("t", env, { vision: true })["copilot-vision-request"]).toBe("true");
  });
});

describe("copilot token exchange (from OmniRoute refreshCopilotToken)", () => {
  const endpoints = copilotEndpoints("github");
  it("uses token-auth header against copilot_internal/v2/token", async () => {
    const seen: Record<string, string> = {};
    const fetchFn = async (url: any, init: any) => {
      for (const [k, v] of Object.entries(init.headers)) seen[k] = String(v);
      return json({
        token: "cp_tok",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
        endpoints: { api: "https://api.individual.githubcopilot.com", proxy: "https://proxy.individual.githubcopilot.com" },
      });
    };
    const t = await exchangeCopilotToken("gho_oauth", endpoints, fetchFn as typeof fetch);
    expect(t?.token).toBe("cp_tok");
    expect(seen["Authorization"]).toBe(["token", "gho_oauth"].join(" "));
    expect(seen["User-Agent"]).toBe("GithubCopilot/1.0");
    expect(t!.expiresAt).toBeGreaterThan(Date.now() + 1700_000);
    expect(t!.apiUrl).toBe("https://api.individual.githubcopilot.com");
  });
  it("returns null when GitHub rejects (non-ok)", async () => {
    const fetchFn = async () => json({ message: "no" }, 401);
    expect(await exchangeCopilotToken("bad", endpoints, fetchFn as typeof fetch)).toBeNull();
  });
});

describe("device-flow login (mock IdP)", () => {
  it("full login: device code -> poll -> exchange -> user info -> session (0600)", async () => {
    let polls = 0;
    const calls: string[] = [];
    const fetchFn = async (url: any, init: any) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/login/device/code")) {
        return json({ device_code: "dc1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 });
      }
      if (u.endsWith("/login/oauth/access_token")) {
        polls++;
        if (polls < 2) return json({ error: "authorization_pending" });
        return json({
          access_token: "0123456789abcdef",
          refresh_token: "fedcba9876543210",
          expires_in: 3600,
        });
      }
      if (u.endsWith("/copilot_internal/v2/token")) {
        return json({ token: "copilot_tok", expires_at: Math.floor(Date.now() / 1000) + 1800 });
      }
      if (u.endsWith("/api.github.com/user")) {
        return json({ login: "octocat", email: "o@example.com" });
      }
      throw new Error(`unexpected url ${u}`);
    };
    let shown: [string, string] | null = null;
    const s = await loginWithDeviceFlow({
      kind: "github",
      onCode: (code, uri) => { shown = [code, uri]; },
      fetchFn: fetchFn as typeof fetch,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(shown![0]).toBe("ABCD-1234");
    expect(shown![1]).toBe("https://github.com/login/device");
    expect(s.copilotToken).toBe("copilot_tok");
    expect(s.email).toBe("o@example.com");
    expect(loadSession(sessionNameFor("github"))?.copilotToken).toBe("copilot_tok");
    expect(sessionNameFor("github")).toBe("github-copilot");
    expect(sessionNameFor("ghe")).toBe("ghe-copilot");
    // 0600 permissions
    const mode = statSync(`${dir}/github-copilot.json`).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("refreshCopilotToken (OmniRoute refreshCredentials semantics)", () => {
  function seed(over: Partial<Omit<Parameters<typeof saveCopilotSession>[0], "kind">> = {}) {
    saveCopilotSession({
      kind: "github",
      accessToken: "ghaccess0123",
      refreshToken: "ghrefresh0123",
      expiresIn: 3600,
      copilotToken: "cp_old",
      copilotTokenExpiresAt: Date.now() - 60_000, // expired
      email: "o@example.com",
      ...over,
    });
  }
  it("uses the in-file copilot token when still fresh", async () => {
    seed({ copilotTokenExpiresAt: Date.now() + 3600_000, copilotToken: "cp_fresh" });
    let called = 0;
    const fetchFn = async () => { called++; return json({}); };
    const t = await refreshCopilotToken("github", fetchFn as typeof fetch, {} as NodeJS.ProcessEnv);
    expect(t.token).toBe("cp_fresh");
    expect(called).toBe(0);
  });
  it("exchanges the stored github token when the copilot token is stale", async () => {
    seed();
    const fetchFn = async (url: any, init: any) => {
      expect(String(url)).toBe("https://api.github.com/copilot_internal/v2/token");
      expect(init.headers["Authorization"]).toBe("token " + "ghaccess0123");
      return json({ token: "cp_new", expires_at: Math.floor(Date.now() / 1000) + 1800 });
    };
    const t = await refreshCopilotToken("github", fetchFn as typeof fetch, {} as NodeJS.ProcessEnv);
    expect(t.token).toBe("cp_new");
    expect(loadSession("github-copilot")!.copilotToken).toBe("cp_new");
  });
  it("falls back to the refresh_token grant (no client_secret) when the exchange fails", async () => {
    seed();
    const bodies: string[] = [];
    const fetchFn = async (url: any, init: any) => {
      const u = String(url);
      if (u.includes("copilot_internal")) {
        return init.headers["Authorization"] === "token " + "ghaccess0123"
          ? json({ error: "x" }, 401)
          : json({ token: "cp_via_refresh", expires_at: Math.floor(Date.now() / 1000) + 1800 });
      }
      if (u.endsWith("/login/oauth/access_token")) {
        bodies.push(String(init.body));
        return json({
          access_token: "ghaccess0456",
          refresh_token: "ghrefresh0456",
          expires_in: 3600,
        });
      }
      throw new Error(`unexpected ${u}`);
    };
    const t = await refreshCopilotToken("github", fetchFn as typeof fetch, {} as NodeJS.ProcessEnv);
    expect(t.token).toBe("cp_via_refresh");
    const params = new URLSearchParams(bodies[0]);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("client_id")).toBe("Iv1.b507a08c87ecfe98");
    // Copilot is a public client — never send a client_secret
    expect(params.has("client_secret")).toBe(false);
  });
  it("throws a login-hint error when there is no session", async () => {
    const fetchFn = async () => json({});
    await expect(refreshCopilotToken("github", fetchFn as typeof fetch, {} as NodeJS.ProcessEnv)).rejects.toThrow(
      /llmswitch login copilot/,
    );
  });
});

describe("copilotTokenFresh + fetchCopilotAccount", () => {
  it("respects the 5-minute margin", () => {
    const now = Date.now();
    const s = { copilotToken: "t", copilotTokenExpiresAt: now + 4 * 60_000 } as any;
    expect(copilotTokenFresh(s, now)).toBe(false);
    expect(copilotTokenFresh({ ...s, copilotTokenExpiresAt: now + 6 * 60_000 }, now)).toBe(true);
    expect(copilotTokenFresh({} as any, now)).toBe(false);
  });
  it("account lookup never throws", async () => {
    const e = copilotEndpoints("github");
    const ok = await fetchCopilotAccount("tok", e, (async () => json({ login: "octocat" })) as unknown as typeof fetch);
    expect(ok.login).toBe("octocat");
    const bad = await fetchCopilotAccount("tok", e, (async () => { throw new Error("net"); }) as unknown as typeof fetch);
    expect(bad).toEqual({});
  });
  it("CopilotLoginRequiredError is typed", () => {
    const e = new CopilotLoginRequiredError("x");
    expect(e.name).toBe("CopilotLoginRequiredError");
  });
});
