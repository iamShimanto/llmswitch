import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type BatchJob } from "../api";
import { Tabs, TabEmpty } from "../components/Tabs";

function Jobs() {
  const { t } = useLang();
  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = () => {
    api.batches()
      .then((r) => {
        setJobs(r.data ?? []);
        setSupported(r.supported !== false);
      })
      .catch((e) => setError(String(e)));
  };
  useEffect(load, []);

  const cancel = async (id: string) => {
    if (!confirm(t("common.confirmCancelBatch", { id }))) return;
    setBusy(id);
    try {
      await api.cancelBatch(id);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button
          onClick={load}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
        >{t("common.refresh")}</button>
      </div>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-zinc-400">
            <tr>
              <th className="p-3">{t("common.batchId")}</th>
              <th className="p-3">{t("common.status")}</th>
              <th className="p-3">{t("common.endpoint")}</th>
              <th className="p-3">{t("common.created")}</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className="border-t border-zinc-800">
                <td className="p-3 font-mono text-xs">{j.id}</td>
                <td className="p-3">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      j.status === "completed"
                        ? "bg-emerald-900 text-emerald-300"
                        : j.status === "failed" || j.status === "cancelled"
                          ? "bg-red-900 text-red-300"
                          : "bg-amber-900 text-amber-300"
                    }`}
                  >
                    {j.status ?? "?"}
                  </span>
                </td>
                <td className="p-3 text-zinc-400">{j.endpoint ?? "—"}</td>
                <td className="p-3 text-zinc-400">
                  {j.created_at ? new Date(j.created_at * 1000).toLocaleString() : "—"}
                </td>
                <td className="p-3 text-right">
                  {j.status !== "completed" && j.status !== "cancelled" && (
                    <button
                      onClick={() => cancel(j.id)}
                      disabled={busy === j.id}
                      className="rounded-lg border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-900 disabled:opacity-50"
                    >
                      {busy === j.id ? "…" : "Cancel"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {jobs.length === 0 && !error && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-zinc-500">
                  {supported
                    ? "No batch jobs yet."
                    : "No connected provider supports the Batches API yet — it is an OpenAI feature. Connect OpenAI to create and list batch jobs."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs text-zinc-500">{t("batches.lists_batches_via_the_first_connected_op")}</p>
    </div>
  );
}

export default function Batches() {
  const { t } = useLang();
  const [tab, setTab] = useState("jobs");
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.batches")}</h1>
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "jobs", label: "Jobs" },
          { id: "files", label: "Files" },
        ]}
      />
      {tab === "jobs" && <Jobs />}
      {tab === "files" && (
        <TabEmpty>
          <p className="mb-2 font-medium text-zinc-200">{t("batches.noFileApi")}</p>
          <p>
            Batch input files live on the upstream provider. Use{" "}
            <code className="rounded bg-zinc-800 px-1 text-xs">POST /v1/files</code> (multipart upload),{" "}
            <code className="rounded bg-zinc-800 px-1 text-xs">GET /v1/files</code> and{" "}
            <code className="rounded bg-zinc-800 px-1 text-xs">DELETE /v1/files/:id</code>{t("batches.gatewayKey")}</p>
        </TabEmpty>
      )}
    </div>
  );
}
