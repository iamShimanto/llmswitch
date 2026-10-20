/** Live quota telemetry from upstream rate-limit headers. */

export interface QuotaInfo {
  /** requests remaining in the current window (when advertised) */
  remaining: number | null;
  /** window size (when advertised) */
  limit: number | null;
  /** unix ms when the window resets (when advertised) */
  resetAt: number | null;
  updatedAt: number;
}

const HEADER_ALIASES: Record<string, string[]> = {
  remaining: ["x-ratelimit-remaining", "ratelimit-remaining", "x-rate-limit-remaining"],
  limit: ["x-ratelimit-limit", "ratelimit-limit", "x-rate-limit-limit"],
  reset: ["x-ratelimit-reset", "ratelimit-reset", "x-rate-limit-reset", "retry-after"],
};

function num(headers: Headers, names: string[]): number | null {
  for (const n of names) {
    const v = headers.get(n);
    if (v != null && v !== "") {
      const x = Number(v);
      if (!Number.isNaN(x)) return x;
    }
  }
  return null;
}

/** Parse standard rate-limit headers (OpenAI, Anthropic, Groq, …). */
export function parseQuotaHeaders(headers: Headers, now = Date.now()): QuotaInfo | null {
  const remaining = num(headers, HEADER_ALIASES.remaining);
  const limit = num(headers, HEADER_ALIASES.limit);
  let resetAt: number | null = null;
  const reset = num(headers, HEADER_ALIASES.reset);
  if (reset != null) {
    // reset may be epoch seconds or seconds-until-reset; disambiguate by magnitude
    resetAt = reset > 1e12 ? reset : reset > 1e9 ? reset * 1000 : now + reset * 1000;
  }
  if (remaining == null && limit == null && resetAt == null) return null;
  return { remaining, limit, resetAt, updatedAt: now };
}

export class QuotaTelemetry {
  private map = new Map<string, QuotaInfo>();

  record(providerId: string, info: QuotaInfo): void {
    this.map.set(providerId, info);
  }

  get(providerId: string): QuotaInfo | undefined {
    return this.map.get(providerId);
  }

  snapshot(): Map<string, QuotaInfo> {
    return new Map(this.map);
  }

  /** share of remaining quota 0..1 (null when unknown) */
  share(providerId: string): number | null {
    const q = this.map.get(providerId);
    if (!q || q.remaining == null || q.limit == null || q.limit <= 0) return null;
    return Math.max(0, Math.min(1, q.remaining / q.limit));
  }
}
