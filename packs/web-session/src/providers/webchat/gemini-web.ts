/**
 * Gemini Web driver — the gemini.google.com cookie protocol (the
 * classic BardChatUi StreamGenerate flow that third-party clients
 * have used for years), ported for LLMSwitch's web-session pack.
 * OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute)
 * ships a gemini-web provider too, but drives the site with a full
 * Playwright browser lease and RETIRED its image model
 * (nano-banana-web) — this driver instead speaks the lighter HTTP
 * protocol directly and treats images as an open question for the
 * live spike (see generateImage).
 *
 * ⚠️ Unofficial reverse-engineered protocol — NEEDS LIVE VERIFICATION
 * with the user's own gemini.google.com cookies (__Secure-1PSID +
 * __Secure-1PSIDTS). Model selection is account-side: the web
 * protocol serves whichever model the account has selected, so the
 * catalog model names are advisory until the jspb model header is
 * live-verified.
 */
import type { CookieJar } from "../../cookieJar.js";
import type { ChatMessage } from "../../cookieChat.js";
import {
  BROWSER_UA,
  WebChatError,
  harvestCookies,
  requireCookieHeader,
  singleChunkStream,
  type WebChatDriver,
} from "./types.js";

const PROVIDER_ID = "gemini-web";
const APP_URL = "https://gemini.google.com/app";
const GENERATE_URL =
  "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const COOKIE_HINT =
  "gemini.google.com cookies (__Secure-1PSID and __Secure-1PSIDTS) are required; " +
  "import with: llmswitch cookies gemini-web";

interface GeminiTurn {
  text: string;
  imageUrls: string[];
}

/** Deep-collect image URLs hiding anywhere in a candidate structure. */
function collectImageUrls(node: unknown, out: string[], depth = 0): void {
  if (depth > 14 || node == null) return;
  if (typeof node === "string") {
    if (
      /^https:\/\/[^"'\s]+(googleusercontent\.com|fife\.usercontent\.google\.com)[^"'\s]*$/.test(node) &&
      !out.includes(node)
    ) {
      out.push(node);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectImageUrls(child, out, depth + 1);
  } else if (typeof node === "object") {
    for (const child of Object.values(node as Record<string, unknown>)) collectImageUrls(child, out, depth + 1);
  }
}

/**
 * Parse a StreamGenerate response body: `)]}'`-prefixed, length-
 * prefixed JSON chunks; the payload lives in ["wrb.fr", null, "<json>"]
 * entries whose inner JSON carries candidates at index 4. Each
 * candidate's text parts sit at index 1 (a list of strings).
 */
export function parseGeminiResponse(raw: string): GeminiTurn {
  let text = "";
  const imageUrls: string[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("[[")) continue;
    let outer: unknown;
    try {
      outer = JSON.parse(t);
    } catch {
      continue;
    }
    if (!Array.isArray(outer)) continue;
    for (const entry of outer) {
      if (!Array.isArray(entry) || entry[0] !== "wrb.fr" || typeof entry[2] !== "string") continue;
      let inner: unknown;
      try {
        inner = JSON.parse(entry[2]);
      } catch {
        continue;
      }
      if (!Array.isArray(inner)) continue;
      const candidates = inner[4];
      if (!Array.isArray(candidates)) continue;
      for (const cand of candidates) {
        if (!Array.isArray(cand)) continue;
        const parts = cand[1];
        if (Array.isArray(parts)) {
          for (const p of parts) if (typeof p === "string" && p.length > text.length) text = p;
        }
        collectImageUrls(cand, imageUrls);
      }
    }
  }
  return { text, imageUrls };
}

/** Flatten the message list into a single prompt (system folded in). */
function flattenPrompt(messages: ChatMessage[]): string {
  const usable = messages;
  if (usable.length === 1) return usable[0]!.content;
  const lines: string[] = [];
  for (const m of usable) {
    if (m.role === "system") lines.push(`[system] ${m.content}`);
    else if (m.role === "assistant") lines.push(`Assistant: ${m.content}`);
    else lines.push(`User: ${m.content}`);
  }
  lines.push("Assistant:");
  return lines.join("\n\n");
}

export class GeminiWebDriver implements WebChatDriver {
  readonly id = PROVIDER_ID;
  readonly cookieDomains = ["gemini.google.com", "google.com"];
  readonly cookieHint = COOKIE_HINT;

  private atToken: string | null = null;
  private buildLabel: string | null = null;
  private reqid = Math.floor(100_000 + Math.random() * 900_000);

  constructor(
    private jar: CookieJar,
    private fetchFn: typeof fetch = fetch,
  ) {}

  /** GET /app and lift the SNlM0e (at) + cfb2h (bl) tokens from the HTML. */
  async bootstrap(): Promise<void> {
    if (this.atToken) return;
    const cookie = requireCookieHeader(this.jar, APP_URL, PROVIDER_ID, COOKIE_HINT);
    const res = await this.fetchFn(APP_URL, {
      headers: { cookie, "user-agent": BROWSER_UA, accept: "text/html" },
      signal: AbortSignal.timeout(30_000),
    });
    harvestCookies(this.jar, res, APP_URL);
    if (!res.ok) {
      throw new WebChatError(PROVIDER_ID, `gemini web bootstrap failed (HTTP ${res.status})`);
    }
    const html = await res.text();
    this.atToken = /"SNlM0e":"([^"]+)"/.exec(html)?.[1] ?? null;
    this.buildLabel = /"cfb2h":"([^"]+)"/.exec(html)?.[1] ?? null;
    if (!this.atToken) {
      throw new WebChatError(
        PROVIDER_ID,
        "gemini web session has no SNlM0e token — the cookies are not logged in (or expired); re-import gemini.google.com cookies",
      );
    }
  }

  private async turn(prompt: string): Promise<GeminiTurn> {
    await this.bootstrap();
    const cookie = requireCookieHeader(this.jar, APP_URL, PROVIDER_ID, COOKIE_HINT);
    const inner = JSON.stringify([[prompt], null, ["", "", ""]]);
    const fReq = JSON.stringify([null, inner]);
    const body = new URLSearchParams({ "f.req": fReq, at: this.atToken! });
    const url =
      `${GENERATE_URL}?bl=${encodeURIComponent(this.buildLabel ?? "")}` +
      `&hl=en&_reqid=${this.reqid}&rt=c`;
    this.reqid += 100_000;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        cookie,
        "user-agent": BROWSER_UA,
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        origin: "https://gemini.google.com",
        referer: APP_URL,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(120_000),
    });
    harvestCookies(this.jar, res, APP_URL);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new WebChatError(PROVIDER_ID, `gemini web generate failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    const parsed = parseGeminiResponse(await res.text());
    if (!parsed.text && parsed.imageUrls.length === 0) {
      throw new WebChatError(
        PROVIDER_ID,
        "gemini web returned an empty reply — the session may be expired or Google changed the protocol (NEEDS LIVE VERIFICATION)",
      );
    }
    return parsed;
  }

  async chat(_model: string, messages: ChatMessage[]): Promise<string> {
    const turn = await this.turn(flattenPrompt(messages));
    const images = turn.imageUrls.map((u) => `![gemini image](${u})`).join("\n");
    return images ? (turn.text ? `${turn.text}\n\n${images}` : images) : turn.text;
  }

  async *chatStream(model: string, messages: ChatMessage[]): AsyncGenerator<string> {
    yield* singleChunkStream(await this.chat(model, messages));
  }

  /**
   * Image attempt for the live spike: ask for a picture and see if
   * the protocol returns generated-image URLs (the pre-retirement
   * OmniRoute flow suggests it once did). Downloads the first image
   * with the session cookies. NEEDS LIVE VERIFICATION.
   */
  async generateImage(prompt: string): Promise<{ b64: string; mime: string; text?: string }> {
    const turn = await this.turn(prompt);
    const url = turn.imageUrls[0];
    if (!url) {
      throw new WebChatError(
        PROVIDER_ID,
        `gemini web did not return an image${turn.text ? ` — it replied: ${turn.text.slice(0, 240)}` : ""}`,
      );
    }
    const cookie = requireCookieHeader(this.jar, APP_URL, PROVIDER_ID, COOKIE_HINT);
    const res = await this.fetchFn(url, {
      headers: { cookie, "user-agent": BROWSER_UA },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new WebChatError(PROVIDER_ID, `gemini web image download failed (HTTP ${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      b64: buf.toString("base64"),
      mime: res.headers.get("content-type")?.split(";")[0] || "image/jpeg",
      text: turn.text || undefined,
    };
  }
}
