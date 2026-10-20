import { useLang } from "../i18n";
export default function Skills() {
  const { t } = useLang();
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.skills")}</h1>
      <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-900/50 p-10 text-center">
        <div className="mb-3 text-4xl">🧰</div>
        <h2 className="mb-2 text-lg font-semibold">{t("common.noSkills")}</h2>
        <p className="mx-auto max-w-md text-sm text-zinc-500">
          The skills system (reusable prompt packs) is on the roadmap and not yet implemented in
          the gateway — there is no <code className="rounded bg-zinc-800 px-1 text-xs">/api/skills</code>{" "}
          endpoint. This page will list, enable, and configure skills once the backend lands.
        </p>
        <p className="mt-4 text-xs text-zinc-600">{t("skills.meanwhile_compression_presets_routing_st")}</p>
      </div>
    </div>
  );
}
