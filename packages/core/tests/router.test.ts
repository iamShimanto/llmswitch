import { describe, expect, it } from "vitest";
import type { ResolvedProvider } from "../src/providers/types.js";
import { createRouter } from "../src/router/index.js";

function prov(id: string): ResolvedProvider {
  return {
    id,
    name: id,
    baseUrl: "https://example.com",
    wireFormat: "openai",
    models: ["m"],
    defaultModel: "m",
    costTier: 3,
    apiKey: "k",
  };
}

const body = { model: "auto", messages: [{ role: "user" as const, content: "hi" }] };

function jsonResponse(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

describe("router fallback", () => {
  it("falls back to next provider on 500", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      return calls.length === 1 ? new Response("boom", { status: 500 }) : jsonResponse("ok");
    }) as typeof fetch;

    const router = createRouter([prov("a"), prov("b")]);
    const res = await router.route(body, { fetchFn });
    expect(res.response!.choices[0]!.message.content).toBe("ok");
    expect(res.providerId).toBe("b");
    expect(router.stats.get("a")!.errors).toBe(1);
  });

  it("stops immediately on 401 (no retry)", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("bad key", { status: 401 });
    }) as typeof fetch;

    const router = createRouter([prov("a"), prov("b")]);
    await expect(router.route(body, { fetchFn })).rejects.toThrow("all providers failed");
    expect(calls).toBe(1); // did NOT try provider b
  });

  it("resolves explicit provider:model", async () => {
    const fetchFn = (async (url: string, init: any) => {
      expect(url).toBe("https://example.com/chat/completions");
      expect(JSON.parse(init.body).model).toBe("custom-model");
      return jsonResponse("ok");
    }) as typeof fetch;

    const router = createRouter([prov("a"), prov("b")]);
    const res = await router.route({ ...body, model: "b:custom-model" }, { fetchFn });
    expect(res.providerId).toBe("b");
  });

  it("throws when no providers connected", async () => {
    const router = createRouter([]);
    await expect(router.route(body)).rejects.toThrow("no providers connected");
  });
});
