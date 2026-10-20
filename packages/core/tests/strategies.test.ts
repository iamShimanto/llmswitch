import { describe, expect, it } from "vitest";
import { emptyStats, orderProviders, resetRoundRobin, type ProviderStats } from "../src/router/strategies.js";
import type { ResolvedProvider } from "../src/providers/types.js";

function prov(id: string, overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    id,
    name: id,
    baseUrl: "https://example.com",
    wireFormat: "openai",
    models: ["m"],
    defaultModel: "m",
    costTier: 3,
    apiKey: "k",
    ...overrides,
  };
}

describe("orderProviders", () => {
  it("priority keeps config order", () => {
    const ps = [prov("a"), prov("b"), prov("c")];
    expect(orderProviders(ps, "priority").map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("round-robin rotates", () => {
    resetRoundRobin();
    const ps = [prov("a"), prov("b"), prov("c")];
    expect(orderProviders(ps, "round-robin")[0]!.id).toBe("a");
    expect(orderProviders(ps, "round-robin")[0]!.id).toBe("b");
    expect(orderProviders(ps, "round-robin")[0]!.id).toBe("c");
    expect(orderProviders(ps, "round-robin")[0]!.id).toBe("a");
  });

  it("least-used puts idle provider first", () => {
    const stats = new Map<string, ProviderStats>([
      ["a", { calls: 10, errors: 0, totalLatencyMs: 100 }],
      ["b", emptyStats()],
    ]);
    const ps = [prov("a"), prov("b")];
    expect(orderProviders(ps, "least-used", stats)[0]!.id).toBe("b");
  });

  it("cost-optimized sorts by costTier", () => {
    const ps = [prov("a", { costTier: 5 }), prov("b", { costTier: 1 }), prov("c", { costTier: 3 })];
    expect(orderProviders(ps, "cost-optimized").map((p) => p.id)).toEqual(["b", "c", "a"]);
  });

  it("random returns all providers", () => {
    const ps = [prov("a"), prov("b"), prov("c")];
    const out = orderProviders(ps, "random").map((p) => p.id).sort();
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("weighted respects weights over many draws", () => {
    const ps = [prov("a", { weight: 9 }), prov("b", { weight: 1 })];
    let aFirst = 0;
    for (let i = 0; i < 200; i++) {
      if (orderProviders(ps, "weighted")[0]!.id === "a") aFirst++;
    }
    expect(aFirst).toBeGreaterThan(140); // ~90% expected
  });

  it("does not mutate input", () => {
    const ps = [prov("a"), prov("b")];
    orderProviders(ps, "random");
    expect(ps.map((p) => p.id)).toEqual(["a", "b"]);
  });
});
