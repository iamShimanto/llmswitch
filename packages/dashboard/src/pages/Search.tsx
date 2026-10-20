import { useState } from "react";
import { useLang } from "../i18n";

const GW_KEY = "llmswitch_gateway_key";

async function postV1(path: string, gwKey: string, body: unknown): Promise<{ ok: boolean; text: string }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gwKey}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { ok: res.ok, text: text.slice(0, 4000) };
  } catch (e) {
    return { ok: false, text: String(e) };
  }
}

export default function Search() {
  const { t } = useLang();
  const [gwKey, setGwKey] = useState(() => localStorage.getItem(GW_KEY) ?? "");
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [out, setOut] = useState<{ title: string; ok: boolean; text: string } | null>(null);

  const saveKey = (v: string) => {
    setGwKey(v);
    if (v) localStorage.setItem(GW_KEY, v);
    else localStorage.removeItem(GW_KEY);
  };

  const needKey = () => {
    if (!gwKey) {
      setOut({ title: "Missing key", ok: false, text: "Paste a gateway API key above first (create one on the API Keys page)." });
      return false;
    }
    return true;
  };

  const run = async (kind: "search" | "fetch" | "map") => {
    if (!needKey()) return;
    setBusy(kind);
    setOut(null);
    if (kind === "search") {
      const r = await postV1("/v1/search", gwKey, { query });
      setOut({ title: "Web search", ok: r.ok, text: r.text });
    } else if (kind === "fetch") {
      const r = await postV1("/v1/web/fetch", gwKey, { url });
      setOut({ title: "Fetch", ok: r.ok, text: r.text });
    } else {
      const r = await postV1("/v1/web/map", gwKey, { url });
      setOut({ title: "Map", ok: r.ok, text: r.text });
    }
    setBusy("");
  };

  const card = "rounded-xl border border-zinc-800 bg-zinc-900 p-4";
  const input = "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm";

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.search")}</h1>
      <p className="mb-4 text-sm text-zinc-500">
        Test console for the gateway's search tools. Requires a gateway API key (not the admin key).
      </p>
      <div className={`${card} mb-6`}>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Gateway API key (stored locally)</span>
          <input type="password" value={gwKey} onChange={(e) => saveKey(e.target.value)} placeholder="llms_…" className={`${input} max-w-md`} />
        </label>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className={card}>
          <h2 className="mb-2 font-semibold">{t("common.webSearch")}</h2>
          <p className="mb-2 text-xs text-zinc-500">POST /v1/search — needs SEARCH_API_KEY on the server.</p>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("common.queryPlaceholder")} className={input} />
          <button onClick={() => run("search")} disabled={busy !== "" || !query.trim()} className="mt-2 rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium hover:bg-sky-500 disabled:opacity-50">
            {busy === "search" ? "Searching…" : "Search"}
          </button>
        </div>
        <div className={card}>
          <h2 className="mb-2 font-semibold">{t("common.fetchUrl")}</h2>
          <p className="mb-2 text-xs text-zinc-500">POST /v1/web/fetch — SSRF-guarded, 1 MB cap.</p>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className={input} />
          <button onClick={() => run("fetch")} disabled={busy !== "" || !url.trim()} className="mt-2 rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium hover:bg-sky-500 disabled:opacity-50">
            {busy === "fetch" ? "Fetching…" : "Fetch"}
          </button>
        </div>
        <div className={card}>
          <h2 className="mb-2 font-semibold">{t("common.mapUrl")}</h2>
          <p className="mb-2 text-xs text-zinc-500">POST /v1/web/map — extract absolutized links.</p>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className={input} />
          <button onClick={() => run("map")} disabled={busy !== "" || !url.trim()} className="mt-2 rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium hover:bg-sky-500 disabled:opacity-50">
            {busy === "map" ? "Mapping…" : "Map"}
          </button>
        </div>
      </div>
      {out && (
        <div className={`${card} mt-4`}>
          <h2 className="mb-2 font-semibold">
            {out.title} {out.ok ? <span className="text-emerald-400">✓</span> : <span className="text-red-400">✗</span>}
          </h2>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 p-3 text-xs text-zinc-300">{out.text}</pre>
        </div>
      )}
    </div>
  );
}
