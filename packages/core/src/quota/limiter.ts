/**
 * In-memory token-bucket rate limiter (per key). P1 moves state to SQLite/Redis.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; resetAt: number }>();

  constructor(private requestsPerMinute: number = 600) {}

  /** Returns true when allowed (and consumes a token). */
  allow(key: string, now = Date.now()): boolean {
    const windowMs = 60_000;
    const b = this.buckets.get(key);
    if (!b || now >= b.resetAt) {
      this.buckets.set(key, { tokens: this.requestsPerMinute - 1, resetAt: now + windowMs });
      return true;
    }
    if (b.tokens <= 0) return false;
    b.tokens -= 1;
    return true;
  }

  setLimit(rpm: number): void {
    this.requestsPerMinute = rpm;
  }
}

/** Per-provider cooldown tracker: back off sick providers briefly. */
export class CooldownTracker {
  private until = new Map<string, number>();

  cool(id: string, ms: number, now = Date.now()): void {
    this.until.set(id, now + ms);
  }

  isCooling(id: string, now = Date.now()): boolean {
    return (this.until.get(id) ?? 0) > now;
  }

  coolingIds(now = Date.now()): Set<string> {
    const out = new Set<string>();
    for (const [id, until] of this.until) {
      if (until > now) out.add(id);
    }
    return out;
  }
}
