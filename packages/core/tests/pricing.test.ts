import { describe, expect, it } from "vitest";
import { costUsd, priceInfo, setPriceOverrides } from "../src/billing/prices.js";
import { memoryStore } from "../src/store/db.js";

describe("pricing v2", () => {
  it("prices subscription-routed models by model name (antigravity)", () => {
    expect(priceInfo("antigravity", "claude-sonnet-4-6")?.source).toBe("model");
    expect(costUsd("antigravity", "claude-sonnet-4-6", 1_000_000, 0)).toBe(3);
    expect(costUsd("antigravity", "gemini-3.8-flash-high", 0, 1_000_000)).toBe(2.5);
    expect(costUsd("antigravity", "claude-opus-4-6-thinking", 1_000_000, 0)).toBe(15);
  });
  it("prices aggregator models (nvidia) by pattern", () => {
    expect(costUsd("nvidia", "meta/llama-3.3-70b-instruct", 1_000_000, 0)).toBe(0.59);
    expect(priceInfo("nvidia", "meta/muse-glimmer-30b")?.input).toBe(1);
  });
  it("free routes cost $0 but are priced (known)", () => {
    expect(priceInfo("ovhcloud", "Meta-Llama-3_3-70B-Instruct")?.source).toBe("free");
    expect(costUsd("ovhcloud", "Meta-Llama-3_3-70B-Instruct", 1e6, 1e6)).toBe(0);
    expect(priceInfo("kilo-gateway", "nvidia/nemotron-3-super-120b-a12b:free")?.source).toBe("free");
    expect(priceInfo("duckduckgo-web", "gpt-5.4-mini")?.source).toBe("free");
  });
  it("user overrides win over everything", () => {
    setPriceOverrides({ "antigravity:claude-sonnet-4-6": { input: 9, output: 9 } });
    expect(costUsd("antigravity", "claude-sonnet-4-6", 1_000_000, 0)).toBe(9);
    setPriceOverrides({});
    expect(costUsd("antigravity", "claude-sonnet-4-6", 1_000_000, 0)).toBe(3);
  });
  it("unknown models stay unknown → 0", () => {
    expect(priceInfo("some-provider", "totally-unknown-model-xyz")).toBeNull();
    expect(costUsd("some-provider", "totally-unknown-model-xyz", 1e6, 1e6)).toBe(0);
  });
});

describe("cost backfill", () => {
  it("recomputes zero-cost rows with tokens and leaves free rows at 0", () => {
    const store = memoryStore();
    store.logUsage({
      keyId: null,
      provider: "antigravity",
      model: "claude-sonnet-4-6",
      promptTokens: 1_000_000,
      completionTokens: 0,
      costUsd: 0,
      latencyMs: 1,
      status: "ok",
      accountId: null,
    });
    store.logUsage({
      keyId: null,
      provider: "ovhcloud",
      model: "Meta-Llama-3_3-70B-Instruct",
      promptTokens: 500_000,
      completionTokens: 0,
      costUsd: 0,
      latencyMs: 1,
      status: "ok",
      accountId: null,
    });
    const n = store.backfillZeroCosts(costUsd);
    expect(n).toBe(1); // only the antigravity row gains a cost
    expect(store.totalMonthSpend()).toBeCloseTo(3, 5);
  });
});
