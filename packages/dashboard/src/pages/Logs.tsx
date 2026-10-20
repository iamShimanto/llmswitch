import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import {
  api,
  subscribeLive,
  type InspectEntry,
  type KeyRecord,
  type RequestLogRow,
} from "../api";
import { Tabs, TabEmpty } from "../components/Tabs";

const LEVELS = ["debug", "info", "warn", "error"] as const;

const LOG_PAGE_SIZE = 25;

function RequestLogs() {
  const { t } = useLang();
  const [logs, setLogs] = useState<RequestLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [q, setQ] = useState("");
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState("");
  const [keyId, setKeyId] = useState("");
  const [providerIds, setProviderIds] = useState<string[]>([]);
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api.providers().then((ps) => setProviderIds(ps.map((p) => p.id).sort())).catch(() => {});
    api.keys().then(setKeys).catch(() => {});
  }, []);

  useEffect(() => {
    setError("");
    api
      .logs({
        q: q || undefined,
        provider: provider || undefined,
        status: status || undefined,
        key: keyId || undefined,
        limit: LOG_PAGE_SIZE,
        offset: page * LOG_PAGE_SIZE,
      })
      .then((r) => {
        setLogs(r.logs);
        setTotal(r.total);
      })
      .catch((e) => setError(String(e)));
  }, [q, provider, status, keyId, page, tick]);

  // Live tail: new requests stream in when the view is unfiltered, page 1.
  useEffect(() => {
    const unfiltered = !q && !provider && !status && !keyId;
    const unsub = subscribeLive({
      onRequest: (entry) => {
        if (!unfiltered || page !== 0) return;
        const row: RequestLogRow = {
          id: entry.id,
          ts: entry.ts,
          keyId: entry.keyId,
          provider: entry.provider,
          model: entry.model,
          strategy: entry.strategy,
          status: entry.status,
          latencyMs: entry.latencyMs,
          promptTokens: entry.promptTokens,
          completionTokens: entry.completionTokens,
          costUsd: entry.costUsd,
          cached: entry.cached,
          request: entry.request,
          responsePreview: entry.responsePreview,
        };
        setLogs((prev) => [row, ...prev.filter((l) => l.id !== row.id)].slice(0, LOG_PAGE_SIZE));
        setTotal((n) => n + 1);
      },
    });
    return unsub;
  }, [q, provider, status, keyId, page]);

  const pages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));
  const inputCls = "rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm";
  const filtered = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setPage(0); };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-sm text-zinc-500">
          {total.toLocaleString()} {t("logs.records")} · {t("logs.persistedNote")}
        </span>
        <button
          onClick={() => setTick((x) => x + 1)}
          className="ml-auto rounded-lg bg-zinc-800 px-4 py-1.5 text-sm font-medium hover:bg-zinc-700"
        >
          {t("logs.refresh")}
        </button>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => filtered(setQ)(e.target.value)}
          placeholder={t("logs.searchPlaceholder")}
          className={`${inputCls} min-w-[200px] flex-1`}
        />
        <select value={provider} onChange={(e) => filtered(setProvider)(e.target.value)} className={inputCls}>
          <option value="">{t("logs.allProviders")}</option>
          {providerIds.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select value={status} onChange={(e) => filtered(setStatus)(e.target.value)} className={inputCls}>
          <option value="">{t("logs.allStatuses")}</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
        </select>
        <select value={keyId} onChange={(e) => filtered(setKeyId)(e.target.value)} className={inputCls}>
          <option value="">{t("logs.allKeys")}</option>
          {keys.map((k) => (
            <option key={k.id} value={k.id}>{k.name}</option>
          ))}
        </select>
      </div>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <div className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900">
        {logs.length === 0 && <p className="p-4 text-sm text-zinc-500">{t("logs.empty")}</p>}
        {logs.map((l) => (
          <div key={l.id} className="px-4">
            <button
              onClick={() => setOpenId(openId === l.id ? null : l.id)}
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-left"
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${l.status === "ok" ? "bg-emerald-400" : "bg-red-400"}`} />
              <span className="text-xs text-zinc-500">{new Date(l.ts).toLocaleString([], { hour12: false })}</span>
              <span className="font-mono text-xs font-medium text-zinc-100">{l.provider}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-400">{l.model}</span>
              {l.cached && <span className="rounded-full bg-sky-900 px-2 py-0.5 text-[10px] text-sky-300">cache</span>}
              <span className="text-xs text-zinc-500">{l.strategy}</span>
              <span className="text-xs text-zinc-400">{l.promptTokens}→{l.completionTokens} tok</span>
              <span className="text-xs text-zinc-400">${l.costUsd.toFixed(4)}</span>
              <span className="w-16 text-right text-xs text-zinc-300">{l.latencyMs} ms</span>
            </button>
            {openId === l.id && (
              <div className="pb-3 pl-5 text-xs text-zinc-400">
                {l.request.map((m, i) => (
                  <p key={i} className="mb-1">
                    <span className="font-semibold text-zinc-300">{m.role}:</span> {m.content.slice(0, 400)}
                  </p>
                ))}
                {l.responsePreview && (
                  <p className="mt-2 rounded-lg bg-zinc-950 p-2 text-zinc-300">{l.responsePreview}</p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between text-sm">
        <button disabled={page <= 0} onClick={() => setPage((p) => p - 1)} className="rounded-lg border border-zinc-700 px-4 py-1.5 disabled:opacity-40">
          ← {t("logs.prev")}
        </button>
        <span className="text-zinc-500">{page + 1} / {pages}</span>
        <button disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)} className="rounded-lg border border-zinc-700 px-4 py-1.5 disabled:opacity-40">
          {t("logs.next")} →
        </button>
      </div>
    </div>
  );
}

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
  const [tab, setTab] = useState("requests");
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.logs")}</h1>
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "requests", label: "Requests" },
          { id: "activity", label: "Activity" },
          { id: "console", label: "Console" },
          { id: "proxy", label: "Proxy" },
          { id: "timeline", label: "Timeline" },
        ]}
      />
      {tab === "requests" && <RequestLogs />}
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
