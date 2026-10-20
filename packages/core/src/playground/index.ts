import type {
  ChatCompletionRequest,
  ResolvedProvider,
} from "../providers/types.js";
import type { ExecuteResult } from "../executor/http.js";
import type { RouteOptions } from "../router/index.js";

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

/** The slice of the Router the fan-out needs (structural — testable). */
export interface FanoutRouter {
  route(body: ChatCompletionRequest, opts?: RouteOptions): Promise<ExecuteResult>;
}

/**
 * Fan-out: run the same prompt against N providers in parallel and collect
 * results. Powers the playground compare.
 *
 * IMPORTANT: this goes through the real ROUTER with a pinned
 * `provider:model`, not the generic executor — dedicated-executor
 * providers (Antigravity, DuckDuckGo, Copilot, cookie web-chat…) only
 * dispatch correctly through the router. The generic path made compare
 * fail for exactly those providers while their Test buttons worked.
 * A silent fallback to another provider counts as a failure for the
 * provider that was asked for.
 */
export async function fanout(
  providers: ResolvedProvider[],
  body: ChatCompletionRequest,
  router: FanoutRouter,
  timeoutMs = 120_000,
): Promise<FanoutResult[]> {
  const jobs = providers.map(async (p): Promise<FanoutResult> => {
    const started = Date.now();
    try {
      const result = await router.route(
        { ...body, model: `${p.id}:${p.defaultModel}`, stream: false },
        { strategy: "priority", bypassCache: true, timeoutMs },
      );
      const latencyMs = Date.now() - started;
      if (result.providerId !== p.id) {
        return {
          providerId: p.id,
          model: p.defaultModel,
          ok: false,
          error: `provider ${p.id} failed — request fell back to ${result.providerId}`,
          latencyMs,
        };
      }
      const text = result.response?.choices[0]?.message.content ?? "";
      return {
        providerId: p.id,
        model: p.defaultModel,
        ok: true,
        text,
        latencyMs,
        promptTokens: result.response?.usage.prompt_tokens,
        completionTokens: result.response?.usage.completion_tokens,
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
