import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_PUBLIC_CLIENT_ID,
  ANTIGRAVITY_PUBLIC_CLIENT_SECRET,
  buildAuthUrl,
  buildFingerprintHeaders,
  buildIdeMetadata,
  buildOnboardPayload,
  ensureProjectId,
  exchangeCode,
  extractProjectId,
  loadCodeAssist,
  loginWithRefreshToken,
  onboardUser,
  refreshAccessToken,
  resolveAntigravityPlatformEnum,
  ANTIGRAVITY_SCOPES,
} from "../src/providers/antigravity.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("antigravity public OAuth creds (from OmniRoute)", () => {
  it("ships the Antigravity desktop app's public client id/secret", () => {
    // Public native-app OAuth creds: identify the app, not a user.
    expect(ANTIGRAVITY_PUBLIC_CLIENT_ID).toMatch(/\.apps\.googleusercontent\.com$/);
    expect(ANTIGRAVITY_PUBLIC_CLIENT_SECRET).toMatch(/^GOCSPX-/);
  });
  it("requests Cloud Code scopes", () => {
    expect(ANTIGRAVITY_SCOPES).toContain("https://www.googleapis.com/auth/cloud-platform");
    expect(ANTIGRAVITY_SCOPES).toContain("openid");
  });
  it("builds an offline auth URL", () => {
    const url = buildAuthUrl("http://127.0.0.1:53111/callback");
    expect(url.startsWith("https://accounts.google.com/o/oauth2/auth?")).toBe(true);
    const p = new URLSearchParams(url.split("?")[1]);
    expect(p.get("client_id")).toBe(ANTIGRAVITY_PUBLIC_CLIENT_ID);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
  });
});

describe("antigravity IDE metadata (ported from OmniRoute)", () => {
  it("builds wire metadata with enums", () => {
    const m = buildIdeMetadata();
    expect(m).toEqual({ ideType: 9, platform: m.platform, pluginType: 2 });
    expect(typeof m.platform).toBe("number");
  });
  it("resolves the platform enum per host", () => {
    expect(resolveAntigravityPlatformEnum("linux", "x64")).toBe(3);
    expect(resolveAntigravityPlatformEnum("darwin", "arm64")).toBe(2);
  });
  it("fingerprint headers pin the darwin/arm64 UA", () => {
    const h = buildFingerprintHeaders("tok");
    expect(h["User-Agent"]).toBe("antigravity/ide/2.5.5 darwin/arm64");
    expect(h.Authorization).toBe("Bearer tok");
  });
});

describe("loadCodeAssist", () => {
  it("posts metadata and extracts project + tier", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(init!.body as string) });
      return json({ cloudaicompanionProject: "my-gcp-project", currentTier: { id: "standard-tier" } });
    }) as typeof fetch;
    const r = await loadCodeAssist("tok", fetchFn);
    expect(r.projectId).toBe("my-gcp-project");
    expect(r.tierId).toBe("standard-tier");
    expect(calls[0].url).toBe("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
    const md = (calls[0].body as { metadata: Record<string, number> }).metadata;
    expect(md.ideType).toBe(9);
    expect(md.pluginType).toBe(2);
  });

  it("reads object-shaped cloudaicompanionProject", async () => {
    const fetchFn = (async () => json({ cloudaicompanionProject: { id: "obj-project" } })) as typeof fetch;
    const r = await loadCodeAssist("tok", fetchFn);
    expect(r.projectId).toBe("obj-project");
  });

  it("returns null project when not onboarded", async () => {
    const fetchFn = (async () => json({ currentTier: { id: "legacy-tier" } })) as typeof fetch;
    const r = await loadCodeAssist("tok", fetchFn);
    expect(r.projectId).toBeNull();
  });

  it("fails on non-OK", async () => {
    const fetchFn = (async () => new Response("x", { status: 403 })) as typeof fetch;
    await expect(loadCodeAssist("tok", fetchFn)).rejects.toThrow(/403/);
  });
});

describe("extractProjectId", () => {
  it("checks nested LRO response first", () => {
    expect(extractProjectId({ done: true, response: { cloudaicompanionProject: "p1" } })).toBe("p1");
  });
  it("checks the top level", () => {
    expect(extractProjectId({ cloudaicompanionProject: "p2" })).toBe("p2");
  });
  it("returns null for BYOP answers", () => {
    expect(extractProjectId({ done: true })).toBeNull();
    expect(extractProjectId(null)).toBeNull();
  });
});

describe("onboardUser payload shape + LRO polling", () => {
  it("payload carries tier_id and metadata", () => {
    const p = buildOnboardPayload("standard-tier");
    expect(p.tier_id).toBe("standard-tier");
    const md = p.metadata as Record<string, number>;
    expect(md.ideType).toBe(9);
    expect(md.pluginType).toBe(2);
  });

  it("polls while done:false then returns the project", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return calls < 3
        ? json({ done: false })
        : json({ done: true, response: { cloudaicompanionProject: "new-project" } });
    }) as typeof fetch;
    const project = await onboardUser("tok", "legacy-tier", fetchFn, { sleep: async () => {} });
    expect(project).toBe("new-project");
    expect(calls).toBe(3);
  });

  it("returns null for done:true with no project (BYOP)", async () => {
    const fetchFn = (async () => json({ done: true })) as typeof fetch;
    await expect(onboardUser("tok", "legacy-tier", fetchFn, { sleep: async () => {} })).resolves.toBeNull();
  });

  it("fails when the LRO never settles", async () => {
    const fetchFn = (async () => json({ done: false })) as typeof fetch;
    await expect(onboardUser("tok", "legacy-tier", fetchFn, { sleep: async () => {} })).rejects.toThrow(/did not settle/);
  });
});

describe("ensureProjectId", () => {
  it("uses the existing project when loadCodeAssist finds one", async () => {
    const fetchFn = (async (url: string) => {
      expect(url).toContain("loadCodeAssist");
      return json({ cloudaicompanionProject: "existing" });
    }) as typeof fetch;
    await expect(ensureProjectId("tok", fetchFn)).resolves.toBe("existing");
  });

  it("falls back to onboardUser when no project", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("loadCodeAssist")) return json({});
      return json({ done: true, response: { cloudaicompanionProject: "onboarded-project" } });
    }) as typeof fetch;
    await expect(ensureProjectId("tok", fetchFn)).resolves.toBe("onboarded-project");
  });
});

describe("OAuth token exchange + refresh", () => {
  it("exchangeCode posts an authorization_code grant to Google's token endpoint", async () => {
    let seenUrl = "";
    let form: URLSearchParams | null = null;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      form = new URLSearchParams(init!.body as string);
      return json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 });
    }) as typeof fetch;
    const tokens = await exchangeCode("code123", "http://127.0.0.1:53111/callback", fetchFn);
    expect(seenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(form!.get("grant_type")).toBe("authorization_code");
    expect(form!.get("code")).toBe("code123");
    expect(form!.get("redirect_uri")).toBe("http://127.0.0.1:53111/callback");
    expect(tokens.accessToken).toBe("AT");
    expect(tokens.refreshToken).toBe("RT");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it("refreshAccessToken uses the refresh_token grant", async () => {
    let form: URLSearchParams | null = null;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      form = new URLSearchParams(init!.body as string);
      return json({ access_token: "AT2", expires_in: 3600 });
    }) as typeof fetch;
    const fresh = await refreshAccessToken("RT", fetchFn);
    expect(form!.get("grant_type")).toBe("refresh_token");
    expect(fresh.accessToken).toBe("AT2");
  });

  it("loginWithRefreshToken saves a session with project + email", async () => {
    process.env.LLMSWITCH_SESSIONS_DIR = `/tmp/llmswitch-ag-test-${Date.now()}`;
    const fetchFn = (async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "ATL", expires_in: 3600 });
      if (url.includes("loadCodeAssist")) return json({ cloudaicompanionProject: "proj-xyz" });
      if (url.includes("userinfo")) return json({ email: "me@example.com" });
      return new Response("nf", { status: 404 });
    }) as typeof fetch;
    const saved = await loginWithRefreshToken("RT", fetchFn);
    expect(saved.accessToken).toBe("ATL");
    expect(saved.projectId).toBe("proj-xyz");
    expect(saved.email).toBe("me@example.com");
    const { loadAntigravitySession } = await import("../src/providers/antigravity.js");
    expect(loadAntigravitySession()?.projectId).toBe("proj-xyz");
    delete process.env.LLMSWITCH_SESSIONS_DIR;
  });
});
