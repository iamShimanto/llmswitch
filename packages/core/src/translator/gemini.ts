import {
  contentText,
  parseDataUrl,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type ImageContentPart,
} from "../providers/types.js";

/** Google Gemini (Generative Language API) translator. */

type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }
  | { file_data: { file_uri: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

/** JSON-object parse for tool arguments/results (null when not an object). */
function parseJsonObject(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** OpenAI image part → Gemini native shape: data URLs inline as base64;
 *  remote URLs ride as file_data URIs (the native API serves Files-API
 *  URIs; arbitrary https URLs are the upstream's call). */
function imagePartToGemini(part: ImageContentPart): GeminiPart {
  const url = part.image_url?.url ?? "";
  const data = parseDataUrl(url);
  if (data) return { inline_data: { mime_type: data.mediaType, data: data.data } };
  return { file_data: { file_uri: url } };
}

/** Message content → Gemini parts. Empty text parts are dropped when the
 *  turn carries anything else (the API rejects empty parts); a turn with
 *  nothing at all keeps the legacy single empty text part. */
function contentPartsToGemini(content: ChatMessage["content"]): GeminiPart[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: GeminiPart[] = [];
  for (const p of content) {
    if (p?.type === "text") {
      if (p.text) parts.push({ text: p.text });
    } else if (p?.type === "image_url") {
      parts.push(imagePartToGemini(p));
    }
  }
  return parts;
}

export function toGeminiRequest(body: ChatCompletionRequest): Record<string, unknown> {
  const systemParts: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];

  // tool_call_id → function name, so tool results can be named on the wire.
  const callNames = new Map<string, string>();
  for (const m of body.messages) {
    for (const tc of m.tool_calls ?? []) {
      if (tc.id && tc.function?.name) callNames.set(tc.id, tc.function.name);
    }
  }

  for (const m of body.messages) {
    if (m.role === "system") {
      const text = contentText(m.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (m.role === "tool") {
      // Tool results ride as functionResponse parts on a user turn —
      // dropping them (the old behaviour) silently broke tool history.
      const text = contentText(m.content);
      const response = parseJsonObject(text) ?? { result: text };
      const name = m.name ?? (m.tool_call_id ? callNames.get(m.tool_call_id) : undefined) ?? "tool";
      contents.push({ role: "user", parts: [{ functionResponse: { name, response } }] });
      continue;
    }
    const parts = contentPartsToGemini(m.content);
    if (m.role === "assistant") {
      for (const tc of m.tool_calls ?? []) {
        const name = tc.function?.name;
        if (!name) continue;
        parts.push({ functionCall: { name, args: parseJsonObject(tc.function?.arguments) ?? {} } });
      }
    }
    if (parts.length === 0) parts.push({ text: "" });
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts,
    });
  }

  return {
    ...(systemParts.length > 0
      ? { systemInstruction: { parts: [{ text: systemParts.join("\n") }] } }
      : {}),
    contents,
    generationConfig: {
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.max_tokens !== undefined ? { maxOutputTokens: body.max_tokens } : {}),
    },
  };
}

export function geminiUrl(baseUrl: string, model: string, stream: boolean, apiKey: string): string {
  const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  return `${baseUrl}/v1beta/models/${model}:${action}?key=${encodeURIComponent(apiKey)}`;
}

export function fromGeminiResponse(json: any, model: string): ChatCompletionResponse {
  const candidate = json.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((p: any) => p.text ?? "")
    .join("");
  const usage = json.usageMetadata ?? {};
  return {
    id: `chatcmpl-${Date.now()}`,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: candidate?.finishReason === "MAX_TOKENS" ? "length" : "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.promptTokenCount ?? 0,
      completion_tokens: usage.candidatesTokenCount ?? 0,
      total_tokens: usage.totalTokenCount ?? 0,
    },
  };
}

/** Convert one Gemini SSE data payload to an OpenAI chunk (or null to skip). */
export function geminiStreamEvent(data: any, model: string): Record<string, unknown> | null {
  const candidate = data.candidates?.[0];
  if (!candidate) return null;
  const text = (candidate.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
  const done = candidate.finishReason !== undefined;
  return {
    id: `chatcmpl-${Date.now()}`,
    model,
    choices: [
      {
        index: 0,
        delta: text ? { content: text } : {},
        finish_reason: done ? "stop" : null,
      },
    ],
  };
}
