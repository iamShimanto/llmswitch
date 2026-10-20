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
 *
 * COOLDOWN SCOPING (learned live): a 401/403 is often about the MODEL,
 * not the key ("You need to sign in to use this model") — cooling the
 * provider's only key provider-wide made every later model fail with
 * "no healthy account keys" (one bad combo target poisoned the rest).
 * Auth failures therefore cool the (key, model) pair only; a 429 is an
 * account-level quota signal and still cools the whole key.
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
  /** Model-scoped auth cooldowns: `${key}\n${model}` → until timestamp. */
  private modelCoolingUntil = new Map<string, number>();
  private usageCount = new Map<string, number>();

  private isCooling(key: string, now: number, model?: string): boolean {
    if ((this.coolingUntil.get(key) ?? 0) > now) return true;
    if (model && (this.modelCoolingUntil.get(`${key}\n${model}`) ?? 0) > now) return true;
    return false;
  }

  constructor(keys: string[], private cooldownMs = 60_000) {
    this.keys = [...new Set(keys)];
  }

  get total(): number {
    return this.keys.length;
  }

  /** Number of keys not currently cooling (for `model`, when given). */
  healthy(now = Date.now(), model?: string): number {
    return this.keys.filter((k) => !this.isCooling(k, now, model)).length;
  }

  /**
   * Next healthy key in round-robin order, skipping cooling keys and any in
   * `exclude` (keys already tried this attempt). Null when none available.
   */
  next(
    exclude: Set<string> = new Set(),
    now = Date.now(),
    strategy: AccountStrategy = "round-robin",
    model?: string,
  ): string | null {
    if (this.keys.length === 0) return null;
    const healthy = this.keys.filter((k) => !exclude.has(k) && !this.isCooling(k, now, model));
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

  /**
   * Mark a failure. With `model`, the cooldown applies to that
   * (key, model) pair ONLY (auth failures — the key may be perfectly
   * healthy for other models). Without it, the whole key cools
   * (rate-limit / quota failures).
   */
  reportFailure(key: string, now = Date.now(), model?: string): void {
    if (!this.keys.includes(key)) return;
    if (model) this.modelCoolingUntil.set(`${key}\n${model}`, now + this.cooldownMs);
    else this.coolingUntil.set(key, now + this.cooldownMs);
  }

  /** A success clears any cooldown on the key. */
  reportSuccess(key: string): void {
    this.coolingUntil.delete(key);
    for (const k of [...this.modelCoolingUntil.keys()]) {
      if (k.startsWith(`${key}\n`)) this.modelCoolingUntil.delete(k);
    }
    this.usageCount.set(key, (this.usageCount.get(key) ?? 0) + 1);
  }

  /** Counts only — never key values. */
  status(now = Date.now()): { total: number; healthy: number } {
    return { total: this.keys.length, healthy: this.healthy(now) };
  }
}
