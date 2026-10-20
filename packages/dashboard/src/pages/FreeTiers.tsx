import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type ProviderInfo } from "../api";

const LOCAL_IDS = ["ollama", "lmstudio", "lm-studio", "llamacpp", "llama.cpp", "local", "vllm", "textgen", "kobold"];

export default function FreeTiers() {
  const { t } = useLang();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.providers().then(setProviders).catch((e) => setError(String(e)));
  }, []);

  const local = providers.filter((p) => LOCAL_IDS.some((l) => p.id.toLowerCase().includes(l)));
  const rest = providers.filter((p) => !LOCAL_IDS.some((l) => p.id.toLowerCase().includes(l)));

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold">{t("nav.freeTiers")}</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Per-provider cost tiers are not exposed by the gateway API yet, so this page highlights
        what is verifiable: local providers (no API key, no cost) and live activity.
      </p>
      {error && <p className="mb-4 text-red-400">{error}</p>}

      <h2 className="mb-3 font-semibold">🏠 Local — always free ({local.length})</h2>
      {local.length === 0 ? (
        <p className="mb-6 text-sm text-zinc-500">
          No local providers connected. Run Ollama or LM Studio, then{" "}
          <code className="rounded bg-zinc-800 px-1 text-xs">llmswitch providers</code>{t("common.autoDetect")}</p>
      ) : (
        <div className="mb-6 grid gap-3 md:grid-cols-2">
          {local.map((p) => (
            <div key={p.id} className="rounded-xl border border-emerald-900 bg-emerald-950/30 p-4">
              <span className="font-semibold">{p.name}</span>
              <span className="ml-2 rounded bg-emerald-900 px-1.5 py-0.5 text-xs text-emerald-300">$0</span>
              <p className="mt-1 text-xs text-zinc-400">{p.models.length} models · runs on your machine</p>
            </div>
          ))}
        </div>
      )}

      <h2 className="mb-3 font-semibold">☁️ Cloud providers ({rest.length})</h2>
      <p className="mb-3 text-xs text-zinc-600">
        Sorted by error rate (lowest first). For real cost comparison run{" "}
        <code className="rounded bg-zinc-800 px-1">llmswitch bench</code>{t("common.checkCostsPage")}</p>
      <div className="space-y-2">
        {[...rest]
          .sort((a, b) => {
            const ea = a.stats.calls ? a.stats.errors / a.stats.calls : 0;
            const eb = b.stats.calls ? b.stats.errors / b.stats.calls : 0;
            return ea - eb;
          })
          .map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5"
            >
              <div>
                <span className="text-sm font-medium">{p.name}</span>
                <span className="ml-2 text-xs text-zinc-500">{p.models.length} models</span>
              </div>
              <span className="text-xs text-zinc-500">
                {p.stats.calls} calls · <span className="text-red-400">{p.stats.errors} errors</span>
              </span>
            </div>
          ))}
        {rest.length === 0 && !error && (
          <p className="text-sm text-zinc-500">{t("common.noCloud")}</p>
        )}
      </div>
    </div>
  );
}
