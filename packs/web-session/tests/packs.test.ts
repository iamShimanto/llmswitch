import { describe, expect, it } from "vitest";
import { CookieJar } from "../src/cookieJar.js";
import { OAuth2Client } from "../src/oauth2.js";
import { PACKS, ChatGptWeb } from "../src/packs/index.js";

describe("CookieJar", () => {
  it("loads raw header cookies and scopes by domain", () => {
    const j = new CookieJar();
    j.load("session=abc; theme=dark", "chatgpt.com");
    expect(j.headerFor("https://chatgpt.com/api/x")).toBe("session=abc; theme=dark");
    expect(j.headerFor("https://other.com/api")).toBe("");
  });

  it("loads Netscape format", () => {
    const j = new CookieJar();
    j.load(".chatgpt.com\tTRUE\t/\tTRUE\t0\tsession\tabc123", "chatgpt.com");
    expect(j.headerFor("https://chatgpt.com/")).toBe("session=abc123");
    expect(j.size()).toBe(1);
  });

  it("drops expired cookies", () => {
    const j = new CookieJar();
    j.set({ name: "a", value: "1", domain: "x.com", path: "/", expires: Date.now() - 1000 });
    j.set({ name: "b", value: "2", domain: "x.com", path: "/", expires: null });
    expect(j.headerFor("https://x.com/")).toBe("b=2");
  });

  it("ingests Set-Cookie headers", () => {
    const j = new CookieJar();
    j.ingest(["sid=xyz; Path=/; Max-Age=3600; Domain=example.com"], "https://example.com/login");
    expect(j.headerFor("https://example.com/app")).toBe("sid=xyz");
  });
});

describe("OAuth2Client", () => {
  it("refreshes and caches the token", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(JSON.stringify({ access_token: "tok123", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    const c = new OAuth2Client(
      { tokenUrl: "https://x.test/token", clientId: "cid", refreshToken: "rt" },
      fetchFn,
    );
    expect(await c.token()).toBe("tok123");
    expect(await c.token()).toBe("tok123");
    expect(calls).toBe(1); // cached
  });

  it("throws on refresh failure", async () => {
    const fetchFn = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    const c = new OAuth2Client(
      { tokenUrl: "https://x.test/token", clientId: "cid", refreshToken: "bad" },
      fetchFn,
    );
    await expect(c.token()).rejects.toThrow("HTTP 401");
  });
});

describe("packs", () => {
  it("five experimental packs with ToS warnings", () => {
    expect(PACKS).toHaveLength(5);
    for (const p of PACKS) {
      expect(p.status).toBe("experimental");
      expect(p.tosWarning.length).toBeGreaterThan(50);
      // every pack declares its credential path: env vars, or a login command
      expect(p.requiredEnv.length > 0 || /login/.test(p.setupHint)).toBe(true);
    }
    expect(PACKS.map((p) => p.id).sort()).toEqual(
      ["antigravity", "chatgpt-web", "claude-web", "copilot-web", "grok-web"],
    );
  });

  it("pack requires its env var", () => {
    const p = new ChatGptWeb();
    expect(() => p.loadSession({} as NodeJS.ProcessEnv)).toThrow("CHATGPT_WEB_COOKIES");
    expect(() => p.loadSession({ CHATGPT_WEB_COOKIES: "s=1" } as NodeJS.ProcessEnv)).not.toThrow();
  });
});
