import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type GatewayConfig } from "../api";

interface BackupRow {
  name: string;
  sizeBytes: number;
  createdAt: number;
}

function Backups() {
  const [rows, setRows] = useState<BackupRow[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => {
    api.backups().then((r) => setRows(r.backups)).catch(() => {});
  };
  useEffect(load, []);

  const create = async () => {
    setBusy(true);
    setMsg("");
    try {
      await api.createBackup();
      load();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };
  const restore = async (name: string) => {
    if (!confirm(`Restore the database from ${name}? The gateway must be restarted afterwards; the current database is kept as a .pre-restore copy.`)) return;
    setMsg("");
    try {
      await api.restoreBackup(name);
      setMsg("Restore staged — restart the gateway (container) to apply it.");
    } catch (e) {
      setMsg(String(e));
    }
  };
  const del = async (name: string) => {
    if (!confirm(`Delete backup ${name}?`)) return;
    await api.deleteBackup(name).catch(() => {});
    load();
  };
  const kb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-sm text-zinc-500">Database backups</p>
        <button onClick={create} disabled={busy} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium hover:bg-zinc-700 disabled:opacity-50">
          {busy ? "Backing up…" : "＋ Back up now"}
        </button>
      </div>
      <p className="mb-3 text-xs text-zinc-500">
        Full SQLite snapshot — API keys, provider accounts, sessions, settings and usage.
        Automatic backups run daily and keep the newest 7.
      </p>
      {msg && <p className="mb-2 text-xs text-amber-300">{msg}</p>}
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">No backups yet.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((b) => (
            <div key={b.name} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{b.name}</span>
              <span className="shrink-0 text-xs text-zinc-500">
                {kb(b.sizeBytes)} · {new Date(b.createdAt).toLocaleString()}
              </span>
              <button onClick={() => api.downloadBackup(b.name).catch((e) => setMsg(String(e)))} className="shrink-0 rounded-lg border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800">
                Download
              </button>
              <button onClick={() => restore(b.name)} className="shrink-0 rounded-lg border border-amber-800 px-2 py-1 text-xs text-amber-300 hover:bg-amber-950">
                Restore
              </button>
              <button onClick={() => del(b.name)} className="shrink-0 rounded-lg border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800">
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Runtime() {
  const { t } = useLang();
  const [providers, setProviders] = useState<string[]>([]);
  const [cfg, setCfg] = useState<GatewayConfig | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.health().then((h) => setProviders(h.providers)).catch((e) => setError(String(e)));
    api.getConfig().then(setCfg).catch((e) => setError(String(e)));
  }, []);

  const card = "rounded-xl border border-zinc-800 bg-zinc-900 p-4";
  const na = <span className="text-zinc-600">{t("common.notExposedApi")}</span>;

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.runtime")}</h1>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <div className={card}>
          <p className="mb-1 text-sm text-zinc-500">{t("common.gatewayVersion")}</p>
          <p className="text-xl font-bold">llmswitch 0.1.0</p>
          <p className="mt-1 text-xs text-zinc-500">From /healthz (public endpoint).</p>
        </div>
        <div className={card}>
          <p className="mb-1 text-sm text-zinc-500">{t("common.connectedProviders")}</p>
          <p className="text-xl font-bold">{providers.length}</p>
          <p className="mt-1 truncate text-xs text-zinc-500" title={providers.join(", ")}>
            {providers.slice(0, 6).join(", ")}{providers.length > 6 ? "…" : ""}
          </p>
        </div>
        <div className={card}>
          <p className="mb-1 text-sm text-zinc-500">{t("common.activeStrategy")}</p>
          <p className="text-xl font-bold">{cfg ? cfg.strategy.value : "…"}</p>
          <p className="mt-1 text-xs text-zinc-500">{t("common.changeOnSettings")}</p>
        </div>
        <div className={card}>
          <p className="mb-1 text-sm text-zinc-500">{t("common.nodePlatform")}</p>
          <p className="text-sm text-zinc-400">{na}</p>
          <p className="mt-1 text-xs text-zinc-500">
            The gateway does not expose host internals. Check the server process directly
            (<code className="rounded bg-zinc-800 px-1">node --version</code>, <code className="rounded bg-zinc-800 px-1">process.memoryUsage()</code>).
          </p>
        </div>
      </div>
      <div className="mt-4">
        <Backups />
      </div>
    </div>
  );
}
