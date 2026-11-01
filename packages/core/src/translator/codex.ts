import type { ChatCompletionRequest, ChatCompletionResponse } from "../providers/types.js";

/**
 * OpenAI Codex / Responses API translator.
 * Chat completions → Responses API `input` array; `output` array → choices.
 */

type ResponsesContentPart =
  | { type: "input_text" | "output_text"; text: string }
  | { type: "input_image"; image_url: string };

interface ResponsesInputItem {
  role: "system" | "user" | "assistant" | "developer";
  content: string | ResponsesContentPart[];
}

export function toCodexRequest(body: ChatCompletionRequest): Record<string, unknown> {
  const input: ResponsesInputItem[] = [];
  for (const m of body.messages) {
    if (m.role === "tool") continue;
    const role = m.role === "system" ? "developer" : (m.role as "user" | "assistant");
    if (Array.isArray(m.content)) {
      // Multimodal: text parts keep their role flavour (input_text /
      // output_text), image parts ride as input_image URLs (data URLs
      // included — the Responses API accepts them inline).
      const textType = m.role === "assistant" ? "output_text" : "input_text";
      const parts: ResponsesContentPart[] = [];
      for (const p of m.content) {
        if (p?.type === "text") {
          if (p.text) parts.push({ type: textType, text: p.text });
        } else if (p?.type === "image_url") {
          parts.push({ type: "input_image", image_url: p.image_url?.url ?? "" });
        }
      }
      input.push({ role, content: parts.length > 0 ? parts : "" });
      continue;
    }
    input.push({ role, content: m.content ?? "" });
  }
  return {
    model: body.model,
    input,
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.max_tokens !== undefined ? { max_output_tokens: body.max_tokens } : {}),
    ...(body.stream ? { stream: true } : {}),
  };
}

/** Responses API `output` → OpenAI chat completion shape. */
export function fromCodexResponse(json: any, model: string): ChatCompletionResponse {
  const outputs: any[] = Array.isArray(json.output) ? json.output : [];
  const text = outputs
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .filter((c: any) => c.type === "output_text")
    .map((c: any) => c.text ?? "")
    .join("");
  const usage = json.usage ?? {};
  return {
    id: json.id ?? `chatcmpl-${Date.now()}`,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: outputs.some((o) => o.type === "message") ? "stop" : "length",
      },
    ],
    usage: {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    },
  };
}

/** One Responses SSE event → OpenAI chunk (or null to skip). */
export function codexStreamEvent(data: any, model: string): Record<string, unknown> | null {
  if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
    return {
      id: `chatcmpl-${Date.now()}`,
      model,
      choices: [{ index: 0, delta: { content: data.delta }, finish_reason: null }],
    };
  }
  if (data.type === "response.completed") {
    return {
      id: `chatcmpl-${Date.now()}`,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
  }
  return null;
}
