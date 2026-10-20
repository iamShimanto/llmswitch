import { afterEach, describe, expect, it } from "vitest";
import { CookieJar } from "../src/cookieJar.js";
import { ChatGptWebFreeDriver } from "../src/providers/webchat/chatgpt-web-free.js";

interface RecordedCall {
  url: string;
  body: any;
}

function makeFetch(handler: (call: RecordedCall) => Response) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (url: unknown, init: any = {}) => {
    const call: RecordedCall = {
      url: String(url),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const json = (v: unknown) =>
  new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });

describe("ChatGPT browser bridge (CHATGPT_BRIDGE_URL)", () => {
  afterEach(() => {
    delete process.env.CHATGPT_BRIDGE_URL;
  });

  it("routes the turn through the bridge and never touches the direct API", async () => {
    process.env.CHATGPT_BRIDGE_URL = "http://bridge.test:6100/";
    const { calls, fetchFn } = makeFetch((call) => {
      if (call.url === "https://chatgpt.com/api/auth/session") return json({});
      if (call.url === "http://bridge.test:6100/turn")
        return json({ ok: true, text: "BRIDGE-TEXT" });
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const d = new ChatGptWebFreeDriver(new CookieJar(), fetchFn);
    const text = await d.chat("gpt-5.6-luna-free", [{ role: "user", content: "Say hi" }]);
    expect(text).toBe("BRIDGE-TEXT");
    const turn = calls.find((c) => c.url.endsWith("/turn"))!;
    expect(turn.body.prompt).toBe("Say hi");
    expect(calls.some((c) => c.url.includes("/f/conversation"))).toBe(false);
  });

  it("surfaces bridge errors as driver errors", async () => {
    process.env.CHATGPT_BRIDGE_URL = "http://bridge.test:6100";
    const { fetchFn } = makeFetch((call) => {
      if (call.url === "https://chatgpt.com/api/auth/session") return json({});
      if (call.url.endsWith("/turn")) return json({ ok: false, error: "composer not found" });
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const d = new ChatGptWebFreeDriver(new CookieJar(), fetchFn);
    await expect(
      d.chat("gpt-5.6-luna-free", [{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/browser bridge: composer not found/);
  });

  it("an unreachable bridge produces a clear error", async () => {
    process.env.CHATGPT_BRIDGE_URL = "http://bridge.test:6100";
    const { fetchFn } = makeFetch((call) => {
      if (call.url === "https://chatgpt.com/api/auth/session") return json({});
      throw new Error("connect ECONNREFUSED");
    });
    const d = new ChatGptWebFreeDriver(new CookieJar(), fetchFn);
    await expect(
      d.chat("gpt-5.6-luna-free", [{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/browser bridge unreachable/);
  });
});
