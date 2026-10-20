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

/* ------------------------------------------------------------------ *
 * Router combos (OmniRoute-style virtual models)
 *
 * A router combo is a named virtual model: a chat request addressed to
 * the combo's name tries its targets (provider:model refs, bare model
 * ids, "auto", or other combo names) in strategy order until one
 * succeeds. Strategies mirror OmniRoute's combo strategies.
 * ------------------------------------------------------------------ */

export type ComboStrategy =
  | "priority"
  | "weighted"
  | "round-robin"
  | "random"
  | "least-used"
  | "cost-optimized"
  | "fill-first"
  | "p2c"
  | "headroom"
  | "context-relay"
  | "strict-random";

export const COMBO_STRATEGIES: ComboStrategy[] = [
  "priority",
  "weighted",
  "round-robin",
  "random",
  "least-used",
  "cost-optimized",
  "fill-first",
  "p2c",
  "headroom",
  "context-relay",
  "strict-random",
];

export function isComboStrategy(v: unknown): v is ComboStrategy {
  return typeof v === "string" && (COMBO_STRATEGIES as string[]).includes(v);
}

export interface ComboTarget {
  /** "provider:model" (or OmniRoute-style "provider/model"), a bare model id, "auto", or another combo name */
  model: string;
  /** weighted strategy only; default 1 */
  weight?: number;
  /** pin this target to one specific account (null/absent = dynamic) */
  accountId?: string | null;
}

export interface ComboValidation {
  /** fail over when the reply contains any of these */
  forbidden?: string[];
  /** fail over unless the reply contains ALL of these */
  required?: string[];
  /** fail over when the reply is shorter than this */
  minLength?: number;
}

export interface ComboConfig {
  /** replaces (or becomes) the system message for requests via this combo */
  systemPrompt?: string;
  /** advertised context window for /v1/models */
  contextLength?: number;
  validation?: ComboValidation;
}

export interface RouterCombo {
  name: string;
  description?: string;
  kind: "router";
  strategy: ComboStrategy;
  targets: ComboTarget[];
  config?: ComboConfig;
  enabled?: boolean;
  createdAt: number;
}

export type ValidatedCombo =
  | { kind: "pipeline"; name: string; description?: string; steps: ComboStep[] }
  | {
      kind: "router";
      name: string;
      description?: string;
      strategy: ComboStrategy;
      targets: ComboTarget[];
      config?: ComboConfig;
      enabled?: boolean;
    };

/** Validate either combo flavour (targets = router combo, steps = pipeline). */
export function validateAnyCombo(input: unknown): ValidatedCombo {
  if (typeof input !== "object" || input === null) throw new Error("combo must be an object");
  const o = input as Record<string, unknown>;
  if (Array.isArray(o.targets)) {
    const name = typeof o.name === "string" ? o.name.trim() : "";
    // Router combo names may carry a namespace slash (e.g. "team/main"),
    // but never ":" (pinned syntax) and never the reserved auto/ prefix.
    if (
      !/^[a-z0-9][a-z0-9-_/.]{1,63}$/.test(name) ||
      name.includes(":") ||
      name === "auto" ||
      name.startsWith("auto/")
    ) {
      throw new Error("invalid combo name (lowercase letters, digits, -, _, / and .; auto/ is reserved)");
    }
    if (o.targets.length < 1 || o.targets.length > 20) {
      throw new Error("targets must be an array of 1-20 entries");
    }
    const targets: ComboTarget[] = o.targets.map((t, i) => {
      if (typeof t !== "object" || t === null) throw new Error(`target ${i}: must be an object`);
      const to = t as Record<string, unknown>;
      const model = typeof to.model === "string" ? to.model.trim() : "";
      if (!model) throw new Error(`target ${i}: model is required`);
      if (model === name) throw new Error(`target ${i}: a combo cannot target itself`);
      const target: ComboTarget = { model };
      if (typeof to.weight === "number" && Number.isFinite(to.weight) && to.weight > 0) {
        target.weight = to.weight;
      }
      if (typeof to.accountId === "string" && to.accountId) target.accountId = to.accountId;
      return target;
    });
    const strategy = isComboStrategy(o.strategy) ? o.strategy : "priority";
    const description = typeof o.description === "string" ? o.description.trim() || undefined : undefined;
    let config: ComboConfig | undefined;
    if (typeof o.config === "object" && o.config !== null) {
      const co = o.config as Record<string, unknown>;
      config = {};
      if (typeof co.systemPrompt === "string" && co.systemPrompt.trim()) {
        config.systemPrompt = co.systemPrompt.trim().slice(0, 4000);
      }
      if (typeof co.contextLength === "number" && co.contextLength > 0) {
        config.contextLength = Math.floor(co.contextLength);
      }
      if (typeof co.validation === "object" && co.validation !== null) {
        const vo = co.validation as Record<string, unknown>;
        const validation: ComboValidation = {};
        const strList = (v: unknown) =>
          Array.isArray(v)
            ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()).slice(0, 20)
            : [];
        const forbidden = strList(vo.forbidden);
        const required = strList(vo.required);
        if (forbidden.length) validation.forbidden = forbidden;
        if (required.length) validation.required = required;
        if (typeof vo.minLength === "number" && vo.minLength > 0) {
          validation.minLength = Math.floor(vo.minLength);
        }
        if (Object.keys(validation).length) config.validation = validation;
      }
      if (!Object.keys(config).length) config = undefined;
    }
    const enabled = typeof o.enabled === "boolean" ? o.enabled : undefined;
    return { kind: "router", name, description, strategy, targets, config, enabled };
  }
  const v = validateCombo(input);
  return { kind: "pipeline", name: v.name, description: v.description, steps: v.steps };
}

export interface ComboOrderContext {
  /** calls so far per provider id (least-used) */
  providerCalls: (providerId: string) => number;
  /** resolve a target model to its provider's cost tier (cost-optimized) */
  providerTier: (model: string) => number;
  /** resolve a target model to a provider id (for least-used); "" when unknown */
  providerOf: (model: string) => string;
  /** remaining-quota share 0..1 for a target model (headroom); null = unknown */
  quotaShare?: (model: string) => number | null;
  /** rotating cursor for round-robin */
  cursor: number;
  /** random source (injectable for tests) */
  random?: () => number;
}

/** Order a router combo's targets per its strategy (pure; unit-tested). */
export function orderComboTargets(
  strategy: ComboStrategy,
  targets: ComboTarget[],
  ctx: ComboOrderContext,
): ComboTarget[] {
  const list = [...targets];
  if (list.length < 2) return list;
  const rand = ctx.random ?? Math.random;
  switch (strategy) {
    case "priority":
    case "fill-first":
      return list;
    case "round-robin": {
      const start = ((ctx.cursor % list.length) + list.length) % list.length;
      return [...list.slice(start), ...list.slice(0, start)];
    }
    case "random": {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [list[i], list[j]] = [list[j]!, list[i]!];
      }
      return list;
    }
    case "weighted": {
      // One weighted pick goes first; the rest follow in listed order.
      const total = list.reduce((a, t) => a + (t.weight ?? 1), 0);
      let r = rand() * total;
      let pick = 0;
      for (let i = 0; i < list.length; i++) {
        r -= list[i]!.weight ?? 1;
        if (r <= 0) {
          pick = i;
          break;
        }
      }
      return [list[pick]!, ...list.filter((_, i) => i !== pick)];
    }
    case "strict-random":
      return orderComboTargets("random", list, ctx);
    case "p2c": {
      // power of two choices: sample two, lead with the less-called one.
      if (list.length < 3) return list;
      const i = Math.floor(rand() * list.length);
      let j = Math.floor(rand() * list.length);
      if (j === i) j = (j + 1) % list.length;
      const ci = ctx.providerCalls(ctx.providerOf(list[i]!.model));
      const cj = ctx.providerCalls(ctx.providerOf(list[j]!.model));
      const lead = ci <= cj ? i : j;
      return [list[lead]!, ...list.filter((_, k) => k !== lead)];
    }
    case "headroom":
      // most remaining quota first; unknown quota counts as half.
      return list
        .map((t, i) => ({ t, i, share: ctx.quotaShare?.(t.model) ?? null }))
        .sort((a, b) => (b.share ?? 0.5) - (a.share ?? 0.5) || a.i - b.i)
        .map((x) => x.t);
    case "context-relay":
      // the router moves the last winning target to the front beforehand
      return list;
    case "least-used":
      return list
        .map((t, i) => ({ t, i, calls: ctx.providerCalls(ctx.providerOf(t.model)) }))
        .sort((a, b) => a.calls - b.calls || a.i - b.i)
        .map((x) => x.t);
    case "cost-optimized":
      return list
        .map((t, i) => ({ t, i, tier: ctx.providerTier(t.model) }))
        .sort((a, b) => a.tier - b.tier || a.i - b.i)
        .map((x) => x.t);
    default:
      return list;
  }
}
