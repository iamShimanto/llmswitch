import type { ChatCompletionRequest, ChatCompletionResponse } from "../providers/types.js";

/**
 * OpenAI Codex / Responses API translator.
 * Chat completions → Responses API `input` array; `output` array → choices.
 */

interface ResponsesInputItem {
  role: "system" | "user" | "assistant" | "developer";
  content: string;
}

export function toCodexRequest(body: ChatCompletionRequest): Record<string, unknown> {
  const input: ResponsesInputItem[] = [];
  for (const m of body.messages) {
    if (m.role === "tool") continue;
    input.push({
      role: m.role === "system" ? "developer" : (m.role as "user" | "assistant"),
      content: m.content ?? "",
    });
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
