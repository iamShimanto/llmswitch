import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type GatewayConfig } from "../api";

export default function Webhooks() {
  const { t } = useLang();
  const [cfg, setCfg] = useState<GatewayConfig | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const load = () => {
    api.getConfig()
      .then((c) => {
        setCfg(c);
        setUrl(c.alert_webhook_url.value ?? "");
      })
      .catch((e) => setError(String(e)));
  };
  useEffect(load, []);

  const save = async () => {
    setError("");
    setSaved("");
    try {
      const c = await api.putConfig({ alert_webhook_url: url.trim() || null });
      setCfg(c);
      setSaved(t("settings.savedRestarts"));
      setTimeout(() => setSaved(""), 3000);
    } catch (e) {
      setError(String(e));
    }
  };

  const card = "rounded-xl border border-zinc-800 bg-zinc-900 p-4";

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.webhooks")}</h1>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      {saved && <p className="mb-4 text-emerald-400">{saved}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <div className={card}>
          <h2 className="mb-3 font-semibold">{t("common.alertWebhook")}</h2>
          <p className="mb-3 text-sm text-zinc-400">
            Fired on budget breaches, provider outages and quota exhaustion. POSTs JSON{" "}
            <code className="rounded bg-zinc-800 px-1">{"{ type, message, ts }"}</code>.
          </p>
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-400">{t("common.webhookUrl")}</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://… — empty = disabled"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            />
          </label>
          <div className="mt-3 flex gap-2">
            <button onClick={save} className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium hover:bg-sky-500">{t("common.save")}</button>
            <button
              disabled
              title={t("common.noTestFire")}
              className="cursor-not-allowed rounded-lg border border-zinc-700 px-4 py-1.5 text-sm opacity-40"
            >{t("common.testFire")}</button>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            {cfg?.alert_webhook_url.enabled ? "Alerts enabled ✓" : "No webhook — alerts disabled."}{" "}
            Test-fire is not implemented server-side yet.
          </p>
        </div>
        <div className={card}>
          <h2 className="mb-3 font-semibold">{t("common.recentDeliveries")}</h2>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-center text-sm text-zinc-500">{t("common.noDeliveryLog")}<br />
            <span className="text-xs">{t("common.checkWebhookLogs")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
