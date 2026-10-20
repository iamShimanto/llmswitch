import { useEffect, useState } from "react";
import { useLang } from "../i18n";

interface RoutingEvent {
  ts: number;
  type: string;
  providerId?: string;
  strategy?: string;
  model?: string;
  latencyMs?: number;
  cached?: boolean;
  kind?: string;
  consecutiveFailures?: number;
}

interface Quality {
  calls: number;
  errors: number;
  avgLatencyMs: number;
  errorRate: number;
}

export default function Explain() {
  const { t } = useLang();
  const [events, setEvents] = useState<RoutingEvent[]>([]);
  const [quality, setQuality] = useState<Record<string, Quality>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    const headers: Record<string, string> = {};
    const k = localStorage.getItem("llmswitch_admin_key");
    if (k) headers["x-admin-key"] = k;
    fetch("/api/explain/routing", { headers })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((j) => {
        setEvents(j.events ?? []);
        setQuality(j.quality ?? {});
      })
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("common.routingExplainability")}</h1>
      {error && <p className="mb-4 text-red-400">{error}</p>}

      <h2 className="mb-3 text-lg font-semibold">{t("common.providerQuality")}</h2>
      <div className="mb-8 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(quality).map(([id, q]) => (
          <div key={id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
            <div className="font-medium">{id}</div>
            <div className="mt-1 text-xs text-zinc-400">
              {q.calls} calls · {q.errors} errors · avg {q.avgLatencyMs}ms ·{" "}
              {(q.errorRate * 100).toFixed(1)}% err
            </div>
          </div>
        ))}
        {Object.keys(quality).length === 0 && (
          <p className="text-sm text-zinc-500">{t("common.noRoutingData")}</p>
        )}
      </div>

      <h2 className="mb-3 text-lg font-semibold">{t("common.recentRouting")}</h2>
      <div className="space-y-2">
        {events.map((e, i) => (
          <div
            key={i}
            className="rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-sm"
          >
            <div className="flex items-center justify-between">
              <span
                className={
                  e.type === "routed"
                    ? "text-emerald-400"
                    : e.type === "provider_failed"
                      ? "text-red-400"
                      : "text-amber-400"
                }
              >
                {e.type}
              </span>
              <span className="text-xs text-zinc-500">
                {new Date(e.ts).toLocaleTimeString()}
              </span>
            </div>
            <div className="mt-1 text-xs text-zinc-400">
              {[e.providerId, e.model, e.strategy && `strategy=${e.strategy}`, e.latencyMs != null && `${e.latencyMs}ms`, e.cached && "cached", e.kind, e.consecutiveFailures != null && t("explain.fails", { n: e.consecutiveFailures })]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
        ))}
        {events.length === 0 && (
          <p className="text-sm text-zinc-500">{t("common.noEvents")}</p>
        )}
      </div>
    </div>
  );
}
