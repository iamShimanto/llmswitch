import { describe, expect, it } from "vitest";
import { BUILTIN_PROVIDERS } from "../src/providers/builtins.js";
import { CATALOG_PROVIDERS } from "../src/providers/catalog.js";
import { registry } from "../src/providers/registry.js";

describe("provider catalog", () => {
  it("has no duplicate ids across builtins + catalog", () => {
    const ids = [...BUILTIN_PROVIDERS, ...CATALOG_PROVIDERS].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry has id, https baseUrl, wireFormat and models", () => {
    for (const p of CATALOG_PROVIDERS) {
      expect(p.id.length).toBeGreaterThan(0);
      expect(p.baseUrl.startsWith("https://")).toBe(true);
      expect(["openai", "anthropic", "gemini"]).toContain(p.wireFormat);
      // passthrough routers accept any model id — empty list is valid;
      // otherwise the default model must be in the list
      if (p.models.length > 0) {
        expect(p.models).toContain(p.defaultModel);
      }
      // API-key providers name a *_API_KEY env var; OAuth/token-import
      // providers resolve tokens from a login session instead, and
      // keyless ("none") providers work without any key (envKey stays as
      // an optional slot that only raises anonymous rate limits).
      if (
        p.authType !== "oauth" &&
        p.authType !== "token-import" &&
        p.authType !== "none" &&
        p.authType !== "env-creds" &&
        p.authType !== "cookie" &&
        !p.disabled
      ) {
        expect(p.envKey.endsWith("_API_KEY")).toBe(true);
      }
    }
  });

  it("catalog is substantial (100+ converted families)", () => {
    expect(CATALOG_PROVIDERS.length).toBeGreaterThan(100);
  });

  it("spot-check known conversions", () => {
    const byId = new Map(CATALOG_PROVIDERS.map((p) => [p.id, p]));
    const aiml = byId.get("aimlapi");
    expect(aiml).toBeDefined();
    expect(aiml!.baseUrl).toBe("https://api.aimlapi.com/v1");
    expect(aiml!.wireFormat).toBe("openai");
    expect(aiml!.models).toContain("gpt-4o");
  });

  it("registry exposes the full catalog", () => {
    const all = registry.all();
    expect(all.length).toBe(BUILTIN_PROVIDERS.length + CATALOG_PROVIDERS.length);
  });

  it("envKey override still works for catalog providers", () => {
    const connected = registry.connected({
      AIMLAPI_API_KEY: "k",
      AIMLAPI_BASE_URL: "https://custom.example.com/v1",
    } as NodeJS.ProcessEnv);
    const p = connected.find((x) => x.id === "aimlapi")!;
    expect(p.baseUrl).toBe("https://custom.example.com/v1");
  });
});
