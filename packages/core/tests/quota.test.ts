import { describe, expect, it } from "vitest";
import { parseAgyQuotaBuckets, fetchAntigravityQuotaBuckets } from "../src/quota/antigravityQuota.js";
import { createRouter, type ExecuteResult } from "../src/router/index.js";
import type { ResolvedProvider } from "../src/registry/index.js";
import type { ChatCompletionRequest } from "../src/types.js";

const sample = {
  buckets: [
    { modelId: "gemini-3.8-flash-high", remainingFraction: 0.72, resetTime: "2026-10-21T04:00:00Z" },
    { modelId: "claude-sonnet-4-6", remainingFraction: 1 },
    { modelId: "gpt-oss-120b-medium" },
  ],
};

describe("parseAgyQuotaBuckets", () => {
  it("parses fractions, unlimited and unknown buckets", () => {
    const out = parseAgyQuotaBuckets(sample);
    expect(out).toHaveLength(3);
    const flash = out.find((b) => b.model.includes("flash"))!;
    expect(flash.remainingPct).toBe(72);
    expect(flash.resetAt).toBe("2026-10-21T04:00:00.000Z");
    expect(flash.unlimited).toBe(false);
    const claude = out.find((b) => b.model.includes("claude"))!;
    expect(claude.unlimited).toBe(true); // full fraction + no reset
    const gpt = out.find((b) => b.model.includes("gpt"))!;
    expect(gpt.remainingPct).toBeNull(); // absent fraction = unknown, NOT 0
    expect(gpt.unlimited).toBe(false);
  });

  it("returns [] for garbage input", () => {
    expect(parseAgyQuotaBuckets(null)).toEqual([]);
    expect(parseAgyQuotaBuckets({})).toEqual([]);
  });
});

describe("fetchAntigravityQuotaBuckets", () => {
  it("posts {project} to retrieveUserQuota and parses buckets", async () => {
    let seenUrl = "";
    let seenBody = "";
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = String(init?.body ?? "");
      return new Response(JSON.stringify(sample), { status: 200 });
    }) as typeof fetch;
    const out = await fetchAntigravityQuotaBuckets("tok", "proj-1", fetchFn);
    expect(seenUrl).toContain("/v1internal:retrieveUserQuota");
    expect(JSON.parse(seenBody)).toEqual({ project: "proj-1" });
    expect(out).toHaveLength(3);
  });

  it("returns null when every host fails", async () => {
    const fetchFn = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchAntigravityQuotaBuckets("tok", "p", fetchFn)).toBeNull();
  });
});

describe("router quota telemetry exposure", () => {
  it("quotaSnapshot reflects headers recorded from executions", async () => {
    const provider: ResolvedProvider = {
      id: "qprov",
      name: "Q",
      baseUrl: "https://q.example/v1",
      models: ["m1"],
      defaultModel: "m1",
      keys: ["k1"],
    } as ResolvedProvider;
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 1,
          model: "m1",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "42",
            "x-ratelimit-limit": "100",
          },
        },
      )) as unknown as typeof fetch;
    const router = createRouter([provider]);
    const body: ChatCompletionRequest = { model: "m1", messages: [{ role: "user", content: "hi" }] };
    const r: ExecuteResult = await router.route(body, { fetchFn });
    expect(r.providerId).toBe("qprov");
    const snap = router.quotaSnapshot().get("qprov");
    expect(snap?.remaining).toBe(42);
    expect(snap?.limit).toBe(100);
  });
});
