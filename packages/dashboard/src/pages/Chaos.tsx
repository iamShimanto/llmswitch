import { useLang } from "../i18n";
export default function Chaos() {
  const { t } = useLang();
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("common.chaosTesting")}</h1>
      <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-900/50 p-10 text-center">
        <div className="mb-3 text-4xl">🌪️</div>
        <h2 className="mb-2 text-lg font-semibold">{t("common.notImplemented")}</h2>
        <p className="mx-auto max-w-md text-sm text-zinc-500">{t("common.thereIsNo")}<code className="rounded bg-zinc-800 px-1 text-xs">/api/chaos/*</code>{t("chaos.endpoint_in_the_gateway_failure_latency")}</p>
        <div className="mx-auto mt-6 grid max-w-lg gap-2 opacity-40">
          {["Simulate provider failure", "Inject 2s latency", "Force fallback chain", "Drop 50% of requests"].map(
            (label) => (
              <button
                key={label}
                disabled
                className="cursor-not-allowed rounded-lg border border-zinc-700 px-4 py-2 text-sm"
              >
                {label}
              </button>
            ),
          )}
        </div>
        <p className="mx-auto mt-6 max-w-md text-xs text-zinc-600">{t("common.workarounds")}<code className="rounded bg-zinc-800 px-1">llmswitch bench</code>{t("chaos.for_latency_reality_stop_a_provider_s_ke")}</p>
      </div>
    </div>
  );
}
