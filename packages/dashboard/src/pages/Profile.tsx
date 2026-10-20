import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api } from "../api";

interface Health {
  status: string;
  version: string;
  providers: string[];
}

export default function Profile() {
  const { t } = useLang();
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.health().then(setHealth).catch((e) => setError(String(e)));
  }, []);

  const row = "rounded-xl border border-zinc-800 bg-zinc-900 p-4";

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.profile")}</h1>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      {!health && !error && <p className="text-zinc-500">{t("common.loading")}</p>}
      {health && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className={row}>
            <p className="mb-1 text-sm text-zinc-500">{t("common.gateway")}</p>
            <p className="text-xl font-bold">{t("common.brand")}</p>
            <p className="mt-1 text-sm text-zinc-400">{t("common.tagline")}</p>
          </div>
          <div className={row}>
            <p className="mb-1 text-sm text-zinc-500">{t("common.version")}</p>
            <p className="text-xl font-bold">{health.version}</p>
            <p className="mt-1 text-sm text-zinc-400">{t("common.license")}</p>
          </div>
          <div className={row}>
            <p className="mb-1 text-sm text-zinc-500">{t("common.status")}</p>
            <p className="text-xl font-bold text-emerald-400">{health.status}</p>
            <p className="mt-1 text-sm text-zinc-400">{health.providers.length} providers connected</p>
          </div>
          <div className={row}>
            <p className="mb-1 text-sm text-zinc-500">{t("common.environment")}</p>
            <p className="text-sm text-zinc-400">
              Runtime env (PORT, DATA_DIR, ADMIN_KEY…) is <span className="font-semibold">{t("common.notExposed")}</span>{t("common.viaApiByDesign")}</p>
            <p className="mt-2 text-sm text-zinc-400">
              Uptime is not tracked by the gateway yet; use your process manager.
            </p>
          </div>
          <div className={`${row} md:col-span-2`}>
            <p className="mb-1 text-sm text-zinc-500">{t("profile.admin_key")}</p>
            <p className="text-sm text-zinc-400">{t("common.rotateKey")}<code className="rounded bg-zinc-800 px-1">ADMIN_KEY</code>{t("profile.then_update_the_field_in_the_header_the")}</p>
          </div>
        </div>
      )}
    </div>
  );
}
