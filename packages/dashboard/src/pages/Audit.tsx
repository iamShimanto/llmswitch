import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api } from "../api";
import { Tabs } from "../components/Tabs";

interface AuditRow {
  id: number;
  ts: number;
  action: string;
  detail: string;
}

function RowList({ rows }: { rows: AuditRow[] }) {
  const { t } = useLang();
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div
          key={r.id}
          className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm"
        >
          <div className="flex items-center justify-between gap-4">
            <span className="font-mono text-xs text-sky-300">{r.action}</span>
            <span className="shrink-0 text-xs text-zinc-500">
              {new Date(r.ts).toLocaleString()}
            </span>
          </div>
          <p className="mt-1 break-words text-xs text-zinc-400">{r.detail}</p>
        </div>
      ))}
      {rows.length === 0 && (
        <p className="text-sm text-zinc-500">{t("common.noAudit")}</p>
      )}
    </div>
  );
}

export default function Audit() {
  const { t } = useLang();
  const [tab, setTab] = useState("all");
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");

  const load = () => {
    api.audit().then((r) => setRows(r)).catch((e) => setError(String(e)));
  };
  useEffect(load, []);

  const byTab =
    tab === "a2a"
      ? rows.filter((r) => /a2a/i.test(r.action) || /a2a/i.test(r.detail))
      : tab === "mcp"
        ? rows.filter((r) => /mcp/i.test(r.action) || /mcp/i.test(r.detail))
        : rows;

  const shown = byTab.filter(
    (r) =>
      !filter ||
      r.action.toLowerCase().includes(filter.toLowerCase()) ||
      r.detail.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("common.auditLog")}</h1>
        <button
          onClick={load}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
        >{t("common.refresh")}</button>
      </div>
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "all", label: "All" },
          { id: "a2a", label: "A2A" },
          { id: "mcp", label: "MCP" },
        ]}
      />
      {error && <p className="mb-4 text-red-400">{error}</p>}
      {(tab === "a2a" || tab === "mcp") && byTab.length === 0 && !error && (
        <p className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-500">
          No {tab.toUpperCase()} audit entries yet. Entries appear here when {tab.toUpperCase()}{" "}
          activity is logged with PII redaction applied.
        </p>
      )}
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={t("common.filterAudit")}
        className="mb-4 w-full max-w-sm rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
      />
      <RowList rows={shown} />
    </div>
  );
}
