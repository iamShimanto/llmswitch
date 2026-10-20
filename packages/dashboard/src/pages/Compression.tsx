import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type ProviderInfo } from "../api";
import { Tabs, TabEmpty } from "../components/Tabs";

const MODES = ["stacked", "caveman", "rtk"] as const;
const LS_EXCL = "llmswitch_compression_exclusions";

function loadExclusions(): string[] {
  try {
    return JSON.parse(localStorage.getItem(LS_EXCL) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function Studio() {
  const { t } = useLang();
  const [text, setText] = useState(
    "Prompt compression removes redundancy from prompts before they are sent to the model. This can significantly reduce token usage and cost, especially for long system prompts and repeated instructions, without meaningfully changing what the model understands.",
  );
  const [mode, setMode] = useState<(typeof MODES)[number]>("stacked");
  const [result, setResult] = useState<{ text: string; savedPct: number; before: number; after: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    setRunning(true);
    setError("");
    try {
      const r = await api.compressionPreview(text, mode);
      setResult({
        text: r.text,
        savedPct: r.stats.savedPct,
        before: r.stats.estTokensBefore,
        after: r.stats.estTokensAfter,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <p className="mb-6 text-sm text-zinc-500">{t("common.compressionDesc")}</p>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        placeholder={t("common.pasteCompress")}
        className="w-full rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-sm"
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {MODES.map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded-lg border px-4 py-1.5 text-sm ${
              mode === m
                ? "border-emerald-600 bg-emerald-950 text-emerald-300"
                : "border-zinc-700 hover:bg-zinc-800"
            }`}
          >
            {m}
          </button>
        ))}
        <button
          onClick={run}
          disabled={running || !text.trim()}
          className="rounded-lg bg-emerald-600 px-5 py-1.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
        >
          {running ? "Compressing…" : "Compress"}
        </button>
      </div>
      {result && (
        <div className="mt-6 grid gap-4 md:grid-cols-[1fr_220px]">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="mb-2 text-xs text-zinc-500">Compressed output ({mode})</p>
            <p className="whitespace-pre-wrap text-sm text-zinc-200">{result.text}</p>
          </div>
          <div className="space-y-3">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-center">
              <p className="text-xs text-zinc-500">{t("common.saved")}</p>
              <p className="text-3xl font-bold text-emerald-400">{result.savedPct.toFixed(1)}%</p>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-center">
              <p className="text-xs text-zinc-500">{t("common.tokens")}</p>
              <p className="text-sm">
                ~{result.before} → <span className="font-semibold text-emerald-300">~{result.after}</span>
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Live() {
  const { t } = useLang();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [prompt, setPrompt] = useState("Explain what a reverse proxy does in two sentences.");
  const [mode, setMode] = useState<(typeof MODES)[number]>("stacked");
  const [out, setOut] = useState<{ compressed: string; savedPct: number; reply: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.providers().then((ps) => {
      setProviders(ps);
      if (ps.length > 0) setProvider(ps[0].id);
    }).catch((e) => setError(String(e)));
  }, []);

  const run = async () => {
    if (!provider) return;
    setRunning(true);
    setError("");
    setOut(null);
    try {
      const c = await api.compressionPreview(prompt, mode);
      const r = await api.playground([{ role: "user", content: c.text }], [provider]);
      const res = r.results[0];
      if (!res.ok) throw new Error(res.error ?? "playground failed");
      setOut({ compressed: c.text, savedPct: c.stats.savedPct, reply: res.text ?? "" });
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <p className="mb-4 text-sm text-zinc-500">{t("compression.liveTest")}<em>{t("compression.compressed")}</em> version through the gateway
        (equivalent of the <code className="rounded bg-zinc-800 px-1 text-xs">x-llmswitch-compress</code> header).
      </p>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <div className="mb-3 flex flex-wrap gap-2">
        <select value={provider} onChange={(e) => setProvider(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm">
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {MODES.map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded-lg border px-3 py-1.5 text-sm ${mode === m ? "border-emerald-600 bg-emerald-950 text-emerald-300" : "border-zinc-700 hover:bg-zinc-800"}`}
          >
            {m}
          </button>
        ))}
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        className="w-full rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-sm"
      />
      <button
        onClick={run}
        disabled={running || !provider || !prompt.trim()}
        className="mt-2 rounded-lg bg-emerald-600 px-5 py-1.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
      >
        {running ? t("common.running") : t("compression.compressSend")}
      </button>
      {out && (
        <div className="mt-4 space-y-3">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="mb-1 text-xs text-zinc-500">Sent (compressed · saved {out.savedPct.toFixed(1)}%)</p>
            <p className="whitespace-pre-wrap text-sm text-zinc-300">{out.compressed}</p>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="mb-1 text-xs text-zinc-500">{t("compression.reply")}</p>
            <p className="whitespace-pre-wrap text-sm text-zinc-200">{out.reply}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Exclusions() {
  const { t } = useLang();
  const [patterns, setPatterns] = useState<string[]>(loadExclusions());
  const [draft, setDraft] = useState("");

  const save = (next: string[]) => {
    setPatterns(next);
    localStorage.setItem(LS_EXCL, JSON.stringify(next));
  };

  const add = () => {
    const p = draft.trim();
    if (!p || patterns.includes(p)) return;
    save([...patterns, p]);
    setDraft("");
  };

  return (
    <div>
      <p className="mb-4 text-sm text-zinc-500">
        Exclusion patterns are kept in your browser (localStorage). The gateway does not yet apply
        them server-side — use them as a checklist when reviewing compressed output, or strip
        matching lines before compressing.
      </p>
      <div className="mb-4 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="e.g. API key, -----BEGIN, <secret>"
          className="w-full max-w-sm rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
        />
        <button onClick={add} className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium hover:bg-sky-500">{t("common.add")}</button>
      </div>
      {patterns.length === 0 ? (
        <TabEmpty>{t("compression.noExclusions")}</TabEmpty>
      ) : (
        <div className="space-y-2">
          {patterns.map((p) => (
            <div key={p} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5">
              <code className="text-sm text-zinc-200">{p}</code>
              <button onClick={() => save(patterns.filter((x) => x !== p))} className="text-xs text-red-400 hover:text-red-300">{t("common.remove")}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Compression() {
  const { t } = useLang();
  const [tab, setTab] = useState("studio");
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.compression")}</h1>
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "studio", label: "Studio" },
          { id: "live", label: "Live" },
          { id: "exclusions", label: "Exclusions" },
        ]}
      />
      {tab === "studio" && <Studio />}
      {tab === "live" && <Live />}
      {tab === "exclusions" && <Exclusions />}
    </div>
  );
}
