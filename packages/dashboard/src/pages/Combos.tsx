import { useEffect, useState } from "react";
import { api, type CatalogEntry, type ServerCombo } from "../api";

const card = "rounded-xl border border-zinc-800 bg-zinc-900 p-4";
const input =
  "rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm";
const STRATEGIES: Array<{ id: string; help: string }> = [
  { id: "priority", help: "Try targets in order; first success wins (fallback chain)." },
  { id: "weighted", help: "Pick one target by weight, then fall back in order." },
  { id: "round-robin", help: "Rotate the starting target on every request." },
  { id: "random", help: "Shuffle the targets on every request." },
  { id: "least-used", help: "Least-called provider first (spreads load)." },
  { id: "cost-optimized", help: "Cheapest providers first." },
  { id: "fill-first", help: "Stick to the first target until it fails." },
];

interface TargetRow {
  providerId: string; // catalog id, "__combo__", or "__auto__"
  model: string;
  weight: string;
}

export default function Combos() {
  const [combos, setCombos] = useState<ServerCombo[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [error, setError] = useState("");
  const [tests, setTests] = useState<
    Record<string, { state: "running" | "ok" | "fail"; line: string }>
  >({});

  // builder state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [strategy, setStrategy] = useState("priority");
  const [rows, setRows] = useState<TargetRow[]>([
    { providerId: "", model: "", weight: "1" },
  ]);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  const load = () => {
    api.combos().then((r) => setCombos(r.combos)).catch((e) => setError(String(e)));
    api.catalog().then(setCatalog).catch(() => {});
  };
  useEffect(load, []);

  const routerCombos = combos.filter((c) => c.kind === "router");
  const pipelines = combos.filter((c) => c.kind === "pipeline");
  const modelsOf = (pid: string) => catalog.find((c) => c.id === pid)?.models ?? [];

  const setRow = (i: number, patch: Partial<TargetRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: number) =>
    setRows((rs) => {
      const j = i + d;
      if (j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const rowToTarget = (r: TargetRow) => {
    if (r.providerId === "__auto__") return { model: "auto" };
    if (r.providerId === "__combo__") return { model: r.model };
    const model = `${r.providerId}:${r.model}`;
    const w = parseFloat(r.weight);
    return strategy === "weighted" && Number.isFinite(w) && w > 0
      ? { model, weight: w }
      : { model };
  };

  const save = async () => {
    setSaveMsg("");
    const targets = rows
      .filter((r) => r.providerId && (r.providerId === "__auto__" || r.model))
      .map(rowToTarget);
    if (!name.trim() || targets.length === 0) {
      setSaveMsg("Give the combo a name and at least one complete target.");
      return;
    }
    setSaving(true);
    try {
      await api.saveCombo({
        name: name.trim().toLowerCase(),
        description: description.trim() || undefined,
        strategy,
        targets,
      });
      setName("");
      setDescription("");
      setRows([{ providerId: "", model: "", weight: "1" }]);
      load();
    } catch (e) {
      setSaveMsg(String(e));
    } finally {
      setSaving(false);
    }
  };

  const test = async (c: ServerCombo) => {
    setTests((s) => ({ ...s, [c.name]: { state: "running", line: "" } }));
    try {
      const r = await api.testCombo(c.name);
      setTests((s) => ({
        ...s,
        [c.name]: r.ok
          ? {
              state: "ok",
              line: `✓ ${r.provider}:${r.model} · ${r.latencyMs} ms · "${r.text ?? ""}"`,
            }
          : { state: "fail", line: `✗ ${r.error ?? "failed"}` },
      }));
    } catch (e) {
      setTests((s) => ({ ...s, [c.name]: { state: "fail", line: `✗ ${String(e)}` } }));
    }
  };

  const remove = async (c: ServerCombo) => {
    await api.deleteCombo(c.name).catch(() => {});
    load();
  };

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold">Combos</h1>
      <p className="mb-6 max-w-2xl text-sm text-zinc-500">
        A combo is a <b className="text-zinc-300">virtual model</b>: send a request with{" "}
        <code className="rounded bg-zinc-800 px-1">model: "&lt;combo-name&gt;"</code> and the
        gateway tries its targets in strategy order until one answers — exactly like
        OmniRoute combos. Failed targets fall through automatically.
      </p>
      {error && <p className="mb-4 text-red-400">{error}</p>}

      {/* Builder */}
      <div className={`${card} mb-8`}>
        <h2 className="mb-3 font-semibold">New router combo</h2>
        <div className="mb-3 flex flex-wrap gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Combo name (e.g. free-pool)"
            className={`${input} w-56`}
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            className={`${input} min-w-48 flex-1`}
          />
          <select
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
            className={input}
          >
            {STRATEGIES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          {STRATEGIES.find((s) => s.id === strategy)?.help}
        </p>
        <div className="grid gap-2">
          {rows.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <span className="w-6 text-xs text-zinc-500">{i + 1}.</span>
              <select
                value={r.providerId}
                onChange={(e) => setRow(i, { providerId: e.target.value, model: "" })}
                className={input}
              >
                <option value="">Pick provider…</option>
                <option value="__auto__">auto (any provider)</option>
                {routerCombos.length > 0 && <option value="__combo__">— another combo —</option>}
                {catalog.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.connected ? "" : " (not connected)"}
                  </option>
                ))}
              </select>
              {r.providerId === "__combo__" ? (
                <select
                  value={r.model}
                  onChange={(e) => setRow(i, { model: e.target.value })}
                  className={`${input} min-w-44 flex-1`}
                >
                  <option value="">Pick combo…</option>
                  {routerCombos
                    .filter((c) => c.name !== name.trim().toLowerCase())
                    .map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                </select>
              ) : r.providerId && r.providerId !== "__auto__" ? (
                <select
                  value={r.model}
                  onChange={(e) => setRow(i, { model: e.target.value })}
                  className={`${input} min-w-44 flex-1`}
                >
                  <option value="">Pick model…</option>
                  {modelsOf(r.providerId).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="flex-1" />
              )}
              {strategy === "weighted" && (
                <input
                  value={r.weight}
                  onChange={(e) => setRow(i, { weight: e.target.value })}
                  type="number"
                  min="0"
                  step="any"
                  title="Weight"
                  className={`${input} w-20`}
                />
              )}
              <button
                onClick={() => move(i, -1)}
                className="rounded-lg border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
              >
                ↑
              </button>
              <button
                onClick={() => move(i, 1)}
                className="rounded-lg border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
              >
                ↓
              </button>
              {rows.length > 1 && (
                <button
                  onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setRows((rs) => [...rs, { providerId: "", model: "", weight: "1" }])}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
          >
            + Add target
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save combo"}
          </button>
          {saveMsg && <span className="text-sm text-red-400">{saveMsg}</span>}
        </div>
      </div>

      {/* Router combos list */}
      <h2 className="mb-3 font-semibold">Router combos ({routerCombos.length})</h2>
      <div className="mb-8 grid gap-4 md:grid-cols-2">
        {routerCombos.map((c) => {
          const tr = tests[c.name];
          return (
            <div key={c.name} className={card}>
              <div className="mb-1 flex items-center justify-between gap-2">
                <h3 className="font-mono font-semibold">{c.name}</h3>
                <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300">
                  {c.strategy ?? "priority"}
                </span>
              </div>
              {c.description && <p className="mb-2 text-xs text-zinc-500">{c.description}</p>}
              <div className="mb-3 flex flex-wrap gap-1.5">
                {(c.targets ?? []).map((t, i) => (
                  <span
                    key={i}
                    className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300"
                  >
                    {t.model}
                    {t.weight ? ` ×${t.weight}` : ""}
                  </span>
                ))}
              </div>
              {tr && (
                <p
                  className={`mb-2 break-words text-xs ${tr.state === "fail" ? "text-red-400" : "text-emerald-400"}`}
                >
                  {tr.state === "running" ? "Testing…" : tr.line}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => test(c)}
                  disabled={tr?.state === "running"}
                  className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium hover:bg-zinc-700 disabled:opacity-50"
                >
                  Test
                </button>
                <button
                  onClick={() => remove(c)}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-800"
                >
                  Delete
                </button>
              </div>
              <p className="mt-2 text-[11px] text-zinc-600">
                Use it anywhere a model goes:{" "}
                <code className="rounded bg-zinc-800 px-1">model: "{c.name}"</code>
              </p>
            </div>
          );
        })}
        {routerCombos.length === 0 && (
          <p className="text-sm text-zinc-500">
            No router combos yet — build one above (e.g. a free-pool of your keyless
            providers).
          </p>
        )}
      </div>

      {/* Pipeline combos (server pipelines, kept from before) */}
      {pipelines.length > 0 && (
        <>
          <h2 className="mb-3 font-semibold">Pipeline combos ({pipelines.length})</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {pipelines.map((c) => (
              <div key={c.name} className={card}>
                <div className="mb-1 flex items-center justify-between">
                  <h3 className="font-mono font-semibold">{c.name}</h3>
                  <button
                    onClick={() => remove(c)}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Delete
                  </button>
                </div>
                <p className="text-xs text-zinc-500">
                  Sequential pipeline: {(c.steps ?? []).map((s) => s.model).join(" → ")} ·
                  run via POST /v1/combos/{c.name}/run
                </p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
