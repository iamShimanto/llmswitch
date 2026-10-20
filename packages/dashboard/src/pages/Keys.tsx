import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type KeyRecord, type Workspace } from "../api";

export default function Keys() {
  const { t } = useLang();
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [newWs, setNewWs] = useState("");
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("");
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState("");

  const refresh = () => {
    api.keys().then(setKeys).catch((e) => setError(String(e)));
    api.workspaces().then(setWorkspaces).catch(() => {});
  };
  useEffect(() => {
    refresh();
  }, []);

  const create = async () => {
    try {
      const b = budget.trim() === "" ? null : Number(budget);
      const k = await api.createKey(name.trim() || "default", b);
      setNewKey(k.key);
      setName("");
      setBudget("");
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const revoke = async (id: string) => {
    if (!confirm(t("common.confirmRevokeKey"))) return;
    await api.revokeKey(id);
    refresh();
  };

  const editBudget = async (id: string, current: number | null) => {
    const v = prompt("Monthly budget in USD (empty = no limit):", current?.toString() ?? "");
    if (v === null) return;
    const n = v.trim() === "" ? null : Number(v);
    if (n !== null && (isNaN(n) || n < 0)) {
      setError(t("limits.budgetNumber"));
      return;
    }
    await api.setBudget(id, n);
    refresh();
  };

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.apiKeys")}</h1>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      {newKey && (
        <div className="mb-4 rounded-xl border border-emerald-800 bg-emerald-950 p-4">
          <p className="text-sm text-emerald-300">New key (shown once — copy it now):</p>
          <code className="mt-1 block break-all text-emerald-200">{newKey}</code>
        </div>
      )}
      <div className="mb-6 flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Key name (e.g. cursor)"
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
        />
        <input
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          placeholder="Budget $/mo (optional)"
          type="number"
          min="0"
          className="w-44 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
        />
        <button
          onClick={create}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500"
        >{t("common.createKey")}</button>
      </div>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <span className="text-sm text-zinc-400">{t("common.workspaces")}</span>
        {workspaces.map((w) => (
          <span key={w.id} className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs">{w.name}</span>
        ))}
        <input
          value={newWs}
          onChange={(e) => setNewWs(e.target.value)}
          placeholder={t("common.newWorkspace")}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs"
        />
        <button
          onClick={() => newWs.trim() && api.createWorkspace(newWs.trim()).then(() => { setNewWs(""); refresh(); })}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800"
        >{t("common.add")}</button>
      </div>
      <div className="space-y-2">
        {keys.map((k) => (
          <div
            key={k.id}
            className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 p-3"
          >
            <div>
              <span className="font-medium">{k.name}</span>
              <span className="ml-2 text-xs text-zinc-500">{k.rpmLimit} rpm</span>
              <button
                onClick={() => editBudget(k.id, k.budgetUsd)}
                className="ml-2 text-xs text-zinc-400 underline hover:text-white"
                title={t("common.setMonthlyBudget")}
              >
                {k.budgetUsd != null ? `$${k.budgetUsd}/mo` : "no budget"}
              </button>
              <select
                value={k.workspaceId}
                onChange={(e) => api.setKeyWorkspace(k.id, e.target.value).then(refresh)}
                className="ml-2 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-xs"
                title={t("common.workspace")}
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </div>
            <button
              onClick={() => revoke(k.id)}
              className="rounded-lg border border-red-900 px-3 py-1 text-sm text-red-400 hover:bg-red-950"
            >{t("common.revoke")}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
