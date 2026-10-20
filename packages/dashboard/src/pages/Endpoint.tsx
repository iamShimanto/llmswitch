import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type EndpointInfo } from "../api";

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="shrink-0 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs hover:bg-zinc-800"
      title="Copy"
    >
      {done ? "✓ Copied" : (label ?? "⧉ Copy")}
    </button>
  );
}

const GROUP_ICONS: Record<string, string> = {
  "Core APIs": "🕸️",
  "Media & Multi-modal": "🖼️",
  "Search & Discovery": "🔭",
  "Utility & Management": "🛠️",
};
const EP_ICONS: Record<string, string> = {
  "Chat Completions": "💬",
  Responses: "⌨️",
  "Completions (Legacy)": "Tt",
  Messages: "🧠",
  Embeddings: "[ ]",
  "Image Generation": "🖼️",
  "Image Edits": "✏️",
  "Audio Transcription": "🎙️",
  "Text to Speech": "🗣️",
  "Music Generation": "🎵",
  "Video Generation": "🎬",
  "Web Search": "🔍",
  Rerank: "↕️",
  Moderations: "🛡️",
  "Batch API": "🗂️",
  "Files API": "📁",
  "List Models": "☰",
};

export default function Endpoint() {
  const { t } = useLang();
  const [info, setInfo] = useState<EndpointInfo | null>(null);
  const [tab, setTab] = useState<"apis" | "mcp">("apis");
  const [healthy, setHealthy] = useState<boolean | null>(null);

  const [gspOn, setGspOn] = useState(false);
  const [gspText, setGspText] = useState("");
  const [gspMsg, setGspMsg] = useState("");

  const [vsKey, setVsKey] = useState("");

  const origin = window.location.origin;
  const publicBase = `${origin}/v1`;

  useEffect(() => {
    api.endpointInfo().then(setInfo).catch(() => {});
    api.health().then(() => setHealthy(true)).catch(() => setHealthy(false));
    api
      .getConfig()
      .then((c) => {
        setGspOn(c.global_system_prompt_enabled.value);
        setGspText(c.global_system_prompt.value);
      })
      .catch(() => {});
  }, []);

  const saveGsp = async () => {
    await api
      .putConfig({ global_system_prompt: gspText, global_system_prompt_enabled: gspOn })
      .catch(() => {});
    setGspMsg("Saved — applies to every new chat request.");
  };

  const groups = new Map<string, NonNullable<EndpointInfo["endpoints"]>>();
  for (const e of info?.endpoints ?? []) {
    const list = groups.get(e.group) ?? [];
    list.push(e);
    groups.set(e.group, list);
  }

  const mcpSnippet = JSON.stringify(
    {
      mcpServers: {
        llmswitch: {
          command: "npx",
          args: ["-y", "llmswitch", "mcp"],
          env: { LLMSWITCH_URL: origin, LLMSWITCH_API_KEY: "<your gateway key>" },
        },
      },
    },
    null,
    2,
  );

  const card = "rounded-xl border border-zinc-800 bg-zinc-900 p-4";

  return (
    <div>
      <p className="mb-1 text-xs text-zinc-500">
        Dashboard › <span className="text-zinc-300">Endpoint</span>
      </p>
      <h1 className="mb-2 text-2xl font-bold">API Endpoint</h1>
      <p className="mb-4 text-sm text-zinc-400">
        Use the OpenAI-compatible endpoint with most SDKs and tools.
      </p>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <code className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-amber-200">
          {publicBase}
        </code>
        <CopyBtn text={publicBase} />
        <button
          onClick={() => {
            window.location.hash = "#/playground";
          }}
          className="text-sm text-sky-400 hover:text-sky-300"
        >
          Test endpoint →
        </button>
        <span className="text-xs text-zinc-500">Advanced protocols</span>
      </div>

      <div className="mb-5 flex gap-1.5">
        {(
          [
            ["apis", "🔷 APIs"],
            ["mcp", "🧩 MCP"],
          ] as Array<["apis" | "mcp", string]>
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-full border px-4 py-1.5 text-sm ${
              tab === id
                ? "border-amber-600/60 bg-amber-950/40 font-semibold text-amber-200"
                : "border-zinc-800 text-zinc-400 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "mcp" ? (
        <div className={card}>
          <h2 className="mb-1 font-semibold">MCP server</h2>
          <p className="mb-3 text-sm text-zinc-400">
            LLMSwitch ships an MCP server (17 tools: routing, providers, usage, combos…) over
            stdio. Add this to Claude Code / Cursor / your MCP client:
          </p>
          <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-300">
            {mcpSnippet}
          </pre>
          <div className="mt-3">
            <CopyBtn text={mcpSnippet} label="⧉ Copy config" />
          </div>
          <p className="mt-3 text-xs text-zinc-500">
            More detail and a live tool browser live on the <b>MCP</b> page under Tools.
          </p>
        </div>
      ) : (
        <>
          <div className={`${card} mb-4`}>
            <h2 className="mb-3 font-semibold">API Endpoint</h2>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-red-400">
              Active endpoints
            </p>
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                <span className="w-14 text-sm text-zinc-400">Public</span>
                <code className="min-w-0 flex-1 truncate font-mono text-sm">{publicBase}</code>
                <CopyBtn text={publicBase} />
              </div>
              <div className="flex items-center gap-3">
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                <span className="w-14 text-sm text-zinc-400">Local</span>
                <code className="min-w-0 flex-1 truncate font-mono text-sm">
                  http://localhost:{info?.port ?? 6000}/v1
                </code>
                <CopyBtn text={`http://localhost:${info?.port ?? 6000}/v1`} />
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-3">
              <span className="text-sm font-medium">🖥️ Local Server</span>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  healthy ? "bg-emerald-900 text-emerald-300" : "bg-zinc-800 text-zinc-400"
                }`}
              >
                ● {healthy == null ? "Checking…" : healthy ? "Running" : "Unreachable"}
              </span>
              <span className="text-xs text-zinc-500">
                {info ? `${info.connectedProviders} providers connected · v${info.version}` : ""}
              </span>
            </div>
            <p className="mt-3 text-xs text-zinc-500">
              Remote access: this gateway answers on the public URL above. For a local-only
              install, point any tunnel (Cloudflare Tunnel, ngrok, Tailscale) at{" "}
              <code className="rounded bg-zinc-800 px-1">localhost:{info?.port ?? 6000}</code>.
            </p>
          </div>

          <div className={`${card} mb-6`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold">Custom System Prompt</h2>
                <p className="mt-1 text-sm text-zinc-400">
                  Inject a custom system prompt into every model request.
                </p>
              </div>
              <button
                onClick={() => setGspOn((v) => !v)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${gspOn ? "bg-emerald-600" : "bg-zinc-700"}`}
                aria-label="Toggle custom system prompt"
              >
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${gspOn ? "left-[22px]" : "left-0.5"}`} />
              </button>
            </div>
            {gspOn && (
              <>
                <textarea
                  value={gspText}
                  onChange={(e) => setGspText(e.target.value)}
                  rows={3}
                  placeholder="You are a helpful assistant…"
                  className="mt-3 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={saveGsp}
                    className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium hover:bg-emerald-500"
                  >
                    Save
                  </button>
                  {gspMsg && <span className="text-xs text-emerald-400">{gspMsg}</span>}
                </div>
              </>
            )}
            {!gspOn && gspText && (
              <p className="mt-2 text-xs text-zinc-500">A prompt is saved but the toggle is off.</p>
            )}
          </div>

          <h2 className="text-xl font-bold">Available Endpoints</h2>
          <p className="mb-4 text-sm text-zinc-500">
            {info
              ? `${info.totalModels.toLocaleString()} models across ${info.endpointCount} endpoints`
              : "Loading…"}
          </p>
          {[...groups.entries()].map(([group, eps]) => (
            <div key={group} className="mb-6">
              <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                <span>{GROUP_ICONS[group] ?? "•"}</span> {group}
                <span className="h-px flex-1 bg-zinc-800" />
              </h3>
              <div className="grid gap-3 md:grid-cols-2">
                {eps.map((e) => (
                  <div key={e.path} className="rounded-xl border border-zinc-800 bg-zinc-900 p-3.5">
                    <div className="flex items-start gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-base">
                        {EP_ICONS[e.name] ?? "•"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 font-medium">
                          {e.name}
                          {e.tag && (
                            <span className="rounded bg-zinc-800 px-1.5 py-px text-[10px] font-semibold text-zinc-400">
                              {e.tag}
                            </span>
                          )}
                        </p>
                        <p className="text-sm text-zinc-500">
                          {e.models != null ? `${e.models.toLocaleString()} models` : (e.note ?? "—")}
                        </p>
                      </div>
                      <CopyBtn text={e.path} />
                    </div>
                    <p className="mt-2 truncate font-mono text-xs text-zinc-500">{e.path}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="rounded-xl border border-sky-900/60 bg-sky-950/20 p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-sky-300">
                VS Code Token Alias
              </h3>
              <span className="text-xs text-zinc-500">CLI Tools</span>
            </div>
            <p className="mt-1 text-sm text-zinc-400">
              Ready-to-paste compatibility URL using the{" "}
              <code className="rounded bg-zinc-800 px-1">/api/v1/vscode/TOKEN/…</code> endpoint —
              for tools that cannot set an Authorization header. Paste your gateway key to build
              yours:
            </p>
            <input
              value={vsKey}
              onChange={(e) => setVsKey(e.target.value)}
              placeholder="Gateway key (llmswitch_…)"
              className="mt-3 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs"
            />
            <div className="mt-2 flex items-center gap-2">
              <span className="w-24 shrink-0 text-sm text-zinc-400">VS Code base</span>
              <code className="min-w-0 flex-1 truncate rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs">
                {origin}/api/v1/vscode/{vsKey.trim() || "TOKEN"}
              </code>
              <CopyBtn text={`${origin}/api/v1/vscode/${vsKey.trim() || "TOKEN"}`} />
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              Treat the alias URL like the key itself — anyone with it can call your gateway.
            </p>
          </div>

          <p className="mt-4 text-xs text-zinc-600">{t("nav.endpoint")} · LLMSwitch</p>
        </>
      )}
    </div>
  );
}
