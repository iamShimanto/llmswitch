/**
 * Approximate public pricing in USD per 1M tokens.
 * ESTIMATES — verify against provider pricing pages; auto-discovery (P1)
 * will refresh these from live data where providers publish it.
 */
export interface ModelPrice {
  input: number;
  output: number;
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

export function getPrice(providerId: string, model: string): ModelPrice | null {
  return PRICES[`${providerId}:${model}`] ?? PROVIDER_DEFAULT[providerId] ?? null;
}

/** USD cost for a completed request. Unknown pricing → 0 (never blocks). */
export function costUsd(
  providerId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = getPrice(providerId, model);
  if (!p) return 0;
  const cost = (promptTokens * p.input + completionTokens * p.output) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000; // 6dp
}
