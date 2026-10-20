import { describe, expect, it } from "vitest";
import { fromKiroResponse, toKiroRequest } from "../src/translator/kiro.js";

describe("kiro translator", () => {
  it("forwards profileArn from arg or body", () => {
    const out = toKiroRequest(
      { model: "kiro", messages: [{ role: "user", content: "hi" }] },
      "arn:aws:iam::123:instance-profile/x",
    );
    expect(out.profileArn).toBe("arn:aws:iam::123:instance-profile/x");
    const out2 = toKiroRequest({
      model: "kiro",
      messages: [{ role: "user", content: "hi" }],
      profileArn: "arn:body",
    } as any);
    expect(out2.profileArn).toBe("arn:body");
  });

  it("omits profileArn when absent", () => {
    const out = toKiroRequest({ model: "kiro", messages: [{ role: "user", content: "hi" }] });
    expect("profileArn" in out).toBe(false);
  });

  it("converts OpenAI-shaped response", () => {
    const res = fromKiroResponse(
      {
        id: "k1",
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      },
      "kiro",
    );
    expect(res.choices[0]!.message.content).toBe("done");
    expect(res.usage.total_tokens).toBe(4);
  });
});
