/**
 * Approximate public list pricing in USD per 1M tokens.
 *
 * ESTIMATES for cost tracking and budgets — verify against provider
 * pricing pages. Resolution order (first hit wins):
 *   1. user overrides (dashboard Pricing tab; "provider:model" or "model")
 *   2. free routes (keyless/free providers and *:free models) → $0
 *   3. exact provider:model entries
 *   4. model-name patterns (bare model, any provider — this is what
 *      prices subscription-routed models like antigravity's Claude /
 *      Gemini at their list value)
 *   5. per-provider blended defaults
 *   6. null (unknown → cost 0, never blocks)
 */
export interface ModelPrice {
  input: number;
  output: number;
}

export type PriceSource = "override" | "exact" | "model" | "provider" | "free";
export interface PriceInfo extends ModelPrice {
  source: PriceSource;
}

const PRICES: Record<string, ModelPrice> = {
  // OpenAI
  "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
  "openai:gpt-4o": { input: 2.5, output: 10 },
  "openai:gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "openai:gpt-4.1": { input: 2, output: 8 },
  // Anthropic
  "anthropic:claude-haiku-4-5": { input: 1, output: 5 },
  "anthropic:claude-sonnet-4-5": { input: 3, output: 15 },
  "anthropic:claude-opus-4-1": { input: 15, output: 75 },
  // Google
  "gemini:gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini:gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini:gemini-2.0-flash": { input: 0.1, output: 0.4 },
  // Cheap/fast
  "groq:llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "deepseek:deepseek-chat": { input: 0.27, output: 1.1 },
  "mistral:mistral-small-latest": { input: 0.1, output: 0.3 },
  "mistral:mistral-medium-latest": { input: 0.4, output: 2 },
  "cerebras:llama-3.3-70b": { input: 0.6, output: 0.6 },
};

/** Model-name patterns, most specific first. Matched on the bare model id. */
const MODEL_PATTERNS: Array<{ label: string; re: RegExp; price: ModelPrice }> = [
  { label: "gpt-5-nano", re: /gpt-5[-.]?\d*-nano|gpt-5-nano/, price: { input: 0.05, output: 0.4 } },
  { label: "gpt-5-mini", re: /gpt-5.*mini/, price: { input: 0.25, output: 2 } },
  { label: "gpt-5", re: /gpt-5/, price: { input: 1.25, output: 10 } },
  { label: "gpt-4.1-mini", re: /gpt-4\.1-mini/, price: { input: 0.4, output: 1.6 } },
  { label: "gpt-4.1", re: /gpt-4\.1/, price: { input: 2, output: 8 } },
  { label: "gpt-4o-mini", re: /gpt-4o-mini/, price: { input: 0.15, output: 0.6 } },
  { label: "gpt-4o", re: /gpt-4o/, price: { input: 2.5, output: 10 } },
  { label: "o4-mini", re: /o4-mini/, price: { input: 1.1, output: 4.4 } },
  { label: "o3", re: /\bo3\b|o3-/, price: { input: 2, output: 8 } },
  { label: "claude-opus", re: /claude.*opus|opus.*Muse/, price: { input: 15, output: 75 } },
  { label: "claude-sonnet", re: /claude.*sonnet|sonnet.*Muse/, price: { input: 3, output: 15 } },
  { label: "claude-3.5-haiku", re: /claude-3[-.]5-haiku/, price: { input: 0.8, output: 4 } },
  { label: "claude-haiku", re: /claude.*haiku|haiku.*Muse/, price: { input: 1, output: 5 } },
  { label: "gemini-pro", re: /gemini.*pro/, price: { input: 1.25, output: 10 } },
  { label: "gemini-flash-lite", re: /gemini.*flash-lite|gemini.*lite/, price: { input: 0.1, output: 0.4 } },
  { label: "gemini-flash", re: /gemini.*flash/, price: { input: 0.3, output: 2.5 } },
  { label: "gemini", re: /gemini/, price: { input: 0.3, output: 2.5 } },
  { label: "llama-70b", re: /llama.*70b/, price: { input: 0.59, output: 0.79 } },
  { label: "llama-4-maverick", re: /llama-4-maverick|llama.*maverick/, price: { input: 0.2, output: 0.6 } },
  { label: "llama-4-scout", re: /llama-4-scout|llama.*scout/, price: { input: 0.11, output: 0.34 } },
  { label: "llama-8b", re: /llama.*8b/, price: { input: 0.05, output: 0.08 } },
  { label: "llama", re: /llama/, price: { input: 0.2, output: 0.2 } },
  { label: "deepseek-r1", re: /deepseek-r1|deepseek.*reasoner/, price: { input: 0.55, output: 2.19 } },
  { label: "deepseek", re: /deepseek/, price: { input: 0.27, output: 1.1 } },
  { label: "qwen-max", re: /qwen.*max/, price: { input: 1.2, output: 6 } },
  { label: "qwen-plus", re: /qwen.*plus/, price: { input: 0.4, output: 1.2 } },
  { label: "qwen-turbo", re: /qwen.*turbo/, price: { input: 0.05, output: 0.2 } },
  { label: "qwq", re: /qwq/, price: { input: 0.5, output: 1.5 } },
  { label: "qwen", re: /qwen/, price: { input: 0.3, output: 0.9 } },
  { label: "mistral-large", re: /mistral-large/, price: { input: 2, output: 6 } },
  { label: "mistral-medium", re: /mistral-medium/, price: { input: 0.4, output: 2 } },
  { label: "mistral-small", re: /mistral-small/, price: { input: 0.1, output: 0.3 } },
  { label: "mistral", re: /mistral|mixtral/, price: { input: 0.4, output: 2 } },
  { label: "grok-mini", re: /grok.*mini/, price: { input: 0.3, output: 0.5 } },
  { label: "grok", re: /grok/, price: { input: 3, output: 15 } },
  { label: "kimi/moonshot", re: /kimi|moonshot/, price: { input: 0.6, output: 2.5 } },
  { label: "gpt-oss-120b", re: /gpt-oss-120b/, price: { input: 0.15, output: 0.6 } },
  { label: "gpt-oss", re: /gpt-oss/, price: { input: 0.07, output: 0.3 } },
  { label: "muse-glimmer", re: /muse-glimmer/, price: { input: 1, output: 5 } },
  { label: "muse-spark/wonder", re: /muse-spark|muse-wonder/, price: { input: 4, output: 20 } },
  { label: "command", re: /command/, price: { input: 2.5, output: 7.5 } },
  { label: "glm", re: /glm/, price: { input: 0.5, output: 1.5 } },
  { label: "minimax", re: /minimax/, price: { input: 0.3, output: 1.2 } },
  { label: "nemotron", re: /nemotron/, price: { input: 0.3, output: 0.9 } },
];

const PROVIDER_DEFAULT: Record<string, ModelPrice> = {
  openai: { input: 2.5, output: 10 },
  anthropic: { input: 3, output: 15 },
  gemini: { input: 0.3, output: 2.5 },
  groq: { input: 0.59, output: 0.79 },
  deepseek: { input: 0.27, output: 1.1 },
  mistral: { input: 0.4, output: 2 },
  openrouter: { input: 1, output: 3 },
  cerebras: { input: 0.6, output: 0.6 },
  together: { input: 0.9, output: 0.9 },
  fireworks: { input: 0.9, output: 0.9 },
  deepinfra: { input: 0.7, output: 0.7 },
  xai: { input: 2, output: 10 },
  moonshot: { input: 1, output: 3 },
  zai: { input: 0.5, output: 1 },
  dashscope: { input: 0.4, output: 1.2 },
  minimax: { input: 0.3, output: 1.2 },
  perplexity: { input: 1, output: 3 },
  cohere: { input: 2.5, output: 7.5 },
  siliconflow: { input: 0.5, output: 0.5 },
  nebius: { input: 0.9, output: 0.9 },
  sambanova: { input: 0.6, output: 1.2 },
  novita: { input: 0.5, output: 0.5 },
};

/** Providers whose routes are free at the margin (keyless/free tiers). */
const FREE_PROVIDERS = new Set(["ovhcloud", "duckduckgo-web", "pollinations"]);
const FREE_MODEL = /(:free|\/free|^free|free)$/;

let overrides: Record<string, ModelPrice> = {};
export function setPriceOverrides(map: Record<string, ModelPrice>): void {
  overrides = { ...map };
}
export function getPriceOverrides(): Record<string, ModelPrice> {
  return { ...overrides };
}

export function priceInfo(providerId: string, model: string): PriceInfo | null {
  const o = overrides[`${providerId}:${model}`] ?? overrides[model];
  if (o) return { ...o, source: "override" };
  if (FREE_PROVIDERS.has(providerId)) return { input: 0, output: 0, source: "free" };
  if (FREE_MODEL.test(model)) return { input: 0, output: 0, source: "free" };
  const exact = PRICES[`${providerId}:${model}`];
  if (exact) return { ...exact, source: "exact" };
  const bare = model.toLowerCase();
  for (const p of MODEL_PATTERNS) {
    if (p.re.test(bare)) return { ...p.price, source: "model" };
  }
  const def = PROVIDER_DEFAULT[providerId];
  if (def) return { ...def, source: "provider" };
  return null;
}

export function getPrice(providerId: string, model: string): ModelPrice | null {
  const info = priceInfo(providerId, model);
  return info ? { input: info.input, output: info.output } : null;
}

/** USD cost for a completed request. Unknown pricing → 0 (never blocks). */
export function costUsd(
  providerId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = priceInfo(providerId, model);
  if (!p) return 0;
  const cost = (promptTokens * p.input + completionTokens * p.output) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000; // 6dp
}

/** The built-in table, for the dashboard Pricing tab. */
export function pricingCatalog(): {
  exact: Array<{ key: string; input: number; output: number }>;
  patterns: Array<{ label: string; input: number; output: number }>;
  providers: Array<{ key: string; input: number; output: number }>;
} {
  return {
    exact: Object.entries(PRICES).map(([key, p]) => ({ key, ...p })),
    patterns: MODEL_PATTERNS.map((p) => ({ label: p.label, ...p.price })),
    providers: Object.entries(PROVIDER_DEFAULT).map(([key, p]) => ({ key, ...p })),
  };
}
