/**
 * Combo chains — sequential multi-model pipelines.
 *
 * A combo is a named list of steps. Step 1 receives the user's input;
 * each later step receives the previous step's output (optionally with
 * its own system prompt). Per-step outputs + costs are returned.
 *
 *   POST /v1/combos/:name/run { "input": "..." }
 */
import type { Router } from "../router/index.js";
import type { ChatCompletionRequest } from "../providers/types.js";
import { costUsd } from "../billing/prices.js";

export interface ComboStep {
  /** model id, "provider:model" or "auto" */
  model: string;
  /** optional system prompt for this step */
  system?: string;
}

export interface Combo {
  name: string;
  description?: string;
  steps: ComboStep[];
  createdAt: number;
}

export interface ComboStepResult {
  step: number;
  model: string;
  providerId: string;
  output: string;
  latencyMs: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  costUsd: number;
}

export interface ComboRunResult {
  combo: string;
  steps: ComboStepResult[];
  totalCostUsd: number;
  totalLatencyMs: number;
}

export function validateCombo(input: unknown): { name: string; description?: string; steps: ComboStep[] } {
  if (typeof input !== "object" || input === null) throw new Error("combo must be an object");
  const o = input as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!/^[a-z0-9][a-z0-9-_]{1,63}$/.test(name)) {
    throw new Error("invalid combo name (lowercase letters, digits, - and _)");
  }
  if (!Array.isArray(o.steps) || o.steps.length < 1 || o.steps.length > 10) {
    throw new Error("steps must be an array of 1-10 steps");
  }
  const steps: ComboStep[] = o.steps.map((s, i) => {
    if (typeof s !== "object" || s === null) throw new Error(`step ${i}: must be an object`);
    const so = s as Record<string, unknown>;
    const model = typeof so.model === "string" ? so.model.trim() : "";
    if (!model) throw new Error(`step ${i}: model is required`);
    const step: ComboStep = { model };
    if (typeof so.system === "string" && so.system.trim()) step.system = so.system.trim();
    return step;
  });
  const description = typeof o.description === "string" ? o.description.trim() : undefined;
  return { name, description: description || undefined, steps };
}

export async function runCombo(combo: Combo, input: string, router: Router): Promise<ComboRunResult> {
  if (!input.trim()) throw new Error("input is required");
  const results: ComboStepResult[] = [];
  let current = input;
  for (let i = 0; i < combo.steps.length; i++) {
    const step = combo.steps[i];
    const messages: ChatCompletionRequest["messages"] = [];
    if (step.system) messages.push({ role: "system", content: step.system });
    messages.push({ role: "user", content: current });
    const body: ChatCompletionRequest = { model: step.model, messages };
    const r = await router.route(body);
    const output = r.response?.choices?.[0]?.message?.content ?? "";
    const usage = r.response?.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    results.push({
      step: i + 1,
      model: step.model,
      providerId: r.providerId,
      output,
      latencyMs: r.latencyMs,
      usage,
      costUsd: costUsd(r.providerId, r.model, usage.prompt_tokens, usage.completion_tokens),
    });
    current = output;
  }
  return {
    combo: combo.name,
    steps: results,
    totalCostUsd: results.reduce((a, s) => a + s.costUsd, 0),
    totalLatencyMs: results.reduce((a, s) => a + s.latencyMs, 0),
  };
}
