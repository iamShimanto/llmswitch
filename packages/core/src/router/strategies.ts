import { randomInt } from "node:crypto";
import type { ResolvedProvider } from "../providers/types.js";
import type { QuotaInfo } from "../quota/telemetry.js";

/** All 20 routing strategies (OmniRoute parity). */
export const STRATEGY_NAMES = [
  "priority",
  "weighted",
  "round-robin",
  "context-relay",
  "fill-first",
  "p2c",
  "random",
  "least-used",
  "cost-optimized",
  "reset-aware",
  "reset-window",
  "headroom",
  "quota-weighted",
  "strict-random",
  "auto",
  "lkgp",
  "context-optimized",
  "cache-optimized",
  "fusion",
  "pipeline",
] as const;

export type StrategyName = (typeof STRATEGY_NAMES)[number];

export function isStrategyName(v: unknown): v is StrategyName {
  return typeof v === "string" && (STRATEGY_NAMES as readonly string[]).includes(v);
}

/** Live stats used by stateful strategies. */
export interface ProviderStats {
  calls: number;
  errors: number;
  totalLatencyMs: number;
}

export const emptyStats = (): ProviderStats => ({ calls: 0, errors: 0, totalLatencyMs: 0 });

/** Extra context for data-driven strategies. */
export interface OrderContext {
  stats?: Map<string, ProviderStats>;
  /** provider ids currently cooling down (recent failures) */
  cooling?: Set<string>;
  /** sessionId -> providerId affinity map */
  affinity?: Map<string, string>;
  sessionId?: string;
  /** live quota telemetry (provider id -> quota info) */
  quota?: Map<string, QuotaInfo>;
}

let rrCursor = 0;
export function resetRoundRobin(): void {
  rrCursor = 0;
}

/** fill-first stickiness: keep using the last-good provider until it fails. */
let stickyProviderId: string | null = null;
export function setStickyProvider(id: string): void {
  stickyProviderId = id;
}
export function clearStickyProvider(id?: string): void {
  if (!id || stickyProviderId === id) stickyProviderId = null;
}
export function resetSticky(): void {
  stickyProviderId = null;
}

function shuffle<T>(list: T[], strong = false): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = strong ? randomInt(i + 1) : Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function successRate(s: ProviderStats): number {
  if (s.calls === 0) return 1;
  return (s.calls - s.errors) / s.calls;
}

/**
 * Order providers for an attempt. Never mutates the input.
 * Third arg accepts a legacy stats Map or an OrderContext.
 * "auto" is resolved by the router (task-aware); here it behaves as priority.
 */
export function orderProviders(
  providers: ResolvedProvider[],
  strategy: StrategyName,
  ctxOrStats: Map<string, ProviderStats> | OrderContext = new Map(),
): ResolvedProvider[] {
  const ctx: OrderContext =
    ctxOrStats instanceof Map ? { stats: ctxOrStats } : ctxOrStats;
  const stats = ctx.stats ?? new Map();
  const get = (id: string): ProviderStats => stats.get(id) ?? emptyStats();
  const list = [...providers];
  if (list.length === 0) return list;

  switch (strategy) {
    case "priority":
    case "pipeline": // explicit sequential chain == priority order
    case "auto": // resolved by task-aware router; safe default here
      return list;

    case "round-robin": {
      const start = rrCursor % list.length;
      rrCursor += 1;
      return [...list.slice(start), ...list.slice(0, start)];
    }

    case "random":
      return shuffle(list);

    case "strict-random":
      return shuffle(list, true);

    case "weighted": {
      const total = list.reduce((s, p) => s + (p.weight ?? 1), 0);
      let r = Math.random() * total;
      for (const p of list) {
        r -= p.weight ?? 1;
        if (r <= 0) {
          const rest = list.filter((x) => x.id !== p.id);
          return [p, ...orderProviders(rest, "weighted", ctx)];
        }
      }
      return list;
    }

    case "least-used":
      return list.sort((a, b) => get(a.id).calls - get(b.id).calls);

    case "cost-optimized":
    case "fusion": // fusion = escalate cheap → strong via fallback chain
      return list.sort((a, b) => a.costTier - b.costTier || get(a.id).calls - get(b.id).calls);

    case "p2c": {
      // power of two choices: sample 2, take the least-used
      if (list.length < 2) return list;
      const i = Math.floor(Math.random() * list.length);
      let j = Math.floor(Math.random() * list.length);
      if (j === i) j = (j + 1) % list.length;
      const [x, y] = [list[i]!, list[j]!];
      const first = get(x.id).calls <= get(y.id).calls ? x : y;
      const second = first === x ? y : x;
      return [first, second, ...list.filter((p) => p.id !== x.id && p.id !== y.id)];
    }

    case "fill-first": {
      // stick to the last-good provider until it fails
      if (stickyProviderId) {
        const sticky = list.find((p) => p.id === stickyProviderId);
        if (sticky && !ctx.cooling?.has(sticky.id)) {
          return [sticky, ...list.filter((p) => p.id !== sticky.id)];
        }
      }
      return list;
    }

    case "lkgp": // least errors
      return list.sort((a, b) => get(a.id).errors - get(b.id).errors);

    case "headroom": // best success rate first
      return list.sort((a, b) => successRate(get(b.id)) - successRate(get(a.id)));

    case "quota-weighted": {
      // Weight by live quota share when telemetry exists, else by health.
      const quota = ctx.quota ?? new Map<string, QuotaInfo>();
      const weightOf = (p: ResolvedProvider): number => {
        const q = quota.get(p.id);
        if (q && q.remaining != null && q.limit != null && q.limit > 0) {
          return Math.max(0.01, q.remaining / q.limit);
        }
        return 1 / (1 + get(p.id).errors);
      };
      const scored = list.map((p) => ({ p, w: weightOf(p) }));
      const total = scored.reduce((s, x) => s + x.w, 0);
      let r = Math.random() * total;
      for (const { p, w } of scored) {
        r -= w;
        if (r <= 0) {
          const rest = list.filter((x) => x.id !== p.id);
          return [p, ...orderProviders(rest, "quota-weighted", ctx)];
        }
      }
      return list;
    }

    case "reset-aware": {
      // providers in cooldown go last (their quota window is presumably resetting)
      const cooling = ctx.cooling ?? new Set<string>();
      const fresh = list.filter((p) => !cooling.has(p.id));
      const stale = list.filter((p) => cooling.has(p.id));
      return [...fresh, ...stale];
    }

    case "reset-window": {
      // Providers closest to quota exhaustion go last; unknown quota keeps
      // config order (stable, documented degradation).
      const quota = ctx.quota ?? new Map<string, QuotaInfo>();
      const shareOf = (p: ResolvedProvider): number | null => {
        const q = quota.get(p.id);
        if (q && q.remaining != null && q.limit != null && q.limit > 0) {
          return q.remaining / q.limit;
        }
        return null;
      };
      const known = list.filter((p) => shareOf(p) != null);
      if (known.length === 0) return list;
      const unknown = list.filter((p) => shareOf(p) == null);
      known.sort((a, b) => shareOf(b)! - shareOf(a)!);
      return [...known, ...unknown];
    }

    case "context-relay": {
      // continue a conversation on the provider that served its last turn
      if (ctx.sessionId && ctx.affinity) {
        const id = ctx.affinity.get(ctx.sessionId);
        const hit = id ? list.find((p) => p.id === id) : undefined;
        if (hit) return [hit, ...list.filter((p) => p.id !== hit.id)];
      }
      return list;
    }

    case "context-optimized":
      return list.sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));

    case "cache-optimized":
      return list.sort(
        (a, b) =>
          Number(b.supportsPromptCache ?? false) - Number(a.supportsPromptCache ?? false) ||
          get(a.id).calls - get(b.id).calls,
      );

    default:
      return list;
  }
}
