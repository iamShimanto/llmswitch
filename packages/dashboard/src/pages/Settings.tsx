import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, authApi, setSession, type ConfigPatch, type GatewayConfig } from "../api";
import { Tabs } from "../components/Tabs";
import { applyTheme, getTheme, applyPalette, getPalette, type Theme, type Palette } from "../theme";

// Mirrors STRATEGY_NAMES in packages/core/src/router/strategies.ts
const STRATEGIES = [
  "priority",
  "weighted",
  "round-robin",
  "context-relay",
  "fill-first",
  "p2c",
  "random",
  "least-used",
  "cost-optimized",
  "reset-aware",
  "reset-window",
  "headroom",
  "quota-weighted",
  "strict-random",
  "auto",
  "lkgp",
  "context-optimized",
  "cache-optimized",
  "fusion",
  "pipeline",
];

const COMPRESSION_MODES = ["caveman", "rtk", "stacked"];

function Source({ source }: { source: "db" | "env" }) {
  return (
    <span
      title={source === "db" ? "Set via dashboard (stored in SQLite)" : "From environment / default"}
      className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${
        source === "db" ? "bg-sky-900 text-sky-300" : "bg-zinc-800 text-zinc-400"
      }`}
    >
      {source}
    </span>
  );
}

const row = "rounded-xl border border-zinc-800 bg-zinc-900 p-4";
const label = "mb-1 block text-sm font-medium";
const hint = "mt-1 text-xs text-zinc-500";
const input = "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm";

export default function Settings() {
  const { t } = useLang();
  const [tab, setTab] = useState("general");
  const [cfg, setCfg] = useState<GatewayConfig | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  // form state
  const [strategy, setStrategy] = useState("");
  const [piiRedact, setPiiRedact] = useState(true);
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  async function changeDashboardPassword() {
    setPwMsg("");
    try {
      const r = await authApi.changePassword(curPw, newPw);
      setSession(r.token);
      setCurPw("");
      setNewPw("");
      setPwMsg(t("settings.passwordChanged"));
    } catch {
      setPwMsg(t("settings.passwordWrong"));
    }
  }
  const [compression, setCompression] = useState("");
  const [webhook, setWebhook] = useState("");
  const [budgetAction, setBudgetAction] = useState<"warn" | "block">("warn");
  const [globalBudget, setGlobalBudget] = useState("");
  const [theme, setTheme] = useState<Theme>("dark");
  const [palette, setPalette] = useState<Palette>("bronze");

  const load = () => {
    setTheme(getTheme());
    setPalette(getPalette());
    api.getConfig()
      .then((c) => {
        setCfg(c);
        setStrategy(c.strategy.value);
        setPiiRedact(c.pii_redact.value);
        setCompression(c.compression_default.value ?? "");
        setWebhook(c.alert_webhook_url.value ?? "");
        setBudgetAction(c.budget_action.value === "block" ? "block" : "warn");
        setGlobalBudget(c.global_budget_usd.value != null ? String(c.global_budget_usd.value) : "");
      })
      .catch((e) => setError(String(e)));
  };
  useEffect(load, []);
  useEffect(() => {
    const onTheme = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener("llmswitch-theme", onTheme);
    return () => window.removeEventListener("llmswitch-theme", onTheme);
  }, []);

  const save = async () => {
    setError("");
    setSaved("");
    const patch: ConfigPatch = {
      strategy,
      pii_redact: piiRedact,
      compression_default: compression || null,
      alert_webhook_url: webhook.trim() || null,
      budget_action: budgetAction,
      global_budget_usd: globalBudget.trim() ? Number(globalBudget) : null,
    };
    if (patch.global_budget_usd != null && !(patch.global_budget_usd > 0)) {
      setError(t("settings.budgetPositive"));
      return;
    }
    try {
      const c = await api.putConfig(patch);
      setCfg(c);
      setSaved(t("common.savedCheck"));
      setTimeout(() => setSaved(""), 3000);
    } catch (e) {
      setError(String(e));
    }
  };

  const pickTheme = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
  };

  const pickPalette = (p: Palette) => {
    setPalette(p);
    applyPalette(p);
  };

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.settings")}</h1>
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "general", label: "General" },
          { id: "routing", label: "Routing" },
          { id: "cache", label: "Cache" },
          { id: "security", label: "Security" },
          { id: "appearance", label: "Appearance" },
          { id: "ai", label: "AI" },
          { id: "advanced", label: "Advanced" },
        ]}
      />
      {error && <p className="mb-4 text-red-400">{error}</p>}
      {saved && <p className="mb-4 text-emerald-400">{saved}</p>}
      {!cfg && !error && <p className="text-zinc-500">{t("common.loading")}</p>}

      {cfg && tab === "general" && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className={row}>
            <label className={label}>{t("common.budgetAction")}<Source source={cfg.budget_action.source} /></label>
            <select value={budgetAction} onChange={(e) => setBudgetAction(e.target.value as "warn" | "block")} className={input}>
              <option value="warn">{t("common.warnHeader")}</option>
              <option value="block">{t("common.block402Exceed")}</option>
            </select>
            <p className={hint}>{t("common.budgetHint")}</p>
          </div>
          <div className={row}>
            <label className={label}>Global monthly budget (USD) <Source source={cfg.global_budget_usd.source} /></label>
            <input
              value={globalBudget}
              onChange={(e) => setGlobalBudget(e.target.value)}
              placeholder="e.g. 50 — empty = no cap"
              inputMode="decimal"
              className={input}
            />
            <p className={hint}>
              Spent this month: ${cfg.global_budget_usd.spentMonthToDate.toFixed(4)} across all keys.
            </p>
          </div>
        </div>
      )}

      {cfg && tab === "routing" && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className={row}>
            <label className={label}>{t("common.routingStrategy")}<Source source={cfg.strategy.source} /></label>
            <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className={input}>
              {STRATEGIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <p className={hint}>Default strategy for /v1/chat/completions (per-request header x-llmswitch-strategy wins).</p>
          </div>
          <div className={row}>
            <h2 className="mb-2 font-semibold">{t("settings.strategyNotes")}</h2>
            <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-400">
              <li><code className="text-zinc-300">cost-optimized</code>{t("settings.picksCheapest")}</li>
              <li><code className="text-zinc-300">quota-weighted</code>{t("settings.usesTelemetry")}</li>
              <li><code className="text-zinc-300">auto</code>{t("settings.letsDecide")}</li>
            </ul>
            <p className={hint}>Explain any decision on the Routing page (/explain).</p>
          </div>
        </div>
      )}

      {cfg && tab === "cache" && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className={row}>
            <label className={label}>{t("common.defaultCompression")}<Source source={cfg.compression_default.source} /></label>
            <select value={compression} onChange={(e) => setCompression(e.target.value)} className={input}>
              <option value="">{t("common.off")}</option>
              {COMPRESSION_MODES.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <p className={hint}>{t("common.compressionHint")}</p>
          </div>
          <div className={row}>
            <h2 className="mb-2 font-semibold">{t("settings.cacheControls")}</h2>
            <p className="text-sm text-zinc-400">{t("settings.cacheLiveOn")}<span className="font-medium text-zinc-200">{t("nav.cache")}</span>{t("settings.semanticVia")}<code className="rounded bg-zinc-800 px-1 text-xs">SEMANTIC_CACHE=1</code>{t("memory.on_the_gateway")}</p>
          </div>
        </div>
      )}

      {cfg && tab === "security" && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className={row}>
            <label className={label}>{t("common.piiRedaction")}<Source source={cfg.pii_redact.source} /></label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={piiRedact} onChange={(e) => setPiiRedact(e.target.checked)} className="h-4 w-4" />{t("common.piiHint")}</label>
            <p className={hint}>{t("common.onByDefault")}</p>
          </div>
          <div className={row}>
            <h2 className="mb-2 font-semibold">🔒 {t("settings.dashboardPassword")}</h2>
            <p className="mb-3 text-sm text-zinc-400">{t("settings.dashboardPasswordHint")}</p>
            <label className={label}>{t("settings.currentPassword")}</label>
            <input type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} className="mb-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
            <label className={label}>{t("settings.newPassword")}</label>
            <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} className="mb-3 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
            <button onClick={changeDashboardPassword} disabled={!curPw || newPw.length < 6} className="rounded-lg bg-zinc-100 px-4 py-1.5 text-sm font-semibold text-zinc-900 disabled:opacity-50">
              {t("settings.changePassword")}
            </button>
            {pwMsg && <p className="mt-2 text-sm text-zinc-300">{pwMsg}</p>}
          </div>
          <div className={row}>
            <h2 className="mb-2 font-semibold">{t("profile.admin_key")}</h2>
            <p className="text-sm text-zinc-400">{t("common.set")}<code className="rounded bg-zinc-800 px-1 text-xs">ADMIN_KEY</code>{t("settings.gateAll")}<code className="rounded bg-zinc-800 px-1 text-xs">/api/*</code> management routes.
              Enter it via the 🔑 button in the header; it is stored only in your browser.
            </p>
          </div>
        </div>
      )}

      {tab === "appearance" && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className={row}>
            <h2 className="mb-2 font-semibold">{t("settings.theme")}</h2>
            <div className="flex gap-2">
              {(["dark", "light"] as Theme[]).map((t) => (
                <button
                  key={t}
                  onClick={() => pickTheme(t)}
                  className={`rounded-lg border px-5 py-2 text-sm capitalize ${
                    theme === t
                      ? "border-sky-600 bg-sky-950 text-sky-200"
                      : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
                  }`}
                >
                  {t === "dark" ? "🌙 Dark" : "☀️ Light"}
                </button>
              ))}
            </div>
            <p className={hint}>{t("settings.themeHint")}</p>
          </div>
          <div className={row}>
            <h2 className="mb-2 font-semibold">{t("settings.palette")}</h2>
            <div className="flex gap-2">
              {([
                { id: "bronze", label: "Bronze", dots: ["#171412", "#faf7f2", "#d6ad68"] },
                { id: "default", label: "Default", dots: ["#09090b", "#fafafa", "#0284c7"] },
              ] as { id: Palette; label: string; dots: string[] }[]).map((p) => (
                <button
                  key={p.id}
                  onClick={() => pickPalette(p.id)}
                  className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm ${
                    palette === p.id
                      ? "border-sky-600 bg-sky-950 text-sky-200"
                      : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
                  }`}
                >
                  <span className="flex -space-x-1">
                    {p.dots.map((c) => (
                      <span key={c} className="h-3.5 w-3.5 rounded-full border border-zinc-600" style={{ backgroundColor: c }} />
                    ))}
                  </span>
                  {p.label}
                </button>
              ))}
            </div>
            <p className={hint}>{t("settings.paletteHint")}</p>
          </div>
        </div>
      )}

      {cfg && tab === "ai" && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className={row}>
            <label className={label}>{t("common.alertWebhookUrl")}<Source source={cfg.alert_webhook_url.source} /></label>
            <input
              value={webhook}
              onChange={(e) => setWebhook(e.target.value)}
              placeholder="https://…"
              className={input}
            />
            <p className={hint}>
              {cfg.alert_webhook_url.enabled ? "Alerts enabled ✓" : "No webhook — alerts disabled."} Applies immediately, survives restarts.
            </p>
          </div>
          <div className={row}>
            <h2 className="mb-2 font-semibold">{t("settings.alertEvents")}</h2>
            <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-400">
              <li>{t("settings.errorSpikes")}</li>
              <li>{t("settings.budgetThresholds")}</li>
              <li>{t("settings.quotaWarnings")}</li>
            </ul>
            <p className={hint}>{t("settings.webhooksPage")}</p>
          </div>
        </div>
      )}

      {cfg && tab === "advanced" && (
        <div className={row}>
          <h2 className="mb-2 font-semibold">Raw config (read-only)</h2>
          <pre className="max-h-96 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-300">
            {JSON.stringify(cfg, null, 2)}
          </pre>
          <p className={hint}>Edit via the tabs above, or via PUT /api/config with the admin key.</p>
        </div>
      )}

      {tab !== "appearance" && (
        <div className="mt-6">
          <button
            onClick={save}
            disabled={!cfg}
            className="rounded-lg bg-sky-600 px-6 py-2 text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
          >{t("common.saveSettings")}</button>
        </div>
      )}
    </div>
  );
}
