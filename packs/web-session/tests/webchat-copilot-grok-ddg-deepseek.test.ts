/**
 * Mock-only tests for the copilot-web / grok-web / duckduckgo / deepseek-web
 * cookie web-chat drivers (P11-J). No network: fetch and WebSocket are faked.
 */
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { CookieJar } from "../src/cookieJar.js";
import {
  CopilotWebDriver,
  copilotMode,
  solveHashcash,
  type CopilotSocket,
} from "../src/providers/webchat/copilot-web.js";
import { GrokWebDriver } from "../src/providers/webchat/grok-web.js";
import { DuckDuckGoDriver } from "../src/providers/webchat/duckduckgo.js";
import {
  DeepSeekWebDriver,
  type PowChallenge,
} from "../src/providers/webchat/deepseek-web.js";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function jsonRes(obj: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function textRes(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers });
}

/* ───────────────────────────── copilot-web ───────────────────────────── */

class FakeSocket implements CopilotSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(
    public url: string,
    private onSend: (s: FakeSocket, frame: Record<string, unknown>) => void = () => {},
  ) {}
  open(): void {
    this.onopen?.();
  }
  emit(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  send(data: string): void {
    this.sent.push(data);
    this.onSend(this, JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.onclose?.();
  }
}

function copilotJar(): CookieJar {
  const jar = new CookieJar();
  jar.load("access_token=tok123; _RwBf=zzz", "copilot.microsoft.com");
  return jar;
}

describe("CopilotWebDriver", () => {
  it("throws a missing-cookie error with the import hint", async () => {
    const d = new CopilotWebDriver(new CookieJar());
    await expect(d.bootstrap()).rejects.toThrow(/llmswitch cookies copilot-web/);
  });

  it("maps models to Copilot modes and solves hashcash", () => {
    expect(copilotMode("gpt-5")).toBe("smart");
    expect(copilotMode("o1")).toBe("reasoning");
    expect(copilotMode("gpt-4-turbo")).toBe("chat");
    expect(copilotMode("unknown")).toBe("chat");
    const n = solveHashcash("abc", 1);
    expect(typeof n).toBe("number");
    expect(createHash("sha256").update(`abc:${n}`).digest("hex").startsWith("0")).toBe(true);
    expect(solveHashcash("abc", 99)).toBeNull();
  });

  it("creates a conversation then streams appendText over WS", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonRes({ currentConversationId: "conv-1" });
    }) as unknown as typeof fetch;

    const sockets: FakeSocket[] = [];
    const d = new CopilotWebDriver(copilotJar(), fetchFn, (url) => {
      const s = new FakeSocket(url, (sock, frame) => {
        if (frame.event === "send") {
          sock.emit({ event: "appendText", text: "Hello " });
          sock.emit({ event: "appendText", text: "world" });
          sock.emit({ event: "done" });
        }
      });
      sockets.push(s);
      return s;
    });

    const consuming = (async () => {
      let out = "";
      for await (const chunk of d.chatStream("gpt-4", [{ role: "user", content: "hi" }])) out += chunk;
      return out;
    })();
    await tick();
    sockets[0]!.open();
    await expect(consuming).resolves.toBe("Hello world");

    // conversation-creation request shape
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://copilot.microsoft.com/c/api/start");
    const init = calls[0]!.init!;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok123");
    expect(headers.cookie).toContain("access_token=tok123");
    expect(JSON.parse(String(init.body))).toMatchObject({
      startNewConversation: true,
      teenSupportEnabled: false,
    });

    // WS url carries clientSessionId + accessToken (headers impossible in Node WS)
    const wsUrl = new URL(sockets[0]!.url);
    expect(wsUrl.protocol).toBe("wss:");
    expect(wsUrl.searchParams.get("clientSessionId")).toBeTruthy();
    expect(wsUrl.searchParams.get("accessToken")).toBe("tok123");

    // the send frame
    const frame = JSON.parse(sockets[0]!.sent[0]!) as Record<string, unknown>;
    expect(frame).toMatchObject({
      event: "send",
      conversationId: "conv-1",
      mode: "chat",
      content: [{ type: "text", text: "hi" }],
    });
  });

  it("answers a hashcash challenge then continues streaming", async () => {
    const fetchFn = vi.fn(async () => jsonRes({ conversationId: "conv-2" })) as unknown as typeof fetch;
    const sockets: FakeSocket[] = [];
    const d = new CopilotWebDriver(copilotJar(), fetchFn, (url) => {
      const s = new FakeSocket(url, (sock, frame) => {
        if (frame.event === "send") {
          sock.emit({ event: "challenge", method: "hashcash", parameter: "seed:1" });
        } else if (frame.event === "challengeResponse") {
          sock.emit({ event: "appendText", text: "after challenge" });
          sock.emit({ event: "done" });
        }
      });
      sockets.push(s);
      return s;
    });
    const consuming = (async () => {
      let out = "";
      for await (const chunk of d.chatStream("copilot", [{ role: "user", content: "hi" }])) out += chunk;
      return out;
    })();
    await tick();
    sockets[0]!.open();
    await expect(consuming).resolves.toBe("after challenge");
    const response = JSON.parse(sockets[0]!.sent[1]!) as Record<string, unknown>;
    expect(response.event).toBe("challengeResponse");
    expect(response.method).toBe("hashcash");
    const n = Number(response.token);
    expect(createHash("sha256").update(`seed:${n}`).digest("hex").startsWith("0")).toBe(true);
  });

  it("surfaces WS error events as WebChatError", async () => {
    const fetchFn = vi.fn(async () => jsonRes({ conversationId: "conv-3" })) as unknown as typeof fetch;
    const sockets: FakeSocket[] = [];
    const d = new CopilotWebDriver(copilotJar(), fetchFn, (url) => {
      const s = new FakeSocket(url, (sock, frame) => {
        if (frame.event === "send") sock.emit({ event: "error", error: "boom" });
      });
      sockets.push(s);
      return s;
    });
    const consuming = (async () => {
      for await (const _ of d.chatStream("copilot", [{ role: "user", content: "hi" }])) void _;
    })();
    await tick();
    sockets[0]!.open();
    await expect(consuming).rejects.toThrow(/Copilot stream error: boom/);
  });
});

/* ─────────────────────────────── grok-web ────────────────────────────── */

function grokJar(): CookieJar {
  const jar = new CookieJar();
  jar.load("sso=sso-value; sso-rw=rw-value", "grok.com");
  return jar;
}

const GROK_URL = "https://grok.com/rest/app-chat/conversations/new";

function grokFetch(lines: string[], status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return textRes(lines.join("\n"), status, { "content-type": "application/x-ndjson" });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("GrokWebDriver", () => {
  it("throws a missing-cookie error with the import hint", async () => {
    const d = new GrokWebDriver(new CookieJar());
    await expect(d.bootstrap()).rejects.toThrow(/llmswitch cookies grok-web/);
    await expect(d.bootstrap()).rejects.toThrow(/sso/);
  });

  it("posts the OmniRoute payload and assembles NDJSON token deltas", async () => {
    const { fetchFn, calls } = grokFetch([
      JSON.stringify({ result: { response: { token: "think", isThinking: true } } }),
      JSON.stringify({ result: { response: { token: "Hello " } } }),
      JSON.stringify({ result: { response: { token: "world" } } }),
    ]);
    const d = new GrokWebDriver(grokJar(), fetchFn);
    const out = await d.chat("expert", [{ role: "user", content: "hi grok" }]);
    expect(out).toBe("Hello world"); // thinking token excluded

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(GROK_URL);
    const init = calls[0]!.init!;
    const headers = init.headers as Record<string, string>;
    expect(headers.cookie).toContain("sso=sso-value");
    expect(headers["x-statsig-id"]).toBeTruthy();
    expect(headers["x-xai-request-id"]).toBeTruthy();
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ temporary: true, modeId: "expert", message: "hi grok" });
  });

  it("falls back to modelResponse.message when no tokens stream", async () => {
    const { fetchFn } = grokFetch([
      JSON.stringify({ result: { response: { modelResponse: { message: "final answer" } } } }),
    ]);
    const d = new GrokWebDriver(grokJar(), fetchFn);
    await expect(d.chat("fast", [{ role: "user", content: "q" }])).resolves.toBe("final answer");
  });

  it("surfaces stream error events", async () => {
    const { fetchFn } = grokFetch([JSON.stringify({ error: { message: "nope", code: "X" } })]);
    const d = new GrokWebDriver(grokJar(), fetchFn);
    await expect(d.chat("fast", [{ role: "user", content: "q" }])).rejects.toThrow(/Grok stream error: nope/);
  });

  it("maps 403 to an expired-sso message", async () => {
    const { fetchFn } = grokFetch(["forbidden"], 403);
    const d = new GrokWebDriver(grokJar(), fetchFn);
    await expect(d.chat("fast", [{ role: "user", content: "q" }])).rejects.toThrow(/sso cookie may be expired/);
  });
});

/* ────────────────────────────── duckduckgo ───────────────────────────── */

function ddgJar(): CookieJar {
  const jar = new CookieJar();
  jar.load("5=1; ah=wt-wt", "duck.ai");
  return jar;
}

describe("DuckDuckGoDriver", () => {
  it("throws a missing-cookie error with the import hint", async () => {
    const d = new DuckDuckGoDriver(new CookieJar());
    await expect(d.bootstrap()).rejects.toThrow(/llmswitch cookies duckduckgo/);
  });

  it("bootstraps x-vqd-4 from /status and posts the chat payload", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/duckchat/v1/status")) {
        return textRes("", 200, { "x-vqd-4": "vqd-abc" });
      }
      return textRes(
        'data: {"message":"Hi "}\n\ndata: {"message":"there"}\n\ndata: [DONE]\n\n',
        200,
        { "content-type": "text/event-stream" },
      );
    }) as unknown as typeof fetch;

    const d = new DuckDuckGoDriver(ddgJar(), fetchFn);
    await d.bootstrap();
    await d.bootstrap(); // idempotent: no second /status call
    const out = await d.chat("gpt-4o-mini", [{ role: "user", content: "hello" }]);
    expect(out).toBe("Hi there");

    const statusCall = calls.find((c) => c.url.endsWith("/duckchat/v1/status"))!;
    expect((statusCall.init!.headers as Record<string, string>)["x-vqd-accept"]).toBe("1");
    expect(calls.filter((c) => c.url.endsWith("/duckchat/v1/status"))).toHaveLength(1);

    const chatCall = calls.find((c) => c.url.endsWith("/duckchat/v1/chat"))!;
    const headers = chatCall.init!.headers as Record<string, string>;
    expect(headers["x-vqd-4"]).toBe("vqd-abc");
    const body = JSON.parse(String(chatCall.init!.body)) as Record<string, unknown>;
    expect(body.model).toBe("gpt-5.4-mini"); // alias-normalized
    expect(body.reasoningEffort).toBe("none"); // required upstream
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("surfaces HTTP 418 as the known ERR_CHALLENGE anti-bot failure", async () => {
    const fetchFn = vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/status")) return textRes("", 200, { "x-vqd-4": "v" });
      return textRes(JSON.stringify({ type: "ERR_CHALLENGE" }), 418);
    }) as unknown as typeof fetch;
    const d = new DuckDuckGoDriver(ddgJar(), fetchFn);
    await expect(d.chat("gpt-5.4-mini", [{ role: "user", content: "hi" }])).rejects.toThrow(
      /418 ERR_CHALLENGE/,
    );
  });

  it("requires a solver for x-vqd-hash-1 challenges (default: NEEDS LIVE VERIFICATION)", async () => {
    const fetchFn = vi.fn(async () => textRes("", 200, { "x-vqd-hash-1": "aGFzaA==" })) as unknown as typeof fetch;
    const d = new DuckDuckGoDriver(ddgJar(), fetchFn);
    await expect(d.bootstrap()).rejects.toThrow(/NEEDS LIVE VERIFICATION/);
  });

  it("uses an injected challenge solver's result as the vqd token", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      if (String(url).endsWith("/status")) return textRes("", 200, { "x-vqd-hash-1": "aGFzaA==" });
      return textRes('data: {"content":"ok"}\n\n', 200, { "content-type": "text/event-stream" });
    }) as unknown as typeof fetch;
    const solver = vi.fn(async (h: string) => `solved:${h}`);
    const d = new DuckDuckGoDriver(ddgJar(), fetchFn, { challengeSolver: solver });
    await expect(d.chat("gpt-5.4-mini", [{ role: "user", content: "hi" }])).resolves.toBe("ok");
    expect(solver).toHaveBeenCalledWith("aGFzaA==");
    const chatCall = seen.find((c) => c.url.endsWith("/chat"))!;
    expect((chatCall.init!.headers as Record<string, string>)["x-vqd-4"]).toBe("solved:aGFzaA==");
  });
});

/* ───────────────────────────── deepseek-web ──────────────────────────── */

function deepseekJar(): CookieJar {
  const jar = new CookieJar();
  jar.load("user-token=ut-123; other=1", "chat.deepseek.com");
  return jar;
}

const DS = "https://chat.deepseek.com/api/v0";

function deepseekFetch(completionBody: string) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u === `${DS}/users/current`) return jsonRes({ code: 0, data: { biz_data: { token: "at-xyz" } } });
    if (u === `${DS}/chat_session/create`) return jsonRes({ data: { biz_data: { chat_session: { id: "sess-1" } } } });
    if (u === `${DS}/chat/create_pow_challenge`) {
      return jsonRes({
        data: {
          biz_data: {
            challenge: {
              algorithm: "DeepSeekHashV1",
              challenge: "a".repeat(64),
              salt: "salt",
              signature: "sig",
              difficulty: 2,
              expire_at: 1893456000,
            },
          },
        },
      });
    }
    if (u === `${DS}/chat/completion`) {
      return textRes(completionBody, 200, { "content-type": "text/event-stream" });
    }
    if (u === `${DS}/chat_session/delete`) return jsonRes({ code: 0 });
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const DS_FINISHED_STREAM = [
  'data: {"p":"response/fragments","v":[{"type":"ANSWER","content":"Hello "}]}',
  'data: {"v":"world"}',
  'data: {"p":"response/status","v":"FINISHED"}',
  "",
].join("\n");

describe("DeepSeekWebDriver", () => {
  it("throws a missing-cookie error with the import hint", async () => {
    const d = new DeepSeekWebDriver(new CookieJar());
    await expect(d.bootstrap()).rejects.toThrow(/llmswitch cookies deepseek-web/);
  });

  it("throws when cookies exist but user-token is absent", async () => {
    const jar = new CookieJar();
    jar.load("other=1", "chat.deepseek.com");
    const d = new DeepSeekWebDriver(jar);
    await expect(d.bootstrap()).rejects.toThrow(/no user-token cookie/);
  });

  it("exchanges the user-token for an access token (idempotent bootstrap)", async () => {
    const { fetchFn, calls } = deepseekFetch(DS_FINISHED_STREAM);
    const d = new DeepSeekWebDriver(deepseekJar(), fetchFn);
    await d.bootstrap();
    await d.bootstrap();
    const userCalls = calls.filter((c) => c.url === `${DS}/users/current`);
    expect(userCalls).toHaveLength(1);
    const headers = userCalls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ut-123");
  });

  it("runs session + PoW + completion and parses fragment SSE", async () => {
    const { fetchFn, calls } = deepseekFetch(DS_FINISHED_STREAM);
    const solver = vi.fn(async (c: PowChallenge) => {
      expect(c.algorithm).toBe("DeepSeekHashV1");
      expect(c.target_path).toBe("/api/v0/chat/completion");
      return "pow-base64";
    });
    const d = new DeepSeekWebDriver(deepseekJar(), fetchFn, { powSolver: solver });
    const out = await d.chat("deepseek-chat", [{ role: "user", content: "hi there" }]);
    expect(out).toBe("Hello world");
    expect(solver).toHaveBeenCalledTimes(1);

    const powCall = calls.find((c) => c.url === `${DS}/chat/create_pow_challenge`)!;
    expect(JSON.parse(String(powCall.init!.body))).toEqual({ target_path: "/api/v0/chat/completion" });

    const completion = calls.find((c) => c.url === `${DS}/chat/completion`)!;
    const headers = completion.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer at-xyz");
    expect(headers["x-ds-pow-response"]).toBe("pow-base64");
    expect(JSON.parse(String(completion.init!.body))).toMatchObject({
      chat_session_id: "sess-1",
      parent_message_id: null,
      model_type: "default",
      prompt: "hi there",
      thinking_enabled: false,
      search_enabled: false,
      preempt: false,
    });
    // session cleaned up afterwards
    expect(calls.some((c) => c.url === `${DS}/chat_session/delete`)).toBe(true);
  });

  it("fails with NEEDS LIVE VERIFICATION when no PoW solver is injected", async () => {
    const { fetchFn } = deepseekFetch(DS_FINISHED_STREAM);
    const d = new DeepSeekWebDriver(deepseekJar(), fetchFn);
    await expect(d.chat("deepseek-chat", [{ role: "user", content: "hi" }])).rejects.toThrow(
      /NEEDS LIVE VERIFICATION/,
    );
  });

  it("rejects a stream that ends without the FINISHED signal", async () => {
    const truncated = 'data: {"p":"response/fragments","v":[{"type":"ANSWER","content":"partial"}]}\n';
    const { fetchFn } = deepseekFetch(truncated);
    const d = new DeepSeekWebDriver(deepseekJar(), fetchFn, { powSolver: async () => "pow" });
    await expect(d.chat("deepseek-chat", [{ role: "user", content: "hi" }])).rejects.toThrow(/no FINISHED/);
  });

  it("skips THINK fragments for reasoner models and enables thinking", async () => {
    const stream = [
      'data: {"p":"response/fragments","v":[{"type":"THINK","content":"hmm"}]}',
      'data: {"p":"response/fragments","v":[{"type":"ANSWER","content":"answer"}]}',
      'data: {"p":"response/status","v":"FINISHED"}',
      "",
    ].join("\n");
    const { fetchFn, calls } = deepseekFetch(stream);
    const d = new DeepSeekWebDriver(deepseekJar(), fetchFn, { powSolver: async () => "pow" });
    await expect(d.chat("deepseek-reasoner", [{ role: "user", content: "q" }])).resolves.toBe("answer");
    const completion = calls.find((c) => c.url === `${DS}/chat/completion`)!;
    expect(JSON.parse(String(completion.init!.body))).toMatchObject({ thinking_enabled: true });
  });
});
