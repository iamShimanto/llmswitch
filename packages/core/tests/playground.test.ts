import http from "node:http";
import { describe, expect, it } from "vitest";
import { fanout } from "../src/playground/index.js";
import { detectLocalProviders } from "../src/providers/local.js";
import type { ResolvedProvider } from "../src/providers/types.js";

function prov(id: string, baseUrl = "https://example.com"): ResolvedProvider {
  return {
    id, name: id, baseUrl, wireFormat: "openai",
    models: ["m"], defaultModel: "m", costTier: 3, apiKey: "k",
  };
}

function ok(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "x", model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const body = { model: "auto", messages: [{ role: "user" as const, content: "hi" }] };

/** Stub router: routes via the generic executor with a mock fetch. */
function stubRouter(fetchFn: typeof fetch) {
  return {
    route: async (b: { model: string; messages: typeof body.messages }) => {
      const id = b.model.split(":")[0]!;
      const p = prov(id);
      const { executeProvider } = await import("../src/executor/http.js");
      return executeProvider(p, p.defaultModel, { ...b, stream: false } as never, fetchFn);
    },
  };
}

describe("fanout", () => {
  it("collects results from all providers in parallel", async () => {
    const fetchFn = (async (url: string) => {
      await new Promise((r) => setTimeout(r, 20));
      return ok(`reply from ${url}`);
    }) as typeof fetch;

    const results = await fanout([prov("a"), prov("b"), prov("c")], body, stubRouter(fetchFn) as never);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.providerId).sort()).toEqual(["a", "b", "c"]);
    expect(results[0]!.promptTokens).toBe(2);
  });

  it("one failure doesn't fail the batch", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("example.com")) return new Response("boom", { status: 500 });
      return ok("fine");
    }) as typeof fetch;

    const results = await fanout([prov("a"), prov("b", "https://other.com")], body, stubRouter(fetchFn) as never);
    const a = results.find((r) => r.providerId === "a")!;
    const b = results.find((r) => r.providerId === "b")!;
    expect(a.ok).toBe(false);
    expect(a.error).toBeTruthy();
    expect(b.ok).toBe(true);
  });

  it("counts a silent fallback to another provider as a failure", async () => {
    const fallbackRouter = {
      route: async (b: { model: string }) => ({
        providerId: "someone-else",
        model: b.model,
        latencyMs: 1,
        response: {
          id: "x", model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      }),
    };
    const results = await fanout([prov("a")], body, fallbackRouter as never);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toContain("fell back");
  });
});

describe("detectLocalProviders", () => {
  it("detects Ollama when /api/tags responds", async () => {
    const srv = http.createServer((req, res) => {
      if (req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "llama3.1:8b" }, { name: "qwen2.5:7b" }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as any).port;

    const found = await detectLocalProviders({ ollamaUrl: `http://127.0.0.1:${port}` });
    const ollama = found.find((d) => d.id === "ollama")!;
    expect(ollama).toBeDefined();
    expect(ollama.models).toEqual(["llama3.1:8b", "qwen2.5:7b"]);
    expect(ollama.noAuth).toBe(true);
    srv.close();
  });

  it("detects LM Studio when /v1/models responds", async () => {
    const srv = http.createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "local-model" }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as any).port;

    const found = await detectLocalProviders({
      ollamaUrl: "http://127.0.0.1:1", // nothing there
      lmstudioUrl: `http://127.0.0.1:${port}`,
    });
    expect(found.find((d) => d.id === "lmstudio")!.models).toEqual(["local-model"]);
    expect(found.find((d) => d.id === "ollama")).toBeUndefined();
    srv.close();
  });

  it("returns [] when nothing is running", async () => {
    const found = await detectLocalProviders({
      ollamaUrl: "http://127.0.0.1:1",
      lmstudioUrl: "http://127.0.0.1:1",
      timeoutMs: 300,
    });
    expect(found).toEqual([]);
  });
});
