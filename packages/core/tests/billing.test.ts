import { describe, expect, it } from "vitest";
import { costUsd, getPrice } from "../src/billing/prices.js";
import { memoryStore } from "../src/store/db.js";

describe("pricing", () => {
  it("prices known models", () => {
    expect(getPrice("openai", "gpt-4o-mini")).toEqual({ input: 0.15, output: 0.6 });
  });
  it("falls back to provider default", () => {
    expect(getPrice("groq", "some-new-model")).toEqual({ input: 0.59, output: 0.79 });
  });
  it("unknown provider → null → zero cost", () => {
    expect(getPrice("nope", "x")).toBeNull();
    expect(costUsd("nope", "x", 1000, 1000)).toBe(0);
  });
  it("computes USD cost", () => {
    // 1M in + 1M out on gpt-4o-mini = 0.15 + 0.60
    expect(costUsd("openai", "gpt-4o-mini", 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6);
  });
});

describe("budgets + forecasting", () => {
  it("tracks monthly spend per key", () => {
    const s = memoryStore();
    const { record } = s.createApiKey("k", 600, 10);
    expect(record.budgetUsd).toBe(10);
    s.logUsage({
      keyId: record.id, provider: "openai", model: "gpt-4o-mini",
      promptTokens: 1_000_000, completionTokens: 0, latencyMs: 1, status: "ok",
      costUsd: 0.15,
    });
    expect(s.monthSpend(record.id)).toBeCloseTo(0.15, 6);
    expect(s.setBudget(record.id, 5)).toBe(true);
    expect(s.verifyApiKey).toBeDefined();
    s.close();
  });

  it("dailySpend returns 7 buckets, forecast is linear", () => {
    const s = memoryStore();
    const { record } = s.createApiKey("k");
    // log $2 today
    s.logUsage({
      keyId: record.id, provider: "a", model: "m",
      promptTokens: 0, completionTokens: 0, latencyMs: 1, status: "ok", costUsd: 2,
    });
    const days = s.dailySpend(7);
    expect(days).toHaveLength(7);
    expect(days[6]!.total).toBeCloseTo(2, 6);
    const f = s.forecastMonthly();
    expect(f.dailyAvg).toBeCloseTo(2 / 7, 6);
    expect(f.projectedMonthly).toBeCloseTo((2 / 7) * 30, 6);
    s.close();
  });
});
