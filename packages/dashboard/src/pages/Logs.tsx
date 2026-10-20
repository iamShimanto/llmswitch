import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type InspectEntry } from "../api";
import { Tabs, TabEmpty } from "../components/Tabs";

const LEVELS = ["debug", "info", "warn", "error"] as const;

function DiagnosticsExport() {
  const { t } = useLang();
  const [level, setLevel] = useState<string>("info");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const download = async () => {
    setBusy(true);
    setError("");
    try {
      const health = await api.health();
      const cfg = await api.getConfig();
      const safeConfig = {
        strategy: cfg.strategy.value,
        pii_redact: cfg.pii_redact.value,
        compression_default: cfg.compression_default.value,
        budget_action: cfg.budget_action.value,
        global_budget_usd: cfg.global_budget_usd.value,
        alert_webhook_configured: cfg.alert_webhook_url.value != null,
      };
      const bundle = {
        exportedAt: new Date().toISOString(),
        level,
        health,
        config: safeConfig,
        note: "Request-level logs live in the gateway server stdout.",
      };
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `llmswitch-diagnostics-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-3 font-semibold">{t("common.whereLogsGo")}</h2>
        <ul className="space-y-2 text-sm text-zinc-400">
          <li><code className="rounded bg-zinc-800 px-1">llmswitch serve</code> — terminal stdout</li>
          <li><code className="rounded bg-zinc-800 px-1">docker logs &lt;container&gt;</code> — container stdout</li>
          <li><code className="rounded bg-zinc-800 px-1">journalctl -u llmswitch</code> — systemd unit</li>
          <li><code className="rounded bg-zinc-800 px-1">pm2 logs llmswitch</code> — pm2</li>
        </ul>
        <p className="mt-3 text-xs text-zinc-500">{t("common.set")}<code className="rounded bg-zinc-800 px-1">LOG_LEVEL</code> (debug/info/warn/error) to
          control verbosity. PII redaction applies to inspector + audit logs, not raw stdout.
        </p>
      </div>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-3 font-semibold">{t("common.export")}</h2>
        {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-zinc-400">Minimum level (for future log API)</span>
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm"
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </label>
        <button
          onClick={download}
          disabled={busy}
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? "Building…" : "Download diagnostics bundle (.json)"}
        </button>
        <p className="mt-2 text-xs text-zinc-500">{t("common.healthDesc")}</p>
      </div>
    </div>
  );
}

function ProxyLog() {
  const { t } = useLang();
  const [entries, setEntries] = useState<InspectEntry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    api.inspector().then(setEntries).catch((e) => setError(String(e)));
  }, []);
  return (
    <div>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <p className="mb-4 text-sm text-zinc-500">
        Requests proxied through the gateway (from the inspector ring buffer — last 200).
      </p>
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-zinc-400">
            <tr>
              <th className="p-3">{t("apimanager.time")}</th>
              <th className="p-3">{t("common.provider")}</th>
              <th className="p-3">{t("common.model")}</th>
              <th className="p-3 text-right">{t("logs.latency")}</th>
              <th className="p-3 text-right">{t("common.status")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-zinc-800">
                <td className="p-3 text-xs text-zinc-500">{new Date(e.ts).toLocaleTimeString()}</td>
                <td className="p-3">{e.provider}</td>
                <td className="p-3 text-xs text-zinc-400">{e.model}</td>
                <td className="p-3 text-right">{e.latencyMs} ms</td>
                <td className="p-3 text-right">
                  <span className={`rounded px-2 py-0.5 text-xs ${e.status === "ok" ? "bg-emerald-900 text-emerald-300" : "bg-red-900 text-red-300"}`}>
                    {e.status}
                  </span>
                </td>
              </tr>
            ))}
            {entries.length === 0 && !error && (
              <tr><td colSpan={5} className="p-6 text-center text-zinc-500">{t("logs.noProxied")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Timeline() {
  const { t } = useLang();
  const [entries, setEntries] = useState<InspectEntry[]>([]);
  useEffect(() => {
    api.inspector().then(setEntries).catch(() => {});
  }, []);
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  const t0 = sorted[0]?.ts ?? 0;
  const t1 = sorted[sorted.length - 1]?.ts ?? 1;
  const span = Math.max(1, t1 - t0);
  return (
    <div>
      <p className="mb-4 text-sm text-zinc-500">Visual timeline of recent requests (oldest → newest).</p>
      {sorted.length === 0 ? (
        <TabEmpty>{t("logs.noTimeline")}</TabEmpty>
      ) : (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <div className="relative h-24">
            <div className="absolute left-0 right-0 top-1/2 h-px bg-zinc-700" />
            {sorted.map((e) => {
              const left = ((e.ts - t0) / span) * 100;
              return (
                <div
                  key={e.id}
                  title={`${e.provider}/${e.model} · ${e.latencyMs}ms · ${e.status}`}
                  className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ${
                    e.status === "ok" ? "bg-emerald-500" : "bg-red-500"
                  }`}
                  style={{ left: `${left}%` }}
                />
              );
            })}
          </div>
          <div className="mt-2 flex justify-between text-xs text-zinc-500">
            <span>{new Date(t0).toLocaleTimeString()}</span>
            <span>{sorted.length} requests</span>
            <span>{new Date(t1).toLocaleTimeString()}</span>
          </div>
          <div className="mt-3 flex gap-4 text-xs text-zinc-500">
            <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500" />{t("logs.ok")}</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-red-500" />{t("logs.error")}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Logs() {
  const { t } = useLang();
  const [tab, setTab] = useState("activity");
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.logs")}</h1>
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "activity", label: "Activity" },
          { id: "console", label: "Console" },
          { id: "proxy", label: "Proxy" },
          { id: "timeline", label: "Timeline" },
        ]}
      />
      {tab === "activity" && <DiagnosticsExport />}
      {tab === "console" && (
        <TabEmpty>
          <p className="mb-2 font-medium text-zinc-200">{t("logs.noStreamApi")}</p>
          <p>
            By design — server logs may contain request bodies. Tail them where the gateway runs:{" "}
            <code className="rounded bg-zinc-800 px-1 text-xs">llmswitch serve</code> stdout,{" "}
            <code className="rounded bg-zinc-800 px-1 text-xs">{t("logs.dockerLogs")}</code>, or{" "}
            <code className="rounded bg-zinc-800 px-1 text-xs">journalctl -u llmswitch</code>{t("logs.inspectorNote")}</p>
        </TabEmpty>
      )}
      {tab === "proxy" && <ProxyLog />}
      {tab === "timeline" && <Timeline />}
    </div>
  );
}
