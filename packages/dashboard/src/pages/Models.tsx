import { useEffect, useMemo, useState } from "react";
import { useLang } from "../i18n";
import { api, type ProviderInfo } from "../api";

interface ModelRow {
  model: string;
  providerId: string;
  providerName: string;
  isDefault: boolean;
}

export default function Models() {
  const { t } = useLang();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("");

  useEffect(() => {
    api.providers().then(setProviders).catch((e) => setError(String(e)));
  }, []);

  const rows: ModelRow[] = useMemo(() => {
    const out: ModelRow[] = [];
    for (const p of providers) {
      for (const m of p.models) {
        out.push({ model: m, providerId: p.id, providerName: p.name, isDefault: m === p.defaultModel });
      }
    }
    const q = query.trim().toLowerCase();
    return out
      .filter((r) => (!q || r.model.toLowerCase().includes(q)) && (!providerFilter || r.providerId === providerFilter))
      .slice(0, 500);
  }, [providers, query, providerFilter]);

  const total = useMemo(() => providers.reduce((n, p) => n + p.models.length, 0), [providers]);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.models")}<span className="text-base font-normal text-zinc-500">{total.toLocaleString()} across {providers.length} providers</span>
      </h1>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <div className="mb-4 flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models… (e.g. gpt-4o, claude)"
          className="min-w-64 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
        />
        <select
          value={providerFilter}
          onChange={(e) => setProviderFilter(e.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
        >
          <option value="">{t("models.all_providers")}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      <p className="mb-2 text-xs text-zinc-500">{t("common.showingMatches")}<code className="rounded bg-zinc-800 px-1">provider:model</code>{t("common.chaosHint2")}</p>
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-900 text-left text-zinc-400">
              <th className="px-4 py-2">{t("common.model")}</th>
              <th className="px-4 py-2">{t("common.provider")}</th>
              <th className="px-4 py-2">{t("common.address")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.providerId}:${r.model}:${i}`} className="border-t border-zinc-800 hover:bg-zinc-900/50">
                <td className="px-4 py-2 font-mono text-[13px]">
                  {r.model} {r.isDefault && <span className="ml-1 rounded bg-sky-900 px-1.5 py-0.5 text-[10px] text-sky-300">{t("common.default")}</span>}
                </td>
                <td className="px-4 py-2 text-zinc-400">{r.providerName}</td>
                <td className="px-4 py-2 font-mono text-[13px] text-zinc-500">{r.providerId}:{r.model}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-zinc-500">
                  {providers.length === 0 && !error ? "Loading…" : "No matches."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
