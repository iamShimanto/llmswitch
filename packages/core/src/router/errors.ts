/** Error classification for fallback decisions. */

export type ErrorKind =
  | "rate_limited" // 429 — try next provider/account
  | "server_error" // 5xx — try next provider
  | "timeout" // network timeout — try next provider
  | "auth_error" // 401/403 — do NOT retry (key is bad)
  | "bad_request" // 400/404/422 — do NOT retry (request is bad)
  | "unknown";

export function classifyStatus(status: number): ErrorKind {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth_error";
  if (status === 400 || status === 404 || status === 422) return "bad_request";
  if (status >= 500) return "server_error";
  return "unknown";
}

export function classifyError(err: unknown): ErrorKind {
  if (err instanceof UpstreamError) return err.kind;
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|aborted/i.test(msg)) return "timeout";
  return "unknown";
}

/** Retryable kinds: safe to try the next provider in the chain. */
export function isRetryable(kind: ErrorKind): boolean {
  return kind === "rate_limited" || kind === "server_error" || kind === "timeout";
}

export class UpstreamError extends Error {
  constructor(
    public kind: ErrorKind,
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}
