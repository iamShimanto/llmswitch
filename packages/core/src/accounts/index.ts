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

export class AccountPool {
  private readonly keys: string[];
  private cursor = 0;
  private coolingUntil = new Map<string, number>();

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
  next(exclude: Set<string> = new Set(), now = Date.now()): string | null {
    if (this.keys.length === 0) return null;
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[(this.cursor + i) % this.keys.length]!;
      if (exclude.has(k)) continue;
      if ((this.coolingUntil.get(k) ?? 0) > now) continue;
      this.cursor = (this.cursor + i + 1) % this.keys.length;
      return k;
    }
    return null;
  }

  /** Mark a key bad/rate-limited: cool it for `cooldownMs`. */
  reportFailure(key: string, now = Date.now()): void {
    if (this.keys.includes(key)) this.coolingUntil.set(key, now + this.cooldownMs);
  }

  /** A success clears any cooldown on the key. */
  reportSuccess(key: string): void {
    this.coolingUntil.delete(key);
  }

  /** Counts only — never key values. */
  status(now = Date.now()): { total: number; healthy: number } {
    return { total: this.keys.length, healthy: this.healthy(now) };
  }
}
