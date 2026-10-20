import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type SessionMeta } from "../api";

function statusOf(s: SessionMeta): { label: string; cls: string } {
  if (s.expiresAt && s.expiresAt < Date.now()) return { label: "expired", cls: "bg-red-900 text-red-300" };
  if (s.expiresAt) return { label: "valid", cls: "bg-emerald-900 text-emerald-300" };
  return { label: "no expiry", cls: "bg-zinc-800 text-zinc-300" };
}

export default function Sessions() {
  const { t } = useLang();
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [error, setError] = useState("");

  const load = () => {
    api.sessions().then((r) => setSessions(r.sessions)).catch((e) => setError(String(e)));
  };
  useEffect(load, []);

  const remove = async (name: string) => {
    if (!confirm(t("common.confirmDeleteSession", { name }))) return;
    try {
      await api.deleteSession(name);
      load();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("sessions.web_sessions")}</h1>
        <button
          onClick={load}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
        >{t("common.refresh")}</button>
      </div>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <p className="mb-4 text-sm text-zinc-500">{t("common.sessionsSavedBy")}<code className="text-zinc-300">llmswitch login</code> (OAuth device flow)
        or <code className="text-zinc-300">llmswitch cookies</code> (browser cookie import).
        Only metadata is shown here — tokens and cookies never leave the server.
      </p>
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-zinc-400">
            <tr>
              <th className="p-3">{t("common.name")}</th>
              <th className="p-3">{t("common.kind")}</th>
              <th className="p-3">{t("common.detail")}</th>
              <th className="p-3">{t("common.saved")}</th>
              <th className="p-3">{t("common.status")}</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => {
              const st = statusOf(s);
              return (
                <tr key={s.name} className="border-t border-zinc-800">
                  <td className="p-3 font-mono">{s.name}</td>
                  <td className="p-3 text-zinc-400">{s.kind}</td>
                  <td className="p-3 text-zinc-400">{s.provider ?? s.cookieDomain ?? "—"}</td>
                  <td className="p-3 text-zinc-400">
                    {s.savedAt ? new Date(s.savedAt).toLocaleString() : "—"}
                  </td>
                  <td className="p-3">
                    <span className={`rounded px-2 py-0.5 text-xs ${st.cls}`}>{st.label}</span>
                  </td>
                  <td className="p-3 text-right">
                    <button
                      onClick={() => remove(s.name)}
                      className="rounded-lg border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-900"
                    >{t("common.delete")}</button>
                  </td>
                </tr>
              );
            })}
            {sessions.length === 0 && !error && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-zinc-500">{t("common.noSessions")}<code className="text-zinc-300">llmswitch login</code> or{" "}
                  <code className="text-zinc-300">llmswitch cookies</code>{t("sessions.on_the_server")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
