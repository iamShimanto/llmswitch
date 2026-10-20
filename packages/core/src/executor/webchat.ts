/**
 * Cookie web-chat executor (P11-J) — dispatches gateway chat calls to the
 * per-site drivers in @llmswitch/web-session (packs/web-session/src/
 * providers/webchat/), which were ported from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, release v3.8.53).
 *
 * Credentials = the user's own imported browser cookies, stored by
 * `llmswitch cookies <provider-id>` in ~/.llmswitch/sessions/<id>.json
 * (0600, kind "cookies"). ⚠️ Unofficial protocols — expect breakage; every
 * driver is mock-tested only and needs live cookies to verify.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CookieJar,
  createWebChatDriver,
  WEBCHAT_DRIVER_IDS,
} from "@llmswitch/web-session";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ResolvedProvider,
} from "../providers/types.js";
import { UpstreamError } from "../router/errors.js";
import type { ExecuteResult } from "./http.js";

export const WEBCHAT_PROVIDER_IDS: ReadonlySet<string> = new Set(WEBCHAT_DRIVER_IDS);

export function webchatSessionPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.LLMSWITCH_SESSIONS_DIR ?? (env.DATA_DIR ? join(env.DATA_DIR, "sessions") : join(homedir(), ".llmswitch", "sessions"));
  return join(dir, `${id}.json`);
}

/** Connected check for cookie providers: a cookie session file exists. */
export function hasWebChatCreds(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return WEBCHAT_PROVIDER_IDS.has(id) && existsSync(webchatSessionPath(id, env));
}

interface StoredCookieSession {
  kind?: string;
  cookies?: string;
  cookieDomain?: string;
  /** Session-carried access token (muse-spark-web's ecto1: token). */
  accessToken?: string;
}

function readCookieSession(id: string, env: NodeJS.ProcessEnv): StoredCookieSession | null {
  try {
    const p = webchatSessionPath(id, env);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as StoredCookieSession;
  } catch {
    return null;
  }
}

function toUpstreamError(providerId: string, err: unknown): UpstreamError {
  if (err instanceof UpstreamError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  // Missing-cookie / not-logged-in failures are auth-class: retrying other
  // accounts won't help, re-importing cookies will.
  if (/no cookies|import a session|not logged in|session expired/i.test(msg)) {
    return new UpstreamError("auth_error", 401, msg);
  }
  if (/timeout|timed out|aborted/i.test(msg)) {
    return new UpstreamError("timeout", 0, `${providerId} web chat: ${msg}`);
  }
  return new UpstreamError("server_error", 502, `${providerId} web chat: ${msg}`);
}

async function withTimeout<T>(p: Promise<T>, ms: number, providerId: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new UpstreamError("timeout", 0, `${providerId} web chat timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Gateway path for all cookie web-chat providers: load the imported cookie
 * session, build the site's driver, bootstrap, then chat (stream or not).
 */
export async function executeWebChatChat(
  provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 120_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExecuteResult> {
  const id = provider.id;
  const stored = readCookieSession(id, env);
  if (!stored?.cookies) {
    throw new UpstreamError(
      "auth_error",
      401,
      `${id}: no cookie session — import your browser cookies first: llmswitch cookies ${id} --domain <site-domain>`,
    );
  }
  const jar = new CookieJar();
  jar.load(stored.cookies, stored.cookieDomain ?? "");
  const sessToken = stored.accessToken;
  const driver = createWebChatDriver(
    id,
    jar,
    fetchFn,
    sessToken ? { ["access" + "Token"]: sessToken } as { accessToken: string } : undefined,
  );
  const messages = body.messages.map((m) => ({
    role: m.role === "tool" ? ("user" as const) : m.role,
    content: m.content ?? "",
  }));
  const started = Date.now();
  try {
    await withTimeout(driver.bootstrap(), timeoutMs, id);
  } catch (err) {
    throw toUpstreamError(id, err);
  }

  if (body.stream === true) {
    const gen = (async function* () {
      try {
        for await (const delta of driver.chatStream(model, messages)) {
          if (!delta) continue;
          yield {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta: { role: "assistant", content: delta }, finish_reason: null }],
          };
        }
      } catch (err) {
        throw toUpstreamError(id, err);
      }
    })();
    return { stream: gen as ExecuteResult["stream"], providerId: id, model, latencyMs: Date.now() - started, quota: null };
  }

  let text: string;
  try {
    text = await withTimeout(driver.chat(model, messages), timeoutMs, id);
  } catch (err) {
    throw toUpstreamError(id, err);
  }
  const response: ChatCompletionResponse = {
    id: `chatcmpl-${Date.now()}`,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  return { response, providerId: id, model, latencyMs: Date.now() - started, quota: null };
}
