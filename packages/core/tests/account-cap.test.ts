import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { createRouter } from "../src/router/index.js";
import type { ResolvedProvider } from "../src/providers/types.js";

describe("per-account daily cap (store)", () => {
  it("persists the cap and sums today's spend per account", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "llmswitch-cap-")));
    const a = store.addAccount({ providerId: "nvidia", label: "A", kind: "api_key", secret: "k1" });
    expect(a.dailyCapUsd ?? null).toBeNull();
    expect(store.updateAccount(a.id, { dailyCapUsd: 1.5 })).toBe(true);
    expect(store.getAccount(a.id)!.dailyCapUsd).toBe(1.5);

    const dayStart = new Date().setUTCHours(0, 0, 0, 0);
    store.logUsage({
      keyId: null, provider: "nvidia", model: "m", promptTokens: 1, completionTokens: 1,
      latencyMs: 1, status: "ok", costUsd: 0.75, accountId: a.id,
    });
    store.logUsage({
      keyId: null, provider: "nvidia", model: "m", promptTokens: 1, completionTokens: 1,
      latencyMs: 1, status: "ok", costUsd: 0.8, accountId: a.id,
    });
    store.logUsage({
      keyId: null, provider: "nvidia", model: "m", promptTokens: 1, completionTokens: 1,
      latencyMs: 1, status: "ok", costUsd: 99, accountId: "someone-else",
    });
    expect(store.accountDailySpend(a.id, dayStart)).toBeCloseTo(1.55);
    expect(store.accountDailySpend(a.id, dayStart) >= 1.5).toBe(true); // cap reached
    store.updateAccount(a.id, { dailyCapUsd: null });
    expect(store.getAccount(a.id)!.dailyCapUsd).toBeNull();
    store.close();
  });
});

describe("per-account daily cap (router)", () => {
  it("never routes to a capped account's key", async () => {
    const seenAuth: string[] = [];
    const fetchFn = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seenAuth.push(h.authorization ?? h.Authorization ?? "");
      return new Response(
        JSON.stringify({
          id: "x", model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const provider = {
      id: "p", name: "p", baseUrl: "https://p.test", wireFormat: "openai",
      models: ["m"], defaultModel: "m", costTier: 3, apiKey: "key-a",
      allKeys: ["key-a", "key-b"],
      keyAccounts: new Map([["key-a", "acctA"], ["key-b", "acctB"]]),
    } as unknown as ResolvedProvider;

    const router = createRouter([provider], {
      accounts: {
        strategy: () => "round-robin",
        stats: () => [],
        record: () => {},
        capped: () => new Set(["acctA"]),
      },
    });
    const body = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };
    for (let i = 0; i < 3; i++) await router.route(body, { fetchFn });
    expect(seenAuth.length).toBe(3);
    expect(seenAuth.every((a) => a.includes("key-b"))).toBe(true);
  });
});
