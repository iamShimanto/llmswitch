import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type ProviderInfo } from "../api";
import { Tabs, TabEmpty } from "../components/Tabs";

/** Token estimate heuristic used across the gateway: ~4 chars per token. */
const estTokens = (text: string) => Math.ceil(text.length / 4);

interface Engine {
  id: string;
  label: string;
  /** real backend mode, or null when the engine doesn't exist server-side */
  previewMode: "caveman" | "rtk" | "stacked" | null;
  previewNote?: string;
  description: string;
}

const ENGINES: Engine[] = [
  {
    id: "caveman",
    label: "Caveman",
    previewMode: "caveman",
    description:
      "Aggressive prompt slimming: removes low-signal tokens — filler words, hedges, redundant qualifiers — while keeping meaning. Best for long system prompts.",
  },
  {
    id: "rtk",
    label: "RTK",
    previewMode: "rtk",
    description:
      "Dedupes repeated lines/paragraphs, collapses whitespace, trims quoted echoes. Best for prompts with repeated instructions or pasted context.",
  },
  {
    id: "aggressive",
    label: "Aggressive",
    previewMode: "caveman",
    previewNote: "No dedicated Aggressive engine on this gateway — previewed via Caveman (the aggressive pass).",
    description:
      "OmniRoute-style aggressive mode: maximum token removal. On LLMSwitch this maps to the Caveman pass, which is the aggressive slimming engine.",
  },
  {
    id: "lite",
    label: "Lite",
    previewMode: "rtk",
    previewNote: "No dedicated Lite engine on this gateway — previewed via RTK (the lightweight dedup pass).",
    description:
      "OmniRoute-style lite mode: cheap structural cleanup only. On LLMSwitch this maps to the RTK pass.",
  },
  {
    id: "ultra",
    label: "Ultra",
    previewMode: "stacked",
    previewNote: "No dedicated Ultra engine on this gateway — previewed via Stacked (Caveman + RTK).",
    description:
      "OmniRoute-style ultra mode: all passes combined. On LLMSwitch this maps to Stacked (Caveman + RTK).",
  },
  {
    id: "session-dedup",
    label: "Session Dedup",
    previewMode: "rtk",
    previewNote: "Session-level dedup across turns is not implemented — previewed via RTK line dedup on a single prompt.",
    description:
      "Would dedupe repeated content across conversation turns within a session. Not implemented server-side; the RTK pass covers single-prompt line dedup.",
  },
];

function EngineTab({ engine }: { engine: Engine }) {
  const { t } = useLang();
  const [text, setText] = useState(
    "Please note that it is very important to remember that you should always be helpful. As mentioned before, being helpful is really quite essential.",
  );
  const [result, setResult] = useState<{ text: string; savedPct: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    if (!engine.previewMode) return;
    setRunning(true);
    setError("");
    try {
      const r = await api.compressionPreview(text, engine.previewMode);
      setResult({ text: r.text, savedPct: r.stats.savedPct });
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-1 font-semibold">{engine.label}</h2>
        <p className="text-sm text-zinc-400">{engine.description}</p>
        {engine.previewNote && (
          <p className="mt-2 rounded-lg bg-amber-950/50 px-3 py-2 text-xs text-amber-200">{engine.previewNote}</p>
        )}
      </div>
      <h3 className="mb-2 text-sm font-semibold text-zinc-300">{t("context.testBox")}</h3>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        className="w-full rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-sm"
      />
      <button
        onClick={run}
        disabled={running || !engine.previewMode || !text.trim()}
        className="mt-2 rounded-lg bg-emerald-600 px-5 py-1.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
      >
        {running ? t("common.running") : t("context.testEngine", { engine: engine.label })}
      </button>
      {result && (
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="mb-1 text-xs text-zinc-500">
            Output · saved {result.savedPct.toFixed(1)}%
          </p>
          <p className="whitespace-pre-wrap text-sm text-zinc-200">{result.text}</p>
        </div>
      )}
    </div>
  );
}

function Overview() {
  const { t } = useLang();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [text, setText] = useState("");
  const [window, setWindow] = useState("128000");
  const [error, setError] = useState("");

  useEffect(() => {
    api.providers().then(setProviders).catch((e) => setError(String(e)));
  }, []);

  const tokens = estTokens(text);
  const win = Number(window) || 0;
  const fits = win > 0 && tokens <= win;
  const pct = win > 0 ? Math.min(100, (tokens / win) * 100) : 0;

  return (
    <div>
      <p className="mb-6 text-sm text-zinc-500">
        Paste a prompt to estimate tokens (~4 chars/token heuristic). Context windows are not
        exposed by the gateway API — enter your model's window to check fit.
      </p>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder={t("common.pastePrompt")}
        className="w-full rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-sm"
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          Model context window (tokens)
          <input
            value={window}
            onChange={(e) => setWindow(e.target.value)}
            type="number"
            min="0"
            className="w-32 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm"
          />
        </label>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2">
          <span className="text-sm text-zinc-400">{t("common.estimated")}</span>
          <span className="font-bold">~{tokens.toLocaleString()} tokens</span>
          <span className="ml-2 text-xs text-zinc-500">({text.length.toLocaleString()} chars)</span>
        </div>
        {text && win > 0 && (
          <span
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${fits ? "bg-emerald-950 text-emerald-300" : "bg-red-950 text-red-300"}`}
          >
            {fits ? t("context.fits", { pct: pct.toFixed(1) }) : t("context.exceeds", { pct: pct.toFixed(0) })}
          </span>
        )}
      </div>

      {text && win > 0 && (
        <div className="mt-4">
          <div className="h-3 overflow-hidden rounded-full bg-zinc-800">
            <div
              className={`h-full rounded-full ${fits ? "bg-emerald-500" : "bg-red-500"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      <h2 className="mb-3 mt-8 font-semibold">Connected providers ({providers.length})</h2>
      <div className="grid gap-2 md:grid-cols-2">
        {providers.map((p) => (
          <div key={p.id} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5">
            <div>
              <span className="text-sm font-medium">{p.name}</span>
              <span className="ml-2 text-xs text-zinc-500">{p.models.length} models</span>
            </div>
            {text && win > 0 ? (
              <span className={`text-xs font-medium ${fits ? "text-emerald-400" : "text-red-400"}`}>
                {fits ? "fits" : "too big"}
              </span>
            ) : (
              <span className="text-xs text-zinc-600">{t("common.windowNa")}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Context() {
  const { t } = useLang();
  const [tab, setTab] = useState("overview");
  const engine = ENGINES.find((e) => e.id === tab);
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.context")}</h1>
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "Overview" },
          ...ENGINES.map((e) => ({ id: e.id, label: e.label })),
        ]}
      />
      {tab === "overview" && <Overview />}
      {engine && <EngineTab key={engine.id} engine={engine} />}
    </div>
  );
}
