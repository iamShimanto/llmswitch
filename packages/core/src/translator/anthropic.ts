import {
  contentText,
  parseDataUrl,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type ImageContentPart,
} from "../providers/types.js";

/** Anthropic Messages API translator (→ wire format → OpenAI shape). */

export function toAnthropicRequest(body: ChatCompletionRequest): Record<string, unknown> {
  // Rich requests (image parts, tool calls, tool results) take the block
  // path; plain-text requests keep the legacy string path byte-identical.
  const rich = body.messages.some(
    (m) => Array.isArray(m.content) || m.role === "tool" || (m.tool_calls?.length ?? 0) > 0,
  );
  return rich ? toAnthropicRequestRich(body) : toAnthropicRequestText(body);
}

/** Legacy plain-text conversion (unchanged behaviour for string content). */
function toAnthropicRequestText(body: ChatCompletionRequest): Record<string, unknown> {
  const systemParts: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const m of body.messages) {
    if (m.role === "system") {
      const text = contentText(m.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (m.role === "tool") continue; // P0: tools not supported
    messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: contentText(m.content) });
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

type AnthropicBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
    }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

function parseArgsObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** OpenAI image part → Anthropic image block (data URLs as base64 source). */
function imagePartToAnthropic(part: ImageContentPart): AnthropicBlock {
  const url = part.image_url?.url ?? "";
  const data = parseDataUrl(url);
  if (data) {
    return { type: "image", source: { type: "base64", media_type: data.mediaType, data: data.data } };
  }
  return { type: "image", source: { type: "url", url } };
}

/** Block-path conversion: image parts, tool_use and tool_result blocks. */
function toAnthropicRequestRich(body: ChatCompletionRequest): Record<string, unknown> {
  const systemParts: string[] = [];
  const converted: Array<{ role: "user" | "assistant"; blocks: AnthropicBlock[] }> = [];
  let callSeq = 0;

  for (const m of body.messages) {
    if (m.role === "system") {
      const text = contentText(m.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (m.role === "tool") {
      const text = contentText(m.content);
      if (m.tool_call_id) {
        converted.push({
          role: "user",
          blocks: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: text }],
        });
      } else if (text) {
        // No call id to bind to — degrade to a plain user text turn.
        converted.push({ role: "user", blocks: [{ type: "text", text }] });
      }
      continue;
    }
    const blocks: AnthropicBlock[] = [];
    if (typeof m.content === "string") {
      if (m.content) blocks.push({ type: "text", text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p?.type === "text") {
          if (p.text) blocks.push({ type: "text", text: p.text });
        } else if (p?.type === "image_url") {
          blocks.push(imagePartToAnthropic(p));
        }
      }
    }
    if (m.role === "assistant") {
      for (const tc of m.tool_calls ?? []) {
        const name = tc.function?.name;
        if (!name) continue;
        blocks.push({
          type: "tool_use",
          id: tc.id ?? `toolu_call_${++callSeq}`,
          name,
          input: parseArgsObject(tc.function?.arguments),
        });
      }
    }
    if (blocks.length === 0) continue;
    converted.push({ role: m.role === "assistant" ? "assistant" : "user", blocks });
  }

  // Anthropic requires alternating roles; merge consecutive same-role turns
  // by concatenating their blocks.
  const merged: Array<{ role: "user" | "assistant"; blocks: AnthropicBlock[] }> = [];
  for (const c of converted) {
    const last = merged[merged.length - 1];
    if (last && last.role === c.role) last.blocks.push(...c.blocks);
    else merged.push({ role: c.role, blocks: [...c.blocks] });
  }
  if (merged.length > 0 && merged[0]!.role !== "user") {
    merged.unshift({ role: "user", blocks: [{ type: "text", text: "(start)" }] });
  }

  return {
    model: body.model,
    max_tokens: body.max_tokens ?? 1024,
    ...(systemParts.length > 0 ? { system: systemParts.join("\n") } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    messages: merged.map((m) => ({ role: m.role, content: m.blocks })),
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
      // One input message can yield several internal messages: tool_result
      // blocks become their own role:"tool" messages (call id preserved);
      // text/image blocks and tool_use calls accumulate into one message.
      type Segment = { kind: "text"; text: string } | { kind: "image"; part: ImageContentPart };
      let segments: Segment[] = [];
      let toolCalls: NonNullable<ChatMessage["tool_calls"]> = [];
      const flush = () => {
        if (segments.length === 0 && toolCalls.length === 0) return;
        const msg: ChatMessage = { role, content: "" };
        if (segments.some((s) => s.kind === "image")) {
          msg.content = segments.map((s) =>
            s.kind === "image" ? s.part : { type: "text" as const, text: s.text },
          );
        } else {
          msg.content = segments.map((s) => (s.kind === "text" ? s.text : "")).join("\n");
        }
        if (toolCalls.length > 0) msg.tool_calls = toolCalls;
        messages.push(msg);
        segments = [];
        toolCalls = [];
      };
      for (const b of m.content) {
        if (b?.type === "text") {
          segments.push({ kind: "text", text: b.text ?? "" });
        } else if (b?.type === "tool_result") {
          flush();
          messages.push({
            role: "tool",
            content:
              typeof b.content === "string"
                ? b.content
                : Array.isArray(b.content)
                  ? b.content
                      .filter((x: any) => x?.type === "text")
                      .map((x: any) => x.text ?? "")
                      .join("\n")
                  : JSON.stringify(b.content ?? ""),
            ...(typeof b.tool_use_id === "string" ? { tool_call_id: b.tool_use_id } : {}),
          });
        } else if (b?.type === "tool_use") {
          toolCalls.push({
            id: typeof b.id === "string" ? b.id : undefined,
            type: "function",
            function: { name: String(b.name ?? ""), arguments: JSON.stringify(b.input ?? {}) },
          });
        } else if (b?.type === "image") {
          const src = (b.source ?? {}) as Record<string, unknown>;
          if (src.type === "base64" && typeof src.data === "string") {
            segments.push({
              kind: "image",
              part: {
                type: "image_url",
                image_url: {
                  url: `data:${typeof src.media_type === "string" ? src.media_type : "image/png"};base64,${src.data}`,
                },
              },
            });
          } else if (src.type === "url" && typeof src.url === "string") {
            segments.push({ kind: "image", part: { type: "image_url", image_url: { url: src.url } } });
          } else {
            segments.push({ kind: "text", text: "[image omitted]" });
          }
        }
      }
      flush();
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
