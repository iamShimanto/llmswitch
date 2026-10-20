import { describe, expect, it } from "vitest";
import { fromGlmResponse, GLM_REQUEST_DEFAULTS, toGlmRequest } from "../src/translator/glm.js";

describe("glm translator", () => {
  it("injects GLM request defaults without clobbering explicit values", () => {
    const out = toGlmRequest({ model: "glm-4", messages: [{ role: "user", content: "hi" }] });
    expect(out.temperature).toBe(GLM_REQUEST_DEFAULTS.temperature);
    expect(out.top_p).toBe(GLM_REQUEST_DEFAULTS.top_p);
    const out2 = toGlmRequest({
      model: "glm-4",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.1,
    });
    expect(out2.temperature).toBe(0.1);
  });

  it("converts OpenAI-shaped response", () => {
    const res = fromGlmResponse(
      {
        id: "g1",
        choices: [{ message: { content: "ni hao" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
      "glm-4",
    );
    expect(res.choices[0]!.message.content).toBe("ni hao");
    expect(res.usage.total_tokens).toBe(5);
  });
});
