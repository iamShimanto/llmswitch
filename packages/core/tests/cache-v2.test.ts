import { describe, expect, it } from "vitest";
import { PromptCache, stableStringify, type CachePersister } from "../src/cache/index.js";
import { SemanticCache } from "../src/cache/semantic.js";
import { replayStream, tapStream } from "../src/cache/stream.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/providers/types.js";

const baseBody: ChatCompletionRequest = {
  model: "auto",
  messages: [{ role: "user", content: "hi" }],
};

function resp(text: string): ChatCompletionResponse {
  return {
    id: "x",
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  } as ChatCompletionResponse;
}

describe("cache v2 — key strength", () => {
  const c = new PromptCache();
  const k0 = c.key("a", "m", baseBody);

  it("is stable for identical requests", () => {
    expect(c.key("a", "m", { ...baseBody })).toBe(k0);
  });

  it("changes with every generation parameter (v1 missed these)", () => {
    const variants: ChatCompletionRequest[] = [
      { ...baseBody, top_p: 0.5 },
      { ...baseBody, stop: ["END"] },
      { ...baseBody, seed: 42 },
      { ...baseBody, frequency_penalty: 0.3 },
      { ...baseBody, presence_penalty: 0.3 },
      { ...baseBody, response_format: { type: "json_object" } },
      { ...baseBody, user: "someone" },
      { ...baseBody, temperature: 0.7 },
      { ...baseBody, max_tokens: 10 },
    ];
    for (const v of variants) expect(c.key("a", "m", v)).not.toBe(k0);
  });

  it("is namespace-isolated per gateway key", () => {
    expect(c.key("a", "m", baseBody, "key-1")).not.toBe(c.key("a", "m", baseBody, "key-2"));
    expect(c.key("a", "m", baseBody, "key-1")).toBe(c.key("a", "m", baseBody, "key-1"));
    // and a namespaced entry is not visible without the namespace
    const c2 = new PromptCache();
    c2.set(c2.key("a", "m", baseBody, "key-1"), resp("secret"));
    expect(c2.get(c2.key("a", "m", baseBody, "key-2"))).toBeNull();
    expect(c2.get(c2.key("a", "m", baseBody))).toBeNull();
    expect(c2.get(c2.key("a", "m", baseBody, "key-1"))).not.toBeNull();
  });

  it("ignores object key order in parameters (stable stringify)", () => {
    expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 4 }, b: 1 }));
    const t1 = c.key("a", "m", { ...baseBody, tools: [{ type: "function", function: { name: "f", parameters: { x: 1, y: 2 } } }] as never });
    const t2 = c.key("a", "m", { ...baseBody, tools: [{ type: "function", function: { parameters: { y: 2, x: 1 }, name: "f" } }] as never });
    expect(t1).toBe(t2);
  });
});

describe("cache v2 — LRU + cloning", () => {
  it("evicts the least recently USED entry, not the oldest inserted", () => {
    const c = new PromptCache(60_000, 2);
    const ka = c.key("a", "m", { ...baseBody, messages: [{ role: "user", content: "A" }] });
    const kb = c.key("a", "m", { ...baseBody, messages: [{ role: "user", content: "B" }] });
    const kc = c.key("a", "m", { ...baseBody, messages: [{ role: "user", content: "C" }] });
    c.set(ka, resp("a"));
    c.set(kb, resp("b"));
    expect(c.get(ka)).not.toBeNull(); // touch A → B becomes LRU
    c.set(kc, resp("c"));
    expect(c.get(kb)).toBeNull();
    expect(c.get(ka)).not.toBeNull();
    expect(c.get(kc)).not.toBeNull();
  });

  it("clones on set and get — callers cannot corrupt the cache", () => {
    const c = new PromptCache();
    const k = c.key("a", "m", baseBody);
    const original = resp("clean");
    c.set(k, original);
    original.choices[0]!.message.content = "mutated-after-set";
    const got = c.get(k)!;
    expect(got.choices[0]!.message.content).toBe("clean");
    got.choices[0]!.message.content = "mutated-after-get";
    expect(c.get(k)!.choices[0]!.message.content).toBe("clean");
  });
});

describe("cache v2 — persistence", () => {
  it("hydrates from the persister (survives a restart)", () => {
    const rows = new Map<string, { response: ChatCompletionResponse; expiresAt: number }>();
    const persister: CachePersister = {
      load: () => [...rows.entries()].map(([key, v]) => ({ key, response: v.response, expiresAt: v.expiresAt })),
      put: (key, response, expiresAt) => void rows.set(key, { response, expiresAt }),
      del: (key) => void rows.delete(key),
      clear: () => rows.clear(),
    };
    const c1 = new PromptCache(60_000, 100, persister);
    const k = c1.key("a", "m", baseBody, "key-1");
    c1.set(k, resp("durable"));
    expect(rows.size).toBe(1);

    const c2 = new PromptCache(60_000, 100, persister); // "restarted" cache
    expect(c2.stats().persistent).toBe(true);
    expect(c2.get(k)?.choices[0]!.message.content).toBe("durable");

    c2.clear();
    expect(rows.size).toBe(0);
  });

  it("does not hydrate expired rows", () => {
    const persister: CachePersister = {
      load: () => [{ key: "old", response: resp("stale"), expiresAt: Date.now() - 1000 }],
      put: () => {},
      del: () => {},
      clear: () => {},
    };
    const c = new PromptCache(60_000, 100, persister);
    expect(c.stats().entries).toBe(0);
  });
});

describe("cache v2 — semantic scoping", () => {
  it("never serves a response across scopes", async () => {
    const sem = new SemanticCache(undefined, 0.9, 100, 60_000);
    const msgs = [
      { role: "system", content: "be terse" },
      { role: "user", content: "what is the capital of france" },
    ];
    const scopeA = SemanticCache.scopeFor("key-1", "prov-a", "m1", msgs);
    const scopeB = SemanticCache.scopeFor("key-2", "prov-a", "m1", msgs);
    const scopeC = SemanticCache.scopeFor("key-1", "prov-b", "m2", msgs);
    await sem.add(scopeA, "what is the capital of france", resp("Paris"));
    expect(await sem.find(scopeB, "what is the capital of france")).toBeNull();
    expect(await sem.find(scopeC, "what is the capital of france")).toBeNull();
    const hit = await sem.find(scopeA, "what is the capital of france");
    expect(hit?.response.choices[0]!.message.content).toBe("Paris");
    expect(sem.stats().hits).toBe(1);
  });

  it("expires semantic entries on the TTL", async () => {
    const sem = new SemanticCache(undefined, 0.9, 100, 1000);
    await sem.add("s", "hello there friend", resp("hi"), 0);
    expect(await sem.find("s", "hello there friend", 500)).not.toBeNull();
    expect(await sem.find("s", "hello there friend", 1500)).toBeNull();
  });

  it("system prompt changes the scope", () => {
    const a = SemanticCache.scopeFor("k", "p", "m", [{ role: "system", content: "one" }]);
    const b = SemanticCache.scopeFor("k", "p", "m", [{ role: "system", content: "two" }]);
    expect(a).not.toBe(b);
  });
});

describe("cache v2 — stream tap + replay", () => {
  it("assembles a chunk stream into a full response", async () => {
    async function* chunks() {
      yield { id: "c1", model: "m", created: 7, choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null }] };
      yield { id: "c1", model: "m", created: 7, choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] };
      yield {
        id: "c1", model: "m", created: 7,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      };
    }
    let assembled: ChatCompletionResponse | null = null;
    const seen: unknown[] = [];
    for await (const ch of tapStream(chunks() as never, (r) => (assembled = r))) seen.push(ch);
    expect(seen.length).toBe(3); // pass-through untouched
    expect(assembled!.choices[0]!.message.content).toBe("Hello");
    expect(assembled!.choices[0]!.finish_reason).toBe("stop");
    expect(assembled!.usage?.total_tokens).toBe(5);
  });

  it("does not call onDone when the stream breaks", async () => {
    async function* chunks() {
      yield { choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] };
      throw new Error("upstream died");
    }
    let done = false;
    await expect(async () => {
      for await (const _ of tapStream(chunks() as never, () => (done = true))) void _;
    }).rejects.toThrow("upstream died");
    expect(done).toBe(false);
  });

  it("replays a stored response as protocol-valid chunks", async () => {
    const out: Array<Record<string, unknown>> = [];
    for await (const ch of replayStream(resp("Hello"))) out.push(ch);
    expect(out.length).toBe(2);
    const first = out[0] as { choices: Array<{ delta: { content?: string } }> };
    expect(first.choices[0]!.delta.content).toBe("Hello");
    const last = out[out.length - 1] as { choices: Array<{ finish_reason: string }>; usage?: unknown };
    expect(last.choices[0]!.finish_reason).toBe("stop");
    expect(last.usage).toBeDefined();
  });
});
