import { describe, expect, it } from "vitest";
import {
  clearStickyProvider,
  emptyStats,
  isStrategyName,
  orderProviders,
  resetSticky,
  setStickyProvider,
  STRATEGY_NAMES,
  type ProviderStats,
} from "../src/router/strategies.js";
import type { ResolvedProvider } from "../src/providers/types.js";

function prov(id: string, overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    id, name: id, baseUrl: "https://example.com", wireFormat: "openai",
    models: ["m"], defaultModel: "m", costTier: 3, apiKey: "k", ...overrides,
  };
}

describe("strategy registry", () => {
  it("has exactly 20 strategies", () => {
    expect(STRATEGY_NAMES).toHaveLength(20);
  });
  it("isStrategyName validates", () => {
    expect(isStrategyName("p2c")).toBe(true);
    expect(isStrategyName("nope")).toBe(false);
  });
});

describe("new strategies", () => {
  it("p2c picks the least-used of two random choices", () => {
    const stats = new Map<string, ProviderStats>([
      ["a", { calls: 100, errors: 0, totalLatencyMs: 1 }],
      ["b", { calls: 1, errors: 0, totalLatencyMs: 1 }],
      ["c", { calls: 100, errors: 0, totalLatencyMs: 1 }],
    ]);
    // run many times: b should usually be first (it's in every pair's least-used half the time at least)
    let bFirst = 0;
    for (let i = 0; i < 100; i++) {
      if (orderProviders([prov("a"), prov("b"), prov("c")], "p2c", stats)[0]!.id === "b") bFirst++;
    }
    expect(bFirst).toBeGreaterThan(40);
  });

  it("fill-first sticks to last-good provider", () => {
    resetSticky();
    const ps = [prov("a"), prov("b"), prov("c")];
    expect(orderProviders(ps, "fill-first")[0]!.id).toBe("a"); // no sticky → priority
    setStickyProvider("c");
    expect(orderProviders(ps, "fill-first")[0]!.id).toBe("c");
    clearStickyProvider("c");
    expect(orderProviders(ps, "fill-first")[0]!.id).toBe("a");
    resetSticky();
  });

  it("lkgp sorts by errors ascending", () => {
    const stats = new Map<string, ProviderStats>([
      ["a", { calls: 10, errors: 5, totalLatencyMs: 1 }],
      ["b", { calls: 10, errors: 0, totalLatencyMs: 1 }],
    ]);
    expect(orderProviders([prov("a"), prov("b")], "lkgp", stats)[0]!.id).toBe("b");
  });

  it("headroom prefers best success rate", () => {
    const stats = new Map<string, ProviderStats>([
      ["a", { calls: 10, errors: 9, totalLatencyMs: 1 }],
      ["b", { calls: 10, errors: 1, totalLatencyMs: 1 }],
    ]);
    expect(orderProviders([prov("a"), prov("b")], "headroom", stats)[0]!.id).toBe("b");
  });

  it("quota-weighted returns all providers", () => {
    const out = orderProviders([prov("a"), prov("b")], "quota-weighted");
    expect(out.map((p) => p.id).sort()).toEqual(["a", "b"]);
  });

  it("strict-random shuffles", () => {
    const out = orderProviders([prov("a"), prov("b"), prov("c")], "strict-random");
    expect(out.map((p) => p.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("context-relay honors session affinity", () => {
    const affinity = new Map([["s1", "b"]]);
    const ps = [prov("a"), prov("b")];
    expect(
      orderProviders(ps, "context-relay", { affinity, sessionId: "s1" })[0]!.id,
    ).toBe("b");
    expect(orderProviders(ps, "context-relay")[0]!.id).toBe("a"); // no session → priority
  });

  it("context-optimized sorts by context window", () => {
    const ps = [prov("a", { contextWindow: 8_000 }), prov("b", { contextWindow: 1_000_000 })];
    expect(orderProviders(ps, "context-optimized")[0]!.id).toBe("b");
  });

  it("cache-optimized prefers prompt-cache providers", () => {
    const ps = [prov("a"), prov("b", { supportsPromptCache: true })];
    expect(orderProviders(ps, "cache-optimized")[0]!.id).toBe("b");
  });

  it("fusion == cost order, pipeline/reset-window == priority", () => {
    const ps = [prov("a", { costTier: 5 }), prov("b", { costTier: 1 })];
    expect(orderProviders(ps, "fusion").map((p) => p.id)).toEqual(["b", "a"]);
    expect(orderProviders(ps, "pipeline").map((p) => p.id)).toEqual(["a", "b"]);
    expect(orderProviders(ps, "reset-window").map((p) => p.id)).toEqual(["a", "b"]);
    expect(orderProviders(ps, "auto").map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("reset-aware puts cooling providers last", () => {
    const ps = [prov("a"), prov("b")];
    const out = orderProviders(ps, "reset-aware", { cooling: new Set(["a"]) });
    expect(out.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("legacy Map third-arg still works", () => {
    const stats = new Map<string, ProviderStats>([["a", { calls: 5, errors: 0, totalLatencyMs: 1 }]]);
    expect(orderProviders([prov("a"), prov("b")], "least-used", stats)[0]!.id).toBe("b");
  });
});
