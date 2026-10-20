import { describe, expect, it } from "vitest";
import { fromClovaResponse, toClovaRequest } from "../src/translator/clova.js";

describe("clova translator", () => {
  it("maps roles and forwards topP/topK/maxTokens", () => {
    const out = toClovaRequest({
      model: "clova-x",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
      ],
      max_tokens: 100,
      topP: 0.8,
      topK: 40,
    } as any);
    expect(out.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ]);
    expect(out.topP).toBe(0.8);
    expect(out.topK).toBe(40);
    expect(out.maxTokens).toBe(100);
  });

  it("converts result.message.content to OpenAI shape", () => {
    const res = fromClovaResponse(
      {
        result: {
          message: { role: "assistant", content: "Annyeong" },
          stopReason: "end_turn",
          usage: { promptTokens: 6, completionTokens: 2 },
        },
      },
      "clova-x",
    );
    expect(res.choices[0]!.message.content).toBe("Annyeong");
    expect(res.choices[0]!.finish_reason).toBe("stop");
    expect(res.usage).toEqual({ prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 });
  });
});
