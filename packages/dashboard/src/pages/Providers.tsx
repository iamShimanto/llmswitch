import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, getAdminKey, getSession, type CatalogEntry, type OAuthStatus, type ProviderInfo } from "../api";

function ProviderDetail({
  p,
  connected,
  envKey,
  onBack,
  onChanged,
}: {
  p: ProviderInfo;
  connected: boolean;
  envKey?: string;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyMsg, setKeyMsg] = useState("");

  const [tokenInput, setTokenInput] = useState("");
  const [refreshInput, setRefreshInput] = useState("");
  const [savingToken, setSavingToken] = useState(false);
  const [tokenMsg, setTokenMsg] = useState("");

  const saveToken = async () => {
    setSavingToken(true);
    setTokenMsg("");
    try {
      const r = await api.oauthTokenSave(p.id, tokenInput, refreshInput || undefined);
      if (r.connected) {
        setTokenInput("");
        setRefreshInput("");
        onChanged();
      } else {
        setTokenMsg("Token saved, but the provider did not connect — check the token.");
      }
    } catch (e) {
      setTokenMsg(String(e));
    } finally {
      setSavingToken(false);
    }
  };

  const removeToken = async () => {
    try {
      await api.oauthTokenRemove(p.id);
      onChanged();
    } catch {
      /* ignore */
    }
  };

  const [cookieInput, setCookieInput] = useState("");
  const [museTokenInput, setMuseTokenInput] = useState("");
  const [importing, setImporting] = useState(false);
  const [cookieMsg, setCookieMsg] = useState("");

  const importCookies = async () => {
    setImporting(true);
    setCookieMsg("");
    try {
      const r = await api.importSession(
        p.id,
        cookieInput,
        undefined,
        p.id === "muse-spark-web" ? museTokenInput.trim() || undefined : undefined,
      );
      if (r.connected) {
        setCookieInput("");
        onChanged();
      } else {
        setCookieMsg("Session saved, but the provider did not connect — the cookies may be incomplete.");
      }
    } catch (e) {
      setCookieMsg(String(e));
    } finally {
      setImporting(false);
    }
  };

  const saveKey = async () => {
    setSavingKey(true);
    setKeyMsg("");
    try {
      const r = await api.saveProviderKey(p.id, keyInput);
      if (r.connected) {
        setKeyInput("");
        onChanged();
      } else {
        setKeyMsg("Key saved, but the provider did not connect — check the key.");
      }
    } catch (e) {
      setKeyMsg(String(e));
    } finally {
      setSavingKey(false);
    }
  };
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
    // Use the dedicated provider-test endpoint (real router, pinned
    // provider:model) — the playground fan-out has its own dispatcher that
    // mishandles dedicated-executor providers (Antigravity, web-chat…),
    // which made this button fail while the per-model Test worked.
    setTesting(true);
    setError("");
    setTestResult("");
    try {
      const r = await api.testModel(p.id, p.defaultModel);
      setTestResult(
        r.ok ? `✓ ${(r.text ?? "").slice(0, 200)} (${r.latencyMs} ms)` : `✗ ${r.error ?? "failed"}`,
      );
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
            disabled={discovering || !connected}
            className="rounded-lg border border-zinc-700 px-4 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-50"
          >
            {discovering ? "Discovering…" : "Discover models"}
          </button>
          <button
            onClick={test}
            disabled={testing || !connected}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
          >
            {testing ? "Testing…" : "Test provider"}
          </button>
        </div>
      </div>

      {connected && p.authType === "oauth" && !["antigravity", "claude", "codex"].includes(p.id) && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-sm text-zinc-400">Connected with a pasted token.</p>
          <button
            onClick={removeToken}
            className="rounded-lg border border-zinc-700 px-4 py-1.5 text-sm hover:bg-zinc-800"
          >
            Disconnect
          </button>
        </div>
      )}

      {p.id === "muse-code" && (
        <DeviceConnectCard onChanged={onChanged} />
      )}

      {!connected && (
        <div className={`${card} mb-4 border-dashed`}>
          <h2 className="mb-1 font-semibold">Not connected</h2>
          {p.authType === "api-key" ? (
            <>
              <p className="mb-3 text-sm text-zinc-400">
                Paste your {p.name} API key to connect it — it is stored only in this
                gateway's local database and works immediately (no restart).
              </p>
              <div className="flex flex-wrap gap-2">
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder={envKey ? `${envKey} value` : "API key"}
                  className="min-w-56 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                />
                <button
                  onClick={saveKey}
                  disabled={savingKey || !keyInput.trim()}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
                >
                  {savingKey ? "Connecting…" : "Save & connect"}
                </button>
              </div>
              {keyMsg && <p className="mt-2 text-sm text-red-400">{keyMsg}</p>}
            </>
          ) : p.authType === "oauth" ? (
            ["antigravity", "claude", "codex"].includes(p.id) ? (
              <OAuthConnectCard cfg={OAUTH_PANEL.find((c) => c.id === p.id)!} />
            ) : (
              <>
                <p className="mb-3 text-sm text-zinc-400">
                  Paste an access token from your {p.name} account to connect it. The token is
                  stored only in this gateway's local session store and works immediately.
                </p>
                <div className="grid gap-2">
                  <input
                    type="password"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder="Access token"
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                  />
                  <input
                    type="password"
                    value={refreshInput}
                    onChange={(e) => setRefreshInput(e.target.value)}
                    placeholder="Refresh token (optional)"
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                  />
                  <div>
                    <button
                      onClick={saveToken}
                      disabled={savingToken || !tokenInput.trim()}
                      className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {savingToken ? "Connecting…" : "Connect with token"}
                    </button>
                  </div>
                  {tokenMsg && <p className="text-sm text-red-400">{tokenMsg}</p>}
                </div>
              </>
            )
          ) : p.authType === "cookie" ? (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <button
                  onClick={() => {
                    const tok = getSession() || getAdminKey();
                    window.open(`/proxy/${p.id}/${tok ? `?s=${encodeURIComponent(tok)}` : ""}`, "_blank");
                  }}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500"
                >
                  Open login window
                </button>
                <p className="max-w-md text-xs text-zinc-500">
                  The site opens through this gateway — just log in there and your session
                  connects automatically. Then come back and press Test. (Some sites block
                  proxied logins; then use the paste box below.)
                </p>
              </div>
              <p className="mb-3 text-sm text-zinc-400">
                Or paste cookies manually: open the site in your
                browser while logged in, copy the <b>Cookie</b> request header (DevTools →
                Network → any request → Cookie) or use a cookie-export extension, and paste
                it here. Unofficial sessions can break when the site changes.
              </p>
              <textarea
                value={cookieInput}
                onChange={(e) => setCookieInput(e.target.value)}
                placeholder="session=…; token=…; …"
                rows={3}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs"
              />
              {p.id === "muse-spark-web" && (
                <div className="mt-2">
                  <input
                    value={museTokenInput}
                    onChange={(e) => setMuseTokenInput(e.target.value)}
                    placeholder="ecto1:… access token (Meta AI — the browser extension fills this automatically)"
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs"
                  />
                  <p className="mt-1 text-xs text-zinc-500">
                    Meta AI also needs this short-lived token from the meta.ai page
                    (it expires in ~5 minutes — reconnect to refresh; the extension
                    re-grabs it in one click).
                  </p>
                </div>
              )}
              <div className="mt-2">
                <button
                  onClick={importCookies}
                  disabled={importing || !cookieInput.trim()}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
                >
                  {importing ? "Importing…" : "Import & connect"}
                </button>
              </div>
              {cookieMsg && <p className="mt-2 text-sm text-red-400">{cookieMsg}</p>}
            </>
          ) : (
            <p className="text-sm text-zinc-400">This provider is not available yet.</p>
          )}
        </div>
      )}

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
            disabled={testingAll || !connected}
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
                    disabled={r?.state === "running" || !connected}
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
function DeviceConnectCard({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<{ email?: string; tier?: string; subsActive?: boolean; requirePayment?: boolean } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [phase, setPhase] = useState<"idle" | "waiting" | "failed">("idle");
  const [userCode, setUserCode] = useState("");
  const [verifyUrl, setVerifyUrl] = useState("");
  const [msg, setMsg] = useState("");

  const loadStatus = () => {
    api
      .museStatus()
      .then((r) => {
        if (r.connected) setStatus({ email: r.email, tier: r.tier, subsActive: r.subsActive, requirePayment: r.requirePayment });
        else setStatus(null);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  };
  useEffect(loadStatus, []);

  const start = async () => {
    setMsg("");
    try {
      const r = await api.museDeviceStart();
      // Open the verification page synchronously from the click (mobile
      // browsers block popups opened after async gaps).
      window.open(r.verificationUrl, "_blank");
      setUserCode(r.userCode);
      setVerifyUrl(r.verificationUrl);
      setPhase("waiting");
      const state = r.state;
      const intervalMs = Math.max(3, r.interval || 5) * 1000;
      const deadline = Date.now() + r.expiresIn * 1000;
      const timer = setInterval(async () => {
        if (Date.now() > deadline) {
          clearInterval(timer);
          setPhase("failed");
          setMsg("The code expired — try again.");
          return;
        }
        try {
          const p = await api.museDevicePoll(state);
          if (p.status === "connected") {
            clearInterval(timer);
            setPhase("idle");
            setStatus({ email: p.email, tier: p.tier, subsActive: p.subsActive, requirePayment: p.requirePayment });
            onChanged();
          } else if (p.status === "failed" || p.status === "expired") {
            clearInterval(timer);
            setPhase("failed");
            setMsg(p.error ?? "Login failed — try again.");
          }
        } catch {
          /* keep polling through transient errors */
        }
      }, intervalMs);
    } catch (e) {
      setPhase("failed");
      setMsg(String(e));
    }
  };

  const disconnect = async () => {
    try {
      await api.museDisconnect();
      setStatus(null);
      onChanged();
    } catch {
      /* ignore */
    }
  };

  if (!loaded) return null;
  return (
    <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="mb-1 font-semibold">Connect your Muse account</h2>
      {status ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-zinc-400">
            Connected{status.email ? <> as <b className="text-zinc-200">{status.email}</b></> : ""}
            {status.tier ? <> · {status.tier}</> : ""}
            {status.subsActive === false ? (
              <span className="text-amber-400"> · subscription not active — requests may need payment setup</span>
            ) : null}
          </p>
          <button
            onClick={disconnect}
            className="rounded-lg border border-zinc-700 px-4 py-1.5 text-sm hover:bg-zinc-800"
          >
            Disconnect
          </button>
        </div>
      ) : phase === "waiting" ? (
        <div>
          <p className="mb-2 text-sm text-zinc-400">
            On Meta's page, confirm this code matches, then approve:
          </p>
          <p className="mb-2 font-mono text-2xl font-bold tracking-widest">{userCode}</p>
          <a
            href={verifyUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-sky-400 underline"
          >
            Open Meta verification page
          </a>
          <p className="mt-2 animate-pulse text-sm text-zinc-500">Waiting for approval…</p>
        </div>
      ) : (
        <div>
          <p className="mb-3 text-sm text-zinc-400">
            Log in with the Muse / Muse Code account whose token balance you
            want to spend here — no API key needed. A code will be shown; you
            approve it on Meta's site.
          </p>
          <button
            onClick={start}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500"
          >
            Connect with device code
          </button>
          {msg && <p className="mt-2 text-sm text-red-400">{msg}</p>}
        </div>
      )}
    </div>
  );
}

function OAuthConnectCard({ cfg }: { cfg: OAuthPanelCfg }) {
  const { t } = useLang();
  const [status, setStatus] = useState<OAuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.oauthStatus(cfg.id).then(setStatus).catch(() => setStatus(null));
  }, [cfg.id]);

  const [started, setStarted] = useState(false);
  const [pasteUrl, setPasteUrl] = useState("");
  const [completing, setCompleting] = useState(false);

  const connect = async () => {
    setBusy(true);
    setError("");
    // Open the tab SYNCHRONOUSLY inside the click handler — after an await,
    // mobile browsers treat window.open as a popup and block it, which made
    // Connect look completely dead on phones.
    const tab = window.open("about:blank", "_blank");
    try {
      const { url } = await api.oauthStart(cfg.id);
      if (tab) tab.location.href = url;
      else window.location.href = url; // popup blocked entirely: same-tab fallback
      setStarted(true);
    } catch (e) {
      if (tab) tab.close();
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const completePaste = async () => {
    setCompleting(true);
    setError("");
    try {
      await api.oauthComplete(cfg.id, pasteUrl);
      setPasteUrl("");
      setStarted(false);
      const s = await api.oauthStatus(cfg.id);
      setStatus(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setCompleting(false);
    }
  };

  useEffect(() => {
    if (!started || status?.connected) return;
    const iv = setInterval(async () => {
      try {
        const s = await api.oauthStatus(cfg.id);
        if (s.connected) setStatus(s);
      } catch {
        /* keep polling */
      }
    }, 4000);
    return () => clearInterval(iv);
  }, [started, status?.connected, cfg.id]);

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
      {!status.connected && (
        <div className="mt-3 rounded-lg border border-dashed border-zinc-700 p-3">
          <p className="text-xs text-zinc-400">
            A sign-in tab opened. After you approve, your browser may land on a{" "}
            <code className="rounded bg-zinc-800 px-1">localhost</code> page that fails to
            load — that is expected on a remote gateway. Copy the <b>full address-bar URL</b>{" "}
            from that tab and paste it here:
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              value={pasteUrl}
              onChange={(e) => setPasteUrl(e.target.value)}
              placeholder="http://localhost:6000/api/oauth/…/callback?code=…&state=…"
              className="min-w-56 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs"
            />
            <button
              onClick={completePaste}
              disabled={completing || !pasteUrl.trim()}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
            >
              {completing ? "Connecting…" : "Complete sign-in"}
            </button>
          </div>
        </div>
      )}
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


function DirectoryCard({
  c,
  live,
  onOpen,
}: {
  c: CatalogEntry;
  live: ProviderInfo | undefined;
  onOpen: () => void;
}) {
  const { t } = useLang();
  const [testState, setTestState] = useState<{ running: boolean; msg?: string; ok?: boolean }>({ running: false });
  const runTest = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setTestState({ running: true });
    try {
      const r = await api.testModel(c.id, c.defaultModel);
      setTestState({ running: false, ok: r.ok, msg: r.ok ? `✓ ${r.latencyMs} ms` : `✗ ${r.error ?? "failed"}` });
    } catch (err) {
      setTestState({ running: false, ok: false, msg: `✗ ${String(err)}` });
    }
  };
  const connectable = !c.disabled && !live && c.authType !== "none";
  return (
    <div
      onClick={onOpen}
      className="min-w-0 w-full cursor-pointer overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-left transition-colors hover:border-zinc-600"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="min-w-0 truncate font-semibold">{c.name}</h2>
        {c.disabled ? (
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">Unavailable</span>
        ) : live ? (
          c.authType === "none" ? (
            <span className="rounded-full bg-sky-900 px-2 py-0.5 text-xs text-sky-300">{t("providers.keylessBadge")}</span>
          ) : (
            <span className="rounded-full bg-emerald-900 px-2 py-0.5 text-xs text-emerald-300">{t("common.connected")}</span>
          )
        ) : (
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">Not connected</span>
        )}
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        {c.id} · {c.authType} · {c.models.length} models · default: {c.defaultModel}
      </p>
      <p className="mt-2 truncate text-sm text-zinc-400">{c.models.slice(0, 4).join(", ")}</p>
      <div className="mt-3 flex items-center gap-2">
        {connectable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium hover:bg-emerald-500"
          >
            Connect
          </button>
        )}
        {live && (
          <button
            onClick={runTest}
            disabled={testState.running}
            className="rounded-lg bg-zinc-800 px-4 py-1.5 text-sm font-medium hover:bg-zinc-700 disabled:opacity-50"
          >
            {testState.running ? "Testing…" : "Test"}
          </button>
        )}
        <span className="text-xs text-sky-400">{t("providers.detailsArrow")}</span>
        {live && testState.msg && (
          <span
            className={`max-w-40 truncate text-xs ${testState.ok ? "text-emerald-400" : "text-red-400"}`}
            title={testState.msg}
          >
            {testState.msg}
          </span>
        )}
        {live && (
          <span className="ml-auto text-xs text-zinc-500">
            {live.stats.calls} calls · {live.stats.errors} errors
          </span>
        )}
      </div>
    </div>
  );
}

export default function Providers() {
  const { t } = useLang();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  // Remember the open provider across page refreshes.
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    sessionStorage.getItem("llmswitch_provider_detail"),
  );
  useEffect(() => {
    if (selectedId) sessionStorage.setItem("llmswitch_provider_detail", selectedId);
    else sessionStorage.removeItem("llmswitch_provider_detail");
  }, [selectedId]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");

  const load = () => {
    api.providers().then(setProviders).catch((e) => setError(String(e)));
    api.catalog().then(setCatalog).catch(() => undefined);
  };
  useEffect(load, []);

  const connectedById = new Map(providers.map((p) => [p.id, p]));
  const selectedEntry = selectedId ? catalog.find((c) => c.id === selectedId) : undefined;
  const selectedConnected = selectedId ? connectedById.get(selectedId) : undefined;

  if (selectedId && (selectedEntry || selectedConnected)) {
    const info: ProviderInfo =
      selectedConnected ??
      ({
        id: selectedEntry!.id,
        name: selectedEntry!.name,
        wireFormat: selectedEntry!.wireFormat,
        authType: selectedEntry!.authType,
        models: selectedEntry!.models,
        defaultModel: selectedEntry!.defaultModel,
        stats: { calls: 0, errors: 0, totalLatencyMs: 0 },
      } as ProviderInfo);
    return (
      <ProviderDetail
        key={info.id}
        p={info}
        connected={Boolean(selectedConnected)}
        envKey={selectedEntry?.envKey}
        onBack={() => setSelectedId(null)}
        onChanged={load}
      />
    );
  }

  const q = query.trim().toLowerCase();
  const entries = [...catalog]
    .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name))
    .filter((c) => {
      if (filter === "connected" && !c.connected) return false;
      if (filter === "disconnected" && c.connected) return false;
      if (filter !== "all" && filter !== "connected" && filter !== "disconnected" && c.authType !== filter)
        return false;
      return (
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        c.models.some((m) => m.toLowerCase().includes(q))
      );
    });

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.providers")}</h1>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <OAuthConnectPanel />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search providers or models…"
          className="min-w-56 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
        />
        <p className="text-sm text-zinc-500">
          {providers.length} connected · {catalog.length} total
        </p>
      </div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {(
          [
            ["all", "All"],
            ["connected", "Connected"],
            ["disconnected", "Not connected"],
            ["api-key", "API key"],
            ["oauth", "OAuth"],
            ["none", "Keyless"],
            ["cookie", "Cookie / web"],
          ] as Array<[string, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setFilter(id)}
            className={`rounded-full border px-3 py-1 text-xs ${
              filter === id
                ? "border-zinc-500 bg-zinc-800 font-semibold text-white"
                : "border-zinc-800 text-zinc-400 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {entries.map((c) => (
          <DirectoryCard key={c.id} c={c} live={connectedById.get(c.id)} onOpen={() => setSelectedId(c.id)} />
        ))}
      </div>
      {entries.length === 0 && (
        <p className="text-zinc-400">No providers match your search.</p>
      )}
    </div>
  );
}
