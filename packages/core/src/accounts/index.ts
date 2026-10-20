/**
 * Multi-account rotation: a provider can carry several API keys.
 *
 * Key sources (checked in order):
 *   1. `<ENVKEY>S` — comma-separated, e.g. GROQ_API_KEYS="k1,k2,k3"
 *   2. `<ENVKEY>_1`, `<ENVKEY>_2`, … — indexed, e.g. GROQ_API_KEY_1="k1"
 *   3. `<ENVKEY>` — single key, e.g. GROQ_API_KEY="k1"
 *
 * A key that returns 401/403 (bad key) or 429 (rate limited) is cooled for
 * 60s; the pool round-robins over the remaining healthy keys.
 * Key VALUES are never exposed — status() only reports counts.
 */

/** Collect all configured keys for one provider env key. */
export function collectKeys(envKey: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const plural = (env[`${envKey}S`] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (plural.length > 0) return [...new Set(plural)];

  const indexed: string[] = [];
  for (let i = 1; i <= 64; i++) {
    const v = (env[`${envKey}_${i}`] ?? "").trim();
    if (!v) break;
    indexed.push(v);
  }
  if (indexed.length > 0) return [...new Set(indexed)];

  const single = (env[envKey] ?? "").trim();
  return single ? [single] : [];
}

export type AccountStrategy = "round-robin" | "least-used" | "priority" | "random";

export function isAccountStrategy(v: unknown): v is AccountStrategy {
  return v === "round-robin" || v === "least-used" || v === "priority" || v === "random";
}

export class AccountPool {
  private readonly keys: string[];
  private cursor = 0;
  private coolingUntil = new Map<string, number>();
  private usageCount = new Map<string, number>();

  constructor(keys: string[], private cooldownMs = 60_000) {
    this.keys = [...new Set(keys)];
  }

  get total(): number {
    return this.keys.length;
  }

  /** Number of keys not currently cooling. */
  healthy(now = Date.now()): number {
    return this.keys.filter((k) => (this.coolingUntil.get(k) ?? 0) <= now).length;
  }

  /**
   * Next healthy key in round-robin order, skipping cooling keys and any in
   * `exclude` (keys already tried this attempt). Null when none available.
   */
  next(
    exclude: Set<string> = new Set(),
    now = Date.now(),
    strategy: AccountStrategy = "round-robin",
  ): string | null {
    if (this.keys.length === 0) return null;
    const healthy = this.keys.filter(
      (k) => !exclude.has(k) && (this.coolingUntil.get(k) ?? 0) <= now,
    );
    if (healthy.length === 0) return null;
    let ordered = healthy;
    if (strategy === "priority") {
      ordered = healthy; // configured order
    } else if (strategy === "least-used") {
      ordered = [...healthy].sort(
        (x, y) => (this.usageCount.get(x) ?? 0) - (this.usageCount.get(y) ?? 0),
      );
    } else if (strategy === "random") {
      ordered = [...healthy];
      for (let i = ordered.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!];
      }
    } else {
      // round-robin: rotate the healthy list by the cursor position
      const start = this.cursor % healthy.length;
      ordered = [...healthy.slice(start), ...healthy.slice(0, start)];
    }
    const pick = ordered[0]!;
    const idx = this.keys.indexOf(pick);
    if (idx >= 0) this.cursor = (idx + 1) % this.keys.length;
    return pick;
  }

  /** Mark a key bad/rate-limited: cool it for `cooldownMs`. */
  reportFailure(key: string, now = Date.now()): void {
    if (this.keys.includes(key)) this.coolingUntil.set(key, now + this.cooldownMs);
  }

  /** A success clears any cooldown on the key. */
  reportSuccess(key: string): void {
    this.coolingUntil.delete(key);
    this.usageCount.set(key, (this.usageCount.get(key) ?? 0) + 1);
  }

  /** Counts only — never key values. */
  status(now = Date.now()): { total: number; healthy: number } {
    return { total: this.keys.length, healthy: this.healthy(now) };
  }
}
