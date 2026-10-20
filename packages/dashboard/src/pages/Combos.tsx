import { useEffect, useMemo, useState } from "react";
import {
  api,
  type AutoTemplateInfo,
  type CatalogEntry,
  type ComboConfig,
  type ComboTarget,
  type ComboTestResult,
  type ProviderAccount,
  type ServerCombo,
} from "../api";

const card = "rounded-xl border border-zinc-800 bg-zinc-900 p-4";
const input = "rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm";
const btn =
  "rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800";

const STRATEGIES: Array<{ id: string; label: string; help: string }> = [
  { id: "priority", label: "Priority", help: "Sequential fallback: tries target 1 first, then 2, etc. Best when you have one preferred model and only want fallback on failure." },
  { id: "weighted", label: "Weighted", help: "Distributes requests across targets by weight, falling back in order on failure." },
  { id: "round-robin", label: "Round Robin", help: "Rotates the starting target on every request to spread load evenly." },
  { id: "fill-first", label: "Fill First", help: "Sticks to the first target until it fails, then moves on." },
  { id: "p2c", label: "P2C", help: "Power of two choices: samples two targets and leads with the less-used one." },
  { id: "random", label: "Random", help: "Shuffles targets on every request." },
  { id: "strict-random", label: "Strict Random", help: "Pure random order on every request, no memory." },
  { id: "least-used", label: "Least Used", help: "Least-called providers first — balances wear across accounts." },
  { id: "cost-optimized", label: "Cost Optimized", help: "Cheapest providers first." },
  { id: "headroom", label: "Headroom", help: "Targets with the most remaining quota go first." },
  { id: "context-relay", label: "Context Relay", help: "Leads with the last target that answered, keeping a conversation on one model." },
];

interface StepDraft {
  providerId: string;
  model: string;
  accountId: string; // "" = dynamic
}

interface WizardState {
  name: string;
  description: string;
  strategy: string;
  steps: ComboTarget[];
  draft: StepDraft;
  systemPrompt: string;
  contextLength: string;
  forbidden: string;
  required: string;
  minLength: string;
}

function emptyWizard(): WizardState {
  return {
    name: "",
    description: "",
    strategy: "priority",
    steps: [],
    draft: { providerId: "", model: "", accountId: "" },
    systemPrompt: "",
    contextLength: "",
    forbidden: "",
    required: "",
    minLength: "",
  };
}

function wizardFromCombo(c: ServerCombo): WizardState {
  const w = emptyWizard();
  w.name = c.name;
  w.description = c.description ?? "";
  w.strategy = c.strategy ?? "priority";
  w.steps = (c.targets ?? []).map((t) => ({ ...t }));
  w.systemPrompt = c.config?.systemPrompt ?? "";
  w.contextLength = c.config?.contextLength ? String(c.config.contextLength) : "";
  w.forbidden = (c.config?.validation?.forbidden ?? []).join("\n");
  w.required = (c.config?.validation?.required ?? []).join("\n");
  w.minLength = c.config?.validation?.minLength ? String(c.config.validation.minLength) : "";
  return w;
}

const NAME_OK = /^[a-z0-9][a-z0-9-_/.]{1,63}$/;

function Wizard({
  initial,
  editing,
  catalog,
  accounts,
  combos,
  onClose,
  onSaved,
}: {
  initial: WizardState;
  editing: ServerCombo | null;
  catalog: CatalogEntry[];
  accounts: ProviderAccount[];
  combos: ServerCombo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [stage, setStage] = useState(0);
  const [w, setW] = useState<WizardState>(initial);
  const [refPick, setRefPick] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const set = (p: Partial<WizardState>) => setW((s) => ({ ...s, ...p }));
  const setDraft = (p: Partial<StepDraft>) => setW((s) => ({ ...s, draft: { ...s.draft, ...p } }));

  const nameValid = NAME_OK.test(w.name.trim().toLowerCase()) && !w.name.includes(":");
  const basicsDone = nameValid;
  const stepsDone = w.steps.length >= 1;
  const stageDone = [basicsDone, stepsDone, true, true];
  const accountsOf = (pid: string) => accounts.filter((a) => a.providerId === pid && a.enabled);
  const modelsOf = (pid: string) => catalog.find((c) => c.id === pid)?.models ?? [];
  const providerName = (pid: string) => catalog.find((c) => c.id === pid)?.name ?? pid;
  const accountLabel = (id?: string | null) =>
    id ? (accounts.find((a) => a.id === id)?.label ?? "pinned account") : "dynamic account";

  const addStep = () => {
    const d = w.draft;
    if (!d.providerId || !d.model) return;
    const t: ComboTarget = {
      model: `${d.providerId}:${d.model}`,
      accountId: d.accountId || null,
    };
    set({ steps: [...w.steps, t], draft: { providerId: "", model: "", accountId: "" } });
  };
  const addRef = () => {
    if (!refPick) return;
    set({ steps: [...w.steps, { model: refPick, accountId: null }] });
    setRefPick("");
  };
  const moveStep = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= w.steps.length) return;
    const next = [...w.steps];
    [next[i], next[j]] = [next[j]!, next[i]!];
    set({ steps: next });
  };

  const buildConfig = (): ComboConfig | undefined => {
    const cfg: ComboConfig = {};
    if (w.systemPrompt.trim()) cfg.systemPrompt = w.systemPrompt.trim();
    const cl = parseInt(w.contextLength, 10);
    if (Number.isFinite(cl) && cl > 0) cfg.contextLength = cl;
    const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
    const forb = lines(w.forbidden);
    const req = lines(w.required);
    const min = parseInt(w.minLength, 10);
    const validation: ComboConfig["validation"] = {};
    if (forb.length) validation.forbidden = forb;
    if (req.length) validation.required = req;
    if (Number.isFinite(min) && min > 0) validation.minLength = min;
    if (validation && Object.keys(validation).length) cfg.validation = validation;
    return Object.keys(cfg).length ? cfg : undefined;
  };
  const advancedCount =
    (w.systemPrompt.trim() ? 1 : 0) +
    (w.contextLength.trim() ? 1 : 0) +
    (w.forbidden.trim() ? 1 : 0) +
    (w.required.trim() ? 1 : 0) +
    (w.minLength.trim() ? 1 : 0);

  const save = async () => {
    setErr("");
    setSaving(true);
    try {
      const targets = w.steps.map((t) => {
        const out: ComboTarget = { model: t.model, accountId: t.accountId ?? null };
        if (w.strategy === "weighted" && t.weight) out.weight = t.weight;
        return out;
      });
      await api.saveCombo({
        name: w.name.trim().toLowerCase(),
        description: w.description.trim() || undefined,
        strategy: w.strategy,
        targets,
        config: buildConfig(),
        enabled: editing ? editing.enabled : true,
      });
      onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  const stages = [
    { title: "Basics", sub: "Name and description" },
    { title: "Steps", sub: "Provider, model, and account selection" },
    { title: "Strategy", sub: "Routing behavior and advanced settings" },
    { title: "Review", sub: "Final validation before saving" },
  ];
  const strat = STRATEGIES.find((s) => s.id === w.strategy);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-3 sm:p-6">
      <div className="w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <h2 className="text-lg font-bold">{editing ? "Edit Combo" : "Create Combo"}</h2>
          <button onClick={onClose} className="text-xl text-zinc-400 hover:text-zinc-200">✕</button>
        </div>
        <div className="max-h-[78vh] overflow-y-auto px-5 py-4">
          {/* Stage tracker */}
          <div className="mb-5 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {stages.map((s, i) => {
              const locked = i > 0 && !stageDone.slice(0, i).every(Boolean);
              const state = i === stage ? "current" : stageDone[i] ? "done" : locked ? "locked" : "todo";
              return (
                <button
                  key={s.title}
                  disabled={locked}
                  onClick={() => setStage(i)}
                  className={`rounded-xl border p-3 text-left ${
                    state === "current"
                      ? "border-amber-600/60 bg-amber-950/30"
                      : "border-zinc-800 bg-zinc-900"
                  } disabled:opacity-50`}
                >
                  <p className="text-sm font-semibold">
                    {state === "done" ? "✓ " : `${i + 1} `}
                    {s.title}
                  </p>
                  <p className="mt-0.5 text-[11px] text-zinc-500">{s.sub}</p>
                  <p className="mt-1 text-[10px] uppercase tracking-wide text-zinc-500">
                    {state === "current" ? "Current stage" : state === "done" ? "Stage completed" : locked ? "Locked — complete previous first" : "Pending"}
                  </p>
                </button>
              );
            })}
          </div>

          {stage === 0 && (
            <div>
              <label className="mb-1 block text-sm font-medium">Combo Name</label>
              <input
                value={w.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="my-combo"
                className={`${input} w-full font-mono`}
              />
              <p className={`mt-1 text-xs ${w.name && !nameValid ? "text-red-400" : "text-zinc-500"}`}>
                Letters, numbers, -, _, / and . allowed
                {w.name && !nameValid ? " — check the name" : ""}
              </p>
              <label className="mb-1 mt-4 block text-sm font-medium">Description</label>
              <input
                value={w.description}
                onChange={(e) => set({ description: e.target.value })}
                placeholder="Optional note describing this combo"
                className={`${input} w-full`}
              />
            </div>
          )}

          {stage === 1 && (
            <div>
              <h3 className="mb-1 font-semibold">Build a Combo</h3>
              <p className="mb-3 text-xs text-zinc-500">
                Build each step in order: provider, model, then account. The same provider
                and model can repeat across different accounts.
              </p>
              <label className="mb-1 block text-xs font-medium text-zinc-400">1. PROVIDER</label>
              <select
                value={w.draft.providerId}
                onChange={(e) => setDraft({ providerId: e.target.value, model: "", accountId: "" })}
                className={`${input} mb-3 w-full`}
              >
                <option value="">Select provider</option>
                {catalog.map((c) => {
                  const n = accountsOf(c.id).length;
                  return (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {n > 0 ? ` (${n} accts)` : ""}
                      {c.connected ? "" : " (not connected)"}
                    </option>
                  );
                })}
              </select>
              <label className="mb-1 block text-xs font-medium text-zinc-400">2. MODEL</label>
              <select
                value={w.draft.model}
                onChange={(e) => setDraft({ model: e.target.value })}
                disabled={!w.draft.providerId}
                className={`${input} mb-3 w-full`}
              >
                <option value="">{w.draft.providerId ? "Select model" : "Pick provider first"}</option>
                {modelsOf(w.draft.providerId).map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <label className="mb-1 block text-xs font-medium text-zinc-400">3. ACCOUNT</label>
              <select
                value={w.draft.accountId}
                onChange={(e) => setDraft({ accountId: e.target.value })}
                className={`${input} mb-3 w-full`}
              >
                <option value="">Automatically select account at runtime</option>
                {accountsOf(w.draft.providerId).map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
              <button
                onClick={addStep}
                disabled={!w.draft.providerId || !w.draft.model}
                className="mb-5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
              >
                Add step
              </button>

              <label className="mb-1 block text-xs font-medium text-zinc-400">COMBO REF</label>
              <div className="mb-5 flex gap-2">
                <select value={refPick} onChange={(e) => setRefPick(e.target.value)} className={`${input} flex-1`}>
                  <option value="">Select combo to reference</option>
                  {combos
                    .filter((c) => c.kind === "router" && c.name !== w.name.trim().toLowerCase())
                    .map((c) => (
                      <option key={c.name} value={c.name}>{c.name}</option>
                    ))}
                </select>
                <button onClick={addRef} disabled={!refPick} className={`${btn} disabled:opacity-50`}>
                  Add combo reference
                </button>
              </div>

              <div className="grid gap-2">
                {w.steps.map((t, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2">
                    <span className="text-xs text-zinc-500">{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs">{t.model}</span>
                      <span className="block text-[11px] text-zinc-500">{accountLabel(t.accountId)}</span>
                    </span>
                    {w.strategy === "weighted" && (
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={t.weight ?? 1}
                        onChange={(e) => {
                          const steps = [...w.steps];
                          steps[i] = { ...t, weight: parseFloat(e.target.value) || 1 };
                          set({ steps });
                        }}
                        className={`${input} w-16 px-2 py-1`}
                        title="Weight"
                      />
                    )}
                    <button onClick={() => moveStep(i, -1)} className="px-1 text-zinc-400 hover:text-zinc-200">↑</button>
                    <button onClick={() => moveStep(i, 1)} className="px-1 text-zinc-400 hover:text-zinc-200">↓</button>
                    <button
                      onClick={() => set({ steps: w.steps.filter((_, j) => j !== i) })}
                      className="px-1 text-red-400 hover:text-red-300"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {w.steps.length === 0 && (
                  <p className="text-sm text-zinc-500">No steps yet — add at least one.</p>
                )}
              </div>
            </div>
          )}

          {stage === 2 && (
            <div>
              <h3 className="mb-3 font-semibold">Routing Strategy</h3>
              <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {STRATEGIES.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => set({ strategy: s.id })}
                    className={`rounded-xl border p-3 text-left text-sm font-medium ${
                      w.strategy === s.id
                        ? "border-amber-600/60 bg-amber-950/30 text-amber-200"
                        : "border-zinc-800 bg-zinc-900 hover:bg-zinc-800"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              {strat && (
                <div className="mb-5 rounded-xl border border-zinc-800 p-3 text-sm text-zinc-400">
                  <p className="mb-1 font-medium text-zinc-200">How to use this strategy</p>
                  {strat.help}
                </div>
              )}
              <details className="rounded-xl border border-zinc-800 p-3">
                <summary className="cursor-pointer text-sm font-semibold">Advanced Settings</summary>
                <div className="mt-3 grid gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-400">
                      Response validation — forbidden substrings (one per line)
                    </label>
                    <textarea
                      value={w.forbidden}
                      onChange={(e) => set({ forbidden: e.target.value })}
                      rows={2}
                      placeholder={"I cannot help\nas an AI"}
                      className={`${input} w-full font-mono text-xs`}
                    />
                    <p className="mt-1 text-[11px] text-zinc-500">
                      Fail over to the next target when a 200 reply contains these.
                    </p>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-400">
                      Required substrings (one per line)
                    </label>
                    <textarea
                      value={w.required}
                      onChange={(e) => set({ required: e.target.value })}
                      rows={2}
                      className={`${input} w-full font-mono text-xs`}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-400">
                      Minimum content length (chars)
                    </label>
                    <input
                      value={w.minLength}
                      onChange={(e) => set({ minLength: e.target.value })}
                      type="number"
                      min="0"
                      className={`${input} w-full`}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-400">
                      Override system message (agents)
                    </label>
                    <textarea
                      value={w.systemPrompt}
                      onChange={(e) => set({ systemPrompt: e.target.value })}
                      rows={2}
                      placeholder="You are an expert assistant…"
                      className={`${input} w-full text-xs`}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-400">Context length</label>
                    <input
                      value={w.contextLength}
                      onChange={(e) => set({ contextLength: e.target.value })}
                      type="number"
                      min="0"
                      placeholder="e.g. 128000"
                      className={`${input} w-full`}
                    />
                    <p className="mt-1 text-[11px] text-zinc-500">
                      Defines the context window for this combo in /v1/models.
                    </p>
                  </div>
                </div>
              </details>
            </div>
          )}

          {stage === 3 && (
            <div>
              <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {[
                  ["NAME", w.name || "—"],
                  ["STRATEGY", strat?.label ?? w.strategy],
                  ["STEPS", String(w.steps.length)],
                  ["ACCOUNTS PINNED", String(w.steps.filter((t) => t.accountId).length)],
                  ["PROVIDERS", String(new Set(w.steps.map((t) => t.model.split(":")[0])).size)],
                  ["COMBO REFERENCES", String(w.steps.filter((t) => !t.model.includes(":") && combos.some((c) => c.name === t.model)).length)],
                  ["ADVANCED SETTINGS", String(advancedCount)],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-xl border border-zinc-800 p-3">
                    <p className="text-[10px] uppercase tracking-wide text-zinc-500">{k}</p>
                    <p className="mt-0.5 truncate font-semibold">{v}</p>
                  </div>
                ))}
              </div>
              <h4 className="mb-2 text-sm font-semibold">Model Sequence</h4>
              <div className="mb-4 grid gap-1.5">
                {w.steps.map((t, i) => (
                  <p key={i} className="rounded-lg border border-zinc-800 px-3 py-2 font-mono text-xs">
                    {i + 1}. {t.model} · {accountLabel(t.accountId)}
                  </p>
                ))}
              </div>
              <div className="rounded-xl border border-emerald-900/60 bg-emerald-950/20 p-3">
                <p className="mb-1 font-semibold text-emerald-300">Ready to save?</p>
                <p className="mb-2 text-xs text-zinc-400">Review the checklist before creating or updating this combo.</p>
                {[
                  [nameValid, "Combo name is valid"],
                  [stepsDone, "At least one model is selected"],
                  [true, "Weight rule not required"],
                  [true, "Pricing rule not required"],
                ].map(([ok, label]) => (
                  <p key={label as string} className={`text-sm ${ok ? "text-emerald-300" : "text-red-400"}`}>
                    {ok ? "✓" : "✗"} {label}
                  </p>
                ))}
              </div>
              {err && <p className="mt-3 text-sm text-red-400">{err}</p>}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-zinc-800 px-5 py-4">
          <button onClick={() => (stage === 0 ? onClose() : setStage(stage - 1))} className={btn}>
            {stage === 0 ? "Cancel" : "Back"}
          </button>
          {stage < 3 ? (
            <button
              onClick={() => setStage(stage + 1)}
              disabled={!stageDone[stage]}
              className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
            >
              Next
            </button>
          ) : (
            <button
              onClick={save}
              disabled={saving || !nameValid || !stepsDone}
              className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
            >
              {saving ? "Saving…" : editing ? "Update combo" : "Create combo"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Combos() {
  const [combos, setCombos] = useState<ServerCombo[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [templates, setTemplates] = useState<AutoTemplateInfo[]>([]);
  const [error, setError] = useState("");
  const [wizard, setWizard] = useState<{ open: boolean; editing: ServerCombo | null }>({
    open: false,
    editing: null,
  });
  const [catalogOpen, setCatalogOpen] = useState(true);
  const [tests, setTests] = useState<
    Record<string, { state: "running" | "done"; result?: ComboTestResult }>
  >({});
  const [copied, setCopied] = useState("");

  const load = () => {
    api.combos().then((r) => setCombos(r.combos)).catch((e) => setError(String(e)));
    api.catalog().then(setCatalog).catch(() => {});
    api.accounts().then((r) => setAccounts(r.accounts)).catch(() => {});
    api.autoCatalog().then((r) => setTemplates(r.templates)).catch(() => {});
  };
  useEffect(load, []);

  const routerCombos = useMemo(() => combos.filter((c) => c.kind === "router"), [combos]);
  const pipelines = useMemo(() => combos.filter((c) => c.kind === "pipeline"), [combos]);
  const accountLabel = (id?: string | null) =>
    id ? (accounts.find((a) => a.id === id)?.label ?? "pinned account") : "dynamic account";

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(text);
    setTimeout(() => setCopied(""), 1500);
  };

  const test = async (c: ServerCombo) => {
    setTests((s) => ({ ...s, [c.name]: { state: "running" } }));
    try {
      const result = await api.testCombo(c.name);
      setTests((s) => ({ ...s, [c.name]: { state: "done", result } }));
    } catch (e) {
      setTests((s) => ({
        ...s,
        [c.name]: {
          state: "done",
          result: { ok: false, combo: c.name, resolvedBy: null, results: [] },
        },
      }));
      setError(String(e));
    }
  };

  const toggleEnabled = async (c: ServerCombo) => {
    await api
      .saveCombo({
        name: c.name,
        description: c.description ?? undefined,
        strategy: c.strategy ?? "priority",
        targets: c.targets ?? [],
        config: c.config ?? undefined,
        enabled: !c.enabled,
      })
      .catch(() => {});
    load();
  };

  const remove = async (c: ServerCombo) => {
    await api.deleteCombo(c.name).catch(() => {});
    load();
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Combos</h1>
        <button
          onClick={() => setWizard({ open: true, editing: null })}
          className="rounded-lg bg-gradient-to-r from-amber-600 to-yellow-600 px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          + Create Combo
        </button>
      </div>
      <p className="mb-6 max-w-2xl text-sm text-zinc-500">
        A combo is a virtual model: send{" "}
        <code className="rounded bg-zinc-800 px-1">model: "&lt;combo-name&gt;"</code> and the
        gateway walks its targets in strategy order until one answers.
      </p>
      {error && <p className="mb-4 text-red-400">{error}</p>}

      {/* Auto-routing catalog */}
      <div className={`${card} mb-8`}>
        <button
          onClick={() => setCatalogOpen((v) => !v)}
          className="flex w-full items-center justify-between"
        >
          <span className="font-semibold">
            ✨ Auto-routing catalog{" "}
            <span className="ml-1 rounded-full bg-amber-900/60 px-2 py-0.5 text-[11px] text-amber-300">
              {templates.length} templates
            </span>
          </span>
          <span className="text-zinc-500">{catalogOpen ? "▾" : "▸"}</span>
        </button>
        {catalogOpen && (
          <>
            <p className="mb-3 mt-1 text-xs text-zinc-500">
              Built-in auto/* combos resolved dynamically from connected providers. Use any
              of these IDs as the model field — no setup needed.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              {templates.map((t) => (
                <div key={t.id} className="rounded-xl border border-zinc-800 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm font-semibold">{t.id}</span>
                    <span className="flex items-center gap-1">
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400">
                        {t.strategy}
                      </span>
                      <button
                        onClick={() => copy(t.id)}
                        title="Copy model id"
                        className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] hover:bg-zinc-800"
                      >
                        {copied === t.id ? "✓" : "⧉"}
                      </button>
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm font-medium">{t.title}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {t.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">
                        {tag}
                      </span>
                    ))}
                    <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-500">
                      {t.candidates} candidates now
                    </span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-xs italic text-zinc-500">{t.systemPrompt}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Combo cards */}
      <h2 className="mb-3 font-semibold">Your combos ({routerCombos.length})</h2>
      <div className="mb-8 grid gap-4 md:grid-cols-2">
        {routerCombos.map((c) => {
          const tr = tests[c.name];
          const targets = c.targets ?? [];
          return (
            <div key={c.name} className={card}>
              <div className="mb-1 flex items-center justify-between gap-2">
                <h3 className="min-w-0 truncate font-mono font-semibold">{c.name}</h3>
                <span className="flex shrink-0 items-center gap-1">
                  <span className="rounded bg-blue-900/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-blue-300">
                    {c.strategy ?? "priority"}
                  </span>
                  <button
                    onClick={() => copy(c.name)}
                    title="Copy model id"
                    className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] hover:bg-zinc-800"
                  >
                    {copied === c.name ? "✓" : "⧉"}
                  </button>
                </span>
              </div>
              {c.description && <p className="mb-2 text-xs text-zinc-500">{c.description}</p>}
              <div className="mb-3 grid gap-1.5">
                {targets.slice(0, 3).map((t, i) => (
                  <p key={i} className="truncate rounded bg-zinc-800/70 px-2 py-1 font-mono text-[11px] text-zinc-300">
                    {t.model}
                    <span className="text-zinc-500"> · {accountLabel(t.accountId)}</span>
                    {t.weight ? <span className="text-zinc-500"> · ×{t.weight}</span> : null}
                  </p>
                ))}
                {targets.length > 3 && (
                  <p className="text-[11px] text-zinc-500">+{targets.length - 3} more</p>
                )}
              </div>

              {tr?.state === "done" && tr.result && (
                <div className="mb-3 rounded-lg border border-zinc-800 p-2.5">
                  {tr.result.resolvedBy ? (
                    <p className="mb-1.5 text-xs">
                      Resolved by:{" "}
                      <span className="rounded bg-emerald-900/60 px-1.5 py-0.5 font-mono text-emerald-300">
                        {tr.result.resolvedBy.provider}/{tr.result.resolvedBy.model}
                      </span>
                    </p>
                  ) : (
                    <p className="mb-1.5 text-xs text-red-400">No target answered.</p>
                  )}
                  <div className="grid gap-1">
                    {tr.result.results.map((r, i) => (
                      <p key={i} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="min-w-0 truncate font-mono text-zinc-400">
                          {r.ok ? "✓" : "✗"} {r.target}
                        </span>
                        <span className={r.ok ? "shrink-0 text-emerald-400" : "shrink-0 text-red-400"}>
                          {r.latencyMs}ms {r.ok ? "OK" : "ERROR"}
                        </span>
                      </p>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => toggleEnabled(c)}
                  className={`relative h-5 w-9 rounded-full transition ${c.enabled ? "bg-emerald-600" : "bg-zinc-700"}`}
                  title={c.enabled ? "Active" : "Disabled"}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${c.enabled ? "left-4.5 left-[18px]" : "left-0.5"}`}
                  />
                </button>
                <span className="text-xs text-zinc-400">{c.enabled ? "Active" : "Off"}</span>
                <span className="flex-1" />
                <button
                  onClick={() => test(c)}
                  disabled={tr?.state === "running"}
                  className={`${btn} px-2.5 py-1 text-xs disabled:opacity-50`}
                >
                  {tr?.state === "running" ? "Testing…" : "▶ Test"}
                </button>
                <button
                  onClick={() => setWizard({ open: true, editing: c })}
                  className={`${btn} px-2.5 py-1 text-xs`}
                >
                  Edit
                </button>
                <button
                  onClick={() => remove(c)}
                  className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-red-400 hover:bg-zinc-800"
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
        {routerCombos.length === 0 && (
          <p className="text-sm text-zinc-500">
            No combos yet — create one, or use the auto/* templates above right away.
          </p>
        )}
      </div>

      {pipelines.length > 0 && (
        <>
          <h2 className="mb-3 font-semibold">Pipeline combos ({pipelines.length})</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {pipelines.map((c) => (
              <div key={c.name} className={card}>
                <div className="mb-1 flex items-center justify-between">
                  <h3 className="font-mono font-semibold">{c.name}</h3>
                  <button onClick={() => remove(c)} className="text-xs text-red-400 hover:text-red-300">
                    Delete
                  </button>
                </div>
                <p className="text-xs text-zinc-500">
                  Sequential pipeline: {(c.steps ?? []).map((s) => s.model).join(" → ")} · run
                  via POST /v1/combos/{c.name}/run
                </p>
              </div>
            ))}
          </div>
        </>
      )}

      {wizard.open && (
        <Wizard
          initial={wizard.editing ? wizardFromCombo(wizard.editing) : emptyWizard()}
          editing={wizard.editing}
          catalog={catalog}
          accounts={accounts}
          combos={combos}
          onClose={() => setWizard({ open: false, editing: null })}
          onSaved={() => {
            setWizard({ open: false, editing: null });
            load();
          }}
        />
      )}
    </div>
  );
}
