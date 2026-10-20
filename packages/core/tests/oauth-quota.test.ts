import { describe, expect, it } from "vitest";
import { parseClaudeUsage, parseCodexUsage } from "../src/quota/oauthQuota.js";

describe("claude usage parser", () => {
  it("maps utilization windows to remaining buckets", () => {
    const out = parseClaudeUsage({
      five_hour: { utilization: 25, resets_at: "2026-10-20T20:00:00Z" },
      seven_day: { utilization: 40.5, resets_at: "2026-10-27T00:00:00Z" },
      seven_day_opus: { utilization: 90, resets_at: "2026-10-27T00:00:00Z" },
      seven_day_sonnet: null,
    });
    expect(out.map((b) => b.model)).toEqual(["5-hour window", "7-day window", "7-day · Opus"]);
    expect(out[0]!.remainingPct).toBe(75);
    expect(out[1]!.remainingPct).toBe(59.5);
    expect(out[0]!.resetAt).toBe("2026-10-20T20:00:00.000Z");
  });

  it("missing utilization stays unknown (bucket skipped, never 0)", () => {
    expect(parseClaudeUsage({ five_hour: {} })).toEqual([]);
    expect(parseClaudeUsage(null)).toEqual([]);
    expect(parseClaudeUsage({})).toEqual([]);
  });
});

describe("codex usage parser", () => {
  it("maps rate_limit windows with epoch-second resets", () => {
    const out = parseCodexUsage({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1792600000 },
        secondary_window: { used_percent: 55, limit_window_seconds: 604800, reset_at: 1793100000 },
      },
    });
    expect(out.map((b) => b.model)).toEqual(["Primary window", "Weekly window"]);
    expect(out[0]!.remainingPct).toBe(70);
    expect(out[0]!.resetAt).toBe(new Date(1792600000 * 1000).toISOString());
  });

  it("handles a missing rate_limit", () => {
    expect(parseCodexUsage({})).toEqual([]);
    expect(parseCodexUsage(null)).toEqual([]);
  });
});
