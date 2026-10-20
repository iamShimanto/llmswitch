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

  it("a chat turn that generated an image appends it as a markdown data URL", async () => {
    process.env.CHATGPT_BRIDGE_URL = "http://bridge.test:6100";
    const { fetchFn } = makeFetch((call) => {
      if (call.url === "https://chatgpt.com/api/auth/session") return json({});
      if (call.url.endsWith("/turn"))
        return json({ ok: true, text: "Here you go", image: { b64: "QUJD", mime: "image/png" } });
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const d = new ChatGptWebFreeDriver(new CookieJar(), fetchFn);
    const text = await d.chat("gpt-5.6-luna-free", [{ role: "user", content: "draw a cat" }]);
    expect(text).toContain("Here you go");
    expect(text).toContain("![generated image](data:image/png;base64,QUJD)");
  });

  it("generateImage asks the bridge for an image turn and returns the bytes", async () => {
    process.env.CHATGPT_BRIDGE_URL = "http://bridge.test:6100";
    const { calls, fetchFn } = makeFetch((call) => {
      if (call.url === "https://chatgpt.com/api/auth/session") return json({});
      if (call.url.endsWith("/turn"))
        return json({ ok: true, text: "", image: { b64: "AAAABBBB", mime: "image/jpeg" } });
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const d = new ChatGptWebFreeDriver(new CookieJar(), fetchFn);
    const img = await d.generateImage!("a red panda");
    expect(img.b64).toBe("AAAABBBB");
    expect(img.mime).toBe("image/jpeg");
    const turn = calls.find((c) => c.url.endsWith("/turn"))!;
    expect(turn.body.wantImage).toBe(true);
    expect(turn.body.prompt).toBe("a red panda");
  });

  it("generateImage surfaces the assistant's refusal when no image comes back", async () => {
    process.env.CHATGPT_BRIDGE_URL = "http://bridge.test:6100";
    const { fetchFn } = makeFetch((call) => {
      if (call.url === "https://chatgpt.com/api/auth/session") return json({});
      if (call.url.endsWith("/turn"))
        return json({ ok: true, text: "You need to log in to generate images." });
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const d = new ChatGptWebFreeDriver(new CookieJar(), fetchFn);
    await expect(d.generateImage!("a cat")).rejects.toThrow(
      /did not generate an image — it replied: You need to log in/,
    );
  });

  it("generateImage without the bridge configured is a clear error", async () => {
    delete process.env.CHATGPT_BRIDGE_URL;
    const { fetchFn } = makeFetch((call) => {
      if (call.url === "https://chatgpt.com/api/auth/session") return json({});
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const d = new ChatGptWebFreeDriver(new CookieJar(), fetchFn);
    await expect(d.generateImage!("a cat")).rejects.toThrow(/needs the browser bridge/);
  });
});
