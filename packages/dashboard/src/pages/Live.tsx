import { useEffect, useRef, useState } from "react";
import { getAdminKey, getSession, type InspectEntry, type LiveStats } from "../api";
import { useLang } from "../i18n";

interface RoutingEvent {
  ts: number;
  type: string;
  providerId?: string;
  strategy?: string;
  model?: string;
  latencyMs?: number;
  kind?: string;
}

const MAX_ENTRIES = 120;

export default function Live() {
  const { t } = useLang();
  const [entries, setEntries] = useState<InspectEntry[]>([]);
  const [routing, setRouting] = useState<RoutingEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [stats, setStats] = useState<LiveStats | null>(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const bufferRef = useRef<InspectEntry[]>([]);

  useEffect(() => {
    let aborted = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = async () => {
      try {
        const headers: Record<string, string> = {};
        const ak = getAdminKey();
        const sess = getSession();
        if (ak) headers["x-admin-key"] = ak;
        if (sess) headers["x-dashboard-session"] = sess;
        const res = await fetch("/api/live", { headers });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        setConnected(true);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done || aborted) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = "message";
            let data = "";
            for (const line of chunk.split("\n")) {
              if (line.startsWith("event: ")) event = line.slice(7).trim();
              else if (line.startsWith("data: ")) data += line.slice(6);
            }
            if (!data) continue;
            try {
              const parsed = JSON.parse(data);
              if (event === "snapshot") {
                setEntries(parsed.entries ?? []);
                setRouting(parsed.routing ?? []);
              } else if (event === "request") {
                const entry = parsed as InspectEntry;
                if (pausedRef.current) {
                  bufferRef.current = [entry, ...bufferRef.current].slice(0, MAX_ENTRIES);
                } else {
                  setEntries((prev) => [entry, ...prev].slice(0, MAX_ENTRIES));
                }
              } else if (event === "stats") {
                setStats(parsed as LiveStats);
              } else if (event === "routing") {
                setRouting((prev) => [parsed as RoutingEvent, ...prev].slice(0, 30));
              }
            } catch {
              /* ignore malformed events */
            }
          }
        }
      } catch {
        /* fall through to reconnect */
      }
      setConnected(false);
      if (!aborted) retry = setTimeout(connect, 3000);
    };

    connect();
    return () => {
      aborted = true;
      clearTimeout(retry);
    };
  }, []);

  // Flush the pause buffer when resuming.
  useEffect(() => {
    if (!paused && bufferRef.current.length > 0) {
      const buffered = bufferRef.current;
      bufferRef.current = [];
      setEntries((prev) => [...buffered, ...prev].slice(0, MAX_ENTRIES));
    }
  }, [paused]);

  const q = filter.trim().toLowerCase();
  const shown = entries.filter(
    (e) =>
      !q ||
      e.provider.toLowerCase().includes(q) ||
      e.model.toLowerCase().includes(q) ||
      e.status.includes(q),
  );
  const errors = shown.filter((e) => e.status === "error").length;
  const avgLatency =
    shown.length > 0 ? Math.round(shown.reduce((s, e) => s + e.latencyMs, 0) / shown.length) : 0;

  const card = "rounded-xl border border-zinc-800 bg-zinc-900 p-4";

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{t("live.title")}</h1>
        <span
          className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${
            connected ? "bg-emerald-900 text-emerald-300" : "bg-red-900 text-red-300"
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${connected ? "animate-pulse bg-emerald-400" : "bg-red-400"}`} />
          {connected ? t("live.streaming") : t("live.reconnecting")}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("live.filterPlaceholder")}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm"
          />
          <button
            onClick={() => setPaused((p) => !p)}
            className="rounded-lg bg-zinc-800 px-4 py-1.5 text-sm font-medium hover:bg-zinc-700"
          >
            {paused ? t("live.resume") : t("live.pause")}
          </button>
          <button
            onClick={() => {
              setEntries([]);
              bufferRef.current = [];
            }}
            className="rounded-lg border border-zinc-700 px-4 py-1.5 text-sm hover:bg-zinc-800"
          >
            {t("live.clear")}
          </button>
        </div>
      </div>

      {stats && (
        <div className="mb-4 flex flex-wrap gap-x-5 gap-y-1 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-xs text-zinc-400">
          <span>
            {t("live.today")}: <span className="font-semibold text-zinc-100">{stats.today.requests}</span>{" "}
            {t("live.requests").toLowerCase()}
          </span>
          <span>
            {t("live.errors")}: <span className="font-semibold text-red-400">{stats.today.errors}</span>
          </span>
          <span>
            Tokens:{" "}
            <span className="font-semibold text-zinc-100">
              {(stats.today.inputTokens + stats.today.outputTokens).toLocaleString()}
            </span>
          </span>
          <span>
            All-time: <span className="font-semibold text-zinc-100">{stats.totalRequests.toLocaleString()}</span>
          </span>
        </div>
      )}

      <div className="mb-4 grid grid-cols-3 gap-4">
        <div className={card}>
          <p className="text-xs text-zinc-500">{t("live.requests")}</p>
          <p className="mt-1 text-2xl font-bold">{shown.length}</p>
        </div>
        <div className={card}>
          <p className="text-xs text-zinc-500">{t("live.errors")}</p>
          <p className="mt-1 text-2xl font-bold">{errors}</p>
        </div>
        <div className={card}>
          <p className="text-xs text-zinc-500">{t("live.avgLatency")}</p>
          <p className="mt-1 text-2xl font-bold">{avgLatency} ms</p>
        </div>
      </div>

      <div className={`${card} divide-y divide-zinc-800 p-0`}>
        {shown.length === 0 && (
          <p className="p-4 text-sm text-zinc-500">{t("live.waiting")}</p>
        )}
        {shown.map((e) => (
          <div key={e.id} className="px-4">
            <button
              onClick={() => setOpenId(openId === e.id ? null : e.id)}
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-left"
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${e.status === "ok" ? "bg-emerald-400" : "bg-red-400"}`} />
              <span className="text-xs text-zinc-500">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="font-mono text-xs font-medium text-zinc-100">{e.provider}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-400">{e.model}</span>
              {e.cached && (
                <span className="rounded-full bg-sky-900 px-2 py-0.5 text-[10px] text-sky-300">cache</span>
              )}
              <span className="text-xs text-zinc-500">{e.strategy}</span>
              <span className="text-xs text-zinc-400">
                {e.promptTokens}→{e.completionTokens} tok
              </span>
              <span className="text-xs text-zinc-400">${e.costUsd.toFixed(4)}</span>
              <span className="w-16 text-right text-xs text-zinc-300">{e.latencyMs} ms</span>
            </button>
            {openId === e.id && (
              <div className="pb-3 pl-5 text-xs text-zinc-400">
                {e.request.map((m, i) => (
                  <p key={i} className="mb-1">
                    <span className="font-semibold text-zinc-300">{m.role}:</span>{" "}
                    {m.content.slice(0, 300)}
                  </p>
                ))}
                {e.responsePreview && (
                  <p className="mt-2 rounded-lg bg-zinc-950 p-2 text-zinc-300">{e.responsePreview}</p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {routing.length > 0 && (
        <div className="mt-4">
          <h2 className="mb-2 text-sm font-semibold text-zinc-400">{t("live.routingEvents")}</h2>
          <div className={`${card} space-y-1 p-3`}>
            {routing.slice(0, 10).map((r, i) => (
              <p key={i} className="font-mono text-[11px] text-zinc-500">
                {new Date(r.ts).toLocaleTimeString()} · {r.type}
                {r.providerId ? ` · ${r.providerId}` : ""}
                {r.model ? ` · ${r.model}` : ""}
                {r.kind ? ` · ${r.kind}` : ""}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
