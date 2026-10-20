import type { ChatCompletionRequest, ChatCompletionResponse } from "../providers/types.js";

/**
 * AWS Kiro translator. OpenAI-compatible wire with `profileArn` passthrough
 * (Kiro routes requests to an IAM Identity Center profile).
 */

export function toKiroRequest(
  body: ChatCompletionRequest,
  profileArn?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: body.model,
    messages: body.messages.map((m) => ({ role: m.role, content: m.content ?? "" })),
    stream: body.stream ?? false,
  };
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  if (body.tools) out.tools = body.tools;
  if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice;
  const arn = profileArn ?? (body as unknown as Record<string, unknown>).profileArn;
  if (typeof arn === "string" && arn.length > 0) out.profileArn = arn;
  return out;
}

/** Kiro responds in OpenAI shape. */
export function fromKiroResponse(json: any, model: string): ChatCompletionResponse {
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
