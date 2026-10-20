import { useEffect, useMemo, useState } from "react";
import { useLang } from "../i18n";
import {
  api,
  type AutoTemplateInfo,
  type ProviderInfo,
  type ServerCombo,
} from "../api";

interface ModelProvider {
  id: string;
  name: string;
  isDefault: boolean;
  free: boolean;
}
interface GroupedModel {
  model: string;
  display: string;
  providers: ModelProvider[];
  caps: string[];
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
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [combos, setCombos] = useState<ServerCombo[]>([]);
  const [autos, setAutos] = useState<AutoTemplateInfo[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [cap, setCap] = useState<string | null>(null);
  const [freeOnly, setFreeOnly] = useState(false);
  const [tests, setTests] = useState<Record<string, { state: "running" | "ok" | "fail"; msg?: string }>>({});
  const [comboTests, setComboTests] = useState<Record<string, { state: "running" | "ok" | "fail"; msg?: string }>>({});

  useEffect(() => {
    api.providers().then(setProviders).catch((e) => setError(String(e)));
    api.combos().then((r) => setCombos(r.combos)).catch(() => {});
    api.autoCatalog().then((r) => setAutos(r.templates)).catch(() => {});
  }, []);

  const grouped = useMemo<GroupedModel[]>(() => {
    const map = new Map<string, GroupedModel>();
    for (const p of providers) {
      for (const m of p.models) {
        let g = map.get(m);
        if (!g) {
          g = {
            model: m,
            display: humanize(m),
            providers: [],
            caps: CAPS.filter((k) => k.re.test(m)).map((k) => k.id),
            anyFree: false,
          };
          map.set(m, g);
        }
        const free = isFreeModel(p.id, m);
        g.providers.push({ id: p.id, name: p.name, isDefault: p.defaultModel === m, free });
        g.anyFree = g.anyFree || free;
      }
    }
    return [...map.values()].sort(
      (a, b) => b.providers.length - a.providers.length || a.model.localeCompare(b.model),
    );
  }, [providers]);

  const totalPairs = providers.reduce((n, p) => n + p.models.length, 0);
  const q = query.trim().toLowerCase();

  const shownModels = useMemo(
    () =>
      grouped.filter((g) => {
        if (freeOnly && !g.anyFree) return false;
        if (cap && !g.caps.includes(cap)) return false;
        if (providerFilter && !g.providers.some((p) => p.id === providerFilter)) return false;
        if (q && !g.model.toLowerCase().includes(q) && !g.providers.some((p) => p.name.toLowerCase().includes(q)))
          return false;
        return true;
      }),
    [grouped, q, providerFilter, cap, freeOnly],
  );

  const shownCombos = combos.filter((c) => !q || c.name.toLowerCase().includes(q));
  const shownAutos = autos.filter((a) => !q || a.id.toLowerCase().includes(q) || a.title.toLowerCase().includes(q));

  const runTest = async (g: GroupedModel) => {
    const target = g.providers[0];
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

  const runComboTest = async (name: string) => {
    setComboTests((s) => ({ ...s, [name]: { state: "running" } }));
    try {
      const r = await api.testCombo(name);
      const okCount = r.results.filter((x) => x.ok).length;
      setComboTests((s) => ({
        ...s,
        [name]: r.ok
          ? { state: "ok", msg: `✓ ${okCount}/${r.results.length} targets · via ${r.resolvedBy?.provider ?? "?"}` }
          : { state: "fail", msg: `✗ 0/${r.results.length} targets` },
      }));
    } catch (e) {
      setComboTests((s) => ({ ...s, [name]: { state: "fail", msg: `✗ ${String(e)}` } }));
    }
  };

  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs ${
      active
        ? "border-amber-600/60 bg-amber-950/40 font-semibold text-amber-200"
        : "border-zinc-800 text-zinc-400 hover:text-white"
    }`;

  const visible = shownModels.slice(0, 300);
  const comboCard = "rounded-xl border border-zinc-800 bg-zinc-900 p-3.5";

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">
        {t("nav.models")}{" "}
        <span className="text-base font-normal text-zinc-500">
          {grouped.length.toLocaleString()} models · {totalPairs.toLocaleString()} routes ·{" "}
          {combos.length + autos.length} combos
        </span>
      </h1>
      <p className="mb-4 text-xs text-zinc-500">
        Only your available models — from your connected providers — plus your combos. Address
        any route as <code className="rounded bg-zinc-800 px-1">provider:model</code>, a combo
        by its name, or an <code className="rounded bg-zinc-800 px-1">auto/*</code> model.
      </p>
      {error && <p className="mb-4 text-red-400">{error}</p>}

      <div className="mb-3 flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="🔍 Search models, combos or providers…"
          className="min-w-64 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
        />
        <select
          value={providerFilter}
          onChange={(e) => setProviderFilter(e.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
        >
          <option value="">{t("models.all_providers")}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      {(shownCombos.length > 0 || shownAutos.length > 0) && (
        <>
          <h2 className="mb-3 font-semibold">
            🧬 Combos &amp; Auto models{" "}
            <span className="text-sm font-normal text-zinc-500">
              {shownCombos.length + shownAutos.length}
            </span>
          </h2>
          <div className="mb-6 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {shownCombos.map((c) => {
              const test = comboTests[c.name];
              const targets = c.targets ?? [];
              return (
                <div key={c.name} className={`${comboCard} ${c.enabled === false ? "opacity-50" : ""}`}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold">{c.name}</span>
                    <span className="shrink-0 rounded bg-violet-900/60 px-1.5 py-px text-[10px] font-semibold text-violet-300">
                      {c.kind === "pipeline" ? "PIPELINE" : "COMBO"}
                    </span>
                    {c.enabled === false && (
                      <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-px text-[10px] text-zinc-400">OFF</span>
                    )}
                  </div>
                  <p className="mt-1 truncate text-xs text-zinc-500">
                    {c.kind === "pipeline"
                      ? `${c.steps?.length ?? 0} steps`
                      : `${c.strategy ?? "priority"} · ${targets.length} targets: ${targets.map((x) => x.model).slice(0, 2).join(", ")}${targets.length > 2 ? ` +${targets.length - 2}` : ""}`}
                  </p>
                  <div className="mt-2.5 flex items-center gap-2">
                    <button
                      onClick={() => void navigator.clipboard?.writeText(c.name).catch(() => {})}
                      className="rounded-lg border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
                      title="Copy combo name"
                    >
                      ⧉
                    </button>
                    {c.kind !== "pipeline" && (
                      <button
                        onClick={() => runComboTest(c.name)}
                        disabled={test?.state === "running"}
                        className="rounded-lg bg-zinc-800 px-3 py-1 text-xs font-medium hover:bg-zinc-700 disabled:opacity-50"
                      >
                        {test?.state === "running" ? "Testing…" : "▶ Test"}
                      </button>
                    )}
                    {test?.msg && (
                      <span className={`truncate text-xs ${test.state === "ok" ? "text-emerald-400" : "text-red-400"}`}>
                        {test.msg}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            {shownAutos.map((a) => {
              const test = comboTests[a.id];
              return (
                <div key={a.id} className={comboCard}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold">{a.id}</span>
                    <span className="shrink-0 rounded bg-sky-900/60 px-1.5 py-px text-[10px] font-semibold text-sky-300">
                      AUTO
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-zinc-500">
                    {a.title} · {a.candidates} candidate models from your providers
                  </p>
                  <div className="mt-2.5 flex items-center gap-2">
                    <button
                      onClick={() => void navigator.clipboard?.writeText(a.id).catch(() => {})}
                      className="rounded-lg border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
                      title="Copy model name"
                    >
                      ⧉
                    </button>
                    <button
                      onClick={() => runComboTest(a.id)}
                      disabled={test?.state === "running" || a.candidates === 0}
                      className="rounded-lg bg-zinc-800 px-3 py-1 text-xs font-medium hover:bg-zinc-700 disabled:opacity-50"
                    >
                      {test?.state === "running" ? "Testing…" : "▶ Test"}
                    </button>
                    {test?.msg && (
                      <span className={`truncate text-xs ${test.state === "ok" ? "text-emerald-400" : "text-red-400"}`}>
                        {test.msg}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="mb-4 flex flex-wrap gap-1.5">
        <button onClick={() => setCap(null)} className={chip(cap === null)}>All</button>
        {CAPS.map((k) => (
          <button key={k.id} onClick={() => setCap(cap === k.id ? null : k.id)} className={chip(cap === k.id)}>
            {k.label}
          </button>
        ))}
        <button onClick={() => setFreeOnly((v) => !v)} className={chip(freeOnly)}>
          🆓 Free only
        </button>
        <span className="ml-auto self-center text-xs text-zinc-500">
          Showing {visible.length} of {shownModels.length.toLocaleString()} models
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
              const copyId = `${g.providers[0]?.id}:${g.model}`;
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
                          className="rounded-full border border-emerald-800 bg-emerald-950/40 px-2 py-0.5 text-[11px] text-emerald-300"
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
                    <button
                      onClick={() => runTest(g)}
                      disabled={test?.state === "running"}
                      className="rounded-lg bg-zinc-800 px-3 py-1 text-xs font-medium hover:bg-zinc-700 disabled:opacity-50"
                    >
                      {test?.state === "running" ? "Testing…" : "▶ Test"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-zinc-500">
                  {providers.length === 0 && !error ? "Loading…" : "No matches."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {shownModels.length > visible.length && (
        <p className="mt-3 text-xs text-zinc-500">
          Showing the first {visible.length} — search or filter to narrow the list.
        </p>
      )}
    </div>
  );
}
