import { describe, expect, it, afterEach } from "vitest";
import { CookieJar } from "../src/cookieJar.js";
import type { ChatMessage } from "../src/cookieChat.js";
import { WebChatError } from "../src/providers/webchat/types.js";
import { HuggingChatDriver } from "../src/providers/webchat/huggingchat.js";
import {
  LmArenaDriver,
  reconstructLMArenaCookie,
} from "../src/providers/webchat/lmarena.js";
import { PoeWebDriver } from "../src/providers/webchat/poe.js";
import { BlackboxWebDriver } from "../src/providers/webchat/blackbox.js";

const USER_MSG: ChatMessage[] = [{ role: "user", content: "hi" }];

function jarWith(raw: string, domain: string): CookieJar {
  const jar = new CookieJar();
  jar.load(raw, domain);
  return jar;
}

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((url: unknown, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init ?? {}))) as unknown as typeof fetch;
}

const HF_STREAM_BODY =
  `{"type":"status","status":"started"}\n` +
  `{"type":"stream","token":"Hello\\u0000\\u0000\\u0000"}\n` +
  `{"type":"finalAnswer","text":"Hello world"}\n`;

/** HuggingChat: conversation-create -> root id -> JSONL message post. */
function hfMockFetch(seen: { create?: unknown; data?: unknown }) {
  return mockFetch((url, init) => {
    if (url === "https://huggingface.co/chat/conversation") {
      seen.create = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ conversationId: "conv1" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://huggingface.co/chat/api/v2/conversations/conv1") {
      return new Response(
        JSON.stringify({ json: { rootMessageId: "msg1" } }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://huggingface.co/chat/conversation/conv1") {
      const data = (init.body as FormData).get("data");
      seen.data = JSON.parse(String(data));
      return new Response(HF_STREAM_BODY, {
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("HuggingChatDriver", () => {
  it("bootstrap is idempotent and errors without cookies with an import hint", async () => {
    const d = new HuggingChatDriver(jarWith("hf-chat=abc", "huggingface.co"));
    await d.bootstrap();
    await d.bootstrap();
    const noCookie = new HuggingChatDriver(new CookieJar());
    await expect(noCookie.bootstrap()).rejects.toThrowError(
      /llmswitch cookies huggingchat/,
    );
  });

  it("creates a conversation then posts the message and parses JSONL", async () => {
    const seen: { create?: unknown; data?: unknown } = {};
    const d = new HuggingChatDriver(
      jarWith("hf-chat=abc", "huggingface.co"),
      hfMockFetch(seen),
    );
    const reply = await d.chat("", USER_MSG);
    expect(reply).toBe("Hello world");
    expect(seen.create).toMatchObject({
      model: "baidu/ERNIE-4.5-VL-424B-A47B-Base-PT",
    });
    expect(seen.data).toMatchObject({
      inputs: "hi",
      is_retry: false,
      is_continue: false,
      id: "msg1",
    });
  });

  it("sends system content as preprompt and yields stream tokens", async () => {
    const seen: { create?: unknown; data?: unknown } = {};
    const d = new HuggingChatDriver(
      jarWith("hf-chat=abc", "huggingface.co"),
      hfMockFetch(seen),
    );
    const chunks: string[] = [];
    for await (const c of d.chatStream("openai/gpt-oss-120b", [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ])) {
      chunks.push(c);
    }
    expect(chunks.join("")).toBe("Hello world");
    expect(seen.create).toMatchObject({
      model: "openai/gpt-oss-120b",
      preprompt: "be brief",
    });
    expect((seen.data as { inputs: string }).inputs).toBe("hi");
  });

  it("builds a multi-turn transcript for the inputs prompt", async () => {
    const seen: { create?: unknown; data?: unknown } = {};
    const d = new HuggingChatDriver(
      jarWith("hf-chat=abc", "huggingface.co"),
      hfMockFetch(seen),
    );
    await d.chat("", [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
    expect((seen.data as { inputs: string }).inputs).toBe(
      "User: q1\n\nAssistant: a1\n\nUser: q2\n\nAssistant:",
    );
  });

  it("throws WebChatError on an upstream stream error event", async () => {
    const fetchFn = mockFetch((url, init) => {
      if (url === "https://huggingface.co/chat/conversation")
        return new Response(JSON.stringify({ conversationId: "conv1" }));
      if (url.startsWith("https://huggingface.co/chat/api/v2/conversations/"))
        return new Response(JSON.stringify({ rootMessageId: "msg1" }));
      return new Response(
        `{"type":"status","status":"error","message":"rate limited"}\n`,
      );
    });
    const d = new HuggingChatDriver(jarWith("hf-chat=abc", "huggingface.co"), fetchFn);
    await expect(d.chat("", USER_MSG)).rejects.toThrowError(WebChatError);
    await expect(d.chat("", USER_MSG)).rejects.toThrowError(/rate limited/);
  });

  it("throws WebChatError on missing conversationId", async () => {
    const fetchFn = mockFetch((url) => {
      if (url === "https://huggingface.co/chat/conversation")
        return new Response(JSON.stringify({}));
      return new Response("nope", { status: 404 });
    });
    const d = new HuggingChatDriver(jarWith("hf-chat=abc", "huggingface.co"), fetchFn);
    await expect(d.chat("", USER_MSG)).rejects.toThrowError(/conversationId/);
  });
});

describe("LmArenaDriver", () => {
  const UUID = "a14546b5-d78d-4cf6-bb61-ab5b8510a9d6";
  const ARENA_SSE = `data: 0:"hel"\ndata: 2:{}\ndata: 0:"lo"\ndata: d:{"finishReason":"stop"}\n`;

  function arenaMockFetch(seen: { body?: unknown; cookie?: string }) {
    return mockFetch((url, init) => {
      expect(url).toBe("https://arena.ai/nextjs-api/stream/create-evaluation");
      seen.body = JSON.parse(String(init.body));
      seen.cookie = (init.headers as Record<string, string>).cookie;
      return new Response(ARENA_SSE, {
        headers: { "content-type": "text/event-stream" },
      });
    });
  }

  it("reconstructs the chunked arena-auth cookie and posts the direct-battle payload", async () => {
    const seen: { body?: unknown; cookie?: string } = {};
    const jar = jarWith(
      "arena-auth-prod-v1.0=AA; arena-auth-prod-v1.1=BB; other=1",
      "arena.ai",
    );
    const d = new LmArenaDriver(jar, arenaMockFetch(seen));
    const reply = await d.chat(UUID, USER_MSG);
    expect(reply).toBe("hello");
    expect(seen.cookie).toBe("arena-auth-prod-v1=AABB; other=1");
    expect(seen.body).toMatchObject({
      mode: "direct-battle",
      modelAId: UUID,
      userMessage: {
        content: "hi",
        experimental_attachments: [],
        metadata: {},
      },
      modality: "chat",
      recaptchaV3Token: null,
    });
  });

  it("passes a whole auth cookie through unchanged", () => {
    expect(reconstructLMArenaCookie("arena-auth-prod-v1=FULL; x=1")).toBe(
      "arena-auth-prod-v1=FULL; x=1",
    );
  });

  it("formats multi-turn prompts with role labels", async () => {
    const seen: { body?: unknown; cookie?: string } = {};
    const jar = jarWith("arena-auth-prod-v1=FULL", "arena.ai");
    const d = new LmArenaDriver(jar, arenaMockFetch(seen));
    await d.chat(UUID, [
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
      { role: "user", content: "q2" },
    ]);
    const content = (seen.body as { userMessage: { content: string } }).userMessage
      .content;
    expect(content).toBe("System: sys\n\nUser: q\n\nAssistant: a\n\nUser: q2");
  });

  it("streams text deltas and stops at done", async () => {
    const jar = jarWith("arena-auth-prod-v1=FULL", "arena.ai");
    const d = new LmArenaDriver(jar, arenaMockFetch({}));
    const chunks: string[] = [];
    for await (const c of d.chatStream(UUID, USER_MSG)) chunks.push(c);
    expect(chunks).toEqual(["hel", "lo"]);
  });

  it("throws WebChatError on an upstream error event and on missing cookies", async () => {
    const fetchFn = mockFetch(() =>
      new Response(`data: 3:{"error":"blocked"}\n`),
    );
    const d = new LmArenaDriver(jarWith("arena-auth-prod-v1=FULL", "arena.ai"), fetchFn);
    await expect(d.chat(UUID, USER_MSG)).rejects.toThrowError(/blocked/);
    const noCookie = new LmArenaDriver(new CookieJar());
    await expect(noCookie.chat(UUID, USER_MSG)).rejects.toThrowError(
      /llmswitch cookies lmarena/,
    );
  });
});

describe("PoeWebDriver", () => {
  function poeMockFetch(seen: { body?: unknown; cookie?: string }) {
    return mockFetch((url, init) => {
      expect(url).toBe("https://www.poe.com/api/gql_POST");
      seen.body = JSON.parse(String(init.body));
      seen.cookie = (init.headers as Record<string, string>).cookie;
      return new Response(
        JSON.stringify({
          data: { chatWithBot: { messageId: "1", text: "poe reply", state: "complete" } },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
  }

  it("sends ChatViewQuery with the p-b cookie and maps model to a Poe bot name", async () => {
    const seen: { body?: unknown; cookie?: string } = {};
    const d = new PoeWebDriver(jarWith("p-b=SECRET; other=1", "poe.com"), poeMockFetch(seen));
    const reply = await d.chat("gpt-4o", [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "hi" },
    ]);
    expect(reply).toBe("poe reply");
    expect(seen.cookie).toBe("p-b=SECRET");
    expect(seen.body).toMatchObject({
      operationName: "ChatViewQuery",
      variables: { bot: "GPT-4o", query: "hi" },
    });
  });

  it("passes unmapped model names through as the bot name", async () => {
    const seen: { body?: unknown; cookie?: string } = {};
    const d = new PoeWebDriver(jarWith("p-b=SECRET", "poe.com"), poeMockFetch(seen));
    await d.chat("Claude-Sonnet-4", USER_MSG);
    expect(seen.body).toMatchObject({
      variables: { bot: "Claude-Sonnet-4", query: "hi" },
    });
  });

  it("emits the whole reply as one stream chunk", async () => {
    const d = new PoeWebDriver(jarWith("p-b=SECRET", "poe.com"), poeMockFetch({}));
    const chunks: string[] = [];
    for await (const c of d.chatStream("gpt-4o", USER_MSG)) chunks.push(c);
    expect(chunks).toEqual(["poe reply"]);
  });

  it("throws on GraphQL errors and on HTTP errors", async () => {
    const gqlErr = new PoeWebDriver(
      jarWith("p-b=SECRET", "poe.com"),
      mockFetch(() =>
        new Response(JSON.stringify({ errors: [{ message: "bot offline" }] })),
      ),
    );
    await expect(gqlErr.chat("gpt-4o", USER_MSG)).rejects.toThrowError(/bot offline/);
    const httpErr = new PoeWebDriver(
      jarWith("p-b=SECRET", "poe.com"),
      mockFetch(() => new Response("bad", { status: 403 })),
    );
    await expect(httpErr.chat("gpt-4o", USER_MSG)).rejects.toThrowError(/HTTP 403/);
  });

  it("requires the p-b cookie with an import hint", async () => {
    const missing = new PoeWebDriver(jarWith("other=1", "poe.com"), poeMockFetch({}));
    await expect(missing.chat("gpt-4o", USER_MSG)).rejects.toThrowError(/p-b/);
    const empty = new PoeWebDriver(new CookieJar(), poeMockFetch({}));
    await expect(empty.chat("gpt-4o", USER_MSG)).rejects.toThrowError(
      /llmswitch cookies poe/,
    );
  });
});

describe("BlackboxWebDriver", () => {
  interface BbSeen {
    calls: string[];
    body?: unknown;
    cookie?: string;
    referer?: string;
  }

  function bbMockFetch(seen: BbSeen, chatText = "bb reply") {
    return mockFetch((url, init) => {
      seen.calls.push(String(url));
      if (url === "https://app.blackbox.ai/api/auth/session") {
        return new Response(JSON.stringify({ user: { email: "u@example.com" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://app.blackbox.ai/api/check-subscription") {
        return new Response(
          JSON.stringify({ hasActiveSubscription: true, customerId: "c1" }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://app.blackbox.ai/api/chat") {
        seen.body = JSON.parse(String(init.body));
        const headers = init.headers as Record<string, string>;
        seen.cookie = headers.cookie;
        seen.referer = headers.referer;
        return new Response(chatText, { headers: { "content-type": "text/plain" } });
      }
      return new Response("not found", { status: 404 });
    });
  }

  function bbDriver(seen: BbSeen, chatText?: string): BlackboxWebDriver {
    const jar = jarWith("connect.sid=sess; next-auth.session-token=tok", "app.blackbox.ai");
    return new BlackboxWebDriver(jar, bbMockFetch(seen, chatText));
  }

  afterEach(() => {
    delete process.env.BLACKBOX_WEB_VALIDATED_TOKEN;
  });

  it("bootstraps session+subscription once and posts the chat body", async () => {
    const seen: BbSeen = { calls: [] };
    const d = bbDriver(seen);
    await d.bootstrap();
    await d.bootstrap(); // idempotent: no second session fetch
    const reply = await d.chat("blackboxai", USER_MSG);
    expect(reply).toBe("bb reply");
    expect(seen.calls.filter((c) => c.endsWith("/auth/session"))).toHaveLength(1);
    const body = seen.body as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", content: "hi" });
    expect(typeof messages[0]!.id).toBe("string");
    expect((messages[0]!.id as string).length).toBe(7);
    expect(body).toMatchObject({
      userSelectedModel: "blackboxai",
      userSelectedAgent: "VscodeAgent",
      isPremium: true,
      teamAccount: "u@example.com",
    });
    expect((body.subscriptionCache as { status: string }).status).toBe("PREMIUM");
    expect((body.session as { user: { email: string } }).user.email).toBe(
      "u@example.com",
    );
    expect(typeof body.validated).toBe("string");
    expect((body.validated as string).length).toBeGreaterThan(0);
    expect(seen.cookie).toContain("connect.sid=sess");
    expect(seen.cookie).toContain("next-auth.session-token=tok");
    expect(seen.referer).toMatch(/^https:\/\/app\.blackbox\.ai\/chat\//);
  });

  it("uses BLACKBOX_WEB_VALIDATED_TOKEN when set", async () => {
    process.env.BLACKBOX_WEB_VALIDATED_TOKEN = "frontend-tk-123";
    const seen: BbSeen = { calls: [] };
    await bbDriver(seen).chat("m", USER_MSG);
    expect((seen.body as Record<string, unknown>).validated).toBe(
      "frontend-tk-123",
    );
  });

  it("folds system messages into the first user message", async () => {
    const seen: BbSeen = { calls: [] };
    await bbDriver(seen).chat("m", [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
    const messages = (seen.body as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    expect(messages[0]!.content).toBe("System instructions:\nbe terse\n\nhi");
  });

  it("emits the plain-text reply as one stream chunk", async () => {
    const chunks: string[] = [];
    for await (const c of bbDriver({ calls: [] }).chatStream("m", USER_MSG)) {
      chunks.push(c);
    }
    expect(chunks).toEqual(["bb reply"]);
  });

  it("detects in-band subscription/rate-limit errors and 403s", async () => {
    const sub = bbDriver({ calls: [] }, "Please upgrade to a premium plan");
    await expect(sub.chat("m", USER_MSG)).rejects.toThrowError(/premium subscription/);
    const rl = bbDriver({ calls: [] }, "Rate limit exceeded");
    await expect(rl.chat("m", USER_MSG)).rejects.toThrowError(/rate limit/i);

    const jar = jarWith("connect.sid=sess", "app.blackbox.ai");
    const f403 = mockFetch((url) => {
      if (url.endsWith("/auth/session")) return new Response("{}");
      if (url.endsWith("/check-subscription")) return new Response("{}");
      return new Response("invalid validated token", { status: 403 });
    });
    const d = new BlackboxWebDriver(jar, f403);
    await expect(d.chat("m", USER_MSG)).rejects.toThrowError(
      /BLACKBOX_WEB_VALIDATED_TOKEN/,
    );
  });

  it("errors without cookies with an import hint", async () => {
    const d = new BlackboxWebDriver(
      new CookieJar(),
      mockFetch(() => new Response("nope", { status: 500 })),
    );
    await expect(d.bootstrap()).rejects.toThrowError(/llmswitch cookies blackbox/);
  });
});
