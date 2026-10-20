import { describe, expect, it } from "vitest";
import { bufferKimiChunks, toKimiRequest } from "../src/translator/kimi.js";

describe("kimi translator", () => {
  it("forces stream:true upstream", () => {
    const out = toKimiRequest({
      model: "kimi-k2",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    expect(out.stream).toBe(true);
  });

  it("buffers SSE chunks back to a JSON response", () => {
    const res = bufferKimiChunks(
      [
        { choices: [{ delta: { content: "Hel" }, finish_reason: null }] },
        { choices: [{ delta: { content: "lo" }, finish_reason: null }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        },
      ],
      "kimi-k2",
    );
    expect(res.choices[0]!.message.content).toBe("Hello");
    expect(res.choices[0]!.finish_reason).toBe("stop");
    expect(res.usage.total_tokens).toBe(6);
  });

  it("handles empty chunk list", () => {
    const res = bufferKimiChunks([], "kimi-k2");
    expect(res.choices[0]!.message.content).toBe("");
  });
});
