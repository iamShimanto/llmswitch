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
              ) : p.accountQuotas && p.accountQuotas.length > 0 ? null : (
                <p className="text-xs text-zinc-500">{t("common.noRateLimit")}</p>
              )}
              {p.accountQuotas?.map((g) => (
                <div key={g.accountId ?? "default"} className="mt-3 border-t border-zinc-800 pt-3">
                  <p className="mb-2 text-xs font-medium text-zinc-300">{g.label}</p>
                  <div className="grid gap-2.5">
                    {g.buckets.map((b) => (
                      <div key={b.model}>
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate font-mono text-[11px] text-zinc-300" title={b.model}>
                            {b.model}
                          </span>
                          <span className="shrink-0 text-[11px] text-zinc-400">
                            {b.unlimited
                              ? "Unlimited"
                              : b.remainingPct != null
                                ? `${b.remainingPct}% left`
                                : "quota unknown"}
                          </span>
                        </div>
                        {b.remainingPct != null && !b.unlimited && (
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                            <div
                              className={`h-full rounded-full ${b.remainingPct < 20 ? "bg-red-500" : b.remainingPct < 50 ? "bg-amber-500" : "bg-emerald-500"}`}
                              style={{ width: `${b.remainingPct}%` }}
                            />
                          </div>
                        )}
                        {b.resetAt && (
                          <p className="mt-0.5 text-right text-[10px] text-zinc-500">
                            resets {new Date(b.resetAt).toLocaleString()}
                          </p>
                        )}
                      </div>
                    ))}
                    {g.buckets.length === 0 && (
                      <p className="text-[11px] text-zinc-500">No quota buckets reported.</p>
                    )}
                  </div>
                </div>
              ))}
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
