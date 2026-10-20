import type { ChatCompletionRequest, ChatCompletionResponse } from "../providers/types.js";

/**
 * Moonshot Kimi translator.
 * Kimi's route requires upstream SSE: always request `stream: true`, then
 * buffer the chunks back to a JSON response when the client asked stream:false.
 */

export function toKimiRequest(body: ChatCompletionRequest): Record<string, unknown> {
  return {
    model: body.model,
    messages: body.messages.map((m) => ({ role: m.role, content: m.content ?? "" })),
    stream: true, // required by the Kimi route
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
  };
}

/**
 * Assemble buffered OpenAI SSE chunk dicts into a single JSON response.
 * Chunks are the parsed `data:` payloads (already JSON-decoded).
 */
export function bufferKimiChunks(chunks: any[], model: string): ChatCompletionResponse {
  let content = "";
  let finishReason: string | null = null;
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const c of chunks) {
    const choice = c?.choices?.[0];
    if (!choice) continue;
    if (typeof choice.delta?.content === "string") content += choice.delta.content;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (c.usage) {
      usage = {
        prompt_tokens: c.usage.prompt_tokens ?? 0,
        completion_tokens: c.usage.completion_tokens ?? 0,
        total_tokens: c.usage.total_tokens ?? 0,
      };
    }
  }
  return {
    id: `chatcmpl-${Date.now()}`,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason ?? "stop",
      },
    ],
    usage,
  };
}
