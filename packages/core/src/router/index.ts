import { executeProvider, type ExecuteResult } from "../executor/http.js";
import { executeAntigravityChat } from "../executor/antigravity.js";
import { executeClaudeOAuthChat } from "../executor/claudeOAuth.js";
import { executeCodexOAuthChat } from "../executor/codexOAuth.js";
import { executeMuseCodeChat } from "../executor/museCode.js";
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
import { AccountPool, type AccountStrategy } from "../accounts/index.js";
import { orderAccounts } from "../accounts/selection.js";
import type { RoutingRule } from "../store/db.js";
import type {
  ChatCompletionRequest,
  ResolvedProvider,
} from "../providers/types.js";
import { CooldownTracker } from "../quota/limiter.js";
import { PromptCache } from "../cache/index.js";
import { QuotaTelemetry, type QuotaInfo } from "../quota/telemetry.js";
import { orderComboTargets, type RouterCombo } from "../combos/index.js";
import { autoTemplate, buildAutoTargets } from "../combos/autoCatalog.js";
import { buildEmulationPrompt, nativeTools, parseEmulatedToolCall } from "../tools/emulation.js";
import { SemanticCache } from "../cache/semantic.js";
import { classifyError, isRetryable } from "./errors.js";
import {
  clearStickyProvider,
  emptyStats,
  orderProviders,
  setStickyProvider,
  isStrategyName,
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
  /** internal: router-combo nesting depth (recursion guard) */
  comboDepth?: number;
  /** pin execution to one provider account (combo target account pin) */
  forceAccountId?: string;
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
  /** Multi-account hooks (strategy + stats + outcome recording). */
  accounts?: AccountHooks;
  /** Live routing rules (per-model provider chains). */
  routingRules?: () => RoutingRule[];
  /** Live router combos (OmniRoute-style virtual models). */
  combos?: () => RouterCombo[];
}

/** Multi-account plumbing supplied by the server (backed by the store). */
export interface AccountHooks {
  strategy: () => AccountStrategy;
  stats: (providerId: string) => Array<{ id: string; calls: number }>;
  record: (accountId: string, ok: boolean, error?: string) => void;
}

/** First enabled rule matching a bare (unpinned) model name, if any. */
export function matchRoutingRule(rules: RoutingRule[], model: string): RoutingRule | null {
  if (model === "auto" || model.includes(":")) return null;
  for (const r of rules) {
    if (!r.enabled || r.providers.length === 0) continue;
    if (r.pattern === model) return r;
    if (r.pattern.endsWith("*") && model.startsWith(r.pattern.slice(0, -1))) return r;
  }
  return null;
}

export interface Router {
  route(body: ChatCompletionRequest, opts?: RouteOptions): Promise<ExecuteResult>;
  stats: Map<string, ProviderStats>;
  /** per-provider account key pools (multi-account rotation) */
  pools: Map<string, AccountPool>;
  /** latest rate-limit telemetry per provider (from upstream headers) */
  quotaSnapshot: () => Map<string, QuotaInfo>;
}

const COOLDOWN_MS = 30_000;

/**
 * Dedicated (non-key-rotation) dispatch — OAuth/cookie/custom-transport
 * providers resolve their own credentials at call time. Returns null when
 * the provider uses the generic API-key path. `accountId` selects one DB
 * account's session file; null = the provider's default account.
 */
async function runDedicated(
  provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch,
  timeoutMs: number,
  accountId: string | null,
): Promise<ExecuteResult | null> {
  if (provider.id === "antigravity") {
    return executeAntigravityChat(provider, model, body, fetchFn, timeoutMs, process.env, "antigravity", accountId);
  }
  if (provider.id === "claude") {
    return executeClaudeOAuthChat(provider, model, body, fetchFn, timeoutMs, process.env, accountId);
  }
  if (provider.id === "codex") {
    return executeCodexOAuthChat(provider, model, body, fetchFn, timeoutMs, process.env, accountId);
  }
  if (provider.id === "muse-code") {
    return executeMuseCodeChat(provider, model, body, fetchFn, timeoutMs, process.env, accountId);
  }
  if (provider.id === "cursor") {
    return executeCursorChat(provider, model, body, fetchFn, timeoutMs, process.env, accountId);
  }
  if (provider.id === "kiro") {
    return executeKiroChat(provider, model, body, fetchFn, timeoutMs, process.env, accountId);
  }
  if (provider.id === "trae") {
    return executeTraeChat(provider, model, body, fetchFn, timeoutMs, process.env, accountId);
  }
  if (provider.id === "zed-hosted") {
    return executeZedHostedChat(provider, model, body, fetchFn, timeoutMs, process.env, accountId);
  }
  if (provider.id === "clinepass") {
    return executeClinepassChat(provider, model, body, fetchFn, timeoutMs, process.env, accountId);
  }
  if (P11I_OAUTH_IDS.has(provider.id)) {
    return executeOAuthProvider(provider, model, body, fetchFn, timeoutMs, process.env, accountId);
  }
  // Keyless custom transport: Duck.ai's VQD-session chat API (no auth header).
  if (provider.id === "duckduckgo-web") {
    return executeDuckDuckGoChat(provider, model, body, fetchFn, timeoutMs);
  }
  if (provider.id === "github" || provider.id === "ghe-copilot") {
    return executeCopilotChat(provider, model, body, fetchFn, timeoutMs, process.env, accountId);
  }
  // Cookie web-session providers (P11-J): per-site drivers in the
  // web-session pack resolve the imported browser cookies at call time.
  if (WEBCHAT_PROVIDER_IDS.has(provider.id)) {
    return executeWebChatChat(provider, model, body, fetchFn, timeoutMs, process.env, accountId);
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
  return null;
}

/**
 * Execute against one provider, rotating through its accounts.
 * API keys: the pool rotates on 401/403/429 (60s cooldown), ordered by
 * the account strategy. Session providers with DB accounts: each account
 * is tried in strategy order on auth/rate-limit failures, with the
 * default account as the final fallback. The serving account id rides
 * back on the result for usage attribution.
 */
async function executeWithRotation(
  pool: AccountPool,
  provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch,
  timeoutMs: number,
  hooks?: AccountHooks,
  forceAccountId?: string,
): Promise<ExecuteResult> {
  const accountStrategy = hooks?.strategy() ?? "round-robin";
  const sessionAccounts = (provider.accounts ?? []).filter((a) => a.kind === "session");
  if (forceAccountId && sessionAccounts.some((a) => a.id === forceAccountId)) {
    // Pinned session account: try ONLY that account; its failure is final
    // for this provider so combo fall-through can move to the next target.
    try {
      const r = await runDedicated(provider, model, body, fetchFn, timeoutMs, forceAccountId);
      if (r !== null) {
        hooks?.record(forceAccountId, true);
        return { ...r, accountId: forceAccountId };
      }
    } catch (err) {
      const kind = classifyError(err);
      if (kind === "auth_error" || kind === "rate_limited") {
        hooks?.record(forceAccountId, false, err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
  }
  if (sessionAccounts.length > 0) {
    const counts = new Map((hooks?.stats(provider.id) ?? []).map((x) => [x.id, x.calls]));
    const ordered = orderAccounts(
      provider.id,
      sessionAccounts.map((a) => ({ id: a.id, calls: counts.get(a.id) ?? 0 })),
      accountStrategy,
    ).map((a) => a.id);
    const candidates: Array<string | null> = [...ordered, null];
    let lastErr: unknown = null;
    let dedicated = false;
    for (const acct of candidates) {
      try {
        const r = await runDedicated(provider, model, body, fetchFn, timeoutMs, acct);
        if (r === null) break; // generic key provider — session rows don't apply
        dedicated = true;
        if (acct) hooks?.record(acct, true);
        return { ...r, accountId: acct };
      } catch (err) {
        dedicated = true;
        lastErr = err;
        const kind = classifyError(err);
        if (acct && (kind === "auth_error" || kind === "rate_limited")) {
          hooks?.record(acct, false, err instanceof Error ? err.message : String(err));
        }
        if (kind === "auth_error" || kind === "rate_limited") continue; // next account
        throw err;
      }
    }
    if (dedicated) throw lastErr ?? new Error("all provider accounts failed");
  } else {
    const r = await runDedicated(provider, model, body, fetchFn, timeoutMs, null);
    if (r !== null) return { ...r, accountId: null };
  }

  const tried = new Set<string>();
  // Pinned API-key account: pre-exclude every other key in the pool.
  if (forceAccountId && provider.keyAccounts) {
    const pinnedKey = [...provider.keyAccounts.entries()].find(
      ([, acct]) => acct === forceAccountId,
    )?.[0];
    if (pinnedKey !== undefined) {
      for (const k of provider.allKeys ?? [provider.apiKey]) {
        if (k !== pinnedKey) tried.add(k);
      }
    }
  }
  let lastErr: unknown = null;
  for (;;) {
    const key = pool.next(tried, Date.now(), accountStrategy);
    // NB: null-check, not falsiness — keyless/noAuth providers legitimately
    // carry the empty-string key ("") as their single pool slot.
    if (key === null) break;
    tried.add(key);
    const keyed = key === provider.apiKey ? provider : { ...provider, apiKey: key };
    const acctId = provider.keyAccounts?.get(key) ?? null;
    try {
      const result = await executeProvider(keyed, model, body, fetchFn, timeoutMs);
      pool.reportSuccess(key);
      if (acctId) hooks?.record(acctId, true);
      return { ...result, accountId: acctId };
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);
      if (kind === "auth_error" || kind === "rate_limited") {
        if (acctId) hooks?.record(acctId, false, err instanceof Error ? err.message : String(err));
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
  const poolSigs = new Map<string, string>();
  const accountHooks = opts.accounts;
  const routingRulesFn = opts.routingRules;
  const combosFn = opts.combos;
  const comboCursors = new Map<string, number>();
  const comboWinners = new Map<string, string>();

  function record(id: string, latencyMs: number, failed: boolean): void {
    const s = stats.get(id) ?? emptyStats();
    s.calls += 1;
    s.totalLatencyMs += latencyMs;
    if (failed) s.errors += 1;
    stats.set(id, s);
  }

  /** OmniRoute-style "provider/model" target refs → our "provider:model". */
  function normalizeTargetModel(model: string): string {
    if (model.includes(":")) return model;
    const slash = model.indexOf("/");
    if (slash > 0) {
      const prefix = model.slice(0, slash);
      if (providers.some((p) => p.id === prefix)) {
        return `${prefix}:${model.slice(slash + 1)}`;
      }
    }
    return model;
  }

  function comboBody(combo: RouterCombo, body: ChatCompletionRequest): ChatCompletionRequest {
    const prompt = combo.config?.systemPrompt;
    if (!prompt) return body;
    const messages = [...body.messages];
    const sysIdx = messages.findIndex((m) => m.role === "system");
    if (sysIdx >= 0) {
      messages[sysIdx] = { ...messages[sysIdx]!, content: prompt };
    } else {
      messages.unshift({ role: "system", content: prompt });
    }
    return { ...body, messages };
  }

  /** Response validation (OmniRoute advanced setting): a 200 reply that
   *  fails the checks counts as a target failure → fall through. */
  function comboValidationError(combo: RouterCombo, result: ExecuteResult): string | null {
    const v = combo.config?.validation;
    if (!v || !result.response) return null;
    const content = result.response.choices?.[0]?.message?.content ?? "";
    for (const f of v.forbidden ?? []) {
      if (content.includes(f)) return `validation: reply contains forbidden text "${f}"`;
    }
    for (const r of v.required ?? []) {
      if (!content.includes(r)) return `validation: reply is missing required text "${r}"`;
    }
    if (v.minLength != null && content.length < v.minLength) {
      return `validation: reply too short (${content.length} < ${v.minLength} chars)`;
    }
    return null;
  }

  async function runRouterCombo(
    combo: RouterCombo,
    body: ChatCompletionRequest,
    opts: RouteOptions,
  ): Promise<ExecuteResult> {
    const cursor = comboCursors.get(combo.name) ?? 0;
    if (combo.strategy === "round-robin") comboCursors.set(combo.name, cursor + 1);
    const providerOf = (model: string) => {
      const m = normalizeTargetModel(model);
      if (m.includes(":")) return m.split(":")[0]!;
      return providers.find((p) => p.models.includes(m))?.id ?? "";
    };
    let targets = combo.targets;
    // context-relay: lead with the last target that answered for this combo.
    if (combo.strategy === "context-relay") {
      const winner = comboWinners.get(combo.name);
      if (winner) {
        const idx = targets.findIndex((t) => t.model === winner);
        if (idx > 0) targets = [targets[idx]!, ...targets.filter((_, i) => i !== idx)];
      }
    }
    const ordered = orderComboTargets(combo.strategy, targets, {
      providerCalls: (pid) => stats.get(pid)?.calls ?? 0,
      providerOf,
      providerTier: (model) => {
        const pid = providerOf(model);
        return providers.find((p) => p.id === pid)?.costTier ?? 3;
      },
      quotaShare: (model) => telemetry.share(providerOf(model)),
      cursor,
    });
    const effectiveBody = comboBody(combo, body);
    const tried: string[] = [];
    let lastError: unknown = null;
    for (const t of ordered) {
      tried.push(t.model);
      try {
        const result = await route(
          { ...effectiveBody, model: normalizeTargetModel(t.model) },
          {
            ...opts,
            comboDepth: (opts.comboDepth ?? 0) + 1,
            forceAccountId: t.accountId ?? undefined,
          },
        );
        const vErr = comboValidationError(combo, result);
        if (vErr) {
          lastError = new Error(vErr);
          continue; // fall through to the next target
        }
        comboWinners.set(combo.name, t.model);
        return result;
      } catch (err) {
        lastError = err; // combos fall through on ANY target failure
      }
    }
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`combo "${combo.name}": all targets failed (tried: ${tried.join(", ")}): ${msg}`);
  }

  async function route(body: ChatCompletionRequest, opts: RouteOptions = {}): Promise<ExecuteResult> {
    const strategy = opts.strategy ?? "priority";
    const fetchFn = opts.fetchFn ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 120_000;

    // Router combos (virtual models) intercept before normal resolution.
    if ((opts.comboDepth ?? 0) < 3 && body.model !== "auto") {
      const combo = combosFn?.().find((c) => c.name === body.model && c.enabled !== false);
      if (combo) return runRouterCombo(combo, body, opts);
      // Built-in auto/* catalog: synthesize a weighted combo on the fly
      // from the connected providers (zero setup, OmniRoute-style).
      if (body.model.startsWith("auto/")) {
        const template = autoTemplate(body.model);
        if (template) {
          const targets = buildAutoTargets(template, providers);
          if (targets.length > 0) {
            return runRouterCombo(
              {
                name: template.id,
                kind: "router",
                strategy: "weighted",
                targets,
                config: { systemPrompt: template.systemPrompt },
                createdAt: 0,
              },
              body,
              opts,
            );
          }
        }
      }
    }

    let target = resolveTarget(providers, body.model, strategy, stats);

    let ordered: ResolvedProvider[];
    // Routing rules: a matching rule restricts the chain to its providers
    // (rule order, or the rule's own strategy when one is set).
    const rule = routingRulesFn ? matchRoutingRule(routingRulesFn(), body.model) : null;
    const ruleChain = rule
      ? rule.providers
          .map((id) => providers.find((p) => p.id === id))
          .filter((p): p is ResolvedProvider => !!p)
      : [];
    if (rule && ruleChain.length > 0) {
      const serving = ruleChain.find((p) => p.models.includes(body.model));
      target = serving
        ? { provider: serving, model: body.model }
        : { provider: ruleChain[0]!, model: ruleChain[0]!.defaultModel };
      ordered =
        isStrategyName(rule.strategy) && rule.strategy !== "priority"
          ? orderProviders(ruleChain, rule.strategy, {
              stats,
              cooling: cooldown.coolingIds(),
              affinity,
              sessionId: opts.sessionId,
              quota: telemetry.snapshot(),
            })
          : ruleChain;
    } else if (body.model === "auto" && strategy === "auto") {
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
        // Pools are rebuilt when the provider's key set changes (accounts
        // added/removed at runtime) — the map alone would go stale.
        let pool = pools.get(provider.id);
        const sig = (provider.allKeys ?? [provider.apiKey]).join("\u0001");
        if (!pool || poolSigs.get(provider.id) !== sig) {
          pool = new AccountPool(provider.allKeys ?? [provider.apiKey]);
          pools.set(provider.id, pool);
          poolSigs.set(provider.id, sig);
        }
        const result = await executeWithRotation(pool, provider, model, attemptBody, fetchFn, timeoutMs, accountHooks, opts.forceAccountId);
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

  return { route, stats, pools, quotaSnapshot: () => telemetry.snapshot() };
}
