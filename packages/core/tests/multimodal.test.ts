import { afterEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentText,
  hasImageParts,
  parseDataUrl,
  type ChatCompletionRequest,
  type ResolvedProvider,
} from "../src/providers/types.js";
import { toGeminiRequest } from "../src/translator/gemini.js";
import { fromAnthropicRequest, toAnthropicRequest } from "../src/translator/anthropic.js";
import { toCodexRequest } from "../src/translator/codex.js";
import { executeProvider } from "../src/executor/http.js";
import { createRouter } from "../src/router/index.js";
import { isVisionNotSupported, VisionNotSupportedError } from "../src/router/errors.js";
import { Store } from "../src/store/db.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=";

const imgPart = (url: string) => ({ type: "image_url" as const, image_url: { url } });
const textPart = (text: string) => ({ type: "text" as const, text });

describe("content helpers", () => {
  it("contentText passes strings through and joins text parts", () => {
    expect(contentText("hello")).toBe("hello");
    expect(contentText(null)).toBe("");
    expect(contentText(undefined)).toBe("");
    expect(contentText([textPart("a"), imgPart(PNG_DATA_URL), textPart("b")])).toBe("ab");
  });

  it("hasImageParts detects image parts only", () => {
    expect(hasImageParts("text")).toBe(false);
    expect(hasImageParts([textPart("x")])).toBe(false);
    expect(hasImageParts([textPart("x"), imgPart(PNG_DATA_URL)])).toBe(true);
  });

  it("parseDataUrl splits media type and payload", () => {
    expect(parseDataUrl(PNG_DATA_URL)).toEqual({ mediaType: "image/png", data: PNG_DATA_URL.split(",")[1] });
    expect(parseDataUrl("https://example.com/x.png")).toBeNull();
  });
});

describe("gemini translator — multimodal", () => {
  it("text-only array content equals the string form", () => {
    const asString = toGeminiRequest({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Hi" }],
    });
    const asArray = toGeminiRequest({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: [textPart("Hi")] }],
    });
    expect(asArray).toEqual(asString);
  });

  it("converts a data-URL image to inline_data", () => {
    const out: any = toGeminiRequest({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: [textPart("what is this?"), imgPart(PNG_DATA_URL)] }],
    });
    expect(out.contents).toEqual([
      {
        role: "user",
        parts: [
          { text: "what is this?" },
          { inline_data: { mime_type: "image/png", data: PNG_DATA_URL.split(",")[1] } },
        ],
      },
    ]);
  });

  it("converts an https image to file_data and keeps multiple images", () => {
    const out: any = toGeminiRequest({
      model: "gemini-2.5-flash",
      messages: [
        { role: "user", content: [imgPart("https://example.com/a.jpg"), imgPart(PNG_DATA_URL)] },
      ],
    });
    expect(out.contents[0].parts).toEqual([
      { file_data: { file_uri: "https://example.com/a.jpg" } },
      { inline_data: { mime_type: "image/png", data: PNG_DATA_URL.split(",")[1] } },
    ]);
  });

  it("maps tool calls and tool results to functionCall/functionResponse", () => {
    const out: any = toGeminiRequest({
      model: "gemini-2.5-flash",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call-1", type: "function", function: { name: "get_weather", arguments: '{"city":"Dhaka"}' } },
          ],
        },
        { role: "tool", content: '{"tempC":31}', tool_call_id: "call-1" },
        { role: "assistant", content: "It is 31C." },
      ],
    });
    expect(out.contents[1]).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "get_weather", args: { city: "Dhaka" } } }],
    });
    expect(out.contents[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "get_weather", response: { tempC: 31 } } }],
    });
    expect(out.contents[3]).toEqual({ role: "model", parts: [{ text: "It is 31C." }] });
  });

  it("wraps non-JSON tool results as { result }", () => {
    const out: any = toGeminiRequest({
      model: "gemini-2.5-flash",
      messages: [
        { role: "user", content: "go" },
        { role: "tool", content: "plain text result", name: "lookup" },
      ],
    });
    expect(out.contents[1].parts[0].functionResponse).toEqual({
      name: "lookup",
      response: { result: "plain text result" },
    });
  });
});

describe("anthropic translator — multimodal", () => {
  it("converts a data-URL image to a base64 image block", () => {
    const out: any = toAnthropicRequest({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: [textPart("look"), imgPart(PNG_DATA_URL)] }],
    });
    expect(out.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_DATA_URL.split(",")[1] } },
        ],
      },
    ]);
  });

  it("converts an https image to a url image block", () => {
    const out: any = toAnthropicRequest({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: [imgPart("https://example.com/a.jpg")] }],
    });
    expect(out.messages[0].content).toEqual([
      { type: "image", source: { type: "url", url: "https://example.com/a.jpg" } },
    ]);
  });

  it("maps tool calls/results to tool_use/tool_result blocks with alternation", () => {
    const out: any = toAnthropicRequest({
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Dhaka"}' } },
          ],
        },
        { role: "tool", content: "sunny", tool_call_id: "toolu_1" },
      ],
    });
    expect(out.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "weather?" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Dhaka" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny" }] },
    ]);
  });

  it("plain string requests keep the legacy string shape", () => {
    const out: any = toAnthropicRequest({
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: "Hi" },
        { role: "user", content: "there" },
      ],
    });
    expect(out.messages).toEqual([{ role: "user", content: "Hi\nthere" }]);
  });
});

describe("anthropic ingress — multimodal fidelity", () => {
  it("maps base64 image blocks to image_url data-URL parts", () => {
    const out = fromAnthropicRequest({
      model: "auto",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
          ],
        },
      ],
    });
    expect(out.messages[0]!.content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
    ]);
  });

  it("preserves tool_use/tool_result linkage", () => {
    const out = fromAnthropicRequest({
      model: "auto",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "lookup", input: { q: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "found it" }] },
      ],
    });
    expect(out.messages[0]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "toolu_9", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
    });
    expect(out.messages[1]).toEqual({ role: "tool", content: "found it", tool_call_id: "toolu_9" });
  });
});

describe("codex translator — multimodal", () => {
  it("maps array content to input_text/input_image parts", () => {
    const out: any = toCodexRequest({
      model: "gpt-5.5",
      messages: [{ role: "user", content: [textPart("look"), imgPart(PNG_DATA_URL)] }],
    });
    expect(out.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: PNG_DATA_URL },
        ],
      },
    ]);
  });
});

describe("executor wire conversion", () => {
  const geminiProvider = {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://gemini.example",
    wireFormat: "gemini",
    models: ["gemini-2.5-flash"],
    defaultModel: "gemini-2.5-flash",
    costTier: 2,
    apiKey: "g-key",
    allKeys: ["g-key"],
  } as unknown as ResolvedProvider;

  it("sends inline_data to a gemini-wire upstream", async () => {
    let wireBody: any = null;
    const fetchFn = (async (_url: string, init: any) => {
      wireBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "a red circle" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const req: ChatCompletionRequest = {
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: [textPart("describe"), imgPart(PNG_DATA_URL)] }],
    };
    const res = await executeProvider(geminiProvider, "gemini-2.5-flash", req, fetchFn);
    expect(res.response!.choices[0]!.message.content).toBe("a red circle");
    expect(wireBody.contents[0].parts).toEqual([
      { text: "describe" },
      { inline_data: { mime_type: "image/png", data: PNG_DATA_URL.split(",")[1] } },
    ]);
  });

  it("passes content arrays through verbatim on the openai wire", async () => {
    let wireBody: any = null;
    const fetchFn = (async (_url: string, init: any) => {
      wireBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          id: "x",
          model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const provider = {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.example/v1",
      wireFormat: "openai",
      models: ["gpt-4o"],
      defaultModel: "gpt-4o",
      costTier: 4,
      apiKey: "k",
      allKeys: ["k"],
    } as unknown as ResolvedProvider;
    const content = [textPart("describe"), imgPart(PNG_DATA_URL)];
    await executeProvider(
      provider,
      "gpt-4o",
      { model: "gpt-4o", messages: [{ role: "user", content }] },
      fetchFn,
    );
    expect(wireBody.messages[0].content).toEqual(content);
  });
});

describe("router vision gate", () => {
  it("rejects image requests to a text-only dedicated transport with the typed error", async () => {
    const ddg = {
      id: "duckduckgo-web",
      name: "DuckDuckGo Web",
      baseUrl: "https://duckduckgo.example",
      wireFormat: "openai",
      models: ["ddg-model"],
      defaultModel: "ddg-model",
      costTier: 1,
      apiKey: "",
      allKeys: [""],
    } as unknown as ResolvedProvider;
    const router = createRouter([ddg]);
    const err = await router
      .route({
        model: "duckduckgo-web:ddg-model",
        messages: [{ role: "user", content: [textPart("look"), imgPart(PNG_DATA_URL)] }],
      })
      .catch((e) => e);
    expect(isVisionNotSupported(err)).toBe(true);
    expect(err).toBeInstanceOf(VisionNotSupportedError);
    expect((err as VisionNotSupportedError).errorType).toBe("vision_not_supported");
    expect((err as Error).message).toContain("duckduckgo-web:ddg-model");
  });
});

describe("ingress e2e — multimodal over HTTP", () => {
  let upstream: Server;
  let server: Server;
  let store: Store;
  let dir: string;
  let lastUpstreamBody: any = null;

  afterEach(async () => {
    server?.close();
    upstream?.close();
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    delete process.env.ADMIN_KEY;
  });

  async function boot(): Promise<{ base: string; auth: Record<string, string> }> {
    upstream = createHttpServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        lastUpstreamBody = JSON.parse(raw || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "mm",
            model: lastUpstreamBody.model ?? "vision-1",
            choices: [{ index: 0, message: { role: "assistant", content: "MM-OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        );
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upPort = (upstream.address() as { port: number }).port;

    process.env.ADMIN_KEY = "mm-admin";
    dir = mkdtempSync(join(tmpdir(), "lsw-mm-"));
    store = new Store(dir);
    const stub = {
      id: "stub",
      name: "Stub",
      baseUrl: `http://127.0.0.1:${upPort}/v1`,
      wireFormat: "openai",
      models: ["vision-1"],
      defaultModel: "vision-1",
      costTier: 3,
      apiKey: "stub-key",
      allKeys: ["stub-key"],
    } as unknown as ResolvedProvider;
    const ddg = {
      id: "duckduckgo-web",
      name: "DuckDuckGo Web",
      baseUrl: "https://duckduckgo.example",
      wireFormat: "openai",
      models: ["ddg-model"],
      defaultModel: "ddg-model",
      costTier: 1,
      apiKey: "",
      allKeys: [""],
    } as unknown as ResolvedProvider;
    const fakeRegistry = {
      all: () => [],
      connected: () => [stub, ddg],
    } as unknown as import("../src/providers/registry.js").ProviderRegistry;
    const { app } = createServer(loadConfig(), [stub, ddg], store, fakeRegistry);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const keyRes = await fetch(`${base}/api/keys`, {
      method: "POST",
      headers: { "x-admin-key": "mm-admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "mm-key" }),
    });
    const { key } = (await keyRes.json()) as { key: string };
    return { base, auth: { authorization: `Bearer ${key}`, "content-type": "application/json" } };
  }

  it("accepts array content (no schema 400) and forwards it to the upstream", async () => {
    const { base, auth } = await boot();
    const content = [textPart("describe this"), imgPart(PNG_DATA_URL)];
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model: "stub:vision-1", messages: [{ role: "user", content }] }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(j.choices[0]!.message.content).toBe("MM-OK");
    expect(lastUpstreamBody.messages[0].content).toEqual(content);
  });

  it("string content still works (regression)", async () => {
    const { base, auth } = await boot();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "stub:vision-1",
        messages: [{ role: "user", content: "plain hello" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(lastUpstreamBody.messages[0].content).toBe("plain hello");
  });

  it("tool linkage survives ingress (tool_calls/tool_call_id not stripped)", async () => {
    const { base, auth } = await boot();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "stub:vision-1",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call-1", type: "function", function: { name: "get_weather", arguments: '{"city":"Dhaka"}' } },
            ],
          },
          { role: "tool", content: "sunny", tool_call_id: "call-1" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(lastUpstreamBody.messages[1].tool_calls).toEqual([
      { id: "call-1", type: "function", function: { name: "get_weather", arguments: '{"city":"Dhaka"}' } },
    ]);
    expect(lastUpstreamBody.messages[2].tool_call_id).toBe("call-1");
  });

  it("image request to a text-only provider returns 400 vision_not_supported", async () => {
    const { base, auth } = await boot();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "duckduckgo-web:ddg-model",
        messages: [{ role: "user", content: [textPart("look"), imgPart(PNG_DATA_URL)] }],
      }),
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { type: string; message: string } };
    expect(j.error.type).toBe("vision_not_supported");
    expect(j.error.message).toContain("duckduckgo-web");
  });
});
