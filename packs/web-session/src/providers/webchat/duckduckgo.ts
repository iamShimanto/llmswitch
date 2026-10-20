/**
 * DuckDuckGoDriver — DuckDuckGo AI Chat (duck.ai) via the site's own API,
 * using cookies imported by the user (or seeded browser-like cookies).
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53):
 *   - open-sse/config/providers/registry/duckduckgo-web/index.ts
 *     (baseUrl https://duck.ai/duckchat/v1/chat; same-origin host verified live 2026-08-26)
 *   - open-sse/executors/duckduckgo-web.ts (status bootstrap, chat payload, SSE parse)
 *   - open-sse/executors/duckduckgo-web/models.ts (model aliases, reasoningEffort)
 *
 * Protocol (from OmniRoute's executor):
 *   1. GET /duckchat/v1/status with `x-vqd-accept: 1` -> bootstrap token in
 *      the `x-vqd-4` response header (OmniRoute historically documented this
 *      status endpoint against duckduckgo.com; duck.ai serves the same flow).
 *      An `x-vqd-hash-1` header instead means an anti-abuse JS challenge that
 *      must be solved before chat — see the challenge-solver note below.
 *   2. POST /duckchat/v1/chat with `x-vqd-4: <token>`, `reasoningEffort`
 *      ("none", or "low" for claude-haiku-4-5 and tinfoil/gpt-oss-120b —
 *      OmniRoute notes it is REQUIRED; omitting it returns 400), and the
 *      OpenAI-style messages array.
 *   3. The response is SSE: `data:` lines carrying JSON
 *      { message: "..." } / { content: "..." } chunks.
 *
 * ⚠️ KNOWN LIVE FINDING: probed live from a datacenter IP, the chat endpoint
 * returns HTTP 418 ERR_CHALLENGE (anti-bot) even when the protocol above is
 * followed. From a residential IP the same flow can succeed. The protocol is
 * implemented as coded; expect 418 until the anti-bot posture changes.
 *
 * ⚠️ Reverse-engineered protocol — it rots. Mock-tested only.
 * NEEDS LIVE VERIFICATION: the x-vqd-hash-1 challenge flow (OmniRoute solves it
 * with node:vm in executors/duckduckgo-web/challenge.ts — NOT ported here; the
 * solver is injectable via the constructor opts), the x-fe-signals/x-fe-version
 * header fidelity, system-message handling, and the durableStream block.
 */
import { randomUUID } from "node:crypto";
import type { CookieJar } from "../../cookieJar.js";
import type { ChatMessage } from "../../cookieChat.js";
import {
  BROWSER_UA,
  WebChatError,
  harvestCookies,
  requireCookieHeader,
  sseDataLines,
  type WebChatDriver,
} from "./types.js";

const DUCK_BASE = "https://duck.ai";
const STATUS_URL = `${DUCK_BASE}/duckchat/v1/status`;
const CHAT_URL = `${DUCK_BASE}/duckchat/v1/chat`;

/** Challenge-solver injection: (xVqdHash1) -> solved header value. */
export type DuckDuckGoChallengeSolver = (xVqdHash1: string) => Promise<string>;

/** OmniRoute model aliases (executors/duckduckgo-web/models.ts, captured live 2026-08-26). */
const MODEL_ALIASES: Record<string, string> = {
  "gpt-4o-mini": "gpt-5.4-mini",
  "gpt-5-mini": "gpt-5.4-mini",
  "o3-mini": "gpt-5.4-mini",
  "gpt-5.4-nano": "gpt-5.4-mini",
  "llama-4-scout": "gpt-5.4-mini",
  "claude-3-5-haiku-20241022": "claude-haiku-4-5",
  "mistral-small-2501": "mistral-small-2603",
  "gpt-oss-120b": "tinfoil/gpt-oss-120b",
  gemma4: "tinfoil/gemma4-31b",
  "gemma4-31b": "tinfoil/gemma4-31b",
};

function normalizeModel(model: string): string {
  const clean = model.startsWith("duckduckgo/") ? model.slice("duckduckgo/".length) : model;
  return MODEL_ALIASES[clean] ?? clean;
}

/** OmniRoute getDuckDuckGoModelCapabilities: reasoningEffort is REQUIRED. */
function reasoningEffort(model: string): string {
  if (model === "claude-haiku-4-5" || model === "tinfoil/gpt-oss-120b") return "low";
  return "none";
}

/**
 * Mimics OmniRoute's makeDuckDuckGoFeSignals(): fake interaction-timing
 * telemetry the real frontend sends on every chat request. The upstream
 * cross-checks plausibility, so a static value is worse than none — but the
 * real thing NEEDS LIVE VERIFICATION against the current bundle.
 */
function makeFeSignals(): string {
  const start = Date.now() - 3000;
  let delta = 80 + Math.floor(Math.random() * 101);
  const events: Array<Record<string, unknown>> = [{ name: "onboarding_impression_1", delta }];
  delta += 120 + Math.floor(Math.random() * 141);
  events.push({ name: "onboarding_impression_2", delta });
  delta += 200 + Math.floor(Math.random() * 301);
  events.push({ name: "startNewChat", delta });
  const keyEvents = 6 + Math.floor(Math.random() * 13);
  for (let i = 0; i < keyEvents; i++) {
    delta += 40 + Math.floor(Math.random() * 141);
    events.push({ name: "user_input", delta });
  }
  delta += 120 + Math.floor(Math.random() * 231);
  events.push({ name: "user_submit", delta });
  return Buffer.from(
    JSON.stringify({ start, events, end: Math.max(delta + 20 + Math.floor(Math.random() * 71), 3000) }),
    "utf8",
  ).toString("base64");
}

const SEEDED_HEADERS: Record<string, string> = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  origin: DUCK_BASE,
  referer: `${DUCK_BASE}/`,
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "user-agent": BROWSER_UA,
};

export interface DuckDuckGoDriverOptions {
  /** Solves an x-vqd-hash-1 anti-abuse challenge. Defaults to an explanatory throw. */
  challengeSolver?: DuckDuckGoChallengeSolver;
}

function defaultChallengeSolver(): Promise<string> {
  return Promise.reject(
    new WebChatError(
      "duckduckgo",
      "DuckDuckGo returned an x-vqd-hash-1 anti-abuse challenge. Solving it requires the " +
        "node:vm challenge solver from OmniRoute (executors/duckduckgo-web/challenge.ts), which " +
        "is NOT ported — NEEDS LIVE VERIFICATION. Inject a solver via DuckDuckGoDriverOptions.",
    ),
  );
}

export class DuckDuckGoDriver implements WebChatDriver {
  readonly id = "duckduckgo";
  readonly cookieDomains = ["duck.ai", "duckduckgo.com"];
  readonly cookieHint =
    "DDG AI chat is anonymous, but importing duck.ai/duckduckgo.com cookies seeds " +
    "anti-abuse state; import with: llmswitch cookies duckduckgo";

  private cookie = "";
  private vqd4: string | null = null;
  private booted = false;

  constructor(
    private jar: CookieJar,
    private fetchFn: typeof fetch = fetch,
    private opts: DuckDuckGoDriverOptions = {},
  ) {}

  /** GET /duckchat/v1/status -> x-vqd-4 bootstrap token. Idempotent. */
  async bootstrap(): Promise<void> {
    if (this.booted) return;
    this.cookie = requireCookieHeader(this.jar, STATUS_URL, this.id, this.cookieHint);
    const res = await this.fetchFn(STATUS_URL, {
      method: "GET",
      headers: { ...SEEDED_HEADERS, cookie: this.cookie, "x-vqd-accept": "1" },
      signal: AbortSignal.timeout(30_000),
    });
    harvestCookies(this.jar, res, STATUS_URL);
    if (!res.ok) {
      throw new WebChatError(
        this.id,
        `DuckDuckGo status bootstrap failed (HTTP ${res.status}) — the anti-bot may be blocking this IP`,
      );
    }
    const vqd4 = res.headers.get("x-vqd-4");
    if (vqd4) {
      this.vqd4 = vqd4;
      this.booted = true;
      return;
    }
    // Anti-abuse challenge path: OmniRoute solves the x-vqd-hash-1 payload with
    // its node:vm challenge solver. That solver is not ported; the hook is here.
    const hash1 = res.headers.get("x-vqd-hash-1");
    if (hash1) {
      this.vqd4 = await (this.opts.challengeSolver ?? defaultChallengeSolver)(hash1);
      this.booted = true;
      return;
    }
    throw new WebChatError(
      this.id,
      "DuckDuckGo status returned neither x-vqd-4 nor x-vqd-hash-1 — protocol may have rotated (NEEDS LIVE VERIFICATION)",
    );
  }

  private buildPayload(model: string, messages: ChatMessage[]): Record<string, unknown> {
    const wireModel = normalizeModel(model);
    // #ddgw defense-in-depth: the upstream web client sends only user/assistant
    // roles. OmniRoute normalizes system messages; this port prefixes them onto
    // the first user message. NEEDS LIVE VERIFICATION.
    const wireMessages = messages.map((m) => ({
      role: m.role,
      content: m.role === "system" ? `[system] ${m.content}` : m.content,
    }));
    return {
      model: wireModel,
      metadata: {
        toolChoice: {
          NewsSearch: false,
          VideosSearch: false,
          LocalSearch: false,
          WeatherForecast: false,
        },
      },
      messages: wireMessages,
      canUseTools: false,
      reasoningEffort: reasoningEffort(wireModel),
      canUseApproxLocation: null,
      canDelegateImageGeneration: null,
    };
  }

  async *chatStream(model: string, messages: ChatMessage[]): AsyncGenerator<string> {
    await this.bootstrap();
    const res = await this.fetchFn(CHAT_URL, {
      method: "POST",
      headers: {
        ...SEEDED_HEADERS,
        cookie: this.cookie,
        accept: "text/event-stream",
        "content-type": "application/json",
        "x-ddg-journey-id": randomUUID().replaceAll("-", ""),
        "x-fe-signals": makeFeSignals(),
        ...(this.vqd4 ? { "x-vqd-4": this.vqd4 } : {}),
      },
      body: JSON.stringify(this.buildPayload(model, messages)),
      signal: AbortSignal.timeout(120_000),
    });
    harvestCookies(this.jar, res, CHAT_URL);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 418) {
        // KNOWN LIVE FINDING: datacenter IPs get HTTP 418 ERR_CHALLENGE here.
        let detail = body.slice(0, 200);
        try {
          const parsed = JSON.parse(body) as { type?: string };
          if (parsed?.type) detail = parsed.type;
        } catch {
          /* keep raw */
        }
        throw new WebChatError(
          this.id,
          `DuckDuckGo AI Chat anti-abuse challenge failed (HTTP 418 ${detail}). Retry later or from a less rate-limited IP; DuckDuckGo is rejecting this session.`,
        );
      }
      throw new WebChatError(this.id, `DuckDuckGo chat failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
    // Remember the rotated challenge token for the next request (OmniRoute does).
    const nextHash = res.headers.get("x-vqd-hash-1");
    if (nextHash && this.opts.challengeSolver) {
      try {
        this.vqd4 = await this.opts.challengeSolver(nextHash);
      } catch {
        /* keep the old token */
      }
    }
    for await (const data of sseDataLines(res.body)) {
      if (data === "[DONE]") break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const rec = parsed as { message?: unknown; content?: unknown };
      const text = typeof rec.message === "string" ? rec.message : rec.content;
      if (typeof text === "string" && text) yield text;
    }
  }

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    let text = "";
    for await (const delta of this.chatStream(model, messages)) text += delta;
    return text;
  }
}
