import { createRouter, resolveTarget } from "../router/index.js";
import { STRATEGY_NAMES, isStrategyName, orderProviders } from "../router/strategies.js";
import { registry } from "../providers/registry.js";
import type { ResolvedProvider } from "../providers/types.js";
import { loadConfig } from "../config.js";
import { detectLocalProviders } from "../providers/local.js";
import { compressText, isCompressionMode } from "../compression/index.js";
import { getPrice, costUsd } from "../billing/prices.js";
import { PromptCache } from "../cache/index.js";
import { fetchPageText } from "../search/index.js";
import { randomBytes } from "node:crypto";

/**
 * Minimal MCP server (protocol 2024-11-05) over newline-delimited JSON-RPC.
 * Exposes the gateway as 17 tools: chat, list_providers, compress,
 * pick_fastest_model, get_stats, web_search, discover_models, estimate_cost,
 * explain_routing, check_quota, cache_stats, clear_cache, fetch_url,
 * rerank, create_embeddings, budget_status, replay_request.
 * Run: `llmswitch mcp`
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: any;
}

const TOOLS = [
  {
    name: "chat",
    description: "Send a chat completion through the LLMSwitch gateway (auto provider routing).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "User message" },
        model: { type: "string", description: "Model id, provider:model, or 'auto'", default: "auto" },
        system: { type: "string", description: "Optional system prompt" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "list_providers",
    description: "List connected providers and their default models.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "compress",
    description: "Compress a prompt with caveman/RTK to save tokens. Returns compressed text + savings stats.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to compress" },
        mode: { type: "string", enum: ["caveman", "rtk", "stacked"], default: "stacked" },
      },
      required: ["text"],
    },
  },
  {
    name: "pick_fastest_model",
    description: "Pick the fastest provider by measured latency (falls back to config order with no data).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_stats",
    description: "Per-provider routing stats: calls, errors, average latency.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "web_search",
    description: "Web search via Tavily/Brave (needs SEARCH_API_KEY on the server).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: { type: "number", default: 5 },
      },
      required: ["query"],
    },
  },
  {
    name: "discover_models",
    description: "Search the connected provider model catalog (same as /v1/models/query).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Filter by model or provider id (empty = all)" },
      },
    },
  },
  {
    name: "estimate_cost",
    description: "Estimate USD cost for a prompt without sending it. Uses the price table (~4 chars/token heuristic).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Prompt text to estimate" },
        model: { type: "string", description: "Model id, provider:model, or 'auto' (cheapest first)", default: "auto" },
        max_output_tokens: { type: "number", description: "Assumed completion length", default: 512 },
      },
      required: ["prompt"],
    },
  },
  {
    name: "explain_routing",
    description: "Explain why a provider/model would be picked: strategy, ordered candidates, live stats.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model id, provider:model, or 'auto'", default: "auto" },
        strategy: { type: "string", description: `Routing strategy (${STRATEGY_NAMES.join("|")}); defaults to server config` },
      },
    },
  },
  {
    name: "check_quota",
    description: "Quota/call telemetry per connected provider (same as /v1/quotas/check).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cache_stats",
    description: "Prompt-cache stats for this MCP session: entries, hits, misses, hit rate.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "clear_cache",
    description: "Clear this MCP session's prompt cache.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: { type: "boolean", description: "Must be true" },
      },
      required: ["confirm"],
    },
  },
  {
    name: "fetch_url",
    description: "Fetch a public URL and extract readable text (SSRF-guarded: blocks private IPs).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "http(s) URL to fetch" },
      },
      required: ["url"],
    },
  },
  {
    name: "rerank",
    description: "Rerank documents against a query via the provider's /rerank endpoint (OpenAI-wire providers).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        documents: { type: "array", items: { type: "string" }, description: "Documents to rank" },
        model: { type: "string", description: "Model id, provider:model, or 'auto'", default: "auto" },
        top_n: { type: "number", description: "Return top N" },
      },
      required: ["query", "documents"],
    },
  },
  {
    name: "create_embeddings",
    description: "Create embeddings via the provider's /embeddings endpoint (OpenAI-wire providers).",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Text to embed (or JSON array of strings)" },
        model: { type: "string", description: "Model id, provider:model, or 'auto'", default: "auto" },
      },
      required: ["input"],
    },
  },
  {
    name: "budget_status",
    description: "Budget enforcement config (BUDGET_ACTION) + this MCP session's accumulated spend.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "replay_request",
    description: "Re-execute a previous chat request from this session's log by id (see chat output header).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Request id from a previous chat call" },
      },
      required: ["id"],
    },
  },
];

interface LoggedRequest {
  id: string;
  ts: number;
  model: string;
  messages: Array<{ role: "user" | "system"; content: string }>;
}

export class McpServer {
  private router: ReturnType<typeof createRouter>;
  private cache = new PromptCache();
  private requestLog: LoggedRequest[] = [];
  private spendUsd = 0;

  constructor() {
    this.router = createRouter(registry.connected(), { cache: this.cache });
  }

  /** Resolve an OpenAI-wire provider for media-style passthrough (mirrors /v1/* route logic). */
  private resolveMedia(modelStr: string): ResolvedProvider | null {
    const providers = registry.connected();
    if (!modelStr || modelStr === "auto") return providers[0] ?? null;
    const colon = modelStr.indexOf(":");
    if (colon > 0) {
      const p = providers.find((x) => x.id === modelStr.slice(0, colon));
      if (p) return p;
    }
    return providers.find((x) => x.models.includes(modelStr)) ?? providers[0] ?? null;
  }

  private async passthrough(p: ResolvedProvider, path: string, body: unknown): Promise<string> {
    const upstream = await fetch(`${p.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // keyless providers (authType "none", empty key): no Authorization
        // header — an empty Bearer reads as a *bad* key and 403s upstream
        ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      throw { code: -32603, message: `upstream ${upstream.status}: ${text.slice(0, 300)}` };
    }
    return text.length > 6000 ? text.slice(0, 6000) + "…[truncated]" : text;
  }

  private logRequest(model: string, messages: LoggedRequest["messages"]): string {
    const id = randomBytes(6).toString("hex");
    this.requestLog.unshift({ id, ts: Date.now(), model, messages });
    if (this.requestLog.length > 50) this.requestLog.length = 50;
    return id;
  }

  async handle(req: JsonRpcRequest): Promise<any> {
    switch (req.method) {
      case "initialize":
        return {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "llmswitch", version: "0.1.0" },
        };
      case "notifications/initialized":
        return null; // notification, no response
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call":
        return this.callTool(req.params?.name, req.params?.arguments ?? {});
      case "ping":
        return {};
      default:
        throw { code: -32601, message: `unknown method: ${req.method}` };
    }
  }

  private async callTool(name: string, args: any): Promise<any> {
    const text = (t: string) => ({ content: [{ type: "text", text: t }] });
    switch (name) {
      case "list_providers": {
        const ps = registry.connected().map((p) => `${p.id} (default: ${p.defaultModel})`);
        return text(ps.length ? ps.join("\n") : "no providers connected");
      }
      case "chat": {
        if (typeof args.prompt !== "string" || !args.prompt) {
          throw { code: -32602, message: "prompt is required" };
        }
        const messages: Array<{ role: "user" | "system"; content: string }> = [];
        if (typeof args.system === "string" && args.system) messages.push({ role: "system", content: args.system });
        messages.push({ role: "user", content: args.prompt });
        const modelStr = typeof args.model === "string" && args.model ? args.model : "auto";
        const r = await this.router.route({ model: modelStr, messages });
        const reply = r.response?.choices[0]?.message.content ?? "";
        const id = this.logRequest(modelStr, messages);
        const u = r.response?.usage;
        if (u) this.spendUsd += costUsd(r.providerId, r.model, u.prompt_tokens, u.completion_tokens);
        return text(`[req ${id} · ${r.providerId}/${r.model}${r.cached ? " · cached" : ""}] ${reply}`);
      }
      case "compress": {
        if (typeof args.text !== "string" || !args.text) {
          throw { code: -32602, message: "text is required" };
        }
        const mode = isCompressionMode(args.mode) ? args.mode : "stacked";
        const out = compressText(args.text, mode);
        return text(
          `saved ${out.stats.savedChars} chars (${out.stats.savedPct}%), ~${out.stats.estTokensBefore} → ~${out.stats.estTokensAfter} tokens\n\n${out.text}`,
        );
      }
      case "pick_fastest_model": {
        const stats = this.router.stats;
        let best: string | null = null;
        let bestMs = Infinity;
        for (const [id, s] of stats) {
          if (s.calls > 0) {
            const avg = s.totalLatencyMs / s.calls;
            if (avg < bestMs) {
              bestMs = avg;
              best = id;
            }
          }
        }
        const connected = registry.connected();
        if (!best) best = connected[0]?.id ?? null;
        if (!best) return text("no providers connected");
        const p = connected.find((x) => x.id === best)!;
        const measured = bestMs !== Infinity;
        return text(
          `${p.id}:${p.defaultModel}` +
            (measured ? ` (avg ${Math.round(bestMs)}ms over ${stats.get(best)!.calls} calls)` : " (no latency data yet — config order)"),
        );
      }
      case "get_stats": {
        const lines: string[] = [];
        for (const [id, s] of this.router.stats) {
          const avg = s.calls > 0 ? Math.round(s.totalLatencyMs / s.calls) : 0;
          lines.push(`${id}: ${s.calls} calls, ${s.errors} errors, avg ${avg}ms`);
        }
        return text(lines.length ? lines.join("\n") : "no routing data yet");
      }
      case "web_search": {
        if (typeof args.query !== "string" || !args.query) {
          throw { code: -32602, message: "query is required" };
        }
        try {
          const { webSearch } = await import("../search/index.js");
          const out = await webSearch(args.query, Number(args.max_results ?? 5) || 5);
          return text(
            out.results.map((r) => `• ${r.title}\n  ${r.url}\n  ${r.snippet.slice(0, 200)}`).join("\n") ||
              "no results",
          );
        } catch (err) {
          throw { code: -32603, message: err instanceof Error ? err.message : String(err) };
        }
      }
      case "discover_models": {
        const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
        const connected = registry.connected();
        if (!connected.length) return text("no providers connected");
        const data = connected.flatMap((p) =>
          p.models
            .filter((m) => !q || m.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
            .map((m) => `${p.id}:${m}`),
        );
        return text(data.length ? data.slice(0, 200).join("\n") : "no models match");
      }
      case "estimate_cost": {
        if (typeof args.prompt !== "string" || !args.prompt) {
          throw { code: -32602, message: "prompt is required" };
        }
        const connected = registry.connected();
        if (!connected.length) return text("no providers connected");
        const promptTokens = Math.max(1, Math.ceil(args.prompt.length / 4));
        const outTokens = Math.max(1, Number(args.max_output_tokens ?? 512) || 512);
        const modelStr = typeof args.model === "string" && args.model ? args.model : "auto";
        const fmt = (pid: string, model: string) => {
          const price = getPrice(pid, model);
          if (!price) return `${pid}:${model} — no pricing data`;
          const c = costUsd(pid, model, promptTokens, outTokens);
          return `${pid}:${model} — ~${promptTokens} in + ${outTokens} out tokens ≈ $${c.toFixed(6)}`;
        };
        if (modelStr !== "auto") {
          const t = resolveTarget(connected, modelStr, "priority", this.router.stats);
          return text(fmt(t.provider.id, t.model) + "\n(heuristic: ~4 chars/token; estimates only)");
        }
        const rows = connected
          .map((p) => ({ pid: p.id, model: p.defaultModel, c: costUsd(p.id, p.defaultModel, promptTokens, outTokens) }))
          .filter((r) => getPrice(r.pid, r.model))
          .sort((a, b) => a.c - b.c)
          .slice(0, 5);
        if (!rows.length) return text("no pricing data for connected providers");
        return text(
          rows.map((r) => fmt(r.pid, r.model)).join("\n") +
            "\ncheapest first · (heuristic: ~4 chars/token; estimates only)",
        );
      }
      case "explain_routing": {
        const connected = registry.connected();
        if (!connected.length) return text("no providers connected");
        const modelStr = typeof args.model === "string" && args.model ? args.model : "auto";
        const strategy = typeof args.strategy === "string" && isStrategyName(args.strategy)
          ? args.strategy
          : loadConfig().strategy;
        const target = resolveTarget(connected, modelStr, strategy, this.router.stats);
        const ordered = orderProviders(connected, strategy, this.router.stats)
          .slice(0, 5)
          .map((p, i) => {
            const s = this.router.stats.get(p.id);
            return `${i + 1}. ${p.id} (${s?.calls ?? 0} calls, ${s?.errors ?? 0} errors)`;
          });
        return text(
          `model: ${modelStr}\nstrategy: ${strategy}\n→ picked: ${target.provider.id}:${target.model}\n\ntop candidates:\n${ordered.join("\n")}`,
        );
      }
      case "check_quota": {
        const connected = registry.connected();
        if (!connected.length) return text("no providers connected");
        const lines = connected.map((p) => {
          const s = this.router.stats.get(p.id);
          return `${p.id}: ${s?.calls ?? 0} calls, ${s?.errors ?? 0} errors (upstream quota telemetry: n/a in MCP)`;
        });
        return text(lines.join("\n"));
      }
      case "cache_stats": {
        const s = this.cache.stats();
        return text(
          `entries: ${s.entries}\nhits: ${s.hits}\nmisses: ${s.misses}\nhit rate: ${s.hitRate}%`,
        );
      }
      case "clear_cache": {
        if (args.confirm !== true) {
          throw { code: -32602, message: "pass confirm: true to clear the cache" };
        }
        const before = this.cache.stats().entries;
        this.cache.clear();
        return text(`cleared ${before} cached entries`);
      }
      case "fetch_url": {
        if (typeof args.url !== "string" || !args.url) {
          throw { code: -32602, message: "url is required" };
        }
        try {
          const page = await fetchPageText(args.url);
          const body = page.text.length > 3000 ? page.text.slice(0, 3000) + "…[truncated]" : page.text;
          return text(`${page.title}\n${page.url}\n\n${body}`);
        } catch (err) {
          throw { code: -32603, message: err instanceof Error ? err.message : String(err) };
        }
      }
      case "rerank": {
        if (typeof args.query !== "string" || !args.query) {
          throw { code: -32602, message: "query is required" };
        }
        if (!Array.isArray(args.documents) || args.documents.length === 0) {
          throw { code: -32602, message: "documents (non-empty array) is required" };
        }
        const modelStr = typeof args.model === "string" && args.model ? args.model : "auto";
        const p = this.resolveMedia(modelStr);
        if (!p) return text("no providers connected");
        if (p.wireFormat !== "openai") {
          throw { code: -32602, message: `provider ${p.id} does not support rerank (openai wire required)` };
        }
        const out = await this.passthrough(p, "/rerank", {
          model: modelStr,
          query: args.query,
          documents: args.documents,
          top_n: args.top_n,
        });
        return text(`[${p.id}] ${out}`);
      }
      case "create_embeddings": {
        if (typeof args.input !== "string" || !args.input) {
          throw { code: -32602, message: "input is required" };
        }
        const modelStr = typeof args.model === "string" && args.model ? args.model : "auto";
        const p = this.resolveMedia(modelStr);
        if (!p) return text("no providers connected");
        if (p.wireFormat !== "openai") {
          throw { code: -32602, message: `provider ${p.id} does not support embeddings (openai wire required)` };
        }
        let input: unknown = args.input;
        try {
          const parsed = JSON.parse(args.input);
          if (Array.isArray(parsed)) input = parsed;
        } catch { /* plain string */ }
        const out = await this.passthrough(p, "/embeddings", { model: modelStr, input });
        return text(`[${p.id}] ${out}`);
      }
      case "budget_status": {
        const action = (process.env.BUDGET_ACTION ?? "warn").toLowerCase();
        return text(
          `budget action: ${action}\nthis MCP session spend: $${this.spendUsd.toFixed(6)}\n` +
            `per-key budgets + monthly spend are tracked by the gateway store (see /v1/me/status, /api/keys/:id/budget)`,
        );
      }
      case "replay_request": {
        if (typeof args.id !== "string" || !args.id) {
          throw { code: -32602, message: "id is required" };
        }
        const entry = this.requestLog.find((e) => e.id === args.id);
        if (!entry) {
          throw { code: -32602, message: `no logged request with id ${args.id} (this session only)` };
        }
        const started = Date.now();
        const r = await this.router.route({ model: entry.model, messages: entry.messages });
        const reply = r.response?.choices[0]?.message.content ?? "";
        const u = r.response?.usage;
        if (u) this.spendUsd += costUsd(r.providerId, r.model, u.prompt_tokens, u.completion_tokens);
        return text(
          `[replay of ${entry.id} · ${Date.now() - started}ms · ${r.providerId}/${r.model}${r.cached ? " · cached" : ""}] ${reply}`,
        );
      }
      default:
        throw { code: -32602, message: `unknown tool: ${name}` };
    }
  }

  /** JSON-RPC response envelope (null for notifications). */
  async dispatch(line: string): Promise<string | null> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      return null;
    }
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return null;
    try {
      const result = await this.handle(req);
      if (req.id == null || req.method.startsWith("notifications/")) return null;
      return JSON.stringify({ jsonrpc: "2.0", id: req.id, result });
    } catch (err: any) {
      if (req.id == null) return null;
      const e = err && typeof err.code === "number" ? err : { code: -32603, message: String(err?.message ?? err) };
      return JSON.stringify({ jsonrpc: "2.0", id: req.id, error: e });
    }
  }
}

export async function startMcp(): Promise<void> {
  loadConfig();
  try {
    for (const def of await detectLocalProviders()) registry.register(def);
  } catch {
    /* never blocks */
  }
  const server = new McpServer();
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      void server.dispatch(line).then((out) => {
        if (out) process.stdout.write(out + "\n");
      });
    }
  });
}
