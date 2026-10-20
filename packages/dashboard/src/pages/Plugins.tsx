import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type ProviderInfo } from "../api";

export default function Plugins() {
  const { t } = useLang();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.providers().then(setProviders).catch((e) => setError(String(e)));
  }, []);

  const manifest = {
    gateway: "llmswitch",
    format: "generic",
    endpoints: {
      chatCompletions: "/v1/chat/completions",
      responses: "/v1/responses",
      models: "/v1/models",
      embeddings: "/v1/embeddings",
    },
    auth: { header: "Authorization", scheme: "Bearer", note: "use your llmswitch API key" },
    providers: providers.map((p) => ({
      id: p.id,
      name: p.name,
      models: p.models,
      defaultModel: p.defaultModel,
      wireFormat: p.wireFormat,
    })),
  };
  const manifestJson = JSON.stringify(manifest, null, 2);

  const copy = async () => {
    await navigator.clipboard.writeText(manifestJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.plugins")}</h1>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <p className="mb-4 text-sm text-zinc-500">{t("plugins.every_connected_provider_is_exposed_as_a")}<code className="rounded bg-zinc-800 px-1">POST /v1/provider-plugin-manifest</code>{" "}
        (which also supports <code className="rounded bg-zinc-800 px-1">{"{ format: \"cline\" | \"cursor\" }"}</code> via gateway key).
      </p>
      <div className="mb-6 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {providers.map((p) => (
          <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-semibold">🔌 {p.name}</span>
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{p.wireFormat}</span>
            </div>
            <p className="font-mono text-xs text-zinc-500">{p.id}</p>
            <p className="mt-1 text-xs text-zinc-400">{p.models.length} models · default {p.defaultModel || "—"}</p>
          </div>
        ))}
        {providers.length === 0 && !error && <p className="text-sm text-zinc-500">{t("common.loading")}</p>}
      </div>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">Manifest JSON (live preview)</h2>
          <button onClick={copy} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800">
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
        <pre className="max-h-96 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-300">{manifestJson}</pre>
        <p className="mt-2 text-xs text-zinc-500">
          Fetch the authoritative version:{" "}
          <code className="rounded bg-zinc-800 px-1">curl -X POST localhost:6000/v1/provider-plugin-manifest -H "Authorization: Bearer $KEY" -d '{"{"}"format":"cursor"{"}"}'</code>
        </p>
      </div>
    </div>
  );
}
