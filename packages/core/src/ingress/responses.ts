import { randomBytes } from "node:crypto";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
} from "../providers/types.js";

/**
 * OpenAI Responses API (/v1/responses) adapter.
 * Translates to/from the gateway's chat-completions core.
 */

export interface ResponsesRequest {
  model: string;
  input?: string | Array<{ role: string; content: unknown }>;
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("");
  }
  return "";
}

export function responsesToChat(body: ResponsesRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];
  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }
  const input = body.input ?? "";
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else {
    for (const m of input) {
      const role = m.role === "assistant" || m.role === "system" ? m.role : "user";
      messages.push({ role, content: textOf(m.content) });
    }
  }
  return {
    model: body.model,
    messages,
    max_tokens: body.max_output_tokens,
    temperature: body.temperature,
    stream: body.stream,
  };
}

export interface ResponsesResponse {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  status: "completed" | "incomplete";
  output: Array<{
    type: "message";
    id: string;
    role: "assistant";
    content: Array<{ type: "output_text"; text: string; annotations: unknown[] }>;
  }>;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

export function chatToResponses(
  chat: ChatCompletionResponse,
  model: string,
): ResponsesResponse {
  const text = chat.choices[0]?.message.content ?? "";
  return {
    id: `resp_${randomBytes(12).toString("hex")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output: [
      {
        type: "message",
        id: `msg_${randomBytes(12).toString("hex")}`,
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: chat.usage.prompt_tokens,
      output_tokens: chat.usage.completion_tokens,
      total_tokens: chat.usage.total_tokens,
    },
  };
}

/** SSE event lines for a streaming Responses API reply. */
export function responsesStreamEvents(
  respId: string,
  model: string,
  deltas: string[],
): string[] {
  const events: string[] = [];
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  events.push(
    ev("response.created", { type: "response.created", response: { id: respId, object: "response", model } }),
  );
  for (const d of deltas) {
    events.push(
      ev("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: `msg_${respId}`,
        delta: d,
      }),
    );
  }
  events.push(
    ev("response.completed", {
      type: "response.completed",
      response: { id: respId, object: "response", model, status: "completed" },
    }),
  );
  return events;
}
