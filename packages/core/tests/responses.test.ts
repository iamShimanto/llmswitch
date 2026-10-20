import { describe, expect, it } from "vitest";
import {
  chatToResponses,
  responsesStreamEvents,
  responsesToChat,
} from "../src/ingress/responses.js";
import type { ChatCompletionResponse } from "../src/providers/types.js";

function chatResp(text: string): ChatCompletionResponse {
  return {
    id: "chatcmpl-1", model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  };
}

describe("responsesToChat", () => {
  it("maps string input + instructions", () => {
    const c = responsesToChat({ model: "auto", input: "hello", instructions: "be nice" });
    expect(c.messages).toEqual([
      { role: "system", content: "be nice" },
      { role: "user", content: "hello" },
    ]);
    expect(c.model).toBe("auto");
  });

  it("maps message array with content parts", () => {
    const c = responsesToChat({
      model: "auto",
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_text", text: " there" }] },
        { role: "assistant", content: "yo" },
      ],
    });
    expect(c.messages[0]).toEqual({ role: "user", content: "hi there" });
    expect(c.messages[1]).toEqual({ role: "assistant", content: "yo" });
  });

  it("maps max_output_tokens → max_tokens", () => {
    const c = responsesToChat({ model: "auto", input: "x", max_output_tokens: 50 });
    expect(c.max_tokens).toBe(50);
  });
});

describe("chatToResponses", () => {
  it("shapes a Responses API object", () => {
    const r = chatToResponses(chatResp("Paris"), "gpt-4o");
    expect(r.object).toBe("response");
    expect(r.status).toBe("completed");
    expect(r.id.startsWith("resp_")).toBe(true);
    expect(r.output[0]!.content[0]!.text).toBe("Paris");
    expect(r.usage).toEqual({ input_tokens: 5, output_tokens: 7, total_tokens: 12 });
  });
});

describe("responsesStreamEvents", () => {
  it("emits created → deltas → completed", () => {
    const evs = responsesStreamEvents("resp_1", "m", ["Hel", "lo"]);
    const joined = evs.join("");
    expect(joined).toContain("event: response.created");
    expect(joined).toContain("event: response.output_text.delta");
    expect(joined).toContain('"delta":"Hel"');
    expect(joined).toContain("event: response.completed");
  });
});
