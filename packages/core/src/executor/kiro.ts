/**
 * Kiro AI (AWS CodeWhisperer) executor — SIMPLIFIED port.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `open-sse/executors/kiro.ts` (request →
 * conversationState, generateAssistantResponse endpoint), `open-sse/executors/kiro/eventstream.ts`
 * (AWS event-stream framing), `open-sse/config/providers/registry/kiro/index.ts`.
 * Attribution retained per MIT.
 *
 * What this port keeps: endpoint, conversationState request shape,
 * Bearer auth (+ TokenType: EXTERNAL_IDP header for IdP sessions),
 * profileArn passthrough, and binary event-stream parsing into
 * assistantResponseEvent text. What it drops: tool-call wrapper/repair
 * layers, thinking-channel splitting, credits metering, region routing
 * (us-east-1 only — where the generateAssistantResponse profile lives for
 * Builder ID / social accounts).
 *
 * ⚠️ UNOFFICIAL / REVERSE-ENGINEERED — see packs/web-session for warnings.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ResolvedProvider,
} from "../providers/types.js";
import { classifyStatus, UpstreamError } from "../router/errors.js";
import type { ExecuteResult } from "./http.js";

export const KIRO_GENERATE_URL = "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse";
export const KIRO_SSO_TOKEN_URL = "https://oidc.us-east-1.amazonaws.com/token";
export const KIRO_SOCIAL_REFRESH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";

/* ------------------------------------------------------------------ *
 * Credential resolution (session file convention mirrors the pack)
 * ------------------------------------------------------------------ */

function sessionPath(env: NodeJS.ProcessEnv, accountId?: string | null): string {
  const dir = env.LLMSWITCH_SESSIONS_DIR ?? (env.DATA_DIR ? join(env.DATA_DIR, "sessions") : join(homedir(), ".llmswitch", "sessions"));
  return join(dir, accountId ? `kiro--${accountId}.json` : "kiro.json");
}

export interface KiroCreds {
  accessToken: string;
  refreshToken?: string;
  profileArn?: string;
  /** true for enterprise External-IdP logins → TokenType: EXTERNAL_IDP header */
  externalIdp?: boolean;
}

export function hasKiroCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.KIRO_ACCESS_TOKEN ?? "").trim()) return true;
  if ((env.KIRO_REFRESH_TOKEN ?? "").trim()) return true;
  return existsSync(sessionPath(env));
}

interface StoredKiroSession {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  meta?: {
    authMethod?: string;
    clientId?: string;
    clientSecret?: string;
    profileArn?: string;
    region?: string;
  };
}

function readStoredSession(env: NodeJS.ProcessEnv, accountId?: string | null): StoredKiroSession | null {
  try {
    const p = sessionPath(env, accountId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as StoredKiroSession;
  } catch {
    return null;
  }
}

export async function resolveKiroCreds(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
  accountId?: string | null,
): Promise<KiroCreds> {
  const envAccess = (env.KIRO_ACCESS_TOKEN ?? "").trim();
  if (envAccess && !accountId) {
    return {
      accessToken: envAccess,
      refreshToken: (env.KIRO_REFRESH_TOKEN ?? "").trim() || undefined,
      profileArn: (env.KIRO_PROFILE_ARN ?? "").trim() || undefined,
    };
  }
  const stored = readStoredSession(env, accountId);
  const meta = stored?.meta ?? {};
  const externalIdp = meta.authMethod === "external_idp";
  if (stored?.accessToken && stored.expiresAt && stored.expiresAt > Date.now() + 60_000) {
    return { accessToken: stored.accessToken, refreshToken: stored.refreshToken, profileArn: meta.profileArn, externalIdp };
  }
  const refreshToken = (env.KIRO_REFRESH_TOKEN ?? "").trim() || stored?.refreshToken;
  if (!refreshToken) {
    throw new UpstreamError("auth_error", 401, "kiro: no session — run: llmswitch login kiro");
  }
  // Social accounts refresh at the Kiro auth service; Builder-ID/imported
  // SSO tokens refresh at the AWS SSO OIDC endpoint and need the client
  // registration recorded at login time.
  if (meta.authMethod === "google" || meta.authMethod === "github") {
    const res = await fetchFn(KIRO_SOCIAL_REFRESH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new UpstreamError("auth_error", 401, `kiro token refresh failed: HTTP ${res.status} — re-run: llmswitch login kiro`);
    const j = (await res.json()) as { accessToken?: string };
    if (!j.accessToken) throw new UpstreamError("auth_error", 401, "kiro token refresh: no accessToken in response");
    return { accessToken: j.accessToken, refreshToken, profileArn: meta.profileArn, externalIdp };
  }
  if (meta.clientId && meta.clientSecret) {
    const res = await fetchFn(KIRO_SSO_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        clientId: meta.clientId,
        clientSecret: meta.clientSecret,
        grantType: "refresh_token",
        refreshToken,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new UpstreamError("auth_error", 401, `kiro token refresh failed: HTTP ${res.status} — re-run: llmswitch login kiro`);
    const j = (await res.json()) as { accessToken?: string };
    if (!j.accessToken) throw new UpstreamError("auth_error", 401, "kiro token refresh: no accessToken in response");
    return { accessToken: j.accessToken, refreshToken, profileArn: meta.profileArn, externalIdp };
  }
  // Imported token with no registration data — use the stored access token if any.
  if (stored?.accessToken) {
    return { accessToken: stored.accessToken, refreshToken, profileArn: meta.profileArn, externalIdp };
  }
  throw new UpstreamError("auth_error", 401, "kiro: imported session cannot be refreshed (no client registration) — re-run: llmswitch login kiro");
}

/* ------------------------------------------------------------------ *
 * Request: OpenAI messages → CodeWhisperer conversationState.
 * Ported (simplified) from OmniRoute kiro executor: system + prior turns
 * become history; the last user turn becomes currentMessage.
 * ------------------------------------------------------------------ */

export function buildKiroPayload(
  model: string,
  body: ChatCompletionRequest,
  profileArn?: string,
): Record<string, unknown> {
  const messages = body.messages ?? [];
  const systemParts: string[] = [];
  const history: Array<Record<string, unknown>> = [];
  let currentContent = "";

  const textOf = (m: { content: string | null }): string => m.content ?? "";
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system") {
      systemParts.push(textOf(m));
      continue;
    }
    if (m.role === "user" && i === messages.length - 1) {
      currentContent = textOf(m);
      continue;
    }
    if (m.role === "user") {
      history.push({
        userInputMessage: {
          content: textOf(m),
          modelId: model,
          origin: "AI_EDITOR",
          userInputMessageContext: {},
        },
      });
    } else if (m.role === "assistant") {
      history.push({
        assistantResponseMessage: { content: textOf(m), toolUses: [] },
      });
    }
  }
  if (systemParts.length > 0) {
    // CodeWhisperer has no system role; prepend as the first user context.
    currentContent = [systemParts.join("\n\n"), currentContent].filter(Boolean).join("\n\n");
  }
  const payload: Record<string, unknown> = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: randomUUID(),
      currentMessage: {
        userInputMessage: {
          content: currentContent,
          modelId: model,
          origin: "AI_EDITOR",
          userInputMessageContext: {},
        },
      },
      ...(history.length > 0 ? { history } : {}),
    },
  };
  const arn = profileArn ?? (body as unknown as Record<string, unknown>).profileArn;
  if (typeof arn === "string" && arn.length > 0) payload.profileArn = arn;
  return payload;
}

export function buildKiroHeaders(creds: KiroCreds): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.0",
    accept: "application/x-amz-json-1.0",
    authorization: `Bearer ${creds.accessToken}`,
    "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
  };
  // External IdP tokens need this header so CodeWhisperer binds the token
  // to the Amazon Q Developer profile (OmniRoute kiroExternalIdp.ts).
  if (creds.externalIdp) headers.TokenType = "EXTERNAL_IDP";
  return headers;
}

/* ------------------------------------------------------------------ *
 * AWS event-stream parsing (simplified port of OmniRoute
 * open-sse/executors/kiro/eventstream.ts). Frame layout:
 *   total_len(4 BE) | headers_len(4 BE) | prelude_crc(4) |
 *   headers (name_len, name, type=7 string, value_len(2 BE), value) |
 *   payload (JSON) | message_crc(4)
 * CRCs are skipped (not validated) — payload JSON drives extraction.
 * ------------------------------------------------------------------ */

export interface EventStreamFrame {
  headers: Record<string, string>;
  payload: string;
}

export class EventStreamParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): EventStreamFrame[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    const frames: EventStreamFrame[] = [];
    for (;;) {
      if (this.buf.length < 12) break;
      const totalLen = this.buf.readUInt32BE(0);
      if (totalLen < 16 || this.buf.length < totalLen) break;
      const headersLen = this.buf.readUInt32BE(4);
      const frame = this.buf.subarray(0, totalLen);
      this.buf = this.buf.subarray(totalLen);
      const headers: Record<string, string> = {};
      let off = 12;
      const headersEnd = 12 + headersLen;
      while (off < headersEnd) {
        const nameLen = frame.readUInt8(off);
        off += 1;
        const name = frame.toString("utf8", off, off + nameLen);
        off += nameLen;
        const type = frame.readUInt8(off);
        off += 1;
        if (type === 7) {
          const valueLen = frame.readUInt16BE(off);
          off += 2;
          headers[name] = frame.toString("utf8", off, off + valueLen);
          off += valueLen;
        } else if (type === 0 || type === 1) {
          off += 1; // bool
        } else if (type === 2) {
          off += 1; // byte
        } else if (type === 3) {
          off += 2; // short
        } else if (type === 4 || type === 5) {
          off += 4; // int / float
        } else if (type === 6 || type === 8) {
          const len = frame.readUInt16BE(off);
          off += 2 + len; // byte array / timestamp
        } else if (type === 9) {
          off += 16; // uuid
        } else {
          break;
        }
      }
      const payload = frame.toString("utf8", headersEnd, totalLen - 4);
      frames.push({ headers, payload });
    }
    return frames;
  }
}

/** Extract visible assistant text from one event-stream frame payload. */
export function textFromKiroFrame(frame: EventStreamFrame): string {
  try {
    const j = JSON.parse(frame.payload) as {
      assistantResponseEvent?: { content?: string };
      content?: string;
    };
    return j.assistantResponseEvent?.content ?? (frame.headers[":event-type"] === "assistantResponseEvent" ? (j.content ?? "") : "");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

export interface KiroExecuteOpts {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  url?: string;
}

export async function executeKiroChat(
  _provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 120_000,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<ExecuteResult> {
  const creds = await resolveKiroCreds(env, fetchFn, accountId);
  const payload = buildKiroPayload(model, body, creds.profileArn);
  const headers = buildKiroHeaders(creds);
  const started = Date.now();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(KIRO_GENERATE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new UpstreamError("timeout", 0, `kiro network error: ${(err as Error).message}`);
  }
  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    throw new UpstreamError(classifyStatus(res.status), res.status, `kiro upstream ${res.status}: ${text.slice(0, 300)}`);
  }
  const latencyMs = Date.now() - started;

  if (body.stream === true && res.body) {
    const parser = new EventStreamParser();
    const gen = (async function* () {
      const reader = res.body!.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of parser.push(value)) {
            const text = textFromKiroFrame(frame);
            if (text) {
              yield {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                model,
                choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
              };
            }
          }
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
    return { stream: gen as ExecuteResult["stream"], providerId: "kiro", model, latencyMs, quota: null };
  }

  let full = "";
  if (res.body) {
    const parser = new EventStreamParser();
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(value)) full += textFromKiroFrame(frame);
      }
    } finally {
      clearTimeout(timer);
    }
  } else {
    clearTimeout(timer);
  }
  const response: ChatCompletionResponse = {
    id: `chatcmpl-${Date.now()}`,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: full }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  return { response, providerId: "kiro", model, latencyMs, quota: null };
}
