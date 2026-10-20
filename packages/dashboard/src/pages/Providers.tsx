import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, type OAuthStatus, type ProviderInfo } from "../api";

function ProviderDetail({ p, onBack }: { p: ProviderInfo; onBack: () => void }) {
  const { t } = useLang();
  const [models, setModels] = useState<string[]>(p.models);
  const [discovering, setDiscovering] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string>("");
  const [error, setError] = useState("");
  const [modelTests, setModelTests] = useState<
    Record<string, { state: "running" | "ok" | "fail"; latencyMs?: number; error?: string }>
  >({});
  const [testingAll, setTestingAll] = useState(false);

  const testModel = async (m: string) => {
    setModelTests((r) => ({ ...r, [m]: { state: "running" } }));
    try {
      const r = await api.testModel(p.id, m);
      setModelTests((prev) => ({
        ...prev,
        [m]: r.ok
          ? { state: "ok", latencyMs: r.latencyMs }
          : { state: "fail", latencyMs: r.latencyMs, error: r.error ?? "failed" },
      }));
    } catch (e) {
      setModelTests((prev) => ({ ...prev, [m]: { state: "fail", error: String(e) } }));
    }
  };

  const testAll = async () => {
    setTestingAll(true);
    for (const m of models) {
      await testModel(m);
    }
    setTestingAll(false);
  };

  const avg = p.stats.calls > 0 ? Math.round(p.stats.totalLatencyMs / p.stats.calls) : null;
  const errRate = p.stats.calls > 0 ? (p.stats.errors / p.stats.calls) * 100 : 0;

  const discover = async () => {
    setDiscovering(true);
    setError("");
    try {
      const r = await api.discover(p.id);
      setModels(r.models);
    } catch (e) {
      setError(String(e));
    } finally {
      setDiscovering(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setError("");
    setTestResult("");
    try {
      const r = await api.playground([{ role: "user", content: "Reply with the single word: ok" }], [p.id]);
      const res = r.results[0];
      setTestResult(res.ok ? `✓ ${(res.text ?? "").slice(0, 200)} (${res.latencyMs} ms)` : `✗ ${res.error}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setTesting(false);
    }
  };

  const card = "rounded-xl border border-zinc-800 bg-zinc-900 p-4";

  return (
    <div>
      <button onClick={onBack} className="mb-4 text-sm text-sky-400 hover:text-sky-300">{t("providers.backTo")}</button>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{p.name}</h1>
            {p.authType === "none" && (
              <span className="rounded-full bg-sky-900 px-2 py-0.5 text-xs text-sky-300">{t("providers.keylessBadge")}</span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {p.id} · {p.wireFormat} · default: {p.defaultModel}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={discover}
            disabled={discovering}
            className="rounded-lg border border-zinc-700 px-4 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-50"
          >
            {discovering ? "Discovering…" : "Discover models"}
          </button>
          <button
            onClick={test}
            disabled={testing}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
          >
            {testing ? "Testing…" : "Test provider"}
          </button>
        </div>
      </div>

      {testResult && (
        <div className={`${card} mb-4`}>
          <p className="text-sm">{testResult}</p>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          { label: "Calls", value: String(p.stats.calls) },
          { label: "Errors", value: `${p.stats.errors} (${errRate.toFixed(1)}%)` },
          { label: "Avg latency", value: avg == null ? "—" : `${avg} ms` },
          { label: "Models", value: String(models.length) },
        ].map((s) => (
          <div key={s.label} className={card}>
            <p className="text-xs text-zinc-500">{s.label}</p>
            <p className="mt-1 text-2xl font-bold">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Models ({models.length})</h2>
        {models.length > 0 && (
          <button
            onClick={testAll}
            disabled={testingAll}
            className="rounded-lg border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
          >
            {testingAll ? "Testing…" : "Test all models"}
          </button>
        )}
      </div>
      <div className={card}>
        {models.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No models listed — this provider passes model ids through. Use{" "}
            <code className="rounded bg-zinc-800 px-1 text-xs">{p.id}:&lt;model&gt;</code>{t("providers.discoverAbove")}</p>
        ) : (
          <div className="divide-y divide-zinc-800">
            {models.map((m) => {
              const r = modelTests[m];
              return (
                <div key={m} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200" title={m}>
                    {m}
                  </span>
                  {r?.state === "ok" && (
                    <span className="shrink-0 text-xs text-emerald-400">✓ works · {r.latencyMs} ms</span>
                  )}
                  {r?.state === "fail" && (
                    <span className="max-w-56 shrink-0 truncate text-xs text-red-400" title={r.error}>
                      ✗ {r.error}
                    </span>
                  )}
                  <button
                    onClick={() => testModel(m)}
                    disabled={r?.state === "running"}
                    className="shrink-0 rounded-lg bg-zinc-800 px-3 py-1 text-xs font-medium hover:bg-zinc-700 disabled:opacity-50"
                  >
                    {r?.state === "running" ? "Testing…" : "Test"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <p className="mt-4 text-xs text-zinc-500">{t("providers.addressModel")}<code className="rounded bg-zinc-800 px-1">{p.id}:&lt;model-id&gt;</code>{t("providers.inThe")}<code className="rounded bg-zinc-800 px-1">{t("providers.modelField")}</code>{t("providers.fieldFrag")}</p>
    </div>
  );
}

interface OAuthPanelCfg {
  id: string;
  name: string;
  hintKey: string;
  connectKey: string;
  connectingKey: string;
}

const OAUTH_PANEL: OAuthPanelCfg[] = [
  { id: "antigravity", name: "Antigravity", hintKey: "oauth.connectHint", connectKey: "oauth.connectAntigravity", connectingKey: "oauth.connecting" },
  { id: "claude", name: "Claude", hintKey: "oauth.connectHintClaude", connectKey: "oauth.connectClaude", connectingKey: "oauth.connectingGeneric" },
  { id: "codex", name: "Codex", hintKey: "oauth.connectHintCodex", connectKey: "oauth.connectCodex", connectingKey: "oauth.connectingGeneric" },
];

/** One OAuth provider's browser connect/disconnect card. */
function OAuthConnectCard({ cfg }: { cfg: OAuthPanelCfg }) {
  const { t } = useLang();
  const [status, setStatus] = useState<OAuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.oauthStatus(cfg.id).then(setStatus).catch(() => setStatus(null));
  }, [cfg.id]);

  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      const { url } = await api.oauthStart(cfg.id);
      window.location.href = url; // same tab: provider consent → callback → back
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError("");
    try {
      await api.oauthDisconnect(cfg.id);
      setStatus({ connected: false });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (status === null) return null;

  const card = "rounded-xl border border-zinc-800 bg-zinc-900 p-4";
  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">{cfg.name} · {t("oauth.sectionTitle")}</h2>
          <p className="mt-1 max-w-2xl text-xs text-zinc-500">{t(cfg.hintKey)}</p>
          {status.connected && (
            <p className="mt-2 text-xs text-zinc-400">
              {t("oauth.account")}: {status.email ?? status.accountId ?? "—"}
              {status.projectId && (
                <>
                  {" "}· {t("oauth.project")}:{" "}
                  <code className="rounded bg-zinc-800 px-1">{status.projectId}</code>
                </>
              )}
            </p>
          )}
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </div>
        <div className="flex items-center gap-2">
          {status.connected ? (
            <>
              <span className="rounded-full bg-emerald-900 px-2 py-0.5 text-xs text-emerald-300">
                {t("oauth.connectedBadge")}
              </span>
              <button
                onClick={disconnect}
                disabled={busy}
                className="rounded-lg border border-zinc-700 px-4 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-50"
              >
                {t("oauth.disconnect")}
              </button>
            </>
          ) : (
            <button
              onClick={connect}
              disabled={busy}
              className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? t(cfg.connectingKey) : t(cfg.connectKey)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Browser OAuth panel: one connect card per OAuth provider. */
function OAuthConnectPanel() {
  return (
    <div className="mb-6 grid gap-4">
      {OAUTH_PANEL.map((cfg) => (
        <OAuthConnectCard key={cfg.id} cfg={cfg} />
      ))}
    </div>
  );
}

export default function Providers() {
  const { t } = useLang();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selected, setSelected] = useState<ProviderInfo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.providers().then(setProviders).catch((e) => setError(String(e)));
  }, []);

  if (selected) {
    return <ProviderDetail p={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.providers")}</h1>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <OAuthConnectPanel />
      {providers.length === 0 && !error && (
        <p className="text-zinc-400">
          No providers connected. Set an API key env var (e.g. <code>GROQ_API_KEY</code>) and
          restart the gateway.
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {providers.map((p) => (
          <button
            key={p.id}
            onClick={() => setSelected(p)}
            className="min-w-0 w-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-left transition-colors hover:border-zinc-600"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="min-w-0 truncate font-semibold">{p.name}</h2>
              {p.authType === "none" ? (
                <span className="rounded-full bg-sky-900 px-2 py-0.5 text-xs text-sky-300">{t("providers.keylessBadge")}</span>
              ) : (
                <span className="rounded-full bg-emerald-900 px-2 py-0.5 text-xs text-emerald-300">{t("common.connected")}</span>
              )}
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              {p.id} · {p.wireFormat} · default: {p.defaultModel}
            </p>
            <p className="mt-2 truncate text-sm text-zinc-400">{p.models.join(", ")}</p>
            <p className="mt-2 text-xs text-zinc-500">
              {p.stats.calls} calls · {p.stats.errors} errors ·{" "}
              <span className="text-sky-400">{t("providers.detailsArrow")}</span>
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}
