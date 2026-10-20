import { useEffect, useMemo, useState } from "react";
import { useLang } from "../i18n";
import {
  api,
  type AutoTemplateInfo,
  type ProviderInfo,
  type ServerCombo,
} from "../api";

type ItemKind = "model" | "combo" | "pipeline" | "auto";
interface Item {
  kind: ItemKind;
  name: string;
  sub: string;
  caps: string[];
  free: boolean;
  off: boolean;
  chips: Array<{ label: string; title?: string }>;
  copyText: string;
  testable: boolean;
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

const BADGE: Record<ItemKind, { label: string; cls: string } | null> = {
  model: null,
  combo: { label: "COMBO", cls: "bg-violet-900/60 text-violet-300" },
  pipeline: { label: "PIPELINE", cls: "bg-fuchsia-900/60 text-fuchsia-300" },
  auto: { label: "AUTO", cls: "bg-sky-900/60 text-sky-300" },
};

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

  useEffect(() => {
    api.providers().then(setProviders).catch((e) => setError(String(e)));
    api.combos().then((r) => setCombos(r.combos)).catch(() => {});
    api.autoCatalog().then((r) => setAutos(r.templates)).catch(() => {});
  }, []);

  const providerName = useMemo(() => {
    const m = new Map(providers.map((p) => [p.id, p.name]));
    return (id: string) => m.get(id) ?? id;
  }, [providers]);

  // One unified list: combos + auto templates live INSIDE the models list,
  // exactly like they appear in /v1/models.
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const c of combos) {
      const targets = c.targets ?? [];
      const provs = [...new Set(targets.map((x) => x.model.split(":")[0]))];
      out.push({
        kind: c.kind === "pipeline" ? "pipeline" : "combo",
        name: c.name,
        sub:
          c.kind === "pipeline"
            ? `${c.steps?.length ?? 0} pipeline steps`
            : `${c.strategy ?? "priority"} · ${targets.length} targets`,
        caps: [],
        free: false,
        off: c.enabled === false,
        chips: provs.map((id) => ({ label: providerName(id), title: id })),
        copyText: c.name,
        testable: c.kind !== "pipeline",
      });
    }
    for (const a of autos) {
      out.push({
        kind: "auto",
        name: a.id,
        sub: `${a.title} · ${a.candidates} candidates`,
        caps: [],
        free: false,
        off: a.candidates === 0,
        chips: [],
        copyText: a.id,
        testable: a.candidates > 0,
      });
    }
    const map = new Map<string, { provs: ProviderInfo[]; free: boolean }>();
    for (const p of providers) {
      for (const m of p.models) {
        let e = map.get(m);
        if (!e) {
          e = { provs: [], free: false };
          map.set(m, e);
        }
        e.provs.push(p);
        e.free = e.free || isFreeModel(p.id, m);
      }
    }
    for (const [m, e] of map) {
      out.push({
        kind: "model",
        name: m,
        sub: humanize(m),
        caps: CAPS.filter((k) => k.re.test(m)).map((k) => k.id),
        free: e.free,
        off: false,
        chips: e.provs.map((p) => ({
          label: p.name + (p.defaultModel === m ? " ★" : ""),
          title: p.id,
        })),
        copyText: `${e.provs[0]?.id}:${m}`,
        testable: true,
      });
    }
    // combos/autos first (they are the user's own virtual models), then models
    const rank = (k: ItemKind) => (k === "model" ? 1 : 0);
    return out.sort(
      (a, b) => rank(a.kind) - rank(b.kind) || b.chips.length - a.chips.length || a.name.localeCompare(b.name),
    );
  }, [providers, combos, autos, providerName]);

  const totalModelRoutes = providers.reduce((n, p) => n + p.models.length, 0);
  const modelCount = items.filter((i) => i.kind === "model").length;
  const q = query.trim().toLowerCase();

  const shown = useMemo(
    () =>
      items.filter((it) => {
        if (q && !it.name.toLowerCase().includes(q) && !it.chips.some((c) => c.label.toLowerCase().includes(q)))
          return false;
        if (it.kind === "model") {
          if (freeOnly && !it.free) return false;
          if (cap && !it.caps.includes(cap)) return false;
          if (providerFilter && !it.chips.some((c) => c.title === providerFilter)) return false;
        } else if (providerFilter && it.kind !== "auto") {
          if (!it.chips.some((c) => c.title === providerFilter)) return false;
        }
        return true;
      }),
    [items, q, providerFilter, cap, freeOnly],
  );

  const runTest = async (it: Item) => {
    setTests((s) => ({ ...s, [it.name]: { state: "running" } }));
    try {
      if (it.kind === "model") {
        const providerId = it.copyText.split(":")[0];
        const r = await api.testModel(providerId, it.name);
        setTests((s) => ({
          ...s,
          [it.name]: r.ok
            ? { state: "ok", msg: `✓ ${r.latencyMs} ms via ${providerId}` }
            : { state: "fail", msg: `✗ ${r.error ?? "failed"}` },
        }));
      } else {
        const r = await api.testCombo(it.name);
        const okCount = r.results.filter((x) => x.ok).length;
        setTests((s) => ({
          ...s,
          [it.name]: r.ok
            ? { state: "ok", msg: `✓ ${okCount}/${r.results.length} targets · via ${r.resolvedBy?.provider ?? "?"}` }
            : { state: "fail", msg: `✗ 0/${r.results.length} targets` },
        }));
      }
    } catch (e) {
      setTests((s) => ({ ...s, [it.name]: { state: "fail", msg: `✗ ${String(e)}` } }));
    }
  };

  const chipBtn = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs ${
      active
        ? "border-amber-600/60 bg-amber-950/40 font-semibold text-amber-200"
        : "border-zinc-800 text-zinc-400 hover:text-white"
    }`;

  const visible = shown.slice(0, 300);

  const actions = (it: Item) => {
    const test = tests[it.name];
    return (
      <span className="flex items-center gap-1.5">
        {test?.msg && (
          <span className={`max-w-44 truncate text-xs sm:max-w-none ${test.state === "ok" ? "text-emerald-400" : "text-red-400"}`}>
            {test.msg}
          </span>
        )}
        <button
          onClick={() => void navigator.clipboard?.writeText(it.copyText).catch(() => {})}
          className="rounded-lg border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
          title={`Copy ${it.copyText}`}
        >
          ⧉
        </button>
        {it.testable && (
          <button
            onClick={() => runTest(it)}
            disabled={test?.state === "running"}
            className="rounded-lg bg-zinc-800 px-3 py-1 text-xs font-medium hover:bg-zinc-700 disabled:opacity-50"
          >
            {test?.state === "running" ? "Testing…" : "▶ Test"}
          </button>
        )}
      </span>
    );
  };

  const nameCell = (it: Item) => {
    const badge = BADGE[it.kind];
    return (
      <>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[13px] font-medium">{it.name}</span>
          {badge && (
            <span className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold ${badge.cls}`}>
              {badge.label}
            </span>
          )}
          {it.off && (
            <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-px text-[10px] text-zinc-400">OFF</span>
          )}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-zinc-500">
          <span className="italic">{it.sub}</span>
          {it.caps.slice(0, 4).map((cid) => (
            <span key={cid} className="rounded bg-zinc-800 px-1.5 py-px text-[10px] text-zinc-400">
              {CAPS.find((k) => k.id === cid)?.label}
            </span>
          ))}
          {it.free && <span className="rounded bg-emerald-900/60 px-1.5 py-px text-[10px] text-emerald-300">FREE</span>}
        </span>
      </>
    );
  };

  const chipsCell = (it: Item) => (
    <span className="flex flex-wrap gap-1">
      {it.chips.slice(0, 4).map((c) => (
        <span
          key={c.label}
          className="rounded-full border border-emerald-800 bg-emerald-950/40 px-2 py-0.5 text-[11px] text-emerald-300"
        >
          {c.label}
        </span>
      ))}
      {it.chips.length > 4 && <span className="px-1 py-0.5 text-[11px] text-zinc-500">+{it.chips.length - 4}</span>}
      {it.chips.length === 0 && it.kind === "auto" && <span className="text-[11px] text-zinc-500">from your providers</span>}
    </span>
  );

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">
        {t("nav.models")}{" "}
        <span className="text-base font-normal text-zinc-500">
          {modelCount.toLocaleString()} models · {totalModelRoutes.toLocaleString()} routes ·{" "}
          {combos.length + autos.length} combos
        </span>
      </h1>
      <p className="mb-4 text-xs text-zinc-500">
        Only your available models — from your connected providers — with your combos and{" "}
        <code className="rounded bg-zinc-800 px-1">auto/*</code> models in the same list, just
        like <code className="rounded bg-zinc-800 px-1">/v1/models</code>.
      </p>
      {error && <p className="mb-4 text-red-400">{error}</p>}

      <div className="mb-3 flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="🔍 Search models, combos or providers…"
          className="w-full min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm sm:min-w-64"
        />
        <select
          value={providerFilter}
          onChange={(e) => setProviderFilter(e.target.value)}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm sm:w-auto"
        >
          <option value="">{t("models.all_providers")}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        <button onClick={() => setCap(null)} className={chipBtn(cap === null)}>All</button>
        {CAPS.map((k) => (
          <button key={k.id} onClick={() => setCap(cap === k.id ? null : k.id)} className={chipBtn(cap === k.id)}>
            {k.label}
          </button>
        ))}
        <button onClick={() => setFreeOnly((v) => !v)} className={chipBtn(freeOnly)}>
          🆓 Free only
        </button>
        <span className="ml-auto self-center text-xs text-zinc-500">
          Showing {visible.length} of {shown.length.toLocaleString()}
        </span>
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-xl border border-zinc-800 md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-900 text-left text-zinc-400">
              <th className="px-4 py-2">Model</th>
              <th className="px-4 py-2">Providers</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((it) => (
              <tr key={`${it.kind}:${it.name}`} className={`border-t border-zinc-800 hover:bg-zinc-900/50 ${it.off ? "opacity-55" : ""}`}>
                <td className="max-w-0 px-4 py-2.5">{nameCell(it)}</td>
                <td className="max-w-xs px-4 py-2.5">{chipsCell(it)}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right">{actions(it)}</td>
              </tr>
            ))}
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

      {/* Mobile cards */}
      <div className="space-y-2 md:hidden">
        {visible.map((it) => (
          <div key={`${it.kind}:${it.name}`} className={`rounded-xl border border-zinc-800 bg-zinc-900 p-3 ${it.off ? "opacity-55" : ""}`}>
            {nameCell(it)}
            <div className="mt-2">{chipsCell(it)}</div>
            <div className="mt-2.5 flex justify-end">{actions(it)}</div>
          </div>
        ))}
        {visible.length === 0 && (
          <p className="py-6 text-center text-zinc-500">
            {providers.length === 0 && !error ? "Loading…" : "No matches."}
          </p>
        )}
      </div>

      {shown.length > visible.length && (
        <p className="mt-3 text-xs text-zinc-500">
          Showing the first {visible.length} — search or filter to narrow the list.
        </p>
      )}
    </div>
  );
}
