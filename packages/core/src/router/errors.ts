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

const REASON_PHRASES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/**
 * Turn a raw upstream error body into a short human message. Raw bodies are
 * often full HTML error pages or nested JSON dumps — showing them verbatim
 * made the dashboard unreadable (and leaked page markup into API errors).
 * HTML → status line only; JSON → its error.message; text → collapsed.
 */
export function summarizeUpstreamBody(status: number, text: string, max = 180): string {
  const head = `upstream ${status}${REASON_PHRASES[status] ? ` ${REASON_PHRASES[status]}` : ""}`;
  const body = (text ?? "").trim();
  if (!body) return head;
  if (/^<!doctype html|^<html/i.test(body)) return head;
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const err = (j.error ?? j) as Record<string, unknown>;
    const msg =
      (typeof err.message === "string" && err.message) ||
      (typeof (j as { message?: unknown }).message === "string" && (j as { message: string }).message) ||
      "";
    if (msg) return `${head}: ${msg.replace(/\s+/g, " ").slice(0, max)}`;
    return head;
  } catch {
    return `${head}: ${body.replace(/\s+/g, " ").slice(0, max)}`;
  }
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
