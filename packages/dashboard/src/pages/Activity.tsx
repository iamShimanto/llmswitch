import { useEffect, useRef, useState } from "react";
import { useLang } from "../i18n";
import { api, type InspectEntry } from "../api";

export default function Activity() {
  const { t } = useLang();
  const [entries, setEntries] = useState<InspectEntry[]>([]);
  const [auto, setAuto] = useState(true);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = () => {
    api.inspector().then((r) => setEntries(r.slice(0, 50))).catch((e) => setError(String(e)));
  };

  useEffect(() => {
    load();
    if (auto) timer.current = setInterval(load, 5000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [auto]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("nav.activity")}</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-zinc-400">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            Auto-refresh (5s)
          </label>
          <button
            onClick={load}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
          >{t("common.refresh")}</button>
        </div>
      </div>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <p className="mb-4 text-sm text-zinc-500">
        Live request feed from the inspector ring buffer (last 200 requests).
      </p>
      <div className="space-y-2">
        {entries.map((e) => (
          <div
            key={e.id}
            className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5"
          >
            <div className="flex items-center gap-3">
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full ${e.status === "ok" ? "bg-emerald-500" : "bg-red-500"}`}
                title={e.status}
              />
              <div>
                <span className="text-sm font-medium">{e.provider}</span>
                <span className="ml-2 text-xs text-zinc-500">{e.model}</span>
                {e.cached && (
                  <span className="ml-2 rounded bg-sky-900 px-1.5 py-0.5 text-xs text-sky-300">{t("common.cached")}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-4 text-xs text-zinc-500">
              <span>{e.strategy}</span>
              <span>{e.latencyMs}ms</span>
              <span>${e.costUsd.toFixed(6)}</span>
              <span>{new Date(e.ts).toLocaleTimeString()}</span>
            </div>
          </div>
        ))}
        {entries.length === 0 && !error && (
          <p className="text-sm text-zinc-500">{t("common.noRequestsTraffic")}</p>
        )}
      </div>
    </div>
  );
}
