import { describe, expect, it } from "vitest";
import { CATALOG_PROVIDERS } from "../src/providers/catalog.js";
import { registry } from "../src/providers/registry.js";
import { executeProvider } from "../src/executor/http.js";

const byId = new Map(CATALOG_PROVIDERS.map((p) => [p.id, p]));

describe("P11-K catalog presence", () => {
  it("includes bedrock + vertex as env-creds providers", () => {
    const bedrock = byId.get("bedrock");
    expect(bedrock).toBeDefined();
    expect(bedrock!.authType).toBe("env-creds");
    expect(bedrock!.models).toContain("anthropic.claude-sonnet-4-6");

    const vertex = byId.get("vertex");
    expect(vertex).toBeDefined();
    expect(vertex!.authType).toBe("env-creds");
    expect(vertex!.models).toContain("gemini-2.5-flash");
  });

  it("includes command-code with its non-default chat path", () => {
    const cc = byId.get("command-code");
    expect(cc).toBeDefined();
    expect(cc!.baseUrl).toBe("https://api.commandcode.ai");
    expect(cc!.chatPath).toBe("/provider/v1/chat/completions");
  });

  it("includes promptql (GraphQL thread protocol, dedicated executor)", () => {
    const pql = byId.get("promptql");
    expect(pql).toBeDefined();
    expect(pql!.envKey).toBe("PROMPTQL_API_KEY");
    expect(pql!.models).toContain("bedrock-claude-sonnet-4-5");
  });

  it("keeps tinycms-web as a disabled entry (WASM signer not ported)", () => {
    const tc = byId.get("tinycms-web");
    expect(tc).toBeDefined();
    expect(tc!.disabled).toMatch(/WASM/);
  });

  it("keeps the plain api-key gateways dgrid / inference-net / kilo-gateway", () => {
    expect(byId.get("dgrid")!.baseUrl).toBe("https://api.dgrid.ai/v1");
    expect(byId.get("dgrid")!.models).toContain("dgridai/free");
    // P11-K fix: placeholder model list replaced with OmniRoute's real ids
    expect(byId.get("inference-net")!.models).toEqual([
      "meta-llama/Llama-3.3-70B-Instruct",
      "deepseek-ai/DeepSeek-R1",
      "Qwen/Qwen2.5-72B-Instruct",
    ]);
    expect(byId.get("kilo-gateway")).toBeDefined();
  });
});

describe("P11-K registry connection rules", () => {
  it("connects bedrock only with the AWS key pair set", () => {
    const withCreds = registry.connected({
      AWS_ACCESS_KEY_ID: "AK",
      AWS_SECRET_ACCESS_KEY: "SK",
    } as NodeJS.ProcessEnv);
    expect(withCreds.some((p) => p.id === "bedrock")).toBe(true);
    const without = registry.connected({} as NodeJS.ProcessEnv);
    expect(without.some((p) => p.id === "bedrock")).toBe(false);
  });

  it("connects vertex with a pre-minted token + project", () => {
    const connected = registry.connected({
      VERTEX_ACCESS_TOKEN: "ya29.x",
      VERTEX_PROJECT_ID: "p",
    } as NodeJS.ProcessEnv);
    expect(connected.some((p) => p.id === "vertex")).toBe(true);
    expect(registry.connected({} as NodeJS.ProcessEnv).some((p) => p.id === "vertex")).toBe(false);
  });

  it("never connects tinycms-web (disabled), even with its UUID set", () => {
    const connected = registry.connected({ TINYCMS_UUID: "R1234567890" } as NodeJS.ProcessEnv);
    expect(connected.some((p) => p.id === "tinycms-web")).toBe(false);
  });
});

describe("command-code dispatch (generic executor + chatPath)", () => {
  it("posts to /provider/v1/chat/completions with a Bearer key", async () => {
    const connected = registry.connected({
      COMMAND_CODE_API_KEY: "<redacted>",
    } as NodeJS.ProcessEnv);
    const provider = connected.find((p) => p.id === "command-code");
    expect(provider).toBeDefined();

    let seen: { url: string; init: any } | null = null;
    const fetchFn = (async (url: any, init: any) => {
      seen = { url: String(url), init };
      return new Response(
        JSON.stringify({
          id: "chatcmpl-cc",
          model: "claude-sonnet-4-6",
          choices: [{ index: 0, message: { role: "assistant", content: "cc ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const out = await executeProvider(
      provider!,
      "claude-sonnet-4-6",
      { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] },
      fetchFn,
      5_000,
    );
    expect(out.response?.choices[0]!.message.content).toBe("cc ok");
    expect(seen!.url).toBe("https://api.commandcode.ai/provider/v1/chat/completions");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer <redacted>");
  });
});
