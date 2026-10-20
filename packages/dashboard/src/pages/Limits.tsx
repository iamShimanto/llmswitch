import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type GatewayConfig, type KeyRecord } from "../api";

export default function Limits() {
  const { t } = useLang();
  const [cfg, setCfg] = useState<GatewayConfig | null>(null);
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [globalBudget, setGlobalBudget] = useState("");
  const [budgetAction, setBudgetAction] = useState<"warn" | "block">("warn");
  const [keyBudgets, setKeyBudgets] = useState<Record<string, string>>({});

  const load = () => {
    api.getConfig()
      .then((c) => {
        setCfg(c);
        setGlobalBudget(c.global_budget_usd.value != null ? String(c.global_budget_usd.value) : "");
        setBudgetAction(c.budget_action.value === "block" ? "block" : "warn");
      })
      .catch((e) => setError(String(e)));
    api.keys()
      .then((ks) => {
        setKeys(ks);
        const m: Record<string, string> = {};
        for (const k of ks) m[k.id] = k.budgetUsd != null ? String(k.budgetUsd) : "";
        setKeyBudgets(m);
      })
      .catch((e) => setError(String(e)));
  };
  useEffect(load, []);

  const saveGlobal = async () => {
    setError("");
    setSaved("");
    const v = globalBudget.trim() ? Number(globalBudget) : null;
    if (v != null && !(v > 0)) {
      setError(t("settings.budgetPositive"));
      return;
    }
    try {
      const c = await api.putConfig({ global_budget_usd: v, budget_action: budgetAction });
      setCfg(c);
      setSaved(t("limits.globalSaved"));
      setTimeout(() => setSaved(""), 3000);
    } catch (e) {
      setError(String(e));
    }
  };

  const saveKey = async (id: string) => {
    setError("");
    const raw = (keyBudgets[id] ?? "").trim();
    const v = raw ? Number(raw) : null;
    if (v != null && !(v > 0)) {
      setError(t("limits.budgetPositive"));
      return;
    }
    try {
      await api.setBudget(id, v);
      setKeys((ks) => ks.map((k) => (k.id === id ? { ...k, budgetUsd: v } : k)));
      setSaved(t("limits.budgetUpdated", { id: id.slice(0, 8) }));
      setTimeout(() => setSaved(""), 3000);
    } catch (e) {
      setError(String(e));
    }
  };

  const input = "rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm";

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.limits")}</h1>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      {saved && <p className="mb-4 text-emerald-400">{saved}</p>}

      <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-3 font-semibold">{t("common.globalMonthlyCap")}</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-zinc-400">Budget (USD)</span>
            <input value={globalBudget} onChange={(e) => setGlobalBudget(e.target.value)} placeholder="empty = no cap" inputMode="decimal" className={input} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-400">{t("common.onExceed")}</span>
            <select value={budgetAction} onChange={(e) => setBudgetAction(e.target.value as "warn" | "block")} className={input}>
              <option value="warn">{t("common.warnHeader")}</option>
              <option value="block">{t("common.block402")}</option>
            </select>
          </label>
          <button onClick={saveGlobal} className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium hover:bg-sky-500">{t("common.save")}</button>
        </div>
        {cfg && (
          <p className="mt-2 text-xs text-zinc-500">
            Spent this month: ${cfg.global_budget_usd.spentMonthToDate.toFixed(4)} across all keys.
          </p>
        )}
      </div>

      <h2 className="mb-3 font-semibold">{t("common.perKeyBudgets")}</h2>
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-900 text-left text-zinc-400">
              <th className="px-4 py-2">{t("common.key")}</th>
              <th className="px-4 py-2">{t("common.workspace")}</th>
              <th className="px-4 py-2">{t("common.rpmLimit")}</th>
              <th className="px-4 py-2">Budget (USD)</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className="border-t border-zinc-800">
                <td className="px-4 py-2 font-medium">{k.name} <span className="text-xs text-zinc-500">{k.id.slice(0, 8)}…</span></td>
                <td className="px-4 py-2 text-zinc-400">{k.workspaceId || "—"}</td>
                <td className="px-4 py-2">{k.rpmLimit}</td>
                <td className="px-4 py-2">
                  <input
                    value={keyBudgets[k.id] ?? ""}
                    onChange={(e) => setKeyBudgets((m) => ({ ...m, [k.id]: e.target.value }))}
                    placeholder={t("common.noCap")}
                    inputMode="decimal"
                    className={`${input} w-28`}
                  />
                </td>
                <td className="px-4 py-2">
                  <button onClick={() => saveKey(k.id)} className="rounded-lg border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800">{t("common.save")}</button>
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">{t("common.noKeysCreate")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
