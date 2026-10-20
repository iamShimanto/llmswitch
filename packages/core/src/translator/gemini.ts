import type { ChatCompletionRequest, ChatCompletionResponse } from "../providers/types.js";

/** Google Gemini (Generative Language API) translator. */

export function toGeminiRequest(body: ChatCompletionRequest): Record<string, unknown> {
  const systemParts: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

  for (const m of body.messages) {
    if (m.role === "system") {
      if (m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === "tool") continue;
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content ?? "" }],
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
