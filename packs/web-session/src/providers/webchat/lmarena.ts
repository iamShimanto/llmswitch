/**
 * LmArenaDriver — Arena (formerly LMArena, arena.ai) cookie web chat.
 *
 * Ported from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, release v3.8.53).
 * Source paths in OmniRoute:
 *   open-sse/executors/lmarena.ts
 *   open-sse/executors/lmarena/{cookie,models,stream,response,clientInteraction}.ts
 *   open-sse/config/providers/registry/lmarena/index.ts (+ directModels.ts)
 *
 * Protocol (as coded upstream):
 *   POST https://arena.ai/nextjs-api/stream/create-evaluation
 *   JSON body:
 *     { id: <uuid v7>, mode: "direct-battle", modelAId: <arena model UUID>,
 *       userMessageId: <uuid v7>, modelAMessageId: <uuid v7>,
 *       userMessage: { content: <flattened prompt>,
 *                      experimental_attachments: [], metadata: {} },
 *       modality: "chat", recaptchaV3Token: null }
 *   Auth: session cookies from arena.ai. Supabase SSR splits the
 *   `arena-auth-prod-v1` cookie across `.0`, `.1`, … chunks; when no whole
 *   cookie is present the chunks are joined back into one (ported from
 *   lmarena/cookie.ts). Upstream's missing-cookie guidance also asks for
 *   `cf_clearance` when present — the jar header is sent as imported.
 *   Response: AI-SDK-style SSE lines, optionally participant-prefixed
 *   (`a`/`b` before the code):
 *     0:<json string>  text delta        g:<json>  thinking delta (skipped)
 *     2:<json>         heartbeat         3:<json>  error
 *     d:{finishReason} done              legacy [ab]e:<json>  error
 *
 * ⚠️ NEEDS LIVE VERIFICATION: mock-tested only, and two upstream facts make
 * live success uncertain from here:
 *   - Upstream does NOT use plain fetch: arena.ai sits behind Cloudflare and
 *     OmniRoute routes through wreq-js Chrome TLS impersonation
 *     (services/lmarenaTlsClient.ts). Plain fetch may be bot-blocked (403).
 *   - `modelAId` must be an arena model UUID. Upstream resolves names via a
 *     scraped seed catalog (registry/lmarena/directModels.ts, not ported);
 *     this driver passes UUID-shaped models through and sends any other
 *     model string as-is, which upstream may reject.
 *   - Upstream omits the `cx` client-interaction field unless an operator
 *     supplies one, and sends `recaptchaV3Token: null` unless a browser
 *     token is supplied; both defaults are mirrored here.
 */
import type { CookieJar } from "../../cookieJar.js";
import {
  WebChatError,
  harvestCookies,
  requireCookieHeader,
  type ChatMessage,
  type WebChatDriver,
} from "./types.js";

const ARENA_BASE = "https://arena.ai";
const STREAM_URL = `${ARENA_BASE}/nextjs-api/stream/create-evaluation`;
const AUTH_COOKIE = "arena-auth-prod-v1";
const MODEL_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 9562 UUID v7 (time-ordered), as upstream's uuidv7() produces. */
function uuidv7(): string {
  const msHex = Date.now().toString(16).padStart(12, "0");
  const rand = [...crypto.getRandomValues(new Uint8Array(10))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const variant = (8 + (parseInt(rand[3]!, 16) & 3)).toString(16);
  return `${msHex.slice(0, 8)}-${msHex.slice(8)}-7${rand.slice(0, 3)}-${variant}${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

/**
 * Rebuild the single `arena-auth-prod-v1` cookie from Supabase SSR chunks
 * (port of upstream reconstructLMArenaCookie, cookie-header in/out).
 */
export function reconstructLMArenaCookie(rawCookie: string): string {
  if (!rawCookie?.trim()) return rawCookie;
  const pairs: Array<{ name: string; value: string }> = [];
  for (const part of rawCookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    pairs.push({ name, value: part.slice(eq + 1).trim() });
  }
  const existing = pairs.find((p) => p.name === AUTH_COOKIE);
  if (existing?.value) return rawCookie;

  const chunkPrefix = `${AUTH_COOKIE}.`;
  const chunks = new Map<number, string>();
  for (const { name, value } of pairs) {
    if (!name.startsWith(chunkPrefix)) continue;
    const idxRaw = name.slice(chunkPrefix.length);
    if (!/^\d+$/.test(idxRaw)) continue;
    chunks.set(Number(idxRaw), value);
  }
  const joinedParts: string[] = [];
  for (let i = 0; chunks.has(i); i++) joinedParts.push(chunks.get(i) ?? "");
  const joined = joinedParts.join("");
  if (!joined) return rawCookie;

  const preserved = pairs.filter(
    (p) => p.name !== AUTH_COOKIE && !p.name.startsWith(chunkPrefix),
  );
  return [
    `${AUTH_COOKIE}=${joined}`,
    ...preserved.map((p) => `${p.name}=${p.value}`),
  ].join("; ");
}

/** Flatten messages into Arena's single prompt string (upstream formatArenaPrompt). */
function formatArenaPrompt(messages: ChatMessage[]): string {
  const rendered = messages
    .map((m) => {
      const text = (m.content ?? "").trim();
      if (!text) return "";
      const label =
        m.role === "system"
          ? "System"
          : m.role === "assistant"
            ? "Assistant"
            : "User";
      return `${label}: ${text}`;
    })
    .filter(Boolean);
  if (rendered.length === 1 && messages[0]?.role === "user") {
    return (messages[0].content ?? "").trim();
  }
  return rendered.join("\n\n");
}

interface ArenaEvent {
  type: "text" | "thinking" | "error" | "done" | "heartbeat";
  content?: string;
}

function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function pickString(value: unknown, keys: string[]): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const data = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = data[key];
    if (typeof candidate === "string") return candidate;
  }
  return JSON.stringify(value);
}

/** Parse one Arena SSE line (port of upstream parseArenaSSE). */
export function parseArenaSSE(line: string): ArenaEvent | null {
  const trimmed = line.trim();
  const payload = trimmed.startsWith("data: ")
    ? trimmed.substring(6).trim()
    : trimmed;
  if (!payload) return null;

  const legacyError = payload.match(/^[ab]e:(.*)$/);
  if (legacyError) {
    const value = parseJsonValue(legacyError[1] ?? "");
    const content = pickString(value, ["error", "message"]);
    return content ? { type: "error", content } : null;
  }

  const participantPrefixed = payload.match(/^[ab]([023dfg]):(.*)$/);
  const normalized = participantPrefixed
    ? `${participantPrefixed[1]}:${participantPrefixed[2]}`
    : payload;
  const separator = normalized.indexOf(":");
  if (separator < 0) return null;

  const code = normalized.slice(0, separator);
  const value = parseJsonValue(normalized.slice(separator + 1));

  switch (code) {
    case "0":
      return { type: "text", content: pickString(value, ["text", "textDelta"]) };
    case "g":
      return {
        type: "thinking",
        content: pickString(value, ["thinking", "text", "textDelta"]),
      };
    case "2":
      return { type: "heartbeat" };
    case "3":
      return { type: "error", content: pickString(value, ["error", "message"]) };
    case "d": {
      if (
        value &&
        typeof value === "object" &&
        (value as Record<string, unknown>).finishReason === "error"
      ) {
        return { type: "error", content: "Arena stream finished with an error" };
      }
      return { type: "done" };
    }
    default:
      return null;
  }
}

async function* bodyLines(
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
      yield buf.slice(0, idx);
      buf = buf.slice(idx + 1);
    }
  }
  if (buf) yield buf;
}

export class LmArenaDriver implements WebChatDriver {
  readonly id = "lmarena";
  readonly cookieDomains = ["arena.ai"];
  readonly cookieHint =
    "log in at arena.ai and import its cookies (needs the arena-auth-prod-v1 session cookie, incl. its .0/.1 chunks, and cf_clearance when present)";

  private bootstrapped = false;
  private cookieHeader = "";

  constructor(
    private jar: CookieJar,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    const raw = requireCookieHeader(this.jar, STREAM_URL, this.id, this.cookieHint);
    this.cookieHeader = reconstructLMArenaCookie(raw);
    this.bootstrapped = true;
  }

  private buildPayload(model: string, messages: ChatMessage[]) {
    return {
      id: uuidv7(),
      mode: "direct-battle",
      // UUIDs pass through; other names are sent as-is (see header note).
      modelAId: MODEL_ID_RE.test(model.trim()) ? model.trim() : model,
      userMessageId: uuidv7(),
      modelAMessageId: uuidv7(),
      userMessage: {
        content: formatArenaPrompt(messages),
        experimental_attachments: [] as unknown[],
        metadata: {},
      },
      modality: "chat",
      recaptchaV3Token: null as string | null,
    };
  }

  async *chatStream(
    model: string,
    messages: ChatMessage[],
  ): AsyncGenerator<string> {
    await this.bootstrap();
    const payload = this.buildPayload(model, messages);
    const res = await this.fetchFn(STREAM_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        pragma: "no-cache",
        origin: ARENA_BASE,
        referer: `${ARENA_BASE}/`,
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        cookie: this.cookieHeader,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
    harvestCookies(this.jar, res, STREAM_URL);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new WebChatError(
          this.id,
          `Arena auth/bot check failed (HTTP ${res.status}) — session cookie may be expired, or Cloudflare blocked the request (upstream uses browser TLS impersonation): ${text.slice(0, 200)}`,
        );
      }
      throw new WebChatError(
        this.id,
        `Arena returned HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    if (!res.body) throw new WebChatError(this.id, "Arena returned empty response body");

    for await (const line of bodyLines(res.body)) {
      const event = parseArenaSSE(line);
      if (!event) continue;
      if (event.type === "error") {
        throw new WebChatError(this.id, event.content || "Arena stream error");
      }
      if (event.type === "text" && event.content) yield event.content;
      if (event.type === "done") return;
    }
  }

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    let out = "";
    for await (const delta of this.chatStream(model, messages)) out += delta;
    return out;
  }
}
