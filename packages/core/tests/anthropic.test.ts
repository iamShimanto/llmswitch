import { describe, expect, it } from "vitest";
import {
  anthropicStreamEvent,
  fromAnthropicResponse,
  toAnthropicRequest,
} from "../src/translator/anthropic.js";

const req = {
  model: "claude-haiku-4-5",
  messages: [
    { role: "system" as const, content: "Be brief." },
    { role: "user" as const, content: "Hi" },
    { role: "user" as const, content: "there" },
  ],
};

describe("anthropic translator", () => {
  it("extracts system prompt and merges consecutive user messages", () => {
    const out = toAnthropicRequest(req);
    expect(out.system).toBe("Be brief.");
    expect(out.messages).toEqual([{ role: "user", content: "Hi\nthere" }]);
    expect(out.max_tokens).toBe(1024);
  });

  it("converts response to OpenAI shape", () => {
    const res = fromAnthropicResponse(
      {
        id: "msg_1",
        content: [{ type: "text", text: "Hello!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      "claude-haiku-4-5",
    );
    expect(res.choices[0]!.message.content).toBe("Hello!");
    expect(res.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("converts SSE text deltas to OpenAI chunks", () => {
    const chunk = anthropicStreamEvent(
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
      "m",
    );
    expect(chunk!.choices[0].delta.content).toBe("Hel");
    const done = anthropicStreamEvent({ type: "message_stop" }, "m");
    expect(done!.choices[0].finish_reason).toBe("stop");
    expect(anthropicStreamEvent({ type: "message_start" }, "m")).toBeNull();
  });
});

describe("anthropic ingress (Messages API)", () => {
  it("converts an Anthropic request to an OpenAI chat request", async () => {
    const { fromAnthropicRequest } = await import("../src/translator/anthropic.js");
    const out = fromAnthropicRequest({
      model: "auto",
      max_tokens: 256,
      system: "You are terse.",
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "Again" },
      ],
    });
    expect(out.model).toBe("auto");
    expect(out.max_tokens).toBe(256);
    expect(out.messages[0]).toEqual({ role: "system", content: "You are terse." });
    expect(out.messages[1]).toEqual({ role: "user", content: "Hello" });
    expect(out.messages[2]).toEqual({ role: "assistant", content: "Hi!" });
  });

  it("converts an OpenAI response to an Anthropic message", async () => {
    const { toAnthropicResponse } = await import("../src/translator/anthropic.js");
    const out = toAnthropicResponse(
      {
        id: "chatcmpl-9",
        model: "kilo-auto/free",
        choices: [{ index: 0, message: { role: "assistant", content: "Yo" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      },
      "auto",
    );
    expect(out.type).toBe("message");
    expect(out.id).toBe("msg_9");
    expect(out.content).toEqual([{ type: "text", text: "Yo" }]);
    expect(out.stop_reason).toBe("end_turn");
    expect(out.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
  });

  it("maps length finish to max_tokens stop_reason", async () => {
    const { toAnthropicStopReason } = await import("../src/translator/anthropic.js");
    expect(toAnthropicStopReason("length")).toBe("max_tokens");
    expect(toAnthropicStopReason("tool_calls")).toBe("tool_use");
    expect(toAnthropicStopReason("stop")).toBe("end_turn");
  });
});
