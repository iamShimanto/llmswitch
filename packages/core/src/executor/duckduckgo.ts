/**
 * DuckDuckGo AI Chat (duck.ai) — anonymous, keyless executor.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * open-sse/executors/duckduckgo-web.ts @ release/v3.8.53) — attribution retained.
 * This is a deliberately MINIMAL port of their flow:
 *
 *   1. GET  {base}/duckchat/v1/status   → session tokens in `x-vqd-4` /
 *      `x-vqd-hash-1` RESPONSE headers (with `x-vqd-accept: 1` on the request)
 *   2. POST {base}/duckchat/v1/chat     → SSE stream of `data:` lines whose
 *      JSON payloads carry incremental `message` (or `content`) fragments.
 *
 * The JavaScript anti-bot challenge (x-vqd-hash-1) IS solved here — the
 * solver is ported from OmniRoute's challenge.ts into ./ddgChallenge.ts
 * (node:vm sandbox + browser stubs); the SOLVED payload is sent back in the
 * x-vqd-hash-1 header of the chat call, exactly like the real client (the
 * raw challenge must never be forwarded). What this port still lacks vs
 * OmniRoute: their browser-fingerprint session pool and Playwright
 * fallback. Even with the challenge solved, Duck.ai may still 418 from
 * IPs it has hard-flagged — that surfaces as a clear anti-bot error and
 * the router's fallback chain moves on to the next provider.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ResolvedProvider,
} from "../providers/types.js";
import { UpstreamError } from "../router/errors.js";
import type { ExecuteResult } from "./http.js";
import { makeDuckDuckGoFeSignals, solveDuckDuckGoChallenge } from "./ddgChallenge.js";


/** Browser-ish headers Duck.ai expects (mirrors OmniRoute's FAKE_HEADERS). */
const BROWSER_HEADERS: Record<string, string> = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  origin: "https://duck.ai",
  referer: "https://duck.ai/",
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
};

/** Solve an x-vqd-hash-1 challenge payload (injectable for tests). */
export type DdgChallengeSolver = (hash1: string) => Promise<string>;
const defaultSolver: DdgChallengeSolver = (hash1) =>
  solveDuckDuckGoChallenge(hash1, BROWSER_HEADERS["user-agent"]);

/**
 * Duck.ai rejects `system`/`tool` roles — chat accepts user/assistant only.
 * System prompts are folded into a leading user turn (OmniRoute's
 * normalizeSystemRole does the equivalent).
 */
function normalizeMessages(messages: ChatMessage[]): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  let systemText = "";
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) systemText += (systemText ? "\n" : "") + m.content;
      continue;
    }
    if (m.role === "tool") continue; // no tool channel in the anonymous chat
    out.push({ role: m.role, content: m.content ?? "" });
  }
  if (systemText) {
    const firstUser = out.find((m) => m.role === "user");
    if (firstUser) firstUser.content = `${systemText}\n\n${firstUser.content}`;
    else out.unshift({ role: "user", content: systemText });
  }
  return out;
}

/** Model aliases (ported from OmniRoute's duckduckgo-web/models.ts). */
const MODEL_ALIASES: Record<string, string> = {
  "gpt-4o-mini": "gpt-5.4-mini",
  "gpt-5-mini": "gpt-5.4-mini",
  "o3-mini": "gpt-5.4-mini",
  "gpt-5.4-nano": "gpt-5.4-mini",
  "llama-4-scout": "gpt-5.4-mini",
  "claude-3-5-haiku-20241022": "claude-haiku-4-5",
  "mistral-small-2501": "mistral-small-2603",
  "gpt-oss-120b": "tinfoil/gpt-oss-120b",
  "gemma4-31b": "tinfoil/gemma4-31b",
};

/** reasoningEffort is REQUIRED by duckchat — omitting it earns ERR_BAD_REQUEST. */
function reasoningEffort(model: string): string {
  if (model === "claude-haiku-4-5" || model === "tinfoil/gpt-oss-120b") return "low";
  return "none";
}

const FE_VERSION_PATTERN = /serp_\d{8}_\d{6}_[A-Z]{2}-[0-9a-f]{20,40}/;
const DEFAULT_FE_VERSION = "serp_20260424_180649_ET-0bdc33b2a02ebf8f235def65d887787f694720a1";

/** Extract text from one Duck.ai SSE payload (`message` or `content` field). */
function fragmentText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const rec = data as Record<string, unknown>;
  if (typeof rec.message === "string") return rec.message;
  if (typeof rec.content === "string") return rec.content;
  return "";
}

/** The durable-stream block of the chat payload (fresh RSA public key, as upstream). */
function durableStream(): Record<string, unknown> {
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const jwk = publicKey.export({ format: "jwk" }) as unknown as Record<string, unknown>;
  return {
    messageId: randomUUID(),
    conversationId: randomUUID(),
    publicKey: { ...jwk, alg: "RSA-OAEP-256", ext: true, key_ops: ["encrypt"], use: "enc" },
  };
}

/** Friendlier message for Duck.ai error bodies ({type: "ERR_CHALLENGE", ...}). */
function ddgErrorMessage(status: number, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as { type?: unknown };
    if (parsed.type === "ERR_CHALLENGE" || parsed.type === "ERR_BN_LIMIT") {
      return (
        `DuckDuckGo AI Chat anti-bot challenge (${String(parsed.type)}): the challenge was ` +
        "solved but Duck.ai still refused this session (HTTP 418) — the IP may be flagged; " +
        "retry later or from a residential IP."
      );
    }
    if (typeof parsed.type === "string") return `DuckDuckGo AI Chat error: ${parsed.type}`;
  } catch {
    /* not JSON — fall through */
  }
  if (status === 418) {
    return "DuckDuckGo AI Chat answered HTTP 418 (anti-bot challenge) — anonymous access is blocked from this IP.";
  }
  return `DuckDuckGo AI Chat upstream ${status}: ${bodyText.slice(0, 200)}`;
}

/**
 * Execute one chat against Duck.ai's anonymous endpoint.
 * `fetchFn` is injectable for tests, mirroring executeProvider.
 */
export async function executeDuckDuckGoChat(
  provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 120_000,
  solve: DdgChallengeSolver = defaultSolver,
): Promise<ExecuteResult> {
  const started = Date.now();
  const base = provider.baseUrl.replace(/\/$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // 0) warm the session like the real client: GET the homepage for seed
    // cookies + the live x-fe-version token (both cross-checked upstream).
    const jar = new Map<string, string>();
    const harvest = (res: Response) => {
      try {
        for (const sc of res.headers.getSetCookie()) {
          const pair = sc.split(";")[0];
          const eq = pair.indexOf("=");
          if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
      } catch {
        /* older runtimes without getSetCookie */
      }
    };
    const cookieHeader = () =>
      [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    let feVersion = DEFAULT_FE_VERSION;
    try {
      const home = await fetchFn(`${base}/`, { headers: { ...BROWSER_HEADERS }, signal: ctrl.signal });
      harvest(home);
      const html = await home.text().catch(() => "");
      feVersion = html.match(FE_VERSION_PATTERN)?.[0] ?? feVersion;
    } catch {
      /* warm-up is best-effort */
    }

    // 1) session tokens
    const statusRes = await fetchFn(`${base}/duckchat/v1/status`, {
      method: "GET",
      headers: {
        ...BROWSER_HEADERS,
        "x-vqd-accept": "1",
        "cache-control": "no-store",
        ...(jar.size ? { cookie: cookieHeader() } : {}),
      },
      signal: ctrl.signal,
    });
    harvest(statusRes);
    if (!statusRes.ok) {
      const text = await statusRes.text().catch(() => "");
      throw new UpstreamError(
        statusRes.status === 429 || statusRes.status === 418 ? "rate_limited" : "server_error",
        statusRes.status,
        ddgErrorMessage(statusRes.status, text),
      );
    }
    const vqd4 = statusRes.headers.get("x-vqd-4");
    const vqdHash1 = statusRes.headers.get("x-vqd-hash-1");
    // Solve the anti-bot challenge; only the SOLVED payload is ever sent.
    let solvedHash1: string | null = null;
    if (vqdHash1) {
      try {
        solvedHash1 = await solve(vqdHash1);
      } catch (err) {
        throw new UpstreamError(
          "server_error",
          418,
          `DuckDuckGo challenge solve failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!vqd4 && !solvedHash1) {
      throw new UpstreamError(
        "server_error",
        statusRes.status,
        "DuckDuckGo AI Chat status response carried no VQD session token — anonymous session refused (anti-bot?).",
      );
    }

    // 2) chat
    const wireModel = MODEL_ALIASES[model] ?? model;
    const payload = {
      model: wireModel,
      metadata: {
        toolChoice: { NewsSearch: false, VideosSearch: false, LocalSearch: false, WeatherForecast: false },
      },
      messages: normalizeMessages(body.messages),
      canUseTools: false,
      reasoningEffort: reasoningEffort(wireModel),
      canUseApproxLocation: null,
      canDelegateImageGeneration: null,
      durableStream: durableStream(),
    };
    const chatRes = await fetchFn(`${base}/duckchat/v1/chat`, {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        accept: "text/event-stream",
        "content-type": "application/json",
        ...(vqd4 ? { "x-vqd-4": vqd4 } : {}),
        ...(solvedHash1 ? { "x-vqd-hash-1": solvedHash1 } : {}),
        "x-fe-signals": makeDuckDuckGoFeSignals(),
        "x-fe-version": feVersion,
        "x-ddg-journey-id": randomUUID().replaceAll("-", ""),
        ...(jar.size ? { cookie: cookieHeader() } : {}),
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!chatRes.ok) {
      const text = await chatRes.text().catch(() => "");
      throw new UpstreamError(
        chatRes.status === 429 || chatRes.status === 418 ? "rate_limited" : "server_error",
        chatRes.status,
        ddgErrorMessage(chatRes.status, text),
      );
    }

    const raw = await chatRes.text();
    const fragments: string[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const frag = fragmentText(JSON.parse(data));
        if (frag) fragments.push(frag);
      } catch {
        /* ignore malformed SSE lines */
      }
    }
    const latencyMs = Date.now() - started;
    const fullText = fragments.join("");

    if (body.stream === true) {
      const gen = (async function* () {
        for (const frag of fragments) {
          yield {
            id: "chatcmpl-ddg",
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta: { content: frag }, finish_reason: null }],
          };
        }
        yield {
          id: "chatcmpl-ddg",
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
      })();
      return { stream: gen, providerId: provider.id, model, latencyMs, quota: null };
    }

    const response: ChatCompletionResponse = {
      id: "chatcmpl-ddg",
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    return { response, providerId: provider.id, model, latencyMs, quota: null };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError("server_error", 0, `duckduckgo network error: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
