import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type UsageRow } from "../api";

export default function Usage() {
  const { t } = useLang();
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.usage().then(setRows).catch((e) => setError(String(e)));
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.usage")}</h1>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-zinc-400">
            <tr>
              <th className="p-3">{t("common.provider")}</th>
              <th className="p-3">{t("common.model")}</th>
              <th className="p-3 text-right">{t("common.requests")}</th>
              <th className="p-3 text-right">{t("common.promptTok")}</th>
              <th className="p-3 text-right">{t("common.completionTok")}</th>
              <th className="p-3 text-right">{t("common.errors")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-zinc-800">
                <td className="p-3">{r.provider}</td>
                <td className="p-3 text-zinc-400">{r.model}</td>
                <td className="p-3 text-right">{r.requests}</td>
                <td className="p-3 text-right">{r.promptTokens}</td>
                <td className="p-3 text-right">{r.completionTokens}</td>
                <td className="p-3 text-right text-red-400">{r.errors}</td>
              </tr>
            ))}
            {rows.length === 0 && !error && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-zinc-500">
                  No usage yet — send a request to /v1/chat/completions.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
