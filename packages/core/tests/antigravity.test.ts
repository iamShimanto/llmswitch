import { describe, expect, it, vi } from "vitest";
import {
  ANTIGRAVITY_MODEL_ALIASES,
  AntigravityAuthError,
  buildAntigravityContentHeaders,
  buildAntigravityEnvelope,
  buildAntigravityIdeMetadata,
  deriveAntigravitySessionId,
  executeAntigravity,
  resolveAntigravityModelId,
  resolveAntigravityPlatformEnum,
  scrubFingerprintHeaders,
  type AntigravityCreds,
} from "../src/executor/antigravity.js";

const creds: AntigravityCreds = { accessToken: "tok123", projectId: "proj-1", email: "me@example.com" };
const body = { model: "gemini-3.8-flash-high", messages: [{ role: "user" as const, content: "hi" }] };

describe("antigravity model aliases (ported from OmniRoute)", () => {
  it("resolves 3.7 flash tiers to the shared tiered id", () => {
    expect(resolveAntigravityModelId("gemini-3.7-flash")).toBe("gemini-3.7-flash-tiered");
    expect(resolveAntigravityModelId("gemini-3.7-flash-high")).toBe("gemini-3.7-flash-tiered");
    expect(resolveAntigravityModelId("gemini-3.7-flash-low")).toBe("gemini-3.7-flash-tiered");
  });
  it("resolves 3.8 bare display id to the high tier", () => {
    expect(resolveAntigravityModelId("gemini-3.8-flash")).toBe("gemini-3.8-flash-high");
    expect(resolveAntigravityModelId("gemini-3.8-flash-tiered")).toBe("gemini-3.8-flash-high");
  });
  it("resolves gpt-oss, pro-high and legacy claude ids", () => {
    expect(resolveAntigravityModelId("gpt-oss-120b")).toBe("gpt-oss-120b-medium");
    expect(resolveAntigravityModelId("gemini-3.1-pro-high")).toBe("gemini-pro-agent");
    expect(resolveAntigravityModelId("gemini-claude-sonnet-4-5")).toBe("claude-sonnet-4-6");
    expect(resolveAntigravityModelId("gemini-claude-opus-4-5-thinking")).toBe("claude-opus-4-6-thinking");
  });
  it("passes unknown ids through", () => {
    expect(resolveAntigravityModelId("gemini-4-argon-high")).toBe("gemini-4-argon-high");
    expect(resolveAntigravityModelId("")).toBe("");
  });
  it("alias map is frozen", () => {
    expect(Object.isFrozen(ANTIGRAVITY_MODEL_ALIASES)).toBe(true);
  });
});

describe("antigravity fingerprint headers (ported from OmniRoute)", () => {
  it("pins the darwin/arm64 IDE user-agent", () => {
    const h = buildAntigravityContentHeaders("tok");
    expect(h["User-Agent"]).toBe("antigravity/ide/2.5.5 darwin/arm64");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["Authorization"]).toBe("Bearer tok");
  });
  it("omits Authorization when no token", () => {
    expect(buildAntigravityContentHeaders().Authorization).toBeUndefined();
  });
  it("ide metadata uses wire enums (ideType=9, pluginType=2)", () => {
    const m = buildAntigravityIdeMetadata();
    expect(m.ideType).toBe(9);
    expect(m.pluginType).toBe(2);
    expect(typeof m.platform).toBe("number");
  });
  it("platform enum resolves per host", () => {
    expect(resolveAntigravityPlatformEnum("linux", "x64")).toBe(3); // LINUX_AMD64
    expect(resolveAntigravityPlatformEnum("linux", "arm64")).toBe(4);
    expect(resolveAntigravityPlatformEnum("darwin", "arm64")).toBe(2);
    expect(resolveAntigravityPlatformEnum("win32", "x64")).toBe(5);
  });
  it("scrub removes proxy/browser fingerprint headers", () => {
    const scrubbed = scrubFingerprintHeaders({
      "Content-Type": "application/json",
      "User-Agent": "antigravity/ide/2.5.5 darwin/arm64",
      Authorization: "Bearer tok",
      "X-Forwarded-For": "1.2.3.4",
      "Sec-Ch-Ua": "nope",
      "X-Stainless-Lang": "js",
      "Accept-Encoding": "gzip, deflate, br, zstd",
    });
    expect(scrubbed["X-Forwarded-For"]).toBeUndefined();
    expect(scrubbed["Sec-Ch-Ua"]).toBeUndefined();
    expect(scrubbed["X-Stainless-Lang"]).toBeUndefined();
    expect(scrubbed["Accept-Encoding"]).toBe("gzip, deflate, br");
    expect(scrubbed.Authorization).toBe("Bearer tok");
    // Authorization lands last — matches the native client fingerprint
    expect(Object.keys(scrubbed).at(-1)).toBe("Authorization");
  });
});

describe("antigravity envelope", () => {
  it("builds the Cloud Code envelope shape", () => {
    const env = buildAntigravityEnvelope("gemini-3.8-flash-high", body, "proj-1", "me@example.com");
    expect(env.project).toBe("proj-1");
    expect(env.model).toBe("gemini-3.8-flash-high");
    expect(env.userAgent).toBe("antigravity");
    expect(env.requestType).toBe("agent");
    expect(String(env.requestId)).toMatch(/^agent\//);
    const req = env.request as Record<string, unknown>;
    expect(Array.isArray(req.contents)).toBe(true);
    expect(typeof req.sessionId).toBe("string");
    expect((req.systemInstruction as { parts: Array<{ text: string }> }).parts[0].text.length).toBeGreaterThan(0);
  });
  it("uses the caller's system prompt when provided", () => {
    const env = buildAntigravityEnvelope(
      "gemini-3.8-flash-high",
      { model: "x", messages: [{ role: "system" as const, content: "be terse" }, { role: "user" as const, content: "hi" }] },
      "proj-1",
    );
    const req = env.request as Record<string, unknown>;
    expect((req.systemInstruction as { parts: Array<{ text: string }> }).parts[0].text).toBe("be terse");
  });
  it("derives a stable session id from the account key", () => {
    expect(deriveAntigravitySessionId("me@example.com")).toBe(deriveAntigravitySessionId("me@example.com"));
    expect(deriveAntigravitySessionId("me@example.com")).not.toBe(deriveAntigravitySessionId("you@example.com"));
  });
});

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function mockOk(text: string, overrides: Record<string, unknown> = {}): Response {
  const payload = {
    response: {
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 8 },
    },
    ...overrides,
  };
  return new Response(sseEvent(payload), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("executeAntigravity", () => {
  it("collects SSE text into a chat completion", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockOk("hello world"));
    const res = await executeAntigravity("gemini-3.8-flash-high", body, creds, { fetchFn, sleep: async () => {} });
    expect(res.response!.choices[0].message.content).toBe("hello world");
    expect(res.response!.usage.total_tokens).toBe(8);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.userAgent).toBe("antigravity");
    expect(sent.project).toBe("proj-1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok123");
    expect((init.headers as Record<string, string>)["User-Agent"]).toContain("antigravity/ide/");
  });

  it("prefers non-thought text when reasoning parts are present", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      mockOk("", {
        response: {
          candidates: [
            {
              content: { parts: [{ text: "inner monologue", thought: true }, { text: "final answer" }] },
              finishReason: "STOP",
            },
          ],
        },
      }),
    );
    const res = await executeAntigravity("gemini-3.8-flash-high", body, creds, { fetchFn, sleep: async () => {} });
    expect(res.response!.choices[0].message.content).toBe("final answer");
  });

  it("throws a typed auth error on 401/403 with a login hint", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("denied", { status: 401 }));
    await expect(executeAntigravity("gemini-3.8-flash-high", body, creds, { fetchFn })).rejects.toThrow(
      AntigravityAuthError,
    );
    const fetchFn2 = vi.fn().mockResolvedValue(new Response("denied", { status: 403 }));
    const err = await executeAntigravity("gemini-3.8-flash-high", body, creds, { fetchFn: fetchFn2 }).catch((e) => e);
    expect(err).toBeInstanceOf(AntigravityAuthError);
    expect(err.kind).toBe("auth_error");
    expect(err.message).toContain("llmswitch login antigravity");
  });

  it("requires a project id up front", async () => {
    const fetchFn = vi.fn();
    await expect(
      executeAntigravity("gemini-3.8-flash-high", body, { accessToken: "tok" }, { fetchFn }),
    ).rejects.toThrow(/project id/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("retries 429 with Retry-After and gives up after maxAttempts", async () => {
    const sleeps: number[] = [];
    const r429 = new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    const fetchFn = vi.fn().mockResolvedValue(r429);
    await expect(
      executeAntigravity("gemini-3.8-flash-high", body, creds, {
        fetchFn,
        maxAttempts: 3,
        maxRetryDelayMs: 50,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toThrow(/rate limited/);
    expect(fetchFn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries = bounded
    expect(sleeps).toHaveLength(2);
  });

  it("succeeds after a transient 429", async () => {
    const r429 = new Response("slow down", { status: 429 });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(r429)
      .mockResolvedValueOnce(mockOk("recovered"));
    const res = await executeAntigravity("gemini-3.8-flash-high", body, creds, {
      fetchFn,
      maxAttempts: 3,
      maxRetryDelayMs: 50,
      sleep: async () => {},
    });
    expect(res.response!.choices[0].message.content).toBe("recovered");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("surfaces 400s as bad_request", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("bad", { status: 400 }));
    const err = await executeAntigravity("gemini-3.8-flash-high", body, creds, { fetchFn }).catch((e) => e);
    expect(err.kind).toBe("bad_request");
  });
});
