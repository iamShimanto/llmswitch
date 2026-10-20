/**
 * Venice Web (venice.ai) cookie web-chat driver.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53):
 *  - `open-sse/executors/venice-web.ts` (`VeniceWebExecutor`,
 *    `buildVeniceBody`, `parseVeniceLine`, `collectContent`) — the chat wire.
 *  - `open-sse/executors/venice-web-auth.ts` (`getSessionJwt`,
 *    `extractClientJwt`, `decodeJwtPayload`, VENICE_APP_URL /
 *    VENICE_CLERK_URL) — the Clerk session-JWT mint/refresh flow.
 *  - `open-sse/executors/index.ts` — registers the executor as
 *    "venice-web" (alias "ven").
 *  - `open-sse/services/tokenExtractionConfig.ts` — the "venice-web"
 *    browser-extraction entry (login https://venice.ai/login).
 *
 * ⚠️ DISCREPANCY IN OMNIROUTE'S OWN CODE, kept visible on purpose:
 * tokenExtractionConfig tells the browser extractor to grab a
 * `venice_session` cookie on `.venice.ai` (plus a localStorage `token`),
 * but the executor never uses either. The executor's durable credential
 * is the Clerk `__client` cookie (Clerk host: clerk.venice.ai), which is
 * exchanged for a short-lived session JWT sent as
 * `Authorization: Bearer`. This driver follows the EXECUTOR: without a
 * `__client` cookie, bootstrap fails with an explicit message. A jar
 * holding only `venice_session` is NOT sufficient per the code.
 *
 * Protocol (exactly as in the executor):
 *  1. GET  https://clerk.venice.ai/v1/client
 *       headers: Cookie: __client=<value>, Content-Type: application/json,
 *       Origin: https://venice.ai — response JSON
 *       `response.sessions[]`; the session with status "active" wins.
 *  2. POST https://clerk.venice.ai/v1/client/sessions/{id}/tokens
 *       (same headers) — response JSON `{ jwt }`. The JWT is cached
 *       until exp − 10 s (default TTL 55 s when no exp claim, matching
 *       venice-web-auth.ts); its `sub` claim becomes the body's userId.
 *  3. POST https://outerface.venice.ai/api/inference/chat
 *       headers: Authorization: Bearer <jwt>, x-venice-version:
 *       "interface@web", x-venice-middleface-version: "outerface@web",
 *       x-venice-request-timestamp-ms, Referer/Origin https://venice.ai.
 *       Body: see buildVeniceBody (modelId, prompt[], reasoning: false,
 *       temperature 0.7 / topP 0.9 defaults, random 7-char requestId,
 *       conversationType "text", all web/x-search flags false).
 *       Response: newline-delimited JSON events served as text/html;
 *       only `{ kind: "content", content }` lines carry assistant text
 *       (`reasoning_content` lines are skipped by this string-yielding
 *       driver; OmniRoute surfaces them as a separate delta field).
 *  On HTTP 401/403 from inference, the cached JWT is evicted (as in the
 *  executor) so the next call re-mints.
 *
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED. Mock-tested only — NEEDS LIVE
 * VERIFICATION with the user's real venice.ai cookies. Using a browser
 * session this way may violate Venice's Terms of Service.
 */
import type { CookieJar } from "../../cookieJar.js";
import type { ChatMessage } from "../../cookieChat.js";
import {
  BROWSER_UA,
  WebChatError,
  harvestCookies,
  requireCookieHeader,
  type WebChatDriver,
} from "./types.js";

export const VENICE_APP_URL = "https://venice.ai";
export const VENICE_CLERK_URL = "https://clerk.venice.ai";
export const VENICE_INFERENCE_URL = "https://outerface.venice.ai/api/inference/chat";

const PROVIDER_ID = "venice-web";
const COOKIE_HINT =
  "log in at https://venice.ai/login, then export cookies for venice.ai — " +
  "the Clerk __client cookie (clerk.venice.ai) is required; a venice_session " +
  "cookie alone is not enough (see driver header)";

/** JWT expiry safety buffer + fallback TTL, from venice-web-auth.ts. */
const EXPIRY_BUFFER_MS = 10_000;
const DEFAULT_TTL_MS = 55_000;

/** Accepts `__client=<jwt>`, a full Cookie header, or the bare value. */
export function extractClientJwt(raw: string): string {
  const trimmed = raw.trim().replace(/^cookie:\s*/i, "");
  const match = /(?:^|;\s*)__client=([^;\s]+)/.exec(trimmed);
  if (match) return match[1]!;
  return trimmed;
}

/** Decode a JWT payload without verifying the signature. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  try {
    const part = jwt.split(".")[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function jwtExpMs(jwt: string): number {
  const exp = decodeJwtPayload(jwt).exp;
  return typeof exp === "number" ? exp * 1000 : 0;
}

export interface VeniceEvent {
  kind?: string;
  content?: string;
  reasoning_content?: string;
}

/** Parse one NDJSON line defensively; unparseable lines are skipped. */
export function parseVeniceLine(line: string): VeniceEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as VeniceEvent) : null;
  } catch {
    return null;
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .filter((c: Record<string, unknown>) => c?.type === "text")
    .map((c: Record<string, unknown>) => String(c.text ?? ""))
    .join("");
}

function randomRequestId(): string {
  return Math.random().toString(36).slice(2, 9).padEnd(7, "0");
}

/** Request body for the Venice inference endpoint (port of buildVeniceBody). */
export function buildVeniceBody(
  modelId: string,
  messages: ChatMessage[],
  userId: string,
): Record<string, unknown> {
  return {
    modelId,
    prompt: messages.map((m) => ({ role: m.role, content: extractText(m.content) })),
    reasoning: false,
    temperature: 0.7,
    topP: 0.9,
    requestId: randomRequestId(),
    userId,
    simpleMode: false,
    includeVeniceSystemPrompt: false,
    webEnabled: false,
    webScrapeEnabled: false,
    xSearchEnabled: false,
    conversationType: "text",
    enableLargeContextChat: false,
    isCharacter: false,
    clientProcessingTime: 0,
  };
}

export class VeniceWebDriver implements WebChatDriver {
  readonly id = PROVIDER_ID;
  readonly cookieDomains = ["venice.ai", "clerk.venice.ai"];
  readonly cookieHint = COOKIE_HINT;

  private sessionJwt: string | null = null;
  private sessionJwtExpiresAt = 0;
  private userId = "";

  constructor(
    private jar: CookieJar,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private clerkHeaders(clientJwt: string): Record<string, string> {
    return {
      cookie: `__client=${clientJwt}`,
      "content-type": "application/json",
      "user-agent": BROWSER_UA,
      origin: VENICE_APP_URL,
    };
  }

  private veniceHeaders(jwt: string): Record<string, string> {
    return {
      "content-type": "application/json",
      "user-agent": BROWSER_UA,
      accept: "*/*",
      referer: `${VENICE_APP_URL}/`,
      origin: VENICE_APP_URL,
      authorization: `Bearer ${jwt}`,
      "x-venice-request-timestamp-ms": String(Date.now()),
      "x-venice-version": "interface@web",
      "x-venice-middleface-version": "outerface@web",
    };
  }

  /**
   * Exchange the Clerk `__client` cookie for a session JWT.
   * Idempotent: a still-valid cached JWT is reused without any fetch.
   */
  async bootstrap(): Promise<void> {
    if (this.sessionJwt && Date.now() < this.sessionJwtExpiresAt - EXPIRY_BUFFER_MS) return;

    const clientUrl = `${VENICE_CLERK_URL}/v1/client`;
    const cookieHeader = requireCookieHeader(this.jar, clientUrl, PROVIDER_ID, COOKIE_HINT);
    const clientJwt = extractClientJwt(cookieHeader);
    // requireCookieHeader only proves SOME cookie exists for the host; the
    // executor's credential is specifically __client. If the header has no
    // __client pair, extractClientJwt fell back to the raw header — detect
    // that and fail honestly instead of sending a wrong cookie to Clerk.
    if (!/(?:^|;\s*)__client=/.test(cookieHeader)) {
      throw new WebChatError(
        PROVIDER_ID,
        `cookies for venice.ai found, but no Clerk __client cookie — the ` +
          `venice-web executor requires __client (clerk.venice.ai); a ` +
          `venice_session cookie alone cannot mint a session JWT — import a ` +
          `session first: llmswitch cookies ${PROVIDER_ID} (${COOKIE_HINT})`,
      );
    }

    // 1. Find the active Clerk session.
    let clientRes: Response;
    try {
      clientRes = await this.fetchFn(clientUrl, {
        headers: this.clerkHeaders(clientJwt),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new WebChatError(
        PROVIDER_ID,
        `venice: Clerk /v1/client fetch failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
    harvestCookies(this.jar, clientRes, clientUrl);
    if (!clientRes.ok) {
      throw new WebChatError(
        PROVIDER_ID,
        `venice: Clerk /v1/client returned HTTP ${clientRes.status} - check your __client cookie`,
      );
    }
    const clientBody = (await clientRes.json().catch(() => null)) as {
      response?: { sessions?: Array<Record<string, string>> };
    } | null;
    const active = (clientBody?.response?.sessions ?? []).find((s) => s.status === "active");
    if (!active?.id) {
      throw new WebChatError(
        PROVIDER_ID,
        "venice: no active Clerk session - your __client cookie may be expired",
      );
    }

    // 2. Mint the short-lived session JWT.
    const tokensUrl = `${VENICE_CLERK_URL}/v1/client/sessions/${active.id}/tokens`;
    let tokenRes: Response;
    try {
      tokenRes = await this.fetchFn(tokensUrl, {
        method: "POST",
        headers: this.clerkHeaders(clientJwt),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new WebChatError(
        PROVIDER_ID,
        `venice: Clerk token refresh fetch failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
    harvestCookies(this.jar, tokenRes, tokensUrl);
    if (!tokenRes.ok) {
      throw new WebChatError(
        PROVIDER_ID,
        `venice: Clerk token refresh returned HTTP ${tokenRes.status}`,
      );
    }
    const jwt = ((await tokenRes.json().catch(() => null)) as { jwt?: unknown } | null)?.jwt;
    if (typeof jwt !== "string" || !jwt.startsWith("eyJ")) {
      throw new WebChatError(PROVIDER_ID, "venice: Clerk token refresh did not return a valid JWT");
    }
    this.sessionJwt = jwt;
    this.sessionJwtExpiresAt = jwtExpMs(jwt) || Date.now() + DEFAULT_TTL_MS;
    this.userId = String(decodeJwtPayload(jwt).sub ?? "");
  }

  private async inference(model: string, messages: ChatMessage[]): Promise<Response> {
    await this.bootstrap();
    const jwt = this.sessionJwt!;
    const body = buildVeniceBody(model || "venice-default", messages, this.userId);
    let res: Response;
    try {
      res = await this.fetchFn(VENICE_INFERENCE_URL, {
        method: "POST",
        headers: this.veniceHeaders(jwt),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new WebChatError(
        PROVIDER_ID,
        `venice: inference fetch failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
    harvestCookies(this.jar, res, VENICE_INFERENCE_URL);
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        // Mirror the executor: a rejected JWT is evicted so the next
        // call re-runs the Clerk exchange.
        this.sessionJwt = null;
        this.sessionJwtExpiresAt = 0;
      }
      const errText = await res.text().catch(() => "");
      throw new WebChatError(
        PROVIDER_ID,
        `venice: inference returned HTTP ${res.status}: ${errText.slice(0, 200)}`,
      );
    }
    return res;
  }

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    const res = await this.inference(model, messages);
    const text = await res.text();
    let out = "";
    for (const line of text.split("\n")) {
      const ev = parseVeniceLine(line);
      if (ev?.kind === "content" && ev.content) out += ev.content;
    }
    return out;
  }

  async *chatStream(model: string, messages: ChatMessage[]): AsyncGenerator<string> {
    const res = await this.inference(model, messages);
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const handle = (line: string): string => {
      const ev = parseVeniceLine(line);
      return ev?.kind === "content" && ev.content ? ev.content : "";
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const delta = handle(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
        if (delta) yield delta;
      }
    }
    const tail = handle(buf);
    if (tail) yield tail;
  }
}
