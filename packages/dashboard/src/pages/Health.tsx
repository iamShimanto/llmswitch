import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type QuotaProvider } from "../api";

export default function Health() {
  const { t } = useLang();
  const [status, setStatus] = useState<string>("");
  const [gatewayProviders, setGatewayProviders] = useState<string[]>([]);
  const [quotas, setQuotas] = useState<QuotaProvider[]>([]);
  const [error, setError] = useState("");

  const load = () => {
    api.health()
      .then((h) => {
        setStatus(h.status);
        setGatewayProviders(h.providers ?? []);
      })
      .catch((e) => setError(String(e)));
    api.quotas().then((r) => setQuotas(r.providers)).catch(() => {});
  };
  useEffect(load, []);

  const dot = (q: QuotaProvider) => {
    if (!q.connected) return "bg-zinc-600";
    if (q.errors > 0 && q.calls > 0 && q.errors / q.calls > 0.5) return "bg-red-500";
    if (q.errors > 0) return "bg-amber-500";
    return "bg-emerald-500";
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("nav.health")}</h1>
        <button
          onClick={load}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
        >{t("common.refresh")}</button>
      </div>
      {error && <p className="mb-4 text-red-400">{error}</p>}

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs text-zinc-500">{t("common.gateway")}</p>
          <p className="mt-1 text-xl font-bold">
            <span className={`mr-2 inline-block h-3 w-3 rounded-full ${status === "ok" ? "bg-emerald-500" : "bg-red-500"}`} />
            {status || "—"}
          </p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs text-zinc-500">{t("common.providersUp")}</p>
          <p className="mt-1 text-xl font-bold">{gatewayProviders.length}</p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs text-zinc-500">Total errors (session)</p>
          <p className="mt-1 text-xl font-bold text-red-400">
            {quotas.reduce((n, q) => n + q.errors, 0)}
          </p>
        </div>
      </div>

      <h2 className="mb-3 font-semibold">{t("common.perProviderStatus")}</h2>
      <div className="grid gap-2 md:grid-cols-2">
        {quotas.map((q) => (
          <div key={q.id} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5">
            <div className="flex items-center gap-3">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot(q)}`} />
              <span className="text-sm font-medium">{q.id}</span>
              {!q.connected && <span className="text-xs text-zinc-600">{t("common.notConnected")}</span>}
            </div>
            <span className="text-xs text-zinc-500">
              {q.calls} calls · <span className="text-red-400">{q.errors} errors</span>
            </span>
          </div>
        ))}
        {quotas.length === 0 && !error && (
          <p className="text-sm text-zinc-500">{t("common.noTelemetry")}</p>
        )}
      </div>
      <p className="mt-4 text-xs text-zinc-600">
        Green = healthy · amber = some errors · red = mostly failing · gray = not connected.
      </p>
    </div>
  );
}
