import { describe, expect, it } from "vitest";
import { memoryStore } from "../src/store/db.js";
import { RateLimiter } from "../src/quota/limiter.js";

describe("store", () => {
  it("creates, verifies and revokes API keys", () => {
    const s = memoryStore();
    const { record, key } = s.createApiKey("test");
    expect(key.startsWith("lsk_")).toBe(true);

    const verified = s.verifyApiKey(key);
    expect(verified?.name).toBe("test");

    expect(s.verifyApiKey("lsk_wrong")).toBeNull();
    expect(s.revokeApiKey(record.id)).toBe(true);
    expect(s.verifyApiKey(key)).toBeNull();
    s.close();
  });

  it("logs and summarizes usage", () => {
    const s = memoryStore();
    s.logUsage({
      keyId: null, provider: "groq", model: "m",
      promptTokens: 10, completionTokens: 5, latencyMs: 100, status: "ok",
    });
    s.logUsage({
      keyId: null, provider: "groq", model: "m",
      promptTokens: 0, completionTokens: 0, latencyMs: 50, status: "error",
    });
    const sum = s.usageSummary(0);
    expect(sum).toHaveLength(1);
    expect(sum[0]!.requests).toBe(2);
    expect(sum[0]!.promptTokens).toBe(10);
    expect(sum[0]!.errors).toBe(1);
    s.close();
  });
});

describe("rate limiter", () => {
  it("allows up to the limit then blocks", () => {
    const l = new RateLimiter(3);
    expect(l.allow("k")).toBe(true);
    expect(l.allow("k")).toBe(true);
    expect(l.allow("k")).toBe(true);
    expect(l.allow("k")).toBe(false);
    expect(l.allow("other")).toBe(true);
  });
});
