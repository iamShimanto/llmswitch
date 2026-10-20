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

/** Convert an Anthropic Messages API request (ingress) to an OpenAI chat request. */
export function fromAnthropicRequest(body: any): ChatCompletionRequest {
  const messages: ChatCompletionRequest["messages"] = [];
  const systemText =
    typeof body?.system === "string"
      ? body.system
      : Array.isArray(body?.system)
        ? body.system
            .filter((b: any) => b?.type === "text")
            .map((b: any) => b.text ?? "")
            .join("\n")
        : "";
  if (systemText) messages.push({ role: "system", content: systemText });

  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    const role = m?.role === "assistant" ? ("assistant" as const) : ("user" as const);
    if (typeof m?.content === "string") {
      messages.push({ role, content: m.content });
      continue;
    }
    if (Array.isArray(m?.content)) {
      const texts: string[] = [];
      for (const b of m.content) {
        if (b?.type === "text") texts.push(b.text ?? "");
        else if (b?.type === "tool_result") {
          messages.push({
            role: "tool",
            content: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""),
          });
        } else if (b?.type === "tool_use") {
          texts.push(`[tool call: ${b.name}(${JSON.stringify(b.input ?? {})})]`);
        } else if (b?.type === "image") {
          texts.push("[image omitted]");
        }
      }
      if (texts.length > 0) messages.push({ role, content: texts.join("\n") });
      continue;
    }
    messages.push({ role, content: "" });
  }

  return {
    model: body?.model,
    messages,
    ...(body?.max_tokens ? { max_tokens: body.max_tokens } : {}),
    ...(body?.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body?.stream ? { stream: true } : {}),
  };
}

export function toAnthropicStopReason(finish: string | null | undefined): string {
  switch (finish) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

function safeJsonParse(s: unknown): Record<string, unknown> {
  try {
    const v = typeof s === "string" ? JSON.parse(s) : s;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Convert an OpenAI chat response to an Anthropic Messages response (ingress). */
export function toAnthropicResponse(resp: ChatCompletionResponse, model: string): Record<string, unknown> {
  const choice = resp.choices?.[0];
  const content: Array<Record<string, unknown>> = [];
  const text = choice?.message?.content ?? "";
  if (text) content.push({ type: "text", text });
  for (const tc of choice?.message?.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: tc.id ?? `toolu_${Date.now()}`,
      name: tc.function?.name ?? "",
      input: safeJsonParse(tc.function?.arguments),
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id: resp.id?.startsWith("msg_") ? resp.id : `msg_${(resp.id ?? "x").replace(/^chatcmpl-/, "")}`,
    type: "message",
    role: "assistant",
    model: resp.model ?? model,
    content,
    stop_reason: toAnthropicStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}
