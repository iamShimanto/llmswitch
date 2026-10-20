import { useEffect, useMemo, useState } from "react";
import { useLang } from "../i18n";
import { api, type CatalogEntry } from "../api";

interface ModelProvider {
  id: string;
  name: string;
  connected: boolean;
  isDefault: boolean;
  free: boolean;
}
interface GroupedModel {
  model: string;
  display: string;
  providers: ModelProvider[];
  caps: string[];
  anyConnected: boolean;
  anyFree: boolean;
}

const CAPS: Array<{ id: string; label: string; re: RegExp }> = [
  { id: "vision", label: "👁 Vision", re: /vision|gpt-4o|gpt-5|claude|gemini|llama-4|moondream|pixtral|qvq|-vl\b|vl-/i },
  { id: "coding", label: "</> Coding", re: /coder|code|devstral|starcoder|swe|deepseek-coder/i },
  { id: "reasoning", label: "🧠 Reasoning", re: /reason|thinking|think|o3|o4-mini|qwq|deepseek-r|magistral|-r1\b/i },
  { id: "fast", label: "⚡ Fast", re: /mini|lite|flash|haiku|nano|small|turbo|8b|7b|3b/i },
  { id: "image", label: "🖼 Image", re: /dall-e|flux|imagen|stable|sdxl|image|midjourney/i },
  { id: "video", label: "🎬 Video", re: /veo|sora|video|kling|runway|luma/i },
  { id: "music", label: "🎵 Music", re: /music|suno|udio/i },
  { id: "tts", label: "🗣 TTS", re: /tts|text-to-speech/i },
  { id: "stt", label: "🎙 STT", re: /whisper|speech-to-text|transcri/i },
  { id: "embedding", label: "🧬 Embedding", re: /embed/i },
];
const FREE_PROVIDERS = new Set(["ovhcloud", "duckduckgo-web", "pollinations"]);
const isFreeModel = (providerId: string, model: string): boolean =>
  FREE_PROVIDERS.has(providerId) || /(:free|\/free|^free$|free)$/.test(model);

const humanize = (m: string): string =>
  m
    .split("/")
    .pop()!
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

export default function Models() {
  const { t } = useLang();
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [cap, setCap] = useState<string | null>(null);
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const [tests, setTests] = useState<Record<string, { state: "running" | "ok" | "fail"; msg?: string }>>({});

  useEffect(() => {
    api.catalog().then(setCatalog).catch((e) => setError(String(e)));
  }, []);

  const grouped = useMemo<GroupedModel[]>(() => {
    const map = new Map<string, GroupedModel>();
    for (const c of catalog) {
      const hidden = new Set(c.hiddenModels ?? []);
      for (const m of c.models) {
        if (hidden.has(m)) continue;
        let g = map.get(m);
        if (!g) {
          g = {
            model: m,
            display: humanize(m),
            providers: [],
            caps: CAPS.filter((k) => k.re.test(m)).map((k) => k.id),
            anyConnected: false,
            anyFree: false,
          };
          map.set(m, g);
        }
        const free = isFreeModel(c.id, m);
        g.providers.push({
          id: c.id,
          name: c.name,
          connected: c.connected,
          isDefault: c.defaultModel === m,
          free,
        });
        g.anyConnected = g.anyConnected || c.connected;
        g.anyFree = g.anyFree || free;
      }
    }
    return [...map.values()].sort(
      (a, b) =>
        Number(b.anyConnected) - Number(a.anyConnected) ||
        b.providers.length - a.providers.length ||
        a.model.localeCompare(b.model),
    );
  }, [catalog]);

  const totalPairs = catalog.reduce((n, c) => n + c.models.length, 0);
  const connectedPairs = catalog
    .filter((c) => c.connected)
    .reduce((n, c) => n + c.models.length, 0);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return grouped.filter((g) => {
      if (connectedOnly && !g.anyConnected) return false;
      if (freeOnly && !g.anyFree) return false;
      if (cap && !g.caps.includes(cap)) return false;
      if (providerFilter && !g.providers.some((p) => p.id === providerFilter)) return false;
      if (q && !g.model.toLowerCase().includes(q) && !g.providers.some((p) => p.name.toLowerCase().includes(q)))
        return false;
      return true;
    });
  }, [grouped, query, providerFilter, cap, connectedOnly, freeOnly]);

  const runTest = async (g: GroupedModel) => {
    const target = g.providers.find((p) => p.connected);
    if (!target) return;
    setTests((s) => ({ ...s, [g.model]: { state: "running" } }));
    try {
      const r = await api.testModel(target.id, g.model);
      setTests((s) => ({
        ...s,
        [g.model]: r.ok
          ? { state: "ok", msg: `✓ ${r.latencyMs} ms via ${target.id}` }
          : { state: "fail", msg: `✗ ${r.error ?? "failed"}` },
      }));
    } catch (e) {
      setTests((s) => ({ ...s, [g.model]: { state: "fail", msg: `✗ ${String(e)}` } }));
    }
  };

  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs ${
      active
        ? "border-amber-600/60 bg-amber-950/40 font-semibold text-amber-200"
        : "border-zinc-800 text-zinc-400 hover:text-white"
    }`;

  const visible = shown.slice(0, 300);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">
        {t("nav.models")}{" "}
        <span className="text-base font-normal text-zinc-500">
          {grouped.length.toLocaleString()} models · {totalPairs.toLocaleString()} routes ·{" "}
          {connectedPairs.toLocaleString()} connected
        </span>
      </h1>
      <p className="mb-4 text-xs text-zinc-500">
        Every model in the catalog, grouped across providers. Address any route as{" "}
        <code className="rounded bg-zinc-800 px-1">provider:model</code>.
      </p>
      {error && <p className="mb-4 text-red-400">{error}</p>}

      <div className="mb-3 flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="🔍 Search models or providers… (e.g. claude, llama, gemini)"
          className="min-w-64 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
        />
        <select
          value={providerFilter}
          onChange={(e) => setProviderFilter(e.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
        >
          <option value="">{t("models.all_providers")}</option>
          {catalog.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.connected ? " ●" : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        <button onClick={() => setCap(null)} className={chip(cap === null)}>All</button>
        {CAPS.map((k) => (
          <button key={k.id} onClick={() => setCap(cap === k.id ? null : k.id)} className={chip(cap === k.id)}>
            {k.label}
          </button>
        ))}
        <button onClick={() => setConnectedOnly((v) => !v)} className={chip(connectedOnly)}>
          ● Connected only
        </button>
        <button onClick={() => setFreeOnly((v) => !v)} className={chip(freeOnly)}>
          🆓 Free only
        </button>
        <span className="ml-auto self-center text-xs text-zinc-500">
          Showing {visible.length} of {shown.length.toLocaleString()}
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-900 text-left text-zinc-400">
              <th className="px-4 py-2">Model</th>
              <th className="px-4 py-2">Providers</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((g) => {
              const test = tests[g.model];
              const firstConnected = g.providers.find((p) => p.connected);
              const copyId = `${(firstConnected ?? g.providers[0])?.id}:${g.model}`;
              return (
                <tr key={g.model} className="border-t border-zinc-800 hover:bg-zinc-900/50">
                  <td className="max-w-0 px-4 py-2.5">
                    <span className="block truncate font-mono text-[13px]">{g.model}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-zinc-500">
                      <span className="italic">{g.display}</span>
                      {g.caps.slice(0, 4).map((cid) => (
                        <span key={cid} className="rounded bg-zinc-800 px-1.5 py-px text-[10px] text-zinc-400">
                          {CAPS.find((k) => k.id === cid)?.label}
                        </span>
                      ))}
                      {g.anyFree && <span className="rounded bg-emerald-900/60 px-1.5 py-px text-[10px] text-emerald-300">FREE</span>}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex max-w-md flex-wrap gap-1">
                      {g.providers.slice(0, 4).map((p) => (
                        <span
                          key={p.id}
                          className={`rounded-full border px-2 py-0.5 text-[11px] ${
                            p.connected
                              ? "border-emerald-800 bg-emerald-950/40 text-emerald-300"
                              : "border-zinc-800 text-zinc-500"
                          }`}
                          title={p.connected ? "Connected" : "Not connected"}
                        >
                          {p.name}
                          {p.isDefault ? " ★" : ""}
                        </span>
                      ))}
                      {g.providers.length > 4 && (
                        <span className="px-1 py-0.5 text-[11px] text-zinc-500">+{g.providers.length - 4}</span>
                      )}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    {test?.msg && (
                      <span className={`mr-2 text-xs ${test.state === "ok" ? "text-emerald-400" : "text-red-400"}`}>
                        {test.msg}
                      </span>
                    )}
                    <button
                      onClick={() => void navigator.clipboard?.writeText(copyId).catch(() => {})}
                      className="mr-1.5 rounded-lg border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
                      title={`Copy ${copyId}`}
                    >
                      ⧉
                    </button>
                    {firstConnected && (
                      <button
                        onClick={() => runTest(g)}
                        disabled={test?.state === "running"}
                        className="rounded-lg bg-zinc-800 px-3 py-1 text-xs font-medium hover:bg-zinc-700 disabled:opacity-50"
                      >
                        {test?.state === "running" ? "Testing…" : "▶ Test"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-zinc-500">
                  {catalog.length === 0 && !error ? "Loading…" : "No matches."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {shown.length > visible.length && (
        <p className="mt-3 text-xs text-zinc-500">
          Showing the first {visible.length} — search or filter to narrow the list.
        </p>
      )}
    </div>
  );
}
