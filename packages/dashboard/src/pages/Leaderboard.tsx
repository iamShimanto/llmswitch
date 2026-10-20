import { useEffect, useMemo, useState } from "react";
import { useLang } from "../i18n";
import { api, type ProviderInfo } from "../api";

type SortKey = "reliability" | "latency" | "calls";

interface Row {
  id: string;
  name: string;
  calls: number;
  errors: number;
  avgLatency: number | null;
  reliability: number | null;
}

export default function Leaderboard() {
  const { t } = useLang();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<SortKey>("reliability");

  const load = () => {
    api.providers().then(setProviders).catch((e) => setError(String(e)));
  };
  useEffect(load, []);

  const rows: Row[] = useMemo(() => {
    const rs = providers.map((p) => ({
      id: p.id,
      name: p.name,
      calls: p.stats.calls,
      errors: p.stats.errors,
      avgLatency: p.stats.calls > 0 ? p.stats.totalLatencyMs / p.stats.calls : null,
      reliability: p.stats.calls > 0 ? 1 - p.stats.errors / p.stats.calls : null,
    }));
    const by: Record<SortKey, (a: Row, b: Row) => number> = {
      reliability: (a, b) => (b.reliability ?? -1) - (a.reliability ?? -1),
      latency: (a, b) => (a.avgLatency ?? Infinity) - (b.avgLatency ?? Infinity),
      calls: (a, b) => b.calls - a.calls,
    };
    return rs.sort(by[sort]);
  }, [providers, sort]);

  const medal = (i: number) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("nav.leaderboard")}</h1>
        <div className="flex items-center gap-2">
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm"
          >
            <option value="reliability">{t("common.sortReliability")}</option>
            <option value="latency">{t("common.sortLatency")}</option>
            <option value="calls">{t("common.sortCalls")}</option>
          </select>
          <button
            onClick={load}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
          >{t("common.refresh")}</button>
        </div>
      </div>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <p className="mb-4 text-sm text-zinc-500">
        Live router stats since gateway boot. Reliability = 1 − errors/calls. Cost ranking lives on
        the Costs page.
      </p>
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-900 text-left text-zinc-400">
              <th className="px-4 py-2">#</th>
              <th className="px-4 py-2">{t("common.provider")}</th>
              <th className="px-4 py-2 text-right">{t("leaderboard.reliability")}</th>
              <th className="px-4 py-2 text-right">{t("common.avgLatency")}</th>
              <th className="px-4 py-2 text-right">{t("common.calls")}</th>
              <th className="px-4 py-2 text-right">{t("common.errors")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className="border-t border-zinc-800 hover:bg-zinc-900/50">
                <td className="px-4 py-2">{medal(i)}</td>
                <td className="px-4 py-2 font-medium">{r.name}</td>
                <td className="px-4 py-2 text-right">
                  {r.reliability == null ? (
                    <span className="text-zinc-600">—</span>
                  ) : (
                    <span className={r.reliability >= 0.99 ? "text-emerald-400" : r.reliability >= 0.95 ? "text-amber-400" : "text-red-400"}>
                      {(r.reliability * 100).toFixed(1)}%
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  {r.avgLatency == null ? <span className="text-zinc-600">—</span> : `${Math.round(r.avgLatency)} ms`}
                </td>
                <td className="px-4 py-2 text-right">{r.calls}</td>
                <td className="px-4 py-2 text-right text-red-400">{r.errors}</td>
              </tr>
            ))}
            {rows.length === 0 && !error && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-zinc-500">{t("common.noProviders")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
