/**
 * DeepSeekWebDriver — DeepSeek web chat (chat.deepseek.com) driven over the
 * site's own API, using the user's imported `user-token` cookie.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53):
 *   - open-sse/config/providers/registry/deepseek/web/index.ts
 *     (baseUrl https://chat.deepseek.com/api/v0/chat/completion)
 *   - open-sse/executors/deepseek-web.ts (token exchange, session, completion, SSE parse)
 *   - open-sse/executors/deepseek-web/pow.ts (create_pow_challenge request shape)
 *   - open-sse/executors/deepseek-web/stream-format.ts (fragment formatting)
 *   - open-sse/services/tokenExtractionConfig.ts (cookie `user-token` on .deepseek.com,
 *     also mirrored in the `userToken` localStorage key)
 *
 * Protocol (from OmniRoute's executor):
 *   1. POST /api/v0/users/current with `Authorization: Bearer <user-token>` ->
 *      short-lived access token at data.biz_data.token.
 *   2. POST /api/v0/chat_session/create {} -> data.biz_data.chat_session.id.
 *   3. POST /api/v0/chat/create_pow_challenge { target_path:
 *      "/api/v0/chat/completion" } -> a PoW challenge; the solved answer is
 *      sent to the completion call as the base64 JSON header
 *      `X-Ds-Pow-Response`.
 *   4. POST /api/v0/chat/completion { chat_session_id, parent_message_id:
 *      null, model_type, prompt, ref_file_ids, thinking_enabled,
 *      search_enabled, preempt } — the API takes a single `prompt` string,
 *      NOT a messages array. The reply is SSE: `data:` JSON objects keyed by
 *      `p` (path) and `v` (value) — response/fragments carry
 *      { type: "THINK"|"ANSWER"|"RESPONSE", content } fragments, and
 *      response/status === "FINISHED" marks a genuine completion.
 *
 * ⚠️ PoW: the challenge step is NEEDS LIVE VERIFICATION in this port. OmniRoute
 * solves "DeepSeekHashV1" in a WASM/worker (open-sse/lib/deepseek-pow*), which
 * is NOT ported here. The solver is pluggable — inject `powSolver` in the
 * constructor opts. Without one, chat() fails with an explanatory
 * WebChatError as soon as a challenge arrives.
 *
 * ⚠️ Reverse-engineered protocol — it rots. Mock-tested only.
 * NEEDS LIVE VERIFICATION: the userToken exchange response shape, the PoW
 * answer encoding, and the omission of OmniRoute's `x-hif-leim` attestation
 * header (obfuscated client JS; the completion endpoint did not enforce it
 * at OmniRoute's capture time).
 */
import type { CookieJar } from "../../cookieJar.js";
import type { ChatMessage } from "../../cookieChat.js";
import {
  BROWSER_UA,
  WebChatError,
  requireCookieHeader,
  sseDataLines,
  type WebChatDriver,
} from "./types.js";

const DEEPSEEK_WEB_BASE = "https://chat.deepseek.com";
const DEEPSEEK_API_BASE = `${DEEPSEEK_WEB_BASE}/api`;
const USERS_CURRENT_URL = `${DEEPSEEK_API_BASE}/v0/users/current`;
const SESSION_CREATE_URL = `${DEEPSEEK_API_BASE}/v0/chat_session/create`;
const SESSION_DELETE_URL = `${DEEPSEEK_API_BASE}/v0/chat_session/delete`;
const POW_CHALLENGE_URL = `${DEEPSEEK_API_BASE}/v0/chat/create_pow_challenge`;
const COMPLETION_URL = `${DEEPSEEK_API_BASE}/v0/chat/completion`;
export const COMPLETION_TARGET_PATH = "/api/v0/chat/completion";

/** Fingerprint headers the chat.deepseek.com web client sends (OmniRoute FAKE_HEADERS). */
const FAKE_HEADERS: Record<string, string> = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  origin: DEEPSEEK_WEB_BASE,
  referer: `${DEEPSEEK_WEB_BASE}/`,
  "user-agent": BROWSER_UA,
  "x-client-bundle-id": "com.deepseek.chat",
  "x-client-locale": "en-US",
  "x-client-platform": "web",
  "x-client-version": "2.0.0",
};

/** PoW challenge as returned by /api/v0/chat/create_pow_challenge. */
export interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  difficulty: number;
  expire_at: number;
  expire_after?: number;
  target_path: string;
}

/**
 * Pluggable PoW solver: given a challenge, return the `X-Ds-Pow-Response`
 * header value (base64 JSON in OmniRoute's encoding).
 */
export type DeepSeekPowSolver = (challenge: PowChallenge) => Promise<string>;

export interface DeepSeekWebDriverOptions {
  powSolver?: DeepSeekPowSolver;
}

function unfinishedPowSolver(): Promise<string> {
  return Promise.reject(
    new WebChatError(
      "deepseek-web",
      "DeepSeek PoW challenge solving is not implemented in this port — NEEDS LIVE VERIFICATION. " +
        "OmniRoute solves DeepSeekHashV1 in a WASM worker (open-sse/lib/deepseek-pow*); inject a " +
        "solver via DeepSeekWebDriverOptions.powSolver to enable completion calls.",
    ),
  );
}

/** OmniRoute generateFakeCookie(): plausible ancillary cookies for session calls. */
function fakeCookie(): string {
  const ts = Date.now();
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const uid = () =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  return `intercom-HWWAFSESTIME=${ts}; HWWAFSESID=${hex(18)}; Hm_lvt_${uid()}=${Math.floor(ts / 1000)}; _frid=${uid()}`;
}

/** Extract the `user-token` cookie value; it may be JSON-wrapped ({"value":"..."}). */
function extractUserToken(cookieHeader: string): string | null {
  for (const pair of cookieHeader.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (name?.trim() !== "user-token") continue;
    const raw = decodeURIComponent(rest.join("=").trim());
    try {
      const parsed = JSON.parse(raw) as { value?: unknown };
      if (typeof parsed?.value === "string") return parsed.value;
    } catch {
      /* not JSON — use raw */
    }
    return raw || null;
  }
  return null;
}

/** OmniRoute resolveModelOptions: map a model id to web-client flags. */
function resolveModelOptions(model: string): {
  modelType: string;
  thinkingEnabled: boolean;
  searchEnabled: boolean;
} {
  const m = model.toLowerCase();
  return {
    modelType: m.includes("pro") || m.includes("expert") ? "expert" : "default",
    thinkingEnabled: m.includes("r1") || m.includes("think") || m.includes("reason"),
    searchEnabled: m.includes("search"),
  };
}

/** Thinking model per OmniRoute stream-format.ts isThinkingModel(). */
function isThinkingModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("think") || m.includes("r1") || m.includes("reason");
}

/** OmniRoute cleanDeepSeekToken(): strip control tokens from content. */
function cleanToken(text: string): string {
  return text.replace(/FINISHED/g, "").replace(/^(SEARCH|WEB_SEARCH|SEARCHING)\s*/i, "");
}

/** OmniRoute messagesToPrompt(): system parts first, then a rolling transcript. */
function messagesToPrompt(messages: ChatMessage[]): string {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content.trim()).filter(Boolean);
  const convo = messages.filter((m) => m.role !== "system");
  const parts: string[] = [];
  if (systemParts.length) parts.push(systemParts.join("\n\n"));
  if (convo.length === 1) {
    parts.push(convo[0]!.content);
  } else if (convo.length > 1) {
    parts.push(
      convo
        .slice(-20) // DEFAULT_AUTO_HISTORY_WINDOW in OmniRoute
        .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
        .join("\n\n"),
    );
  }
  return parts.join("\n\n").replace(/!\[.*?\]\(.*?\)/g, "");
}

interface Fragment {
  type?: string;
  content?: string;
}

export class DeepSeekWebDriver implements WebChatDriver {
  readonly id = "deepseek-web";
  readonly cookieDomains = ["deepseek.com", "chat.deepseek.com"];
  readonly cookieHint =
    "sign in at chat.deepseek.com in your browser and import the `user-token` cookie for .deepseek.com";

  private accessToken: string | null = null;

  constructor(
    private jar: CookieJar,
    private fetchFn: typeof fetch = fetch,
    private opts: DeepSeekWebDriverOptions = {},
  ) {}

  private userToken(): string {
    const cookie = requireCookieHeader(this.jar, DEEPSEEK_WEB_BASE, this.id, this.cookieHint);
    const token = extractUserToken(cookie);
    if (!token) {
      throw new WebChatError(
        this.id,
        `no user-token cookie for chat.deepseek.com — import a session first: llmswitch cookies ${this.id} (${this.cookieHint})`,
      );
    }
    return token;
  }

  /**
   * Exchange the user-token for a short-lived access token via
   * /api/v0/users/current. Idempotent (cached until process restart).
   */
  async bootstrap(): Promise<void> {
    if (this.accessToken) return;
    const userToken = this.userToken();
    const res = await this.fetchFn(USERS_CURRENT_URL, {
      method: "GET",
      headers: {
        ...FAKE_HEADERS,
        authorization: `Bearer ${userToken}`,
        cookie: this.jar.headerFor(USERS_CURRENT_URL),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 || res.status === 403) {
      throw new WebChatError(
        this.id,
        "DeepSeek token invalid or expired — import a fresh user-token from chat.deepseek.com",
      );
    }
    if (!res.ok) throw new WebChatError(this.id, `DeepSeek users/current failed (HTTP ${res.status})`);
    const json = (await res.json()) as {
      code?: number;
      msg?: string;
      data?: { biz_data?: { token?: string } };
      biz_data?: { token?: string };
    };
    if (json?.code && json.code !== 0) {
      throw new WebChatError(this.id, `DeepSeek rejected the token: ${json.msg ?? `code ${json.code}`}`);
    }
    const token = json?.data?.biz_data?.token ?? json?.biz_data?.token;
    if (!token) throw new WebChatError(this.id, "DeepSeek users/current returned no access token");
    this.accessToken = token;
  }

  private async createSession(): Promise<string> {
    const res = await this.fetchFn(SESSION_CREATE_URL, {
      method: "POST",
      headers: {
        ...FAKE_HEADERS,
        "content-type": "application/json",
        authorization: `Bearer ${this.accessToken}`,
        cookie: fakeCookie(),
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new WebChatError(this.id, `DeepSeek chat_session/create failed (HTTP ${res.status})`);
    const json = (await res.json()) as {
      data?: { biz_data?: { chat_session?: { id?: string } } };
      biz_data?: { chat_session?: { id?: string } };
    };
    const id = json?.data?.biz_data?.chat_session?.id ?? json?.biz_data?.chat_session?.id;
    if (!id) throw new WebChatError(this.id, "DeepSeek chat_session/create returned no session id");
    return id;
  }

  private async deleteSession(sessionId: string): Promise<void> {
    // Best-effort cleanup, like OmniRoute's non-persistent default.
    try {
      await this.fetchFn(SESSION_DELETE_URL, {
        method: "POST",
        headers: {
          ...FAKE_HEADERS,
          "content-type": "application/json",
          authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({ chat_session_id: sessionId }),
      });
    } catch {
      /* ignore */
    }
  }

  private async getPowChallenge(): Promise<PowChallenge> {
    const res = await this.fetchFn(POW_CHALLENGE_URL, {
      method: "POST",
      headers: {
        ...FAKE_HEADERS,
        "content-type": "application/json",
        authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({ target_path: COMPLETION_TARGET_PATH }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new WebChatError(this.id, `DeepSeek create_pow_challenge failed (HTTP ${res.status})`);
    const json = (await res.json()) as {
      data?: { biz_data?: { challenge?: Record<string, unknown> } };
      biz_data?: { challenge?: Record<string, unknown> };
    };
    const challenge = json?.data?.biz_data?.challenge ?? json?.biz_data?.challenge;
    if (!challenge) throw new WebChatError(this.id, "DeepSeek create_pow_challenge returned no challenge");
    return { ...(challenge as unknown as PowChallenge), target_path: COMPLETION_TARGET_PATH };
  }

  async *chatStream(model: string, messages: ChatMessage[]): AsyncGenerator<string> {
    await this.bootstrap();
    const sessionId = await this.createSession();
    try {
      const challenge = await this.getPowChallenge();
      const powHeader = await (this.opts.powSolver ?? unfinishedPowSolver)(challenge);
      const { modelType, thinkingEnabled, searchEnabled } = resolveModelOptions(model);
      const payload = {
        chat_session_id: sessionId,
        parent_message_id: null,
        model_type: modelType,
        prompt: messagesToPrompt(messages),
        ref_file_ids: [] as string[],
        thinking_enabled: thinkingEnabled,
        search_enabled: searchEnabled,
        preempt: false,
      };
      const res = await this.fetchFn(COMPLETION_URL, {
        method: "POST",
        headers: {
          ...FAKE_HEADERS,
          "content-type": "application/json",
          authorization: `Bearer ${this.accessToken}`,
          "x-ds-pow-response": powHeader,
          "x-client-timezone-offset": String(new Date().getTimezoneOffset() * -60),
          cookie: fakeCookie(),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status === 401 || res.status === 403) {
          this.accessToken = null;
          throw new WebChatError(this.id, "DeepSeek token expired — import a fresh user-token.");
        }
        if (res.status === 429) throw new WebChatError(this.id, "DeepSeek rate limited (HTTP 429).");
        throw new WebChatError(this.id, `DeepSeek completion failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }

      const thinking = isThinkingModel(model);
      let currentPath: "thinking" | "content" | "" = "";
      let sawFinished = false;
      const emit = (raw: string): string => {
        const text = cleanToken(raw);
        if (!text) return "";
        let path = currentPath;
        if (!path && thinking) path = "thinking";
        return path === "thinking" ? "" : text; // reasoning is not content
      };
      const handleFragment = (frag: Fragment): string[] => {
        const type = String(frag?.type ?? "").toUpperCase();
        if (type === "THINK") currentPath = "thinking";
        else if (type === "ANSWER" || type === "RESPONSE") currentPath = "content";
        if (typeof frag?.content !== "string" || !frag.content) return [];
        const t = emit(frag.content);
        return t ? [t] : [];
      };

      for await (const data of sseDataLines(res.body)) {
        if (data === "[DONE]") break;
        let ev: { p?: string; v?: unknown; o?: string };
        try {
          ev = JSON.parse(data) as typeof ev;
        } catch {
          continue;
        }
        const { p, v } = ev;
        if (p === "response/status" && v === "FINISHED") {
          sawFinished = true;
          continue;
        }
        if (v && typeof v === "object" && (v as { response?: { fragments?: Fragment[] } }).response) {
          const resp = (v as { response: { thinking_enabled?: boolean; fragments?: Fragment[] } }).response;
          if (resp.thinking_enabled === true) currentPath = "thinking";
          else if (resp.thinking_enabled === false) currentPath = "content";
          for (const frag of resp.fragments ?? []) for (const t of handleFragment(frag)) yield t;
          continue;
        }
        if (p === "response/fragments") {
          const frags = Array.isArray(v) ? (v as Fragment[]) : [v as Fragment];
          for (const frag of frags) for (const t of handleFragment(frag)) yield t;
          continue;
        }
        if (p === "response/search_status" || p === "response/search_results") continue;
        if (typeof v === "string") {
          const t = emit(v);
          if (t) yield t;
        }
      }
      // OmniRoute honesty check: no FINISHED signal means the session was cut
      // off (expired cookie / anti-bot / network), not a genuine completion.
      if (!sawFinished) {
        throw new WebChatError(
          this.id,
          "DeepSeek web session ended before completion (no FINISHED signal) — likely a dropped session; retry.",
        );
      }
    } finally {
      await this.deleteSession(sessionId);
    }
  }

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    let text = "";
    for await (const delta of this.chatStream(model, messages)) text += delta;
    return text;
  }
}
