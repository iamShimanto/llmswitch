import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "../src/router/index.js";
import { ANTHROPIC_BETA_CLAUDE_OAUTH, buildClaudeOAuthHeaders } from "../src/executor/claudeOAuth.js";
import { buildCodexOAuthHeaders, CODEX_ORIGINATOR } from "../src/executor/codexOAuth.js";
import type { ResolvedProvider } from "../src/providers/types.js";

const NEW_TOKEN = "AT-REFRESHED-999";

function prov(id: string, baseUrl: string, wireFormat: ResolvedProvider["wireFormat"]): ResolvedProvider {
  return {
    id,
    name: id,
    baseUrl,
    wireFormat,
    models: ["m"],
    defaultModel: "m",
    costTier: 3,
    apiKey: "oauth",
    allKeys: ["oauth"],
    authType: "oauth",
  } as ResolvedProvider;
}

const body = { model: "claude:m", messages: [{ role: "user" as const, content: "hi" }] };

interface SeenCall {
  url: string;
  headers: Record<string, string>;
  bodyText: string;
}

function sseResponse(events: unknown[]): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("claude oauth headers (OmniRoute)", () => {
  it("token rides in x-api-key with the oauth beta set", () => {
    const h = buildClaudeOAuthHeaders("tok-1");
    expect(h["x-api-key"]).toBe("tok-1");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(h["anthropic-beta"]).toContain("claude-code-20250219");
    expect(h["authorization"]).toBeUndefined();
    expect(ANTHROPIC_BETA_CLAUDE_OAUTH).toContain("fine-grained-tool-streaming-2025-05-14");
  });
});

describe("codex oauth headers (OmniRoute)", () => {
  it("bearer + originator + account binding", () => {
    const h = buildCodexOAuthHeaders("tok-2", { accountId: "acct-1", sessionId: "sess-1" });
    expect(h["authorization"]).toBe("Bearer tok-2");
    expect(h["originator"]).toBe(CODEX_ORIGINATOR);
    expect(h["openai-beta"]).toBe("responses_websockets=2026-02-06");
    expect(h["chatgpt-account-id"]).toBe("acct-1");
    expect(h["session_id"]).toBe("sess-1");
  });
  it("omits account header without an account id", () => {
    expect(buildCodexOAuthHeaders("tok")["chatgpt-account-id"]).toBeUndefined();
  });
});

describe("router dispatch: claude oauth (refresh-on-expired)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lsw-claude-dispatch-"));
    process.env.LLMSWITCH_SESSIONS_DIR = dir;
    // expired session with a refresh token
    writeFileSync(
      join(dir, "claude.json"),
      JSON.stringify({ name: "claude", kind: "oauth-refresh", provider: "claude", accessToken: "OLD", refreshToken: "RT-1", expiresAt: Date.now() - 1000 }),
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.LLMSWITCH_SESSIONS_DIR;
  });

  it("refreshes the expired token, then calls Messages with the new token in x-api-key", async () => {
    const calls: SeenCall[] = [];
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, bodyText: String(init?.body ?? "") });
      if (url === "https://api.anthropic.com/v1/oauth/token") {
        return new Response(JSON.stringify({ access_token: NEW_TOKEN, expires_in: 3600 }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://api.anthropic.com/v1/messages")) {
        return new Response(
          JSON.stringify({
            id: "msg_1",
            content: [{ type: "text", text: "hello from claude" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 3, output_tokens: 4 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("nf", { status: 404 });
    }) as typeof fetch;

    const router = createRouter([prov("claude", "https://api.anthropic.com", "anthropic")]);
    const result = await router.route({ ...body, model: "claude:claude-sonnet-4-6" }, { fetchFn });
    expect(result.providerId).toBe("claude");
    expect(result.response?.choices[0]?.message.content).toBe("hello from claude");

    const upstream = calls.find((c) => c.url.includes("/v1/messages"))!;
    expect(upstream.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(upstream.headers["x-api-key"]).toBe(NEW_TOKEN);
    expect(upstream.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
  });
});

describe("router dispatch: codex oauth (refresh-on-expired)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lsw-codex-dispatch-"));
    process.env.LLMSWITCH_SESSIONS_DIR = dir;
    writeFileSync(
      join(dir, "codex.json"),
      JSON.stringify({
        name: "codex",
        kind: "oauth-refresh",
        provider: "codex",
        accessToken: "OLD",
        refreshToken: "RT-2",
        expiresAt: Date.now() - 1000,
        accountId: "acct-77",
      }),
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.LLMSWITCH_SESSIONS_DIR;
  });

  it("refreshes, then streams from the ChatGPT backend with bearer + originator + account id", async () => {
    const calls: SeenCall[] = [];
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, bodyText: String(init?.body ?? "") });
      if (url === "https://auth.openai.com/oauth/token") {
        return new Response(JSON.stringify({ access_token: NEW_TOKEN, expires_in: 3600 }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://chatgpt.com/backend-api/codex/responses") {
        return sseResponse([
          { type: "response.output_text.delta", delta: "hello " },
          { type: "response.output_text.delta", delta: "codex" },
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              output: [{ type: "message", content: [{ type: "output_text", text: "hello codex" }] }],
              usage: { input_tokens: 2, output_tokens: 2 },
            },
          },
        ]);
      }
      return new Response("nf", { status: 404 });
    }) as typeof fetch;

    const router = createRouter([prov("codex", "https://chatgpt.com/backend-api/codex", "openai")]);
    const result = await router.route({ model: "codex:gpt-5.5", messages: [{ role: "user", content: "hi" }] }, { fetchFn });
    expect(result.providerId).toBe("codex");
    expect(result.response?.choices[0]?.message.content).toBe("hello codex");

    const upstream = calls.find((c) => c.url.includes("chatgpt.com"))!;
    expect(upstream.headers["authorization"]).toBe(`Bearer ${NEW_TOKEN}`);
    expect(upstream.headers["originator"]).toBe("codex_cli_rs");
    expect(upstream.headers["chatgpt-account-id"]).toBe("acct-77");
    // forceStream: upstream is always asked for SSE
    expect(JSON.parse(upstream.bodyText).stream).toBe(true);
  });
});
