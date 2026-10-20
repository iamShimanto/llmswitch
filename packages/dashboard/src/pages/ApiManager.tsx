import { useEffect, useMemo, useState } from "react";
import { useLang } from "../i18n";
import { api, type InspectEntry, type KeyRecord } from "../api";
import { Tabs, TabEmpty } from "../components/Tabs";

function KeysTab({ keys, perKey }: {
  keys: KeyRecord[];
  perKey: Map<string, { requests: number; errors: number; cost: number }>;
}) {
  const { t } = useLang();
  return (
    <div>
      <p className="mb-4 text-sm text-zinc-500">
        Per-key budgets, rate limits, and live usage (aggregated from the inspector buffer).
        Create / revoke keys on the API Keys page.
      </p>
      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
              <th className="px-4 py-2">{t("common.key")}</th>
              <th className="px-4 py-2">{t("common.budget")}</th>
              <th className="px-4 py-2">{t("common.rpmLimit")}</th>
              <th className="px-4 py-2">{t("common.requests")}</th>
              <th className="px-4 py-2">{t("common.errors")}</th>
              <th className="px-4 py-2">{t("common.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const u = perKey.get(k.id) ?? { requests: 0, errors: 0, cost: 0 };
              return (
                <tr key={k.id} className="border-b border-zinc-800/60 last:border-0">
                  <td className="px-4 py-2.5 font-medium">{k.name}</td>
                  <td className="px-4 py-2.5 text-zinc-400">
                    {k.budgetUsd != null ? `$${k.budgetUsd}/mo` : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-400">{k.rpmLimit}</td>
                  <td className="px-4 py-2.5">{u.requests}</td>
                  <td className="px-4 py-2.5 text-red-400">{u.errors}</td>
                  <td className="px-4 py-2.5">${u.cost.toFixed(6)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {keys.length === 0 && (
          <p className="p-4 text-sm text-zinc-500">{t("common.noKeys")}</p>
        )}
      </div>
    </div>
  );
}

function AccessTab({ entries, keys }: { entries: InspectEntry[]; keys: KeyRecord[] }) {
  const { t } = useLang();
  const nameOf = (id: string | null) =>
    id == null ? "(no key)" : keys.find((k) => k.id === id)?.name ?? id.slice(0, 12);
  const sorted = [...entries].sort((a, b) => b.ts - a.ts).slice(0, 100);
  return (
    <div>
      <p className="mb-4 text-sm text-zinc-500">{t("apimanager.accessLog")}</p>
      {sorted.length === 0 ? (
        <TabEmpty>{t("analytics.noRequests")}</TabEmpty>
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-left text-zinc-400">
              <tr>
                <th className="p-3">{t("apimanager.time")}</th>
                <th className="p-3">{t("common.key")}</th>
                <th className="p-3">{t("common.provider")}</th>
                <th className="p-3">{t("common.model")}</th>
                <th className="p-3 text-right">{t("common.status")}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((e) => (
                <tr key={e.id} className="border-t border-zinc-800">
                  <td className="p-3 text-xs text-zinc-500">{new Date(e.ts).toLocaleTimeString()}</td>
                  <td className="p-3">{nameOf(e.keyId)}</td>
                  <td className="p-3">{e.provider}</td>
                  <td className="p-3 text-xs text-zinc-400">{e.model}</td>
                  <td className="p-3 text-right">
                    <span className={`rounded px-2 py-0.5 text-xs ${e.status === "ok" ? "bg-emerald-900 text-emerald-300" : "bg-red-900 text-red-300"}`}>
                      {e.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function ApiManager() {
  const { t } = useLang();
  const [tab, setTab] = useState("keys");
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [entries, setEntries] = useState<InspectEntry[]>([]);
  const [error, setError] = useState("");

  const refresh = () => {
    api.keys().then(setKeys).catch((e) => setError(String(e)));
    api.inspector().then(setEntries).catch(() => {});
  };
  useEffect(refresh, []);

  const perKey = useMemo(() => {
    const m = new Map<string, { requests: number; errors: number; cost: number }>();
    for (const e of entries) {
      const k = e.keyId ?? "(no key)";
      const cur = m.get(k) ?? { requests: 0, errors: 0, cost: 0 };
      cur.requests += 1;
      if (e.status === "error") cur.errors += 1;
      cur.cost += e.costUsd;
      m.set(k, cur);
    }
    return m;
  }, [entries]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("common.keyManager")}</h1>
        <button
          onClick={refresh}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
        >{t("common.refresh")}</button>
      </div>
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "keys", label: "Keys" },
          { id: "routing", label: "Routing" },
          { id: "access", label: "Access" },
        ]}
      />
      {error && <p className="mb-4 text-red-400">{error}</p>}
      {tab === "keys" && <KeysTab keys={keys} perKey={perKey} />}
      {tab === "routing" && (
        <TabEmpty>
          <p className="mb-2 font-medium text-zinc-200">{t("apimanager.noRoutingRules")}</p>
          <p>
            Routing strategy is global (Settings → Routing). Per-request overrides use the{" "}
            <code className="rounded bg-zinc-800 px-1 text-xs">x-llmswitch-strategy</code>{t("apimanager.pinningNote")}<code className="rounded bg-zinc-800 px-1 text-xs">provider:model</code>{" "}
            model syntax — both work with any key.
          </p>
        </TabEmpty>
      )}
      {tab === "access" && <AccessTab entries={entries} keys={keys} />}
    </div>
  );
}
