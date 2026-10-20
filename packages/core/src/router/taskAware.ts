import type { ChatCompletionRequest, ResolvedProvider } from "../providers/types.js";
import { orderProviders, type ProviderStats } from "./strategies.js";

export type TaskKind = "code" | "reasoning" | "writing" | "chat";

/** Heuristic task classifier (v1: keywords/patterns; ML classifier later). */
export function classifyTask(body: ChatCompletionRequest): TaskKind {
  const text = body.messages.map((m) => m.content ?? "").join("\n");
  if (
    /```|def \w+\(|function\s+\w+\s*\(|import\s+[\w.{}\s,]+|class\s+\w+|<\w+[^>]*>|=>|#include|console\.log|print\(/.test(
      text,
    )
  ) {
    return "code";
  }
  if (
    /\b(prove|proof|calculate|compute|solve|theorem|equation|integral|derivative|algorithm complexity)\b/i.test(
      text,
    )
  ) {
    return "reasoning";
  }
  if (/\b(write|draft|essay|blog|email|story|poem|rewrite|summariz|translate)\b/i.test(text)) {
    return "writing";
  }
  return "chat";
}

/** Preferred provider order per task (heuristic; falls back to cost order). */
const TASK_PREFERENCE: Record<TaskKind, string[]> = {
  code: ["deepseek", "groq", "cerebras", "together", "fireworks", "openai", "anthropic", "mistral", "gemini"],
  reasoning: ["anthropic", "openai", "deepseek", "gemini", "groq", "mistral"],
  writing: ["anthropic", "openai", "gemini", "mistral", "groq", "deepseek"],
  chat: [], // pure cost-optimized
};

export function taskAwareOrder(
  providers: ResolvedProvider[],
  body: ChatCompletionRequest,
  stats: Map<string, ProviderStats> = new Map(),
): { order: ResolvedProvider[]; task: TaskKind } {
  const task = classifyTask(body);
  if (task === "chat") {
    return { order: orderProviders(providers, "cost-optimized", stats), task };
  }
  const pref = TASK_PREFERENCE[task];
  const rank = new Map(pref.map((id, i) => [id, i] as const));
  const byTask = [...providers].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id)! : 1000 + a.costTier;
    const rb = rank.has(b.id) ? rank.get(b.id)! : 1000 + b.costTier;
    return ra - rb;
  });
  // stable: keep stats-aware tiebreak via least-used within same rank
  return { order: byTask, task };
}
