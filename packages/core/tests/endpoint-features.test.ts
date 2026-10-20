import { describe, expect, it } from "vitest";
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

const prov = {
  id: "prov-a",
  name: "prov-a",
  baseUrl: "https://prov-a.example/v1",
  wireFormat: "openai",
  models: ["ma"],
  defaultModel: "ma",
  costTier: 3,
  apiKey: "k",
  allKeys: ["k"],
} as unknown as ResolvedProvider;

describe("global system prompt", () => {
  it("is prepended to every chat request, exactly once", async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const router = createRouter([prov], { globalSystemPrompt: () => "ALWAYS-BE-NICE" });
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse("ok");
    }) as typeof fetch;
    await router.route(
      { model: "prov-a:ma", messages: [{ role: "user", content: "hi" }] },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0].messages[0]).toEqual({ role: "system", content: "ALWAYS-BE-NICE" });
    expect(bodies[0].messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("does nothing when disabled (null)", async () => {
    const bodies: Array<{ messages: unknown[] }> = [];
    const router = createRouter([prov], { globalSystemPrompt: () => null });
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse("ok");
    }) as typeof fetch;
    await router.route(
      { model: "prov-a:ma", messages: [{ role: "user", content: "hi" }] },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(bodies[0].messages).toHaveLength(1);
  });
});
