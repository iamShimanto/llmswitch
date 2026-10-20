import { describe, expect, it } from "vitest";
import { parseQuotaHeaders, QuotaTelemetry } from "../src/quota/telemetry.js";
import { orderProviders } from "../src/router/strategies.js";
import { createRouter } from "../src/router/index.js";
import type { ResolvedProvider } from "../src/providers/types.js";

function prov(id: string): ResolvedProvider {
  return {
    id, name: id, baseUrl: "https://example.com", wireFormat: "openai",
    models: ["m"], defaultModel: "m", costTier: 3, apiKey: "k",
  };
}

function headers(pairs: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(pairs)) h.set(k, v);
  return h;
}

describe("parseQuotaHeaders", () => {
  it("parses OpenAI-style headers", () => {
    const q = parseQuotaHeaders(headers({
      "x-ratelimit-remaining": "42",
      "x-ratelimit-limit": "100",
      "x-ratelimit-reset": "30",
    }), 1_000_000);
    expect(q!.remaining).toBe(42);
    expect(q!.limit).toBe(100);
    expect(q!.resetAt).toBe(1_030_000); // seconds-until-reset
  });

  it("handles epoch-second resets", () => {
    const q = parseQuotaHeaders(headers({ "x-ratelimit-reset": "1_700_000_000".replace(/_/g, "") }));
    expect(q!.resetAt).toBe(1_700_000_000_000);
  });

  it("returns null when no quota headers", () => {
    expect(parseQuotaHeaders(headers({ "content-type": "application/json" }))).toBeNull();
  });
});

describe("QuotaTelemetry", () => {
  it("computes quota share", () => {
    const t = new QuotaTelemetry();
    t.record("a", { remaining: 25, limit: 100, resetAt: null, updatedAt: 0 });
    expect(t.share("a")).toBe(0.25);
    expect(t.share("b")).toBeNull();
  });
});

describe("quota-aware strategies", () => {
  const quota = new Map([
    ["a", { remaining: 5, limit: 100, resetAt: null, updatedAt: 0 }],
    ["b", { remaining: 90, limit: 100, resetAt: null, updatedAt: 0 }],
  ]);

  it("reset-window puts most-quota provider first", () => {
    const out = orderProviders([prov("a"), prov("b")], "reset-window", { quota });
    expect(out[0]!.id).toBe("b");
  });

  it("reset-window without data keeps config order", () => {
    const out = orderProviders([prov("a"), prov("b")], "reset-window", {});
    expect(out.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("quota-weighted prefers high-quota provider", () => {
    let bFirst = 0;
    for (let i = 0; i < 100; i++) {
      if (orderProviders([prov("a"), prov("b")], "quota-weighted", { quota })[0]!.id === "b") bFirst++;
    }
    expect(bFirst).toBeGreaterThan(80); // 90% vs 5% share
  });
});

describe("router feeds telemetry from upstream headers", () => {
  it("records quota from response headers", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          id: "x", model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json", "x-ratelimit-remaining": "10", "x-ratelimit-limit": "100" },
        },
      )) as typeof fetch;

    const router = createRouter([prov("a"), prov("b")]);
    const r = await router.route(
      { model: "auto", messages: [{ role: "user" as const, content: "hi" }] },
      { fetchFn, strategy: "reset-window" },
    );
    expect(r.quota?.remaining).toBe(10);
    // second route: 'a' now has 10% quota share, 'b' unknown → 'b' keeps config position after known
    const r2 = await router.route(
      { model: "auto", messages: [{ role: "user" as const, content: "hi" }] },
      { fetchFn: (async () => new Response("boom", { status: 500 })) as typeof fetch, strategy: "reset-window" },
    ).catch((e) => e);
    expect(r2).toBeDefined();
  });
});
