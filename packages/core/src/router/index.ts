import { executeProvider, type ExecuteResult } from "../executor/http.js";
import { executeAntigravityChat } from "../executor/antigravity.js";
import { executeClaudeOAuthChat } from "../executor/claudeOAuth.js";
import { executeCodexOAuthChat } from "../executor/codexOAuth.js";
import { executeCursorChat } from "../executor/cursor.js";
import { executeCopilotChat } from "../executor/copilot.js";
import { executeKiroChat } from "../executor/kiro.js";
import { executeTraeChat } from "../executor/trae.js";
import { executeZedHostedChat } from "../executor/zedHosted.js";
import { executeClinepassChat } from "../executor/clinepass.js";
import { executeDuckDuckGoChat } from "../executor/duckduckgo.js";
import { executeOAuthProvider, P11I_OAUTH_IDS } from "../oauth/dispatch.js";
import { executeBedrockChat } from "../executor/bedrock.js";
import { executeVertexChat } from "../executor/vertex.js";
import { executePromptQlChat } from "../executor/promptql.js";
import { executeWebChatChat, WEBCHAT_PROVIDER_IDS } from "../executor/webchat.js";
import { AccountPool } from "../accounts/index.js";
import type {
  ChatCompletionRequest,
  ResolvedProvider,
} from "../providers/types.js";
import { CooldownTracker } from "../quota/limiter.js";
import { PromptCache } from "../cache/index.js";
import { QuotaTelemetry } from "../quota/telemetry.js";
import { buildEmulationPrompt, nativeTools, parseEmulatedToolCall } from "../tools/emulation.js";
import { SemanticCache } from "../cache/semantic.js";
import { classifyError, isRetryable } from "./errors.js";
import {
  clearStickyProvider,
  emptyStats,
  orderProviders,
  setStickyProvider,
  type ProviderStats,
  type StrategyName,
} from "./strategies.js";
import { taskAwareOrder } from "./taskAware.js";

export interface RouteOptions {
  strategy?: StrategyName;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  /** conversation id for context-relay affinity (x-llmswitch-session) */
  sessionId?: string;
  /** hook for alerts/metrics */
  onEvent?: (e: RouterEvent) => void;
  /** bypass prompt cache for this request */
  bypassCache?: boolean;
}

export type RouterEvent =
  | { type: "provider_failed"; providerId: string; kind: string; consecutiveFailures: number }
  | { type: "provider_recovered"; providerId: string };

export interface ResolvedTarget {
  provider: ResolvedProvider;
  model: string;
}

/** Resolve "auto" / "provider:model" / "model-id" against connected providers. */
export function resolveTarget(
  providers: ResolvedProvider[],
  model: string,
  strategy: StrategyName,
  stats: Map<string, ProviderStats>,
): ResolvedTarget {
  if (providers.length === 0) throw new Error("no providers connected");
  if (model === "auto") {
    const [first] =
      strategy === "auto"
        ? taskAwareOrder(providers, { model, messages: [] }, stats).order
        : orderProviders(providers, strategy, stats);
    return { provider: first!, model: first!.defaultModel };
  }
  const [maybeProvider, ...rest] = model.split(":");
  const byId = providers.find((p) => p.id === maybeProvider);
  if (byId && rest.length > 0) {
    return { provider: byId, model: rest.join(":") };
  }
  const byModel = providers.find((p) => p.models.includes(model));
  if (byModel) return { provider: byModel, model };
  // last resort: first provider by strategy, passing the raw model through
  const [first] = orderProviders(providers, strategy === "auto" ? "priority" : strategy, stats);
  return { provider: first!, model };
}

export interface RouterOptions {
  cache?: PromptCache;
  semantic?: SemanticCache;
}

export interface Router {
  route(body: ChatCompletionRequest, opts?: RouteOptions): Promise<ExecuteResult>;
  stats: Map<string, ProviderStats>;
  /** per-provider account key pools (multi-account rotation) */
  pools: Map<string, AccountPool>;
}

const COOLDOWN_MS = 30_000;

/**
 * Execute against one provider, rotating through its account keys.
 * On 401/403/429 the offending key is cooled for 60s and the next key is
 * tried; other errors throw immediately so the chain moves to the next
 * provider as before. Single-key providers behave exactly as before.
 */
async function executeWithRotation(
  pool: AccountPool,
  provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<ExecuteResult> {
  // OAuth/custom-transport providers resolve their own credentials at call
  // time (sessions, refresh flows) instead of key rotation.
  if (provider.id === "antigravity") {    return executeAntigravityChat(provider, model, body, fetchFn, timeoutMs);
  }
  if (provider.id === "claude") {
    return executeClaudeOAuthChat(provider, model, body, fetchFn, timeoutMs);
  }
  if (provider.id === "codex") {
    return executeCodexOAuthChat(provider, model, body, fetchFn, timeoutMs);
  }
  if (provider.id === "cursor") {
    return executeCursorChat(provider, model, body, fetchFn, timeoutMs);
  }
  if (provider.id === "kiro") {
    return executeKiroChat(provider, model, body, fetchFn, timeoutMs);
  }
  if (provider.id === "trae") {
    return executeTraeChat(provider, model, body, fetchFn, timeoutMs);
  }
  if (provider.id === "zed-hosted") {
    return executeZedHostedChat(provider, model, body, fetchFn, timeoutMs);
  }
  if (provider.id === "clinepass") {
    return executeClinepassChat(provider, model, body, fetchFn, timeoutMs);
  }
  if (P11I_OAUTH_IDS.has(provider.id)) {
    return executeOAuthProvider(provider, model, body, fetchFn, timeoutMs);
  }
  // Keyless custom transport: Duck.ai's VQD-session chat API (no auth header).
  if (provider.id === "duckduckgo-web") {
    return executeDuckDuckGoChat(provider, model, body, fetchFn, timeoutMs);
  }
  if (provider.id === "github" || provider.id === "ghe-copilot") {
    return executeCopilotChat(provider, model, body, fetchFn, timeoutMs);
  }
  // Cookie web-session providers (P11-J): per-site drivers in the
  // web-session pack resolve the imported browser cookies at call time.
  if (WEBCHAT_PROVIDER_IDS.has(provider.id)) {
    return executeWebChatChat(provider, model, body, fetchFn, timeoutMs);
  }
  // Special-auth providers (P11-K): per-request env-credential resolution
  // (SigV4 / service-account JWT / pasted session JWT), not key rotation.
  if (provider.id === "bedrock") {
    return executeBedrockChat(provider, model, body, fetchFn, timeoutMs);
  }
  if (provider.id === "vertex") {
    return executeVertexChat(provider, model, body, fetchFn, timeoutMs);
  }
  if (provider.id === "promptql") {
    return executePromptQlChat(provider, model, body, fetchFn, timeoutMs);
  }
  const tried = new Set<string>();
  let lastErr: unknown = null;
  for (;;) {
    const key = pool.next(tried);
    // NB: null-check, not falsiness — keyless/noAuth providers legitimately
    // carry the empty-string key ("") as their single pool slot.
    if (key === null) break;
    tried.add(key);
    const keyed = key === provider.apiKey ? provider : { ...provider, apiKey: key };
    try {
      const result = await executeProvider(keyed, model, body, fetchFn, timeoutMs);
      pool.reportSuccess(key);
      return result;
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);
      if (kind === "auth_error" || kind === "rate_limited") {
        pool.reportFailure(key);
        continue; // try the next key
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("no healthy account keys");
}

/** Create a stateful router over a fixed provider list. */
export function createRouter(providers: ResolvedProvider[], opts: RouterOptions = {}): Router {
  const stats = new Map<string, ProviderStats>();
  const cooldown = new CooldownTracker();
  const affinity = new Map<string, string>();
  const consecutiveFailures = new Map<string, number>();
  const telemetry = new QuotaTelemetry();
  const cache = opts.cache;
  const semantic = opts.semantic;
  const pools = new Map<string, AccountPool>(
    providers.map((p) => [p.id, new AccountPool(p.allKeys ?? [p.apiKey])]),
  );

  function record(id: string, latencyMs: number, failed: boolean): void {
    const s = stats.get(id) ?? emptyStats();
    s.calls += 1;
    s.totalLatencyMs += latencyMs;
    if (failed) s.errors += 1;
    stats.set(id, s);
  }

  async function route(body: ChatCompletionRequest, opts: RouteOptions = {}): Promise<ExecuteResult> {
    const strategy = opts.strategy ?? "priority";
    const fetchFn = opts.fetchFn ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 120_000;

    const target = resolveTarget(providers, body.model, strategy, stats);

    let ordered: ResolvedProvider[];
    if (body.model === "auto" && strategy === "auto") {
      ordered = taskAwareOrder(providers, body, stats).order;
    } else if (body.model === "auto") {
      ordered = orderProviders(providers, strategy, {
        stats,
        cooling: cooldown.coolingIds(),
        affinity,
        sessionId: opts.sessionId,
        quota: telemetry.snapshot(),
      });
    } else {
      ordered = [
        target.provider,
        ...orderProviders(
          providers.filter(
            (p) => p.id !== target.provider.id && p.models.includes(target.model),
          ),
          strategy === "auto" ? "priority" : strategy,
          stats,
        ),
      ];
    }

    // Don't send "auto" traffic to cooling providers unless everything is cooling.
    let chain = ordered;
    if (body.model === "auto") {
      const fresh = ordered.filter((p) => !cooldown.isCooling(p.id));
      if (fresh.length > 0) chain = fresh;
    }

    const attempted: string[] = [];
    let lastError: unknown = null;

    for (const provider of chain) {
      attempted.push(provider.id);
      const model = provider.id === target.provider.id ? target.model : provider.defaultModel;
      const started = Date.now();

      // tool-call emulation for wire formats without native tool support
      const emulate =
        (body.tools?.length ?? 0) > 0 && !nativeTools(provider.wireFormat) && body.stream !== true;
      const attemptBody: ChatCompletionRequest = emulate
        ? {
            ...body,
            tools: undefined,
            tool_choice: undefined,
            messages: [
              { role: "system" as const, content: buildEmulationPrompt(body.tools!) },
              ...body.messages,
            ],
          }
        : body;

      // caching (non-streaming only)
      const useCache = body.stream !== true && !opts.bypassCache;
      if (useCache && cache) {
        const key = cache.key(provider.id, model, attemptBody);
        const hit = cache.get(key);
        if (hit) {
          record(provider.id, Date.now() - started, false);
          return { response: hit, providerId: provider.id, model, latencyMs: 0, cached: true };
        }
      }
      // semantic cache: paraphrase match (opt-in, independent of exact cache)
      if (useCache && semantic) {
        const sem = await semantic.find(SemanticCache.promptText(attemptBody.messages));
        if (sem) {
          record(provider.id, Date.now() - started, false);
          return { response: sem.response, providerId: provider.id, model, latencyMs: 0, cached: true };
        }
      }

      try {
        const pool = pools.get(provider.id) ?? new AccountPool([provider.apiKey]);
        const result = await executeWithRotation(pool, provider, model, attemptBody, fetchFn, timeoutMs);
        if (emulate && result.response) {
          const tc = parseEmulatedToolCall(result.response.choices[0]?.message.content ?? "");
          if (tc) {
            result.response.choices[0]!.message.tool_calls = [tc];
            result.response.choices[0]!.finish_reason = "tool_calls";
          }
        }
        record(provider.id, Date.now() - started, false);
        consecutiveFailures.set(provider.id, 0);
        if (result.quota) telemetry.record(provider.id, result.quota);
        if (opts.sessionId) affinity.set(opts.sessionId, provider.id);
        if (strategy === "fill-first") setStickyProvider(provider.id);
        // store non-streaming successes in caches
        if (body.stream !== true && !opts.bypassCache && result.response) {
          if (cache) cache.set(cache.key(provider.id, model, attemptBody), result.response);
          if (semantic) {
            void semantic.add(SemanticCache.promptText(attemptBody.messages), result.response);
          }
        }
        return result;
      } catch (err) {
        record(provider.id, Date.now() - started, true);
        lastError = err;
        const kind = classifyError(err);
        if (isRetryable(kind)) {
          cooldown.cool(provider.id, COOLDOWN_MS);
          const n = (consecutiveFailures.get(provider.id) ?? 0) + 1;
          consecutiveFailures.set(provider.id, n);
          opts.onEvent?.({ type: "provider_failed", providerId: provider.id, kind, consecutiveFailures: n });
        }
        if (strategy === "fill-first") clearStickyProvider(provider.id);
        if (!isRetryable(kind)) break; // auth/bad-request: stop immediately
      }
    }

    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`all providers failed (tried: ${attempted.join(", ")}): ${msg}`);
  }

  return { route, stats, pools };
}
