/**
 * CopilotWebDriver — Microsoft Copilot web chat driven over the site's own
 * WebSocket protocol, using the user's imported browser cookies.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53):
 *   - open-sse/config/providers/registry/copilot-web/index.ts
 *     (baseUrl wss://copilot.microsoft.com/c/api/chat?api-version=2)
 *   - open-sse/executors/copilot-web.ts
 *     (conversation creation, WS chat frames, hashcash challenge)
 *
 * Protocol (from OmniRoute's executor):
 *   1. POST https://copilot.microsoft.com/c/api/start -> conversationId
 *      (Authorization: Bearer <access_token> when available; anonymous otherwise)
 *   2. WS connect wss://copilot.microsoft.com/c/api/chat?api-version=2
 *      with query params clientSessionId=<uuid> and (when available)
 *      accessToken=<access_token>. Node's global WebSocket cannot set custom
 *      headers, so auth rides in the query string — exactly as OmniRoute does.
 *   3. Send { event: "send", conversationId, content: [{type:"text",text}],
 *      mode } where mode is chat|reasoning|smart.
 *   4. Receive JSON events: appendText (deltas), done, error, and possibly a
 *      hashcash "challenge" that must be answered with "challengeResponse".
 *
 * ⚠️ Reverse-engineered protocol — it rots. Mock-tested only.
 * NEEDS LIVE VERIFICATION: the exact WS event shapes, whether the
 * accessToken query param is still accepted for WS auth, and whether an
 * `access_token` cookie is present in a real imported session (the driver
 * also works anonymously with limited models, per OmniRoute).
 */
import { createHash, randomUUID } from "node:crypto";
import type { CookieJar } from "../../cookieJar.js";
import type { ChatMessage } from "../../cookieChat.js";
import {
  BROWSER_UA,
  WebChatError,
  requireCookieHeader,
  type WebChatDriver,
} from "./types.js";

const COPILOT_BASE = "https://copilot.microsoft.com";
const COPILOT_START_URL = `${COPILOT_BASE}/c/api/start`;
const COPILOT_WS_URL = "wss://copilot.microsoft.com/c/api/chat?api-version=2";

const WS_CONNECT_TIMEOUT_MS = 15_000;
const WS_IDLE_TIMEOUT_MS = 120_000;

/** OmniRoute model id -> Copilot "mode" (executors/copilot-web.ts MODEL_MODE_MAP). */
const MODEL_MODE_MAP: Record<string, string> = {
  copilot: "chat",
  "copilot-chat": "chat",
  "gpt-4o": "chat",
  "gpt-4": "chat",
  "gpt-4-turbo": "chat",
  "copilot-study": "chat",
  "copilot-think": "reasoning",
  "copilot-think-deeper": "reasoning",
  o1: "reasoning",
  o3: "reasoning",
  "copilot-smart": "smart",
  "copilot-gpt5": "smart",
  "gpt-5": "smart",
};

/* @internal — exported for tests */
export function copilotMode(model?: string): string {
  if (!model) return "chat";
  return MODEL_MODE_MAP[model.toLowerCase()] ?? "chat";
}

/**
 * Hashcash solver, ported from OmniRoute (solveHashcash). Difficulty is clamped
 * to 8 hex zeros so a malicious/buggy server cannot force unbounded work.
 */
/* @internal — exported for tests */
export function solveHashcash(parameter: string, difficulty: number): number | null {
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 8) return null;
  const prefix = "0".repeat(difficulty);
  for (let i = 0; i < 10_000_000; i++) {
    const hash = createHash("sha256").update(`${parameter}:${i}`).digest("hex");
    if (hash.startsWith(prefix)) return i;
  }
  return null;
}

/* @internal — exported for tests */
export function buildCopilotWsUrl(accessToken?: string): string {
  const url = new URL(COPILOT_WS_URL);
  url.searchParams.set("clientSessionId", randomUUID());
  if (accessToken) url.searchParams.set("accessToken", accessToken);
  return url.toString();
}

/** Pull an `access_token` value out of a raw Cookie header, if present. */
function extractAccessToken(cookieHeader: string): string | undefined {
  for (const pair of cookieHeader.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (name?.trim() === "access_token") {
      const v = rest.join("=").trim();
      if (v) return v;
    }
  }
  return undefined;
}

/** Minimal WebSocket surface the driver needs (matches the browser API). */
export interface CopilotSocket {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((err: unknown) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type CopilotSocketFactory = (url: string) => CopilotSocket;

function defaultSocketFactory(url: string): CopilotSocket {
  const WS = (globalThis as { WebSocket?: new (u: string) => CopilotSocket }).WebSocket;
  if (!WS) {
    throw new WebChatError(
      "copilot-web",
      "no global WebSocket available — pass a socket factory to CopilotWebDriver",
    );
  }
  return new WS(url);
}

interface CopilotWsEvent {
  event: string;
  text?: string;
  method?: string;
  parameter?: string;
  error?: string;
  [key: string]: unknown;
}

/** Async queue over a socket: resolves open, yields parsed JSON messages. */
class WsEventQueue {
  private pending: CopilotWsEvent[] = [];
  private waiters: Array<(ev: CopilotWsEvent | null) => void> = [];
  private opened = false;
  private openWaiters: Array<() => void> = [];
  private failed: unknown = null;
  private closed = false;

  constructor(private socket: CopilotSocket) {
    socket.onopen = () => {
      this.opened = true;
      for (const w of this.openWaiters.splice(0)) w();
    };
    socket.onmessage = (ev) => {
      let parsed: CopilotWsEvent;
      try {
        parsed = typeof ev.data === "string" ? JSON.parse(ev.data) : JSON.parse(String(ev.data));
      } catch {
        return; // skip unparseable frames, like OmniRoute
      }
      const w = this.waiters.shift();
      if (w) w(parsed);
      else this.pending.push(parsed);
    };
    socket.onerror = (err) => {
      this.failed = err;
      for (const w of this.waiters.splice(0)) w(null);
      for (const w of this.openWaiters.splice(0)) w();
    };
    socket.onclose = () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w(null);
      for (const w of this.openWaiters.splice(0)) w();
    };
  }

  waitForOpen(timeoutMs: number): Promise<void> {
    if (this.opened) return Promise.resolve();
    if (this.failed !== null || this.closed) {
      return Promise.reject(
        new WebChatError("copilot-web", "Copilot WebSocket failed before opening"),
      );
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new WebChatError("copilot-web", "Copilot WebSocket connect timeout"));
      }, timeoutMs);
      this.openWaiters.push(() => {
        clearTimeout(t);
        if (this.failed !== null || this.closed) {
          reject(new WebChatError("copilot-web", "Copilot WebSocket failed before opening"));
        } else resolve();
      });
    });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<CopilotWsEvent> {
    const idle = setTimeout(() => {
      for (const w of this.waiters.splice(0)) w(null);
    }, WS_IDLE_TIMEOUT_MS);
    try {
      for (;;) {
        const ev = this.pending.shift() ?? (await new Promise<CopilotWsEvent | null>((r) => this.waiters.push(r)));
        if (ev === null) return; // error / close / idle
        yield ev;
      }
    } finally {
      clearTimeout(idle);
    }
  }
}

export class CopilotWebDriver implements WebChatDriver {
  readonly id = "copilot-web";
  readonly cookieDomains = ["copilot.microsoft.com"];
  readonly cookieHint =
    "sign in at copilot.microsoft.com in your browser, then import the session cookies";

  private cookie = "";
  private accessToken?: string;

  constructor(
    private jar: CookieJar,
    private fetchFn: typeof fetch = fetch,
    private socketFactory: CopilotSocketFactory = defaultSocketFactory,
  ) {}

  async bootstrap(): Promise<void> {
    // Idempotent: re-read the (possibly refreshed) cookie header each call.
    this.cookie = requireCookieHeader(this.jar, COPILOT_BASE, this.id, this.cookieHint);
    this.accessToken = extractAccessToken(this.cookie);
  }

  private async startConversation(): Promise<string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": BROWSER_UA,
      origin: COPILOT_BASE,
      referer: `${COPILOT_BASE}/`,
      cookie: this.cookie,
    };
    if (this.accessToken) headers["authorization"] = `Bearer ${this.accessToken}`;
    const res = await this.fetchFn(COPILOT_START_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        timeZone: "America/New_York",
        startNewConversation: true,
        teenSupportEnabled: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new WebChatError(
        this.id,
        `Copilot /c/api/start failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as {
      currentConversationId?: string;
      conversationId?: string;
    };
    const convId = data.currentConversationId || data.conversationId;
    if (!convId) throw new WebChatError(this.id, "Copilot /c/api/start returned no conversationId");
    return convId;
  }

  private static buildPrompt(messages: ChatMessage[]): string {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userText = lastUser?.content ?? "";
    return system ? `[System Instructions]\n${system}\n\n${userText}` : userText;
  }

  async *chatStream(model: string, messages: ChatMessage[]): AsyncGenerator<string> {
    await this.bootstrap();
    const conversationId = await this.startConversation();
    const prompt = CopilotWebDriver.buildPrompt(messages);
    if (!prompt.trim()) throw new WebChatError(this.id, "no user message provided");

    const socket = this.socketFactory(buildCopilotWsUrl(this.accessToken));
    const events = new WsEventQueue(socket);
    try {
      await events.waitForOpen(WS_CONNECT_TIMEOUT_MS);
      socket.send(
        JSON.stringify({
          event: "send",
          conversationId,
          content: [{ type: "text", text: prompt }],
          mode: copilotMode(model),
        }),
      );
      for await (const ev of events) {
        switch (ev.event) {
          case "appendText":
          case "replaceText":
            if (typeof ev.text === "string" && ev.text) yield ev.text;
            break;
          case "challenge":
            // OmniRoute answers a hashcash challenge then re-sends; here the
            // send frame is idempotent-safe so we answer and keep streaming.
            if (ev.method === "hashcash" && typeof ev.parameter === "string") {
              const [param, diff] = ev.parameter.split(":");
              const solution = solveHashcash(param ?? "", parseInt(diff ?? "1", 10));
              socket.send(
                JSON.stringify({
                  event: "challengeResponse",
                  token: solution === null ? "" : String(solution),
                  method: "hashcash",
                }),
              );
            } else {
              throw new WebChatError(
                this.id,
                `unsupported Copilot challenge "${ev.method ?? "unknown"}" — NEEDS LIVE VERIFICATION`,
              );
            }
            break;
          case "done":
            return;
          case "error":
            throw new WebChatError(
              this.id,
              `Copilot stream error: ${typeof ev.error === "string" ? ev.error : "unknown"}`,
            );
          default:
            break; // ignore connected/received/citation/etc.
        }
      }
    } finally {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }
  }

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    let text = "";
    for await (const delta of this.chatStream(model, messages)) text += delta;
    return text;
  }
}
