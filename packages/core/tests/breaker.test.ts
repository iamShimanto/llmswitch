import { describe, expect, it } from "vitest";
import { ModelBreaker } from "../src/router/breaker.js";
import { classifyStatus } from "../src/router/errors.js";
import { createRouter } from "../src/router/index.js";
import type { ResolvedProvider } from "../src/providers/types.js";

describe("error classification v2", () => {
  it("404/410 are model errors, 400/422 stay bad requests", () => {
    expect(classifyStatus(404)).toBe("model_error");
    expect(classifyStatus(410)).toBe("model_error");
    expect(classifyStatus(400)).toBe("bad_request");
    expect(classifyStatus(422)).toBe("bad_request");
    expect(classifyStatus(429)).toBe("rate_limited");
    expect(classifyStatus(401)).toBe("auth_error");
  });
});

describe("ModelBreaker", () => {
  it("opens after the threshold and blocks until the cooldown ends", () => {
    const b = new ModelBreaker();
    const t0 = 1_000_000;
    b.recordFailure("p", "m", "model_error", 404, "upstream 404", t0);
    expect(b.gate("p", "m", t0)).toBe("go"); // 1 failure: below threshold
    b.recordFailure("p", "m", "model_error", 404, "upstream 404", t0);
    expect(b.gate("p", "m", t0 + 1000)).toBe("blocked");
    expect(b.isOpen("p", "m", t0 + 599_000)).toBe(true); // 10 min cooldown
    expect(b.isOpen("p", "m", t0 + 601_000)).toBe(false);
  });

  it("410 Gone opens on the FIRST failure (model is retired)", () => {
    const b = new ModelBreaker();
    b.recordFailure("nvidia", "old-model", "model_error", 410, "upstream 410 Gone", 0);
    expect(b.gate("nvidia", "old-model", 1000)).toBe("blocked");
  });

  it("half-open: exactly one probe after expiry; success clears", () => {
    const b = new ModelBreaker();
    b.recordFailure("p", "m", "server_error", 500, "boom", 0);
    b.recordFailure("p", "m", "server_error", 500, "boom", 0);
    const t = 31_000; // 30s cooldown over
    expect(b.gate("p", "m", t)).toBe("probe");
    expect(b.gate("p", "m", t)).toBe("blocked"); // concurrent second request waits
    b.recordSuccess("p", "m");
    expect(b.gate("p", "m", t)).toBe("go");
    expect(b.snapshot(t)).toHaveLength(0);
  });

  it("a failed probe re-opens with an escalated duration", () => {
    const b = new ModelBreaker();
    b.recordFailure("p", "m", "model_error", 404, "x", 0);
    b.recordFailure("p", "m", "model_error", 404, "x", 0); // opens 10 min
    const t = 601_000;
    expect(b.gate("p", "m", t)).toBe("probe");
    b.recordFailure("p", "m", "model_error", 404, "x", t); // probe fails → 30 min
    expect(b.isOpen("p", "m", t + 29 * 60_000)).toBe(true);
    expect(b.isOpen("p", "m", t + 31 * 60_000)).toBe(false);
  });

  it("ignores auth/bad-request failures and supports reset", () => {
    const b = new ModelBreaker();
    b.recordFailure("p", "m", "auth_error", 401, "bad key", 0);
    b.recordFailure("p", "m", "bad_request", 400, "bad body", 0);
    expect(b.snapshot(0)).toHaveLength(0);
    b.recordFailure("p", "m", "model_error", 410, "gone", 0);
    expect(b.snapshot(0)).toHaveLength(1);
    b.reset("p:m");
    expect(b.snapshot(0)).toHaveLength(0);
  });
});

function prov(id: string, baseUrl: string): ResolvedProvider {
  return {
    id, name: id, baseUrl, wireFormat: "openai",
    models: ["m"], defaultModel: "m", costTier: 3, apiKey: "k",
  } as ResolvedProvider;
}

const okJson = (text: string) =>
  new Response(
    JSON.stringify({
      id: "x", model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const body = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };

describe("router rotation v2 (breaker integration)", () => {
  it("a 404 model falls through to the next provider, then fails fast", async () => {
    let aCalls = 0;
    let bCalls = 0;
    const fetchFn = (async (url: string) => {
      if (String(url).includes("a.test")) {
        aCalls++;
        return new Response(JSON.stringify({ error: { message: "model not found" } }), {
          status: 404, headers: { "content-type": "application/json" },
        });
      }
      bCalls++;
      return okJson("from-b");
    }) as typeof fetch;

    const router = createRouter([prov("a", "https://a.test"), prov("b", "https://b.test")], {});
    const r1 = await router.route(body, { fetchFn });
    expect(r1.providerId).toBe("b"); // v1 would have failed the whole request
    const r2 = await router.route(body, { fetchFn });
    expect(r2.providerId).toBe("b");
    expect(aCalls).toBe(2); // second failure opens the breaker
    const r3 = await router.route(body, { fetchFn });
    expect(r3.providerId).toBe("b");
    expect(aCalls).toBe(2); // skipped instantly — no third round-trip
    expect(bCalls).toBe(3);
    const snap = router.breakerSnapshot();
    expect(snap.find((s) => s.key === "a:m")?.open).toBe(true);
  });

  it("a pinned dead model fails fast with the blacklist reason", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("gone", { status: 410 });
    }) as typeof fetch;
    const router = createRouter([prov("a", "https://a.test")], {});
    await expect(router.route(body, { fetchFn })).rejects.toThrow(/410|gone/i);
    expect(calls).toBe(1); // 410 opens on first failure
    await expect(router.route(body, { fetchFn })).rejects.toThrow(/blacklisted/);
    expect(calls).toBe(1); // no second upstream call — fail fast
    router.resetBreaker();
    await expect(router.route(body, { fetchFn })).rejects.toThrow(/410|gone/i);
    expect(calls).toBe(2); // reset lets it try again
  });

  it("a 400 still stops the chain (the request itself is bad)", async () => {
    let bCalls = 0;
    const fetchFn = (async (url: string) => {
      if (String(url).includes("a.test")) {
        return new Response(JSON.stringify({ error: { message: "bad request" } }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      bCalls++;
      return okJson("from-b");
    }) as typeof fetch;
    const router = createRouter([prov("a", "https://a.test"), prov("b", "https://b.test")], {});
    await expect(router.route(body, { fetchFn })).rejects.toThrow();
    expect(bCalls).toBe(0);
  });
});
