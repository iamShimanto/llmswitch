import { describe, expect, it } from "vitest";
import {
  fromGeminiResponse,
  geminiStreamEvent,
  geminiUrl,
  toGeminiRequest,
} from "../src/translator/gemini.js";

const req = {
  model: "gemini-2.5-flash",
  messages: [
    { role: "system" as const, content: "Be brief." },
    { role: "user" as const, content: "Hi" },
    { role: "assistant" as const, content: "Hello" },
  ],
  temperature: 0.5,
};

describe("gemini translator", () => {
  it("builds systemInstruction + contents with model roles", () => {
    const out: any = toGeminiRequest(req);
    expect(out.systemInstruction.parts[0].text).toBe("Be brief.");
    expect(out.contents).toEqual([
      { role: "user", parts: [{ text: "Hi" }] },
      { role: "model", parts: [{ text: "Hello" }] },
    ]);
    expect(out.generationConfig.temperature).toBe(0.5);
  });

  it("builds stream and non-stream URLs", () => {
    expect(geminiUrl("https://x", "m", false, "k")).toContain(":generateContent?key=k");
    expect(geminiUrl("https://x", "m", true, "k")).toContain(":streamGenerateContent?alt=sse");
  });

  it("converts response to OpenAI shape", () => {
    const res = fromGeminiResponse(
      {
        candidates: [{ content: { parts: [{ text: "Hi!" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 },
      },
      "gemini-2.5-flash",
    );
    expect(res.choices[0]!.message.content).toBe("Hi!");
    expect(res.usage.total_tokens).toBe(11);
  });

  it("converts SSE candidates to OpenAI chunks", () => {
    const chunk: any = geminiStreamEvent(
      { candidates: [{ content: { parts: [{ text: "Hi" }] } }] },
      "m",
    );
    expect(chunk.choices[0].delta.content).toBe("Hi");
    expect(chunk.choices[0].finish_reason).toBeNull();
  });
});
