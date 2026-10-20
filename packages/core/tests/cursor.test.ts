import { describe, expect, it } from "vitest";
import { fromCursorResponse, toCursorRequest } from "../src/translator/cursor.js";

describe("cursor translator", () => {
  it("passes available_tools and tool_choice through", () => {
    const tools = [{ type: "function", function: { name: "search", parameters: {} } }];
    const out = toCursorRequest({
      model: "cursor-fast",
      messages: [{ role: "user", content: "hi" }],
      tools: tools as any,
      tool_choice: "auto",
    });
    expect(out.available_tools).toEqual(tools);
    expect(out.tool_choice).toBe("auto");
    expect(out.model).toBe("cursor-fast");
  });

  it("normalizes tool_calls with object arguments", () => {
    const res = fromCursorResponse(
      {
        id: "c1",
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ id: "x", function: { name: "search", arguments: { q: "hi" } } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
      "cursor-fast",
    );
    const tc = res.choices[0]!.message.tool_calls![0]!;
    expect(tc.function.name).toBe("search");
    expect(JSON.parse(tc.function.arguments)).toEqual({ q: "hi" });
    expect(res.choices[0]!.finish_reason).toBe("tool_calls");
  });
});
