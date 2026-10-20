import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type DailyUsageRow, type InspectEntry } from "../api";
import { Tabs, TabEmpty } from "../components/Tabs";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

function Overview({ days }: { days: number }) {
  const { t } = useLang();
  const [daily, setDaily] = useState<DailyUsageRow[]>([]);
  const [entries, setEntries] = useState<InspectEntry[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.usageDaily(days).then((r) => setDaily(r.days)).catch((e) => setError(String(e)));
    api.inspector().then(setEntries).catch(() => {});
  }, [days]);

  const maxReq = Math.max(1, ...daily.map((d) => d.requests));
  const maxCost = Math.max(0.000001, ...daily.map((d) => d.costUsd));

  const byProvider = new Map<string, number[]>();
  for (const e of entries) {
    if (e.status !== "ok") continue;
    const arr = byProvider.get(e.provider) ?? [];
    arr.push(e.latencyMs);
    byProvider.set(e.provider, arr);
  }
  const latency = [...byProvider.entries()]
    .map(([provider, arr]) => {
      const s = [...arr].sort((a, b) => a - b);
      return { provider, n: s.length, p50: percentile(s, 50), p95: percentile(s, 95) };
    })
    .sort((a, b) => b.n - a.n);

  const W = 600, H = 140, P = 24;
  const pts = daily.map((d, i) => {
    const x = daily.length <= 1 ? W / 2 : P + (i / (daily.length - 1)) * (W - 2 * P);
    const y = H - P - (d.costUsd / maxCost) * (H - 2 * P);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <div>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <h2 className="mb-3 font-semibold">{t("common.requestsPerDay")}</h2>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        {daily.length === 0 && <p className="text-sm text-zinc-500">{t("common.noData")}</p>}
        <div className="flex h-36 items-end gap-[3px]">
          {daily.map((d) => (
            <div
              key={d.day}
              title={`${d.day}: ${d.requests} req, ${d.errors} err`}
              className="min-w-[4px] flex-1 rounded-t bg-sky-600/80 hover:bg-sky-500"
              style={{ height: `${Math.max(2, (d.requests / maxReq) * 100)}%` }}
            />
          ))}
        </div>
        <div className="mt-2 flex justify-between text-xs text-zinc-500">
          <span>{daily[0]?.day}</span>
          <span>max {maxReq}/day</span>
          <span>{daily[daily.length - 1]?.day}</span>
        </div>
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Cost / day (USD)</h2>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        {daily.length === 0 ? (
          <p className="text-sm text-zinc-500">{t("common.noData")}</p>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
            <polyline points={pts.join(" ")} fill="none" stroke="#34d399" strokeWidth="2" />
            {daily.map((d, i) => {
              const [x, y] = pts[i].split(",").map(Number);
              return (
                <circle key={d.day} cx={x} cy={y} r="2.5" fill="#34d399">
                  <title>{`${d.day}: $${d.costUsd.toFixed(4)}`}</title>
                </circle>
              );
            })}
          </svg>
        )}
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Latency by provider (recent requests)</h2>
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-zinc-400">
            <tr>
              <th className="p-3">{t("common.provider")}</th>
              <th className="p-3 text-right">{t("common.samples")}</th>
              <th className="p-3 text-right">p50</th>
              <th className="p-3 text-right">p95</th>
            </tr>
          </thead>
          <tbody>
            {latency.map((l) => (
              <tr key={l.provider} className="border-t border-zinc-800">
                <td className="p-3">{l.provider}</td>
                <td className="p-3 text-right">{l.n}</td>
                <td className="p-3 text-right">{l.p50.toFixed(0)} ms</td>
                <td className="p-3 text-right">{l.p95.toFixed(0)} ms</td>
              </tr>
            ))}
            {latency.length === 0 && (
              <tr>
                <td colSpan={4} className="p-6 text-center text-zinc-500">{t("common.noRecentRequests")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Utilization() {
  const { t } = useLang();
  const [entries, setEntries] = useState<InspectEntry[]>([]);
  useEffect(() => {
    api.inspector().then(setEntries).catch(() => {});
  }, []);
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.provider, (counts.get(e.provider) ?? 0) + 1);
  const total = Math.max(1, entries.length);
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return (
    <div>
      <p className="mb-4 text-sm text-zinc-500">Share of recent requests per provider (inspector buffer).</p>
      {rows.length === 0 ? (
        <TabEmpty>{t("analytics.noRequests")}</TabEmpty>
      ) : (
        <div className="space-y-3">
          {rows.map(([p, n]) => (
            <div key={p} className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
              <div className="mb-1 flex justify-between text-sm">
                <span className="font-medium">{p}</span>
                <span className="text-zinc-400">{n} req · {((n / total) * 100).toFixed(1)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                <div className="h-full rounded-full bg-sky-500" style={{ width: `${(n / total) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Analytics() {
  const { t } = useLang();
  const [tab, setTab] = useState("overview");
  const [days, setDays] = useState(30);
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("nav.analytics")}</h1>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
        >
          {[7, 14, 30, 60, 90].map((d) => (
            <option key={d} value={d}>last {d} days</option>
          ))}
        </select>
      </div>
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "utilization", label: "Utilization" },
          { id: "compression", label: "Compression" },
          { id: "search", label: "Search" },
          { id: "combos", label: "Combo Health" },
          { id: "evals", label: "Evals" },
        ]}
      />
      {tab === "overview" && <Overview days={days} />}
      {tab === "utilization" && <Utilization />}
      {tab === "compression" && (
        <TabEmpty>
          Compression savings are not tracked per-request yet. Use the{" "}
          <span className="font-medium text-zinc-200">{t("analytics.compressionStudio")}</span>{t("analytics.previewSavings")}</TabEmpty>
      )}
      {tab === "search" && (
        <TabEmpty>
          Web-search usage is not tracked separately yet. Search calls appear in the inspector
          like any other request.
        </TabEmpty>
      )}
      {tab === "combos" && (
        <TabEmpty>
          Combos run client-side from your browser (saved in localStorage), so the gateway has no
          combo health telemetry. Build and test combos on the{" "}
          <span className="font-medium text-zinc-200">{t("nav.combos")}</span>{t("analytics.pageFrag")}</TabEmpty>
      )}
      {tab === "evals" && (
        <TabEmpty>
          Model evaluations are not implemented yet. Compare models side-by-side on the{" "}
          <span className="font-medium text-zinc-200">{t("nav.playground")}</span>{t("analytics.pageFrag")}</TabEmpty>
      )}
    </div>
  );
}
