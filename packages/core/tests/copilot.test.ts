import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CopilotAuthError,
  buildCopilotChatHeaders,
  clearCopilotTokenCache,
  copilotClientId,
  executeCopilotChat,
  hasCopilotCreds,
  resolveCopilotCreds,
} from "../src/executor/copilot.js";
import type { ResolvedProvider } from "../src/providers/types.js";
import type { ExecuteResult } from "../src/executor/http.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const provider: ResolvedProvider = {
  id: "github",
  name: "GitHub Copilot",
  baseUrl: "https://api.githubcopilot.com",
  wireFormat: "openai",
  authType: "oauth",
  apiKey: "oauth",
  allKeys: ["oauth"],
  models: ["gpt-5.6-sol"],
  defaultModel: "gpt-5.6-sol",
  costTier: 1,
};

const gheProvider: ResolvedProvider = { ...provider, id: "ghe-copilot", name: "GitHub Enterprise Copilot" };

const body = { model: "gpt-5.6-sol", messages: [{ role: "user" as const, content: "hi" }] };

let dir = "";
function seed(kind: "github" | "ghe", fields: Record<string, unknown>): void {
  const name = kind === "ghe" ? "ghe-copilot.json" : "github-copilot.json";
  writeFileSync(join(dir, name), JSON.stringify(fields, null, 2));
  chmodSync(join(dir, name), 0o600);
}
function env(): NodeJS.ProcessEnv {
  return { LLMSWITCH_SESSIONS_DIR: dir } as NodeJS.ProcessEnv;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "core-copilot-"));
  clearCopilotTokenCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearCopilotTokenCache();
});

describe("copilot public client id (from OmniRoute)", () => {
  it("defaults to the public device-flow client and honors env override", () => {
    expect(copilotClientId({} as NodeJS.ProcessEnv)).toBe("Iv1.b507a08c87ecfe98");
    expect(copilotClientId({ GITHUB_OAUTH_CLIENT_ID: "Iv1.custom" } as NodeJS.ProcessEnv)).toBe("Iv1.custom");
  });
  it("builds the CLI fingerprint header set", () => {
    const h = buildCopilotChatHeaders("tok-1", { GITHUB_COPILOT_MACHINE_ID: "m-9" } as NodeJS.ProcessEnv);
    expect(h["copilot-integration-id"]).toBe("copilot-developer-cli");
    expect(h["editor-version"]).toBe("copilot/1.0.91");
    expect(h["openai-intent"]).toBe("conversation-agent");
    expect(h["x-github-api-version"]).toBe("2026-08-01");
    expect(h["x-client-machine-id"]).toBe("m-9");
    expect(h["X-Initiator"]).toBe("user");
    expect(typeof h["authorization"]).toBe("string");
  });
});

describe("hasCopilotCreds", () => {
  it("is false with no session and no env tokens", () => {
    expect(hasCopilotCreds(env(), "github")).toBe(false);
  });
  it("is true with a session file or an env token", () => {
    seed("github", { accessToken: "t" });
    expect(hasCopilotCreds(env(), "github")).toBe(true);
    expect(hasCopilotCreds({ ...env(), COPILOT_OAUTH_TOKEN: "env-tok" } as NodeJS.ProcessEnv, "ghe-copilot")).toBe(true);
  });
});

describe("resolveCopilotCreds / executeCopilotChat (mock fetch)", () => {
  it("no creds → typed CopilotAuthError with login hint", async () => {
    const fetchFn = async () => json({});
    await expect(resolveCopilotCreds(env(), fetchFn as typeof fetch, "github")).rejects.toMatchObject({
      name: "CopilotAuthError",
    });
    await expect(
      executeCopilotChat(provider, "gpt-5.6-sol", body, fetchFn as unknown as typeof fetch, 5_000, env()),
    ).rejects.toThrow(/llmswitch login copilot/);
  });

  it("exchanges the session github token, then dispatches chat with CLI headers + copilot bearer", async () => {
    seed("github", { accessToken: "GH_TOKEN_MOCK", refreshToken: "GH_REFRESH_MOCK" });
    const seen: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    const fetchFn = async (url: any, init: any) => {
      const u = String(url);
      const headers = { ...(init.headers ?? {}) } as Record<string, string>;
      seen.push({ url: u, headers, body: init.body ? String(init.body) : undefined });
      if (u.endsWith("/copilot_internal/v2/token")) {
        return json({
          token: "CP_SHORT_MOCK",
          expires_at: Math.floor(Date.now() / 1000) + 1800,
          endpoints: { api: "https://api.individual.githubcopilot.com" },
        });
      }
      if (u.endsWith("/chat/completions")) {
        return json({
          id: "chatcmpl-1",
          model: "gpt-5.6-sol",
          choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        });
      }
      throw new Error(`unexpected ${u}`);
    };
    const r: ExecuteResult = await executeCopilotChat(
      provider, "gpt-5.6-sol", body, fetchFn as unknown as typeof fetch, 5_000, env(),
    );
    expect(r.response?.choices[0]?.message.content).toBe("hello");
    // exchange went first, with token auth against api.github.com
    expect(seen[0]!.url).toBe("https://api.github.com/copilot_internal/v2/token");
    expect(seen[0]!.headers["User-Agent"]).toBe("GithubCopilot/1.0");
    // chat endpoint host came from the exchange's endpoints.api
    expect(seen[1]!.url).toBe("https://api.individual.githubcopilot.com/chat/completions");
    expect(seen[1]!.headers["copilot-integration-id"]).toBe("copilot-developer-cli");
    expect(seen[1]!.headers["editor-version"]).toBe("copilot/1.0.91");
    // bearer carries the short-lived copilot token, never the github token
    const auth = seen[1]!.headers["authorization"] ?? "";
    expect(auth.endsWith("CP_SHORT_MOCK")).toBe(true);
    expect(auth.includes("GH_TOKEN_MOCK")).toBe(false);
  });

  it("caches the exchanged token in memory (second call skips the exchange)", async () => {
    seed("github", { accessToken: "GH_TOKEN_MOCK", copilotToken: "", copilotTokenExpiresAt: 0 });
    let exchanges = 0;
    const fetchFn = async (url: any) => {
      const u = String(url);
      if (u.endsWith("/copilot_internal/v2/token")) {
        exchanges++;
        return json({ token: "CP_" + exchanges, expires_at: Math.floor(Date.now() / 1000) + 1800 });
      }
      return json({ id: "x", model: "gpt-5.6-sol", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    };
    await executeCopilotChat(provider, "gpt-5.6-sol", body, fetchFn as unknown as typeof fetch, 5_000, env());
    await executeCopilotChat(provider, "gpt-5.6-sol", body, fetchFn as unknown as typeof fetch, 5_000, env());
    expect(exchanges).toBe(1);
  });

  it("falls back to the refresh_token grant when the exchange rejects the github token", async () => {
    seed("github", { accessToken: "GH_EXPIRED_MOCK", refreshToken: "GH_REFRESH_MOCK" });
    let tokenPosts = 0;
    const fetchFn = async (url: any, init: any) => {
      const u = String(url);
      if (u.endsWith("/copilot_internal/v2/token")) {
        const auth = (init.headers["authorization"] ?? "") as string;
        return auth.includes("GH_FRESH_MOCK")
          ? json({ token: "CP_AFTER_REFRESH", expires_at: Math.floor(Date.now() / 1000) + 1800 })
          : json({ message: "expired" }, 401);
      }
      if (u.endsWith("/login/oauth/access_token")) {
        tokenPosts++;
        const params = new URLSearchParams(String(init.body));
        expect(params.get("grant_type")).toBe("refresh_token");
        expect(params.get("client_id")).toBe("Iv1.b507a08c87ecfe98");
        expect(params.has("client_secret")).toBe(false); // public client — never a secret
        return json({ access_token: "GH_FRESH_MOCK", refresh_token: "GH_REFRESH2_MOCK" });
      }
      return json({ id: "x", model: "gpt-5.6-sol", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    };
    const creds = await resolveCopilotCreds(env(), fetchFn as typeof fetch, "github");
    expect(creds.copilotToken).toBe("CP_AFTER_REFRESH");
    expect(tokenPosts).toBe(1);
  });

  it("uses the stored fresh copilot token without any network call", async () => {
    seed("github", {
      accessToken: "GH_TOKEN_MOCK",
      copilotToken: "CP_STORED_FRESH",
      copilotTokenExpiresAt: Date.now() + 3600_000,
      copilotApiUrl: "https://api.githubcopilot.com",
    });
    const fetchFn = async () => {
      throw new Error("network must not be touched");
    };
    const creds = await resolveCopilotCreds(env(), fetchFn as typeof fetch, "github");
    expect(creds.copilotToken).toBe("CP_STORED_FRESH");
  });

  it("ghe-copilot: force-streams upstream and drains SSE into one JSON response", async () => {
    seed("ghe", {
      accessToken: "GH_TOKEN_MOCK",
      copilotToken: "CP_GHE_FRESH",
      copilotTokenExpiresAt: Date.now() + 3600_000,
      copilotApiUrl: "https://copilot.ghe.example.com",
      gheHost: "https://ghe.example.com",
    });
    let upstreamBody: any = null;
    const fetchFn = async (url: any, init: any) => {
      const u = String(url);
      expect(u).toBe("https://copilot.ghe.example.com/chat/completions");
      upstreamBody = JSON.parse(String(init.body));
      const sse =
        'data: {"id":"chatcmpl-g","choices":[{"index":0,"delta":{"role":"assistant","content":"he"},"finish_reason":null}]}\n\n' +
        'data: {"id":"chatcmpl-g","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":null}]}\n\n' +
        'data: {"id":"chatcmpl-g","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n' +
        "data: [DONE]\n\n";
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    // client asked non-stream; GHE must still be called with stream:true
    const r = await executeCopilotChat(gheProvider, "gpt-5.6-sol", body, fetchFn as unknown as typeof fetch, 5_000, env());
    expect(upstreamBody.stream).toBe(true);
    expect(r.response?.choices[0]?.message.content).toBe("hello");
    expect(r.response?.choices[0]?.finish_reason).toBe("stop");
    expect(r.response?.usage?.total_tokens).toBe(4);
  });

  it("ghe-copilot without a host raises a typed error with a host hint", async () => {
    seed("ghe", { accessToken: "GH_TOKEN_MOCK" });
    const fetchFn = async () => json({});
    await expect(resolveCopilotCreds(env(), fetchFn as typeof fetch, "ghe-copilot")).rejects.toThrow(/GHE_COPILOT_HOST/);
  });
});
