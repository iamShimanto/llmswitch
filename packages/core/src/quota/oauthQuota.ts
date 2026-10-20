/**
 * Claude + Codex subscription quota — the same treatment Antigravity
 * gets: per-account live buckets on the Quotas page.
 *
 * Claude: GET https://api.anthropic.com/api/oauth/usage with the OAuth
 * access token (the endpoint Claude Code itself polls) returns
 * utilization windows { five_hour, seven_day, seven_day_opus,
 * seven_day_sonnet } each { utilization: 0..100, resets_at }.
 *
 * Codex: GET https://chatgpt.com/backend-api/wham/usage returns
 * rate_limit { primary_window, secondary_window } each
 * { used_percent, reset_at }. Account id rides along when the session
 * carries one.
 *
 * Buckets reuse the AgyQuotaBucket shape ({model: label, remainingPct,
 * resetAt, unlimited}) so the dashboard renders all three providers
 * through one component. A missing utilization is null ("unknown"),
 * never 0.
 */
import { resolveClaudeCreds } from "../executor/claudeOAuth.js";
import { resolveCodexCreds } from "../executor/codexOAuth.js";
import type { AgyAccountQuota, AgyQuotaBucket } from "./antigravityQuota.js";

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;

const isoOrNull = (v: unknown): string | null => {
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  if (typeof v === "number" && v > 0) {
    // epoch seconds (codex) — anything past year 33658 is milliseconds
    const ms = v > 1e12 ? v : v * 1000;
    return new Date(ms).toISOString();
  }
  return null;
};

interface UsageWindow {
  utilization?: unknown;
  used_percent?: unknown;
  resets_at?: unknown;
  reset_at?: unknown;
}

function windowBucket(label: string, w: UsageWindow | null | undefined): AgyQuotaBucket | null {
  if (!w || typeof w !== "object") return null;
  const used = num(w.utilization ?? w.used_percent);
  if (used == null) return null;
  const resetAt = isoOrNull(w.resets_at ?? w.reset_at);
  return {
    model: label,
    remainingPct: Math.round((100 - used) * 10) / 10,
    resetAt,
    unlimited: used === 0 && !resetAt,
  };
}

/** Pure parser for Anthropic's /api/oauth/usage response. */
export function parseClaudeUsage(data: unknown): AgyQuotaBucket[] {
  const d = (data ?? {}) as Record<string, UsageWindow | undefined>;
  const out: AgyQuotaBucket[] = [];
  const five = windowBucket("5-hour window", d.five_hour);
  if (five) out.push(five);
  const week = windowBucket("7-day window", d.seven_day);
  if (week) out.push(week);
  const opus = windowBucket("7-day · Opus", d.seven_day_opus);
  if (opus) out.push(opus);
  const sonnet = windowBucket("7-day · Sonnet", d.seven_day_sonnet);
  if (sonnet) out.push(sonnet);
  return out;
}

/** Pure parser for ChatGPT's /backend-api/wham/usage response. */
export function parseCodexUsage(data: unknown): AgyQuotaBucket[] {
  const rl = (data as { rate_limit?: Record<string, UsageWindow | undefined> } | null)?.rate_limit;
  if (!rl) return [];
  const out: AgyQuotaBucket[] = [];
  const primary = windowBucket("Primary window", rl.primary_window);
  if (primary) out.push(primary);
  const secondary = windowBucket("Weekly window", rl.secondary_window);
  if (secondary) out.push(secondary);
  return out;
}

export async function fetchClaudeQuotaBuckets(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<AgyQuotaBucket[] | null> {
  if (!accessToken) return null;
  try {
    const res = await fetchFn("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        accept: "application/json",
        "user-agent": "claude-cli/1.0.0 (llmswitch quota)",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return parseClaudeUsage(await res.json());
  } catch {
    return null;
  }
}

export async function fetchCodexQuotaBuckets(
  accessToken: string,
  chatgptAccountId: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<AgyQuotaBucket[] | null> {
  if (!accessToken) return null;
  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      "user-agent": "codex-cli/1.0.0 (llmswitch quota)",
    };
    if (chatgptAccountId) headers["chatgpt-account-id"] = chatgptAccountId;
    const res = await fetchFn("https://chatgpt.com/backend-api/wham/usage", {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return parseCodexUsage(await res.json());
  } catch {
    return null;
  }
}

const CACHE_TTL_MS = 60_000;
const caches = new Map<string, Map<string, { at: number; buckets: AgyQuotaBucket[] }>>();

function cached(provider: string, key: string, now: number): AgyQuotaBucket[] | null {
  const hit = caches.get(provider)?.get(key);
  return hit && now - hit.at < CACHE_TTL_MS ? hit.buckets : null;
}
function storeCache(provider: string, key: string, buckets: AgyQuotaBucket[], now: number): void {
  let m = caches.get(provider);
  if (!m) caches.set(provider, (m = new Map()));
  m.set(key, { at: now, buckets });
}

/** Per-account quota groups for claude / codex (default + DB accounts). */
export async function oauthAccountQuotas(
  provider: "claude" | "codex",
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
    const hit = cached(provider, key, now);
    if (hit) {
      out.push({ accountId: t.accountId, label: t.label, buckets: hit });
      continue;
    }
    try {
      let buckets: AgyQuotaBucket[] | null = null;
      if (provider === "claude") {
        const creds = await resolveClaudeCreds(env, fetchFn, t.accountId);
        buckets = await fetchClaudeQuotaBuckets(creds.accessToken, fetchFn);
      } else {
        const creds = await resolveCodexCreds(env, fetchFn, t.accountId);
        buckets = await fetchCodexQuotaBuckets(creds.accessToken, creds.accountId, fetchFn);
      }
      if (!buckets) continue;
      storeCache(provider, key, buckets, now);
      out.push({ accountId: t.accountId, label: t.label, buckets });
    } catch {
      /* no session for this account — skip */
    }
  }
  return out;
}
