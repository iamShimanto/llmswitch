import { useEffect, useMemo, useState } from "react";
import { useLang } from "../i18n";
import { api, type InspectEntry } from "../api";

export default function Conversations() {
  const { t } = useLang();
  const [entries, setEntries] = useState<InspectEntry[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.inspector().then(setEntries).catch((e) => setError(String(e)));
  }, []);

  // group by calendar day (the inspector keeps no session ids — this is recent
  // request history, newest day first)
  const groups = useMemo(() => {
    const m = new Map<string, InspectEntry[]>();
    for (const e of [...entries].sort((a, b) => b.ts - a.ts)) {
      const day = new Date(e.ts).toLocaleDateString();
      if (!m.has(day)) m.set(day, []);
      m.get(day)!.push(e);
    }
    return [...m.entries()];
  }, [entries]);

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold">{t("nav.conversations")}</h1>
      <p className="mb-6 text-sm text-zinc-500">{t("conversations.recent_request_history_from_the_inspecto")}</p>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      {groups.map(([day, list]) => (
        <div key={day} className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-zinc-400">
            {day} <span className="font-normal">({list.length})</span>
          </h2>
          <div className="space-y-2">
            {list.map((e) => (
              <div key={e.id} className="rounded-xl border border-zinc-800 bg-zinc-900">
                <button
                  onClick={() => setOpen(open === e.id ? null : e.id)}
                  className="flex w-full items-center justify-between px-4 py-2.5 text-left"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${e.status === "ok" ? "bg-emerald-500" : "bg-red-500"}`}
                    />
                    <span className="text-sm font-medium">{e.provider}</span>
                    <span className="truncate text-xs text-zinc-500">
                      {(e.request.find((m) => m.role === "user")?.content ?? "").slice(0, 80)}
                    </span>
                  </div>
                  <span className="shrink-0 text-xs text-zinc-500">
                    {new Date(e.ts).toLocaleTimeString()} · {e.latencyMs}ms
                  </span>
                </button>
                {open === e.id && (
                  <div className="border-t border-zinc-800 px-4 py-3">
                    <p className="mb-1 text-xs font-semibold text-zinc-500">{t("common.requestLabel")}</p>
                    <div className="mb-3 space-y-1">
                      {e.request.map((m, i) => (
                        <p key={i} className="text-xs text-zinc-300">
                          <span className="font-mono text-sky-300">{m.role}:</span>{" "}
                          {m.content.slice(0, 2000)}
                        </p>
                      ))}
                    </div>
                    <p className="mb-1 text-xs font-semibold text-zinc-500">{t("common.responsePreview")}</p>
                    <p className="whitespace-pre-wrap text-xs text-zinc-300">{e.responsePreview}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      {groups.length === 0 && !error && (
        <p className="text-sm text-zinc-500">{t("common.noConversations")}</p>
      )}
    </div>
  );
}
