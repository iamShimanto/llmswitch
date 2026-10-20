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
