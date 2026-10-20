import { describe, expect, it } from "vitest";
import { classifyTask, taskAwareOrder } from "../src/router/taskAware.js";
import type { ResolvedProvider } from "../src/providers/types.js";

function prov(id: string): ResolvedProvider {
  return {
    id, name: id, baseUrl: "https://example.com", wireFormat: "openai",
    models: ["m"], defaultModel: "m", costTier: 3, apiKey: "k",
  };
}

const msg = (content: string) => ({ role: "user" as const, content });

describe("classifyTask", () => {
  it("detects code", () => {
    expect(classifyTask({ model: "auto", messages: [msg("```python\ndef f():")] })).toBe("code");
    expect(classifyTask({ model: "auto", messages: [msg("import numpy as np")] })).toBe("code");
  });
  it("detects reasoning", () => {
    expect(classifyTask({ model: "auto", messages: [msg("Prove that sqrt(2) is irrational")] })).toBe("reasoning");
  });
  it("detects writing", () => {
    expect(classifyTask({ model: "auto", messages: [msg("Write an essay about rivers")] })).toBe("writing");
  });
  it("defaults to chat", () => {
    expect(classifyTask({ model: "auto", messages: [msg("hello, how are you?")] })).toBe("chat");
  });
});

describe("taskAwareOrder", () => {
  it("routes code to deepseek first when available", () => {
    const ps = [prov("openai"), prov("deepseek"), prov("groq")];
    const { order, task } = taskAwareOrder(ps, { model: "auto", messages: [msg("fix this function:\ndef f():")] });
    expect(task).toBe("code");
    expect(order[0]!.id).toBe("deepseek");
  });
  it("routes plain chat cost-optimized", () => {
    const ps = [prov("openai"), prov("groq")];
    const { order, task } = taskAwareOrder(ps, { model: "auto", messages: [msg("hi")] });
    expect(task).toBe("chat");
    expect(order.map((p) => p.id).sort()).toEqual(["groq", "openai"]);
  });
});
