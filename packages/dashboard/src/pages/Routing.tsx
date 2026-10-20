import { useEffect, useState } from "react";
import { api, type CatalogEntry, type RoutingRule } from "../api";

const STRATEGIES = [
  "priority",
  "weighted",
  "round-robin",
  "context-relay",
  "fill-first",
  "p2c",
  "random",
  "least-used",
  "cost-optimized",
  "reset-aware",
  "reset-window",
  "headroom",
  "quota-weighted",
  "strict-random",
  "auto",
  "lkgp",
  "context-optimized",
  "cache-optimized",
  "fusion",
  "pipeline",
];

const ACCOUNT_STRATEGIES = [
  { id: "round-robin", label: "Round-robin — rotate evenly across accounts" },
  { id: "least-used", label: "Least used — prefer the account with fewest calls" },
  { id: "priority", label: "Priority — first healthy account, in order added" },
  { id: "random", label: "Random — pick a healthy account at random" },
];

const card = "rounded-xl border border-zinc-800 bg-zinc-900 p-4";
const input = "rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm";

/**
 * Routing: the account selection strategy (multi-account) + per-model
 * routing rules that pin a model (or prefix) to an ordered provider chain.
 */
export default function Routing() {
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [acctStrategy, setAcctStrategy] = useState("round-robin");
  const [pattern, setPattern] = useState("");
  const [chain, setChain] = useState<string[]>([]);
  const [strategy, setStrategy] = useState("");
  const [msg, setMsg] = useState("");

  const load = () => {
    api.routingRules().then((r) => setRules(r.rules)).catch(() => {});
    api.catalog().then(setCatalog).catch(() => {});
    api
      .getConfig()
      .then((c) => setAcctStrategy(c.account_strategy.value))
      .catch(() => {});
  };
  useEffect(load, []);

  const saveAcctStrategy = async (v: string) => {
    setAcctStrategy(v);
    await api.putConfig({ account_strategy: v }).catch(() => {});
  };

  const toggleProvider = (id: string) => {
    setChain((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const add = async () => {
    setMsg("");
    if (!pattern.trim()) {
      setMsg("A model pattern is required (exact name or prefix ending with *).");
      return;
    }
    if (chain.length === 0) {
      setMsg("Pick at least one provider for the chain.");
      return;
    }
    try {
      await api.addRoutingRule(pattern.trim(), chain, strategy || undefined);
      setPattern("");
      setChain([]);
      setStrategy("");
      load();
    } catch (e) {
      setMsg(String(e));
    }
  };

  const toggleRule = async (r: RoutingRule) => {
    await api.updateRoutingRule(r.id, { enabled: !r.enabled }).catch(() => {});
    load();
  };
  const removeRule = async (r: RoutingRule) => {
    await api.deleteRoutingRule(r.id).catch(() => {});
    load();
  };

  const nameOf = (id: string) => catalog.find((c) => c.id === id)?.name ?? id;

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Routing</h1>
      <p className="mb-6 max-w-3xl text-sm text-zinc-400">
        Two layers decide where a request goes: the <b>account strategy</b> picks which of a
        provider's accounts serves it, and <b>routing rules</b> pin models to an ordered
        provider chain. Rules match unpinned model names only, first match wins; requests that
        name a provider (<code className="rounded bg-zinc-800 px-1">provider:model</code>) and{" "}
        <code className="rounded bg-zinc-800 px-1">auto</code> always bypass rules.
      </p>

      <div className={`${card} mb-4`}>
        <h2 className="font-semibold">Account strategy</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Applies to every provider with multiple accounts — API keys rotate on
          authentication/rate-limit failures, session accounts rotate the same way.
        </p>
        <select
          value={acctStrategy}
          onChange={(e) => saveAcctStrategy(e.target.value)}
          className={`${input} mt-3 w-full md:w-96`}
        >
          {ACCOUNT_STRATEGIES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className={`${card} mb-4`}>
        <h2 className="font-semibold">Routing rules ({rules.length})</h2>
        {rules.length === 0 && <p className="mt-2 text-sm text-zinc-500">No rules yet — every model uses the global routing strategy.</p>}
        <div className="mt-3 space-y-2">
          {rules.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2">
              <code className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-xs">{r.pattern}</code>
              <span className="text-zinc-500">→</span>
              <span className="text-sm">{r.providers.map(nameOf).join(" → ")}</span>
              {r.strategy && (
                <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">{r.strategy}</span>
              )}
              <span className="ml-auto flex gap-2">
                <button
                  onClick={() => toggleRule(r)}
                  className={`rounded-lg px-3 py-1 text-xs ${r.enabled ? "bg-emerald-900 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}
                >
                  {r.enabled ? "Enabled" : "Disabled"}
                </button>
                <button
                  onClick={() => removeRule(r)}
                  className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-red-300 hover:bg-zinc-800"
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>

        <h3 className="mt-5 text-sm font-semibold">Add a rule</h3>
        <div className="mt-2 grid gap-2 md:grid-cols-3">
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="Model pattern — e.g. gpt-* or llama-3.3-70b"
            className={input}
          />
          <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className={input}>
            <option value="">Order: as listed (priority)</option>
            {STRATEGIES.filter((s) => s !== "priority").map((s) => (
              <option key={s} value={s}>
                Order by strategy: {s}
              </option>
            ))}
          </select>
          <button
            onClick={add}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500"
          >
            Add rule
          </button>
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          Provider chain (click in fallback order) — selected: {chain.map(nameOf).join(" → ") || "none"}
        </p>
        <div className="mt-2 flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
          {catalog.map((c) => {
            const idx = chain.indexOf(c.id);
            return (
              <button
                key={c.id}
                onClick={() => toggleProvider(c.id)}
                className={`rounded-full px-2.5 py-1 text-xs ${idx >= 0 ? "bg-emerald-700 text-white" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}
              >
                {idx >= 0 ? `${idx + 1}. ` : ""}
                {c.name}
              </button>
            );
          })}
        </div>
        {msg && <p className="mt-2 text-sm text-red-400">{msg}</p>}
      </div>
    </div>
  );
}
