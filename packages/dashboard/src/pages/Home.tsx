import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type AnalyticsSummary, type ProviderInfo, type RequestLogRow } from "../api";

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-sm text-zinc-400">{label}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

const card = "rounded-xl border border-zinc-800 bg-zinc-900 p-4";

export default function Home() {
  const { t } = useLang();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [monthSpend, setMonthSpend] = useState<number | null>(null);
  const [comboCount, setComboCount] = useState<number | null>(null);
  const [logs, setLogs] = useState<RequestLogRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.providers().then(setProviders).catch((e) => setError(String(e)));
    api.analyticsSummary(30).then(setAnalytics).catch(() => {});
    api.costsSummary().then((s) => setMonthSpend(s.monthToDateUsd)).catch(() => {});
    api.combos().then((r) => setComboCount(r.combos.length)).catch(() => {});
    api.logs({ limit: 8 }).then((r) => setLogs(r.logs)).catch(() => {});
  }, []);

  const calls = providers.reduce((s, p) => s + p.stats.calls, 0);
  const errors = providers.reduce((s, p) => s + p.stats.errors, 0);
  const errRate = calls > 0 ? ((errors / calls) * 100).toFixed(1) : "0";
  const tot = analytics?.totals;
  const series = (analytics?.series ?? []).slice(-14);
  const maxReq = Math.max(1, ...series.map((d) => d.requests));
  const topProviders = (analytics?.byProvider ?? []).slice(0, 5);
  const maxProvReq = Math.max(1, ...topProviders.map((p) => p.requests));
  const topModels = (analytics?.byModel ?? []).slice(0, 5);
  const today = analytics?.series[analytics.series.length - 1];

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.overview")}</h1>
      {error && <p className="mb-4 text-red-400">{error}</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Connected providers" value={providers.length} />
        <Stat label="Total requests" value={calls} sub={today ? `${today.requests} today` : undefined} />
        <Stat label="Errors" value={errors} sub={`${errRate}% error rate`} />
        <Stat
          label="Spent this month"
          value={monthSpend != null ? `$${monthSpend.toFixed(4)}` : "…"}
          sub={tot ? `≈ $${tot.costUsd.toFixed(4)} in 30 days` : undefined}
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Tokens in (30d)" value={tot ? fmtTokens(tot.inputTokens) : "…"} />
        <Stat label="Tokens out (30d)" value={tot ? fmtTokens(tot.outputTokens) : "…"} />
        <Stat label="Avg latency (30d)" value={tot ? `${Math.round(tot.avgLatencyMs)} ms` : "…"} />
        <Stat
          label="Models available"
          value={analytics?.infra.modelsTotal ?? "…"}
          sub={`${analytics?.infra.apiKeys ?? 0} API keys · ${comboCount ?? "…"} combos`}
        />
      </div>

      {series.length > 0 && (
        <div className={`${card} mt-4`}>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-semibold">Requests — last 14 days</h2>
            <span className="text-xs text-zinc-500">
              {series.reduce((s, d) => s + d.requests, 0)} requests ·{" "}
              {series.reduce((s, d) => s + d.errors, 0)} errors
            </span>
          </div>
          <div className="flex h-28 items-end gap-1">
            {series.map((d) => (
              <div key={d.day} className="group flex min-w-0 flex-1 flex-col items-center gap-1">
                <span className="text-[10px] text-zinc-500 opacity-0 transition group-hover:opacity-100">
                  {d.requests}
                </span>
                <div
                  className={`w-full rounded-t ${d.errors > 0 && d.requests > 0 ? "bg-amber-500/80" : "bg-emerald-500/80"}`}
                  style={{ height: `${Math.max(4, (d.requests / maxReq) * 100)}%` }}
                  title={`${d.day}: ${d.requests} requests, ${d.errors} errors`}
                />
                <span className="truncate text-[9px] text-zinc-600">{d.day.slice(5)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className={card}>
          <h2 className="mb-3 font-semibold">Top providers (30 days)</h2>
          {topProviders.length === 0 ? (
            <p className="text-sm text-zinc-500">No requests yet.</p>
          ) : (
            <div className="space-y-3">
              {topProviders.map((p) => (
                <div key={p.provider}>
                  <div className="mb-1 flex items-baseline justify-between text-sm">
                    <span className="font-medium">{p.provider}</span>
                    <span className="text-zinc-400">
                      {p.requests} req · {p.errors} err · ${p.costUsd.toFixed(4)}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-sky-500/80"
                      style={{ width: `${(p.requests / maxProvReq) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={card}>
          <h2 className="mb-3 font-semibold">Top models (30 days)</h2>
          {topModels.length === 0 ? (
            <p className="text-sm text-zinc-500">No requests yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {topModels.map((m) => (
                  <tr key={`${m.provider}:${m.model}`} className="border-b border-zinc-800/60 last:border-0">
                    <td className="max-w-0 truncate py-2 pr-2">
                      <span className="font-mono text-xs">{m.model}</span>
                      <span className="block text-[11px] text-zinc-500">{m.provider}</span>
                    </td>
                    <td className="py-2 text-right text-zinc-400">{m.requests} req</td>
                    <td className="py-2 text-right text-zinc-400">{fmtTokens(m.tokens)} tok</td>
                    <td className="py-2 text-right">${m.costUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className={card}>
          <h2 className="mb-3 font-semibold">Recent activity</h2>
          {logs.length === 0 ? (
            <p className="text-sm text-zinc-500">No requests logged yet.</p>
          ) : (
            <div className="space-y-2">
              {logs.map((l) => (
                <div key={l.id} className="flex items-center gap-2 text-sm">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${l.status === "ok" ? "bg-emerald-500" : "bg-red-500"}`}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {l.provider}:{l.model}
                  </span>
                  <span className="shrink-0 text-xs text-zinc-500">{l.latencyMs} ms</span>
                  <span className="shrink-0 text-xs text-zinc-600">
                    {new Date(l.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={card}>
          <h2 className="mb-2 font-semibold">{t("common.quickStart")}</h2>
          <p className="text-sm text-zinc-400">{t("common.pointClient")}</p>
          <code className="mt-2 block rounded bg-zinc-950 p-3 text-sm text-emerald-300">
            Base URL: {window.location.origin}/v1
            <br />
            Model: auto
          </code>
          <p className="mt-2 text-sm text-zinc-400">{t("common.createKeyOn")}{" "}
            <span className="text-zinc-200">{t("home.keys")}</span> page and send it as{" "}
            <code>Authorization: Bearer &lt;key&gt;</code>.
          </p>
          <p className="mt-3 text-xs text-zinc-500">
            Full endpoint reference, MCP config and the VS Code alias live on the{" "}
            <span className="text-zinc-300">API Endpoint</span> page.
          </p>
        </div>
      </div>
    </div>
  );
}
