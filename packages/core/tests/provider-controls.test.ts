import { describe, expect, it } from "vitest";
import { executeProvider } from "../src/executor/http.js";
import { createRouter } from "../src/router/index.js";
import type { ResolvedProvider } from "../src/providers/types.js";

function jsonResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      model: "m",
      choices: [
        { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const prov = (extra: Partial<ResolvedProvider> = {}): ResolvedProvider =>
  ({
    id: "prov-a",
    name: "prov-a",
    baseUrl: "https://prov-a.example/v1",
    wireFormat: "openai",
    models: ["ma"],
    defaultModel: "ma",
    costTier: 3,
    apiKey: "k",
    allKeys: ["k"],
    ...extra,
  }) as ResolvedProvider;

describe("param filters", () => {
  it("strips blocked params from the outgoing body", async () => {
    let sent: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse("ok");
    }) as typeof fetch;
    await executeProvider(
      prov({ blockedParams: ["thinking", "reasoning_budget"] }),
      "ma",
      {
        model: "ma",
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled" },
        reasoning_budget: 100,
        temperature: 0.5,
      } as never,
      fetchFn,
    );
    expect(sent.thinking).toBeUndefined();
    expect(sent.reasoning_budget).toBeUndefined();
    expect(sent.temperature).toBe(0.5);
  });
});

describe("per-provider account strategy hook", () => {
  it("the router asks the hook with the provider id", async () => {
    const asked: string[] = [];
    const router = createRouter([prov()], {
      accounts: {
        strategy: (pid: string) => {
          asked.push(pid);
          return "round-robin";
        },
        stats: () => [],
        record: () => {},
      },
    });
    await router.route(
      { model: "prov-a:ma", messages: [{ role: "user", content: "hi" }] },
      { fetchFn: (async () => jsonResponse("ok")) as unknown as typeof fetch },
    );
    expect(asked).toContain("prov-a");
  });
});
