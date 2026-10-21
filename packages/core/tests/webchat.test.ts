/**
 * P11-J — cookie web-session providers (core side).
 * Registry wiring, session-file connection checks, catalog shape, and an
 * end-to-end dispatch through the real DuckDuckGo pack driver with a
 * mocked fetch (no network, no live cookies).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeWebChatChat,
  hasWebChatCreds,
  WEBCHAT_PROVIDER_IDS,
} from "../src/executor/webchat.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { CATALOG_PROVIDERS } from "../src/providers/catalog.js";
import type { ResolvedProvider } from "../src/providers/types.js";
import { UpstreamError } from "../src/router/errors.js";

const EXPECTED_IDS = [
  "blackbox", "chatgpt-web", "chatgpt-web-free", "claude-web",
  "claude-web-cookie", "copilot-web", "deepai", "deepseek-web",
  "duckduckgo", "grok-web", "huggingchat", "lmarena", "manus", "poe",
  "venice-web", "you-com-web", "muse-spark-web", "gemini-web",
];

function tempEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "llmswitch-webchat-"));
  return { LLMSWITCH_SESSIONS_DIR: dir } as NodeJS.ProcessEnv;
}

function writeCookieSession(env: NodeJS.ProcessEnv, id: string, domain: string): void {
  writeFileSync(
    join(env.LLMSWITCH_SESSIONS_DIR!, `${id}.json`),
    JSON.stringify({ name: id, kind: "cookies", cookies: "session=abc123", cookieDomain: domain, savedAt: Date.now() }),
  );
}

describe("catalog: cookie providers (P11-J)", () => {
  it("all 18 ids exist with authType cookie", () => {
    const byId = new Map(CATALOG_PROVIDERS.map((p) => [p.id, p]));
    for (const id of EXPECTED_IDS) {
      const def = byId.get(id);
      expect(def, id).toBeDefined();
      expect(def!.authType, id).toBe("cookie");
      expect(def!.models.length, id).toBeGreaterThan(0);
      expect(def!.models, id).toContain(def!.defaultModel);
    }
    expect(WEBCHAT_PROVIDER_IDS.size).toBe(18);
    for (const id of EXPECTED_IDS) expect(WEBCHAT_PROVIDER_IDS.has(id)).toBe(true);
  });
});

describe("hasWebChatCreds + registry", () => {
  it("hidden without a session, connected with one (no secret values exposed)", () => {
    const env = tempEnv();
    const reg = new ProviderRegistry();
    expect(hasWebChatCreds("duckduckgo", env)).toBe(false);
    expect(reg.connected(env).some((p) => p.id === "duckduckgo")).toBe(false);

    writeCookieSession(env, "duckduckgo", "duck.ai");
    expect(hasWebChatCreds("duckduckgo", env)).toBe(true);
    const found = reg.connected(env).find((p) => p.id === "duckduckgo");
    expect(found).toBeDefined();
    expect(found!.apiKey).not.toContain("abc123");
  });

  it("unknown ids never report creds", () => {
    const env = tempEnv();
    writeCookieSession(env, "not-a-provider", "example.com");
    expect(hasWebChatCreds("not-a-provider", env)).toBe(false);
  });
});

describe("executeWebChatChat", () => {
  const provider: ResolvedProvider = {
    id: "duckduckgo",
    name: "DuckDuckGo Web",
    baseUrl: "https://duckduckgo.com",
    wireFormat: "openai",
    models: ["gpt-5.4-mini"],
    defaultModel: "gpt-5.4-mini",
    costTier: 1,
    apiKey: "oauth",
  };

  it("missing session → auth_error with the import hint", async () => {
    const env = tempEnv();
    await expect(
      executeWebChatChat(provider, "gpt-5.4-mini", { model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] }, fetch, 5_000, env),
    ).rejects.toMatchObject({ name: "UpstreamError" });
    try {
      await executeWebChatChat(provider, "gpt-5.4-mini", { model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] }, fetch, 5_000, env);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamError);
      expect((err as UpstreamError).kind).toBe("auth_error");
      expect((err as Error).message).toContain("llmswitch cookies duckduckgo");
    }
  });

  it("end-to-end through the pack DDG driver with mock fetch", async () => {
    const env = tempEnv();
    writeCookieSession(env, "duckduckgo", "duck.ai");
    const calls: string[] = [];
    const fetchFn = async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/duckchat/v1/status")) {
        return new Response("", { status: 200, headers: { "x-vqd-4": "tok-1" } });
      }
      if (u.includes("/duckchat/v1/chat")) {
        return new Response(
          'data: {"message":"Hello "}\n\ndata: {"message":"world"}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    const result = await executeWebChatChat(
      provider,
      "gpt-5.4-mini",
      { model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] },
      fetchFn as unknown as typeof fetch,
      5_000,
      env,
    );
    expect(result.providerId).toBe("duckduckgo");
    expect(result.response?.choices[0]?.message.content).toBe("Hello world");
    expect(calls.some((u) => u.includes("/duckchat/v1/status"))).toBe(true);
    expect(calls.some((u) => u.includes("/duckchat/v1/chat"))).toBe(true);
  });
});
