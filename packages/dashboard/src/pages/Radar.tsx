import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type ProviderInfo } from "../api";
import { Tabs, TabEmpty } from "../components/Tabs";

const LS_REFRESH = "llmswitch_radar_refresh_s";

function statusOf(calls: number, errors: number): { label: string; cls: string } {
  if (calls === 0) return { label: "idle", cls: "bg-zinc-700 text-zinc-300" };
  const rate = errors / calls;
  if (rate === 0) return { label: "healthy", cls: "bg-emerald-900 text-emerald-300" };
  if (rate < 0.1) return { label: "degraded", cls: "bg-amber-900 text-amber-300" };
  return { label: "erroring", cls: "bg-red-900 text-red-300" };
}

function OverviewGrid({ providers, onRefresh }: { providers: ProviderInfo[]; onRefresh: () => void }) {
  const { t } = useLang();
  const maxLatency = Math.max(1, ...providers.map((p) => (p.stats.calls > 0 ? p.stats.totalLatencyMs / p.stats.calls : 0)));
  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button onClick={onRefresh} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">{t("common.refresh")}</button>
      </div>
      <p className="mb-4 text-sm text-zinc-500">{t("radar.live_provider_status_grid_from_router_st")}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {providers.map((p) => {
          const st = statusOf(p.stats.calls, p.stats.errors);
          const avg = p.stats.calls > 0 ? p.stats.totalLatencyMs / p.stats.calls : null;
          const errRate = p.stats.calls > 0 ? (p.stats.errors / p.stats.calls) * 100 : 0;
          return (
            <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="truncate font-semibold" title={p.id}>{p.name}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${st.cls}`}>{st.label}</span>
              </div>
              <div className="mb-1 flex justify-between text-xs text-zinc-500">
                <span>{t("common.avgLatencyLower")}</span>
                <span>{avg == null ? "—" : `${Math.round(avg)} ms`}</span>
              </div>
              <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                <div className="h-full rounded-full bg-sky-500" style={{ width: `${avg == null ? 0 : Math.min(100, (avg / maxLatency) * 100)}%` }} />
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">{p.stats.calls} calls</span>
                <span className={errRate > 0 ? "text-red-400" : "text-zinc-500"}>{errRate.toFixed(1)}% errors</span>
              </div>
            </div>
          );
        })}
        {providers.length === 0 && <p className="text-sm text-zinc-500">{t("common.noProviders")}</p>}
      </div>
    </div>
  );
}

function CombosTab() {
  const { t } = useLang();
  const [combos, setCombos] = useState<Array<{ name: string; steps: Array<{ providerId: string }> }>>([]);
  useEffect(() => {
    try {
      setCombos(JSON.parse(localStorage.getItem("llmswitch_combos") ?? "[]"));
    } catch { /* ignore */ }
  }, []);
  if (combos.length === 0) {
    return <TabEmpty>{t("radar.noCombos")}</TabEmpty>;
  }
  return (
    <div className="space-y-2">
      <p className="mb-2 text-sm text-zinc-500">{t("radar.providersUsed")}</p>
      {combos.map((c) => (
        <div key={c.name} className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5">
          <span className="text-sm font-medium">{c.name}</span>
          <span className="ml-3 text-xs text-zinc-500">{c.steps.map((s) => s.providerId).join(" → ")}</span>
        </div>
      ))}
    </div>
  );
}

function IntelTab({ providers }: { providers: ProviderInfo[] }) {
  const { t } = useLang();
  const withCalls = providers.filter((p) => p.stats.calls > 0);
  if (withCalls.length === 0) {
    return <TabEmpty>No traffic yet — provider intel (error patterns, latency drift) appears after requests flow.</TabEmpty>;
  }
  const rows = withCalls
    .map((p) => ({
      p,
      errRate: (p.stats.errors / p.stats.calls) * 100,
      avg: p.stats.totalLatencyMs / p.stats.calls,
    }))
    .sort((a, b) => b.errRate - a.errRate);
  return (
    <div className="space-y-2">
      <p className="mb-2 text-sm text-zinc-500">{t("radar.derivedStats")}</p>
      {rows.map(({ p, errRate, avg }) => (
        <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="font-medium">{p.name}</span>
            <span className={`rounded px-2 py-0.5 text-xs ${errRate === 0 ? "bg-emerald-900 text-emerald-300" : errRate < 10 ? "bg-amber-900 text-amber-300" : "bg-red-900 text-red-300"}`}>
              {errRate.toFixed(1)}% errors
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {p.stats.calls} calls · avg {Math.round(avg)} ms ·{" "}
            {errRate > 10
              ? "consider deprioritizing via strategy or fallback order"
              : errRate > 0
                ? "watch — occasional failures"
                : "clean record"}
          </p>
        </div>
      ))}
    </div>
  );
}

function OffersTab({ providers }: { providers: ProviderInfo[] }) {
  const { t } = useLang();
  const ranked = [...providers]
    .filter((p) => p.stats.calls > 0)
    .map((p) => ({ p, errRate: (p.stats.errors / p.stats.calls) * 100, avg: p.stats.totalLatencyMs / p.stats.calls }))
    .sort((a, b) => a.errRate - b.errRate || a.avg - b.avg)
    .slice(0, 10);
  if (ranked.length === 0) {
    return <TabEmpty>{t("radar.noReliabilityFull")}</TabEmpty>;
  }
  return (
    <div>
      <p className="mb-4 text-sm text-zinc-500">
        Most reliable providers first (by observed error rate, then latency). Not price advice — see
        Costs → Pricing for estimates.
      </p>
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-zinc-400">
            <tr><th className="p-3">#</th><th className="p-3">{t("common.provider")}</th><th className="p-3 text-right">{t("radar.errorRate")}</th><th className="p-3 text-right">{t("common.avgLatency")}</th></tr>
          </thead>
          <tbody>
            {ranked.map(({ p, errRate, avg }, i) => (
              <tr key={p.id} className="border-t border-zinc-800">
                <td className="p-3 text-zinc-500">{i + 1}</td>
                <td className="p-3 font-medium">{p.name}</td>
                <td className="p-3 text-right">{errRate.toFixed(1)}%</td>
                <td className="p-3 text-right">{Math.round(avg)} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SetupTab() {
  const { t } = useLang();
  const [secs, setSecs] = useState(() => {
    try {
      return Number(localStorage.getItem(LS_REFRESH) ?? "0");
    } catch {
      return 0;
    }
  });
  const save = (v: number) => {
    setSecs(v);
    try {
      localStorage.setItem(LS_REFRESH, String(v));
    } catch { /* ignore */ }
  };
  return (
    <div className="max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="mb-2 font-semibold">{t("radar.monitoring")}</h2>
      <p className="mb-4 text-sm text-zinc-500">
        Radar reads live router stats (calls, errors, latency) for every connected provider.
        Auto-refresh interval is stored in your browser.
      </p>
      <label className="block text-sm">
        <span className="mb-1 block text-zinc-400">{t("radar.autoRefresh")}</span>
        <select
          value={secs}
          onChange={(e) => save(Number(e.target.value))}
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm"
        >
          <option value={0}>off (manual refresh)</option>
          <option value={5}>{t("radar.every5s")}</option>
          <option value={15}>{t("radar.every15s")}</option>
          <option value={60}>{t("radar.every60s")}</option>
        </select>
      </label>
    </div>
  );
}

export default function Radar() {
  const { t } = useLang();
  const [tab, setTab] = useState("overview");
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [error, setError] = useState("");

  const load = () => {
    api.providers().then(setProviders).catch((e) => setError(String(e)));
  };
  useEffect(load, []);

  // auto-refresh per Setup tab
  useEffect(() => {
    let secs = 0;
    try {
      secs = Number(localStorage.getItem(LS_REFRESH) ?? "0");
    } catch { /* ignore */ }
    if (!secs) return;
    const id = setInterval(load, secs * 1000);
    return () => clearInterval(id);
  }, [tab]);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.radar")}</h1>
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "combos", label: "Combos" },
          { id: "intel", label: "Intel" },
          { id: "offers", label: "Offers" },
          { id: "setup", label: "Setup" },
        ]}
      />
      {error && <p className="mb-4 text-red-400">{error}</p>}
      {tab === "overview" && <OverviewGrid providers={providers} onRefresh={load} />}
      {tab === "combos" && <CombosTab />}
      {tab === "intel" && <IntelTab providers={providers} />}
      {tab === "offers" && <OffersTab providers={providers} />}
      {tab === "setup" && <SetupTab />}
    </div>
  );
}
