import type { ChatCompletionRequest, ChatCompletionResponse } from "../providers/types.js";

/**
 * Zhipu GLM (coding endpoint) translator.
 * OpenAI-compatible wire; injects GLM request defaults unless the caller
 * already set them explicitly.
 */

/** Mirror of OmniRoute's GLM_REQUEST_DEFAULTS (shared.ts). */
export const GLM_REQUEST_DEFAULTS = {
  temperature: 0.7,
  top_p: 0.95,
} as const;

export function toGlmRequest(body: ChatCompletionRequest): Record<string, unknown> {
  return {
    model: body.model,
    messages: body.messages.map((m) => ({ role: m.role, content: m.content ?? "" })),
    stream: body.stream ?? false,
    temperature: body.temperature ?? GLM_REQUEST_DEFAULTS.temperature,
    top_p: GLM_REQUEST_DEFAULTS.top_p,
    ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
    ...(body.tools ? { tools: body.tools } : {}),
    ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
  };
}

/** GLM responds in OpenAI shape. */
export function fromGlmResponse(json: any, model: string): ChatCompletionResponse {
  const choice = json.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  return {
    id: json.id ?? `chatcmpl-${Date.now()}`,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: msg.content ?? "",
          ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
        },
        finish_reason: choice.finish_reason ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: json.usage?.prompt_tokens ?? 0,
      completion_tokens: json.usage?.completion_tokens ?? 0,
      total_tokens: json.usage?.total_tokens ?? 0,
    },
  };
}
