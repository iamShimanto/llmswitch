import { describe, expect, it } from "vitest";
import { PromptCache } from "../src/cache/index.js";
import { createRouter } from "../src/router/index.js";
import type { ChatCompletionResponse, ResolvedProvider } from "../src/providers/types.js";

function prov(id: string): ResolvedProvider {
  return {
    id, name: id, baseUrl: "https://example.com", wireFormat: "openai",
    models: ["m"], defaultModel: "m", costTier: 3, apiKey: "k",
  };
}

const body = { model: "auto", messages: [{ role: "user" as const, content: "hi" }] };

function resp(text: string): ChatCompletionResponse {
  return {
    id: "x", model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

describe("PromptCache", () => {
  it("miss → set → hit", () => {
    const c = new PromptCache();
    const k = c.key("a", "m", body);
    expect(c.get(k)).toBeNull();
    c.set(k, resp("hello"));
    expect(c.get(k)!.choices[0]!.message.content).toBe("hello");
    expect(c.stats().hits).toBe(1);
    expect(c.stats().misses).toBe(1);
  });

  it("expires entries after TTL", () => {
    const c = new PromptCache(1000);
    const k = c.key("a", "m", body);
    c.set(k, resp("x"), 0);
    expect(c.get(k, 999)).not.toBeNull();
    expect(c.get(k, 1001)).toBeNull();
  });

  it("keys differ per provider/model/messages", () => {
    const c = new PromptCache();
    const k1 = c.key("a", "m", body);
    const k2 = c.key("b", "m", body);
    const k3 = c.key("a", "m", { ...body, messages: [{ role: "user" as const, content: "bye" }] });
    expect(new Set([k1, k2, k3]).size).toBe(3);
  });

  it("evicts oldest when full", () => {
    const c = new PromptCache(60_000, 2);
    c.set("k1", resp("1"));
    c.set("k2", resp("2"));
    c.set("k3", resp("3"));
    expect(c.get("k1")).toBeNull();
    expect(c.get("k3")).not.toBeNull();
  });
});

describe("router cache integration", () => {
  function jsonResponse(text: string): Response {
    return new Response(
      JSON.stringify({
        id: "x", model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  it("second identical request is served from cache (no upstream call)", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return jsonResponse("live");
    }) as typeof fetch;

    const router = createRouter([prov("a")], { cache: new PromptCache() });
    const r1 = await router.route(body, { fetchFn });
    expect(r1.cached).not.toBe(true);
    const r2 = await router.route(body, { fetchFn });
    expect(r2.cached).toBe(true);
    expect(r2.response!.choices[0]!.message.content).toBe("live");
    expect(calls).toBe(1);
  });

  it("bypassCache forces upstream", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return jsonResponse("live");
    }) as typeof fetch;

    const router = createRouter([prov("a")], { cache: new PromptCache() });
    await router.route(body, { fetchFn });
    await router.route(body, { fetchFn, bypassCache: true });
    expect(calls).toBe(2);
  });

  it("streaming requests are cached in v2 (assembled + replayed)", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const router = createRouter([prov("a")], { cache: new PromptCache() });
    const r1 = await router.route({ ...body, stream: true }, { fetchFn });
    expect(r1.cached).not.toBe(true);
    // drain — the tap assembles the completed stream into the cache
    for await (const _ of r1.stream!) { /* noop */ }
    const r2 = await router.route({ ...body, stream: true }, { fetchFn });
    expect(r2.cached).toBe(true);
    expect(calls).toBe(1);
    // the replayed stream is consumable
    let replayed = 0;
    for await (const _ of r2.stream!) replayed++;
    expect(replayed).toBeGreaterThan(0);
  });
});
