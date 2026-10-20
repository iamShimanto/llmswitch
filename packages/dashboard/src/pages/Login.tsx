import { useEffect, useState } from "react";
import { authApi, setSession } from "../api";
import { useLang } from "../i18n";

/** Full-screen dashboard login (password gate). */
export default function Login({ onLogin }: { onLogin: () => void }) {
  const { t } = useLang();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [isDefault, setIsDefault] = useState(false);

  useEffect(() => {
    authApi
      .status()
      .then((s) => setIsDefault(s.isDefault))
      .catch(() => undefined);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await authApi.login(password);
      setSession(r.token);
      onLogin();
    } catch {
      setError(t("login.wrong"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-xl"
      >
        <div className="mb-1 text-center text-4xl">⚡</div>
        <h1 className="mb-1 text-center text-xl font-bold">LLMSwitch</h1>
        <p className="mb-5 text-center text-sm text-zinc-400">{t("login.subtitle")}</p>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          {t("login.password")}
        </label>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("login.placeholder")}
          className="mb-3 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
        />
        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-lg bg-zinc-100 py-2 text-sm font-semibold text-zinc-900 disabled:opacity-50"
        >
          {busy ? t("login.signingIn") : t("login.signIn")}
        </button>
        {isDefault && (
          <div className="mt-4 rounded-lg border border-dashed border-zinc-700 px-3 py-2 text-center text-xs text-zinc-400">
            {t("login.defaultHint")} <code className="font-mono font-semibold text-zinc-200">llmswitch</code>
            <br />
            {t("login.defaultHint2")}
          </div>
        )}
      </form>
    </div>
  );
}
