import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type QuotaProvider } from "../api";

function resetLabel(resetAt: number | null): string {
  if (!resetAt) return "—";
  const ms = resetAt > 1e12 ? resetAt : resetAt * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default function Quotas() {
  const { t } = useLang();
  const [providers, setProviders] = useState<QuotaProvider[]>([]);
  const [error, setError] = useState("");

  const load = () => {
    api.quotas().then((r) => setProviders(r.providers)).catch((e) => setError(String(e)));
  };
  useEffect(load, []);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("nav.quotas")}</h1>
        <button
          onClick={load}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
        >{t("common.refresh")}</button>
      </div>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <p className="mb-4 text-sm text-zinc-500">{t("quotas.live_rate_limit_telemetry_parsed_from_up")}</p>
      <div className="grid gap-4 md:grid-cols-2">
        {providers.map((p) => {
          const tel = p.telemetry;
          const hasLimit = tel?.limit != null && tel.limit > 0;
          const used = hasLimit ? Math.max(0, (tel!.limit as number) - (tel!.remaining ?? 0)) : null;
          const pct = hasLimit ? Math.min(100, ((used ?? 0) / (tel!.limit as number)) * 100) : 0;
          return (
            <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-semibold">{p.id}</span>
                <span className="text-xs text-zinc-500">
                  {p.calls} calls · <span className="text-red-400">{p.errors} errors</span>
                </span>
              </div>
              {hasLimit ? (
                <>
                  <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className={`h-full rounded-full ${pct > 90 ? "bg-red-500" : pct > 70 ? "bg-amber-500" : "bg-emerald-500"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="mt-2 flex justify-between text-xs text-zinc-400">
                    <span>
                      {used} / {tel!.limit} used
                    </span>
                    <span>resets {resetLabel(tel!.resetAt)}</span>
                  </div>
                </>
              ) : (
                <p className="text-xs text-zinc-500">{t("common.noRateLimit")}</p>
              )}
            </div>
          );
        })}
        {providers.length === 0 && !error && (
          <p className="text-sm text-zinc-500">{t("common.noProviders")}</p>
        )}
      </div>
    </div>
  );
}
