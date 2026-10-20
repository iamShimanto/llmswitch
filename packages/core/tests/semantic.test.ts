import { describe, expect, it } from "vitest";
import { cosine, ProviderEmbedder, SemanticCache, TfIdfEmbedder } from "../src/cache/semantic.js";
import { createRouter } from "../src/router/index.js";
import type { ChatCompletionResponse, ResolvedProvider } from "../src/providers/types.js";

function prov(id: string): ResolvedProvider {
  return {
    id, name: id, baseUrl: "https://example.com", wireFormat: "openai",
    models: ["m"], defaultModel: "m", costTier: 3, apiKey: "k",
  };
}

function resp(text: string): ChatCompletionResponse {
  return {
    id: "x", model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

describe("TfIdfEmbedder", () => {
  it("identical texts have cosine 1", async () => {
    const e = new TfIdfEmbedder();
    const [a, b] = await e.embed(["the quick brown fox", "the quick brown fox"]);
    expect(cosine(a!, b!)).toBeCloseTo(1, 6);
  });

  it("unrelated texts have low cosine", async () => {
    const e = new TfIdfEmbedder();
    const [a, b] = await e.embed(["quantum chromodynamics", "chocolate cake recipe"]);
    expect(cosine(a!, b!)).toBeLessThan(0.3);
  });
});

describe("SemanticCache", () => {
  it("matches paraphrases above threshold", async () => {
    const c = new SemanticCache(new TfIdfEmbedder(), 0.5);
    await c.add("What is the capital city of France?", resp("Paris"));
    const hit = await c.find("What is the capital of France?");
    expect(hit).not.toBeNull();
    expect(hit!.response.choices[0]!.message.content).toBe("Paris");
  });

  it("misses unrelated prompts", async () => {
    const c = new SemanticCache(new TfIdfEmbedder(), 0.92);
    await c.add("What is the capital city of France?", resp("Paris"));
    expect(await c.find("Explain quantum entanglement")).toBeNull();
  });

  it("empty cache → null", async () => {
    expect(await new SemanticCache().find("hi")).toBeNull();
  });

  it("promptText uses the last user message", () => {
    expect(
      SemanticCache.promptText([
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ]),
    ).toBe("second");
  });
});

describe("router semantic integration", () => {
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

  it("serves paraphrased prompts from semantic cache", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return jsonResponse("live answer");
    }) as typeof fetch;

    const semantic = new SemanticCache(new TfIdfEmbedder(), 0.5);
    const router = createRouter([prov("a")], { semantic });
    const msg = (t: string) => ({ role: "user" as const, content: t });

    // exact bytes differ → exact cache misses; semantic should still hit
    await router.route({ model: "auto", messages: [msg("What is the capital city of France?")] }, { fetchFn });
    expect(calls).toBe(1);

    const r2 = await router.route(
      { model: "auto", messages: [msg("What is the capital of France?")] },
      { fetchFn },
    );
    expect(r2.cached).toBe(true);
    expect(calls).toBe(1); // no second upstream call
  });
});

describe("ProviderEmbedder", () => {
  const V = {
    cat: [1, 0, 0],
    dog: [0.9, 0.1, 0],
    car: [0, 0, 1],
  };
  const mockEmbed = async (texts: string[]): Promise<number[][]> =>
    texts.map((t) => V[t as keyof typeof V] ?? [0.33, 0.33, 0.33]);

  it("matches via provider vectors + cosine threshold", async () => {
    const c = new SemanticCache(new ProviderEmbedder(mockEmbed), 0.9);
    await c.add("cat", resp("meow"));
    const hit = await c.find("dog");
    expect(hit).not.toBeNull();
    expect(hit!.response.choices[0]!.message.content).toBe("meow");
    expect(hit!.score).toBeGreaterThan(0.9);
    const miss = await c.find("car");
    expect(miss).toBeNull();
  });

  it("falls back to TF-IDF when the provider call fails", async () => {
    const failing = async (_texts: string[]): Promise<number[][]> => {
      throw new Error("upstream down");
    };
    const c = new SemanticCache(new ProviderEmbedder(failing), 0.5);
    await c.add("What is the capital city of France?", resp("Paris"));
    const hit = await c.find("What is the capital of France?");
    expect(hit).not.toBeNull();
    expect(hit!.response.choices[0]!.message.content).toBe("Paris");
  });

  it("falls back on wrong-shaped provider response", async () => {
    const bad = async (texts: string[]): Promise<number[][]> => [[1, 2]]; // wrong length
    const e = new ProviderEmbedder(bad);
    const vectors = await e.embed(["a", "b"]);
    expect(vectors.length).toBe(2); // TF-IDF fallback produced per-text vectors
  });
});
