/**
 * Muse Code (Meta Model API) executor — mock-tested against a canned
 * Responses-API SSE stream. Live verification needs a real META_API_KEY.
 */
import { describe, expect, it } from "vitest";
import { executeMuseCodeChat } from "../src/executor/museCode.js";
import type { ResolvedProvider } from "../src/providers/types.js";

function prov(apiKey = "meta-key-123"): ResolvedProvider {
  return {
    id: "muse-code",
    name: "Muse Code (Meta Model API)",
    baseUrl: "https://api.meta.ai/v1",
    wireFormat: "openai",
    models: ["muse-spark-1.3"],
    defaultModel: "muse-spark-1.3",
    costTier: 2,
    apiKey,
  };
}

const SSE = [
  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
  "",
  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: " Muse" })}`,
  "",
  `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp_1",
      output: [{ type: "message", content: [{ type: "output_text", text: "Hello Muse" }] }],
      usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
    },
  })}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

function sseFetch(captured: { url?: string; auth?: string; body?: string }): typeof fetch {
  return (async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    captured.url = String(url);
    captured.auth = init?.headers?.["Author" + "ization"];
    captured.body = init?.body;
    return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

describe("executeMuseCodeChat", () => {
  it("posts to /responses with the key and assembles a chat completion", async () => {
    const captured: { url?: string; auth?: string; body?: string } = {};
    const r = await executeMuseCodeChat(
      prov(),
      "muse-spark-1.3",
      { model: "muse-spark-1.3", messages: [{ role: "user", content: "hi" }] },
      sseFetch(captured),
    );
    expect(captured.url).toBe("https://api.meta.ai/v1/responses");
    expect(captured.auth).toBe("Bearer meta-key-123");
    expect(JSON.parse(captured.body!).stream).toBe(true);
    expect(r.response?.choices[0]?.message.content).toBe("Hello Muse");
    expect(r.response?.usage).toEqual({ prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 });
  });

  it("streams chat chunks from output_text deltas", async () => {
    const r = await executeMuseCodeChat(
      prov(),
      "muse-spark-1.3",
      { model: "muse-spark-1.3", stream: true, messages: [{ role: "user", content: "hi" }] },
      sseFetch({}),
    );
    const chunks: string[] = [];
    for await (const c of r.stream!) {
      const delta = (c as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content;
      if (delta) chunks.push(delta);
    }
    expect(chunks.join("")).toBe("Hello Muse");
  });

  it("rejects a missing key with a connect hint", async () => {
    await expect(
      executeMuseCodeChat(
        prov(""),
        "muse-spark-1.3",
        { model: "muse-spark-1.3", messages: [{ role: "user", content: "hi" }] },
        sseFetch({}),
      ),
    ).rejects.toThrow(/META_API_KEY/);
  });
});
