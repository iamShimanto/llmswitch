/**
 * Antigravity (Google Cloud Code) quota — OmniRoute-style per-account,
 * per-model remaining quota via the `retrieveUserQuota` endpoint.
 *
 * Ported approach (MIT, see LICENSE — OmniRoute
 * open-sse/services/usage/antigravity.ts): POST {project} to
 * /v1internal:retrieveUserQuota on the Cloud Code runtime hosts; each
 * bucket carries a modelId, a remainingFraction (0..1, may be ABSENT —
 * absent means "unknown", never 0) and a resetTime. A bucket with a full
 * fraction and no reset time is unlimited.
 */
import {
  ANTIGRAVITY_RUNTIME_BASE_URLS,
  buildAntigravityContentHeaders,
  resolveAntigravityCreds,
} from "../executor/antigravity.js";

export interface AgyQuotaBucket {
  model: string;
  /** 0..100, or null when upstream did not report a fraction */
  remainingPct: number | null;
  /** ISO reset time, or null */
  resetAt: string | null;
  unlimited: boolean;
}

export interface AgyAccountQuota {
  accountId: string | null;
  label: string;
  buckets: AgyQuotaBucket[];
}

/** Pure parser for a retrieveUserQuota response body. */
export function parseAgyQuotaBuckets(data: unknown): AgyQuotaBucket[] {
  const buckets = (data as { buckets?: unknown[] } | null)?.buckets;
  if (!Array.isArray(buckets)) return [];
  const out: AgyQuotaBucket[] = [];
  for (const raw of buckets) {
    const b = raw as { modelId?: unknown; remainingFraction?: unknown; resetTime?: unknown };
    const model = typeof b.modelId === "string" ? b.modelId : "";
    if (!model) continue;
    const frac =
      typeof b.remainingFraction === "number" && Number.isFinite(b.remainingFraction)
        ? Math.max(0, Math.min(1, b.remainingFraction))
        : null;
    let resetAt: string | null = null;
    if (typeof b.resetTime === "string" && b.resetTime) {
      const t = Date.parse(b.resetTime);
      if (!Number.isNaN(t) && t > 0) resetAt = new Date(t).toISOString();
    }
    out.push({
      model,
      remainingPct: frac == null ? null : Math.round(frac * 1000) / 10,
      resetAt,
      unlimited: frac != null && frac >= 1 && !resetAt,
    });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model));
}

/** Fetch one account's buckets; null when the endpoint can't be reached. */
export async function fetchAntigravityQuotaBuckets(
  accessToken: string,
  projectId: string,
  fetchFn: typeof fetch = fetch,
): Promise<AgyQuotaBucket[] | null> {
  if (!accessToken || !projectId) return null;
  for (const base of ANTIGRAVITY_RUNTIME_BASE_URLS) {
    try {
      const res = await fetchFn(`${base}/v1internal:retrieveUserQuota`, {
        method: "POST",
        headers: buildAntigravityContentHeaders(accessToken),
        body: JSON.stringify({ project: projectId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      return parseAgyQuotaBuckets(await res.json());
    } catch {
      /* try the next host */
    }
  }
  return null;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; buckets: AgyQuotaBucket[] }>();

/**
 * Quota groups for the default account + the given DB accounts.
 * Accounts whose creds or quota can't be resolved are skipped; results
 * are cached for 60s so dashboard refreshes don't hammer Google.
 */
export async function antigravityAccountQuotas(
  env: NodeJS.ProcessEnv,
  accounts: Array<{ id: string; label: string }>,
  fetchFn: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<AgyAccountQuota[]> {
  const targets: Array<{ accountId: string | null; label: string }> = [
    { accountId: null, label: "Default account" },
    ...accounts.map((a) => ({ accountId: a.id, label: a.label })),
  ];
  const out: AgyAccountQuota[] = [];
  for (const t of targets) {
    const key = t.accountId ?? "default";
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      out.push({ accountId: t.accountId, label: t.label, buckets: hit.buckets });
      continue;
    }
    try {
      const creds = await resolveAntigravityCreds(env, fetchFn, "antigravity", t.accountId);
      if (!creds.projectId) continue;
      const buckets = await fetchAntigravityQuotaBuckets(creds.accessToken, creds.projectId, fetchFn);
      if (!buckets) continue;
      cache.set(key, { at: now, buckets });
      out.push({ accountId: t.accountId, label: t.label, buckets });
    } catch {
      /* no session for this account — skip */
    }
  }
  return out;
}
