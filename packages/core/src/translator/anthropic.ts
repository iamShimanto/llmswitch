import type { ChatCompletionRequest, ChatCompletionResponse } from "../providers/types.js";

/** Anthropic Messages API translator (→ wire format → OpenAI shape). */

export function toAnthropicRequest(body: ChatCompletionRequest): Record<string, unknown> {
  const systemParts: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const m of body.messages) {
    if (m.role === "system") {
      if (m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === "tool") continue; // P0: tools not supported
    messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content ?? "" });
  }

  // Anthropic requires alternating roles; merge consecutive same-role messages.
  const merged: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += "\n" + m.content;
    else merged.push({ ...m });
  }
  if (merged.length > 0 && merged[0].role !== "user") {
    merged.unshift({ role: "user", content: "(start)" });
  }

  return {
    model: body.model,
    max_tokens: body.max_tokens ?? 1024,
    ...(systemParts.length > 0 ? { system: systemParts.join("\n") } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    messages: merged,
  };
}

export function fromAnthropicResponse(json: any, model: string): ChatCompletionResponse {
  const text = (json.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text ?? "")
    .join("");
  return {
    id: json.id ?? `chatcmpl-${Date.now()}`,
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: json.stop_reason ?? "stop" },
    ],
    usage: {
      prompt_tokens: json.usage?.input_tokens ?? 0,
      completion_tokens: json.usage?.output_tokens ?? 0,
      total_tokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
    },
  };
}

/** Convert one Anthropic SSE data payload to an OpenAI chunk (or null to skip). */
export function anthropicStreamEvent(data: any, model: string): Record<string, unknown> | null {
  if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
    return {
      id: `chatcmpl-${Date.now()}`,
      model,
      choices: [{ index: 0, delta: { content: data.delta.text ?? "" }, finish_reason: null }],
    };
  }
  if (data.type === "message_stop") {
    return {
      id: `chatcmpl-${Date.now()}`,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
  }
  return null;
}

export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
}
