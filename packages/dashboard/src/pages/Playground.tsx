import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type FanoutResult, type ProviderInfo } from "../api";

export default function Playground() {
  const { t } = useLang();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("Explain recursion in one sentence.");
  const [results, setResults] = useState<FanoutResult[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.providers().then((ps) => {
      setProviders(ps);
      setSelected(ps.slice(0, 2).map((p) => p.id));
    }).catch((e) => setError(String(e)));
  }, []);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const run = async () => {
    setRunning(true);
    setError("");
    try {
      const r = await api.playground([{ role: "user", content: prompt }], selected);
      setResults(r.results);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.playground")}</h1>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        className="w-full rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-sm"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {providers.map((p) => (
          <label key={p.id} className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm">
            <input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggle(p.id)} />
            {p.name}
          </label>
        ))}
      </div>
      <button
        onClick={run}
        disabled={running || selected.length === 0}
        className="mt-3 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
      >
        {running ? t("common.running") : t("playground.compareModels", { n: selected.length })}
      </button>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {results.map((r) => (
          <div key={r.providerId} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{r.providerId}</h2>
              <span className={`text-xs ${r.ok ? "text-emerald-400" : "text-red-400"}`}>
                {r.ok ? `${r.latencyMs}ms` : "failed"}
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-500">{r.model}</p>
            <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-200">
              {r.ok ? r.text : r.error}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
