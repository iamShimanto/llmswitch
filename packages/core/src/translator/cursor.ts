import type { ChatCompletionRequest, ChatCompletionResponse } from "../providers/types.js";

/**
 * Cursor agent-style translator.
 * OpenAI-compatible wire; passes `available_tools` / `tool_choice` through
 * and normalizes tool_calls in responses.
 */

export function toCursorRequest(body: ChatCompletionRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: body.model,
    messages: body.messages.map((m) => ({ role: m.role, content: m.content ?? "" })),
    stream: body.stream ?? false,
  };
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  // Cursor agent dialect: tools arrive as available_tools
  const tools = (body as unknown as Record<string, unknown>).available_tools ?? body.tools;
  if (tools) out.available_tools = tools;
  if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice;
  return out;
}

/** Cursor responds in OpenAI shape; normalize tool_calls. */
export function fromCursorResponse(json: any, model: string): ChatCompletionResponse {
  const choice = json.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const toolCalls = (msg.tool_calls ?? []).map((tc: any, i: number) => ({
    id: tc.id ?? `call_${i}`,
    type: "function",
    function: {
      name: tc.function?.name ?? tc.name ?? "",
      arguments:
        typeof tc.function?.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? tc.arguments ?? {}),
    },
  }));
  return {
    id: json.id ?? `chatcmpl-${Date.now()}`,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: msg.content ?? "",
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
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
