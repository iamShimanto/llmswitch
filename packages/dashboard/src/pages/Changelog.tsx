import { useEffect, useState } from "react";
import { useLang } from "../i18n";

export default function Changelog() {
  const { t } = useLang();
  const [text, setText] = useState<string | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    fetch("/CHANGELOG.md")
      .then(async (r) => {
        const t = await r.text();
        // the gateway's SPA fallback serves index.html for unknown paths —
        // detect that and fall back to the bundled note instead of rendering HTML
        if (t.trimStart().startsWith("<")) {
          setNote(
            "CHANGELOG.md is not served by the gateway in this setup. The full changelog ships with the repo at the project root.",
          );
        } else {
          setText(t);
        }
      })
      .catch(() =>
        setNote("Could not load CHANGELOG.md. The full changelog ships with the repo at the project root."),
      );
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.changelog")}</h1>
      {note && (
        <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-900/50 p-6 text-center">
          <p className="text-sm text-zinc-400">{note}</p>
          <div className="mx-auto mt-4 max-w-lg text-left text-sm text-zinc-500">
            <p className="mb-2 font-semibold text-zinc-300">Recent highlights (0.1.0)</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>{t("changelog.express_gateway_on_6000_openai_compatibl")}</li>
              <li>216 provider families, 20 routing strategies, quota telemetry</li>
              <li>{t("common.cacheDesc")}</li>
              <li>{t("common.costDesc")}</li>
              <li>OAuth device flow + web-session packs (experimental)</li>
              <li>17 MCP tools, 20 CLI commands, 29 dashboard pages</li>
            </ul>
          </div>
        </div>
      )}
      {text && (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-zinc-800 bg-zinc-900 p-5 text-sm text-zinc-300">
          {text}
        </pre>
      )}
      {!text && !note && <p className="text-sm text-zinc-500">{t("common.loading")}</p>}
    </div>
  );
}
