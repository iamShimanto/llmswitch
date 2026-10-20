import type { ErrorKind } from "./errors.js";

/**
 * Per-(provider, model) circuit breaker — Rotation v2.
 *
 * v1 had only a provider-wide 30s cooldown for 429/5xx, and 404s were
 * classified "bad_request": the chain stopped AND nothing was remembered,
 * so a dead model (retired upstream, not entitled on the account) cost a
 * full upstream round-trip on every single request, forever.
 *
 * This breaker remembers failures per provider+model:
 * - after a small threshold of consecutive failures the pair is
 *   blacklisted for an escalating duration (model errors start at 10
 *   minutes — they are usually permanent; transient errors at 30–60s),
 * - requests skip open pairs instantly (chains fall through in ~0 ms;
 *   a pinned request fails fast with the reason and retry time),
 * - after the cooldown exactly one probe request is let through
 *   (half-open): success clears the record, failure re-opens with the
 *   next escalation step.
 */
export interface BreakerSnapshotEntry {
  key: string;
  providerId: string;
  model: string;
  failures: number;
  lastKind: string;
  lastError: string;
  open: boolean;
  retryInMs: number;
}

interface Entry {
  providerId: string;
  model: string;
  failures: number;
  openUntil: number;
  lastKind: string;
  lastError: string;
  probing: boolean;
}

interface Policy {
  base: number;
  factor: number;
  cap: number;
  threshold: number;
}

const POLICIES: Record<string, Policy> = {
  // model errors (404/410) are usually permanent: long, steep escalation
  model_error: { base: 600_000, factor: 3, cap: 21_600_000, threshold: 2 },
  rate_limited: { base: 60_000, factor: 2, cap: 300_000, threshold: 2 },
  server_error: { base: 30_000, factor: 2, cap: 300_000, threshold: 2 },
  timeout: { base: 30_000, factor: 2, cap: 300_000, threshold: 2 },
  unknown: { base: 30_000, factor: 2, cap: 300_000, threshold: 3 },
};

const policyFor = (kind: ErrorKind): Policy => POLICIES[kind] ?? POLICIES.unknown!;

export class ModelBreaker {
  private map = new Map<string, Entry>();

  static key(providerId: string, model: string): string {
    return `${providerId}:${model}`;
  }

  /**
   * Gate a request before it goes upstream. "blocked" = fail fast / skip;
   * "probe" = cooldown expired, this request is the single half-open
   * probe; "go" = healthy.
   */
  gate(providerId: string, model: string, now = Date.now()): "go" | "probe" | "blocked" {
    const e = this.map.get(ModelBreaker.key(providerId, model));
    if (!e || e.openUntil === 0) return "go"; // healthy, or failures below threshold
    if (e.openUntil > now) return "blocked"; // cooling down
    if (e.probing) return "blocked"; // a half-open probe is already in flight
    e.probing = true;
    return "probe";
  }

  isOpen(providerId: string, model: string, now = Date.now()): boolean {
    const e = this.map.get(ModelBreaker.key(providerId, model));
    return e != null && e.openUntil > now;
  }

  recordSuccess(providerId: string, model: string): void {
    this.map.delete(ModelBreaker.key(providerId, model));
  }

  recordFailure(
    providerId: string,
    model: string,
    kind: ErrorKind,
    status: number,
    message: string,
    now = Date.now(),
  ): void {
    const key = ModelBreaker.key(providerId, model);
    // any outcome releases a half-open probe slot
    const existing = this.map.get(key);
    if (existing) existing.probing = false;
    // auth and plain bad requests are the caller's problem, not the
    // model's health — the account rotation layer handles those.
    if (kind === "auth_error" || kind === "bad_request") return;
    const policy = policyFor(kind);
    // 410 Gone is definitive (model retired): open on the first failure.
    const threshold = kind === "model_error" && status === 410 ? 1 : policy.threshold;
    const e =
      this.map.get(key) ??
      ({ providerId, model, failures: 0, openUntil: 0, lastKind: kind, lastError: "", probing: false } as Entry);
    e.failures++;
    e.probing = false;
    e.lastKind = kind;
    e.lastError = message.slice(0, 160);
    if (e.failures >= threshold) {
      const steps = e.failures - threshold;
      const duration = Math.min(policy.cap, policy.base * Math.pow(policy.factor, steps));
      e.openUntil = now + duration;
    }
    this.map.set(key, e);
  }

  /** Human explanation for a blocked pair (used in fail-fast errors). */
  describe(providerId: string, model: string, now = Date.now()): string {
    const e = this.map.get(ModelBreaker.key(providerId, model));
    if (!e) return "";
    const mins = Math.max(1, Math.round((e.openUntil - now) / 60_000));
    return `model ${model} on ${providerId} is blacklisted after ${e.failures} failures (${e.lastError}); retry in ~${mins} min`;
  }

  snapshot(now = Date.now()): BreakerSnapshotEntry[] {
    return [...this.map.entries()]
      .map(([key, e]) => ({
        key,
        providerId: e.providerId,
        model: e.model,
        failures: e.failures,
        lastKind: e.lastKind,
        lastError: e.lastError,
        open: e.openUntil > now,
        retryInMs: Math.max(0, e.openUntil - now),
      }))
      .sort((a, b) => Number(b.open) - Number(a.open) || b.failures - a.failures);
  }

  /** Clear one pair or (no key) the whole breaker table. */
  reset(key?: string): void {
    if (key) this.map.delete(key);
    else this.map.clear();
  }
}
