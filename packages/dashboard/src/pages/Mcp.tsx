import { useState } from "react";
import { useLang } from "../i18n";

interface Tool {
  name: string;
  desc: string;
}

// Mirrors the 17 tools in packages/core/src/mcp/server.ts
const TOOLS: Tool[] = [
  { name: "chat", desc: "One-shot chat through the router (any model or auto)." },
  { name: "list_providers", desc: "List connected providers and their models." },
  { name: "compress", desc: "Compress a prompt with caveman / rtk / stacked." },
  { name: "pick_fastest_model", desc: "Benchmark connected providers, return the fastest model." },
  { name: "get_stats", desc: "Router stats: calls, errors, latency per provider." },
  { name: "web_search", desc: "Web search via the configured search provider." },
  { name: "discover_models", desc: "Search provider model catalogs by query." },
  { name: "estimate_cost", desc: "Estimate USD cost for a prompt without sending it." },
  { name: "explain_routing", desc: "Explain why a provider was picked for a request." },
  { name: "check_quota", desc: "Quota status for a provider." },
  { name: "cache_stats", desc: "Prompt-cache entries, hits, misses, hit rate." },
  { name: "clear_cache", desc: "Clear the prompt cache (requires confirm: true)." },
  { name: "fetch_url", desc: "Fetch a URL as text (SSRF-guarded)." },
  { name: "rerank", desc: "Rerank documents against a query." },
  { name: "create_embeddings", desc: "Create embeddings for text." },
  { name: "budget_status", desc: "Budget caps and spend status." },
  { name: "replay_request", desc: "Replay a logged inspector request by id." },
];

const CLAUDE_CONFIG = `{
  "mcpServers": {
    "llmswitch": {
      "command": "llmswitch",
      "args": ["mcp"]
    }
  }
}`;

export default function Mcp() {
  const { t } = useLang();
  const [copied, setCopied] = useState("");

  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 2000);
  };

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("common.mcpServer")}</h1>
      <p className="mb-4 text-sm text-zinc-500">
        The gateway exposes its router, cache, billing and search as MCP tools over stdio.
        Connect any MCP client (Claude Desktop, Cursor, …) to use LLMSwitch as a tool backend.
      </p>
      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="mb-2 font-semibold">{t("common.connection")}</h2>
          <p className="mb-2 text-sm text-zinc-400">Stdio command:</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-lg bg-zinc-950 px-3 py-2 text-sm">llmswitch mcp</code>
            <button
              onClick={() => copy("llmswitch mcp", "cmd")}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800"
            >
              {copied === "cmd" ? "Copied ✓" : "Copy"}
            </button>
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="mb-2 font-semibold">Claude Desktop config</h2>
          <pre className="mb-2 overflow-x-auto rounded-lg bg-zinc-950 p-3 text-xs">{CLAUDE_CONFIG}</pre>
          <button
            onClick={() => copy(CLAUDE_CONFIG, "cfg")}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800"
          >
            {copied === "cfg" ? "Copied ✓" : "Copy JSON"}
          </button>
        </div>
      </div>
      <h2 className="mb-3 font-semibold">Tools ({TOOLS.length})</h2>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {TOOLS.map((t) => (
          <div key={t.name} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <code className="text-sm font-semibold text-sky-300">{t.name}</code>
            <p className="mt-1 text-sm text-zinc-400">{t.desc}</p>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-zinc-500">
        Note: there is no HTTP test-call endpoint — MCP is stdio-only. Exercise tools from an MCP
        client or the core vitest suite (25/25 MCP tests pass).
      </p>
    </div>
  );
}
