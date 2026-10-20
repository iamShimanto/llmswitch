import { describe, expect, it } from "vitest";
import { Inspector, replayEntry } from "../src/inspect/index.js";
import type { ChatCompletionRequest } from "../src/providers/types.js";
import type { ExecuteResult } from "../src/executor/http.js";
import type { RouteOptions } from "../src/router/index.js";

type RouteFn = (body: ChatCompletionRequest, opts?: RouteOptions) => Promise<ExecuteResult>;

function entry(over: Record<string, unknown> = {}) {
  const inspector = new Inspector();
  const body: ChatCompletionRequest = {
    model: "auto",
    messages: [{ role: "user", content: "Say hi" }],
  };
  return inspector.record({
    keyId: null,
    provider: "groq",
    model: "llama-3",
    strategy: "priority",
    status: "ok",
    latencyMs: 120,
    cached: false,
    promptTokens: 5,
    completionTokens: 3,
    costUsd: 0.0001,
    request: [{ role: "user", content: "Say hi" }],
    responsePreview: "Hello!",
    fullBody: body,
    ...over,
  });
}

function okResult(text: string): ExecuteResult {
  return {
    providerId: "groq",
    model: "llama-3",
    latencyMs: 99,
    response: {
      id: "c1",
      model: "llama-3",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    },
  };
}

describe("inspector replay", () => {
  it("replays with bypassCache and reports an identical diff", async () => {
    const e = entry();
    let seenOpts: RouteOptions | undefined;
    const routeFn: RouteFn = async (body, opts) => {
      seenOpts = opts;
      expect(body).toBe(e.fullBody);
      return okResult("Hello!");
    };
    const out = await replayEntry(e, routeFn);
    expect(seenOpts?.bypassCache).toBe(true);
    expect(out.diff.same).toBe(true);
    expect(out.providerId).toBe("groq");
    expect(out.text).toBe("Hello!");
  });

  it("reports a changed diff", async () => {
    const e = entry();
    const routeFn: RouteFn = async () => okResult("Something else entirely");
    const out = await replayEntry(e, routeFn);
    expect(out.diff.same).toBe(false);
    expect(out.diff.origChars).toBe("Hello!".length);
    expect(out.diff.newChars).toBe("Something else entirely".length);
    expect(out.diff.newPreview).toBe("Something else entirely");
  });

  it("assembles streamed replays", async () => {
    const e = entry();
    async function* gen() {
      yield { choices: [{ delta: { content: "Hel" } }] };
      yield { choices: [{ delta: { content: "lo!" } }] };
    }
    const routeFn: RouteFn = async () => ({ providerId: "x", model: "m", latencyMs: 1, stream: gen() });
    const out = await replayEntry(e, routeFn);
    expect(out.text).toBe("Hello!");
    expect(out.diff.same).toBe(true);
  });

  it("throws when no full body was captured", async () => {
    const e = entry({ fullBody: undefined });
    const routeFn: RouteFn = async () => okResult("x");
    await expect(replayEntry(e, routeFn)).rejects.toThrow(/not captured/);
  });

  it("propagates router errors", async () => {
    const e = entry();
    const routeFn: RouteFn = async () => {
      throw new Error("no providers connected");
    };
    await expect(replayEntry(e, routeFn)).rejects.toThrow(/no providers connected/);
  });
});
