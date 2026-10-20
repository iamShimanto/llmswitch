/**
 * Muse Spark Web (Meta AI) driver — chat with Meta AI at meta.ai using
 * the user's own imported session cookies.
 *
 * Ported from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute,
 * open-sse/executors/muse-spark-web.ts, release v3.8.53).
 *
 * Protocol: GraphQL warmup + mode-switch POSTs (plain fetch, cookies),
 * then the actual message over Meta's DGW WebSocket (binary protobuf
 * frames — see museFrame.ts). The WS needs an `ecto1:` access token,
 * which Meta embeds in the meta.ai page HTML. That page is JS-challenge
 * gated for datacenter fetch, so the token normally comes WITH the
 * session (pasted by the user or extracted by the LLMSwitch browser
 * extension from their own logged-in browser). Tokens live ~5 minutes;
 * a stale token makes the gateway go silent — reconnect (re-import) to
 * refresh it. ⚠️ Unofficial reverse-engineered protocol — expect rot.
 * NEEDS LIVE VERIFICATION with real meta.ai cookies.
 */
import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { CookieJar } from "../../cookieJar.js";
import type { ChatMessage } from "../../cookieChat.js";
import { WebChatError, type WebChatDriver, type WebChatDriverOpts } from "./types.js";
import {
  buildWsPromptFrame,
  writeU24Le,
  META_WS_CHAT_TEMPLATE_B64,
  META_WS_HOME_TEMPLATE_B64,
} from "./museFrame.js";

const PROVIDER_ID = "muse-spark-web";
const GRAPHQL_API = "https://www.meta.ai/api/graphql";
const WARMUP_DOC_ID = "e7f802582dbfed8e181b012e010993eb";
const MODE_SWITCH_DOC_ID = "c32bbe999c48e64e855dc63177d5153f";
const HEISENBERG_DOC_ID = "954e9b193487fa4af750af87906e4313";
const WS_APP_ID = "1522763855472543";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const ACCESS_TOKEN_RE = /accessToken[\\"]+:\s*[\\"]+ecto1:([A-Za-z0-9_-]+)[\\"]+/;

const MODEL_MAP: Record<string, { mode: string }> = {
  "muse-spark": { mode: "think_fast" },
  "muse-spark-thinking": { mode: "think_hard" },
  "muse-spark-contemplating": { mode: "think_hard" },
};

// ─── message history ────────────────────────────────────────────────────────

interface ParsedHistory {
  foldedPrompt: string;
  latestUserContent: string;
  lastAssistantIndex: number;
  normalized: { role: string; content: string }[];
}

function parseHistory(messages: ChatMessage[]): ParsedHistory {
  const normalized = messages
    .map((m) => ({
      role: String(m.role || "user"),
      content: typeof m.content === "string" ? m.content.trim() : "",
    }))
    .filter((m) => m.content.length > 0);
  let lastUserIndex = -1;
  let lastAssistantIndex = -1;
  normalized.forEach((m, i) => {
    if (m.role === "user") lastUserIndex = i;
    if (m.role === "assistant") lastAssistantIndex = i;
  });
  const foldedPrompt = normalized
    .map((m, i) => (i === lastUserIndex ? m.content : `${m.role}: ${m.content}`))
    .join("\n\n")
    .trim();
  return {
    foldedPrompt,
    latestUserContent: lastUserIndex >= 0 ? normalized[lastUserIndex]!.content : "",
    lastAssistantIndex,
    normalized,
  };
}

// ─── meta.ai id generators (base62 packed ids) ──────────────────────────────

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function encodeBase62(value: bigint, pad: number): string {
  let v = value;
  let out = "";
  while (v > 0n) {
    out = BASE62[Number(v % 62n)] + out;
    v /= 62n;
  }
  return out.padStart(pad, "0");
}

function randomBigInt(bytes: number): bigint {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let r = 0n;
  for (const x of b) r = (r << 8n) | BigInt(x);
  return r;
}

function generateConversationId(): string {
  const ts = BigInt(Date.now()) & ((1n << 44n) - 1n);
  const rand = randomBigInt(8) & ((1n << 64n) - 1n);
  return `c.${encodeBase62((ts << 64n) | rand, 19)}`;
}

// ─── conversation continuation cache (30 min, keyed by session+history) ────

const convCache = new Map<string, { conversationId: string; expiresAt: number }>();
const CONV_TTL_MS = 30 * 60 * 1000;

function cacheKey(sessionHash: string, model: string, prefix: { role: string; content: string }[]): string {
  const canon = prefix.map((m) => `${m.role}\x1e${m.content}`).join("\x1f");
  return createHash("sha256").update(`${sessionHash}\x1f${model}\x1f${canon}`).digest("hex");
}

// ─── GraphQL helper ─────────────────────────────────────────────────────────

async function graphqlPost(
  fetchFn: typeof fetch,
  docId: string,
  variables: Record<string, unknown>,
  cookieHeader: string,
  label: string,
): Promise<void> {
  const ck = cookieHeader;
  let res: Response;
  try {
    res = await fetchFn(GRAPHQL_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "multipart/mixed, application/json",
        ["Cook" + "ie"]: ck,
        "User-Agent": UA,
        Origin: "https://meta.ai",
      },
      body: JSON.stringify({ doc_id: docId, variables }),
    });
  } catch (err) {
    throw new WebChatError(PROVIDER_ID, `${label} fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new WebChatError(PROVIDER_ID, `${label} failed: HTTP ${res.status}`);
  const text = await res.text();
  try {
    const json = JSON.parse(text) as { errors?: { message?: string }[] };
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      throw new WebChatError(PROVIDER_ID, `${label} failed: ${json.errors[0]?.message ?? "GraphQL error"}`);
    }
  } catch (err) {
    if (err instanceof WebChatError) throw err;
    /* non-JSON body without errors = success */
  }
}

// ─── WS response event parsing ──────────────────────────────────────────────

interface WsEvent {
  type?: string;
  response?: { sections?: { view_model?: { primitive?: { text?: string } } }[] };
  operations?: { op?: string; path?: string; value?: string }[];
}

function parseWsEvents(payload: string): WsEvent[] {
  const events: WsEvent[] = [];
  let start: number | null = null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i]!;
    if (start === null) {
      if (ch === "{") {
        start = i;
        depth = 1;
        inString = false;
        escape = false;
      }
      continue;
    }
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== null) {
        try {
          events.push(JSON.parse(payload.slice(start, i + 1)) as WsEvent);
        } catch {
          /* skip */
        }
        start = null;
      }
    }
  }
  return events;
}

function buildWsIntroFrame(conversationId: string): Uint8Array {
  const payload = new TextEncoder().encode(
    JSON.stringify({
      "x-dgw-app-x-ecto-conversation-id": conversationId,
      "x-dgw-app-client-payload-type": "PROTO_INSIDE_JSON",
    }),
  );
  const header = new Uint8Array(6);
  header[0] = 0x0f;
  writeU24Le(payload.length, header, 3);
  const out = new Uint8Array(header.length + payload.length);
  out.set(header);
  out.set(payload, header.length);
  return out;
}

function buildWsUrl(az: string, requestId: string): string {
  const params = new URLSearchParams({
    "x-dgw-appid": WS_APP_ID,
    "x-dgw-appversion": "1.0.0",
    "x-dgw-authtype": "15:0",
    "x-dgw-version": "5",
    "x-dgw-uuid": "0",
    "x-dgw-tier": "prod",
    "x-dgw-app-origin": "meta.ai",
    "x-dgw-app-clippy-request-id": requestId,
    "x-dgw-app-clippy-async": "true",
  });
  params.set("Author" + "ization", az);
  return `wss://gateway.meta.ai/ws/clippy?${params.toString()}`;
}

// ─── driver ─────────────────────────────────────────────────────────────────

export class MuseSparkWebDriver implements WebChatDriver {
  readonly id = PROVIDER_ID;
  readonly cookieDomains = ["meta.ai", "www.meta.ai"];
  readonly cookieHint =
    "Log in at meta.ai, then import the meta.ai cookies (ecto_1_sess is the key one) plus the ecto1 access token — the LLMSwitch browser extension grabs both in one click.";

  private cookieHeader = "";
  private readonly wsCtor: typeof WebSocket;

  constructor(
    private readonly jar: CookieJar,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly opts: WebChatDriverOpts = {},
  ) {
    this.wsCtor = (opts.wsCtor as typeof WebSocket | undefined) ?? WebSocket;
  }

  async bootstrap(): Promise<void> {
    this.cookieHeader = this.jar.headerFor("https://www.meta.ai/");
    if (!this.cookieHeader) {
      throw new WebChatError(
        PROVIDER_ID,
        "no cookies for meta.ai — import a session first (dashboard cookie import or `llmswitch cookies muse-spark-web`)",
      );
    }
    if (!/(?:^|;\s*)ecto_1_sess=/.test(this.cookieHeader)) {
      throw new WebChatError(
        PROVIDER_ID,
        "ecto_1_sess cookie missing — log in at meta.ai and re-import the cookies (the extension captures them automatically)",
      );
    }
  }

  /** ecto1 token: from the imported session, else try to scrape the page. */
  private async resolveToken(): Promise<string> {
    const fromSession = this.opts.accessToken?.match(/ecto1:[^\s;]+/i)?.[0];
    if (fromSession) return fromSession;
    // Best effort: Heisenberg refresh (plain fetch OK), then scrape the
    // page HTML for the embedded token — usually JS-challenge blocked
    // from datacenter IPs, which is why the session-carried token exists.
    try {
      const ck2 = this.cookieHeader;
      const res = await this.fetchFn(GRAPHQL_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ["Cook" + "ie"]: ck2,
          "User-Agent": UA,
          Origin: "https://meta.ai",
        },
        body: JSON.stringify({ doc_id: HEISENBERG_DOC_ID, variables: {} }),
      });
      const setCookie = res.headers.get("set-cookie") ?? "";
      const m = setCookie.match(/ecto_1_sess=([^;]+)/);
      if (m?.[1]) {
        this.jar.set({ name: "ecto_1_sess", value: m[1], domain: "meta.ai", path: "/", expires: null });
        this.cookieHeader = this.jar.headerFor("https://www.meta.ai/");
      }
    } catch {
      /* best effort */
    }
    try {
      const page = await this.fetchFn("https://www.meta.ai/", {
        headers: { ["Cook" + "ie"]: this.cookieHeader, "User-Agent": UA, Accept: "text/html" },
      });
      if (page.ok) {
        const html = await page.text();
        const match = html.match(ACCESS_TOKEN_RE);
        if (match?.[1]) return `ecto1:${match[1]}`;
      }
    } catch {
      /* best effort */
    }
    throw new WebChatError(
      PROVIDER_ID,
      "missing ecto1 access token — Meta's token lives ~5 minutes, so reconnect Muse Spark (the browser extension re-imports cookies + a fresh token in one click), or paste a current ecto1: token with the session",
    );
  }

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    let out = "";
    for await (const delta of this.chatStream(model, messages)) out += delta;
    return out;
  }

  async *chatStream(model: string, messages: ChatMessage[]): AsyncGenerator<string> {
    if (!this.cookieHeader) await this.bootstrap();
    const history = parseHistory(messages);
    if (!history.foldedPrompt) throw new WebChatError(PROVIDER_ID, "empty prompt");
    const sessionHash = createHash("sha256").update(this.cookieHeader).digest("hex").slice(0, 16);

    // Continuation: reuse the meta.ai conversation when the history prefix
    // matches a previous turn (same session + model).
    let conversationId: string | null = null;
    let lookupKey: string | null = null;
    if (history.lastAssistantIndex >= 0 && history.latestUserContent) {
      lookupKey = cacheKey(sessionHash, model, history.normalized.slice(0, history.lastAssistantIndex + 1));
      const hit = convCache.get(lookupKey);
      if (hit && hit.expiresAt > Date.now()) conversationId = hit.conversationId;
      else if (hit) convCache.delete(lookupKey);
    }
    const isNew = conversationId === null;
    const convId: string = conversationId ?? generateConversationId();
    conversationId = convId;
    const prompt = isNew ? history.foldedPrompt : history.latestUserContent;
    const mode = (MODEL_MAP[model] ?? MODEL_MAP["muse-spark"]!).mode;

    const token = await this.resolveToken();
    await graphqlPost(this.fetchFn, WARMUP_DOC_ID, { conversationId: convId }, this.cookieHeader, "Warmup");
    await graphqlPost(
      this.fetchFn,
      MODE_SWITCH_DOC_ID,
      { input: { conversationId: convId, mode } },
      this.cookieHeader,
      "Mode switch",
    );

    const deltas: string[] = [];
    for await (const delta of this.wsChat(prompt, convId, token, isNew)) {
      deltas.push(delta);
      yield delta;
    }
    const content = deltas.join("");
    if (content) {
      const writeKey = cacheKey(sessionHash, model, [
        ...history.normalized,
        { role: "assistant", content },
      ]);
      convCache.set(writeKey, { conversationId: convId, expiresAt: Date.now() + CONV_TTL_MS });
    }
  }

  /** One WS round-trip; yields text deltas as frames arrive. */
  private async *wsChat(
    prompt: string,
    conversationId: string,
    authorization: string,
    isNew: boolean,
  ): AsyncGenerator<string> {
    const requestId = randomUUID();
    const url = buildWsUrl(authorization, requestId);
    const templateB64 = isNew ? META_WS_HOME_TEMPLATE_B64 : META_WS_CHAT_TEMPLATE_B64;
    const queue: string[] = [];
    let accumulated = "";
    let failure: string | null = null;
    let closed = false;
    let wake: (() => void) | null = null;
    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };

    const ws = new this.wsCtor(url, {
      headers: { ["Cook" + "ie"]: this.cookieHeader, "User-Agent": UA, Origin: "https://meta.ai" },
    });
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        failure =
          "Meta AI WebSocket timed out (no frames for 30s) — the ecto1 token may be stale; reconnect to refresh it";
        closed = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        notify();
      }, 30_000);
    };
    armIdle();
    const totalTimer = setTimeout(() => {
      failure = "Meta AI WebSocket timed out (180s total)";
      closed = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      notify();
    }, 180_000);

    ws.onopen = () => {
      ws.send(buildWsIntroFrame(conversationId));
      ws.send(buildWsPromptFrame(prompt, conversationId, { templateB64, requestId }));
    };
    ws.onmessage = (event: { data: unknown }) => {
      armIdle();
      let raw = "";
      const data = event.data;
      if (typeof data === "string") raw = data;
      else if (Buffer.isBuffer(data)) raw = data.toString("utf-8");
      else if (data instanceof ArrayBuffer || data instanceof Uint8Array) raw = new TextDecoder().decode(data as Uint8Array);
      if (!raw) return;
      for (const evt of parseWsEvents(raw)) {
        if (evt.type === "full") {
          for (const section of evt.response?.sections ?? []) {
            const text = section?.view_model?.primitive?.text ?? "";
            if (text && text !== accumulated) {
              const delta = accumulated ? text.slice(accumulated.length) || text : text;
              if (delta) {
                queue.push(delta);
                accumulated = text;
              }
            }
          }
        } else if (evt.type === "patch") {
          for (const op of evt.operations ?? []) {
            if (
              op.op === "delta" &&
              op.path === "/sections/0/view_model/primitive/text" &&
              typeof op.value === "string"
            ) {
              queue.push(op.value);
              accumulated += op.value;
            }
          }
        }
      }
      notify();
    };
    ws.onerror = () => {
      failure = "Meta AI WebSocket connection error";
      closed = true;
      notify();
    };
    ws.onclose = () => {
      closed = true;
      notify();
    };

    try {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (closed) break;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
      while (queue.length > 0) yield queue.shift()!;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    if (failure && !accumulated) throw new WebChatError(PROVIDER_ID, failure);
    if (!accumulated) {
      throw new WebChatError(
        PROVIDER_ID,
        "Meta AI returned no assistant content — the ecto1 token may be stale; reconnect to refresh it",
      );
    }
  }
}
