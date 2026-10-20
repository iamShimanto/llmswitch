import type { ChatCompletionRequest, ChatCompletionResponse } from "../providers/types.js";

/**
 * Naver Clova Studio translator.
 * Chat completions → Clova `messages` (system/user/assistant) + topP/topK;
 * `result.message.content` → OpenAI shape.
 */

export function toClovaRequest(body: ChatCompletionRequest): Record<string, unknown> {
  const messages = body.messages
    .filter((m) => m.role !== "tool")
    .map((m) => ({ role: m.role === "system" ? "system" : m.role, content: m.content ?? "" }));
  const extra = body as unknown as Record<string, unknown>;
  return {
    messages,
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(typeof extra.topP === "number" ? { topP: extra.topP } : {}),
    ...(typeof extra.topK === "number" ? { topK: extra.topK } : {}),
    ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
    ...(body.stream ? { stream: true } : {}),
  };
}

/** Clova `result.message.content` → OpenAI chat completion shape. */
export function fromClovaResponse(json: any, model: string): ChatCompletionResponse {
  const result = json.result ?? {};
  const text = result.message?.content ?? "";
  const usage = result.usage ?? {};
  return {
    id: `chatcmpl-${Date.now()}`,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: result.stopReason === "length" ? "length" : "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.promptTokens ?? 0,
      completion_tokens: usage.completionTokens ?? 0,
      total_tokens: (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
    },
  };
}
