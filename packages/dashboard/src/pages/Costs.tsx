import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type InspectEntry, type KeyRecord } from "../api";
import { Tabs, TabEmpty } from "../components/Tabs";

/** Mirrors packages/core/src/billing/prices.ts (USD per 1M tokens). ESTIMATES. */
const PRICES: Array<{ model: string; input: number; output: number }> = [
  { model: "openai:gpt-4o-mini", input: 0.15, output: 0.6 },
  { model: "openai:gpt-4o", input: 2.5, output: 10 },
  { model: "openai:gpt-4.1-mini", input: 0.4, output: 1.6 },
  { model: "openai:gpt-4.1", input: 2, output: 8 },
  { model: "anthropic:claude-haiku-4-5", input: 1, output: 5 },
  { model: "anthropic:claude-sonnet-4-5", input: 3, output: 15 },
  { model: "anthropic:claude-opus-4-1", input: 15, output: 75 },
  { model: "gemini:gemini-2.5-flash", input: 0.3, output: 2.5 },
  { model: "gemini:gemini-2.5-pro", input: 1.25, output: 10 },
  { model: "gemini:gemini-2.0-flash", input: 0.1, output: 0.4 },
  { model: "groq:llama-3.3-70b-versatile", input: 0.59, output: 0.79 },
  { model: "deepseek:deepseek-chat", input: 0.27, output: 1.1 },
  { model: "mistral:mistral-small-latest", input: 0.1, output: 0.3 },
  { model: "mistral:mistral-medium-latest", input: 0.4, output: 2 },
  { model: "cerebras:llama-3.3-70b", input: 0.6, output: 0.6 },
];

function Overview() {
  const { t } = useLang();
  const [summary, setSummary] = useState<{ monthToDateUsd: number; forecast: { projectedMonthly: number } } | null>(null);
  const [daily, setDaily] = useState<Array<{ day: string; total: number }>>([]);
  const [cache, setCache] = useState<{ entries: number; hits: number; misses: number; hitRate: number } | null>(null);
  const [error, setError] = useState("");

  const load = () => {
    api.costsSummary().then(setSummary).catch((e) => setError(String(e)));
    api.costsForecast().then((f) => setDaily(f.daily)).catch(() => {});
    api.cacheStats().then(setCache).catch(() => {});
  };
  useEffect(load, []);

  return (
    <div>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <div className="text-2xl font-semibold">${summary?.monthToDateUsd.toFixed(4) ?? "…"}</div>
          <div className="text-sm text-zinc-400">{t("common.spentMonth")}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <div className="text-2xl font-semibold">${summary?.forecast.projectedMonthly.toFixed(2) ?? "…"}</div>
          <div className="text-sm text-zinc-400">{t("common.projectedMonth")}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <div className="text-2xl font-semibold">{cache?.hitRate ?? "…"}%</div>
          <div className="text-sm text-zinc-400">{t("common.cacheHitRate")}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <div className="text-2xl font-semibold">{cache?.entries ?? "…"}</div>
          <div className="text-sm text-zinc-400">{t("common.cacheEntries")}</div>
        </div>
      </div>

      <div className="mt-6 flex gap-2">
        <a href="/api/costs/export" className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800">{t("common.exportUsageCsv")}</a>
        <button
          onClick={() => api.clearCache().then(load)}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800"
        >{t("common.clearCache")}</button>
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Daily spend (last 7 days)</h2>
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-zinc-400">
            <tr><th className="p-3">{t("common.day")}</th><th className="p-3 text-right">{t("common.usd")}</th></tr>
          </thead>
          <tbody>
            {daily.map((d) => (
              <tr key={d.day} className="border-t border-zinc-800">
                <td className="p-3">{d.day}</td>
                <td className="p-3 text-right">${d.total.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Budget() {
  const { t } = useLang();
  const [cfg, setCfg] = useState<{ global_budget_usd: { value: number | null }; budget_action: { value: string } } | null>(null);
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  useEffect(() => {
    api.getConfig().then(setCfg).catch(() => {});
    api.keys().then(setKeys).catch(() => {});
  }, []);
  return (
    <div>
      <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm text-zinc-400">{t("common.globalMonthlyCap")}</p>
            <p className="text-2xl font-bold">
              {cfg?.global_budget_usd.value != null ? `$${cfg.global_budget_usd.value}` : "no cap"}
            </p>
          </div>
          <span className="rounded-lg bg-zinc-800 px-3 py-1 text-sm text-zinc-300">
            on exceed: {cfg?.budget_action.value ?? "warn"}
          </span>
        </div>
        <p className="mt-2 text-xs text-zinc-500">{t("costs.changeSettings")}</p>
      </div>
      <h2 className="mb-3 font-semibold">{t("common.perKeyBudgets")}</h2>
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-zinc-400">
            <tr><th className="p-3">{t("common.key")}</th><th className="p-3 text-right">{t("costs.monthlyBudget")}</th></tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className="border-t border-zinc-800">
                <td className="p-3">{k.name}</td>
                <td className="p-3 text-right">{k.budgetUsd != null ? `$${k.budgetUsd}` : "—"}</td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr><td colSpan={2} className="p-6 text-center text-zinc-500">{t("common.noKeys")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Pricing() {
  const { t } = useLang();
  const [q, setQ] = useState("");
  const shown = PRICES.filter((p) => p.model.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <p className="mb-4 text-sm text-zinc-500">{t("costs.pricingNote")}<span className="text-amber-400">{t("costs.verifyPricing")}</span>
      </p>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter models…"
        className="mb-4 w-full max-w-sm rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
      />
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-zinc-400">
            <tr><th className="p-3">{t("common.model")}</th><th className="p-3 text-right">{t("costs.inputPer1M")}</th><th className="p-3 text-right">{t("costs.outputPer1M")}</th></tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.model} className="border-t border-zinc-800">
                <td className="p-3 font-mono text-xs">{p.model}</td>
                <td className="p-3 text-right">${p.input}</td>
                <td className="p-3 text-right">${p.output}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function QuotaShare() {
  const { t } = useLang();
  const [entries, setEntries] = useState<InspectEntry[]>([]);
  useEffect(() => {
    api.inspector().then(setEntries).catch(() => {});
  }, []);
  const byProv = new Map<string, number>();
  for (const e of entries) byProv.set(e.provider, (byProv.get(e.provider) ?? 0) + e.costUsd);
  const total = Math.max(0.000001, [...byProv.values()].reduce((a, b) => a + b, 0));
  const rows = [...byProv.entries()].sort((a, b) => b[1] - a[1]);
  return (
    <div>
      <p className="mb-4 text-sm text-zinc-500">Cost share per provider (recent requests, inspector buffer).</p>
      {rows.length === 0 ? (
        <TabEmpty>{t("costs.noCostData")}</TabEmpty>
      ) : (
        <div className="space-y-3">
          {rows.map(([p, c]) => (
            <div key={p} className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
              <div className="mb-1 flex justify-between text-sm">
                <span className="font-medium">{p}</span>
                <span className="text-zinc-400">${c.toFixed(6)} · {((c / total) * 100).toFixed(1)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                <div className="h-full rounded-full bg-emerald-500" style={{ width: `${(c / total) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Costs() {
  const { t } = useLang();
  const [tab, setTab] = useState("overview");
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.costs")}</h1>
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "budget", label: "Budget" },
          { id: "pricing", label: "Pricing" },
          { id: "quota", label: "Quota Share" },
        ]}
      />
      {tab === "overview" && <Overview />}
      {tab === "budget" && <Budget />}
      {tab === "pricing" && <Pricing />}
      {tab === "quota" && <QuotaShare />}
    </div>
  );
}
