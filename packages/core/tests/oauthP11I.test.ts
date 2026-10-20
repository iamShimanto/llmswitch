/**
 * P11-I OAuth providers (core side): catalog entries, registry connected(),
 * router dispatch headers + wire formats, token resolution.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { CATALOG_PROVIDERS } from "../src/providers/catalog.js";
import { registry } from "../src/providers/registry.js";
import {
  hasProviderSession,
  resolveProviderToken,
  P11I_PROVIDER_IDS,
} from "../src/oauth/sessions.js";
import { executeOAuthProvider, executeGrokCliChat, executeGitLabDuoChat } from "../src/oauth/dispatch.js";

const fresh = (accessToken = "at", rest: Record<string, unknown> = {}) => ({
  accessToken,
  refreshToken: "rt",
  expiresAt: Date.now() + 3_600_000,
  ...rest,
});

function jsonResponse(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
}

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(`data: ${ch}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

let dir = "";
beforeEach(() => {
  dir = join(tmpdir(), `llmswitch-core-p11i-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  process.env.LLMSWITCH_SESSIONS_DIR = dir;
});
afterEach(() => {
  delete process.env.LLMSWITCH_SESSIONS_DIR;
  vi.unstubAllEnvs();
});

function save(id: string, body: Record<string, unknown>) {
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(body));
}

describe("catalog", () => {
  it("has all 9 P11-I entries", () => {
    const ids = new Set(CATALOG_PROVIDERS.map((p) => p.id));
    for (const id of P11I_PROVIDER_IDS) expect(ids.has(id), id).toBe(true);
    expect(ids.has("devin-cli")).toBe(true);
  });

  it("devin-cli is disabled with a reason", () => {
    const d = CATALOG_PROVIDERS.find((p) => p.id === "devin-cli")!;
    expect(d.disabled).toContain("devin");
    expect(d.authType).toBe("oauth");
  });

  it("devin-desktop is token-import", () => {
    expect(CATALOG_PROVIDERS.find((p) => p.id === "devin-desktop")!.authType).toBe("token-import");
  });

  it("codebuddy entries carry client-fingerprint headers", () => {
    const cn = CATALOG_PROVIDERS.find((p) => p.id === "codebuddy-cn")!;
    expect(cn.extraHeaders?.["X-IDE-Type"]).toBe("CLI");
    const intl = CATALOG_PROVIDERS.find((p) => p.id === "codebuddy-intl")!;
    expect(intl.extraHeaders?.["X-IDE-Type"]).toBe("IDE");
    const wb = CATALOG_PROVIDERS.find((p) => p.id === "workbuddy")!;
    expect(wb.extraHeaders?.["X-Product"]).toBe("SaaS");
  });
});

describe("registry connected()", () => {
  it("lists oauth providers with a session file, never disabled devin-cli", () => {
    save("codebuddy-cn", fresh());
    save("openference", fresh());
    save("devin-desktop", fresh());
    save("devin-cli", fresh());
    const env = { ...process.env } as NodeJS.ProcessEnv;
    const ids = registry.connected(env).map((p) => p.id);
    expect(ids).toContain("codebuddy-cn");
    expect(ids).toContain("openference");
    expect(ids).toContain("devin-desktop");
    expect(ids).not.toContain("devin-cli");
    expect(ids).not.toContain("codebuddy-intl");
  });

  it("env access token also marks a provider connected", () => {
    const env = { ...process.env, GROK_CLI_ACCESS_TOKEN: "tok" } as NodeJS.ProcessEnv;
    expect(registry.connected(env).map((p) => p.id)).toContain("grok-cli");
  });
});

describe("resolveProviderToken", () => {
  it("uses a fresh session token", async () => {
    save("workbuddy", fresh("wb-at"));
    const t = await resolveProviderToken("workbuddy", process.env as NodeJS.ProcessEnv, (async () => {
      throw new Error("no network expected");
    }) as typeof fetch);
    expect(t.accessToken).toBe("wb-at");
  });

  it("refreshes a stale token and persists", async () => {
    save("grok-cli", { accessToken: "old", refreshToken: "rt", expiresAt: Date.now() - 1000 });
    const fetchFn = (async () => jsonResponse({ access_token: "new", expires_in: 3600 })) as typeof fetch;
    const t = await resolveProviderToken("grok-cli", process.env as NodeJS.ProcessEnv, fetchFn);
    expect(t.accessToken).toBe("new");
    const reloaded = JSON.parse(await (await import("node:fs")).promises.readFile(join(dir, "grok-cli.json"), "utf8"));
    expect(reloaded.accessToken).toBe("new");
  });

  it("throws a login hint without any session", async () => {
    await expect(
      resolveProviderToken("openference", process.env as NodeJS.ProcessEnv, (async () => {
        throw new Error("nope");
      }) as typeof fetch),
    ).rejects.toThrow("llmswitch login openference");
  });
});

describe("dispatch", () => {
  const chatBody = (stream = false) => ({
    model: "m",
    messages: [{ role: "user" as const, content: "hello" }],
    stream,
  });

  it("codebuddy-cn sends bearer + fingerprint headers and force-streams for non-stream callers", async () => {
    save("codebuddy-cn", fresh("cb-at"));
    const seen: { url: string; headers: Record<string, string>; body: string } = { url: "", headers: {}, body: "" };
    const fetchFn = (async (url: URL | Request, init?: RequestInit) => {
      seen.url = String(url);
      seen.headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
      seen.body = String(init?.body);
      return sseResponse(['{"choices":[{"delta":{"content":"hi"}}]}']);
    }) as typeof fetch;
    const def = registry.get("codebuddy-cn")!;
    const provider = { ...def, apiKey: "unused", allKeys: [], baseUrl: def.baseUrl } as never;
    const result = await executeOAuthProvider(provider, "glm-5.2", chatBody(false), fetchFn, 30_000, process.env as NodeJS.ProcessEnv);
    expect(seen.headers.authorization).toBe("Bearer cb-at");
    expect(seen.headers["x-ide-type"]).toBe("CLI");
    expect(seen.url).toContain("copilot.tencent.com/v2/chat/completions");
    expect(JSON.parse(seen.body).stream).toBe(true); // forced upstream
    expect(result.response?.choices[0]?.message.content).toBe("hi"); // accumulated back
  });

  it("openference sends bearer auth, no fingerprint", async () => {
    save("openference", fresh("of-at"));
    const seen: { headers: Record<string, string> } = { headers: {} };
    const fetchFn = (async (url: URL | Request, init?: RequestInit) => {
      seen.headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
      return jsonResponse({ choices: [{ message: { role: "assistant", content: "yo" }, finish_reason: "stop" }] });
    }) as typeof fetch;
    const def = registry.get("openference")!;
    const provider = { ...def, apiKey: "unused", allKeys: [], baseUrl: def.baseUrl } as never;
    const result = await executeOAuthProvider(provider, "GLM-5.2", chatBody(false), fetchFn, 30_000, process.env as NodeJS.ProcessEnv);
    expect(seen.headers.authorization).toBe("Bearer of-at");
    expect(seen.headers["x-ide-type"]).toBeUndefined();
    expect(result.response?.choices[0]?.message.content).toBe("yo");
  });

  it("grok-cli dispatches to /v1/responses with xai auth headers", async () => {
    save("grok-cli", fresh("gx-at"));
    const seen: { url: string; headers: Record<string, string>; body: string } = { url: "", headers: {}, body: "" };
    const fetchFn = (async (url: URL | Request, init?: RequestInit) => {
      seen.url = String(url);
      seen.headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
      seen.body = String(init?.body);
      return jsonResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "grok says hi" }] }] });
    }) as typeof fetch;
    const def = registry.get("grok-cli")!;
    const provider = { ...def, apiKey: "unused", allKeys: [], baseUrl: def.baseUrl } as never;
    const result = await executeGrokCliChat(provider, "grok-4.7", chatBody(false), fetchFn, process.env as NodeJS.ProcessEnv);
    expect(seen.url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(seen.headers.authorization).toBe("Bearer gx-at");
    expect(seen.headers["x-xai-token-auth"]).toBe("xai-grok-cli");
    expect(seen.headers["x-grok-client-version"]).toBe("1.0.41");
    expect(JSON.parse(seen.body).input[0].content[0].type).toBe("input_text");
    expect(result.response?.choices[0]?.message.content).toBe("grok says hi");
  });

  it("gitlab-duo posts the completions body with the flattened transcript", async () => {
    save("gitlab-duo", fresh("gl-at"));
    const seen: { body: string; headers: Record<string, string> } = { body: "", headers: {} };
    const fetchFn = (async (url: URL | Request, init?: RequestInit) => {
      seen.body = String(init?.body);
      seen.headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
      return jsonResponse({ choices: [{ text: "def hello(): pass" }] });
    }) as typeof fetch;
    const def = registry.get("gitlab-duo")!;
    const provider = { ...def, apiKey: "unused", allKeys: [], baseUrl: def.baseUrl } as never;
    const result = await executeGitLabDuoChat(provider, "claude-sonnet-4-6", chatBody(false), fetchFn, process.env as NodeJS.ProcessEnv);
    const sent = JSON.parse(seen.body);
    expect(sent.intent).toBe("generation");
    expect(sent.generation_type).toBe("small_file");
    expect(sent.current_file.content_above_cursor).toContain("user: hello");
    expect(seen.headers.authorization).toBe("Bearer gl-at");
    expect(result.response?.choices[0]?.message.content).toBe("def hello(): pass");
  });

  it("gitlab-duo prefers a valid direct_access grant", async () => {
    save("gitlab-duo", fresh("gl-at", { meta: { gitlabDirectAccess: { token: "da-tok", baseUrl: "https://da.gitlab.com", headers: { "X-DA": "1" }, expiresAt: new Date(Date.now() + 3600_000).toISOString() } } }));
    const seen: { headers: Record<string, string> } = { headers: {} };
    const fetchFn = (async (url: URL | Request, init?: RequestInit) => {
      seen.headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
      return jsonResponse({ choices: [{ text: "ok" }] });
    }) as typeof fetch;
    const def = registry.get("gitlab-duo")!;
    const provider = { ...def, apiKey: "unused", allKeys: [], baseUrl: def.baseUrl } as never;
    await executeGitLabDuoChat(provider, "claude-sonnet-4-6", chatBody(false), fetchFn, process.env as NodeJS.ProcessEnv);
    expect(seen.headers.authorization).toBe("Bearer da-tok");
    expect(seen.headers["x-da"]).toBe("1");
  });

  it("agy reuses the antigravity executor with the agy session file", async () => {
    save("agy", fresh("agy-at", { projectId: "proj-1" }));
    const urls: string[] = [];
    const fetchFn = (async (url: URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (String(url).includes("streamGenerateContent")) {
        return jsonResponse({ candidates: [{ content: { parts: [{ text: "agi hi" }] } }] });
      }
      void body;
      return jsonResponse({});
    }) as typeof fetch;
    const def = registry.get("agy")!;
    const provider = { ...def, apiKey: "unused", allKeys: [], baseUrl: def.baseUrl } as never;
    const result = await executeOAuthProvider(provider, "gemini-3.8-flash-high", chatBody(false), fetchFn, 30_000, process.env as NodeJS.ProcessEnv);
    expect(urls.some((u) => u.includes("cloudcode-pa.googleapis.com"))).toBe(true);
    expect(result.providerId).toBe("agy");
  });

  it("devin-desktop dispatch returns a typed not-implemented error", async () => {
    save("devin-desktop", fresh("dd-at"));
    const def = registry.get("devin-desktop")!;
    const provider = { ...def, apiKey: "unused", allKeys: [], baseUrl: def.baseUrl } as never;
    await expect(
      executeOAuthProvider(provider, "claude-sonnet-4-6", chatBody(false), (async () => {
        throw new Error("no network");
      }) as typeof fetch, 30_000, process.env as NodeJS.ProcessEnv),
    ).rejects.toThrow("not ported");
  });

  it("codebuddy dispatch without creds gives a login hint", async () => {
    const def = registry.get("codebuddy-cn")!;
    const provider = { ...def, apiKey: "unused", allKeys: [], baseUrl: def.baseUrl } as never;
    await expect(
      executeOAuthProvider(provider, "glm-5.2", chatBody(false), (async () => {
        throw new Error("no network");
      }) as typeof fetch, 30_000, process.env as NodeJS.ProcessEnv),
    ).rejects.toThrow("llmswitch login codebuddy-cn");
  });
});

describe("hasProviderSession", () => {
  it("false with nothing configured", () => {
    expect(hasProviderSession("codebuddy-intl", process.env as NodeJS.ProcessEnv)).toBe(false);
  });
});
