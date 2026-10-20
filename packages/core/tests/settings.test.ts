import { describe, expect, it } from "vitest";
import { memoryStore } from "../src/store/db.js";
import { Alerter } from "../src/alerts/index.js";

describe("settings store", () => {
  it("gets/sets settings with null default", () => {
    const s = memoryStore();
    expect(s.getSetting("strategy")).toBeNull();
    s.setSetting("strategy", "cost-optimized");
    expect(s.getSetting("strategy")).toBe("cost-optimized");
    s.setSetting("strategy", "priority");
    expect(s.getSetting("strategy")).toBe("priority");
    s.close();
  });

  it("totalMonthSpend sums cost_usd for the current month", () => {
    const s = memoryStore();
    s.logUsage({ keyId: null, provider: "a", model: "m", promptTokens: 1, completionTokens: 1, latencyMs: 10, status: "ok", costUsd: 0.5 });
    s.logUsage({ keyId: null, provider: "b", model: "m", promptTokens: 1, completionTokens: 1, latencyMs: 10, status: "ok", costUsd: 1.25 });
    expect(s.totalMonthSpend()).toBeCloseTo(1.75, 6);
    s.close();
  });

  it("dailyRequests aggregates per day", () => {
    const s = memoryStore();
    s.logUsage({ keyId: null, provider: "a", model: "m", promptTokens: 1, completionTokens: 1, latencyMs: 10, status: "ok", costUsd: 2 });
    s.logUsage({ keyId: null, provider: "a", model: "m", promptTokens: 1, completionTokens: 1, latencyMs: 10, status: "error", costUsd: 0 });
    const days = s.dailyRequests(7);
    expect(days).toHaveLength(7);
    const today = days[days.length - 1]!;
    expect(today.requests).toBe(2);
    expect(today.errors).toBe(1);
    expect(today.costUsd).toBeCloseTo(2, 6);
    expect(today.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    s.close();
  });
});

describe("alerter webhook override", () => {
  it("setWebhookUrl updates enabled state", () => {
    const a = new Alerter(undefined);
    expect(a.enabled).toBe(false);
    a.setWebhookUrl("https://example.com/hook");
    expect(a.enabled).toBe(true);
    expect(a.url).toBe("https://example.com/hook");
    a.setWebhookUrl(undefined);
    expect(a.enabled).toBe(false);
    a.setWebhookUrl("   ");
    expect(a.enabled).toBe(false);
  });
});
