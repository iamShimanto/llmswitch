import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type CostByProvider, type KeyRecord, type PricingTable } from "../api";
import { Tabs, TabEmpty } from "../components/Tabs";

interface Summary {
  monthToDateUsd: number;
  forecast: { projectedMonthly: number };
  byProvider: CostByProvider[];
  coverage: { pricedRequests: number; totalRequests: number; pct: number };
}

function Overview() {
  const { t } = useLang();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [daily, setDaily] = useState<Array<{ day: string; total: number }>>([]);
  const [cache, setCache] = useState<{ entries: number; hits: number; misses: number; hitRate: number } | null>(null);
  const [error, setError] = useState("");

  const load = () => {
    api.costsSummary().then(setSummary).catch((e) => setError(String(e)));
    api.costsForecast().then((f) => setDaily(f.daily)).catch(() => {});
    api.cacheStats().then(setCache).catch(() => {});
  };
  useEffect(load, []);

  const byProvider = new Map<string, { cost: number; requests: number }>();
  for (const r of summary?.byProvider ?? []) {
    const cur = byProvider.get(r.provider) ?? { cost: 0, requests: 0 };
    cur.cost += r.costUsd;
    cur.requests += r.requests;
    byProvider.set(r.provider, cur);
  }
  const spendRows = [...byProvider.entries()].sort((a, b) => b[1].cost - a[1].cost);

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

      {summary && (
        <p className="mt-3 text-xs text-zinc-500">
          Priced coverage: <span className="text-zinc-300">{summary.coverage.pct}%</span> of this
          month's requests have a known price ({summary.coverage.pricedRequests}/
          {summary.coverage.totalRequests}). Free routes count as $0; models with no price yet
          also show $0 — add one on the Pricing tab.
        </p>
      )}

      <div className="mt-6 flex gap-2">
        <a href="/api/costs/export" className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800">{t("common.exportUsageCsv")}</a>
        <button
          onClick={() => api.clearCache().then(load)}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800"
        >{t("common.clearCache")}</button>
      </div>

      {spendRows.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 font-semibold">Spend by provider (this month)</h2>
          <div className="overflow-hidden rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900 text-left text-zinc-400">
                <tr><th className="p-3">Provider</th><th className="p-3 text-right">Requests</th><th className="p-3 text-right">USD</th></tr>
              </thead>
              <tbody>
                {spendRows.map(([p, v]) => (
                  <tr key={p} className="border-t border-zinc-800">
                    <td className="p-3">{p}</td>
                    <td className="p-3 text-right">{v.requests}</td>
                    <td className="p-3 text-right">${v.cost.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

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
  const [cfg, setCfg] = useState<Awaited<ReturnType<typeof api.getConfig>> | null>(null);
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [capInput, setCapInput] = useState("");
  const [keyEdits, setKeyEdits] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");

  const load = () => {
    api.getConfig().then((c) => {
      setCfg(c);
      setCapInput(c.global_budget_usd.value != null ? String(c.global_budget_usd.value) : "");
    }).catch(() => {});
    api.keys().then(setKeys).catch(() => {});
  };
  useEffect(load, []);

  const saveGlobal = async () => {
    const cap = capInput.trim() === "" ? null : Number(capInput);
    if (cap !== null && (!Number.isFinite(cap) || cap < 0)) {
      setMsg("Enter a valid cap or leave it empty for no cap.");
      return;
    }
    await api.putConfig({ global_budget_usd: cap }).catch(() => {});
    setMsg("Saved.");
    load();
  };
  const saveAction = async (action: "warn" | "block") => {
    await api.putConfig({ budget_action: action }).catch(() => {});
    load();
  };
  const saveKeyBudget = async (k: KeyRecord) => {
    const raw = keyEdits[k.id];
    if (raw === undefined) return;
    const v = raw.trim() === "" ? null : Number(raw);
    if (v !== null && (!Number.isFinite(v) || v < 0)) return;
    await api.setBudget(k.id, v).catch(() => {});
    load();
  };

  const spent = cfg?.global_budget_usd.spentMonthToDate ?? 0;
  const cap = cfg?.global_budget_usd.value ?? null;

  return (
    <div>
      <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-sm text-zinc-400">{t("common.globalMonthlyCap")}</p>
        <p className="mt-1 text-sm text-zinc-500">
          Spent this month: <span className="text-zinc-200">${spent.toFixed(4)}</span>
          {cap != null && <> of ${cap} ({cap > 0 ? Math.min(100, (spent / cap) * 100).toFixed(1) : 100}%)</>}
        </p>
        {cap != null && cap > 0 && (
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800">
            <div
              className={`h-full rounded-full ${spent >= cap ? "bg-red-500" : "bg-emerald-500"}`}
              style={{ width: `${Math.min(100, (spent / cap) * 100)}%` }}
            />
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={capInput}
            onChange={(e) => setCapInput(e.target.value)}
            placeholder="No cap"
            inputMode="decimal"
            className="w-36 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          />
          <button onClick={saveGlobal} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500">
            Save cap
          </button>
          <label className="ml-2 text-xs text-zinc-400">On exceed</label>
          <select
            value={cfg?.budget_action.value ?? "warn"}
            onChange={(e) => saveAction(e.target.value as "warn" | "block")}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          >
            <option value="warn">warn (header only)</option>
            <option value="block">block (402)</option>
          </select>
          {msg && <span className="text-xs text-emerald-400">{msg}</span>}
        </div>
      </div>

      <h2 className="mb-3 font-semibold">{t("common.perKeyBudgets")}</h2>
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-zinc-400">
            <tr>
              <th className="p-3">{t("common.key")}</th>
              <th className="p-3 text-right">Spent (month)</th>
              <th className="p-3 text-right">{t("costs.monthlyBudget")}</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className="border-t border-zinc-800">
                <td className="p-3">{k.name}</td>
                <td className="p-3 text-right">${(k.monthSpendUsd ?? 0).toFixed(4)}</td>
                <td className="p-3 text-right">
                  <input
                    value={keyEdits[k.id] ?? (k.budgetUsd != null ? String(k.budgetUsd) : "")}
                    onChange={(e) => setKeyEdits((m) => ({ ...m, [k.id]: e.target.value }))}
                    placeholder="No cap"
                    inputMode="decimal"
                    className="w-28 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-right text-sm"
                  />
                </td>
                <td className="p-3 text-right">
                  <button
                    onClick={() => saveKeyBudget(k)}
                    className="rounded-lg border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800"
                  >
                    Save
                  </button>
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr><td colSpan={4} className="p-6 text-center text-zinc-500">{t("common.noKeys")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        Budgets are enforced on every request: at the cap, the gateway warns (response header)
        or blocks with 402, depending on the "On exceed" setting.
      </p>
    </div>
  );
}

function Pricing() {
  const { t } = useLang();
  const [table, setTable] = useState<PricingTable | null>(null);
  const [q, setQ] = useState("");
  const [key, setKey] = useState("");
  const [inp, setInp] = useState("");
  const [outp, setOutp] = useState("");
  const [msg, setMsg] = useState("");

  const load = () => {
    api.costsPricing().then(setTable).catch(() => {});
  };
  useEffect(load, []);

  const addOverride = async () => {
    const input = Number(inp);
    const output = Number(outp);
    if (!key.trim() || !Number.isFinite(input) || !Number.isFinite(output)) {
      setMsg("Key + numeric prices required.");
      return;
    }
    await api.savePriceOverride(key.trim(), input, output).catch(() => {});
    setKey(""); setInp(""); setOutp("");
    setMsg("Override saved — applies immediately, including to budget checks.");
    load();
  };
  const removeOverride = async (k: string) => {
    await api.deletePriceOverride(k).catch(() => {});
    load();
  };

  const needle = q.trim().toLowerCase();
  const match = (s: string) => !needle || s.toLowerCase().includes(needle);
  const overrides = Object.entries(table?.overrides ?? {});

  const priceTable = (
    rows: Array<{ label: string; input: number; output: number; action?: React.ReactNode }>,
  ) => (
    <div className="overflow-hidden rounded-xl border border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-900 text-left text-zinc-400">
          <tr><th className="p-3">{t("common.model")}</th><th className="p-3 text-right">{t("costs.inputPer1M")}</th><th className="p-3 text-right">{t("costs.outputPer1M")}</th><th className="p-3"></th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-zinc-800">
              <td className="p-3 font-mono text-xs">{r.label}</td>
              <td className="p-3 text-right">${r.input}</td>
              <td className="p-3 text-right">${r.output}</td>
              <td className="p-3 text-right">{r.action}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={4} className="p-6 text-center text-zinc-500">Nothing matches.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      <p className="mb-4 text-sm text-zinc-500">{t("costs.pricingNote")}<span className="text-amber-400">{t("costs.verifyPricing")}</span>
      </p>
      <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h3 className="mb-2 text-sm font-semibold">Add your own price</h3>
        <p className="mb-3 text-xs text-zinc-500">
          Key is <code className="rounded bg-zinc-800 px-1">provider:model</code> or just a
          model id. Overrides beat the built-in table and apply to new requests immediately.
        </p>
        <div className="flex flex-wrap gap-2">
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="antigravity:claude-sonnet-4-6" className="min-w-56 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm" />
          <input value={inp} onChange={(e) => setInp(e.target.value)} placeholder="$ / 1M in" inputMode="decimal" className="w-28 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm" />
          <input value={outp} onChange={(e) => setOutp(e.target.value)} placeholder="$ / 1M out" inputMode="decimal" className="w-28 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm" />
          <button onClick={addOverride} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500">Save</button>
        </div>
        {msg && <p className="mt-2 text-xs text-emerald-400">{msg}</p>}
      </div>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter models…"
        className="mb-4 w-full max-w-sm rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
      />

      {overrides.length > 0 && (
        <>
          <h3 className="mb-2 font-semibold">Your overrides</h3>
          <div className="mb-6">
            {priceTable(
              overrides
                .filter(([k]) => match(k))
                .map(([k, p]) => ({
                  label: k,
                  input: p.input,
                  output: p.output,
                  action: (
                    <button onClick={() => removeOverride(k)} className="text-xs text-red-400 hover:text-red-300">Remove</button>
                  ),
                })),
            )}
          </div>
        </>
      )}

      <h3 className="mb-2 font-semibold">Model prices (any provider)</h3>
      <div className="mb-6">
        {table && priceTable(table.patterns.filter((p) => match(p.label)).map((p) => ({ label: p.label, input: p.input, output: p.output })))}
      </div>

      <h3 className="mb-2 font-semibold">Exact provider prices</h3>
      <div className="mb-6">
        {table && priceTable(table.exact.filter((p) => match(p.key)).map((p) => ({ label: p.key, input: p.input, output: p.output })))}
      </div>

      <h3 className="mb-2 font-semibold">Provider defaults (blended)</h3>
      {table && priceTable(table.providers.filter((p) => match(p.key)).map((p) => ({ label: p.key, input: p.input, output: p.output })))}
    </div>
  );
}

function QuotaShare() {
  const { t } = useLang();
  const [summary, setSummary] = useState<Summary | null>(null);
  useEffect(() => {
    api.costsSummary().then(setSummary).catch(() => {});
  }, []);
  const byProv = new Map<string, number>();
  for (const r of summary?.byProvider ?? []) {
    byProv.set(r.provider, (byProv.get(r.provider) ?? 0) + r.costUsd);
  }
  const total = [...byProv.values()].reduce((a, b) => a + b, 0);
  const rows = [...byProv.entries()].sort((a, b) => b[1] - a[1]);
  return (
    <div>
      <p className="mb-4 text-sm text-zinc-500">Cost share per provider (this month, from the usage database).</p>
      {rows.length === 0 || total <= 0 ? (
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
