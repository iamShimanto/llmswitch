/**
 * Generic cookie-session chat driver.
 * Sends a chat completion through an unofficial web endpoint using the
 * user's own imported browser cookies. The endpoint config (URL, wire
 * format, extra headers) is supplied by the caller — per-provider protocol
 * details live in pack configs, not here.
 */
import { CookieJar } from "./cookieJar.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CookieChatConfig {
  /** full chat endpoint URL, e.g. the provider's web API */
  url: string;
  wireFormat: "openai" | "anthropic";
  extraHeaders?: Record<string, string>;
}

export class CookieChatDriver {
  constructor(
    private jar: CookieJar,
    private config: CookieChatConfig,
    private fetchFn: typeof fetch = fetch,
  ) {}

  /** Non-streaming chat. Returns the assistant's text. */
  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    const cookie = this.jar.headerFor(this.config.url);
    if (!cookie) throw new Error("no cookies for this endpoint — import a session first");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      cookie,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      ...this.config.extraHeaders,
    };
    const body =
      this.config.wireFormat === "anthropic"
        ? {
            model,
            max_tokens: 1024,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
          }
        : { model, messages, stream: false };

    const res = await this.fetchFn(this.config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    // harvest refreshed cookies
    const setCookies = (res.headers as Headers).getSetCookie?.() ?? [];
    if (setCookies.length > 0) this.jar.ingest(setCookies, this.config.url);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`cookie chat failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const j = (await res.json()) as any;
    if (this.config.wireFormat === "anthropic") {
      const text = j?.content?.find((b: any) => b.type === "text")?.text;
      if (typeof text === "string") return text;
    } else {
      const text = j?.choices?.[0]?.message?.content;
      if (typeof text === "string") return text;
    }
    throw new Error("cookie chat: could not parse assistant reply");
  }
}
