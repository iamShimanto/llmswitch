import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type ProviderInfo } from "../api";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-sm text-zinc-400">{label}</div>
    </div>
  );
}

export default function Home() {
  const { t } = useLang();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.providers().then(setProviders).catch((e) => setError(String(e)));
  }, []);

  const calls = providers.reduce((s, p) => s + p.stats.calls, 0);
  const errors = providers.reduce((s, p) => s + p.stats.errors, 0);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.overview")}</h1>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Connected providers" value={providers.length} />
        <Stat label="Total requests" value={calls} />
        <Stat label="Errors" value={errors} />
        <Stat label="Endpoint" value="/v1" />
      </div>
      <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-2 font-semibold">{t("common.quickStart")}</h2>
        <p className="text-sm text-zinc-400">{t("common.pointClient")}</p>
        <code className="mt-2 block rounded bg-zinc-950 p-3 text-sm text-emerald-300">
          Base URL: {window.location.origin}/v1
          <br />
          Model: auto
        </code>
        <p className="mt-2 text-sm text-zinc-400">{t("common.createKeyOn")}{" "}<span className="text-zinc-200">{t("home.keys")}</span> page and send it as{" "}
          <code>Authorization: Bearer &lt;key&gt;</code>.
        </p>
      </div>
    </div>
  );
}
