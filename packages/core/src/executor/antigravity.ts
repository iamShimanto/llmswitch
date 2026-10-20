/**
 * Google Antigravity executor — chat via Google's internal Cloud Code API.
 *
 * Ported (SIMPLIFIED) from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, release v3.8.53) —
 * `open-sse/executors/antigravity.ts`,
 * `open-sse/config/antigravityUpstream.ts`,
 * `open-sse/config/antigravityModelAliases.ts`,
 * `open-sse/services/antigravityHeaders.ts`,
 * `open-sse/services/antigravityIdentity.ts` and
 * `open-sse/services/antigravityHeaderScrub.ts`. Attribution retained.
 *
 * What this port keeps: upstream URLs, IDE fingerprint (UA + metadata
 * enums), header scrubbing, request envelope shape, model alias map,
 * session-id derivation, 429 handling. What it drops: credits engine,
 * per-model quota cooldowns, 429 classifier state, model fallback chains,
 * image/harness fields, thinking-budget steering, project caching.
 *
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED — see packs/web-session for warnings.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { platform as osPlatform, arch as osArch } from "node:os";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ResolvedProvider,
} from "../providers/types.js";
import { classifyStatus, UpstreamError } from "../router/errors.js";
import { toGeminiRequest } from "../translator/gemini.js";
import type { ExecuteResult } from "./http.js";

/* ------------------------------------------------------------------ *
 * Constants (ported from OmniRoute)
 * ------------------------------------------------------------------ */

export const ANTIGRAVITY_RUNTIME_BASE_URLS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
] as const;
export const ANTIGRAVITY_STREAM_PATH = "/v1internal:streamGenerateContent?alt=sse";
export const ANTIGRAVITY_IDE_VERSION = "2.5.5";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Public OAuth client creds for the Antigravity desktop app (public by design — native-app creds). Decoded from OmniRoute `open-sse/utils/publicCreds.ts` (MIT). */
export const ANTIGRAVITY_PUBLIC_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const ANTIGRAVITY_PUBLIC_CLIENT_SECRET = "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";

export function antigravityClientId(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTIGRAVITY_OAUTH_CLIENT_ID?.trim() || ANTIGRAVITY_PUBLIC_CLIENT_ID;
}
export function antigravityClientSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() || ANTIGRAVITY_PUBLIC_CLIENT_SECRET;
}

/** Model alias map — ported verbatim from OmniRoute `ANTIGRAVITY_MODEL_ALIASES`. */
export const ANTIGRAVITY_MODEL_ALIASES: Record<string, string> = Object.freeze({
  "gemini-3.7-flash": "gemini-3.7-flash-tiered",
  "gemini-3.7-flash-high": "gemini-3.7-flash-tiered",
  "gemini-3.7-flash-medium": "gemini-3.7-flash-tiered",
  "gemini-3.7-flash-low": "gemini-3.7-flash-tiered",
  "gemini-3.8-flash": "gemini-3.8-flash-high",
  "gemini-3.8-flash-tiered": "gemini-3.8-flash-high",
  "gpt-oss-120b": "gpt-oss-120b-medium",
  "gemini-3.1-pro-high": "gemini-pro-agent",
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
  "gemini-claude-sonnet-4-5": "claude-sonnet-4-6",
  "gemini-claude-sonnet-4-5-thinking": "claude-sonnet-4-6",
  "gemini-claude-opus-4-5-thinking": "claude-opus-4-6-thinking",
});

export function resolveAntigravityModelId(modelId: string): string {
  if (!modelId) return modelId;
  return ANTIGRAVITY_MODEL_ALIASES[modelId] ?? modelId;
}

/* ------------------------------------------------------------------ *
 * IDE fingerprint — ported from OmniRoute `antigravityHeaders.ts`.
 * ------------------------------------------------------------------ */

const IDE_TYPE_ENUM = 9;
const PLUGIN_TYPE_GEMINI_ENUM = 2;
const PLATFORM_ENUM = { UNSPECIFIED: 0, DARWIN_AMD64: 1, DARWIN_ARM64: 2, LINUX_AMD64: 3, LINUX_ARM64: 4, WINDOWS_AMD64: 5 } as const;

export function resolveAntigravityPlatformEnum(
  platform: NodeJS.Platform = osPlatform(),
  arch: string = osArch(),
): number {
  if (platform === "darwin") return arch === "arm64" ? PLATFORM_ENUM.DARWIN_ARM64 : PLATFORM_ENUM.DARWIN_AMD64;
  if (platform === "linux") return arch === "arm64" ? PLATFORM_ENUM.LINUX_ARM64 : PLATFORM_ENUM.LINUX_AMD64;
  if (platform === "win32") return PLATFORM_ENUM.WINDOWS_AMD64;
  return PLATFORM_ENUM.UNSPECIFIED;
}

export function buildAntigravityIdeMetadata(): Record<string, number> {
  return { ideType: IDE_TYPE_ENUM, platform: resolveAntigravityPlatformEnum(), pluginType: PLUGIN_TYPE_GEMINI_ENUM };
}

/**
 * Content headers for Cloud Code calls — ported from OmniRoute
 * `getAntigravityContentHeaders` (IDE profile). The OS/arch token is pinned
 * to darwin/arm64: the upstream backend expects the native Mac desktop
 * client fingerprint (OmniRoute #8098).
 */
export function buildAntigravityContentHeaders(accessToken?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} darwin/arm64`,
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

/**
 * Header scrubbing — ported from OmniRoute `scrubProxyAndFingerprintHeaders`
 * (based on CLIProxyAPI). Removes headers that reveal proxy infrastructure
 * or a non-native client identity; pins Accept-Encoding to the Node default.
 */
const SCRUBBED_HEADERS = new Set([
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
  "x-real-ip", "forwarded", "via",
  "x-title", "x-stainless-lang", "x-stainless-package-version", "x-stainless-os",
  "x-stainless-arch", "x-stainless-runtime", "x-stainless-runtime-version",
  "x-stainless-timeout", "x-stainless-retry-count", "x-stainless-helper-method",
  "http-referer", "referer",
  "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
  "sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest", "priority",
  "accept-encoding",
]);

export function scrubFingerprintHeaders(headers: Record<string, string>): Record<string, string> {
  const cleaned: Record<string, string> = {};
  let authorization: string | undefined;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower.startsWith("x-llmswitch-") || SCRUBBED_HEADERS.has(lower)) continue;
    if (lower === "authorization") {
      authorization = value; // Authorization lands last — matches the native fingerprint
      continue;
    }
    cleaned[key] = value;
  }
  cleaned["Accept-Encoding"] = "gzip, deflate, br";
  if (authorization !== undefined) cleaned["Authorization"] = authorization;
  return cleaned;
}

/* ------------------------------------------------------------------ *
 * Session id — ported from OmniRoute `antigravityIdentity.ts`
 * (FNV-1a 64-bit over the account key, else a random id).
 * ------------------------------------------------------------------ */

function fnv1a64(input: string): string {
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  for (const byte of Buffer.from(input, "utf8")) {
    hash = (hash ^ BigInt(byte)) * prime;
    hash &= BigInt("0x7fffffffffffffff"); // keep it non-negative for the session id
  }
  return hash.toString();
}

export function deriveAntigravitySessionId(accountKey?: string | null): string {
  if (accountKey && accountKey.trim()) return fnv1a64(accountKey.trim());
  return `-${randomBytes(8).readBigUInt64BE().toString()}`;
}

export function generateAntigravityRequestId(): string {
  return `agent/${Date.now()}/${randomBytes(4).toString("hex")}`;
}

/* ------------------------------------------------------------------ *
 * Request envelope — ported from the antigravity executor's envelope:
 * {project, requestId, request, model, userAgent: "antigravity",
 *  requestType: "agent"}. The inner request is Gemini-format.
 * ------------------------------------------------------------------ */

/** OmniRoute's default system prompt — noted as required for the API to work. */
export const ANTIGRAVITY_DEFAULT_SYSTEM =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.";

export function buildAntigravityEnvelope(
  model: string,
  body: ChatCompletionRequest,
  projectId: string,
  accountKey?: string | null,
): Record<string, unknown> {
  const upstreamModel = resolveAntigravityModelId(model);
  const geminiBody = toGeminiRequest(body) as Record<string, unknown>;
  // The upstream expects a system instruction; use OmniRoute's default when
  // the caller provided none.
  if (!("systemInstruction" in geminiBody)) {
    geminiBody.systemInstruction = { parts: [{ text: ANTIGRAVITY_DEFAULT_SYSTEM }] };
  }
  const request = {
    ...geminiBody,
    sessionId: deriveAntigravitySessionId(accountKey),
  };
  return {
    project: projectId,
    requestId: generateAntigravityRequestId(),
    request,
    model: upstreamModel,
    userAgent: "antigravity",
    requestType: "agent",
  };
}

/* ------------------------------------------------------------------ *
 * Credentials: env first, then the pack's session file
 * (~/.llmswitch/sessions/antigravity.json, 0600) — the same convention the
 * web-session pack writes. Refreshes expired tokens via the refresh_token
 * grant so the gateway path needs no pack dependency.
 * ------------------------------------------------------------------ */

export interface AntigravityCreds {
  accessToken: string;
  refreshToken?: string;
  projectId?: string;
  email?: string;
}

function sessionPath(env: NodeJS.ProcessEnv, sessionName = "antigravity"): string {
  const dir = env.LLMSWITCH_SESSIONS_DIR ?? join(homedir(), ".llmswitch", "sessions");
  return join(dir, `${sessionName}.json`);
}

/** True when a usable Antigravity session/token is configured (sync). */
export function hasAntigravityCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.ANTIGRAVITY_ACCESS_TOKEN ?? "").trim()) return true;
  if ((env.ANTIGRAVITY_OAUTH_REFRESH_TOKEN ?? "").trim()) return true;
  return existsSync(sessionPath(env));
}

interface StoredAntigravitySession {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  projectId?: string;
  email?: string;
}

function readStoredSession(env: NodeJS.ProcessEnv, sessionName = "antigravity"): StoredAntigravitySession | null {
  try {
    const p = sessionPath(env, sessionName);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as StoredAntigravitySession;
  } catch {
    return null;
  }
}

async function refreshGoogleAccessToken(
  refreshToken: string,
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
): Promise<{ accessToken: string; expiresAt: number }> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: antigravityClientId(env),
    client_secret: antigravityClientSecret(env),
  });
  params.set("refresh_token", refreshToken);
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new AntigravityAuthError(401, `antigravity token refresh failed: HTTP ${res.status} — re-run: llmswitch login antigravity`);
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new AntigravityAuthError(401, "antigravity token refresh: no access_token — re-run: llmswitch login antigravity");
  return { accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
}

/** Resolve usable creds: fresh session token, else refresh-token grant.
 * `sessionName` lets sibling surfaces (e.g. `agy`) reuse this executor with
 * their own session file; error hints follow the session name. */
export async function resolveAntigravityCreds(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
  sessionName = "antigravity",
): Promise<AntigravityCreds> {
  const envAccess = (env.ANTIGRAVITY_ACCESS_TOKEN ?? "").trim();
  const envProject = (env.ANTIGRAVITY_PROJECT_ID ?? "").trim();
  if (envAccess) return { accessToken: envAccess, projectId: envProject || undefined };

  const stored = readStoredSession(env, sessionName);
  const refreshToken = (env.ANTIGRAVITY_OAUTH_REFRESH_TOKEN ?? "").trim() || stored?.refreshToken;
  if (stored?.accessToken && stored.expiresAt && stored.expiresAt > Date.now() + 60_000) {
    return { accessToken: stored.accessToken, refreshToken, projectId: stored.projectId ?? envProject, email: stored.email };
  }
  if (!refreshToken) {
    throw new AntigravityAuthError(401, `${sessionName}: no session — run: llmswitch login ${sessionName}`);
  }
  const fresh = await refreshGoogleAccessToken(refreshToken, env, fetchFn);
  return { accessToken: fresh.accessToken, refreshToken, projectId: stored?.projectId ?? envProject, email: stored?.email };
}

/* ------------------------------------------------------------------ *
 * Errors + execution
 * ------------------------------------------------------------------ */

/** Typed auth error the router surfaces as a non-retryable auth failure. */
export class AntigravityAuthError extends UpstreamError {
  constructor(status: number, message: string) {
    super("auth_error", status, message);
    this.name = "AntigravityAuthError";
  }
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h.trim());
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const when = Date.parse(h);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

export interface AntigravityExecuteOpts {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  maxAttempts?: number; // total attempts including the first (default 3)
  maxRetryDelayMs?: number; // cap for Retry-After waits (default 60s)
  sleep?: (ms: number) => Promise<void>;
}

function extractText(payload: any): { text: string; finishReason: string; usage: Record<string, number> } {
  const resp = payload?.response ?? payload;
  const candidate = resp?.candidates?.[0];
  const parts: Array<{ text?: string; thought?: boolean }> = candidate?.content?.parts ?? [];
  const visible = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text as string);
  const all = parts.filter((p) => typeof p.text === "string").map((p) => p.text as string);
  const text = (visible.length > 0 ? visible : all).join("");
  const usage = resp?.usageMetadata ?? {};
  return {
    text,
    finishReason: candidate?.finishReason === "MAX_TOKENS" ? "length" : "stop",
    usage: {
      prompt_tokens: usage.promptTokenCount ?? 0,
      completion_tokens: usage.candidatesTokenCount ?? 0,
      total_tokens: usage.totalTokenCount ?? 0,
    },
  };
}

async function* parseAntigravitySSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<{ text: string; finishReason: string; usage: Record<string, number> }> {
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          yield extractText(JSON.parse(payload));
        } catch {
          /* ignore malformed SSE lines */
        }
      }
    }
  }
}

/**
 * Execute a chat completion through Antigravity's Cloud Code endpoint.
 * Creds (access token + project id) are passed in — token refresh happens
 * in the web-session layer / resolveAntigravityCreds before the call.
 */
export async function executeAntigravity(
  model: string,
  body: ChatCompletionRequest,
  creds: AntigravityCreds,
  opts: AntigravityExecuteOpts = {},
): Promise<ExecuteResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const baseUrl = opts.baseUrl ?? ANTIGRAVITY_RUNTIME_BASE_URLS[0];
  const url = `${baseUrl}${ANTIGRAVITY_STREAM_PATH}`;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const maxRetryDelayMs = opts.maxRetryDelayMs ?? 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const projectId = creds.projectId?.trim();
  if (!projectId) {
    throw new UpstreamError(
      "bad_request",
      400,
      "antigravity: no Cloud Code project id configured — run: llmswitch login antigravity",
    );
  }
  const envelope = buildAntigravityEnvelope(model, body, projectId, creds.email);
  const headers = scrubFingerprintHeaders(buildAntigravityContentHeaders(creds.accessToken));
  const started = Date.now();

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
    let res: Response;
    try {
      res = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(envelope), signal: ctrl.signal });
    } catch (err) {
      clearTimeout(timer);
      throw new UpstreamError("timeout", 0, `antigravity network error: ${(err as Error).message}`);
    }

    if (res.status === 401 || res.status === 403) {
      clearTimeout(timer);
      const text = await res.text().catch(() => "");
      throw new AntigravityAuthError(
        res.status,
        `antigravity auth failed (HTTP ${res.status}): ${text.slice(0, 200)} — refresh the session: llmswitch login antigravity`,
      );
    }

    if (res.status === 429 && attempt < maxAttempts) {
      clearTimeout(timer);
      const wait = retryAfterMs(res);
      const delay = Math.min(wait ?? Math.min(30_000, 500 * 2 ** (attempt - 1)), maxRetryDelayMs);
      await sleep(delay);
      lastErr = new UpstreamError("rate_limited", 429, `antigravity 429 (attempt ${attempt}/${maxAttempts})`);
      continue;
    }

    if (!res.ok) {
      clearTimeout(timer);
      const text = await res.text().catch(() => "");
      const exhausted = res.status === 429 ? `antigravity rate limited after ${maxAttempts} attempts` : `antigravity upstream ${res.status}`;
      throw new UpstreamError(classifyStatus(res.status), res.status, `${exhausted}: ${text.slice(0, 300)}`);
    }

    const latencyMs = Date.now() - started;
    if (body.stream === true && res.body) {
      const gen = (async function* () {
        try {
          for await (const ev of parseAntigravitySSE(res.body!.getReader())) {
            yield {
              id: `chatcmpl-${Date.now()}`,
              object: "chat.completion.chunk",
              model,
              choices: [{ index: 0, delta: { role: "assistant", content: ev.text }, finish_reason: null }],
            };
          }
        } finally {
          clearTimeout(timer);
          try {
            await res.body!.cancel();
          } catch {
            /* noop */
          }
        }
      })();
      return { stream: gen as ExecuteResult["stream"], providerId: "antigravity", model, latencyMs, quota: null };
    }

    clearTimeout(timer);
    let full = "";
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let finishReason = "stop";
    if (res.body) {
      for await (const ev of parseAntigravitySSE(res.body.getReader())) {
        full += ev.text;
        usage = ev.usage as typeof usage;
        finishReason = ev.finishReason;
      }
    }
    const response: ChatCompletionResponse = {
      id: `chatcmpl-${Date.now()}`,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: full }, finish_reason: finishReason }],
      usage,
    };
    return { response, providerId: "antigravity", model, latencyMs, quota: null };
  }
  throw lastErr ?? new UpstreamError("rate_limited", 429, "antigravity: rate limited");
}

/**
 * Gateway path: resolve creds (session/env + refresh) then execute.
 * Used by the router when provider.id === "antigravity".
 */
export async function executeAntigravityChat(
  _provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 120_000,
  env: NodeJS.ProcessEnv = process.env,
  sessionName = "antigravity",
): Promise<ExecuteResult> {
  const creds = await resolveAntigravityCreds(env, fetchFn, sessionName);
  return executeAntigravity(model, body, creds, { fetchFn, timeoutMs, env });
}
