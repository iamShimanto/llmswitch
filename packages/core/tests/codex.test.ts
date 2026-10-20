import { describe, expect, it } from "vitest";
import { codexStreamEvent, fromCodexResponse, toCodexRequest } from "../src/translator/codex.js";

const req = {
  model: "gpt-5",
  messages: [
    { role: "system" as const, content: "Be brief." },
    { role: "user" as const, content: "Hi" },
  ],
  temperature: 0.5,
};

describe("codex translator", () => {
  it("maps chat messages to Responses input (system → developer)", () => {
    const out = toCodexRequest(req);
    expect(out.model).toBe("gpt-5");
    expect(out.input).toEqual([
      { role: "developer", content: "Be brief." },
      { role: "user", content: "Hi" },
    ]);
    expect(out.temperature).toBe(0.5);
  });

  it("converts output array to OpenAI choices", () => {
    const res = fromCodexResponse(
      {
        id: "resp_1",
        output: [
          { type: "message", content: [{ type: "output_text", text: "Hello" }, { type: "output_text", text: "!" }] },
        ],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      },
      "gpt-5",
    );
    expect(res.choices[0]!.message.content).toBe("Hello!");
    expect(res.choices[0]!.finish_reason).toBe("stop");
    expect(res.usage).toEqual({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 });
  });

  it("converts Responses SSE deltas", () => {
    const chunk = codexStreamEvent({ type: "response.output_text.delta", delta: "Hel" }, "gpt-5");
    expect(chunk!.choices[0].delta.content).toBe("Hel");
    const done = codexStreamEvent({ type: "response.completed" }, "gpt-5");
    expect(done!.choices[0].finish_reason).toBe("stop");
    expect(codexStreamEvent({ type: "response.created" }, "gpt-5")).toBeNull();
  });
});
