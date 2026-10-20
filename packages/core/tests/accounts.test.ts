import { describe, expect, it } from "vitest";
import { AccountPool, collectKeys } from "../src/accounts/index.js";
import { createRouter } from "../src/router/index.js";
import type { ResolvedProvider } from "../src/providers/types.js";

function prov(id: string, keys: string[]): ResolvedProvider {
  return {
    id,
    name: id,
    baseUrl: "https://example.com",
    wireFormat: "openai",
    models: ["m"],
    defaultModel: "m",
    costTier: 3,
    apiKey: keys[0] ?? "",
    allKeys: keys,
  };
}

function jsonResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const body = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };

describe("collectKeys", () => {
  it("reads comma-separated PLURAL form", () => {
    expect(collectKeys("GROQ_API_KEY", { GROQ_API_KEYS: "a, b ,c" } as NodeJS.ProcessEnv)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
  it("reads indexed _1.._N form", () => {
    expect(
      collectKeys("GROQ_API_KEY", { GROQ_API_KEY_1: "a", GROQ_API_KEY_2: "b" } as NodeJS.ProcessEnv),
    ).toEqual(["a", "b"]);
  });
  it("falls back to single key", () => {
    expect(collectKeys("GROQ_API_KEY", { GROQ_API_KEY: "a" } as NodeJS.ProcessEnv)).toEqual(["a"]);
  });
  it("prefers plural over indexed/single and dedupes", () => {
    expect(
      collectKeys("GROQ_API_KEY", {
        GROQ_API_KEYS: "a,a,b",
        GROQ_API_KEY_1: "z",
        GROQ_API_KEY: "y",
      } as NodeJS.ProcessEnv),
    ).toEqual(["a", "b"]);
  });
  it("returns [] when nothing set", () => {
    expect(collectKeys("GROQ_API_KEY", {} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("AccountPool", () => {
  it("round-robins across keys", () => {
    const p = new AccountPool(["a", "b", "c"]);
    expect([p.next(), p.next(), p.next(), p.next()]).toEqual(["a", "b", "c", "a"]);
  });
  it("skips cooling keys after failure", () => {
    const p = new AccountPool(["a", "b"]);
    expect(p.next()).toBe("a");
    p.reportFailure("a");
    expect(p.healthy()).toBe(1);
    expect(p.next()).toBe("b");
    expect(p.next()).toBe("b"); // a still cooling
  });
  it("success clears cooldown", () => {
    const p = new AccountPool(["a", "b"]);
    p.reportFailure("a");
    p.reportSuccess("a");
    expect(p.healthy()).toBe(2);
  });
  it("returns null when all cooling", () => {
    const p = new AccountPool(["a"]);
    p.reportFailure("a");
    expect(p.next()).toBeNull();
  });
  it("status() leaks no key values", () => {
    const p = new AccountPool(["secret-1", "secret-2"]);
    const s = JSON.stringify(p.status());
    expect(s).not.toContain("secret-1");
    expect(s).not.toContain("secret-2");
    expect(p.status()).toEqual({ total: 2, healthy: 2 });
  });
});

describe("router key rotation", () => {
  it("falls from a 401 key to the next key", async () => {
    const seen: string[] = [];
    const fetchFn = (async (_url: string, init: { headers: Record<string, string> }) => {
      const auth = init.headers.authorization ?? "";
      seen.push(auth);
      if (auth.includes("bad-key")) return new Response("unauthorized", { status: 401 });
      return jsonResponse("ok");
    }) as typeof fetch;

    const router = createRouter([prov("a", ["bad-key", "good-key"])]);
    const result = await router.route(body, { fetchFn });
    expect(result.response?.choices[0]?.message.content).toBe("ok");
    expect(seen).toEqual(["Bearer bad-key", "Bearer good-key"]);
    // bad key is cooling FOR THIS MODEL (auth cooldowns are model-scoped);
    // model-agnostic health still counts it, other models can use it.
    expect(router.pools.get("a")!.healthy(Date.now(), body.model)).toBe(1);
    expect(router.pools.get("a")!.healthy()).toBe(2);
  });

  it("falls from a 429 key to the next key", async () => {
    const fetchFn = (async (_url: string, init: { headers: Record<string, string> }) => {
      return init.headers.authorization?.includes("k1")
        ? new Response("limited", { status: 429 })
        : jsonResponse("ok");
    }) as typeof fetch;

    const router = createRouter([prov("a", ["k1", "k2"])]);
    const result = await router.route(body, { fetchFn });
    expect(result.response?.choices[0]?.message.content).toBe("ok");
  });

  it("throws when all keys are bad", async () => {
    const fetchFn = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    const router = createRouter([prov("a", ["k1", "k2"])]);
    await expect(router.route(body, { fetchFn })).rejects.toThrow(/all providers failed/);
    // both keys are cooled for the requested model…
    expect(router.pools.get("a")!.healthy(Date.now(), body.model)).toBe(0);
    // …but not provider-wide (a 401 can be model entitlement, not a dead key)
    expect(router.pools.get("a")!.healthy()).toBe(2);
  });

  it("single-key providers behave as before", async () => {
    const fetchFn = (async () => jsonResponse("solo")) as typeof fetch;
    const router = createRouter([prov("a", ["only"])]);
    const result = await router.route(body, { fetchFn });
    expect(result.response?.choices[0]?.message.content).toBe("solo");
    expect(router.pools.get("a")!.status()).toEqual({ total: 1, healthy: 1 });
  });
});

describe("AccountPool model-scoped auth cooldowns", () => {
  it("an auth failure on one model does not block the key for other models", () => {
    const p = new AccountPool(["k1"], 60_000);
    const t0 = 1_000_000;
    p.reportFailure("k1", t0, "model-a");
    // same model: blocked
    expect(p.next(new Set(), t0 + 1, "round-robin", "model-a")).toBeNull();
    // different model: the key is served
    expect(p.next(new Set(), t0 + 1, "round-robin", "model-b")).toBe("k1");
    // healthy() is model-aware
    expect(p.healthy(t0 + 1, "model-a")).toBe(0);
    expect(p.healthy(t0 + 1, "model-b")).toBe(1);
    // after the cooldown the pair recovers
    expect(p.next(new Set(), t0 + 61_000, "round-robin", "model-a")).toBe("k1");
  });

  it("a key-wide failure (rate limit) still blocks every model", () => {
    const p = new AccountPool(["k1"], 60_000);
    const t0 = 2_000_000;
    p.reportFailure("k1", t0);
    expect(p.next(new Set(), t0 + 1, "round-robin", "model-a")).toBeNull();
    expect(p.next(new Set(), t0 + 1, "round-robin", "model-b")).toBeNull();
  });

  it("a success clears model-scoped cooldowns for that key", () => {
    const p = new AccountPool(["k1"], 60_000);
    const t0 = 3_000_000;
    p.reportFailure("k1", t0, "model-a");
    p.reportSuccess("k1");
    expect(p.next(new Set(), t0 + 1, "round-robin", "model-a")).toBe("k1");
  });
});
