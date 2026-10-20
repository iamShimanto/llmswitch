import type { AccountStrategy } from "./index.js";

export type { AccountStrategy };

/**
 * Session-account selection: orders a provider's DB accounts for one
 * request according to the account strategy. Round-robin keeps a
 * per-provider cursor; least-used orders by lifetime call counts.
 */
const cursors = new Map<string, number>();

export interface AccountCandidate {
  id: string;
  calls: number;
}

export function orderAccounts<T extends AccountCandidate>(
  providerId: string,
  accounts: T[],
  strategy: AccountStrategy,
): T[] {
  if (accounts.length <= 1) return [...accounts];
  if (strategy === "priority") return [...accounts];
  if (strategy === "least-used") {
    return [...accounts].sort((a, b) => a.calls - b.calls);
  }
  if (strategy === "random") {
    const out = [...accounts];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
  // round-robin
  const cur = cursors.get(providerId) ?? 0;
  cursors.set(providerId, cur + 1);
  const start = cur % accounts.length;
  return [...accounts.slice(start), ...accounts.slice(0, start)];
}
