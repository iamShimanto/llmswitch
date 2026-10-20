import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api } from "../api";

const LS_KEY = "llmswitch_onboarding_step";
const DONE_KEY = "llmswitch_onboarding_done";

const STEPS = [
  {
    title: "Add a provider key",
    body: "Set an API key env var and restart the gateway — e.g. OPENAI_API_KEY, ANTHROPIC_API_KEY or GROQ_API_KEY. The gateway picks up every *_API_KEY automatically.",
  },
  {
    title: "Verify the provider is connected",
    body: "The dashboard lists connected providers below. If yours is missing, check the key and restart.",
    check: true,
  },
  {
    title: "Point your app at the gateway",
    body: "Base URL http://localhost:6000/v1 with your llmswitch API key (create one on the API Keys page). Works with the OpenAI SDK, Cursor, Cline, Continue and anything OpenAI-compatible.",
  },
  {
    title: "Done — explore",
    body: "Try the Playground for side-by-side fan-out, Routing to see why a provider was picked, and Analytics for cost tracking.",
  },
] as const;

export default function Onboarding() {
  const { t } = useLang();
  const [step, setStep] = useState(() => Number(localStorage.getItem(LS_KEY) ?? 0));
  const [done, setDone] = useState(() => localStorage.getItem(DONE_KEY) === "1");
  const [providers, setProviders] = useState<string[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.providers().then((ps) => setProviders(ps.map((p) => p.id))).catch((e) => setError(String(e)));
  }, []);

  const go = (n: number) => {
    const clamped = Math.max(0, Math.min(STEPS.length - 1, n));
    setStep(clamped);
    localStorage.setItem(LS_KEY, String(clamped));
  };
  const finish = () => {
    setDone(true);
    localStorage.setItem(DONE_KEY, "1");
  };
  const restart = () => {
    setDone(false);
    localStorage.removeItem(DONE_KEY);
    go(0);
  };

  if (done) {
    return (
      <div className="mx-auto max-w-xl text-center">
        <h1 className="mb-4 text-2xl font-bold">{t("common.allSet")}</h1>
        <p className="mb-6 text-sm text-zinc-400">{t("common.gatewayConfigured")}</p>
        <button onClick={restart} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800">{t("common.replayOnboarding")}</button>
      </div>
    );
  }

  const s = STEPS[step];

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="mb-6 text-2xl font-bold">{t("nav.onboarding")}</h1>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      <div className="mb-6 flex gap-2">
        {STEPS.map((_, i) => (
          <button
            key={i}
            onClick={() => go(i)}
            title={STEPS[i].title}
            className={`h-2 flex-1 rounded-full ${i <= step ? "bg-sky-500" : "bg-zinc-800"}`}
          />
        ))}
      </div>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
        <p className="mb-1 text-xs text-zinc-500">Step {step + 1} of {STEPS.length}</p>
        <h2 className="mb-3 text-xl font-semibold">{s.title}</h2>
        <p className="text-sm leading-relaxed text-zinc-300">{s.body}</p>
        {"check" in s && s.check && (
          <div className="mt-4 rounded-lg bg-zinc-950 p-3 text-sm">
            {providers.length > 0 ? (
              <p className="text-emerald-400">✓ {providers.length} provider(s) connected: {providers.slice(0, 5).join(", ")}{providers.length > 5 ? "…" : ""}</p>
            ) : (
              <p className="text-amber-300">{t("common.noProvidersEnv")}</p>
            )}
          </div>
        )}
        {step === 2 && (
          <pre className="mt-4 overflow-x-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-300">
{`from openai import OpenAI
client = OpenAI(
    base_url="http://localhost:6000/v1",
    api_key="<your llmswitch key>",
)
r = client.chat.completions.create(
    model="auto", messages=[{"role": "user", "content": "Hello!"}]
)`}
          </pre>
        )}
      </div>
      <div className="mt-6 flex justify-between">
        <button
          onClick={() => go(step - 1)}
          disabled={step === 0}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40"
        >{t("common.backArrow")}</button>
        {step < STEPS.length - 1 ? (
          <button onClick={() => go(step + 1)} className="rounded-lg bg-sky-600 px-6 py-2 text-sm font-medium hover:bg-sky-500">{t("common.nextArrow")}</button>
        ) : (
          <button onClick={finish} className="rounded-lg bg-emerald-600 px-6 py-2 text-sm font-medium hover:bg-emerald-500">{t("common.finishCheck")}</button>
        )}
      </div>
    </div>
  );
}
