import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type AnalyticsSummary, type InspectEntry, type KeyRecord } from "../api";
import { Tabs, TabEmpty } from "../components/Tabs";

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const RANGES = [
  { id: 1, label: "1D" },
  { id: 7, label: "7D" },
  { id: 30, label: "30D" },
  { id: 90, label: "90D" },
  { id: 3650, label: "All" },
];

function KpiCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`mt-1 text-3xl font-bold ${accent ?? ""}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}

function Overview() {
  const { t } = useLang();
  const [days, setDays] = useState(30);
  const [keyId, setKeyId] = useState("");
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.keys().then(setKeys).catch(() => {});
  }, []);

  useEffect(() => {
    setError("");
    api
      .analyticsSummary(days, keyId || undefined)
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [days, keyId]);

  const totals = data?.totals;
  const totalTokens = (totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0);
  const maxDayTokens = Math.max(
    1,
    ...(data?.series.map((d) => d.inputTokens + d.outputTokens) ?? []),
  );
  const maxProviderReq = Math.max(1, ...(data?.byProvider.map((p) => p.requests) ?? []));
  const errorRate =
    totals && totals.requests > 0 ? (totals.errors / totals.requests) * 100 : 0;

  return (
    <div>
      {/* filters — OmniRoute style */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Usage Analytics</h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            value={keyId}
            onChange={(e) => setKeyId(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
          >
            <option value="">All Keys</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
          <div className="flex overflow-hidden rounded-lg border border-zinc-700">
            {RANGES.map((r) => (
              <button
                key={r.id}
                onClick={() => setDays(r.id)}
                className={`px-3 py-1.5 text-sm ${
                  days === r.id
                    ? "bg-amber-600 font-medium text-white"
                    : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <p className="mb-4 text-red-400">{error}</p>}

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label="Total tokens"
          value={fmtTokens(totalTokens)}
          sub={`${(totals?.requests ?? 0).toLocaleString()} Requests`}
        />
        <KpiCard label="Input tokens" value={fmtTokens(totals?.inputTokens ?? 0)} accent="text-rose-400" />
        <KpiCard label="Output tokens" value={fmtTokens(totals?.outputTokens ?? 0)} accent="text-emerald-400" />
        <KpiCard label="Est. cost" value={`$${(totals?.costUsd ?? 0).toFixed(2)}`} accent="text-amber-400" />
      </div>

      {/* infrastructure + performance */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Infrastructure
          </p>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Providers</span>
              <span className="font-semibold text-sky-400">{data?.infra.providersConnected ?? 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">API Keys</span>
              <span className="font-semibold">{data?.infra.apiKeys ?? 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Models</span>
              <span className="font-semibold">{data?.infra.modelsTotal ?? 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Errors</span>
              <span className="font-semibold text-red-400">{totals?.errors ?? 0}</span>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Performance
          </p>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Avg tokens/req</span>
              <span className="font-semibold text-sky-400">
                {totals && totals.requests > 0
                  ? fmtTokens(Math.round(totalTokens / totals.requests))
                  : "0"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Cost/req</span>
              <span className="font-semibold text-amber-400">
                ${totals && totals.requests > 0 ? (totals.costUsd / totals.requests).toFixed(4) : "0.0000"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Avg latency</span>
              <span className="font-semibold">{Math.round(totals?.avgLatencyMs ?? 0)} ms</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Error rate</span>
              <span className="font-semibold text-red-400">{errorRate.toFixed(1)}%</span>
            </div>
          </div>
        </div>
      </div>

      {/* tokens per day */}
      <h3 className="mb-3 mt-8 font-semibold">Tokens / day</h3>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        {!data || data.series.length === 0 ? (
          <p className="text-sm text-zinc-500">{t("common.noData")}</p>
        ) : (
          <>
            <div className="flex h-36 items-end gap-[3px]">
              {data.series.map((d) => {
                const tot = d.inputTokens + d.outputTokens;
                const inH = (d.inputTokens / maxDayTokens) * 100;
                const outH = (d.outputTokens / maxDayTokens) * 100;
                return (
                  <div
                    key={d.day}
                    title={`${d.day}: ${tot.toLocaleString()} tok · ${d.requests} req · $${d.costUsd.toFixed(4)}`}
                    className="flex min-w-[4px] flex-1 flex-col justify-end"
                    style={{ height: "100%" }}
                  >
                    <div className="w-full bg-emerald-500/80" style={{ height: `${Math.max(0, outH)}%` }} />
                    <div className="w-full bg-rose-500/70" style={{ height: `${Math.max(0, inH)}%` }} />
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex justify-between text-xs text-zinc-500">
              <span>{data.series[0]?.day}</span>
              <span>
                <span className="text-rose-400">■</span> input · <span className="text-emerald-400">■</span> output
              </span>
              <span>{data.series[data.series.length - 1]?.day}</span>
            </div>
          </>
        )}
      </div>

      {/* by provider */}
      <h3 className="mb-3 mt-8 font-semibold">By provider</h3>
      <div className="space-y-3">
        {(data?.byProvider ?? []).map((p) => (
          <div key={p.provider} className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
            <div className="mb-1 flex flex-wrap justify-between gap-2 text-sm">
              <span className="font-medium">{p.provider}</span>
              <span className="text-zinc-400">
                {p.requests.toLocaleString()} req · {fmtTokens(p.inputTokens + p.outputTokens)} tok · $
                {p.costUsd.toFixed(4)} · {Math.round(p.avgLatencyMs)} ms
                {p.errors > 0 && <span className="text-red-400"> · {p.errors} err</span>}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-sky-500"
                style={{ width: `${(p.requests / maxProviderReq) * 100}%` }}
              />
            </div>
          </div>
        ))}
        {data && data.byProvider.length === 0 && (
          <p className="text-sm text-zinc-500">{t("common.noData")}</p>
        )}
      </div>

      {/* by model */}
      <h3 className="mb-3 mt-8 font-semibold">Top models</h3>
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-zinc-400">
            <tr>
              <th className="p-3">Model</th>
              <th className="p-3">{t("common.provider")}</th>
              <th className="p-3 text-right">Requests</th>
              <th className="p-3 text-right">Tokens</th>
              <th className="p-3 text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {(data?.byModel ?? []).map((m) => (
              <tr key={`${m.provider}:${m.model}`} className="border-t border-zinc-800">
                <td className="max-w-[220px] truncate p-3 font-mono text-xs">{m.model}</td>
                <td className="p-3">{m.provider}</td>
                <td className="p-3 text-right">{m.requests.toLocaleString()}</td>
                <td className="p-3 text-right">{fmtTokens(m.tokens)}</td>
                <td className="p-3 text-right">${m.costUsd.toFixed(4)}</td>
              </tr>
            ))}
            {data && data.byModel.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-zinc-500">
                  {t("common.noRecentRequests")}
                </td>
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
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("nav.analytics")}</h1>
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
      {tab === "overview" && <Overview />}
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
