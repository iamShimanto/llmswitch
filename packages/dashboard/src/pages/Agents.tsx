import { useState } from "react";
import { useLang } from "../i18n";

const TOOLS = [
  {
    id: "cursor",
    name: "Cursor",
    steps: [
      "Open Cursor → Settings → Models → OpenAI API Key",
      "Enable “Override OpenAI Base URL”",
      "Set base URL to http://localhost:6000/v1",
      "Paste your llmswitch API key (create one on the API Keys page)",
      "Pick model: auto (or provider:model, e.g. groq:llama-3.3-70b)",
    ],
    snippet: `{\n  "openaiBaseUrl": "http://localhost:6000/v1",\n  "openaiApiKey": "<your-llmswitch-key>",\n  "model": "auto"\n}`,
  },
  {
    id: "vscode",
    name: "VS Code (Continue / Copilot-style)",
    steps: [
      "Install the Continue extension",
      "Open ~/.continue/config.json",
      "Add an OpenAI-compatible model pointing at the gateway",
      "Paste your llmswitch API key",
    ],
    snippet: `{\n  "models": [\n    {\n      "title": "LLMSwitch",\n      "provider": "openai",\n      "model": "auto",\n      "apiBase": "http://localhost:6000/v1",\n      "apiKey": "<your-llmswitch-key>"\n    }\n  ]\n}`,
  },
  {
    id: "cline",
    name: "Cline",
    steps: [
      "Open Cline settings → API Provider → OpenAI Compatible",
      "Base URL: http://localhost:6000/v1",
      "API key: your llmswitch key",
      "Model ID: auto",
    ],
    snippet: `{\n  "apiProvider": "openai-compatible",\n  "baseUrl": "http://localhost:6000/v1",\n  "apiKey": "<your-llmswitch-key>",\n  "model": "auto"\n}`,
  },
  {
    id: "continue",
    name: "Continue (config.yaml)",
    steps: [
      "Edit ~/.continue/config.yaml",
      "Add the model block below",
      "Reload Continue",
    ],
    snippet: `models:\n  - name: LLMSwitch\n    provider: openai\n    model: auto\n    apiBase: http://localhost:6000/v1\n    apiKey: <your-llmswitch-key>`,
  },
];

export default function Agents() {
  const { t } = useLang();
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold">{t("common.codingAgents")}</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Point any OpenAI-compatible coding tool at the gateway. Tip: run{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">llmswitch setup --tool cursor</code>{" "}
        in your terminal for an interactive wizard.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {TOOLS.map((t) => (
          <div key={t.id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="mb-3 font-semibold">{t.name}</h2>
            <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm text-zinc-300">
              {t.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            <div className="relative">
              <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-300">{t.snippet}</pre>
              <button
                onClick={() => copy(t.id, t.snippet)}
                className="absolute right-2 top-2 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs hover:bg-zinc-800"
              >
                {copied === t.id ? "Copied ✓" : "Copy"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
