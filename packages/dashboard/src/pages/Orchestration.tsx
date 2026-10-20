import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type FanoutResult, type ProviderInfo } from "../api";

export default function Orchestration() {
  const { t } = useLang();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("Write a haiku about load balancers.");
  const [system, setSystem] = useState("");
  const [results, setResults] = useState<FanoutResult[]>([]);
  const [running, setRunning] = useState(false);
  const [winner, setWinner] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.providers().then((ps) => {
      setProviders(ps);
      setSelected(ps.slice(0, 3).map((p) => p.id));
    }).catch((e) => setError(String(e)));
  }, []);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const run = async () => {
    setRunning(true);
    setError("");
    setWinner(null);
    try {
      const messages = [
        ...(system.trim() ? [{ role: "system", content: system.trim() }] : []),
        { role: "user", content: prompt },
      ];
      const r = await api.playground(messages, selected);
      const sorted = [...r.results].sort((a, b) => a.latencyMs - b.latencyMs);
      setResults(sorted);
      const fastest = sorted.find((x) => x.ok);
      if (fastest) setWinner(fastest.providerId);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold">{t("nav.orchestration")}</h1>
      <p className="mb-6 text-sm text-zinc-500">{t("common.orchestrationDesc")}</p>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <input
        value={system}
        onChange={(e) => setSystem(e.target.value)}
        placeholder="System prompt (optional)"
        className="mb-2 w-full rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-sm"
      />
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
        {running ? t("common.fanningOut") : t("orchestration.fanOutTo", { n: selected.length })}
      </button>

      {winner && (
        <p className="mt-4 text-sm text-emerald-400">🏆 Fastest successful: {winner}</p>
      )}
      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {results.map((r, i) => (
          <div
            key={r.providerId}
            className={`rounded-xl border p-4 ${r.providerId === winner ? "border-emerald-600 bg-emerald-950/30" : "border-zinc-800 bg-zinc-900"}`}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">
                <span className="mr-2 text-xs text-zinc-500">#{i + 1}</span>
                {r.providerId}
              </h2>
              <span className={`text-xs ${r.ok ? "text-emerald-400" : "text-red-400"}`}>
                {r.ok ? `${r.latencyMs}ms` : "failed"}
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-500">{r.model}</p>
            <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-200">
              {r.ok ? r.text : r.error}
            </p>
            {r.ok && r.text && (
              <button
                onClick={() => navigator.clipboard.writeText(r.text!).catch(() => {})}
                className="mt-2 rounded-lg border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
              >{t("common.copyResponse")}</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
