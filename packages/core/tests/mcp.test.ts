import { describe, expect, it } from "vitest";
import { McpServer } from "../src/mcp/server.js";
import { registry } from "../src/providers/registry.js";

describe("MCP server", () => {
  it("initialize handshake", async () => {
    const s = new McpServer();
    const out = await s.dispatch(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    );
    const r = JSON.parse(out!);
    expect(r.result.protocolVersion).toBe("2024-11-05");
    expect(r.result.serverInfo.name).toBe("llmswitch");
  });

  it("tools/list exposes all 17 tools", async () => {
    const s = new McpServer();
    const out = await s.dispatch(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const names = JSON.parse(out!).result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      "budget_status",
      "cache_stats",
      "chat",
      "check_quota",
      "clear_cache",
      "compress",
      "create_embeddings",
      "discover_models",
      "estimate_cost",
      "explain_routing",
      "fetch_url",
      "get_stats",
      "list_providers",
      "pick_fastest_model",
      "replay_request",
      "rerank",
      "web_search",
    ]);
  });

  it("notifications get no response", async () => {
    const s = new McpServer();
    const out = await s.dispatch(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(out).toBeNull();
  });

  it("unknown method → -32601", async () => {
    const s = new McpServer();
    const out = await s.dispatch(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "bogus" }));
    expect(JSON.parse(out!).error.code).toBe(-32601);
  });

  it("tools/call list_providers", async () => {
    const s = new McpServer();
    const out = await s.dispatch(
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_providers", arguments: {} } }),
    );
    const text = JSON.parse(out!).result.content[0].text;
    expect(typeof text).toBe("string");
  });

  it("tools/call chat requires prompt", async () => {
    const s = new McpServer();
    const out = await s.dispatch(
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "chat", arguments: {} } }),
    );
    expect(JSON.parse(out!).error.code).toBe(-32602);
  });

  it("tools/call unknown tool → -32602", async () => {
    const s = new McpServer();
    const out = await s.dispatch(
      JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope", arguments: {} } }),
    );
    expect(JSON.parse(out!).error.code).toBe(-32602);
  });

  it("tools/call compress", async () => {
    const s = new McpServer();
    const out = await s.dispatch(
      JSON.stringify({
        jsonrpc: "2.0", id: 7, method: "tools/call",
        params: { name: "compress", arguments: { text: "Hello! Could you please explain this in detail? Thank you!", mode: "caveman" } },
      }),
    );
    const text = JSON.parse(out!).result.content[0].text;
    expect(text).toContain("saved");
  });

  it("malformed JSON → null (no crash)", async () => {
    const s = new McpServer();
    expect(await s.dispatch("not json")).toBeNull();
  });
});

describe("MCP new tools (P10-A)", () => {
  let id = 100;
  async function call(s: McpServer, name: string, args: any) {
    const out = await s.dispatch(
      JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    );
    return JSON.parse(out!);
  }
  const textOf = (r: any) => r.result?.content?.[0]?.text as string | undefined;

  it("discover_models returns text (or no-providers notice)", async () => {
    const s = new McpServer();
    const r = await call(s, "discover_models", { query: "gpt" });
    expect(r.error).toBeUndefined();
    expect(typeof textOf(r)).toBe("string");
  });

  it("estimate_cost requires prompt", async () => {
    const s = new McpServer();
    expect((await call(s, "estimate_cost", {})).error.code).toBe(-32602);
  });

  it("estimate_cost handles no-providers gracefully", async () => {
    const s = new McpServer();
    const r = await call(s, "estimate_cost", { prompt: "hello world, this is a test prompt" });
    expect(r.error).toBeUndefined();
    expect(typeof textOf(r)).toBe("string");
  });

  it("explain_routing returns text (or no-providers notice)", async () => {
    const s = new McpServer();
    const r = await call(s, "explain_routing", { model: "auto", strategy: "priority" });
    expect(r.error).toBeUndefined();
    expect(typeof textOf(r)).toBe("string");
  });

  it("explain_routing falls back on bad strategy", async () => {
    const s = new McpServer();
    const r = await call(s, "explain_routing", { model: "auto", strategy: "not-a-strategy" });
    expect(r.error).toBeUndefined();
  });

  it("check_quota returns text", async () => {
    const s = new McpServer();
    const r = await call(s, "check_quota", {});
    expect(r.error).toBeUndefined();
    expect(typeof textOf(r)).toBe("string");
  });

  it("cache_stats shows hit rate, clear_cache needs confirm", async () => {
    const s = new McpServer();
    const stats = textOf(await call(s, "cache_stats", {}))!;
    expect(stats).toContain("hit rate");
    expect((await call(s, "clear_cache", {})).error.code).toBe(-32602);
    expect((await call(s, "clear_cache", { confirm: false })).error.code).toBe(-32602);
    const cleared = textOf(await call(s, "clear_cache", { confirm: true }))!;
    expect(cleared).toContain("cleared");
  });

  it("fetch_url requires url; SSRF-blocked host errors", async () => {
    const s = new McpServer();
    expect((await call(s, "fetch_url", {})).error.code).toBe(-32602);
    const r = await call(s, "fetch_url", { url: "http://127.0.0.1:9/" });
    expect(r.error.code).toBe(-32603);
    expect(r.error.message).toMatch(/blocked|private/i);
  });

  it("rerank validates args", async () => {
    const s = new McpServer();
    expect((await call(s, "rerank", {})).error.code).toBe(-32602);
    expect((await call(s, "rerank", { query: "q" })).error.code).toBe(-32602);
    // Keyless providers are always connected now (P11-J), so the valid-args
    // path dispatches for real; stub fetch to fail fast so the test stays
    // hermetic and lands deterministically on the -32603 branch.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("test: network disabled"); }) as typeof fetch;
    try {
      const r = await call(s, "rerank", { query: "q", documents: ["a", "b"] });
      if (r.error) {
        expect(r.error.code).toBe(-32603); // providers present but upstream unreachable
      } else {
        expect(textOf(r)).toContain("no providers connected");
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("create_embeddings validates input", async () => {
    const s = new McpServer();
    expect((await call(s, "create_embeddings", {})).error.code).toBe(-32602);
    // See rerank test: keyless providers are always connected (P11-J) —
    // stub fetch so the valid-input path fails fast instead of hitting the
    // real network.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("test: network disabled"); }) as typeof fetch;
    try {
      const r = await call(s, "create_embeddings", { input: "hello" });
      if (r.error) {
        expect(r.error.code).toBe(-32603); // providers present but upstream unreachable
      } else {
        expect(textOf(r)).toContain("no providers connected");
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("budget_status reports action + session spend", async () => {
    const s = new McpServer();
    const t = textOf(await call(s, "budget_status", {}))!;
    expect(t).toContain("budget action:");
    expect(t).toContain("session spend: $");
  });

  it("replay_request validates id and rejects unknown ids", async () => {
    const s = new McpServer();
    expect((await call(s, "replay_request", {})).error.code).toBe(-32602);
    const r = await call(s, "replay_request", { id: "deadbeef1234" });
    expect(r.error.code).toBe(-32602);
    expect(r.error.message).toContain("no logged request");
  });
});

// registry sanity for MCP context
describe("registry (mcp context)", () => {
  it("has providers registered", () => {
    expect(registry.all().length).toBeGreaterThan(100);
  });
});

  it("tools/call pick_fastest_model (no data → config order)", async () => {
    const s = new McpServer();
    const out = await s.dispatch(
      JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "pick_fastest_model", arguments: {} } }),
    );
    const text = JSON.parse(out!).result.content[0].text;
    expect(typeof text).toBe("string");
  });

  it("tools/call get_stats", async () => {
    const s = new McpServer();
    const out = await s.dispatch(
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_stats", arguments: {} } }),
    );
    expect(JSON.parse(out!).result.content[0].text).toContain("no routing data yet");
  });

  it("tools/call web_search without key → error", async () => {
    const s = new McpServer();
    delete process.env.SEARCH_API_KEY;
    const out = await s.dispatch(
      JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "web_search", arguments: { query: "x" } } }),
    );
    expect(JSON.parse(out!).error.code).toBe(-32603);
  });
