import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type GatewayConfig } from "../api";

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
    </div>
  );
}
