/**
 * Shared contract for per-site cookie web-chat drivers.
 *
 * Each driver drives one site's unofficial web chat protocol using the
 * user's own imported browser cookies (see `llmswitch cookies <name>`).
 * Protocols were ported from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, release v3.8.53) — see the
 * attribution header in every driver file.
 *
 * ⚠️ These protocols are reverse-engineered and ROT FAST. Every driver is
 * mock-tested only; each needs the user's real browser cookies to verify
 * live. Drivers mark unverifiable steps NEEDS LIVE VERIFICATION.
 */
import type { CookieJar } from "../../cookieJar.js";
import type { ChatMessage } from "../../cookieChat.js";

export type { ChatMessage };

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class WebChatError extends Error {
  constructor(
    public readonly providerId: string,
    message: string,
  ) {
    super(message);
    this.name = "WebChatError";
  }
}

export interface WebChatDriver {
  /** provider id, e.g. "chatgpt-web" */
  readonly id: string;
  /** cookie domains this driver needs (for import help text) */
  readonly cookieDomains: string[];
  /** human-readable hint shown when required cookies are missing */
  readonly cookieHint: string;
  /**
   * Resolve session prerequisites (e.g. exchange cookies for an
   * accessToken, discover an org id). Idempotent; called before chat.
   * Throws WebChatError with an import hint when cookies are missing.
   */
  bootstrap(): Promise<void>;
  /** Non-streaming chat. Returns the assistant's full text. */
  chat(model: string, messages: ChatMessage[]): Promise<string>;
  /** Streaming chat. Yields text deltas as they arrive. */
  chatStream(model: string, messages: ChatMessage[]): AsyncGenerator<string>;
}

export interface WebChatDriverOpts {
  /** Session-carried access token (Meta AI ecto1:… for muse-spark-web). */
  accessToken?: string;
  /** WebSocket constructor override (drivers that speak WS; tests). */
  wsCtor?: unknown;
}

export type WebChatDriverCtor = new (
  jar: CookieJar,
  fetchFn?: typeof fetch,
) => WebChatDriver;

/** Cookie header for `url`, or a WebChatError telling the user how to import. */
export function requireCookieHeader(
  jar: CookieJar,
  url: string,
  providerId: string,
  hint: string,
): string {
  const cookie = jar.headerFor(url);
  if (!cookie) {
    throw new WebChatError(
      providerId,
      `no cookies for ${new URL(url).hostname} — import a session first: llmswitch cookies ${providerId} (${hint})`,
    );
  }
  return cookie;
}

/** Yield the payload of every `data:` line from an SSE response body. */
export async function* sseDataLines(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  const tail = buf.trim();
  if (tail.startsWith("data:")) yield tail.slice(5).trim();
}

/** Wrap a one-shot chat() result as a single-chunk stream. */
export async function* singleChunkStream(text: string): AsyncGenerator<string> {
  if (text) yield text;
}

/** Parse a fetch Response's Set-Cookie headers back into the jar. */
export function harvestCookies(
  jar: CookieJar,
  res: Response,
  fromUrl: string,
): void {
  const setCookies = (res.headers as Headers).getSetCookie?.() ?? [];
  if (setCookies.length > 0) jar.ingest(setCookies, fromUrl);
}
