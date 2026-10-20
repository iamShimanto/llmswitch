import { useState } from "react";
import { useLang } from "../i18n";
import { Tabs } from "../components/Tabs";

const GW_KEY = "llmswitch_gateway_key";

function useGatewayKey() {
  const [key, setKey] = useState(() => {
    try {
      return localStorage.getItem(GW_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const save = (v: string) => {
    setKey(v);
    try {
      if (v) localStorage.setItem(GW_KEY, v);
      else localStorage.removeItem(GW_KEY);
    } catch { /* ignore */ }
  };
  return { key, save };
}

async function postV1(path: string, gwKey: string, body: unknown): Promise<{ ok: boolean; text: string }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gwKey}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { ok: res.ok, text: text.slice(0, 2000) };
  } catch (e) {
    return { ok: false, text: String(e) };
  }
}

type Kind = "image" | "audio" | "video";

const KIND_HINT: Record<Kind, string> = {
  image: "Text prompt → generated image (PNG).",
  audio: "Input text → spoken audio (TTS).",
  video: "Text prompt → generated video (provider support required).",
};

export default function Media() {
  const { t } = useLang();
  const { key, save } = useGatewayKey();
  const [tab, setTab] = useState<Kind>("image");
  const [prompt, setPrompt] = useState("a red panda reading a newspaper, watercolor");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; img?: string } | null>(null);

  const run = async () => {
    if (!key) {
      setResult({ ok: false, text: "Paste a gateway API key above first (create one on the API Keys page)." });
      return;
    }
    setBusy(true);
    setResult(null);
    if (tab === "image") {
      const r = await postV1("/v1/images/generations", key, { prompt, n: 1, size: "1024x1024" });
      let img: string | undefined;
      try {
        const j = JSON.parse(r.text);
        img = j.data?.[0]?.url ?? (j.data?.[0]?.b64_json ? `data:image/png;base64,${j.data[0].b64_json}` : undefined);
      } catch { /* keep raw text */ }
      setResult({ ok: r.ok, text: r.text, img });
    } else if (tab === "audio") {
      const r = await postV1("/v1/audio/speech", key, { input: prompt.slice(0, 200), voice: "alloy" });
      setResult({ ok: r.ok, text: r.ok ? t("media.audioReceived", { n: r.text.length }) : r.text });
    } else {
      const r = await postV1("/v1/videos/generations", key, { prompt });
      setResult({ ok: r.ok, text: r.text });
    }
    setBusy(false);
  };

  const card = "rounded-xl border border-zinc-800 bg-zinc-900 p-4";

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.media")}</h1>
      <Tabs
        active={tab}
        onChange={(id) => {
          setTab(id as Kind);
          setResult(null);
        }}
        tabs={[
          { id: "image", label: "Image" },
          { id: "audio", label: "Audio" },
          { id: "video", label: "Video" },
        ]}
      />
      <p className="mb-4 text-sm text-zinc-500">
        Test {tab} generation through the gateway. {KIND_HINT[tab]} Results depend on your
        connected providers.
      </p>
      <div className={`${card} mb-6`}>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Gateway API key (stored locally, never sent to /api)</span>
          <input
            type="password"
            value={key}
            onChange={(e) => save(e.target.value)}
            placeholder="llms_…"
            className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          />
        </label>
      </div>
      <div className={`${card} mb-6`}>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">{tab === "audio" ? "Input text" : "Prompt"}</span>
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          />
        </label>
        <div className="mt-3">
          <button
            onClick={run}
            disabled={busy}
            className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium capitalize hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? t("common.working") : t("media.generateTab", { tab })}
          </button>
        </div>
      </div>
      {result && (
        <div className={card}>
          <h2 className="mb-2 font-semibold capitalize">
            {tab} result {result.ok ? <span className="text-emerald-400">✓</span> : <span className="text-red-400">✗</span>}
          </h2>
          {result.img && <img src={result.img} alt="generated" className="mb-3 max-w-sm rounded-lg" />}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 p-3 text-xs text-zinc-300">
            {result.text}
          </pre>
        </div>
      )}
    </div>
  );
}
