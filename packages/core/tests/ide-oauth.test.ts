/**
 * Tests for the 5 IDE OAuth providers in core (mock fetch, temp session dir).
 * No live OAuth / no real IDE accounts touched.
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { executeCursorChat, CursorWireError, hasCursorCreds, resolveCursorCreds } from "../src/executor/cursor.js";
import {
  executeKiroChat,
  buildKiroPayload,
  buildKiroHeaders,
  EventStreamParser,
  textFromKiroFrame,
  hasKiroCreds,
  resolveKiroCreds,
} from "../src/executor/kiro.js";
import {
  executeTraeChat,
  buildTraeSessionBody,
  buildTraeCommonParams,
  applyTraeEvent,
  flattenTraeQuery,
  resolveTraeMode,
  resolveTraeCreds,
  hasTraeCreds,
} from "../src/executor/trae.js";
import {
  executeZedHostedChat,
  inferZedWireProvider,
  buildZedPayload,
  buildZedUserAuthHeader,
  resolveZedHostedCreds,
  fetchZedLlmToken,
  clearZedLlmTokenCache,
  ZED_PROVIDERS,
} from "../src/executor/zedHosted.js";
import {
  executeClinepassChat,
  buildClinepassHeaders,
  resolveClinepassCreds,
  hasClinepassCreds,
} from "../src/executor/clinepass.js";
import { registry } from "../src/providers/registry.js";
import { CATALOG_PROVIDERS } from "../src/providers/catalog.js";
import type { ChatCompletionRequest } from "../src/providers/types.js";

const BODY: ChatCompletionRequest = {
  model: "x",
  messages: [{ role: "user", content: "hi" }],
};

let dir: string;
function saveSessionFile(name: string, data: Record<string, unknown>): void {
  const d = join(dir, "sessions");
  mkdirSync(d, { recursive: true });
  const p = join(d, `${name}.json`);
  writeFileSync(p, JSON.stringify(data));
  chmodSync(p, 0o600);
}

beforeEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "llmscore-"));
  clearZedLlmTokenCache();
});

function envWith(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, LLMSWITCH_SESSIONS_DIR: join(dir, "sessions"), ...over };
}

function sseResponse(lines: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/* ------------------------------ catalog + registry ------------------------------ */

describe("catalog entries", () => {
  it("has all 5 IDE providers with models + auth types", () => {
    const byId = new Map(CATALOG_PROVIDERS.map((p) => [p.id, p]));
    expect(byId.get("cursor")?.authType).toBe("oauth");
    expect(byId.get("kiro")?.authType).toBe("oauth");
    expect(byId.get("trae")?.authType).toBe("token-import");
    expect(byId.get("zed-hosted")?.authType).toBe("oauth");
    expect(byId.get("clinepass")?.authType).toBe("oauth");
    for (const id of ["cursor", "kiro", "trae", "zed-hosted", "clinepass"]) {
      expect(byId.get(id)?.models.length).toBeGreaterThan(0);
      expect(byId.get(id)?.defaultModel).toBeTruthy();
    }
  });

  it("registry hides all 5 without creds, shows them with sessions", () => {
    const bare = registry.connected({ PATH: process.env.PATH } as NodeJS.ProcessEnv);
    for (const id of ["cursor", "kiro", "trae", "zed-hosted", "clinepass"]) {
      expect(bare.find((p) => p.id === id)).toBeUndefined();
    }
    saveSessionFile("cursor", { accessToken: "a", kind: "oauth-refresh" });
    saveSessionFile("kiro", { accessToken: "a", kind: "oauth-device" });
    saveSessionFile("trae", { accessToken: "a", kind: "token-import" });
    saveSessionFile("zed-hosted", { accessToken: "a", kind: "oauth-refresh", meta: { userId: "u1" } });
    saveSessionFile("clinepass", { accessToken: "a", kind: "token-import", meta: { authMethod: "byok" } });
    const conn = registry.connected(envWith());
    for (const id of ["cursor", "kiro", "trae", "zed-hosted", "clinepass"]) {
      const p = conn.find((x) => x.id === id);
      expect(p, id).toBeTruthy();
      expect(p?.apiKey).toBe("oauth");
    }
  });
});

/* ------------------------------ cursor ------------------------------ */

describe("cursor core", () => {
  it("no creds -> auth_error with login hint", async () => {
    await expect(resolveCursorCreds(envWith())).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining("llmswitch login cursor"),
    });
    expect(hasCursorCreds(envWith())).toBe(false);
  });

  it("with creds, chat dispatch raises the typed CursorWireError (protobuf not ported)", async () => {
    saveSessionFile("cursor", { accessToken: "tok", expiresAt: Date.now() + 3600_000 });
    await expect(
      executeCursorChat({ id: "cursor" } as never, "auto", BODY, fetch, 1000, envWith()),
    ).rejects.toBeInstanceOf(CursorWireError);
    const err = await executeCursorChat({ id: "cursor" } as never, "auto", BODY, fetch, 1000, envWith()).catch((e) => e);
    expect(err.status).toBe(501);
    expect(err.message).toContain("protobuf");
  });
});

/* ------------------------------ kiro ------------------------------ */

describe("kiro core", () => {
  it("buildKiroPayload builds conversationState with history + currentMessage", () => {
    const p = buildKiroPayload("claude-sonnet-4.5", {
      model: "claude-sonnet-4.5",
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ],
    }) as { conversationState: { currentMessage: { userInputMessage: { content: string; modelId: string } }; history: unknown[] } };
    expect(p.conversationState.currentMessage.userInputMessage.content).toBe("q2");
    expect(p.conversationState.currentMessage.userInputMessage.modelId).toBe("claude-sonnet-4.5");
    expect(p.conversationState.history).toHaveLength(2);
  });

  it("buildKiroPayload includes profileArn when given", () => {
    const p = buildKiroPayload("m", BODY, "arn:aws:xyz") as { profileArn?: string };
    expect(p.profileArn).toBe("arn:aws:xyz");
  });

  it("headers: Bearer + EXTERNAL_IDP TokenType only for IdP sessions", () => {
    const plain = buildKiroHeaders({ accessToken: "t" });
    expect(plain.authorization).toBe("Bearer t");
    expect(plain.TokenType).toBeUndefined();
    const idp = buildKiroHeaders({ accessToken: "t", externalIdp: true });
    expect(idp.TokenType).toBe("EXTERNAL_IDP");
  });

  it("event-stream parser extracts assistantResponseEvent text", () => {
    const payload = JSON.stringify({ assistantResponseEvent: { content: "hello world" } });
    const headersObj: Array<[string, string]> = [
      [":event-type", "assistantResponseEvent"],
      [":message-type", "event"],
    ];
    let headers = Buffer.alloc(0);
    for (const [n, v] of headersObj) {
      const nb = Buffer.from(n, "utf8");
      const vb = Buffer.from(v, "utf8");
      const lenBuf = Buffer.alloc(2);
      lenBuf.writeUInt16BE(vb.length, 0);
      headers = Buffer.concat([headers, Buffer.from([nb.length]), nb, Buffer.from([7]), lenBuf, vb]);
    }
    const payloadBuf = Buffer.from(payload, "utf8");
    const total = 12 + headers.length + payloadBuf.length + 4;
    const frame = Buffer.alloc(total);
    frame.writeUInt32BE(total, 0);
    frame.writeUInt32BE(headers.length, 4);
    headers.copy(frame, 12);
    payloadBuf.copy(frame, 12 + headers.length);
    const parser = new EventStreamParser();
    const frames = parser.push(new Uint8Array(frame));
    expect(frames).toHaveLength(1);
    expect(frames[0].headers[":event-type"]).toBe("assistantResponseEvent");
    expect(textFromKiroFrame(frames[0])).toBe("hello world");
  });

  it("no creds -> 401 auth_error", async () => {
    await expect(resolveKiroCreds(envWith())).rejects.toMatchObject({ status: 401 });
    expect(hasKiroCreds(envWith())).toBe(false);
  });

  it("end-to-end (mock): eventstream response becomes a completion", async () => {
    saveSessionFile("kiro", { accessToken: "tok", expiresAt: Date.now() + 3600_000, meta: { authMethod: "builder-id" } });
    const payload = JSON.stringify({ assistantResponseEvent: { content: "kiro says hi" } });
    const nb = Buffer.from(":event-type", "utf8");
    const vb = Buffer.from("assistantResponseEvent", "utf8");
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(vb.length, 0);
    const headers = Buffer.concat([Buffer.from([nb.length]), nb, Buffer.from([7]), lenBuf, vb]);
    const payloadBuf = Buffer.from(payload, "utf8");
    const total = 12 + headers.length + payloadBuf.length + 4;
    const frame = Buffer.alloc(total);
    frame.writeUInt32BE(total, 0);
    frame.writeUInt32BE(headers.length, 4);
    headers.copy(frame, 12);
    payloadBuf.copy(frame, 12 + headers.length);
    const r = await executeKiroChat({ id: "kiro" } as never, "claude-sonnet-4.5", BODY, async () =>
      new Response(new Uint8Array(frame), { status: 200 }), 5000, envWith());
    expect(r.response?.choices[0].message.content).toBe("kiro says hi");
  });
});

/* ------------------------------ trae ------------------------------ */

describe("trae core", () => {
  it("resolveTraeMode: work model -> work mode; named -> manual; auto -> auto", () => {
    expect(resolveTraeMode("work")).toEqual({ mode: "work", strategy: "auto", modelName: "" });
    expect(resolveTraeMode("gpt-5.4")).toEqual({ mode: "code", strategy: "manual", modelName: "gpt-5.4" });
    expect(resolveTraeMode("auto")).toEqual({ mode: "code", strategy: "auto", modelName: "" });
  });

  it("buildTraeSessionBody has initial_message with common_params + query blocks", () => {
    const b = buildTraeSessionBody("gpt-5.4", BODY, { webId: "w1", bizUserId: "b1" });
    const im = b.initial_message as { query: string; model_name: string; common_params: string; agent_type: string };
    expect(im.agent_type).toBe("solo_agent_remote");
    expect(im.model_name).toBe("gpt-5.4");
    const cp = JSON.parse(im.common_params) as Record<string, unknown>;
    expect(cp.web_id).toBe("w1");
    expect(cp.biz_user_id).toBe("b1");
    expect(cp.scope).toBe("marscode-us");
    const q = JSON.parse(im.query) as Array<{ type: string; data: { content: string } }>;
    expect(q[0].data.content).toBe("hi");
  });

  it("applyTraeEvent: cumulative plan_item deltas + token_usage", () => {
    const state = { byPlanItem: new Map<string, string>(), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    expect(applyTraeEvent(state, "plan_item", { plan_item: { id: "p1", thought: "Hel" } })).toBe("Hel");
    expect(applyTraeEvent(state, "plan_item", { plan_item: { id: "p1", thought: "Hello" } })).toBe("lo");
    applyTraeEvent(state, "token_usage", { usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } });
    expect(state.usage.total_tokens).toBe(7);
  });

  it("flattenTraeQuery prefixes system/assistant", () => {
    const q = flattenTraeQuery({
      model: "auto",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "yo" },
      ],
    });
    expect(JSON.parse(q)[0].data.content).toContain("[System]\nbe terse");
  });

  it("no creds -> 401; expired JWT -> 401 with re-import hint", () => {
    expect(hasTraeCreds(envWith())).toBe(false);
    expect(() => resolveTraeCreds(envWith())).toThrow(/import-token trae/);
    saveSessionFile("trae", { accessToken: "old", expiresAt: Date.now() - 1000 });
    expect(() => resolveTraeCreds(envWith())).toThrow(/re-import/);
  });

  it("end-to-end (mock): create session + events -> completion", async () => {
    saveSessionFile("trae", { accessToken: "jwt", expiresAt: Date.now() + 3600_000, meta: { webId: "w" } });
    let auth = "";
    const mockFetch = async (u: unknown, init?: RequestInit) => {
      const url = String(u);
      if (url.endsWith("/chat_sessions")) {
        auth = (init?.headers as Record<string, string>).authorization;
        return new Response(JSON.stringify({ code: 0, data: { chat_session_id: "s1", message_id: "m1" } }), { status: 200 });
      }
      expect(url).toContain("/chat_sessions/s1/events?reply_to_message_id=m1");
      return sseResponse([
        'event: plan_item\ndata: {"plan_item":{"id":"p1","thought":"trae reply"}}\n\n',
        "event: done\ndata: {}\n\n",
      ]);
    };
    const r = await executeTraeChat({ id: "trae" } as never, "auto", BODY, mockFetch as typeof fetch, 5000, envWith());
    expect(auth).toBe("Cloud-IDE-JWT jwt");
    expect(r.response?.choices[0].message.content).toBe("trae reply");
  });
});

/* ------------------------------ zed-hosted ------------------------------ */

describe("zed-hosted core", () => {
  it("user auth header is '<userId> <token>'", () => {
    expect(buildZedUserAuthHeader({ userId: "u9", accessToken: "tok" })).toBe("u9 tok");
  });

  it("inferZedWireProvider from model id", () => {
    const env = envWith();
    expect(inferZedWireProvider("claude-sonnet-4-5", env)).toBe(ZED_PROVIDERS.anthropic);
    expect(inferZedWireProvider("gemini-2.5-pro", env)).toBe(ZED_PROVIDERS.google);
    expect(inferZedWireProvider("grok-4", env)).toBe(ZED_PROVIDERS.x_ai);
    expect(inferZedWireProvider("gpt-5", env)).toBe(ZED_PROVIDERS.open_ai);
  });

  it("buildZedPayload wraps provider_request in the thread envelope", () => {
    const p = buildZedPayload("anthropic", "claude-sonnet-4-5", { messages: [] }, "t-1");
    expect(p.thread_id).toBe("t-1");
    expect(p.provider).toBe("anthropic");
    expect(p.model).toBe("claude-sonnet-4-5");
    expect(p.provider_request).toEqual({ messages: [] });
  });

  it("no creds -> 401 with login hint", () => {
    expect(() => resolveZedHostedCreds(envWith())).toThrow(/login zed-hosted/);
  });

  it("fetchZedLlmToken exchanges the user header for an LLM token", async () => {
    let auth = "";
    const token = await fetchZedLlmToken({ userId: "u1", accessToken: "at" }, async (u, init) => {
      expect(String(u)).toContain("/client/llm_tokens");
      auth = (init?.headers as Record<string, string>).authorization;
      return new Response(JSON.stringify({ token: "llm-tok" }), { status: 200 });
    });
    expect(auth).toBe("u1 at");
    expect(token).toBe("llm-tok");
  });

  it("end-to-end (mock): llm token exchange + NDJSON events -> completion", async () => {
    saveSessionFile("zed-hosted", { accessToken: "at", meta: { userId: "u1" } });
    const mockFetch = async (u: unknown, init?: RequestInit) => {
      const url = String(u);
      if (url.includes("/client/llm_tokens")) {
        return new Response(JSON.stringify({ token: "llm-tok" }), { status: 200 });
      }
      expect(url).toContain("/completions");
      const auth = (init?.headers as Record<string, string>).authorization;
      expect(auth).toBe("Bearer llm-tok");
      const payload = JSON.parse(String(init?.body)) as { provider: string; provider_request: unknown };
      expect(payload.provider).toBe("open_ai");
      const ndjson = [
        JSON.stringify({ event: { choices: [{ delta: { content: "zed " } }] } }),
        JSON.stringify({ event: { choices: [{ delta: { content: "reply" } }] } }),
        "[DONE]",
      ].join("\n");
      return new Response(ndjson, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    };
    const r = await executeZedHostedChat(
      { id: "zed-hosted" } as never,
      "gpt-5",
      BODY,
      mockFetch as typeof fetch,
      5000,
      envWith(),
    );
    expect(r.response?.choices[0].message.content).toBe("zed reply");
  });
});

/* ------------------------------ clinepass ------------------------------ */

describe("clinepass core", () => {
  it("headers carry Bearer + cline.bot referer/title", () => {
    const h = buildClinepassHeaders("tok");
    expect(h.authorization).toBe("Bearer tok");
    expect(h["HTTP-Referer"]).toBe("https://cline.bot");
    expect(h["X-Title"]).toBe("Cline");
  });

  it("no creds -> 401 with login hint", async () => {
    expect(hasClinepassCreds(envWith())).toBe(false);
    await expect(resolveClinepassCreds(envWith())).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining("llmswitch login clinepass"),
    });
  });

  it("env BYOK key resolves as byok", async () => {
    const c = await resolveClinepassCreds(envWith({ CLINEPASS_API_KEY: "sk-live" }));
    expect(c).toEqual({ accessToken: "sk-live", byok: true });
  });

  it("end-to-end (mock): forceStream accumulates SSE into a JSON completion", async () => {
    saveSessionFile("clinepass", { accessToken: "sk", kind: "token-import", meta: { authMethod: "byok" } });
    let upstreamStream: unknown;
    const mockFetch = async (u: unknown, init?: RequestInit) => {
      expect(String(u)).toBe("https://api.cline.bot/api/v1/chat/completions");
      upstreamStream = (JSON.parse(String(init?.body)) as { stream: unknown }).stream;
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"cline "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"reply"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
        "data: [DONE]\n\n",
      ]);
    };
    const r = await executeClinepassChat(
      { id: "clinepass" } as never,
      "cline-pass/glm-5.2",
      { model: "cline-pass/glm-5.2", messages: [{ role: "user", content: "hi" }] },
      mockFetch as typeof fetch,
      5000,
      envWith(),
    );
    expect(upstreamStream).toBe(true); // forceStream even though client asked non-stream
    expect(r.response?.choices[0].message.content).toBe("cline reply");
    expect(r.response?.usage.total_tokens).toBe(5);
  });
});
