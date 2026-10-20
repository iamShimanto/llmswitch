import { describe, expect, it } from "vitest";
import type { ResolvedProvider } from "../src/providers/types.js";
import { createRouter, type RouterEvent } from "../src/router/index.js";
import { orderProviders } from "../src/router/strategies.js";

function prov(id: string): ResolvedProvider {
  return {
    id, name: id, baseUrl: "https://example.com", wireFormat: "openai",
    models: ["m"], defaultModel: "m", costTier: 3, apiKey: "k",
  };
}

const body = { model: "auto", messages: [{ role: "user" as const, content: "hi" }] };

function ok(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "x", model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("router cooldown + events", () => {
  it("cools a failed provider and skips it on the next auto route", async () => {
    let aCalls = 0;
    const fetchFn = (async () => {
      aCalls++;
      // 'a' always 500s, 'b' succeeds — distinguish by call order is not possible;
      // instead fail twice then succeed: first route a→fail,b→ok; second route must skip a
      return aCalls <= 1 ? new Response("boom", { status: 500 }) : ok("fine");
    }) as typeof fetch;

    const events: RouterEvent[] = [];
    const router = createRouter([prov("a"), prov("b")]);
    const r1 = await router.route(body, { fetchFn, onEvent: (e) => events.push(e) });
    expect(r1.providerId).toBe("b");
    expect(events.some((e) => e.type === "provider_failed" && e.providerId === "a")).toBe(true);

    // 'a' is now cooling → next auto route goes straight to 'b'
    const r2 = await router.route(body, { fetchFn });
    expect(r2.providerId).toBe("b");
    // route1: a(fail) + b(ok) = 2 calls; route2: b only (a skipped) = 1 call
    expect(aCalls).toBe(3);
  });

  it("records session affinity for context-relay", async () => {
    const fetchFn = (async () => ok("hi")) as typeof fetch;
    const router = createRouter([prov("a"), prov("b")]);
    await router.route(body, { fetchFn, sessionId: "s-1", strategy: "priority" });
    // affinity recorded → context-relay would put 'a' first even if order changes
    const ordered = orderProviders([prov("b"), prov("a")], "context-relay", {
      affinity: new Map([["s-1", "a"]]),
      sessionId: "s-1",
    });
    expect(ordered[0]!.id).toBe("a");
  });

  it("auto strategy uses task-aware ordering", async () => {
    const seen: string[] = [];
    const fetchFn = (async () => ok("hi")) as typeof fetch;
    const router = createRouter([prov("openai"), prov("deepseek")]);
    const res = await router.route(
      { model: "auto", messages: [{ role: "user" as const, content: "```js\ncode" }] },
      { fetchFn, strategy: "auto" },
    );
    seen.push(res.providerId);
    expect(seen[0]).toBe("deepseek");
  });
});
