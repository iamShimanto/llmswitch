import { describe, expect, it, afterEach } from "vitest";
import { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { registry } from "../src/providers/registry.js";
import { executeProvider } from "../src/executor/http.js";
import { executeDuckDuckGoChat } from "../src/executor/duckduckgo.js";
import { createRouter } from "../src/router/index.js";
import { memoryStore } from "../src/store/db.js";
import { createServer as createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import type { ResolvedProvider } from "../src/providers/types.js";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const KEYLESS = ["pollinations", "kilo-gateway", "ovhcloud", "llm7", "duckduckgo-web"];

function jsonCompletion(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("keyless registry (authType \"none\")", () => {
  it("is always connected with an empty env (no API keys at all)", () => {
    const connected = registry.connected({});
    const ids = new Set(connected.map((p) => p.id));
    for (const id of KEYLESS) expect(ids.has(id)).toBe(true);
    for (const p of connected.filter((p) => KEYLESS.includes(p.id))) {
      expect(p.apiKey).toBe("");
      expect(p.allKeys).toEqual([""]); // non-empty pool slot for rotation
      expect(p.authType).toBe("none");
    }
  });

  it("also routes noAuth local providers (Ollama) — pre-existing '' key bug", async () => {
    const providers = registry.connected({});
    // simulate a noAuth local provider with no configured key at all
    const local = providers.find((p) => p.id === "pollinations")!;
    const ollamaLike: ResolvedProvider = {
      ...local,
      id: "ollama-like",
      name: "Ollama-like local",
      baseUrl: "https://local.example/v1",
      noAuth: true,
      authType: undefined,
      apiKey: "",
      allKeys: [""],
    };
    const router = createRouter([ollamaLike]);
    const fetchFn = (async () => jsonCompletion("local ok")) as typeof fetch;
    const res = await router.route(
      { model: "ollama-like:openai", messages: [{ role: "user" as const, content: "hi" }] },
      { fetchFn, strategy: "priority" },
    );
    expect(res.providerId).toBe("ollama-like");
    expect(res.response!.choices[0]!.message.content).toBe("local ok");
  });

  it("attaches an optional user key when configured, but never requires it", () => {
    const connected = registry.connected({ POLLINATIONS_API_KEY: "p-free-key" } as NodeJS.ProcessEnv);
    const p = connected.find((x) => x.id === "pollinations")!;
    expect(p.authType).toBe("none");
    expect(p.apiKey).toBe("p-free-key");
    expect(p.allKeys).toEqual(["p-free-key"]);
  });
});

describe("generic executor: no Authorization header when keyless", () => {
  async function capturedHeaders(apiKey: string): Promise<Record<string, string>> {
    let seen: Record<string, string> = {};
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = Object.fromEntries(new Headers(init.headers as HeadersInit).entries());
      return jsonCompletion("hi");
    }) as typeof fetch;
    const provider = {
      id: "pollinations",
      name: "Pollinations",
      baseUrl: "https://gen.pollinations.ai/v1",
      wireFormat: "openai" as const,
      models: ["openai"],
      defaultModel: "openai",
      costTier: 3 as const,
      authType: "none" as const,
      apiKey,
      allKeys: [apiKey],
    };
    await executeProvider(provider, "openai", { model: "openai", messages: [{ role: "user" as const, content: "hi" }] }, fetchFn);
    return seen;
  }

  it("omits the authorization header keyless (bad empty Bearer would 403)", async () => {
    const h = await capturedHeaders("");
    expect("authorization" in h).toBe(false);
    expect(h["content-type"]).toContain("application/json");
  });

  it("sends Bearer when an optional key is configured", async () => {
    const h = await capturedHeaders("p-free-key");
    expect(h.authorization).toBe("Bearer p-free-key");
  });
});

describe("router end-to-end with a keyless provider (no env vars)", () => {
  it("routes pollinations:openai through /v1-shaped flow without any auth header", async () => {
    const providers = registry.connected({});
    const router = createRouter(providers.filter((p) => p.id === "pollinations"));
    const seenHeaders: Record<string, string>[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      seenHeaders.push(Object.fromEntries(new Headers(init.headers as HeadersInit).entries()));
      return jsonCompletion("keyless ok");
    }) as typeof fetch;
    const res = await router.route(
      { model: "pollinations:openai", messages: [{ role: "user" as const, content: "hi" }] },
      { fetchFn, strategy: "priority" },
    );
    expect(res.providerId).toBe("pollinations");
    expect(res.response!.choices[0]!.message.content).toBe("keyless ok");
    expect("authorization" in seenHeaders[0]!).toBe(false);
  });
});

describe("duckduckgo-web executor", () => {
  function ddgProvider(overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
    return {
      id: "duckduckgo-web",
      name: "DuckDuckGo AI Chat",
      baseUrl: "https://duck.ai",
      wireFormat: "openai",
      models: ["gpt-5.4-mini"],
      defaultModel: "gpt-5.4-mini",
      costTier: 1,
      authType: "none",
      apiKey: "",
      allKeys: [""],
      ...overrides,
    };
  }

  it("status → VQD token → chat, fragments concatenated, no auth header", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init.headers as HeadersInit).entries());
      calls.push({ url, headers, body: init.body as string | undefined });
      if (url.endsWith("/duckchat/v1/status")) {
        return new Response("ok", {
          status: 200,
          headers: { "x-vqd-hash-1": "vqd-token-123" },
        });
      }
      const body =
        "data: " + JSON.stringify({ message: "Hello " }) + "\n\n" +
        "data: " + JSON.stringify({ message: "world" }) + "\n\n" +
        "data: [DONE]\n\n";
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const res = await executeDuckDuckGoChat(
      ddgProvider(),
      "gpt-5.4-mini",
      { model: "gpt-5.4-mini", messages: [{ role: "user" as const, content: "hi" }] },
      fetchFn,
    );
    expect(res.response!.choices[0]!.message.content).toBe("Hello world");
    expect(res.providerId).toBe("duckduckgo-web");
    const chat = calls.find((c) => c.url.endsWith("/duckchat/v1/chat"))!;
    expect(chat.headers["x-vqd-hash-1"]).toBe("vqd-token-123");
    expect("authorization" in chat.headers).toBe(false);
    // anonymous chat API forbids system/tool roles — system must be folded
    expect(chat.body).toContain("gpt-5.4-mini");
  });

  it("folds system prompts into a user turn (duck.ai accepts user/assistant only)", async () => {
    let payloadBody = "";
    const fetchFn = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/duckchat/v1/status")) {
        return new Response("ok", { status: 200, headers: { "x-vqd-4": "t" } });
      }
      payloadBody = init.body as string;
      return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    await executeDuckDuckGoChat(
      ddgProvider(),
      "gpt-5.4-mini",
      {
        model: "gpt-5.4-mini",
        messages: [
          { role: "system" as const, content: "Be brief." },
          { role: "user" as const, content: "hi" },
        ],
      },
      fetchFn,
    );
    const payload = JSON.parse(payloadBody) as { messages: Array<{ role: string; content: string }> };
    expect(payload.messages.some((m) => m.role === "system")).toBe(false);
    expect(payload.messages[0]!.content).toContain("Be brief.");
  });

  it("surfaces anti-bot errors honestly (418 ERR_CHALLENGE)", async () => {
    const fetchFn = (async (url: string) => {
      if (url.endsWith("/duckchat/v1/status")) {
        return new Response("ok", { status: 200, headers: { "x-vqd-hash-1": "t" } });
      }
      return new Response(JSON.stringify({ type: "ERR_CHALLENGE" }), { status: 418 });
    }) as typeof fetch;
    await expect(
      executeDuckDuckGoChat(
        ddgProvider(),
        "gpt-5.4-mini",
        { model: "gpt-5.4-mini", messages: [{ role: "user" as const, content: "hi" }] },
        fetchFn,
      ),
    ).rejects.toThrow(/anti-bot|418|challenge/i);
  });
});

describe("/api/providers exposes authType", () => {
  it("flags keyless providers for the dashboard badge", async () => {
    const providers = registry.connected({});
    const store = memoryStore();
    try {
      const { app } = createApp(loadConfig(), providers, store);
      const srv = app.listen(0, "127.0.0.1");
      servers.push(srv);
      await new Promise<void>((r) => srv.on("listening", r));
      const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      const list = (await (await fetch(`${base}/api/providers`)).json()) as Array<{
        id: string;
        authType: string;
      }>;
      const byId = new Map(list.map((p) => [p.id, p]));
      for (const id of KEYLESS) {
        expect(byId.get(id)?.authType, id).toBe("none");
      }
      expect(list.length).toBeGreaterThanOrEqual(KEYLESS.length);
    } finally {
      store.close();
    }
  });
});
