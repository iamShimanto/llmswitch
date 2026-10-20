import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type ProviderInfo } from "../api";
import { Tabs, TabEmpty } from "../components/Tabs";

interface ComboStep {
  providerId: string;
  template: string; // {{input}} placeholder
}

interface Combo {
  name: string;
  steps: ComboStep[];
}

const LS_KEY = "llmswitch_combos";

function loadCombos(): Combo[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]") as Combo[];
  } catch {
    return [];
  }
}

function useCombos() {
  const [combos, setCombos] = useState<Combo[]>(loadCombos);
  const saveAll = (next: Combo[]) => {
    setCombos(next);
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  };
  return { combos, saveAll };
}

function Builder({ combos, saveAll, providers }: {
  combos: Combo[];
  saveAll: (c: Combo[]) => void;
  providers: ProviderInfo[];
}) {
  const { t } = useLang();
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<ComboStep[]>([
    { providerId: "", template: "{{input}}" },
    { providerId: "", template: "Improve this text:\n\n{{input}}" },
  ]);
  const [error, setError] = useState("");

  const setStep = (i: number, patch: Partial<ComboStep>) =>
    setSteps((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const save = () => {
    if (!name.trim() || steps.some((s) => !s.providerId)) {
      setError(t("combos.nameRequired"));
      return;
    }
    saveAll([...combos, { name: name.trim(), steps }]);
    setName("");
    setError("");
  };

  const remove = (n: string) => saveAll(combos.filter((c) => c.name !== n));

  return (
    <div>
      <p className="mb-6 text-sm text-zinc-500">{t("combos.chain_2_3_models_in_sequence_each_step_s")}</p>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <div className="mb-8 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-3 font-semibold">{t("common.newCombo")}</h2>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Combo name (e.g. draft-polish)"
          className="mb-3 w-full max-w-sm rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
        />
        {steps.map((s, i) => (
          <div key={i} className="mb-3 rounded-lg border border-zinc-800 p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs font-semibold text-zinc-400">STEP {i + 1}</span>
              <select
                value={s.providerId}
                onChange={(e) => setStep(i, { providerId: e.target.value })}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
              >
                <option value="">{t("common.pickProvider")}</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {steps.length > 2 && (
                <button
                  onClick={() => setSteps((ss) => ss.filter((_, j) => j !== i))}
                  className="text-xs text-red-400 hover:text-red-300"
                >{t("common.remove")}</button>
              )}
            </div>
            <textarea
              value={s.template}
              onChange={(e) => setStep(i, { template: e.target.value })}
              rows={2}
              placeholder="Prompt template — use {{input}} for the previous step's output"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm"
            />
          </div>
        ))}
        {steps.length < 3 && (
          <button
            onClick={() => setSteps((ss) => [...ss, { providerId: "", template: "{{input}}" }])}
            className="mb-3 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
          >{t("common.addStep")}</button>
        )}
        <div>
          <button
            onClick={save}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500"
          >{t("common.saveCombo")}</button>
        </div>
      </div>

      <h2 className="mb-3 font-semibold">Saved combos ({combos.length})</h2>
      <div className="grid gap-4 md:grid-cols-2">
        {combos.map((c) => (
          <div key={c.name} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-semibold">{c.name}</h3>
              <button onClick={() => remove(c.name)} className="text-xs text-red-400 hover:text-red-300">{t("common.deleteLower")}</button>
            </div>
            <p className="text-xs text-zinc-500">{c.steps.map((s) => s.providerId).join(" → ")}</p>
          </div>
        ))}
      </div>
      {combos.length === 0 && (
        <p className="text-sm text-zinc-500">{t("common.noCombos")}</p>
      )}
    </div>
  );
}

function Live({ combos, providers }: { combos: Combo[]; providers: ProviderInfo[] }) {
  const { t } = useLang();
  const [testInput, setTestInput] = useState("Explain recursion in one sentence.");
  const [running, setRunning] = useState<string | null>(null);
  const [trace, setTrace] = useState<Array<{ step: number; provider: string; output: string }>>([]);
  const [error, setError] = useState("");

  const runCombo = async (combo: Combo) => {
    setRunning(combo.name);
    setError("");
    setTrace([]);
    try {
      let current = testInput;
      const out: Array<{ step: number; provider: string; output: string }> = [];
      for (let i = 0; i < combo.steps.length; i++) {
        const st = combo.steps[i];
        const prompt = st.template.replace(/\{\{input\}\}/g, current);
        const r = await api.playground([{ role: "user", content: prompt }], [st.providerId]);
        const res = r.results[0];
        if (!res.ok) throw new Error(`step ${i + 1} (${st.providerId}) failed: ${res.error}`);
        current = res.text ?? "";
        out.push({ step: i + 1, provider: st.providerId, output: current });
        setTrace([...out]);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(null);
    }
  };

  if (combos.length === 0) {
    return <TabEmpty>{t("combos.noCombosBuilder")}</TabEmpty>;
  }

  return (
    <div>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <label className="mb-4 block text-sm">
        <span className="mb-1 block text-zinc-400">{t("common.testInput")}</span>
        <textarea
          value={testInput}
          onChange={(e) => setTestInput(e.target.value)}
          rows={2}
          className="w-full rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-sm"
        />
      </label>
      <div className="grid gap-4 md:grid-cols-2">
        {combos.map((c) => (
          <div key={c.name} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <h3 className="mb-1 font-semibold">{c.name}</h3>
            <p className="mb-3 text-xs text-zinc-500">{c.steps.map((s) => s.providerId).join(" → ")}</p>
            <button
              onClick={() => runCombo(c)}
              disabled={running !== null}
              className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
            >
              {running === c.name ? t("common.running") : t("combos.runLive")}
            </button>
          </div>
        ))}
      </div>
      {trace.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-3 font-semibold">{t("common.trace")}</h2>
          <div className="space-y-3">
            {trace.map((t) => (
              <div key={t.step} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                <p className="mb-1 text-xs text-zinc-500">Step {t.step} · {t.provider}</p>
                <p className="whitespace-pre-wrap text-sm text-zinc-200">{t.output}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PlaygroundTab({ providers }: { providers: ProviderInfo[] }) {
  const { t } = useLang();
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [prompt, setPrompt] = useState("Write a haiku about load balancers.");
  const [results, setResults] = useState<Array<{ provider: string; ok: boolean; text?: string; error?: string }>>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (providers.length >= 2 && !a) {
      setA(providers[0].id);
      setB(providers[1].id);
    }
  }, [providers, a]);

  const run = async () => {
    if (!a || !b) return;
    setRunning(true);
    setError("");
    try {
      const r = await api.playground([{ role: "user", content: prompt }], [a, b]);
      setResults(r.results.map((x) => ({ provider: x.providerId, ok: x.ok, text: x.text, error: x.error })));
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const sel = "rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm";
  return (
    <div>
      <p className="mb-4 text-sm text-zinc-500">{t("combos.quickCompare")}</p>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <div className="mb-3 flex flex-wrap gap-2">
        <select value={a} onChange={(e) => setA(e.target.value)} className={sel}>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span className="self-center text-zinc-500">{t("combos.vs")}</span>
        <select value={b} onChange={(e) => setB(e.target.value)} className={sel}>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        className="w-full rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-sm"
      />
      <button
        onClick={run}
        disabled={running || !a || !b || !prompt.trim()}
        className="mt-2 rounded-lg bg-sky-600 px-5 py-1.5 text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
      >
        {running ? t("common.running") : t("combos.compare")}
      </button>
      {results.length > 0 && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {results.map((r, i) => (
            <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="mb-2 text-sm font-semibold">
                {r.provider} {r.ok ? <span className="text-emerald-400">✓</span> : <span className="text-red-400">✗</span>}
              </p>
              <p className="whitespace-pre-wrap text-sm text-zinc-200">{r.ok ? r.text : r.error}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Combos() {
  const { t } = useLang();
  const [tab, setTab] = useState("builder");
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const { combos, saveAll } = useCombos();

  useEffect(() => {
    api.providers().then(setProviders).catch(() => {});
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.combos")}</h1>
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "builder", label: "Builder" },
          { id: "live", label: "Live" },
          { id: "playground", label: "Playground" },
        ]}
      />
      {tab === "builder" && <Builder combos={combos} saveAll={saveAll} providers={providers} />}
      {tab === "live" && <Live combos={combos} providers={providers} />}
      {tab === "playground" && <PlaygroundTab providers={providers} />}
    </div>
  );
}
