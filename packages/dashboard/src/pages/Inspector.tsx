import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type InspectEntry } from "../api";

export default function Inspector() {
  const { t } = useLang();
  const [entries, setEntries] = useState<InspectEntry[]>([]);
  const [open, setOpen] = useState<InspectEntry | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.inspector().then(setEntries).catch((e) => setError(String(e)));
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("common.requestInspector")}</h1>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <div className="space-y-2">
        {entries.map((e) => (
          <button
            key={e.id}
            onClick={() => setOpen(open?.id === e.id ? null : e)}
            className="block w-full rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-left hover:border-zinc-600"
          >
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{e.provider} <span className="text-zinc-500">· {e.model}</span></span>
              <span className="flex gap-2 text-xs text-zinc-500">
                {e.cached && <span className="text-amber-400">{t("common.cached")}</span>}
                <span className={e.status === "ok" ? "text-emerald-400" : "text-red-400"}>{e.status}</span>
                <span>{e.latencyMs}ms</span>
                <span>{new Date(e.ts).toLocaleTimeString()}</span>
              </span>
            </div>
            {open?.id === e.id && (
              <div className="mt-3 space-y-2 text-sm">
                <p className="text-xs text-zinc-500">strategy: {e.strategy} · tokens: {e.promptTokens}/{e.completionTokens} · cost: ${e.costUsd.toFixed(6)}</p>
                {e.request.map((m, i) => (
                  <div key={i} className="rounded bg-zinc-950 p-2">
                    <span className="text-xs text-zinc-500">{m.role}: </span>
                    <span className="text-zinc-300">{m.content}</span>
                  </div>
                ))}
                <div className="rounded bg-zinc-950 p-2">
                  <span className="text-xs text-zinc-500">{t("common.response")}</span>
                  <span className="text-zinc-300">{e.responsePreview}</span>
                </div>
              </div>
            )}
          </button>
        ))}
        {entries.length === 0 && !error && (
          <p className="text-zinc-500">No requests yet — send one to /v1/chat/completions.</p>
        )}
      </div>
    </div>
  );
}
