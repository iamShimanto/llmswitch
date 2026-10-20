import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type ProviderInfo } from "../api";

export default function Discovery() {
  const { t } = useLang();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [found, setFound] = useState<Record<string, string[]>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = () => {
    api.providers().then(setProviders).catch((e) => setError(String(e)));
  };
  useEffect(load, []);

  const discover = async (id: string) => {
    setRunning(id);
    setError("");
    try {
      const r = await api.discover(id);
      setFound((f) => ({ ...f, [id]: r.models }));
    } catch (e) {
      setError(`${id}: ${String(e)}`);
    } finally {
      setRunning(null);
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("common.modelDiscovery")}</h1>
        <button
          onClick={load}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
        >{t("common.refresh")}</button>
      </div>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <p className="mb-4 text-sm text-zinc-500">{t("common.queryProvider")}<code className="rounded bg-zinc-800 px-1 text-xs">/v1/models</code>{t("common.discoverHint")}</p>
      <div className="space-y-3">
        {providers.map((p) => (
          <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-semibold">{p.name}</span>
                <span className="ml-2 text-xs text-zinc-500">{p.models.length} catalog models</span>
              </div>
              <button
                onClick={() => discover(p.id)}
                disabled={running !== null}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
              >
                {running === p.id ? "Discovering…" : "Discover"}
              </button>
            </div>
            {found[p.id] && (
              <div className="mt-3">
                <p className="mb-1 text-xs text-zinc-500">
                  Discovered {found[p.id].length} model{found[p.id].length === 1 ? "" : "s"}:
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {found[p.id].map((m) => (
                    <span key={m} className="rounded-lg bg-zinc-800 px-2 py-1 font-mono text-xs text-zinc-300">
                      {m}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
        {providers.length === 0 && !error && (
          <p className="text-sm text-zinc-500">{t("common.noProviders")}</p>
        )}
      </div>
    </div>
  );
}
