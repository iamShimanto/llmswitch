import { useLang } from "../i18n";
interface Translator {
  id: string;
  dialect: string;
  notes: string;
  exampleIn: string;
  exampleOut: string;
}

// Notes mirror packages/core/src/translator/*.ts doc comments.
const TRANSLATORS: Translator[] = [
  {
    id: "anthropic",
    dialect: "Anthropic Messages API",
    notes: "messages → Anthropic blocks; system extracted; tool_use blocks normalized; x-api-key + anthropic-version headers.",
    exampleIn: `{ "model": "claude-4", "messages": [{"role":"user","content":"hi"}] }`,
    exampleOut: `{ "content": [{"type":"text","text":"Hello!"}] } → choices[0].message`,
  },
  {
    id: "gemini",
    dialect: "Gemini generateContent",
    notes: "messages → contents[{parts}]; system → systemInstruction; safetySettings passthrough; candidates[0].content → choices.",
    exampleIn: `{ "model": "gemini-2.0", "messages": [{"role":"user","content":"hi"}] }`,
    exampleOut: `{ "candidates": [{"content":{"parts":[{"text":"Hello!"}]}}] } → choices`,
  },
  {
    id: "codex",
    dialect: "OpenAI Responses API",
    notes: "Chat completions → Responses `input` array (incl. developer role); `output` array items → choices. Used by Codex-style endpoints.",
    exampleIn: `{ "model": "gpt-5", "messages": [{"role":"user","content":"hi"}] }`,
    exampleOut: `{ "output": [{"type":"message","content":[{"text":"Hello!"}]}] } → choices`,
  },
  {
    id: "cursor",
    dialect: "Cursor agent API",
    notes: "OpenAI-compatible wire; `available_tools` / `tool_choice` passed through; tool_calls normalized in responses.",
    exampleIn: `{ "model": "auto", "available_tools": [...], "messages": [...] }`,
    exampleOut: `tool_calls[] normalized → OpenAI tool_calls shape`,
  },
  {
    id: "kiro",
    dialect: "AWS Kiro",
    notes: "OpenAI-compatible wire with `profileArn` passthrough (Kiro routes to an IAM Identity Center profile).",
    exampleIn: `{ "model": "auto", "profileArn": "arn:aws:…", "messages": [...] }`,
    exampleOut: `standard OpenAI choices`,
  },
  {
    id: "clova",
    dialect: "Naver Clova Studio",
    notes: "→ Clova `messages` (system/user/assistant) + topP/topK params; `result.message.content` → OpenAI shape.",
    exampleIn: `{ "model": "clova-x", "messages": [{"role":"user","content":"hi"}] }`,
    exampleOut: `{ "result": {"message": {"content": "Hello!"}} } → choices`,
  },
  {
    id: "kimi",
    dialect: "Moonshot Kimi",
    notes: "Kimi's route requires upstream SSE: always sends stream:true, then buffers chunks back to JSON when the client asked stream:false.",
    exampleIn: `{ "model": "kimi-k2", "messages": [...], "stream": false }`,
    exampleOut: `SSE chunks buffered → single JSON choices response`,
  },
  {
    id: "glm",
    dialect: "Zhipu GLM (coding)",
    notes: "OpenAI-compatible wire; injects GLM request defaults (temperature etc.) unless the caller set them explicitly.",
    exampleIn: `{ "model": "glm-4", "messages": [...] }`,
    exampleOut: `defaults merged → standard OpenAI choices`,
  },
];

export default function Translators() {
  const { t } = useLang();
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.translators")}<span className="text-base font-normal text-zinc-500">{t("translators.dialectCount", { n: TRANSLATORS.length })}</span>
      </h1>
      <p className="mb-4 text-sm text-zinc-500">{t("translators.dialect_adapters_between_the_openai_comp")}</p>
      <div className="grid gap-4 md:grid-cols-2">
        {TRANSLATORS.map((tr) => (
          <div key={tr.id} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="mb-2 flex items-center gap-2">
              <code className="rounded bg-sky-900 px-2 py-0.5 text-sm font-semibold text-sky-300">{tr.id}</code>
              <span className="text-sm text-zinc-400">{tr.dialect}</span>
            </div>
            <p className="mb-3 text-sm text-zinc-300">{tr.notes}</p>
            <div className="grid gap-2 text-xs">
              <div>
                <p className="mb-1 text-zinc-500">{t("translators.exampleIn")}</p>
                <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-2 text-zinc-300">{tr.exampleIn}</pre>
              </div>
              <div>
                <p className="mb-1 text-zinc-500">{t("translators.exampleOut")}</p>
                <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-2 text-zinc-300">{tr.exampleOut}</pre>
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-zinc-500">
        {t("translators.liveNote")} Translator unit tests: 8 files under packages/core/src/translator/.
      </p>
    </div>
  );
}
