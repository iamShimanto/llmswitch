import { describe, expect, it } from "vitest";
import { CookieJar } from "../src/cookieJar.js";
import { ChatGptWebDriver } from "../src/providers/webchat/chatgpt-web.js";
import { ChatGptWebFreeDriver } from "../src/providers/webchat/chatgpt-web-free.js";
import { ClaudeWebDriver } from "../src/providers/webchat/claude-web.js";
import { ClaudeWebCookieDriver } from "../src/providers/webchat/claude-web-cookie.js";

/* ------------------------------------------------------------------ */
/* Mock fetch plumbing — no network. Records every call and dispatches */
/* to a per-test handler.                                              */
/* ------------------------------------------------------------------ */

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

function makeFetch(handler: (call: RecordedCall) => Response) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (url: unknown, init: any = {}) => {
    const call: RecordedCall = {
      url: String(url),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(text: string): Response {
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

/* Canned chatgpt.com delta_encoding:v1 stream (see chatgptWebDeltaV1.ts):
   add the assistant document, append "Hello ", append "world" via an
   inherited-path delta, then finish. */
const CHATGPT_SSE = [
  "event: delta_encoding",
  'data: "v1"',
  "",
  "event: delta",
  'data: {"p":"","o":"add","v":{"message":{"id":"msg-1","author":{"role":"assistant"},"create_time":1,"content":{"content_type":"text","parts":[""]},"status":"in_progress","end_turn":false}}}',
  "",
  "event: delta",
  'data: {"p":"/message/content/parts/0","o":"append","v":"Hello "}',
  "",
  "event: delta",
  'data: {"v":"world"}',
  "",
  "event: delta",
  'data: {"p":"/message/status","o":"replace","v":"finished_successfully"}',
  "",
  "data: [DONE]",
  "",
].join("\n");

function chatgptHandler(call: RecordedCall): Response {
  if (call.url === "https://chatgpt.com/api/auth/session") {
    return jsonResponse({ accessToken: "at-test-123", user: { id: "u1" } });
  }
  if (call.url === "https://chatgpt.com/backend-api/f/conversation") {
    return sseResponse(CHATGPT_SSE);
  }
  throw new Error(`unexpected fetch: ${call.url}`);
}

function chatgptJar(): CookieJar {
  const jar = new CookieJar();
  jar.load("__Secure-next-auth.session-token=tok123; oai-did=dev1", "chatgpt.com");
  return jar;
}

/* Canned claude.ai Anthropic-style SSE (see claude-web/stream.ts). */
const CLAUDE_SSE = [
  'data: {"type":"message_start","message":{"id":"msg_1","role":"assistant"}}',
  "",
  'data: {"type":"ping"}',
  "",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude "}}',
  "",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"says hi"}}',
  "",
  'data: {"type":"content_block_stop","index":0}',
  "",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
  "",
  'data: {"type":"message_stop"}',
  "",
].join("\n");

function claudeHandler(call: RecordedCall): Response {
  if (call.url === "https://claude.ai/api/organizations") {
    return jsonResponse([{ uuid: "org-123", name: "Personal" }]);
  }
  if (call.url.includes("/chat_conversations/") && call.url.endsWith("/completion")) {
    return sseResponse(CLAUDE_SSE);
  }
  throw new Error(`unexpected fetch: ${call.url}`);
}

function claudeJar(): CookieJar {
  const jar = new CookieJar();
  jar.load("sessionKey=sk-test-123; cf_clearance=cf-1", "claude.ai");
  return jar;
}

/* ------------------------------------------------------------------ */

describe("ChatGptWebDriver", () => {
  it("bootstrap GETs /api/auth/session with the cookie header and caches the token", async () => {
    const { calls, fetchFn } = makeFetch(chatgptHandler);
    const d = new ChatGptWebDriver(chatgptJar(), fetchFn);
    await d.bootstrap();
    await d.bootstrap(); // idempotent
    const sessionCalls = calls.filter((c) => c.url.endsWith("/api/auth/session"));
    expect(sessionCalls).toHaveLength(1);
    expect(sessionCalls[0]!.method).toBe("GET");
    expect(sessionCalls[0]!.headers.cookie).toContain(
      "__Secure-next-auth.session-token=tok123",
    );
    expect(sessionCalls[0]!.headers.authorization).toBeUndefined();
    expect(sessionCalls[0]!.headers["user-agent"]).toContain("Mozilla/5.0");
  });

  it("chat POSTs the /f/conversation body shape and extracts SSE delta text", async () => {
    const { calls, fetchFn } = makeFetch(chatgptHandler);
    const d = new ChatGptWebDriver(chatgptJar(), fetchFn);
    const text = await d.chat("gpt-5-6-thinking", [{ role: "user", content: "Say hi" }]);
    expect(text).toBe("Hello world");

    const conv = calls.find((c) => c.url.endsWith("/backend-api/f/conversation"))!;
    expect(conv.method).toBe("POST");
    expect(conv.headers.authorization).toBe("Bearer at-test-123");
    expect(conv.headers.cookie).toContain("__Secure-next-auth.session-token=tok123");
    expect(conv.body.action).toBe("next");
    // thinking variant → wire slug "gpt-5-6" + the "reason" system hint
    expect(conv.body.model).toBe("gpt-5-6");
    expect(conv.body.system_hints).toEqual(["reason"]);
    expect(conv.body.parent_message_id).toBe("client-created-root");
    expect(conv.body.conversation_mode).toEqual({ kind: "primary_assistant" });
    expect(conv.body.history_and_training_disabled).toBe(true);
    expect(conv.body.supported_encodings).toEqual(["v1"]);
    expect(conv.body.messages).toHaveLength(1);
    expect(conv.body.messages[0].author).toEqual({ role: "user" });
    expect(conv.body.messages[0].content).toEqual({
      content_type: "text",
      parts: ["Say hi"],
    });
  });

  it("chatStream yields incremental deltas", async () => {
    const { fetchFn } = makeFetch(chatgptHandler);
    const d = new ChatGptWebDriver(chatgptJar(), fetchFn);
    const deltas: string[] = [];
    for await (const delta of d.chatStream("gpt-5-6", [
      { role: "user", content: "Say hi" },
    ])) {
      deltas.push(delta);
    }
    expect(deltas.join("")).toBe("Hello world");
    expect(deltas.length).toBeGreaterThan(1);
  });

  it("throws the import hint when cookies are missing", async () => {
    const { fetchFn } = makeFetch(chatgptHandler);
    const d = new ChatGptWebDriver(new CookieJar(), fetchFn);
    await expect(d.bootstrap()).rejects.toThrow(/llmswitch cookies chatgpt-web/);
    await expect(d.chat("gpt-5-6", [{ role: "user", content: "hi" }])).rejects.toThrow(
      /llmswitch cookies chatgpt-web/,
    );
  });

  it("throws when the imported cookies lack the session token", async () => {
    const jar = new CookieJar();
    jar.load("oai-did=dev1", "chatgpt.com");
    const { fetchFn } = makeFetch(chatgptHandler);
    const d = new ChatGptWebDriver(jar, fetchFn);
    await expect(d.bootstrap()).rejects.toThrow(/__Secure-next-auth\.session-token/);
  });
});

describe("ChatGptWebFreeDriver (anonymous variant)", () => {
  it("chats with no cookies at all, wire model \"auto\", no auth headers", async () => {
    const { calls, fetchFn } = makeFetch((call) => {
      if (call.url.endsWith("/api/auth/session")) return jsonResponse({});
      return chatgptHandler(call);
    });
    const d = new ChatGptWebFreeDriver(new CookieJar(), fetchFn);
    await expect(d.bootstrap()).resolves.toBeUndefined();
    const text = await d.chat("gpt-5-6-luna-free", [{ role: "user", content: "Say hi" }]);
    expect(text).toBe("Hello world");
    const conv = calls.find((c) => c.url.endsWith("/backend-api/f/conversation"))!;
    expect(conv.body.model).toBe("auto");
    expect(conv.headers.cookie).toBeUndefined();
    expect(conv.headers.authorization).toBeUndefined();
  });

  it("sends imported cookies when present but never requires them", async () => {
    const { calls, fetchFn } = makeFetch(chatgptHandler);
    const d = new ChatGptWebFreeDriver(chatgptJar(), fetchFn);
    const text = await d.chat("gpt-5-6-luna-free-thinking", [
      { role: "user", content: "Say hi" },
    ]);
    expect(text).toBe("Hello world");
    const conv = calls.find((c) => c.url.endsWith("/backend-api/f/conversation"))!;
    expect(conv.body.model).toBe("auto");
    expect(conv.body.system_hints).toEqual(["reason"]);
    expect(conv.headers.cookie).toContain("__Secure-next-auth.session-token=tok123");
  });
});

describe("ClaudeWebDriver", () => {
  it("bootstrap GETs /api/organizations sending only the sessionKey cookie", async () => {
    const { calls, fetchFn } = makeFetch(claudeHandler);
    const d = new ClaudeWebDriver(claudeJar(), fetchFn);
    await d.bootstrap();
    await d.bootstrap(); // cached org id
    const orgCalls = calls.filter((c) => c.url === "https://claude.ai/api/organizations");
    expect(orgCalls).toHaveLength(1);
    expect(orgCalls[0]!.method).toBe("GET");
    // sessionKey extraction: the other imported cookies are NOT sent
    expect(orgCalls[0]!.headers.cookie).toBe("sessionKey=sk-test-123");
    expect(orgCalls[0]!.headers["anthropic-client-platform"]).toBe("web_claude_ai");
    expect(orgCalls[0]!.headers["user-agent"]).toContain("Chrome/149.0.0.0");
  });

  it("chat POSTs the completion payload and extracts text_delta SSE text", async () => {
    const { calls, fetchFn } = makeFetch(claudeHandler);
    const d = new ClaudeWebDriver(claudeJar(), fetchFn);
    const text = await d.chat("claude-sonnet-4-6", [{ role: "user", content: "hi claude" }]);
    expect(text).toBe("Claude says hi");

    const post = calls.find((c) => c.url.includes("/chat_conversations/"))!;
    expect(post.method).toBe("POST");
    expect(post.url).toMatch(
      /^https:\/\/claude\.ai\/api\/organizations\/org-123\/chat_conversations\/[0-9a-f-]{36}\/completion$/,
    );
    expect(post.headers.cookie).toBe("sessionKey=sk-test-123");
    expect(post.body.prompt).toBe("hi claude");
    expect(post.body.model).toBe("claude-sonnet-4-6");
    expect(post.body.rendering_mode).toBe("messages");
    expect(post.body.thinking_mode).toBe("off");
    expect(post.body.effort).toBe("low");
    expect(post.body.tools).toEqual([]);
    expect(post.body.attachments).toEqual([]);
    expect(post.body.personalized_styles[0].key).toBe("Default");
    expect(post.body.turn_message_uuids.human_message_uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.body.turn_message_uuids.assistant_message_uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.body.create_conversation_params).toEqual({
      name: "",
      model: "claude-sonnet-4-6",
      include_conversation_preferences: true,
      paprika_mode: null,
      compass_mode: null,
      is_temporary: false,
      enabled_imagine: true,
      tool_search_mode: "auto",
    });
  });

  it("chatStream yields each text_delta", async () => {
    const { fetchFn } = makeFetch(claudeHandler);
    const d = new ClaudeWebDriver(claudeJar(), fetchFn);
    const deltas: string[] = [];
    for await (const delta of d.chatStream("claude-sonnet-4-6", [
      { role: "user", content: "hi" },
    ])) {
      deltas.push(delta);
    }
    expect(deltas).toEqual(["Claude ", "says hi"]);
  });

  it("serializes multi-turn context into the recovery prompt", async () => {
    const { calls, fetchFn } = makeFetch(claudeHandler);
    const d = new ClaudeWebDriver(claudeJar(), fetchFn);
    await d.chat("claude-sonnet-4-6", [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "follow up" },
    ]);
    const post = calls.find((c) => c.url.includes("/chat_conversations/"))!;
    expect(post.body.prompt).toContain("Conversation context supplied by the caller follows");
    expect(post.body.prompt).toContain('<message role="user">\nfirst question\n</message>');
    expect(post.body.prompt).toContain('<message role="assistant">\nfirst answer\n</message>');
    expect(post.body.prompt).toContain('<message role="user">\nfollow up\n</message>');
  });

  it("throws the import hint when cookies are missing", async () => {
    const { fetchFn } = makeFetch(claudeHandler);
    const d = new ClaudeWebDriver(new CookieJar(), fetchFn);
    await expect(d.bootstrap()).rejects.toThrow(/llmswitch cookies claude-web/);
  });

  it("throws when the imported cookies lack sessionKey", async () => {
    const jar = new CookieJar();
    jar.load("cf_clearance=cf-1", "claude.ai");
    const { fetchFn } = makeFetch(claudeHandler);
    const d = new ClaudeWebDriver(jar, fetchFn);
    await expect(d.bootstrap()).rejects.toThrow(/sessionKey/);
    await expect(d.bootstrap()).rejects.toThrow(/llmswitch cookies claude-web/);
  });
});

describe("ClaudeWebCookieDriver (full Cookie header variant)", () => {
  function fullJar(): CookieJar {
    const jar = new CookieJar();
    jar.load("sessionKey=sk-cookie-9; cf_clearance=cf-9; activity=42", "claude.ai");
    return jar;
  }

  it("sends the full imported Cookie header verbatim and chats", async () => {
    const { calls, fetchFn } = makeFetch(claudeHandler);
    const d = new ClaudeWebCookieDriver(fullJar(), fetchFn);
    const text = await d.chat("claude-sonnet-4-6", [{ role: "user", content: "hi" }]);
    expect(text).toBe("Claude says hi");
    const org = calls.find((c) => c.url === "https://claude.ai/api/organizations")!;
    expect(org.headers.cookie).toBe("sessionKey=sk-cookie-9; cf_clearance=cf-9; activity=42");
    const post = calls.find((c) => c.url.includes("/chat_conversations/"))!;
    expect(post.headers.cookie).toBe("sessionKey=sk-cookie-9; cf_clearance=cf-9; activity=42");
    expect(post.body.prompt).toBe("hi");
  });

  it("throws its own import hint when cookies are missing", async () => {
    const { fetchFn } = makeFetch(claudeHandler);
    const d = new ClaudeWebCookieDriver(new CookieJar(), fetchFn);
    await expect(d.bootstrap()).rejects.toThrow(/llmswitch cookies claude-web-cookie/);
  });
});
