import { describe, expect, it } from "vitest";
import {
  buildEmulationPrompt,
  nativeTools,
  parseEmulatedToolCall,
} from "../src/tools/emulation.js";
import { createRouter } from "../src/router/index.js";
import type { ResolvedProvider } from "../src/providers/types.js";

const TOOLS = [
  { type: "function" as const, function: { name: "get_weather", description: "Get weather", parameters: { type: "object" } } },
];

function prov(id: string, wireFormat: "openai" | "anthropic" = "openai"): ResolvedProvider {
  return {
    id, name: id, baseUrl: "https://example.com", wireFormat,
    models: ["m"], defaultModel: "m", costTier: 3, apiKey: "k",
  };
}

function ok(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "x", model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("emulation prompt + parser", () => {
  it("builds a tool definition prompt", () => {
    const p = buildEmulationPrompt(TOOLS);
    expect(p).toContain("get_weather");
    expect(p).toContain("```tool_call");
  });

  it("parses a tool_call block", () => {
    const tc = parseEmulatedToolCall('```tool_call\n{"name": "get_weather", "arguments": {"city": "Dhaka"}}\n```');
    expect(tc!.function.name).toBe("get_weather");
    expect(JSON.parse(tc!.function.arguments)).toEqual({ city: "Dhaka" });
    expect(tc!.type).toBe("function");
  });

  it("returns null for plain text", () => {
    expect(parseEmulatedToolCall("The weather is nice today.")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseEmulatedToolCall("```tool_call\nnot json\n```")).toBeNull();
  });

  it("nativeTools only for openai wire", () => {
    expect(nativeTools("openai")).toBe(true);
    expect(nativeTools("anthropic")).toBe(false);
    expect(nativeTools("gemini")).toBe(false);
  });
});

describe("router tool emulation", () => {
  it("emulates tool calls on anthropic-wire providers", async () => {
    let sentBody: any = null;
    const fetchFn = (async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      // Anthropic wire-format response carrying a tool_call block
      return new Response(
        JSON.stringify({
          id: "msg_1",
          content: [{ type: "text", text: '```tool_call\n{"name": "get_weather", "arguments": {"city": "Dhaka"}}\n```' }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const router = createRouter([prov("a", "anthropic")]);
    const r = await router.route(
      {
        model: "a:m",
        messages: [{ role: "user" as const, content: "weather?" }],
        tools: TOOLS,
      },
      { fetchFn },
    );
    // tools were NOT sent in anthropic wire format (emulated via prompt)
    expect(sentBody.tools).toBeUndefined();
    expect(sentBody.system).toContain("get_weather");
    // response rewritten to OpenAI tool_calls
    const msg = r.response!.choices[0]!.message;
    expect(msg.tool_calls![0]!.function.name).toBe("get_weather");
    expect(r.response!.choices[0]!.finish_reason).toBe("tool_calls");
  });

  it("passes tools through natively on openai-wire providers", async () => {
    let sentBody: any = null;
    const fetchFn = (async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return ok("sunny");
    }) as typeof fetch;

    const router = createRouter([prov("a", "openai")]);
    await router.route(
      {
        model: "a:m",
        messages: [{ role: "user" as const, content: "weather?" }],
        tools: TOOLS,
      },
      { fetchFn },
    );
    expect(sentBody.tools).toHaveLength(1);
    expect(sentBody.messages[0].role).toBe("user"); // no injected system prompt
  });
});
