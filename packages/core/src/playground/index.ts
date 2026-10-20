import { executeProvider } from "../executor/http.js";
import type {
  ChatCompletionRequest,
  ResolvedProvider,
} from "../providers/types.js";

export interface FanoutResult {
  providerId: string;
  model: string;
  ok: boolean;
  text?: string;
  error?: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Fan-out: run the same prompt against N providers in parallel and collect
 * results. Powers the playground and (P2) multi-model compare.
 */
export async function fanout(
  providers: ResolvedProvider[],
  body: ChatCompletionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 120_000,
): Promise<FanoutResult[]> {
  const jobs = providers.map(async (p): Promise<FanoutResult> => {
    const started = Date.now();
    try {
      const r = await executeProvider(p, p.defaultModel, { ...body, stream: false }, fetchFn, timeoutMs);
      const text = r.response!.choices[0]?.message.content ?? "";
      return {
        providerId: p.id,
        model: p.defaultModel,
        ok: true,
        text,
        latencyMs: Date.now() - started,
        promptTokens: r.response!.usage.prompt_tokens,
        completionTokens: r.response!.usage.completion_tokens,
      };
    } catch (err) {
      return {
        providerId: p.id,
        model: p.defaultModel,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
      };
    }
  });
  return Promise.all(jobs);
}
