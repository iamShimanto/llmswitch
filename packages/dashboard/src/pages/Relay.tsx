import { useLang } from "../i18n";
const ENDPOINTS = [
  { method: "POST", path: "/v1/chat/completions", note: "Main chat endpoint — routing, fallback, cache, billing all apply." },
  { method: "POST", path: "/v1/responses", note: "Responses API dialect (SSE or JSON)." },
  { method: "POST", path: "/v1/completions", note: "Legacy completions." },
  { method: "POST", path: "/v1/embeddings", note: "Embeddings." },
  { method: "POST", path: "/v1/rerank", note: "Reranking." },
  { method: "POST", path: "/v1/images/generations", note: "Image generation → media-capable providers." },
  { method: "POST", path: "/v1/audio/speech", note: "Text-to-speech." },
  { method: "POST", path: "/v1/videos/generations", note: "Video generation → media-capable providers." },
  { method: "POST", path: "/v1/search", note: "Web search (Tavily/Brave)." },
  { method: "POST", path: "/v1/web/fetch", note: "URL → text (SSRF-guarded)." },
  { method: "POST", path: "/v1/web/map", note: "URL → link map." },
  { method: "GET", path: "/v1/models", note: "Aggregated model list." },
];

export default function Relay() {
  const { t } = useLang();
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.relay")}</h1>
      <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm leading-relaxed text-zinc-300">
        <p className="mb-2">{t("common.llmswitchIsA")}<span className="font-semibold">{t("common.smartRelay")}</span>: every request below is
          routed through provider selection (20 strategies), fallback chains, prompt cache,
          compression, cost accounting and audit logging — then relayed to the chosen upstream.
        </p>
        <p className="text-zinc-400">
          Relay is passthrough-only: the gateway never trains on, stores, or alters your prompts
          beyond the transforms you enable (compression, PII redaction). There is no separate
          "relay mode" to configure.
        </p>
      </div>
      <h2 className="mb-3 font-semibold">{t("common.relayedEndpoints")}</h2>
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-900 text-left text-zinc-400">
              <th className="px-4 py-2">{t("common.method")}</th>
              <th className="px-4 py-2">{t("common.path")}</th>
              <th className="px-4 py-2">{t("common.notes")}</th>
            </tr>
          </thead>
          <tbody>
            {ENDPOINTS.map((e) => (
              <tr key={e.path} className="border-t border-zinc-800 hover:bg-zinc-900/50">
                <td className="px-4 py-2"><span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs">{e.method}</span></td>
                <td className="px-4 py-2 font-mono text-[13px]">{e.path}</td>
                <td className="px-4 py-2 text-zinc-400">{e.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs text-zinc-500">{t("common.auth")}<code className="rounded bg-zinc-800 px-1">Authorization: Bearer &lt;llmswitch API key&gt;</code>{t("common.mgmtEndpoints")}<code className="rounded bg-zinc-800 px-1">/api/*</code> (admin key).
      </p>
    </div>
  );
}
