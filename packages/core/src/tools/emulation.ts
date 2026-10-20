/**
 * Tool-call emulation for providers whose wire format has no native tool
 * support in our translator (anthropic/gemini). Strategy:
 *  1. inject tool definitions into the prompt as a system message,
 *  2. parse a ```tool_call JSON block from the reply into OpenAI tool_calls.
 * OpenAI-wire providers get native passthrough (unchanged).
 */

import type { ToolCall, ToolDef } from "../providers/types.js";

export type EmulatedToolCall = ToolCall;

export function buildEmulationPrompt(tools: ToolDef[]): string {
  const defs = tools
    .map(
      (t) =>
        `- ${t.function.name}: ${t.function.description ?? "no description"}` +
        (t.function.parameters ? `\n  Parameters: ${JSON.stringify(t.function.parameters)}` : ""),
    )
    .join("\n");
  return [
    "You have access to the following tools. When you need one, output ONLY a JSON",
    "code block in exactly this format and nothing else:",
    "```tool_call",
    '{"name": "tool_name", "arguments": {"key": "value"}}',
    "```",
    "Otherwise answer normally.",
    "",
    "Tools:",
    defs,
  ].join("\n");
}

/** Extract a tool call from model text. Returns null when none found. */
export function parseEmulatedToolCall(text: string): EmulatedToolCall | null {
  const block = text.match(/```tool_call\s*([\s\S]*?)```/)?.[1]?.trim()
    ?? text.match(/```json\s*([\s\S]*?)```/)?.[1]?.trim();
  const candidates = [block, text.trim()].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const j = JSON.parse(c);
      const name = j.name ?? j.function?.name;
      const args = j.arguments ?? j.function?.arguments ?? j.parameters ?? {};
      if (typeof name === "string" && name.length > 0) {
        return {
          id: `call_${Math.random().toString(36).slice(2, 10)}`,
          type: "function",
          function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
        };
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/** Does this wire format get native tool passthrough? */
export function nativeTools(wireFormat: string): boolean {
  return wireFormat === "openai";
}
