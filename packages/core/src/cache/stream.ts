import type { ChatCompletionResponse } from "../providers/types.ts";

/**
 * Streaming support for the prompt cache. The router's stream is an async
 * generator of OpenAI chunk objects; these helpers assemble a completed
 * stream back into a full ChatCompletionResponse (for storing) and replay
 * a stored response as chunk objects (for a cache hit on a streaming
 * request). Chunk shapes mirror executor/http.ts sseToOpenAI output.
 */

type Chunk = Record<string, unknown>;

interface ToolAcc {
  id: string;
  name: string;
  args: string;
}

/** Wrap a chunk stream: pass chunks through untouched while assembling
 *  the final response; call onDone with it when the stream completes
 *  successfully. If the stream errors, onDone never fires (nothing is
 *  cached from a broken stream). */
export async function* tapStream(
  stream: AsyncGenerator<Chunk>,
  onDone: (response: ChatCompletionResponse) => void,
): AsyncGenerator<Chunk> {
  let id = "";
  let model = "";
  let created = 0;
  let content = "";
  let finishReason: string | null = null;
  let usage: ChatCompletionResponse["usage"] | undefined;
  const tools = new Map<number, ToolAcc>();

  for await (const chunk of stream) {
    const c = chunk as {
      id?: string;
      model?: string;
      created?: number;
      usage?: ChatCompletionResponse["usage"];
      choices?: Array<{
        delta?: {
          content?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
    };
    if (c.id) id = c.id;
    if (c.model) model = c.model;
    if (c.created) created = c.created;
    if (c.usage) usage = c.usage;
    const choice = c.choices?.[0];
    if (choice) {
      const d = choice.delta ?? {};
      if (typeof d.content === "string") content += d.content;
      for (const tc of d.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const acc = tools.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        tools.set(idx, acc);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    yield chunk;
  }

  const toolCalls = [...tools.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, acc]) => ({
      id: acc.id || "call_cached",
      type: "function" as const,
      function: { name: acc.name, arguments: acc.args },
    }));

  onDone({
    id: id || "chatcmpl-cached",
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
      },
    ],
    ...(usage ? { usage } : {}),
  } as ChatCompletionResponse);
}

/** Replay a stored response as OpenAI chunk objects (content in a single
 *  delta — valid per the streaming protocol; tool calls as one chunk). */
export async function* replayStream(response: ChatCompletionResponse): AsyncGenerator<Chunk> {
  const choice = response.choices?.[0];
  const ext = response as unknown as { created?: number; usage?: unknown };
  const base = {
    id: response.id,
    object: "chat.completion.chunk",
    created: ext.created ?? Math.floor(Date.now() / 1000),
    model: response.model,
  };
  const content = choice?.message?.content;
  if (typeof content === "string" && content.length > 0) {
    yield {
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    };
  }
  const toolCalls = (choice?.message as { tool_calls?: unknown[] } | undefined)?.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    yield {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: toolCalls.map((tc, i) => ({ index: i, ...(tc as Record<string, unknown>) })),
          },
          finish_reason: null,
        },
      ],
    };
  }
  yield {
    ...base,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: choice?.finish_reason ?? "stop",
      },
    ],
    ...(ext.usage ? { usage: ext.usage } : {}),
  };
}
