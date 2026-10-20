import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api, getAdminKey, getSession, type CatalogEntry, type OAuthStatus, type ProviderAccount, type ProviderInfo } from "../api";


const BROWSER_OAUTH_IDS = ["antigravity", "claude", "codex"];

/**
 * Multi-account manager for one provider: named accounts rotate with the
 * provider's default connection (the fallback). Add forms mirror the
 * provider's auth type; browser-OAuth providers add accounts through
 * their connect card's account-name field instead.
 */
function AccountsSection({ p, onChanged }: { p: ProviderInfo; onChanged: () => void }) {
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [extra, setExtra] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [acctQuery, setAcctQuery] = useState("");
  const [acctFilter, setAcctFilter] = useState<"all" | "active" | "error">("all");

  const load = () => {
    api.accounts(p.id).then((r) => setAccounts(r.accounts)).catch(() => {});
  };
  useEffect(load, [p.id]);

  const auth = p.authType ?? "api-key";
  const canAddHere =
    auth === "api-key" || auth === "cookie" || (auth === "oauth" && !BROWSER_OAUTH_IDS.includes(p.id) && p.id !== "muse-code");

  const add = async () => {
    setMsg("");
    if (!label.trim()) {
      setMsg("Give the account a name first.");
      return;
    }
    if (!secret.trim()) {
      setMsg("The credential field is empty.");
      return;
    }
    setBusy(true);
    try {
      if (auth === "api-key") {
        await api.saveProviderKey(p.id, secret.trim(), label.trim());
      } else if (auth === "cookie") {
        await api.importSession(p.id, secret.trim(), undefined, p.id === "muse-spark-web" ? extra.trim() || undefined : undefined, label.trim());
      } else {
        await api.oauthTokenSave(p.id, secret.trim(), extra.trim() || undefined, label.trim());
      }
      setLabel("");
      setSecret("");
      setExtra("");
      load();
      onChanged();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (a: ProviderAccount) => {
    await api.updateAccount(a.id, { enabled: !a.enabled }).catch(() => {});
    load();
    onChanged();
  };
  const remove = async (a: ProviderAccount) => {
    await api.deleteAccount(a.id).catch(() => {});
    load();
    onChanged();
  };

  const card = "rounded-xl border border-zinc-800 bg-zinc-900 p-4";
  const input = "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm";
  return (
    <div className={`${card} mb-4`}>
      <h2 className="font-semibold">Accounts</h2>
      <p className="mt-1 text-xs text-zinc-500">
        Requests rotate across the enabled accounts below plus the default connection above
        (the fallback). Selection strategy lives on the Routing page.
      </p>
      {accounts.length > 0 && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={acctQuery}
              onChange={(e) => setAcctQuery(e.target.value)}
              placeholder="🔍 Search accounts…"
              className="min-w-40 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm"
            />
            {(
              [
                ["all", "All"],
                ["active", "Active"],
                ["error", "Error"],
              ] as Array<["all" | "active" | "error", string]>
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setAcctFilter(id)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  acctFilter === id
                    ? "border-zinc-500 bg-zinc-800 font-semibold text-white"
                    : "border-zinc-800 text-zinc-400 hover:text-white"
                }`}
              >
                {label}
              </button>
            ))}
            <span className="text-xs text-zinc-500">{accounts.length} accounts</span>
          </div>
          <div className="mt-3 space-y-2">
          {accounts
            .filter((a) => {
              const q = acctQuery.trim().toLowerCase();
              if (q && !a.label.toLowerCase().includes(q)) return false;
              if (acctFilter === "active" && !a.enabled) return false;
              if (acctFilter === "error" && !(a.errors > 0 || a.lastError)) return false;
              return true;
            })
            .map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2">
              <span className="text-sm font-medium">{a.label}</span>
              <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">
                {a.kind === "api_key" ? "API key" : "Session"}
              </span>
              <span className="text-xs text-zinc-500">
                {a.calls} calls · {a.errors} errors
                {a.lastUsedAt ? ` · last ${new Date(a.lastUsedAt).toLocaleString()}` : ""}
              </span>
              {a.lastError && <span className="w-full text-xs text-red-400/80">{a.lastError}</span>}
              <span className="flex w-full flex-wrap items-center gap-2 text-xs text-zinc-500">
                {a.dailyCapUsd != null ? (
                  <>
                    <span>
                      Daily cap: <span className="text-zinc-300">${a.dailyCapUsd}</span> · spent today{" "}
                      <span className={(a.spentTodayUsd ?? 0) >= a.dailyCapUsd ? "text-red-400" : "text-zinc-300"}>
                        ${(a.spentTodayUsd ?? 0).toFixed(4)}
                      </span>
                      {(a.spentTodayUsd ?? 0) >= a.dailyCapUsd && (
                        <span className="ml-1 rounded bg-red-900/60 px-1.5 py-px text-[10px] text-red-300">CAPPED TODAY</span>
                      )}
                    </span>
                    <button
                      onClick={async () => {
                        await api.updateAccount(a.id, { dailyCapUsd: null });
                        load();
                      }}
                      className="rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800"
                    >
                      Remove cap
                    </button>
                  </>
                ) : (
                  <button
                    onClick={async () => {
                      const v = prompt("Daily spend cap for this account (USD, e.g. 1.50). Cancel = no change.");
                      if (v == null) return;
                      const n = Number(v);
                      if (!Number.isFinite(n) || n <= 0) return;
                      await api.updateAccount(a.id, { dailyCapUsd: n });
                      load();
                    }}
                    className="rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800"
                  >
                    ＋ Daily cap
                  </button>
                )}
              </span>
              <span className="ml-auto flex gap-2">
                <button
                  onClick={() => toggle(a)}
                  className={`rounded-lg px-3 py-1 text-xs ${a.enabled ? "bg-emerald-900 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}
                >
                  {a.enabled ? "Enabled" : "Disabled"}
                </button>
                <button
                  onClick={() => remove(a)}
                  className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-red-300 hover:bg-zinc-800"
                >
                  Remove
                </button>
              </span>
            </div>
          ))}
          </div>
        </>
      )}
      {canAddHere ? (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Account name (e.g. Work, Personal)" className={input} />
          {auth === "api-key" && (
            <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="API key" type="password" className={input} />
          )}
          {auth === "cookie" && (
            <>
              <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Cookies (name=value; …)" className={input} />
              {p.id === "muse-spark-web" && (
                <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Access token (ecto1:…) — optional" className={input} />
              )}
            </>
          )}
          {auth === "oauth" && (
            <>
              <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Access token" type="password" className={input} />
              <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Refresh token (optional)" type="password" className={input} />
            </>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={add}
              disabled={busy}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? "Adding…" : "Add account"}
            </button>
            {msg && <span className="text-xs text-red-400">{msg}</span>}
          </div>
        </div>
      ) : (
        auth !== "none" && (
          <p className="mt-3 text-xs text-zinc-500">
            Add another account from the connect card above — type a name in its
            "Account name" field before signing in and it will be saved as a separate account.
          </p>
        )
      )}
    </div>
  );
}

function ProviderDetail({
  p,
  connected,
  envKey,
  entry,
  onBack,
  onChanged,
}: {
  p: ProviderInfo;
  connected: boolean;
  envKey?: string;
  entry?: CatalogEntry;
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
  const [defaultModel, setDefaultModelState] = useState(p.defaultModel);
  useEffect(() => {
    setDefaultModelState(p.defaultModel);
  }, [p.defaultModel]);
  const setDefault = async (m: string) => {
    try {
      const r = await api.setDefaultModel(p.id, m);
      setDefaultModelState(r.defaultModel);
      onChanged();
    } catch {
      /* ignore */
    }
  };
  const [discovering, setDiscovering] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string>("");
  const [error, setError] = useState("");
  const [modelTests, setModelTests] = useState<
    Record<string, { state: "running" | "ok" | "fail"; latencyMs?: number; error?: string }>
  >({});
  const [testingAll, setTestingAll] = useState(false);
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(
    () => new Set(entry?.hiddenModels ?? []),
  );
  const [modelQuery, setModelQuery] = useState("");
  const [visFilter, setVisFilter] = useState<"all" | "visible" | "hidden">("all");
  const [customId, setCustomId] = useState("");
  const [customName, setCustomName] = useState("");
  const [paramBlock, setParamBlock] = useState(entry?.blockedParams ?? "");
  const [connCount, setConnCount] = useState(connected ? 1 : 0);
  useEffect(() => {
    setModels(entry?.models ?? p.models);
    setHiddenModels(new Set(entry?.hiddenModels ?? []));
    setParamBlock(entry?.blockedParams ?? "");
  }, [entry]);
  useEffect(() => {
    api
      .accounts(p.id)
      .then((r) => setConnCount((connected ? 1 : 0) + r.accounts.filter((a) => a.enabled).length))
      .catch(() => {});
  }, [p.id, connected]);

  const toggleVisibility = async (m: string) => {
    const hidden = !hiddenModels.has(m);
    try {
      const r = await api.setModelVisibility(p.id, m, hidden);
      setHiddenModels(new Set(r.hiddenModels));
      onChanged();
    } catch {
      /* ignore */
    }
  };
  const customNames = new Map((entry?.customModels ?? []).map((c) => [c.id, c.name]));
  const isCustom = (m: string) => customNames.has(m);
  const displayName = (m: string) =>
    customNames.get(m) ??
    m
      .split("/")
      .pop()!
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
  const addCustom = async () => {
    if (!customId.trim()) return;
    await api.saveCustomModel(p.id, customId.trim(), customName.trim() || undefined).catch(() => {});
    setCustomId("");
    setCustomName("");
    onChanged();
  };
  const removeCustom = async (m: string) => {
    await api.saveCustomModel(p.id, m, undefined, true).catch(() => {});
    onChanged();
  };
  const saveParamBlock = async () => {
    await api.setParamBlock(p.id, paramBlock).catch(() => {});
    onChanged();
  };

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
      if (hiddenModels.has(m)) continue;
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
            {connected ? ` · ${connCount} connection${connCount === 1 ? "" : "s"}` : ""}
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

      {["antigravity", "claude", "codex"].includes(p.id) && (
        <div className="mb-4">
          <OAuthConnectCard cfg={OAUTH_PANEL.find((c) => c.id === p.id)!} />
        </div>
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
              <p className="text-sm text-zinc-400">Use the sign-in card above to connect.</p>
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
              <div className="mb-4 rounded-xl border border-violet-900/60 bg-violet-950/20 p-4">
                <h3 className="mb-1 font-semibold">🍪 How to get the session credential</h3>
                <p className="mb-2 text-sm text-zinc-400">
                  {p.name} uses a browser web session instead of an API key.
                </p>
                <ol className="list-decimal space-y-1.5 pl-5 text-sm text-zinc-400">
                  <li>Sign in to {p.name} in your browser.</li>
                  <li>
                    Fast path: install a cookie-export extension (e.g. Cookie Editor), open it
                    on the {p.name} tab, and export with the format set to "Cookie header".
                  </li>
                  <li>
                    Manual path: open DevTools (F12 → Network), refresh, open any authenticated
                    request, and copy the <b>Cookie</b> header value from Request Headers —
                    without the "Cookie:" prefix.
                  </li>
                  <li>Paste it below and check the connection. If it stops working, sign in again and replace it with a fresh value.</li>
                </ol>
                <p className="mt-2 text-xs font-medium text-amber-300">
                  Treat this like a password: it can access your signed-in web account until it
                  expires or is revoked.
                </p>
              </div>
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

      <div className={`${card} mb-4`}>
        <h2 className="font-semibold">Multi-account routing</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Override the global account strategy for this provider only.
        </p>
        <label className="mb-1 mt-3 block text-xs font-medium text-zinc-400">Account strategy</label>
        <select
          value={entry?.accountStrategy ?? ""}
          onChange={async (e) => {
            await api.setProviderAccountStrategy(p.id, e.target.value).catch(() => {});
            onChanged();
          }}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
        >
          <option value="">Global default (Routing page)</option>
          <option value="round-robin">round-robin</option>
          <option value="least-used">least-used</option>
          <option value="priority">priority</option>
          <option value="random">random</option>
        </select>
      </div>

      <AccountsSection p={p} onChanged={onChanged} />

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

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          Available Models{" "}
          <span className="text-sm font-normal text-zinc-500">
            {models.length - hiddenModels.size}/{models.length} active
          </span>
        </h2>
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
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={modelQuery}
          onChange={(e) => setModelQuery(e.target.value)}
          placeholder="🔍 Filter models…"
          className="min-w-44 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm"
        />
        {(
          [
            ["all", "All"],
            ["visible", "Visible only"],
            ["hidden", "Hidden only"],
          ] as Array<["all" | "visible" | "hidden", string]>
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setVisFilter(id)}
            className={`rounded-full border px-3 py-1 text-xs ${
              visFilter === id
                ? "border-zinc-500 bg-zinc-800 font-semibold text-white"
                : "border-zinc-800 text-zinc-400 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
        <button
          onClick={async () => {
            for (const m of models) {
              if (!hiddenModels.has(m)) await api.setModelVisibility(p.id, m, true).catch(() => {});
            }
            onChanged();
          }}
          className="rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-400 hover:text-white"
        >
          Hide all
        </button>
        <button
          onClick={async () => {
            for (const m of [...hiddenModels]) {
              await api.setModelVisibility(p.id, m, false).catch(() => {});
            }
            onChanged();
          }}
          className="rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-400 hover:text-white"
        >
          Show all
        </button>
      </div>
      <div className={card}>
        {models.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No models listed — this provider passes model ids through. Use{" "}
            <code className="rounded bg-zinc-800 px-1 text-xs">{p.id}:&lt;model&gt;</code>{t("providers.discoverAbove")}</p>
        ) : (
          <div className="divide-y divide-zinc-800">
            {models
              .filter((m) => {
                const q = modelQuery.trim().toLowerCase();
                if (q && !m.toLowerCase().includes(q)) return false;
                if (visFilter === "visible" && hiddenModels.has(m)) return false;
                if (visFilter === "hidden" && !hiddenModels.has(m)) return false;
                return true;
              })
              .map((m) => {
              const r = modelTests[m];
              const hidden = hiddenModels.has(m);
              return (
                <div key={m} className={`flex items-center gap-3 py-2 ${hidden ? "opacity-50" : ""}`}>
                  <span className="min-w-0 flex-1" title={m}>
                    <span className="block truncate font-mono text-xs text-zinc-200">
                      {p.id}/{m}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-500">
                      <span className="truncate italic">{displayName(m)}</span>
                      {isCustom(m) ? (
                        <span className="shrink-0 rounded bg-amber-900/60 px-1.5 py-px text-[10px] font-semibold text-amber-300">CUSTOM</span>
                      ) : (
                        <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-px text-[10px] font-semibold text-zinc-400">BUILT-IN</span>
                      )}
                    </span>
                  </span>
                  <button
                    onClick={() => void navigator.clipboard?.writeText(`${p.id}:${m}`).catch(() => {})}
                    title="Copy model id"
                    className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] hover:bg-zinc-800"
                  >
                    ⧉
                  </button>
                  <button
                    onClick={() => toggleVisibility(m)}
                    title={hidden ? "Show model (include in routing)" : "Hide model (remove from routing)"}
                    className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] hover:bg-zinc-800"
                  >
                    {hidden ? "🙈" : "👁"}
                  </button>
                  {m === defaultModel && (
                    <span className="shrink-0 rounded-full bg-amber-900/60 px-2 py-0.5 text-[11px] font-medium text-amber-300">Default</span>
                  )}
                  {r?.state === "ok" && (
                    <span className="shrink-0 text-xs text-emerald-400">✓ works · {r.latencyMs} ms</span>
                  )}
                  {r?.state === "fail" && (
                    <span className="max-w-56 shrink-0 truncate text-xs text-red-400" title={r.error}>
                      ✗ {r.error}
                    </span>
                  )}
                  {m !== defaultModel && (
                    <button
                      onClick={() => setDefault(m)}
                      className="shrink-0 rounded-lg border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800"
                      title="Use this model when a request names the provider without a model"
                    >
                      Set default
                    </button>
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
      <div className={`${card} mt-4`}>
        <h2 className="font-semibold">Custom Models</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Add model IDs that are not in the default list. They become available for routing.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            value={customId}
            onChange={(e) => setCustomId(e.target.value)}
            placeholder="Model ID — e.g. gpt-4.1-mini"
            className="min-w-44 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          />
          <input
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            placeholder="Display name (optional)"
            className="min-w-36 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          />
          <button
            onClick={addCustom}
            disabled={!customId.trim()}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
          >
            + Add
          </button>
        </div>
        {(entry?.customModels ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No custom models added yet.</p>
        ) : (
          <div className="mt-3 grid gap-1.5">
            {(entry?.customModels ?? []).map((c) => (
              <p key={c.id} className="flex items-center justify-between rounded-lg border border-zinc-800 px-3 py-1.5 font-mono text-xs">
                <span>
                  {c.id}
                  {c.name ? <span className="ml-2 font-sans italic text-zinc-500">{c.name}</span> : null}
                </span>
                <button onClick={() => removeCustom(c.id)} className="text-red-400 hover:text-red-300">
                  ✕
                </button>
              </p>
            ))}
          </div>
        )}
      </div>

      <div className={`${card} mt-4`}>
        <h2 className="font-semibold">Param Filters</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Strip or block request parameters before sending to this provider — used to avoid
          400 errors from providers that reject certain params (e.g. NVIDIA NIM rejects{" "}
          <code className="rounded bg-zinc-800 px-1">thinking</code>).
        </p>
        <label className="mb-1 mt-3 block text-xs font-medium text-zinc-400">Blocked parameters</label>
        <div className="flex flex-wrap gap-2">
          <input
            value={paramBlock}
            onChange={(e) => setParamBlock(e.target.value)}
            placeholder="thinking, reasoning_budget, … (comma-separated)"
            className="min-w-56 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          />
          <button
            onClick={saveParamBlock}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800"
          >
            Save
          </button>
        </div>
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
  const [acctName, setAcctName] = useState("");
  const [adding, setAdding] = useState(false);
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
      const r = await api.museDeviceStart(acctName.trim() || undefined);
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
            setAdding(false);
            setAcctName("");
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
      {status && !adding ? (
        <div>
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
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              value={acctName}
              onChange={(e) => setAcctName(e.target.value)}
              placeholder="New account name (e.g. Second account)"
              className="min-w-52 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs"
            />
            <button
              onClick={() => setAdding(true)}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500"
            >
              Add another account
            </button>
          </div>
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
          <div className="flex flex-wrap gap-2">
            <input
              value={acctName}
              onChange={(e) => setAcctName(e.target.value)}
              placeholder="Account name (optional — separate account)"
              className="min-w-52 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs"
            />
            <button
              onClick={start}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500"
            >
              Connect with device code
            </button>
          </div>
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
  const [acctName, setAcctName] = useState("");
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
      await api.oauthComplete(cfg.id, pasteUrl, acctName.trim() || undefined);
      setPasteUrl("");
      setAcctName("");
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
                onClick={connect}
                disabled={busy}
                className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
              >
                Add account
              </button>
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
      {(!status.connected || started) && (
        <div className="mt-3 rounded-lg border border-dashed border-zinc-700 p-3">
          <p className="text-xs text-zinc-400">
            A sign-in tab opened. After you approve, your browser may land on a{" "}
            <code className="rounded bg-zinc-800 px-1">localhost</code> page that fails to
            load — that is expected on a remote gateway. Copy the <b>full address-bar URL</b>{" "}
            from that tab and paste it here:
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              value={acctName}
              onChange={(e) => setAcctName(e.target.value)}
              placeholder="Account name (optional — saves as a separate account)"
              className="min-w-56 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs"
            />
          </div>
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


const CATEGORIES: Array<{ id: string; title: string; desc: string; dot: string }> = [
  { id: "api-key", title: "API Key Providers", desc: "Classic API-key providers — paste a key to connect.", dot: "bg-amber-400" },
  { id: "oauth", title: "OAuth Providers", desc: "Providers authenticated via OAuth — sign in once and tokens rotate automatically.", dot: "bg-blue-400" },
  { id: "cookie", title: "Web Cookie Providers", desc: "These providers use browser web sessions, cookies, or web tokens instead of API keys.", dot: "bg-violet-400" },
  { id: "none", title: "Free / Keyless Providers", desc: "No key needed — public endpoints and anonymous free tiers.", dot: "bg-emerald-400" },
];
const categoryOf = (c: CatalogEntry): string =>
  c.authType === "token-import" ? "oauth" : c.authType === "env-creds" ? "api-key" : c.authType;

const MEDIA_KINDS: Array<{ id: string; label: string; re: RegExp }> = [
  { id: "image", label: "🖼 Image", re: /dall-e|flux|imagen|stable|sdxl|image|midjourney/i },
  { id: "video", label: "🎬 Video", re: /veo|sora|video|kling|runway|luma/i },
  { id: "music", label: "🎵 Music", re: /music|suno|udio/i },
  { id: "tts", label: "🗣 Text → Speech", re: /tts|text-to-speech|speech(?!-to-text)/i },
  { id: "stt", label: "🎙 Speech → Text", re: /whisper|speech-to-text|transcri/i },
  { id: "embedding", label: "🧬 Embedding", re: /embed/i },
];

function DirectoryCard({
  c,
  live,
  accountCount,
  compact,
  matchedModel,
  onOpen,
  onChanged,
}: {
  c: CatalogEntry;
  live: ProviderInfo | undefined;
  accountCount: number;
  compact: boolean;
  matchedModel?: string;
  onOpen: () => void;
  onChanged: () => void;
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
  const toggleEnabled = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await api.setProviderEnabled(c.id, !c.enabled).catch(() => {});
    onChanged();
  };
  const off = !c.disabled && c.enabled === false;
  const connections = live ? 1 + accountCount : 0;
  const statusBadge = c.disabled ? (
    <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">Unavailable</span>
  ) : off ? (
    <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">⏸ Disabled</span>
  ) : live ? (
    c.authType === "none" ? (
      <span className="rounded-full bg-sky-900 px-2 py-0.5 text-xs text-sky-300">{t("providers.keylessBadge")}</span>
    ) : (
      <span className="rounded-full bg-emerald-900 px-2 py-0.5 text-xs text-emerald-300">
        ● {connections} Connected
      </span>
    )
  ) : (
    <span className="text-xs text-zinc-500">No connections</span>
  );
  const toggle = !c.disabled && (
    <button
      onClick={toggleEnabled}
      title={c.enabled ? "Disable provider (leaves rotation, stays connected)" : "Enable provider"}
      className={`relative h-5 w-9 shrink-0 rounded-full transition ${c.enabled ? "bg-emerald-600" : "bg-zinc-700"}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${c.enabled ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );

  if (compact) {
    return (
      <div
        onClick={onOpen}
        className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 transition-colors hover:border-zinc-600 ${off ? "opacity-60" : ""}`}
      >
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</h2>
        {statusBadge}
        {toggle}
        {live && (
          <button
            onClick={runTest}
            disabled={testState.running}
            className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs font-medium hover:bg-zinc-700 disabled:opacity-50"
          >
            {testState.running ? "…" : "▶ Test"}
          </button>
        )}
      </div>
    );
  }

  const connectable = !c.disabled && !live && c.authType !== "none";
  return (
    <div
      onClick={onOpen}
      className={`min-w-0 w-full cursor-pointer overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-left transition-colors hover:border-zinc-600 ${off ? "opacity-60" : ""}`}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="min-w-0 truncate font-semibold">{c.name}</h2>
        {statusBadge}
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        {c.id} · {c.authType} · {c.models.length} models · default: {c.defaultModel}
      </p>
      {matchedModel ? (
        <p className="mt-2 truncate text-sm text-amber-300/90">🎯 {matchedModel}</p>
      ) : (
        <p className="mt-2 truncate text-sm text-zinc-400">{c.models.slice(0, 4).join(", ")}</p>
      )}
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
            {testState.running ? "Testing…" : "▶ Test"}
          </button>
        )}
        {toggle}
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
  const [modelQuery, setModelQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [configuredOnly, setConfiguredOnly] = useState(false);
  const [compact, setCompact] = useState(false);
  const [media, setMedia] = useState<string | null>(null);
  const [allAccounts, setAllAccounts] = useState<ProviderAccount[]>([]);
  const [sectionTests, setSectionTests] = useState<Record<string, { running: boolean; msg?: string }>>({});
  const [error, setError] = useState("");

  const load = () => {
    api.providers().then(setProviders).catch((e) => setError(String(e)));
    api.catalog().then(setCatalog).catch(() => undefined);
    api.accounts().then((r) => setAllAccounts(r.accounts)).catch(() => undefined);
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
        entry={selectedEntry}
        onBack={() => setSelectedId(null)}
        onChanged={load}
      />
    );
  }

  const accountCountByProvider = new Map<string, number>();
  for (const a of allAccounts) {
    if (a.enabled) accountCountByProvider.set(a.providerId, (accountCountByProvider.get(a.providerId) ?? 0) + 1);
  }

  const q = query.trim().toLowerCase();
  const mq = modelQuery.trim().toLowerCase();
  const mediaKind = MEDIA_KINDS.find((k) => k.id === media);
  const matches = (c: CatalogEntry): boolean => {
    if (configuredOnly && !c.connected) return false;
    if (mq && !c.models.some((m) => m.toLowerCase().includes(mq))) return false;
    if (mediaKind && !c.models.some((m) => mediaKind.re.test(m))) return false;
    return (
      !q ||
      c.name.toLowerCase().includes(q) ||
      c.id.toLowerCase().includes(q) ||
      c.models.some((m) => m.toLowerCase().includes(q))
    );
  };
  const sorted = [...catalog].sort(
    (a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name),
  );
  const visibleCount = sorted.filter(matches).length;

  const testSection = async (catId: string, entriesInSection: CatalogEntry[]) => {
    const targets = entriesInSection.filter((c) => c.connected);
    if (targets.length === 0) return;
    setSectionTests((s) => ({ ...s, [catId]: { running: true } }));
    let ok = 0;
    for (const c of targets) {
      const r = await api.testModel(c.id, c.defaultModel).catch(() => null);
      if (r?.ok) ok++;
    }
    setSectionTests((s) => ({
      ...s,
      [catId]: { running: false, msg: `✓ ${ok}/${targets.length} passed` },
    }));
  };

  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs ${
      active
        ? "border-amber-600/60 bg-amber-950/40 font-semibold text-amber-200"
        : "border-zinc-800 text-zinc-400 hover:text-white"
    }`;

  return (
    <div>
      <p className="mb-1 text-xs text-zinc-500">Dashboard › <span className="text-zinc-300">Providers</span></p>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.providers")}</h1>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="🔍 Search Providers"
          className="min-w-48 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
        />
        <input
          value={modelQuery}
          onChange={(e) => setModelQuery(e.target.value)}
          placeholder="🧠 Search by model…"
          className="min-w-48 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
        />
      </div>
      {/* Category stat chips */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        <button onClick={() => setCategory("all")} className={chip(category === "all")}>
          Total {providers.length}/{catalog.length}
        </button>
        {CATEGORIES.map((cat) => {
          const all = catalog.filter((c) => categoryOf(c) === cat.id);
          const conn = all.filter((c) => c.connected).length;
          return (
            <button
              key={cat.id}
              onClick={() => setCategory(category === cat.id ? "all" : cat.id)}
              className={chip(category === cat.id)}
            >
              <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${cat.dot}`} />
              {cat.title.replace(" Providers", "")} {conn}/{all.length}
            </button>
          );
        })}
        <button onClick={() => setConfiguredOnly((v) => !v)} className={chip(configuredOnly)}>
          ✓ Configured
        </button>
        <button onClick={() => setCompact((v) => !v)} className={chip(compact)}>
          ▦ Compact
        </button>
      </div>
      {/* Media kinds (derived from model ids) */}
      <div className="mb-5 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Media</span>
        {MEDIA_KINDS.map((k) => (
          <button
            key={k.id}
            onClick={() => setMedia(media === k.id ? null : k.id)}
            className={chip(media === k.id)}
          >
            {k.label}
          </button>
        ))}
        <span className="ml-auto text-sm text-zinc-500">
          {visibleCount} shown · {providers.length} connected · {catalog.length} total
        </span>
      </div>

      {CATEGORIES.filter((cat) => category === "all" || category === cat.id).map((cat) => {
        const inSection = sorted.filter((c) => categoryOf(c) === cat.id && matches(c));
        if (inSection.length === 0) return null;
        const conn = inSection.filter((c) => c.connected).length;
        const st = sectionTests[cat.id];
        return (
          <section key={cat.id} className="mb-8">
            <div className="mb-1 flex flex-wrap items-center gap-3">
              <h2 className="flex items-center gap-2 text-lg font-bold">
                {cat.title}
                <span className={`h-2 w-2 rounded-full ${cat.dot}`} />
                <span className="text-sm font-medium text-amber-400">
                  {conn}/{inSection.length}
                </span>
              </h2>
              <button
                onClick={() => testSection(cat.id, inSection)}
                disabled={st?.running || conn === 0}
                className="ml-auto rounded-lg border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800 disabled:opacity-50"
              >
                {st?.running ? "Testing…" : "▶ Test All"}
              </button>
              {st?.msg && <span className="text-xs text-emerald-400">{st.msg}</span>}
            </div>
            <p className="mb-3 text-xs text-zinc-500">{cat.desc}</p>
            <div className={compact ? "grid gap-2" : "grid gap-4 md:grid-cols-2 lg:grid-cols-3"}>
              {inSection.map((c) => (
                <DirectoryCard
                  key={c.id}
                  c={c}
                  live={connectedById.get(c.id)}
                  accountCount={accountCountByProvider.get(c.id) ?? 0}
                  compact={compact}
                  matchedModel={mq ? c.models.find((m) => m.toLowerCase().includes(mq)) : undefined}
                  onOpen={() => setSelectedId(c.id)}
                  onChanged={load}
                />
              ))}
            </div>
          </section>
        );
      })}
      {visibleCount === 0 && <p className="text-zinc-400">No providers match your search.</p>}
    </div>
  );
}
